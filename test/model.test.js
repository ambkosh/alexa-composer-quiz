'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

const root = join(__dirname, '..');
const manifest = require('../skill-package/skill.json');
const COMPOSERS = require('../lambda/data/composers.json');
const SONGS = require('../lambda/data/songs.json');

// Interaction model locale -> language of its slot values and samples.
const LOCALES = { 'en-US': 'en', 'de-DE': 'de' };
const models = Object.fromEntries(Object.keys(LOCALES).map((locale) => [
  locale, require(`../skill-package/interactionModels/custom/${locale}.json`),
]));
const LETTERS = { en: "A-Za-z'", de: "A-Za-zäöüÄÖÜß'" };

for (const [locale, lang] of Object.entries(LOCALES)) {
  const model = models[locale];
  const lm = model.interactionModel.languageModel;

  test(`${locale}: COMPOSER slot type is in sync with composers.json`, async () => {
    const { buildModel } = await import('../scripts/build-model.mjs');
    assert.deepEqual(buildModel(model, COMPOSERS, lang), model, 'run: npm run build:model');
  });

  test(`${locale}: invocation name is valid`, () => {
    assert.match(lm.invocationName, /^[a-zäöüß]+( [a-zäöüß]+)+$/);
  });

  test(`${locale}: sample utterances are valid and unique`, () => {
    const valid = new RegExp(`^[${LETTERS[lang]} {}.]+$`);
    const seen = new Map();
    for (const intent of lm.intents) {
      const slotNames = new Set((intent.slots || []).map((s) => s.name));
      for (const sample of intent.samples || []) {
        assert.match(sample, valid, `${intent.name}: "${sample}" has invalid characters`);
        for (const [, slot] of sample.matchAll(/\{(\w+)\}/g)) {
          assert.ok(slotNames.has(slot), `${intent.name}: "${sample}" uses undeclared slot ${slot}`);
        }
        const key = sample.toLowerCase();
        assert.ok(!seen.has(key), `"${sample}" is in both ${seen.get(key)} and ${intent.name}`);
        seen.set(key, intent.name);
      }
    }
  });

  test(`${locale}: required built-in intents are present`, () => {
    const names = new Set(lm.intents.map((i) => i.name));
    for (const required of ['AMAZON.CancelIntent', 'AMAZON.HelpIntent', 'AMAZON.StopIntent', 'AMAZON.NavigateHomeIntent', 'AMAZON.FallbackIntent']) {
      assert.ok(names.has(required), required);
    }
  });

  test(`${locale}: has no dialog model (the skill sends no Dialog directives)`, () => {
    assert.equal(model.interactionModel.dialog, undefined);
  });

  test(`${locale}: slot values are plain words`, () => {
    const valid = new RegExp(`^[${LETTERS[lang]} .]+$`);
    for (const type of lm.types) {
      for (const v of type.values) {
        for (const word of [v.name.value, ...v.name.synonyms]) {
          assert.match(word, valid, `${type.name}: "${word}"`);
        }
      }
    }
  });

  test(`${locale}: has a store listing whose example phrases use the invocation name`, () => {
    const listing = manifest.manifest.publishingInformation.locales[locale];
    assert.ok(listing, `skill.json has no ${locale} listing`);
    for (const phrase of listing.examplePhrases) {
      assert.ok(phrase.toLowerCase().includes(lm.invocationName), phrase);
    }
  });
}

test('every language model has the same intents and slots', () => {
  const shape = (model) => model.interactionModel.languageModel.intents
    .map((i) => `${i.name}(${(i.slots || []).map((s) => `${s.name}:${s.type}`).join(',')})`)
    .sort();
  const [first, ...rest] = Object.values(models);
  for (const model of rest) assert.deepEqual(shape(model), shape(first));
});

test('every manifest locale has an interaction model', () => {
  for (const locale of Object.keys(manifest.manifest.publishingInformation.locales)) {
    assert.ok(existsSync(join(root, `skill-package/interactionModels/custom/${locale}.json`)), locale);
  }
});

test('songs reference known composers and have unique ids', () => {
  const composerIds = new Set(COMPOSERS.map((c) => c.id));
  const ids = new Set();
  for (const song of SONGS) {
    assert.match(song.id, /^[a-z0-9-]+$/, song.id);
    assert.ok(!ids.has(song.id), `duplicate song id ${song.id}`);
    ids.add(song.id);
    assert.ok(composerIds.has(song.composer), `${song.id}: unknown composer ${song.composer}`);
    assert.ok(song.title && song.source, song.id);
    assert.ok(song.start === 'loudest' || Number.isFinite(song.start), `${song.id}: start`);
    if (song.duration !== undefined) assert.ok(song.duration >= 10 && song.duration <= 60, `${song.id}: duration`);
  }
});

test('German translations are complete', () => {
  for (const c of COMPOSERS) {
    assert.ok(c.de && c.de.origin && c.de.period, `${c.id}: missing de.origin / de.period`);
  }
  for (const s of SONGS) {
    assert.ok(s.de && s.de.title, `${s.id}: missing de.title`);
  }
});

test('every song has a built clip', () => {
  const clipsPath = join(root, 'audio/clips.json');
  assert.ok(existsSync(clipsPath), 'run: npm run build:clips');
  const clips = JSON.parse(readFileSync(clipsPath, 'utf8'));
  for (const song of SONGS) {
    assert.ok(existsSync(join(root, `audio/${song.id}.mp3`)), `audio/${song.id}.mp3 missing`);
    assert.ok(clips[song.id], `audio/clips.json has no entry for ${song.id}`);
  }
});

test('clips meet Alexa SSML audio requirements', (t) => {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
  } catch {
    t.skip('ffprobe not installed');
    return;
  }
  for (const song of SONGS) {
    const file = join(root, `audio/${song.id}.mp3`);
    if (!existsSync(file)) continue;
    const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]));
    const audio = info.streams.find((s) => s.codec_type === 'audio');
    assert.equal(audio.codec_name, 'mp3', song.id);
    assert.equal(audio.sample_rate, '24000', song.id);
    assert.ok(Math.abs(Number(audio.bit_rate) - 48000) <= 1000, `${song.id}: ${audio.bit_rate} bps`);
    assert.ok(Number(info.format.duration) <= 90, `${song.id}: clip too long for a reprompt-free game turn`);
  }
});
