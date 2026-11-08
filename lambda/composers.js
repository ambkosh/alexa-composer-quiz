'use strict';

const COMPOSERS = require('./data/composers.json');

const byId = new Map(COMPOSERS.map((c) => [c.id, c]));

/** Lowercase, strip accents and punctuation, collapse whitespace ("Weiß" -> "weiss"). */
function normalize(text) {
  return String(text || '')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Every way of saying each composer in any language, normalized: [{ id, phrase, words }]
const PHRASES = [];
for (const c of COMPOSERS) {
  const seen = new Set();
  const de = c.de || {};
  for (const p of [c.name, c.fullName, ...c.synonyms, de.name, de.fullName, ...(de.synonyms || [])]) {
    const phrase = normalize(p);
    if (!phrase || seen.has(phrase)) continue;
    seen.add(phrase);
    PHRASES.push({ id: c.id, phrase, words: phrase.split(' ') });
  }
}

function getComposer(id) {
  return byId.get(id);
}

function levenshtein(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function maxTypos(word) {
  if (word.length >= 8) return 2;
  if (word.length >= 5) return 1;
  return 0;
}

/**
 * Find composers mentioned in free text, e.g. a raw slot value that entity resolution
 * could not match ("tschaikowsky", "I think it's bach"). Returns composer ids, best first.
 */
function matchText(text) {
  const norm = normalize(text);
  if (!norm) return [];

  // 1. The whole utterance is a known name.
  const exact = PHRASES.filter((p) => p.phrase === norm);
  if (exact.length) return unique(exact.map((p) => p.id));

  // 2. A known name appears as whole words inside the utterance; prefer the longest.
  const padded = ` ${norm} `;
  const contained = PHRASES.filter((p) => padded.includes(` ${p.phrase} `));
  if (contained.length) {
    const longest = Math.max(...contained.map((p) => p.phrase.length));
    return unique(contained.filter((p) => p.phrase.length === longest).map((p) => p.id));
  }

  // 3. A word is a near miss for a single-word name ("rachmaninof", "vivaldy").
  let best = null;
  for (const word of norm.split(' ')) {
    const allowed = maxTypos(word);
    if (!allowed) continue;
    for (const p of PHRASES) {
      if (p.words.length !== 1) continue;
      const d = levenshtein(word, p.phrase);
      if (d <= allowed && (!best || d < best.d)) best = { id: p.id, d };
    }
  }
  return best ? [best.id] : [];
}

function unique(list) {
  return [...new Set(list)];
}

/**
 * Read a slot. Returns the composer ids Alexa's entity resolution matched (empty if
 * none) and the raw spoken value.
 */
function resolveSlot(slot) {
  const raw = (slot && slot.value) || '';
  const ids = [];
  const authorities = (slot && slot.resolutions && slot.resolutions.resolutionsPerAuthority) || [];
  for (const authority of authorities) {
    if (authority.status && authority.status.code === 'ER_SUCCESS_MATCH') {
      for (const v of authority.values || []) {
        if (byId.has(v.value.id)) ids.push(v.value.id);
      }
    }
  }
  return { ids: unique(ids), raw };
}

module.exports = { COMPOSERS, getComposer, matchText, normalize, resolveSlot };
