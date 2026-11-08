'use strict';

// Alles, was Alexa auf Deutsch sagt. Same functions as en.js, in German.
// Composer names, hints and song titles come from the "de" fields in lambda/data/*.json.
// Functions return SSML fragments; index.js wraps them in <speak> via the ASK SDK.

const config = require('../config');
const game = require('../game');
const { escape, pick, audio, sound, pause, firstLetter, localize } = require('./common');

const NUMBER_WORDS = ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn'];

// Words index.js looks for in what the players said (normalized: lowercase, no umlauts,
// ß as ss — "weiß" is matched as "weiss").
const words = {
  counts: {
    eins: 1, ein: 1, eine: 1, einer: 1, allein: 1, alleine: 1, solo: 1,
    zwei: 2, zwo: 2, zweit: 2, drei: 3, dritt: 3, vier: 4, viert: 4,
  },
  countSoundAlikes: { frei: 3 },
  commands: {
    pass: ['pass', 'passe', 'ich passe', 'weiß nicht', 'keine ahnung', 'keinen plan', 'keine idee', 'gebe auf', 'nächster spieler', 'überspring mich', 'weiter'],
    hint: ['tipp', 'tip', 'hinweis'],
    repeat: ['nochmal', 'noch mal', 'noch einmal', 'nochmals', 'wiederholen', 'wiederholung'],
    score: ['punktestand', 'spielstand', 'wer führt', 'wer gewinnt', 'wie steht es', "wie steht's"],
  },
  skipName: ['überspringen', 'skip', 'weiter', 'kein name', 'keiner', 'nichts', 'pass', 'passe', 'nächster', 'egal'],
};

function points(n) {
  return n === 1 ? 'einen Punkt' : `${n} Punkte`;
}

/** After "mit": "mit je einem Punkt", "mit je 3 Punkten". */
function pointsDative(n) {
  return n === 1 ? 'einem Punkt' : `${n} Punkten`;
}

