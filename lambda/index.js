'use strict';

const Alexa = require('ask-sdk-core');
const config = require('./config');
const game = require('./game');
const { forLocale } = require('./speech');
const { getComposer, matchText, normalize, resolveSlot } = require('./composers');
const SONGS = require('./data/songs.json');

const { PHASE } = game;
const songById = new Map(SONGS.map((s) => [s.id, s]));

// ======================================================================= helpers

/** The speech module (English or German) for this request's locale. */
function say(h) {
  return forLocale(Alexa.getLocale(h.requestEnvelope));
}

function getState(h) {
  const attrs = h.attributesManager.getSessionAttributes();
  if (!attrs.game) attrs.game = game.createState();
  return attrs.game;
}

function saveState(h, state) {
  const attrs = h.attributesManager.getSessionAttributes();
  attrs.game = state;
  h.attributesManager.setSessionAttributes(attrs);
}

function currentSong(state) {
  return songById.get(game.currentSongId(state));
}

function clipUrl(song) {
  return song.url || `${config.audioBaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(song.id)}.mp3`;
}

// The slot Alexa should expect next, per phase. Eliciting it biases speech recognition
// towards that slot's values (e.g. composer names while a clip is being guessed).
const EXPECTED_SLOT = {
  [PHASE.SETUP_COUNT]: { intent: 'PlayerCountIntent', slot: 'count' },
  [PHASE.SETUP_NAMES]: { intent: 'PlayerNameIntent', slot: 'name' },
  [PHASE.PLAYING]: { intent: 'AnswerIntent', slot: 'composer' },
};

function defaultReprompt(h, state) {
  switch (state.phase) {
    case PHASE.SETUP_COUNT: return say(h).askPlayerCount();
    case PHASE.SETUP_NAMES: return say(h).askNameReprompt(game.namingIndex(state), state.playerCount);
    case PHASE.PLAYING: return say(h).guessReprompt(state);
    default: return say(h).playAgainReprompt();
  }
}

/** Speak and keep the session open, waiting for the next answer. */
function ask(h, state, text, reprompt = defaultReprompt(h, state)) {
  saveState(h, state);
  const rb = h.responseBuilder.speak(text).reprompt(reprompt);
  const expected = EXPECTED_SLOT[state.phase];
  const type = Alexa.getRequestType(h.requestEnvelope);
  if (config.useElicitSlot && expected && (type === 'IntentRequest' || type === 'LaunchRequest')) {
    rb.addElicitSlotDirective(expected.slot, {
      name: expected.intent,
      confirmationStatus: 'NONE',
      slots: { [expected.slot]: { name: expected.slot, confirmationStatus: 'NONE' } },
    });
  }
  return rb.getResponse();
}

/** Speak and end the session. */
function tell(h, state, text) {
  saveState(h, state);
  return h.responseBuilder.speak(text).withShouldEndSession(true).getResponse();
}

function slotValue(h, name) {
  const slot = Alexa.getSlot(h.requestEnvelope, name);
  return slot && slot.value ? slot.value : '';
}

/** Any raw words the user said in this request (whichever of our slots was filled). */
function anyRawValue(h) {
  return slotValue(h, 'composer') || slotValue(h, 'name') || slotValue(h, 'count');
}

// The words each language listens for (speech/<lang>.js "words"), normalized once.
const wordCache = new Map();

function wordsFor(s) {
  if (!wordCache.has(s.lang)) {
    const { counts, countSoundAlikes, commands, skipName } = s.words;
    wordCache.set(s.lang, {
      counts,
      countSoundAlikes,
      commands: Object.entries(commands).map(([cmd, phrases]) => [cmd, phrases.map(normalize)]),
      skipName: new Set(skipName.map(normalize)),
    });
  }
  return wordCache.get(s.lang);
}

function parseCount(raw, words) {
  const norm = normalize(raw);
  const digits = norm.match(/\b(\d+)\b/);
  if (digits) return Number(digits[1]);
  const list = norm.split(' ');
  for (const table of [words.counts, words.countSoundAlikes]) {
    const word = list.find((w) => Object.hasOwn(table, w));
    if (word) return table[word];
  }
  return NaN;
}

// Words that mean something other than a composer when Alexa forces them into the
// composer slot (which happens while that slot is being elicited).
function detectCommand(raw, words) {
  const padded = ` ${normalize(raw)} `;
  for (const [cmd, phrases] of words.commands) {
    if (phrases.some((p) => padded.includes(` ${p} `))) return cmd;
  }
  return null;
}

