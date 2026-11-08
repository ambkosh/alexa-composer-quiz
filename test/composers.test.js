'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { COMPOSERS, getComposer, matchText, normalize, resolveSlot } = require('../lambda/composers');

test('normalize strips accents, case and punctuation', () => {
  assert.equal(normalize('  Saint-Saëns! '), 'saint saens');
  assert.equal(normalize("I don't know"), 'i don t know');
  assert.equal(normalize(undefined), '');
});

test('composer ids are unique and complete', () => {
  const ids = COMPOSERS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of COMPOSERS) {
    for (const field of ['id', 'name', 'fullName', 'nationality', 'period']) {
      assert.ok(c[field], `${c.id} is missing ${field}`);
    }
    assert.ok(Array.isArray(c.synonyms), `${c.id} synonyms`);
  }
});

test('matchText finds composers in free text', () => {
  const cases = {
    beethoven: ['beethoven'],
    'Ludwig van Beethoven': ['beethoven'],
    "I think it's bach": ['bach'],
    tschaikowsky: ['tchaikovsky'],
    tchaikovski: ['tchaikovsky'],
    rachmaninof: ['rachmaninoff'],
    'saint saens': ['saint_saens'],
    'antonin dvorak': ['dvorak'],
    offenbach: ['offenbach'],
    'rimsky korsakov': ['rimsky_korsakov'],
    vivaldy: ['vivaldi'],
  };
  for (const [text, expected] of Object.entries(cases)) {
    assert.deepEqual(matchText(text), expected, text);
  }
});

test('matchText prefers the longest name and keeps ambiguity', () => {
  assert.deepEqual(matchText('richard strauss'), ['richard_strauss']);
  assert.deepEqual(matchText('johann strauss'), ['strauss']);
  assert.ok(matchText('strauss').includes('strauss'));
});

test('matchText ignores words that are not composers', () => {
  for (const text of ['', 'hello', 'pass', 'no idea', 'what', 'banana bread']) {
    assert.deepEqual(matchText(text), [], text);
  }
});

test('resolveSlot reads entity resolution and ignores unknown ids', () => {
  const slot = {
    value: 'bark',
    resolutions: {
      resolutionsPerAuthority: [
        { status: { code: 'ER_SUCCESS_MATCH' }, values: [{ value: { id: 'bach', name: 'Bach' } }, { value: { id: 'nope', name: 'x' } }] },
      ],
    },
  };
  assert.deepEqual(resolveSlot(slot), { ids: ['bach'], raw: 'bark' });
  assert.deepEqual(resolveSlot({ value: 'zzz', resolutions: { resolutionsPerAuthority: [{ status: { code: 'ER_SUCCESS_NO_MATCH' } }] } }), { ids: [], raw: 'zzz' });
  assert.deepEqual(resolveSlot(undefined), { ids: [], raw: '' });
  assert.equal(getComposer('bach').fullName, 'Johann Sebastian Bach');
});
