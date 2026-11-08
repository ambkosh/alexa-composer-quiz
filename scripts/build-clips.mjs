#!/usr/bin/env node
// Builds the quiz clips.
//
// For every song in lambda/data/songs.json this script looks up the source recording on
// Wikimedia Commons, checks its license, downloads it (cached in .cache/sources), cuts a
// short excerpt and converts it to the MP3 format Alexa's SSML <audio> tag requires
// (MPEG-2, 48 kbps, 24 kHz, no Xing header). Output:
//
//   audio/<song id>.mp3   the clips the skill plays
//   audio/clips.json      clip start/duration and resolved source metadata
//   CREDITS.md            attribution for every recording
//
// Usage:
//   node scripts/build-clips.mjs                     build missing clips
//   node scripts/build-clips.mjs --force             rebuild every clip
//   node scripts/build-clips.mjs --only id1,id2      (re)build just these songs
//   node scripts/build-clips.mjs --allow-attribution also accept CC BY / CC BY-SA sources
//
// Requires ffmpeg and ffprobe on the PATH.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const songsPath = join(root, 'lambda/data/songs.json');
const composersPath = join(root, 'lambda/data/composers.json');
const audioDir = join(root, 'audio');
const cacheDir = process.env.CLIP_CACHE_DIR || join(root, '.cache/sources');
const manifestPath = join(audioDir, 'clips.json');
const creditsPath = join(root, 'CREDITS.md');

const API = 'https://commons.wikimedia.org/w/api.php';
const USER_AGENT = 'ComposerQuizClipBuilder/1.0 (https://github.com/ambkosh/alexa-composer-quiz)';
const DEFAULT_DURATION = 25;
const FREE_LICENSE = /^(public domain|cc0|pdm)/i;
const ATTRIBUTION_LICENSE = /^cc by(-sa)? \d/i;

const args = process.argv.slice(2);
const force = args.includes('--force');
const allowAttribution = args.includes('--allow-attribution');
const onlyArg = args.indexOf('--only');
const only = onlyArg >= 0 ? new Set((args[onlyArg + 1] || '').split(',').filter(Boolean)) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, tries = 6) {
  for (let i = 1; ; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (res.ok) return res;
    if (i >= tries || ![429, 500, 502, 503, 504].includes(res.status)) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    const wait = Number(res.headers.get('retry-after')) * 1000 || 5000 * i;
    console.warn(`  HTTP ${res.status}, retrying in ${Math.round(wait / 1000)}s…`);
    await sleep(wait);
  }
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Look up file URL, license and credit for Commons file titles (without "File:"). */
async function resolveCommons(titles) {
  const info = new Map();
  for (let i = 0; i < titles.length; i += 40) {
    const batch = titles.slice(i, i + 40);
    const params = new URLSearchParams({
      action: 'query', format: 'json', formatversion: '2',
      titles: batch.map((t) => `File:${t}`).join('|'),
      // videoinfo is imageinfo plus the transcoded versions Commons keeps of audio files.
      prop: 'videoinfo', viprop: 'url|size|mime|extmetadata|derivatives',
      viextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|Credit|AttributionRequired',
    });
    const data = await (await fetchWithRetry(`${API}?${params}`)).json();
    const renamed = new Map((data.query.normalized || []).map((n) => [n.to, n.from]));
    for (const page of data.query.pages) {
      const requested = (renamed.get(page.title) || page.title).replace(/^File:/, '');
      if (page.missing || !page.videoinfo) {
        info.set(requested, null);
        continue;
      }
      const ii = page.videoinfo[0];
      const meta = ii.extmetadata || {};
      info.set(requested, {
        url: ii.url,
        download: downloadUrl(ii),
        page: ii.descriptionurl,
        duration: ii.duration,
        license: stripHtml(meta.LicenseShortName && meta.LicenseShortName.value),
        licenseUrl: stripHtml(meta.LicenseUrl && meta.LicenseUrl.value),
        artist: stripHtml(meta.Artist && meta.Artist.value),
      });
    }
    await sleep(1000);
  }
  return info;
}

/** Lossless originals (FLAC, WAV) can be huge; fetch Commons' Ogg/MP3 transcode instead. */
function downloadUrl(ii) {
  if (!/flac|wav/i.test(ii.mime || '')) return ii.url;
  const derivs = ii.derivatives || [];
  const pickType = (re) => derivs.find((d) => re.test(d.type));
  const best = pickType(/^audio\/ogg/) || pickType(/^audio\/mpeg/);
  return best ? best.src : ii.url;
}

async function download(url, dest) {
  const res = await fetchWithRetry(url);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  return JSON.parse(out.toString());
}

/** Start time (seconds) of the loudest `duration`-second window, e.g. a big finale. */
function loudestStart(file, duration) {
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '8000', '-f', 's16le', '-'],
    { maxBuffer: 1 << 30 });
  const samples = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length - (pcm.length % 2)));
  const block = 4000; // half a second
  const energy = [];
  for (let i = 0; i + block <= samples.length; i += block) {
    let sum = 0;
    for (let j = i; j < i + block; j++) sum += samples[j] * samples[j];
    energy.push(sum / block);
  }
  const win = Math.round(duration * 2);
  // Leave out the last two seconds so the clip doesn't end on applause or silence.
  const usable = Math.max(win, energy.length - 4);
  let best = -1;
  let bestAt = 0;
  let running = 0;
  for (let i = 0; i < usable; i++) {
    running += energy[i];
    if (i >= win) running -= energy[i - win];
    if (i >= win - 1 && running > best) {
      best = running;
      bestAt = i - win + 1;
    }
  }
  return bestAt / 2;
}