/** Work out what an answer means: a composer guess, a command, or nothing usable. */
function interpretAnswer(slot, words) {
  const { ids, raw } = resolveSlot(slot);
  if (ids.length) return { kind: 'guess', ids };
  const cmd = detectCommand(raw, words);
  if (cmd) return { kind: cmd };
  const fuzzy = matchText(raw);
  if (fuzzy.length) return { kind: 'guess', ids: fuzzy };
  return { kind: 'unknown' };
}

// ======================================================================= game actions

function welcome(h) {
  const state = game.createState();
  return ask(h, state, say(h).welcome(), say(h).askPlayerCount());
}

function setCount(h, state, value) {
  if (!game.setPlayerCount(state, value, config)) {
    return ask(h, state, say(h).invalidPlayerCount());
  }
  return ask(h, state, say(h).playerCountAccepted(state.playerCount));
}

function addName(h, state, rawName) {
  const index = game.namingIndex(state);
  const raw = String(rawName || '').trim();
  let lead;
  if (/^[\d\s?]*$/.test(raw)) return ask(h, state, say(h).nameNotUnderstood(index, state.playerCount));
  if (wordsFor(say(h)).skipName.has(normalize(raw))) {
    if (game.addPlayer(state, say(h).defaultName(index)) !== 'ok') game.addPlayer(state);
    lead = say(h).nameSkipped(index);
  } else {
    // Keep names short; Alexa occasionally hears a whole sentence.
    const name = raw.split(/\s+/).slice(0, 2).join(' ');
    const result = game.addPlayer(state, name);
    if (result === 'duplicate') {
      const taken = state.players.find((p) => p.name.toLowerCase() === name.toLowerCase());
      return ask(h, state, say(h).duplicateName(taken ? taken.name : name, index));
    }
    if (result !== 'ok') return ask(h, state, say(h).nameNotUnderstood(index, state.playerCount));
    lead = say(h).nameAccepted(state.players[index].name);
  }
  if (game.allPlayersNamed(state)) return beginGame(h, state, lead);
  return ask(h, state, `${lead} ${say(h).askName(game.namingIndex(state), state.playerCount)}`);
}

function skipName(h, state) {
  return addName(h, state, say(h).words.skipName[0]);
}

function beginGame(h, state, lead = '') {
  game.startGame(state, SONGS, config);
  const intro = say(h).roundIntro(state, clipUrl(currentSong(state)));
  return ask(h, state, `${lead} ${say(h).rules(state)} ${intro}`.trim());
}

/** Close the current round and either play the next clip or announce the results. */
function finishRound(h, state, lead) {
  if (game.nextRound(state)) {
    return ask(h, state, `${lead} ${say(h).gameOver(state)}`);
  }
  const intro = say(h).roundIntro(state, clipUrl(currentSong(state)));
  return ask(h, state, `${lead} <break time="700ms"/>${intro}`);
}

function makeGuess(h, state, ids) {
  const song = currentSong(state);
  const answer = getComposer(song.composer);
  const outcome = game.guess(state, ids, song.composer, config);
  switch (outcome.result) {
    case 'correct':
      return finishRound(h, state, say(h).correct(state, outcome.playerIndex, song, answer));
    case 'duplicate':
      return ask(h, state, say(h).duplicateGuess(state, getComposer(outcome.guessedId)));
    default: {
      const lead = say(h).wrong(state, outcome.playerIndex, getComposer(outcome.guessedId));
      if (outcome.roundOver) return finishRound(h, state, `${lead} ${say(h).nobodyGotIt(state, song, answer)}`);
      return ask(h, state, `${lead} ${say(h).askGuess(state)}`);
    }
  }
}

function passTurn(h, state) {
  const song = currentSong(state);
  const outcome = game.pass(state, config);
  const lead = say(h).passed(state, outcome.playerIndex);
  if (outcome.roundOver) {
    return finishRound(h, state, `${lead} ${say(h).nobodyGotIt(state, song, getComposer(song.composer))}`);
  }
  return ask(h, state, `${lead} ${say(h).askGuess(state)}`);
}

function giveHint(h, state) {
  state.hints += 1;
  if (state.hints > 2) return ask(h, state, say(h).noMoreHints(state));
  return ask(h, state, say(h).hint(state, getComposer(currentSong(state).composer)));
}

function repeatClip(h, state) {
  return ask(h, state, say(h).repeatClip(state, clipUrl(currentSong(state))));
}

function skipSong(h, state) {
  const song = currentSong(state);
  return finishRound(h, state, say(h).skipped(song, getComposer(song.composer)));
}

function reportScore(h, state) {
  const follow = state.phase === PHASE.PLAYING ? say(h).askGuess(state) : say(h).playAgainReprompt();
  return ask(h, state, `${say(h).scoreReport(state)} ${follow}`);
}

