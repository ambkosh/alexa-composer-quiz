'use strict';

// Pure game rules. No Alexa code here, so everything is easy to unit test.
// The whole state is a plain JSON object kept in the Alexa session attributes.

const PHASE = Object.freeze({
  SETUP_COUNT: 'SETUP_COUNT', // waiting for the number of players
  SETUP_NAMES: 'SETUP_NAMES', // collecting player names
  PLAYING: 'PLAYING', // a clip has been played, waiting for the current player's guess
  GAME_OVER: 'GAME_OVER', // final scores read, waiting for "play again?"
});

function createState() {
  return {
    phase: PHASE.SETUP_COUNT,
    playerCount: 0,
    players: [], // [{ name, score }]
    totalRounds: 0,
    round: 0, // 1-based number of the current round
    queue: [], // song ids, one per round
    attempt: 0, // guesses (or passes) made in the current round
    wrong: [], // composer ids guessed wrongly in the current round
    hints: 0, // hints given in the current round
    misses: 0, // consecutive answers Alexa couldn't understand on this turn
    played: [], // songs used in earlier games of this session
  };
}

function setPlayerCount(state, count, config) {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1 || n > config.maxPlayers) return false;
  state.playerCount = n;
  state.players = [];
  state.phase = PHASE.SETUP_NAMES;
  return true;
}

/** Index of the player whose name we're asking for next. */
function namingIndex(state) {
  return state.players.length;
}

function defaultName(index) {
  return `Player ${index + 1}`;
}

function cleanName(name) {
  const trimmed = String(name || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * Add the next player's name. Returns 'ok', 'duplicate' or 'empty'.
 * Pass no name to use the default "Player N".
 */
function addPlayer(state, name) {
  const finalName = name === undefined ? defaultName(namingIndex(state)) : cleanName(name);
  if (!finalName) return 'empty';
  if (state.players.some((p) => p.name.toLowerCase() === finalName.toLowerCase())) return 'duplicate';
  state.players.push({ name: finalName, score: 0 });
  return 'ok';
}

function allPlayersNamed(state) {
  return state.players.length >= state.playerCount;
}

function roundsFor(playerCount, songCount, config) {
  const rounds = Math.ceil(config.minRounds / playerCount) * playerCount;
  return Math.min(rounds, songCount);
}

function shuffle(list, rng) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Pick `count` songs at random. Songs not played earlier in the session come first,
 * and no composer repeats until every composer has had a turn.
 */
function pickSongs(songs, count, rng, played = []) {
  const playedSet = new Set(played);
  const pool = [
    ...shuffle(songs.filter((s) => !playedSet.has(s.id)), rng),
    ...shuffle(songs.filter((s) => playedSet.has(s.id)), rng),
  ];
  const picked = [];
  let used = new Set();
  while (picked.length < count && pool.length) {
    let i = pool.findIndex((s) => !used.has(s.composer));
    if (i === -1) {
      // Every remaining composer was used already: start a new cycle, but still
      // avoid playing the same composer twice in a row.
      const last = picked.length ? picked[picked.length - 1].composer : null;
      used = new Set(last ? [last] : []);
      i = pool.findIndex((s) => !used.has(s.composer));
      if (i === -1) i = 0;
    }
    const [song] = pool.splice(i, 1);
    picked.push(song);
    used.add(song.composer);
  }
  return picked.map((s) => s.id);
}

function startGame(state, songs, config, rng = Math.random) {
  for (const p of state.players) p.score = 0;
  state.totalRounds = roundsFor(state.players.length, songs.length, config);
  state.queue = pickSongs(songs, state.totalRounds, rng, state.played);
  // Remember recently played songs so a rematch prefers fresh ones. Keep just enough
  // history that a full game of unplayed songs is always available.
  const history = [...state.played.filter((id) => !state.queue.includes(id)), ...state.queue];
  const keep = Math.max(0, songs.length - state.totalRounds);
  state.played = keep ? history.slice(-keep) : [];
  state.phase = PHASE.PLAYING;
  state.round = 1;
  resetRound(state);
}

function resetRound(state) {
  state.attempt = 0;
  state.wrong = [];
  state.hints = 0;
  state.misses = 0;
}

function currentSongId(state) {
  return state.queue[state.round - 1];
}

/** The player who guesses first in the current round; rotates every round. */
function starterIndex(state) {
  return (state.round - 1) % state.players.length;
}

function currentPlayerIndex(state) {
  return (starterIndex(state) + state.attempt) % state.players.length;
}

function currentPlayer(state) {
  return state.players[currentPlayerIndex(state)];
}

function guessesPerRound(state, config) {
  return state.players.length === 1 ? config.soloGuesses : state.players.length;
}

function isLastRound(state) {
  return state.round >= state.totalRounds;
}

/**
 * The current player guesses `composerIds` (alternatives Alexa heard; the first one is
 * the primary guess). Returns { result, playerIndex, guessedId, roundOver }:
 *   result 'correct'   → the player scores and the round is over
 *   result 'duplicate' → that composer was already ruled out; same player tries again
 *   result 'wrong'     → next player's turn, or the round is over if everyone guessed
 */
function guess(state, composerIds, correctId, config) {
  const playerIndex = currentPlayerIndex(state);
  if (composerIds.includes(correctId)) {
    state.players[playerIndex].score += 1;
    return { result: 'correct', playerIndex, guessedId: correctId, roundOver: true };
  }
  const guessedId = composerIds[0];
  if (state.wrong.includes(guessedId)) {
    return { result: 'duplicate', playerIndex, guessedId, roundOver: false };
  }
  state.wrong.push(guessedId);
  return { result: 'wrong', playerIndex, guessedId, roundOver: endTurn(state, config) };
}

/** The current player passes. Returns { playerIndex, roundOver }. */
function pass(state, config) {
  const playerIndex = currentPlayerIndex(state);
  return { playerIndex, roundOver: endTurn(state, config) };
}

function endTurn(state, config) {
  state.attempt += 1;
  state.misses = 0;
  return state.attempt >= guessesPerRound(state, config);
}

/** Move to the next round. Returns true if the game is over instead. */
function nextRound(state) {
  if (isLastRound(state)) {
    state.phase = PHASE.GAME_OVER;
    return true;
  }
  state.round += 1;
  resetRound(state);
  return false;
}

/** Number of rounds whose result is settled (for score announcements). */
function roundsCompleted(state) {
  if (state.phase === PHASE.GAME_OVER) return state.totalRounds;
  return Math.max(0, state.round - 1);
}

/** Players sorted by score (stable for ties) plus the list of leaders. */
function standings(state) {
  const ranked = state.players
    .map((p, i) => ({ ...p, index: i }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const top = ranked.length ? ranked[0].score : 0;
  const leaders = top > 0 ? ranked.filter((p) => p.score === top) : [];
  return { ranked, leaders, topScore: top };
}

module.exports = {
  PHASE,
  createState,
  setPlayerCount,
  namingIndex,
  defaultName,
  addPlayer,
  allPlayersNamed,
  roundsFor,
  pickSongs,
  startGame,
  currentSongId,
  starterIndex,
  currentPlayerIndex,
  currentPlayer,
  guessesPerRound,
  isLastRound,
  guess,
  pass,
  nextRound,
  roundsCompleted,
  standings,
};