function encodeClip(src, dest, start, duration) {
  const fadeOut = Math.max(0, duration - 2);
  const filters = [
    'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.1',
    `atrim=duration=${duration}`,
    'afade=t=in:st=0:d=0.3',
    `afade=t=out:st=${fadeOut}:d=2`,
    'loudnorm=I=-16:TP=-2:LRA=11',
    'aresample=24000',
  ].join(',');
  execFileSync('ffmpeg', [
    '-hide_banner', '-v', 'error', '-y',
    '-ss', String(start), '-t', String(duration + 10), '-i', src,
    '-vn', '-sn', '-dn', '-map_metadata', '-1',
    '-af', filters,
    '-ac', '2', '-ar', '24000', '-codec:a', 'libmp3lame', '-b:a', '48k', '-write_xing', '0', '-id3v2_version', '0',
    dest,
  ]);
  const { streams, format } = probe(dest);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const problems = [];
  if (!audio || audio.codec_name !== 'mp3') problems.push(`codec ${audio && audio.codec_name}`);
  if (audio && audio.sample_rate !== '24000') problems.push(`sample rate ${audio.sample_rate}`);
  if (audio && Math.abs(Number(audio.bit_rate) - 48000) > 1000) problems.push(`bit rate ${audio.bit_rate}`);
  const length = Number(format.duration);
  if (!(length > 5 && length <= 240)) problems.push(`duration ${length}`);
  if (problems.length) throw new Error(`clip doesn't meet Alexa requirements: ${problems.join(', ')}`);
  return length;
}

function writeCredits(songs, composers, manifest) {
  const composerName = new Map(composers.map((c) => [c.id, c.fullName]));
  const esc = (s) => String(s || '').replace(/\|/g, '\\|');
  const rows = songs.map((s) => {
    const m = manifest[s.id];
    if (!m) return `| ${esc(s.title)} | ${esc(composerName.get(s.composer))} | (not built) | | |`;
    const at = `${Math.floor(m.start / 60)}:${String(Math.round(m.start % 60)).padStart(2, '0')}`;
    return `| ${esc(s.title)} | ${esc(composerName.get(s.composer))} | ${esc(m.artist)} | ${esc(m.license)} | [${esc(s.source)}](${m.page}) (excerpt from ${at}) |`;
  });
  writeFileSync(creditsPath, `# Credits

The quiz clips in \`audio/\` are short excerpts of recordings hosted on
[Wikimedia Commons](https://commons.wikimedia.org/). Every recording is marked as public
domain or dedicated to the public domain (CC0) on its Commons file page, which is linked
below. The underlying compositions are in the public domain as well. Recordings by
US military bands are works of the US federal government; many others come from the
[Musopen](https://musopen.org/) project.

This file is generated by \`npm run build:clips\`; licenses were taken from each file page
at build time. Check the file pages yourself before publishing the skill.

| Piece | Composer | Performer / credit (from Commons) | License | Source |
| --- | --- | --- | --- | --- |
${rows.join('\n')}
`);
}

async function main() {
  const songs = JSON.parse(readFileSync(songsPath, 'utf8'));
  const composers = JSON.parse(readFileSync(composersPath, 'utf8'));
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  mkdirSync(audioDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  console.log(`Resolving ${songs.length} recordings on Wikimedia Commons…`);
  const commons = await resolveCommons([...new Set(songs.map((s) => s.source))]);

  const failures = [];
  for (const song of songs) {
    if (only && !only.has(song.id)) continue;
    const out = join(audioDir, `${song.id}.mp3`);
    if (!force && !only && existsSync(out) && manifest[song.id]) continue;
    try {
      const src = commons.get(song.source);
      if (!src) throw new Error(`not found on Commons: File:${song.source}`);
      const licenseOk = FREE_LICENSE.test(src.license) || (allowAttribution && ATTRIBUTION_LICENSE.test(src.license));
      if (!licenseOk) throw new Error(`license "${src.license}" not allowed (see --allow-attribution)`);

      const cached = join(cacheDir, `${song.id}${extname(new URL(src.download).pathname) || '.audio'}`);
      if (!existsSync(cached)) {
        console.log(`↓ ${song.id}`);
        await download(src.download, cached);
        await sleep(1500);
      }
      const duration = song.duration || DEFAULT_DURATION;
      const start = song.start === 'loudest' ? loudestStart(cached, duration) : Number(song.start || 0);
      const length = encodeClip(cached, out, start, duration);
      manifest[song.id] = {
        start, duration: Math.round(length * 10) / 10,
        source: song.source, page: src.page, license: src.license, artist: src.artist,
      };
      console.log(`✓ ${song.id} (${length.toFixed(1)}s from ${start}s, ${src.license})`);
    } catch (err) {
      failures.push(song.id);
      console.error(`✗ ${song.id}: ${err.message}`);
    }
  }

  // Drop entries for songs that were removed from the catalog.
  const ids = new Set(songs.map((s) => s.id));
  for (const id of Object.keys(manifest)) if (!ids.has(id)) delete manifest[id];

  const sorted = Object.fromEntries(songs.filter((s) => manifest[s.id]).map((s) => [s.id, manifest[s.id]]));
  writeFileSync(manifestPath, `${JSON.stringify(sorted, null, 2)}\n`);
  writeCredits(songs, composers, sorted);

  if (failures.length) {
    console.error(`\n${failures.length} clip(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log(`\nDone: ${Object.keys(sorted).length}/${songs.length} clips in audio/.`);
}

await main();