function notUnderstood(h, state) {
  switch (state.phase) {
    case PHASE.SETUP_COUNT:
      return ask(h, state, say(h).countNotUnderstood());
    case PHASE.SETUP_NAMES:
      return ask(h, state, say(h).nameNotUnderstood(game.namingIndex(state), state.playerCount));
    case PHASE.PLAYING:
      state.misses += 1;
      return ask(h, state, say(h).notUnderstood(state));
    default:
      return ask(h, state, say(h).playAgainReprompt());
  }
}

/** Handle an answer while a clip is being guessed. */
function answerInGame(h, state, slot) {
  const answer = interpretAnswer(slot, wordsFor(say(h)));
  switch (answer.kind) {
    case 'guess': return makeGuess(h, state, answer.ids);
    case 'pass': return passTurn(h, state);
    case 'hint': return giveHint(h, state);
    case 'repeat': return repeatClip(h, state);
    case 'score': return reportScore(h, state);
    default: return notUnderstood(h, state);
  }
}

/**
 * Route free-form words (from whichever intent Alexa picked) according to what we're
 * waiting for. Alexa sometimes picks the "wrong" intent for a bare word, e.g. a player
 * name heard as a composer, so every phase accepts every slot.
 */
function routeRawAnswer(h, state, slot) {
  const raw = (slot && slot.value) || '';
  if (state.phase === PHASE.SETUP_COUNT) {
    if (h.requestEnvelope.session && h.requestEnvelope.session.new) return welcome(h);
    const count = parseCount(raw);
    return Number.isNaN(count) ? notUnderstood(h, state) : setCount(h, state, count);
  }
  if (state.phase === PHASE.SETUP_NAMES) return raw ? addName(h, state, raw) : notUnderstood(h, state);
  if (state.phase === PHASE.PLAYING) return raw ? answerInGame(h, state, slot) : notUnderstood(h, state);
  return ask(h, state, say(h).playAgainReprompt());
}

// ======================================================================= handlers

function isIntent(h, ...names) {
  return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
    && names.includes(Alexa.getIntentName(h.requestEnvelope));
}

const LaunchRequestHandler = {
  canHandle: (h) => Alexa.getRequestType(h.requestEnvelope) === 'LaunchRequest',
  handle: (h) => welcome(h),
};

const PlayerCountIntentHandler = {
  canHandle: (h) => isIntent(h, 'PlayerCountIntent'),
  handle(h) {
    const state = getState(h);
    if (state.phase === PHASE.SETUP_COUNT) {
      const count = parseCount(slotValue(h, 'count'));
      if (Number.isNaN(count)) return notUnderstood(h, state);
      return setCount(h, state, count);
    }
    return routeRawAnswer(h, state, Alexa.getSlot(h.requestEnvelope, 'count'));
  },
};

const PlayerNameIntentHandler = {
  canHandle: (h) => isIntent(h, 'PlayerNameIntent'),
  handle(h) {
    const state = getState(h);
    return routeRawAnswer(h, state, Alexa.getSlot(h.requestEnvelope, 'name'));
  },
};

const AnswerIntentHandler = {
  canHandle: (h) => isIntent(h, 'AnswerIntent'),
  handle(h) {
    const state = getState(h);
    return routeRawAnswer(h, state, Alexa.getSlot(h.requestEnvelope, 'composer'));
  },
};

const PassIntentHandler = {
  canHandle: (h) => isIntent(h, 'PassIntent'),
  handle(h) {
    const state = getState(h);
    if (state.phase === PHASE.PLAYING) return passTurn(h, state);
    if (state.phase === PHASE.SETUP_NAMES) return skipName(h, state);
    return notUnderstood(h, state);
  },
};

const HintIntentHandler = {
  canHandle: (h) => isIntent(h, 'HintIntent'),
  handle(h) {
    const state = getState(h);
    if (state.phase === PHASE.PLAYING) return giveHint(h, state);
    return ask(h, state, say(h).hintsOnlyInGame(defaultReprompt(h, state)));
  },
};

const ScoreIntentHandler = {
  canHandle: (h) => isIntent(h, 'ScoreIntent'),
  handle(h) {
    const state = getState(h);
    if (state.phase === PHASE.PLAYING || state.phase === PHASE.GAME_OVER) return reportScore(h, state);
    return ask(h, state, say(h).notStartedYet(defaultReprompt(h, state)));
  },
};

