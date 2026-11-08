'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const game = require('../lambda/game');
const config = require('../lambda/config');
const SONGS = require('../lambda/data/songs.json');

function seeded(seed) {
  // mulberry32
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function newGame(names, seed = 1) {
  const state = game.createState();
  assert.equal(game.setPlayerCount(state, names.length, config), true);
  for (const n of names) assert.equal(game.addPlayer(state, n), 'ok');
  game.startGame(state, SONGS, config, seeded(seed));
  return state;
}

function answerOf(state) {
  return SONGS.find((s) => s.id === game.currentSongId(state)).composer;
}

test('round count is a multiple of the player count, at least minRounds', () => {
  assert.equal(game.roundsFor(1, 100, config), 8);
  assert.equal(game.roundsFor(2, 100, config), 8);
  assert.equal(game.roundsFor(3, 100, config), 9);
  assert.equal(game.roundsFor(4, 100, config), 8);
  assert.equal(game.roundsFor(4, 5, config), 5, 'capped by the number of songs');
});

test('player count must be between 1 and maxPlayers', () => {
  const state = game.createState();
  for (const bad of [0, 5, -1, 2.5, NaN, 'x']) assert.equal(game.setPlayerCount(state, bad, config), false);
  assert.equal(state.phase, game.PHASE.SETUP_COUNT);
  assert.equal(game.setPlayerCount(state, 4, config), true);
  assert.equal(state.phase, game.PHASE.SETUP_NAMES);
});

test('player names: capitalized, unique, default names', () => {
  const state = game.createState();
  game.setPlayerCount(state, 3, config);
  assert.equal(game.addPlayer(state, 'anna'), 'ok');
  assert.equal(state.players[0].name, 'Anna');
  assert.equal(game.addPlayer(state, 'ANNA'), 'duplicate');
  assert.equal(game.addPlayer(state, '   '), 'empty');
  assert.equal(game.addPlayer(state), 'ok');
  assert.equal(state.players[1].name, 'Player 2');
  assert.equal(game.allPlayersNamed(state), false);
  game.addPlayer(state, 'Ben');
  assert.equal(game.allPlayersNamed(state), true);
});

test('song picks are unique and never repeat a composer back to back', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const ids = game.pickSongs(SONGS, 40, seeded(seed));
    assert.equal(new Set(ids).size, ids.length);
    const composers = ids.map((id) => SONGS.find((s) => s.id === id).composer);
    for (let i = 1; i < composers.length; i++) assert.notEqual(composers[i], composers[i - 1], `seed ${seed}`);
    // With fewer rounds than composers, every composer is different.
    const short = game.pickSongs(SONGS, 9, seeded(seed)).map((id) => SONGS.find((s) => s.id === id).composer);
    assert.equal(new Set(short).size, short.length);
  }
});

test('a rematch prefers songs that were not played yet', () => {
  const state = newGame(['Anna', 'Ben']);
  const first = new Set(state.queue);
  game.startGame(state, SONGS, config, seeded(2));
  assert.equal(state.queue.filter((id) => first.has(id)).length, 0);
  assert.ok(state.played.length <= SONGS.length);
});

test('the first guesser rotates each round, then turns go round the table', () => {
  const state = newGame(['Anna', 'Ben', 'Cleo']);
  assert.equal(state.totalRounds, 9);
  assert.equal(game.currentPlayer(state).name, 'Anna');
  game.pass(state, config);
  assert.equal(game.currentPlayer(state).name, 'Ben');
  game.pass(state, config);
  assert.equal(game.currentPlayer(state).name, 'Cleo');
  game.nextRound(state);
  assert.equal(game.currentPlayer(state).name, 'Ben');
  game.pass(state, config);
  game.pass(state, config);
  assert.equal(game.currentPlayer(state).name, 'Anna');
  game.nextRound(state);
  assert.equal(game.currentPlayer(state).name, 'Cleo');
});

test('a correct guess scores a point and ends the round', () => {
  const state = newGame(['Anna', 'Ben']);
  const outcome = game.guess(state, [answerOf(state)], answerOf(state), config);
  assert.deepEqual(outcome, { result: 'correct', playerIndex: 0, guessedId: answerOf(state), roundOver: true });
  assert.equal(state.players[0].score, 1);
  assert.equal(state.players[1].score, 0);
});

test('a correct composer among several alternatives counts', () => {
  const state = newGame(['Anna', 'Ben']);
  const outcome = game.guess(state, ['richard_strauss', answerOf(state)], answerOf(state), config);
  assert.equal(outcome.result, 'correct');
});

test('wrong guesses pass the turn; the round ends when everyone has guessed', () => {
  const state = newGame(['Anna', 'Ben']);
  const wrongId = answerOf(state) === 'mozart' ? 'bach' : 'mozart';
  const first = game.guess(state, [wrongId], answerOf(state), config);
  assert.equal(first.result, 'wrong');
  assert.equal(first.roundOver, false);
  assert.equal(game.currentPlayer(state).name, 'Ben');

  const dup = game.guess(state, [wrongId], answerOf(state), config);
  assert.equal(dup.result, 'duplicate');
  assert.equal(game.currentPlayer(state).name, 'Ben', 'a repeated wrong guess does not use up the turn');

  const last = game.pass(state, config);
  assert.equal(last.roundOver, true);
  assert.equal(state.players.every((p) => p.score === 0), true);
});

test('a solo player gets two guesses per song', () => {
  const state = newGame(['Solo']);
  const wrongId = answerOf(state) === 'mozart' ? 'bach' : 'mozart';
  assert.equal(game.guess(state, [wrongId], answerOf(state), config).roundOver, false);
  assert.equal(game.guess(state, [answerOf(state)], answerOf(state), config).result, 'correct');
  game.nextRound(state);
  game.pass(state, config);
  assert.equal(game.pass(state, config).roundOver, true);
});

test('the game ends after the last round', () => {
  const state = newGame(['Anna', 'Ben']);
  let rounds = 1;
  while (!game.nextRound(state)) rounds += 1;
  assert.equal(rounds, state.totalRounds);
  assert.equal(state.phase, game.PHASE.GAME_OVER);
  assert.equal(game.roundsCompleted(state), state.totalRounds);
});

test('standings sort by score and report ties', () => {
  const state = newGame(['Anna', 'Ben', 'Cleo']);
  state.players[0].score = 2;
  state.players[1].score = 3;
  state.players[2].score = 3;
  const { ranked, leaders, topScore } = game.standings(state);
  assert.deepEqual(ranked.map((p) => p.name), ['Ben', 'Cleo', 'Anna']);
  assert.deepEqual(leaders.map((p) => p.name), ['Ben', 'Cleo']);
  assert.equal(topScore, 3);
  for (const p of state.players) p.score = 0;
  assert.deepEqual(game.standings(state).leaders, []);
});