function listJoin(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} und ${items[items.length - 1]}`;
}

function name(player) {
  return escape(player.name);
}

function ordinalPlayer(index) {
  return `Spieler ${NUMBER_WORDS[index + 1] || index + 1}`;
}

function solo(state) {
  return state.players.length === 1;
}

function composerName(composer) {
  return escape(localize(composer, 'de').name);
}

// ---------------------------------------------------------------- setup

function welcome() {
  return `${sound('intro')}Willkommen beim Komponisten-Quiz! Ich spiele kurze Ausschnitte klassischer Musik, `
    + 'und ihr ratet abwechselnd, wer sie komponiert hat. Jede richtige Antwort bringt einen Punkt. '
    + `Wie viele Spieler seid ihr? Es können bis zu ${NUMBER_WORDS[config.maxPlayers]} mitspielen.`;
}

function askPlayerCount() {
  return `Wie viele Spieler seid ihr? Sag eine Zahl von eins bis ${NUMBER_WORDS[config.maxPlayers]}.`;
}

function invalidPlayerCount() {
  return `Mitspielen können eine bis ${NUMBER_WORDS[config.maxPlayers]} Personen. Wie viele Spieler seid ihr?`;
}

function countNotUnderstood() {
  return `Entschuldigung, das habe ich nicht verstanden. ${askPlayerCount()}`;
}

function defaultName(index) {
  return `Spieler ${index + 1}`;
}

function playerCountAccepted(count) {
  if (count === 1) return `Ein Solospiel, super! ${askName(0, 1)}`;
  return `Super, ${NUMBER_WORDS[count]} Spieler! ${askName(0, count)}`;
}

function askName(index, count) {
  if (count === 1) return 'Wie heißt du?';
  return `${ordinalPlayer(index)}, wie heißt du?`;
}

function askNameReprompt(index, count) {
  const who = count === 1 ? 'Sag mir bitte deinen Namen' : `${ordinalPlayer(index)}, sag mir bitte deinen Namen`;
  return `${who}, oder sag überspringen, dann nenne ich dich ${ordinalPlayer(index)}.`;
}

function nameAccepted(playerName) {
  const n = escape(playerName);
  return pick([`Hallo ${n}!`, `Schön, dich kennenzulernen, ${n}.`, `Willkommen, ${n}!`]);
}

function nameSkipped(index) {
  return `Okay, du bist ${ordinalPlayer(index)}.`;
}

function duplicateName(playerName, index) {
  return `Wir haben schon jemanden namens ${escape(playerName)}. ${ordinalPlayer(index)}, bitte nimm einen anderen Namen.`;
}

function nameNotUnderstood(index, count) {
  return `Entschuldigung, das habe ich nicht verstanden. ${askNameReprompt(index, count)}`;
}

function rules(state) {
  if (solo(state)) {
    return `Wir spielen ${state.totalRounds} Runden. Du hast ${NUMBER_WORDS[config.soloGuesses]} Versuche pro Stück. `
      + "Wenn du nicht weiterweißt, sag passe oder frag nach einem Tipp. Los geht's!";
  }
  return `Wir spielen ${state.totalRounds} Runden. In jeder Runde rät ein anderer Spieler zuerst, `
    + 'dann geht es reihum, bis jemand richtig liegt. '
    + "Wenn ihr nicht weiterwisst, sagt passe oder fragt nach einem Tipp. Los geht's!";
}

// ---------------------------------------------------------------- rounds

function roundIntro(state, clipUrl) {
  const label = state.round >= state.totalRounds
    ? 'Letzte Runde!'
    : `Runde ${state.round} von ${state.totalRounds}.`;
  return `${label} ${pick(['Gut zuhören!', "Jetzt kommt's.", 'Ohren auf!', 'Und los.'])}`
    + `${pause(400)}${audio(clipUrl)}${pause(300)}${askGuess(state, true)}`;
}

function askGuess(state, firstAsk = false) {
  const player = state.players[game.currentPlayerIndex(state)];
  if (solo(state)) {
    return firstAsk ? 'Wer ist der Komponist?' : 'Was meinst du, wer ist es?';
  }
  if (firstAsk) return pick([`${name(player)}, wer ist der Komponist?`, `${name(player)}, wer hat das komponiert?`, `${name(player)}, von wem ist dieses Stück?`]);
  return pick([`${name(player)}, du bist dran. Wer ist der Komponist?`, `Jetzt du, ${name(player)}. Wer hat es komponiert?`, `${name(player)}, was meinst du?`]);
}

function guessReprompt(state) {
  const player = state.players[game.currentPlayerIndex(state)];
  const who = solo(state) ? 'Wer' : `${name(player)}, wer`;
  return `${who} hat dieses Stück komponiert? Nenne einen Komponisten, oder sag passe, Tipp oder nochmal.`;
}

function songReveal(song, composer) {
  return `Das war ${escape(localize(song, 'de').title)} von ${escape(localize(composer, 'de').fullName)}.`;
}

function correct(state, playerIndex, song, composer) {
  const player = state.players[playerIndex];
  const praise = pick(['Richtig!', 'Genau!', 'Volltreffer!', 'Bravo!']);
  const credit = solo(state)
    ? `Du hast jetzt ${points(player.score)}.`
    : `${name(player)} bekommt einen Punkt und hat jetzt ${points(player.score)}.`;
  return `${sound('correct')}${praise} ${songReveal(song, composer)} ${credit}`;
}

function wrong(state, playerIndex, guessedComposer) {
  const player = state.players[playerIndex];
  const who = solo(state) ? '' : `, ${name(player)}`;
  const what = guessedComposer ? `, es ist nicht ${composerName(guessedComposer)}` : '';
  return `${sound('wrong')}Leider falsch${who}${what}.`;
}

function passed(state, playerIndex) {
  if (solo(state)) return 'Okay, du passt.';
  return `Okay, ${name(state.players[playerIndex])} passt.`;
}

function nobodyGotIt(state, song, composer) {
  const lead = solo(state) ? 'Diesmal leider nicht.' : 'Das wusste diesmal keiner.';
  return `${lead} ${songReveal(song, composer)}`;
}

function duplicateGuess(state, composer) {
  const player = state.players[game.currentPlayerIndex(state)];
  const who = solo(state) ? 'Versuch' : `${name(player)}, versuch`;
  return `${composerName(composer)} wurde schon ausgeschlossen. ${who} es mit einem anderen Komponisten.`;
}

function notUnderstood(state) {
  const extra = state.misses >= 2 ? ' Nenne einen Komponisten, zum Beispiel Mozart, oder sag passe, wenn du es nicht weißt.' : '';
  return `Entschuldigung, das habe ich nicht verstanden.${extra} ${askGuess(state)}`;
}

function hint(state, composer) {
  const c = localize(composer, 'de');
  const lead = state.hints <= 1
    ? `Ein Tipp: Dieser Komponist kam aus ${escape(c.origin)}. Seine Musik stammt aus ${escape(c.period)}.`
    : `Noch ein Tipp: Der Name des Komponisten beginnt mit <say-as interpret-as="spell-out">${escape(firstLetter(c.name))}</say-as>.`;
  return `${lead} ${askGuess(state)}`;
}

function noMoreHints(state) {
  return `Mehr Tipps habe ich für dieses Stück nicht. ${askGuess(state)}`;
}

function hintsOnlyInGame(reprompt) {
  return `Tipps gibt es, während ein Stück gespielt wird. ${reprompt}`;
}

function repeatClip(state, clipUrl) {
  return `Hier ist es noch einmal.${pause(300)}${audio(clipUrl)}${pause(300)}${askGuess(state)}`;
}

function skipped(song, composer) {
  return `Okay, wir überspringen dieses Stück. ${songReveal(song, composer)}`;
}

// ---------------------------------------------------------------- scores

function scoreLine(state) {
  const { ranked } = game.standings(state);
  if (ranked.every((p) => p.score === 0)) return 'Bisher hat noch niemand gepunktet.';
  if (ranked.length === 1) return `Du hast ${points(ranked[0].score)}.`;
  return `${listJoin(ranked.map((p) => `${name(p)} hat ${points(p.score)}`))}.`;
}

function notStartedYet(reprompt) {
  return `Das Spiel hat noch nicht angefangen. ${reprompt}`;
}

function scoreReport(state) {
  const done = game.roundsCompleted(state);
  const progress = done === 0
    ? 'Wir haben noch keine Runde beendet.'
    : `Nach ${done} von ${state.totalRounds} Runden:`;
  return `${progress} ${scoreLine(state)}`;
}

function finalResults(state) {
  const { ranked, leaders, topScore } = game.standings(state);
  if (ranked.length === 1) {
    const score = ranked[0].score;
    const ratio = score / state.totalRounds;
    const comment = ratio >= 0.8 ? 'Das ist Maestro-Niveau!' : ratio >= 0.5 ? 'Gut gemacht!' : ratio > 0 ? 'Nicht schlecht!' : "Beim nächsten Mal klappt's bestimmt!";
    return `Du hast ${score} von ${state.totalRounds} richtig. ${comment}`;
  }
  if (!leaders.length) return 'Diesmal hat niemand gepunktet. Viel Glück beim nächsten Spiel!';
  if (leaders.length === 1) {
    return `Endstand: ${scoreLine(state)} ${name(leaders[0])} gewinnt! Herzlichen Glückwunsch!`;
  }
  return `Endstand: ${scoreLine(state)} Unentschieden zwischen ${listJoin(leaders.map(name))} mit je ${pointsDative(topScore)}!`;
}

function gameOver(state) {
  const again = solo(state) ? 'Willst du noch einmal spielen?' : 'Wollt ihr noch einmal spielen?';
  return `${sound('outro')}Das Spiel ist zu Ende! ${finalResults(state)} ${again}`;
}

function playAgainReprompt() {
  return 'Noch ein Spiel mit denselben Spielern? Sag ja oder nein.';
}

function newGameSamePlayers() {
  return 'Super, ein neues Spiel mit denselben Spielern!';
}

function goodbye() {
  return 'Danke fürs Spielen beim Komponisten-Quiz. Tschüss!';
}

function stoppedMidGame(state) {
  const hasScores = state.players.some((p) => p.score > 0);
  return hasScores
    ? `Okay, ich beende das Spiel. ${scoreLine(state)} ${goodbye()}`
    : goodbye();
}

function startOver() {
  return `Okay, wir fangen von vorne an. ${askPlayerCount()}`;
}

// ---------------------------------------------------------------- help & fallback

function help(state) {
  const { PHASE } = game;
  switch (state.phase) {
    case PHASE.SETUP_COUNT:
      return 'Das Komponisten-Quiz ist ein Spiel für eine bis vier Personen. Ich spiele ein Stück klassischer Musik, '
        + 'und ihr ratet abwechselnd, wer es komponiert hat. '
        + `Sag mir zuerst, wie viele Spieler mitmachen. ${askPlayerCount()}`;
    case PHASE.SETUP_NAMES:
      return `Ich frage nach euren Namen, damit ich weiß, wer an der Reihe ist. ${askNameReprompt(state.players.length, state.playerCount)}`;
    case PHASE.PLAYING:
      return 'Wenn du dran bist, sag einfach den Namen des Komponisten, zum Beispiel Beethoven. '
        + 'Du kannst auch passe sagen, nach einem Tipp fragen, nochmal sagen, um das Stück noch einmal zu hören, '
        + 'nächstes Stück sagen, um es zu überspringen, oder nach dem Punktestand fragen. '
        + askGuess(state);
    default:
      return playAgainReprompt();
  }
}

function error() {
  return 'Entschuldigung, da ist bei mir etwas schiefgelaufen. Bitte versuch es noch einmal.';
}

module.exports = {
  lang: 'de',
  words,
  welcome,
  askPlayerCount,
  invalidPlayerCount,
  countNotUnderstood,
  defaultName,
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
  hintsOnlyInGame,
  repeatClip,
  skipped,
  notStartedYet,
  scoreReport,
  gameOver,
  finalResults,
  playAgainReprompt,
  newGameSamePlayers,
  goodbye,
  stoppedMidGame,
  startOver,
  help,
  error,
};