const RepeatIntentHandler = {
  canHandle: (h) => isIntent(h, 'AMAZON.RepeatIntent'),
  handle(h) {
    const state = getState(h);
    if (state.phase === PHASE.PLAYING) return repeatClip(h, state);
    if (state.phase === PHASE.GAME_OVER) {
      return ask(h, state, `${say(h).finalResults(state)} ${say(h).playAgainReprompt()}`);
    }
    return ask(h, state, defaultReprompt(h, state));
  },
};

const NextIntentHandler = {
  canHandle: (h) => isIntent(h, 'AMAZON.NextIntent'),
  handle(h) {
    const state = getState(h);
    if (state.phase === PHASE.PLAYING) return skipSong(h, state);
    if (state.phase === PHASE.SETUP_NAMES) return skipName(h, state);
    return notUnderstood(h, state);
  },
};

const YesIntentHandler = {
  canHandle: (h) => isIntent(h, 'AMAZON.YesIntent'),
  handle(h) {
    const state = getState(h);
    if (state.phase === PHASE.GAME_OVER) return beginGame(h, state, say(h).newGameSamePlayers());
    return notUnderstood(h, state);
  },
};

const NoIntentHandler = {
  canHandle: (h) => isIntent(h, 'AMAZON.NoIntent'),
  handle(h) {
    const state = getState(h);
    if (state.phase === PHASE.GAME_OVER) return tell(h, state, say(h).goodbye());
    return notUnderstood(h, state);
  },
};

const StartOverIntentHandler = {
  canHandle: (h) => isIntent(h, 'AMAZON.StartOverIntent'),
  handle(h) {
    const state = game.createState();
    return ask(h, state, say(h).startOver());
  },
};

const HelpIntentHandler = {
  canHandle: (h) => isIntent(h, 'AMAZON.HelpIntent'),
  handle(h) {
    const state = getState(h);
    return ask(h, state, say(h).help(state));
  },
};

const StopIntentHandler = {
  canHandle: (h) => isIntent(h, 'AMAZON.StopIntent', 'AMAZON.CancelIntent', 'AMAZON.NavigateHomeIntent'),
  handle(h) {
    const state = getState(h);
    const text = state.phase === PHASE.PLAYING ? say(h).stoppedMidGame(state) : say(h).goodbye();
    return tell(h, state, text);
  },
};

// AMAZON.FallbackIntent, plus any intent we don't know about.
const FallbackHandler = {
  canHandle: (h) => Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest',
  handle(h) {
    const state = getState(h);
    const raw = anyRawValue(h);
    if (raw) return routeRawAnswer(h, state, { value: raw });
    if (state.phase === PHASE.SETUP_COUNT && h.requestEnvelope.session && h.requestEnvelope.session.new) {
      return welcome(h);
    }
    return notUnderstood(h, state);
  },
};

const SessionEndedRequestHandler = {
  canHandle: (h) => Alexa.getRequestType(h.requestEnvelope) === 'SessionEndedRequest',
  handle(h) {
    const { reason, error } = h.requestEnvelope.request;
    console.log(`Session ended: ${reason}${error ? ` (${error.type}: ${error.message})` : ''}`);
    return h.responseBuilder.getResponse();
  },
};

const ErrorHandler = {
  canHandle: () => true,
  handle(h, error) {
    console.error('Error handling request:', error && error.stack ? error.stack : error);
    const text = say(h).error();
    return h.responseBuilder.speak(text).reprompt(text).getResponse();
  },
};

const LogRequestInterceptor = {
  process(h) {
    const type = Alexa.getRequestType(h.requestEnvelope);
    const intent = type === 'IntentRequest' ? ` ${Alexa.getIntentName(h.requestEnvelope)}` : '';
    const phase = (h.attributesManager.getSessionAttributes().game || {}).phase || 'NEW';
    console.log(`Request: ${type}${intent} [${phase}]`);
  },
};

exports.handler = Alexa.SkillBuilders.custom()
  .addRequestHandlers(
    LaunchRequestHandler,
    PlayerCountIntentHandler,
    PlayerNameIntentHandler,
    AnswerIntentHandler,
    PassIntentHandler,
    HintIntentHandler,
    ScoreIntentHandler,
    RepeatIntentHandler,
    NextIntentHandler,
    YesIntentHandler,
    NoIntentHandler,
    StartOverIntentHandler,
    HelpIntentHandler,
    StopIntentHandler,
    SessionEndedRequestHandler,
    FallbackHandler,
  )
  .addRequestInterceptors(LogRequestInterceptor)
  .addErrorHandlers(ErrorHandler)
  .withCustomUserAgent('composer-quiz/1.0')
  .lambda();

// Exposed for unit tests.
exports._internals = { detectCommand, interpretAnswer, parseCount, wordsFor };
