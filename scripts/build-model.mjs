#!/usr/bin/env node
// Regenerates the COMPOSER slot type in each interaction model from lambda/data/composers.json,
// so the composers Alexa listens for always match the composers the game knows about.
// English models use the English names, German models the "de" names and synonyms.
//
//   node scripts/build-model.mjs          write the models
//   node scripts/build-model.mjs --check  exit 1 if a model is out of date

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const composersPath = join(root, 'lambda/data/composers.json');

/** Interaction model locales and the language of their slot values. */
export const LOCALES = { 'en-US': 'en', 'de-DE': 'de' };

export function modelPath(locale) {
  return join(root, `skill-package/interactionModels/custom/${locale}.json`);
}

/** Slot values work best as plain words: drop accents (except German umlauts and ß) and hyphens. */
export function spoken(text, lang = 'en') {
  const keep = lang === 'de' ? /[äöüÄÖÜß]/ : null;
  return [...text.normalize('NFC')]
    .map((ch) => (keep && keep.test(ch) ? ch : ch.normalize('NFD').replace(/[̀-ͯ]/g, '')))
    .join('')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** [value, ...synonyms] for one composer in one language. */
function namesFor(c, lang) {
  if (lang === 'de') {
    const de = c.de || {};
    return [de.name || c.name, de.fullName || c.fullName, c.name, ...(de.synonyms || [])];
  }
  return [c.name, c.fullName, ...c.synonyms];
}

export function composerType(composers, lang = 'en') {
  return {
    name: 'COMPOSER',
    values: composers.map((c) => {
      const [value, ...rest] = namesFor(c, lang).map((n) => spoken(n, lang));
      const seen = new Set([value.toLowerCase()]);
      const synonyms = [];
      for (const s of rest) {
        if (!seen.has(s.toLowerCase())) {
          seen.add(s.toLowerCase());
          synonyms.push(s);
        }
      }
      return { id: c.id, name: { value, synonyms } };
    }),
  };
}

export function buildModel(model, composers, lang = 'en') {
  const next = structuredClone(model);
  const lm = next.interactionModel.languageModel;
  lm.types = [...(lm.types || []).filter((t) => t.name !== 'COMPOSER'), composerType(composers, lang)];
  return next;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const composers = JSON.parse(readFileSync(composersPath, 'utf8'));
  const check = process.argv.includes('--check');
  let stale = false;
  for (const [locale, lang] of Object.entries(LOCALES)) {
    const path = modelPath(locale);
    const current = readFileSync(path, 'utf8');
    const next = `${JSON.stringify(buildModel(JSON.parse(current), composers, lang), null, 2)}\n`;
    if (check) {
      if (next !== current) {
        console.error(`${locale} interaction model is out of date. Run: npm run build:model`);
        stale = true;
      }
    } else {
      writeFileSync(path, next);
      console.log(`Wrote ${composers.length} composers to ${path}`);
    }
  }
  if (check) {
    if (stale) process.exit(1);
    console.log('Interaction models are up to date.');
  }
}
