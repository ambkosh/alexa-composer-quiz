'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

const root = join(__dirname, '..');
const model = require('../skill-package/interactionModels/custom/en-US.json');
const manifest = require('../skill-package/skill.json');
const COMPOSERS = require('../lambda/data/composers.json');
const SONGS = require('../lambda/data/songs.json');

const lm = model.interactionModel.languageModel;

test('COMPOSER slot type is in sync with composers.json', async () => {
  const { buildModel } = await import('../scripts/build-model.mjs');
  assert.deepEqual(buildModel(model, COMPOSERS), model, 'run: npm run build:model');
});

test('invocation name is valid', () => {
  assert.match(lm.invocationName, /^[a-z]+( [a-z]+)+$/);
});

test('sample utterances are valid and unique', () => {
  const seen = new Map();
  for (const intent of lm.intents) {
    const slotNames = new Set((intent.slots || []).map((s) => s.name));
    for (const sample of intent.samples || []) {
      assert.match(sample, /^[a-zA-Z' {}.]+$/, `${intent.name}: "${sample}" has invalid characters`);
      for (const [, slot] of sample.matchAll(/\{(\w+)\}/g)) {
        assert.ok(slotNames.has(slot), `${intent.name}: "${sample}" uses undeclared slot ${slot}`);
      }
      const key = sample.toLowerCase();
      assert.ok(!seen.has(key), `"${sample}" is in both ${seen.get(key)} and ${intent.name}`);
      seen.set(key, intent.name);
    }
  }
});

test('required built-in intents are present', () => {
  const names = new Set(lm.intents.map((i) => i.name));
  for (const required of ['AMAZON.CancelIntent', 'AMAZON.HelpIntent', 'AMAZON.StopIntent', 'AMAZON.NavigateHomeIntent', 'AMAZON.FallbackIntent']) {
    assert.ok(names.has(required), required);
  }
});

test('dialog model matches the language model slots', () => {
  for (const di of model.interactionModel.dialog.intents) {
    const intent = lm.intents.find((i) => i.name === di.name);
    assert.ok(intent, `dialog intent ${di.name} missing from language model`);
    for (const slot of di.slots) {
      const declared = intent.slots.find((s) => s.name === slot.name);
      assert.ok(declared, `${di.name}.${slot.name}`);
      assert.equal(declared.type, slot.type);
    }
  }
  // index.js elicits these slots.
  for (const [intent, slot] of [['PlayerCountIntent', 'count'], ['PlayerNameIntent', 'name'], ['AnswerIntent', 'composer']]) {
    assert.ok(model.interactionModel.dialog.intents.some((d) => d.name === intent && d.slots.some((s) => s.name === slot)), intent);
  }
});

test('slot values are plain words', () => {
  for (const type of lm.types) {
    for (const v of type.values) {
      for (const word of [v.name.value, ...v.name.synonyms]) {
        assert.match(word, /^[A-Za-z' .]+$/, `${type.name}: "${word}"`);
      }
    }
  }
});

test('manifest locales match the interaction models', () => {
  const locales = Object.keys(manifest.manifest.publishingInformation.locales);
  for (const locale of locales) {
    assert.ok(existsSync(join(root, `skill-package/interactionModels/custom/${locale}.json`)), locale);
  }
  for (const phrase of manifest.manifest.publishingInformation.locales['en-US'].examplePhrases) {
    assert.ok(phrase.toLowerCase().includes(lm.invocationName), phrase);
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
