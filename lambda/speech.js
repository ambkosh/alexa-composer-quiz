'use strict';

// Everything Alexa says lives here, so wording can be tweaked (or translated) in one place.
// Functions return SSML fragments; index.js wraps them in <speak> via the ASK SDK.

const config = require('./config');
const game = require('./game');

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

function escape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pick(options, rng = Math.random) {
  return options[Math.floor(rng() * options.length)];
}

function audio(url) {
  return `<audio src="${escape(url)}"/>`;
}

function sound(name) {
  return audio(config.sounds[name]);
}

function pause(ms) {
  return `<break time="${ms}ms"/>`;
}

function points(n) {
  return n === 1 ? 'one point' : `${n} points`;
}

function listJoin(items) {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function name(player) {
  return escape(player.name);
}

function ordinalPlayer(index) {
  return `Player ${NUMBER_WORDS[index + 1] || index + 1}`;
}

// ---------------------------------------------------------------- setup

function welcome() {
  return `${sound('intro')}Welcome to Composer Quiz! I'll play short clips of classical music, `
    + 'and you take turns naming the composer. Every correct answer earns a point. '
    + `How many players are there? You can have up to ${NUMBER_WORDS[config.maxPlayers]}.`;
}

function askPlayerCount() {
  return `How many players? Say a number from one to ${NUMBER_WORDS[config.maxPlayers]}.`;
}

function invalidPlayerCount() {
  return `I can host one to ${NUMBER_WORDS[config.maxPlayers]} players. How many players are there?`;
}

function playerCountAccepted(count) {
  if (count === 1) return `A solo game, great! ${askName(0, 1)}`;
  return `Great, ${NUMBER_WORDS[count]} players! ${askName(0, count)}`;
}

function askName(index, count) {
  if (count === 1) return "What's your name?";
  return `${ordinalPlayer(index)}, what's your name?`;
}

function askNameReprompt(index, count) {
  const who = count === 1 ? 'Please' : `${ordinalPlayer(index)}, please`;
  return `${who} tell me your name, or say skip and I'll call you ${ordinalPlayer(index)}.`;
}

function nameAccepted(playerName) {
  return pick([`Hi ${escape(playerName)}!`, `Nice to meet you, ${escape(playerName)}.`, `Welcome, ${escape(playerName)}!`]);
}

function nameSkipped(index) {
  return `Okay, you're ${ordinalPlayer(index)}.`;
}

function duplicateName(playerName, index) {
  return `We already have someone called ${escape(playerName)}. ${ordinalPlayer(index)}, please pick a different name.`;
}

function nameNotUnderstood(index, count) {
  return `Sorry, I didn't catch that. ${askNameReprompt(index, count)}`;
}

function rules(state) {
  const solo = state.players.length === 1;
  const turns = solo
    ? `You get ${NUMBER_WORDS[config.soloGuesses]} guesses per song.`
    : 'Each round, a different player guesses first, and then it goes round the table until someone gets it right.';
  return `We'll play ${state.totalRounds} rounds. ${turns} `
    + "If you're not sure, say pass, or ask for a hint. Let's begin!";
}

// ---------------------------------------------------------------- rounds

function roundIntro(state, clipUrl) {
  const label = state.round >= state.totalRounds
    ? 'Final round!'
    : `Round ${state.round} of ${state.totalRounds}.`;
  return `${label} ${pick(['Listen carefully.', 'Here it comes.', 'Ears open.', 'Have a listen.'])}`
    + `${pause(400)}${audio(clipUrl)}${pause(300)}${askGuess(state, true)}`;
}

function askGuess(state, firstAsk = false) {
  const player = state.players[game.currentPlayerIndex(state)];
  if (state.players.length === 1) {
    return firstAsk ? "Who's the composer?" : 'Who do you think it is?';
  }
  if (firstAsk) return pick([`${name(player)}, who's the composer?`, `${name(player)}, who wrote this?`, `${name(player)}, who composed this piece?`]);
  return pick([`${name(player)}, your turn. Who's the composer?`, `Over to you, ${name(player)}. Who wrote it?`, `${name(player)}, what's your guess?`]);
}

function guessReprompt(state) {
  const player = state.players[game.currentPlayerIndex(state)];
  const who = state.players.length === 1 ? '' : `${name(player)}, `;
  return `${who}who composed that piece? Name a composer, or say pass, hint, or repeat.`;
}

function songReveal(song, composer) {
  return `That was ${escape(song.title)} by ${escape(composer.fullName)}.`;
}

function correct(state, playerIndex, song, composer) {
  const player = state.players[playerIndex];
  const praise = pick(['Correct!', "That's right!", 'Spot on!', 'Bravo!']);
  const credit = state.players.length === 1
    ? `That's ${points(player.score)} so far.`
    : `${name(player)} gets a point and now has ${points(player.score)}.`;
  return `${sound('correct')}${praise} ${songReveal(song, composer)} ${credit}`;
}

function wrong(state, playerIndex, guessedComposer) {
  const player = state.players[playerIndex];
  const who = state.players.length === 1 ? '' : ` ${name(player)}`;
  const what = guessedComposer ? `, it's not ${escape(guessedComposer.name)}` : ', that\'s not it';
  return `${sound('wrong')}Sorry${who}${what}.`;
}

function passed(state, playerIndex) {
  if (state.players.length === 1) return 'Okay, passing.';
  return `Okay, ${name(state.players[playerIndex])} passes.`;
}

function nobodyGotIt(state, song, composer) {
  const lead = state.players.length === 1 ? 'Not this time.' : 'Nobody got this one.';
  return `${lead} ${songReveal(song, composer)}`;
}

function duplicateGuess(state, composer) {
  const player = state.players[game.currentPlayerIndex(state)];
  const who = state.players.length === 1 ? 'Try' : `${name(player)}, try`;
  return `${escape(composer.name)} has already been ruled out. ${who} another composer.`;
}

function notUnderstood(state) {
  const extra = state.misses >= 2 ? ' Say a composer\'s name, like Mozart, or say pass if you don\'t know.' : '';
  return `Sorry, I didn't catch that.${extra} ${askGuess(state)}`;
}

function hint(state, composer) {
  const lead = state.hints <= 1
    ? `Here's a hint: this composer was ${escape(composer.nationality)} and lived in ${escape(composer.period)}.`
    : `Another hint: the composer's name starts with the letter ${escape(firstLetter(composer.name))}.`;
  return `${lead} ${askGuess(state)}`;
}

function noMoreHints(state) {
  return `That's all the hints I have for this one. ${askGuess(state)}`;
}

function firstLetter(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').charAt(0).toUpperCase();
}

function repeatClip(state, clipUrl) {
  return `Here it is again.${pause(300)}${audio(clipUrl)}${pause(300)}${askGuess(state)}`;
}

function skipped(song, composer) {
  return `Okay, skipping this one. ${songReveal(song, composer)}`;
}

// ---------------------------------------------------------------- scores

function scoreLine(state) {
  const { ranked } = game.standings(state);
  if (ranked.every((p) => p.score === 0)) return 'Nobody has scored yet.';
  if (ranked.length === 1) return `You have ${points(ranked[0].score)}.`;
  return `${listJoin(ranked.map((p) => `${name(p)} has ${points(p.score)}`))}.`;
}

function scoreReport(state) {
  const done = game.roundsCompleted(state);
  const progress = done === 0
    ? "We haven't finished a round yet."
    : `After ${done} of ${state.totalRounds} rounds:`;
  return `${progress} ${scoreLine(state)}`;
}

function finalResults(state) {
  const { ranked, leaders, topScore } = game.standings(state);
  let verdict;
  if (ranked.length === 1) {
    const score = ranked[0].score;
    const ratio = score / state.totalRounds;
    const comment = ratio >= 0.8 ? 'Maestro level!' : ratio >= 0.5 ? 'Well done!' : ratio > 0 ? 'Nice try!' : 'Better luck next time!';
    verdict = `You got ${score} out of ${state.totalRounds}. ${comment}`;
  } else if (!leaders.length) {
    verdict = 'Nobody scored this time. Better luck next game!';
  } else if (leaders.length === 1) {
    verdict = `Final scores: ${scoreLine(state)} ${name(leaders[0])} wins! Congratulations!`;
  } else {
    verdict = `Final scores: ${scoreLine(state)} It's a tie between ${listJoin(leaders.map(name))} with ${points(topScore)} each!`;
  }
  return verdict;
}

function gameOver(state) {
  return `${sound('outro')}That's the end of the game! ${finalResults(state)} Would you like to play again?`;
}

function playAgainReprompt() {
  return 'Would you like to play another game with the same players? Say yes or no.';
}

function newGameSamePlayers() {
  return 'Great, a new game with the same players!';
}

function goodbye() {
  return 'Thanks for playing Composer Quiz. Goodbye!';
}

function stoppedMidGame(state) {
  const hasScores = state.players.some((p) => p.score > 0);
  return hasScores
    ? `Okay, ending the game. ${scoreLine(state)} ${goodbye()}`
    : goodbye();
}

function startOver() {
  return `Okay, let's start over. ${askPlayerCount()}`;
}

// ---------------------------------------------------------------- help & fallback

function help(state) {
  const { PHASE } = game;
  switch (state.phase) {
    case PHASE.SETUP_COUNT:
      return 'Composer Quiz is a game for one to four players. I play a clip of classical music, '
        + 'and you take turns guessing who composed it. '
        + `To get started, tell me how many players there are. ${askPlayerCount()}`;
    case PHASE.SETUP_NAMES:
      return `I'm collecting player names, so I know whose turn it is. ${askNameReprompt(state.players.length, state.playerCount)}`;
    case PHASE.PLAYING:
      return 'When it\'s your turn, just say the composer\'s name, like Beethoven. '
        + 'You can also say pass, ask for a hint, say repeat to hear the clip again, '
        + "say skip this song, or ask what's the score. "
        + askGuess(state);
    default:
      return playAgainReprompt();
  }
}

module.exports = {
  welcome,
  askPlayerCount,
  invalidPlayerCount,
  playerCountAccepted,
  askName,
  askNameReprompt,
  nameAccepted,
  nameSkipped,
  duplicateName,
  nameNotUnderstood,
  rules,
  roundIntro,
  askGuess,
  guessReprompt,
  correct,
  wrong,
  passed,
  nobodyGotIt,
  duplicateGuess,
  notUnderstood,
  hint,
  noMoreHints,
  repeatClip,
  skipped,
  scoreReport,
  gameOver,
  finalResults,
  playAgainReprompt,
  newGameSamePlayers,
  goodbye,
  stoppedMidGame,
  startOver,
  help,
};
