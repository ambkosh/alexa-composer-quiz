#!/usr/bin/env node
// Regenerates the COMPOSER slot type in the interaction model from lambda/data/composers.json,
// so the composers Alexa listens for always match the composers the game knows about.
//
//   node scripts/build-model.mjs          write the model
//   node scripts/build-model.mjs --check  exit 1 if the model is out of date

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const composersPath = join(root, 'lambda/data/composers.json');
const modelPath = join(root, 'skill-package/interactionModels/custom/en-US.json');

/** Slot values work best as plain ASCII words: drop accents and hyphens. */
export function spoken(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}

export function composerType(composers) {
  return {
    name: 'COMPOSER',
    values: composers.map((c) => {
      const value = spoken(c.name);
      const seen = new Set([value.toLowerCase()]);
      const synonyms = [];
      for (const s of [c.fullName, ...c.synonyms].map(spoken)) {
        if (!seen.has(s.toLowerCase())) {
          seen.add(s.toLowerCase());
          synonyms.push(s);
        }
      }
      return { id: c.id, name: { value, synonyms } };
    }),
  };
}

export function buildModel(model, composers) {
  const next = structuredClone(model);
  const lm = next.interactionModel.languageModel;
  lm.types = [...(lm.types || []).filter((t) => t.name !== 'COMPOSER'), composerType(composers)];
  return next;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const composers = JSON.parse(readFileSync(composersPath, 'utf8'));
  const current = readFileSync(modelPath, 'utf8');
  const next = `${JSON.stringify(buildModel(JSON.parse(current), composers), null, 2)}\n`;
  if (process.argv.includes('--check')) {
    if (next !== current) {
      console.error('Interaction model is out of date. Run: npm run build:model');
      process.exit(1);
    }
    console.log('Interaction model is up to date.');
  } else {
    writeFileSync(modelPath, next);
    console.log(`Wrote ${composers.length} composers to ${modelPath}`);
  }
}
