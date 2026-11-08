'use strict';

// End-to-end tests: drive the Lambda handler with Alexa request envelopes, the same way
// the Alexa service would, and check what the skill says and does.

const test = require('node:test');
const assert = require('node:assert/strict');

// Keep the skill's CloudWatch-style request logging out of the test output.
console.log = () => {};

const { handler, _internals } = require('../lambda/index');
const SONGS = require('../lambda/data/songs.json');
const config = require('../lambda/config');
const { forLocale } = require('../lambda/speech');
const { getComposer } = require('../lambda/composers');

const AUTHORITY = 'amzn1.er-authority.echo-sdk.amzn1.ask.skill.test.COMPOSER';

class Session {
  constructor(locale = 'en-US') {
    this.locale = locale;
    this.attributes = {};
    this.isNew = true;
  }

  async send(request) {
    const envelope = {
      version: '1.0',
      session: {
        new: this.isNew,
        sessionId: 'amzn1.echo-api.session.test',
        application: { applicationId: 'amzn1.ask.skill.test' },
        attributes: this.attributes,
        user: { userId: 'amzn1.ask.account.test' },
      },
      context: {
        System: {
          application: { applicationId: 'amzn1.ask.skill.test' },
          user: { userId: 'amzn1.ask.account.test' },
          device: { deviceId: 'amzn1.ask.device.test', supportedInterfaces: {} },
          apiEndpoint: 'https://api.amazonalexa.com',
        },
      },
      request: { requestId: 'amzn1.echo-api.request.test', timestamp: new Date().toISOString(), locale: this.locale, ...request },
    };
    const result = await new Promise((resolve, reject) => {
      handler(envelope, {}, (err, res) => (err ? reject(err) : resolve(res)));
    });
    this.isNew = false;
    this.attributes = result.sessionAttributes || {};
    checkSsml(result.response);
    return result.response;
  }

  launch() { return this.send({ type: 'LaunchRequest' }); }

  intent(name, slots = {}) {
    return this.send({ type: 'IntentRequest', dialogState: 'STARTED', intent: { name, confirmationStatus: 'NONE', slots } });
  }

  count(n) { return this.intent('PlayerCountIntent', { count: { name: 'count', value: String(n), confirmationStatus: 'NONE' } }); }

  name(value) { return this.intent('PlayerNameIntent', { name: { name: 'name', value, confirmationStatus: 'NONE' } }); }

  /** Answer with a composer, as Alexa's entity resolution would deliver it. */
  answer(value, id) {
    const resolution = id
      ? { authority: AUTHORITY, status: { code: 'ER_SUCCESS_MATCH' }, values: [{ value: { name: value, id } }] }
      : { authority: AUTHORITY, status: { code: 'ER_SUCCESS_NO_MATCH' } };
    return this.intent('AnswerIntent', {
      composer: { name: 'composer', value, confirmationStatus: 'NONE', resolutions: { resolutionsPerAuthority: [resolution] } },
    });
  }

  get game() { return this.attributes.game; }

  get song() {
    return SONGS.find((s) => s.id === this.game.queue[this.game.round - 1]);
  }

  get answerId() {
    return this.song.composer;
  }

  get wrongId() {
    return this.answerId === 'mozart' ? 'bach' : 'mozart';
  }
}

function speech(response) {
  return response.outputSpeech.ssml;
}

/** Well-formed SSML with at most five https audio files (Alexa's limits). */
function checkSsml(response) {
  if (!response.outputSpeech) return;
  const ssml = response.outputSpeech.ssml;
  assert.match(ssml, /^<speak>[\s\S]*<\/speak>$/);
  const stack = [];
  for (const [, close, tag, selfClose] of ssml.matchAll(/<(\/?)([a-z-]+)[^>]*?(\/?)>/g)) {
    if (selfClose) continue;
    if (close) assert.equal(stack.pop(), tag, `unbalanced </${tag}> in ${ssml}`);
    else stack.push(tag);
  }
  assert.equal(stack.length, 0, `unclosed tags in ${ssml}`);
  assert.doesNotMatch(ssml.replace(/&(amp|lt|gt|quot|apos);/g, ''), /&/, 'unescaped &');
  const sources = [...ssml.matchAll(/<audio src="([^"]+)"\/>/g)].map((m) => m[1]);
  assert.ok(sources.length <= 5, 'too many audio tags');
  for (const src of sources) assert.match(src, /^(https:\/\/|soundbank:\/\/)/);
}

async function setUp(names) {
  const s = new Session();
  await s.launch();
  await s.count(names.length);
  let last;
  for (const n of names) last = await s.name(n);
  return { s, last };
}

test('launch asks for the number of players', async () => {
  const s = new Session();
  const res = await s.launch();
  assert.match(speech(res), /How many players/);
  assert.equal(res.shouldEndSession, false);
  assert.ok(res.reprompt);
});

test('player count is validated', async () => {
  const s = new Session();
  await s.launch();
  const res = await s.count(7);
  assert.match(speech(res), /one to four players/);
  assert.equal(s.game.phase, 'SETUP_COUNT');
  const ok = await s.count(2);
  assert.match(speech(ok), /Player one, what's your name/);
});

test('one-shot launch with a player count', async () => {
  const s = new Session();
  const res = await s.count(3);
  assert.match(speech(res), /three players/);
  assert.equal(s.game.phase, 'SETUP_NAMES');
});

test('names: duplicates are rejected, skip uses a default, misrouted answers still count', async () => {
  const s = new Session();
  await s.launch();
  await s.count(3);
  await s.name('anna');
  const dup = await s.name('Anna');
  assert.match(speech(dup), /already have someone called Anna/);
  await s.intent('PassIntent');
  assert.equal(s.game.players[1].name, 'Player 2');
  // Alexa heard the last name as an AnswerIntent (e.g. "Cleo" resolved to nothing).
  const start = await s.answer('cleo');
  assert.deepEqual(s.game.players.map((p) => p.name), ['Anna', 'Player 2', 'Cleo']);
  assert.equal(s.game.phase, 'PLAYING');
  assert.match(speech(start), /Round 1 of 9/);
});

test('a full two-player game', async () => {
  const { s, last } = await setUp(['Anna', 'Ben']);
  const firstSong = s.game.queue[0];
  assert.match(speech(last), new RegExp(`<audio src="${config.audioBaseUrl}/${firstSong}\\.mp3"/>`));
  assert.match(speech(last), /Anna, who/);

  // Round 1: Anna is wrong, Ben is right.
  const wrong = await s.answer('Mozart-ish', s.wrongId);
  assert.match(speech(wrong), /Sorry Anna/);
  assert.match(speech(wrong), /Ben/);
  const right = await s.answer('right', s.answerId);
  assert.match(speech(right), /Ben gets a point and now has one point/);
  assert.match(speech(right), /Round 2 of 8/);
  assert.equal(s.game.players[1].score, 1);

  // Round 2: Ben guesses first now.
  assert.match(speech(right), /Ben, wh/);
  const hint = await s.intent('HintIntent');
  assert.match(speech(hint), /hint: this composer was/);
  const hint2 = await s.intent('HintIntent');
  assert.match(speech(hint2), /starts with the letter [A-Z]/);
  const hint3 = await s.intent('HintIntent');
  assert.match(speech(hint3), /all the hints/);
  const again = await s.intent('AMAZON.RepeatIntent');
  assert.match(speech(again), /Here it is again/);
  assert.match(speech(again), new RegExp(`${s.game.queue[1]}\\.mp3`));
  const passBen = await s.intent('PassIntent');
  assert.match(speech(passBen), /Ben passes/);
  const passAnna = await s.answer('no idea'); // forced into the composer slot
  assert.match(speech(passAnna), /Nobody got this one/);
  assert.match(speech(passAnna), /Round 3 of 8/);

  // Round 3: skip the song.
  const skipped = await s.intent('AMAZON.NextIntent');
  assert.match(speech(skipped), /skipping this one/);
  assert.match(speech(skipped), /Round 4 of 8/);

  const score = await s.intent('ScoreIntent');
  assert.match(speech(score), /After 3 of 8 rounds: Ben has one point and Anna has 0 points/);

  // Remaining rounds: the current player answers correctly.
  let res;
  while (s.game.phase === 'PLAYING') res = await s.answer('right', s.answerId);
  assert.match(speech(res), /end of the game/);
  assert.match(speech(res), /play again/);
  assert.equal(res.shouldEndSession, false);

  const again2 = await s.intent('AMAZON.YesIntent');
  assert.match(speech(again2), /same players/);
  assert.deepEqual(s.game.players.map((p) => p.score), [0, 0]);
  assert.equal(s.game.phase, 'PLAYING');

  const stop = await s.intent('AMAZON.StopIntent');
  assert.equal(stop.shouldEndSession, true);
});

test('solo game: two guesses, misunderstood answers, final verdict', async () => {
  const { s, last } = await setUp(['Kim']);
  assert.match(speech(last), /two guesses per song/);
  const unclear = await s.answer('blorp');
  assert.match(speech(unclear), /didn't catch that/);
  assert.equal(s.game.attempt, 0, 'a misunderstood answer does not use up a guess');
  const wrong = await s.answer('x', s.wrongId);
  assert.match(speech(wrong), /Sorry, it's not/);
  assert.equal(s.game.round, 1);
  const dup = await s.answer('x', s.wrongId);
  assert.match(speech(dup), /already been ruled out/);
  // Fuzzy matching of an unresolved slot value.
  const answer = SONGS.find((x) => x.id === s.game.queue[0]).composer;
  const correct = await s.answer(require('../lambda/composers').getComposer(answer).name.toLowerCase());
  assert.match(speech(correct), /That's one point so far/);
  let res;
  while (s.game.phase === 'PLAYING') res = await s.intent('PassIntent');
  assert.match(speech(res), /You got 1 out of 8/);
  const bye = await s.intent('AMAZON.NoIntent');
  assert.equal(bye.shouldEndSession, true);
  assert.match(speech(bye), /Goodbye/);
});

test('a player name heard as a first name still counts as a guess', async () => {
  const { s } = await setUp(['Anna', 'Ben']);
  const composer = require('../lambda/composers').getComposer(s.answerId);
  const res = await s.name(composer.name);
  assert.match(speech(res), /Anna gets a point/);
});

test('help, fallback and stop work in every phase', async () => {
  const s = new Session();
  await s.launch();
  assert.match(speech(await s.intent('AMAZON.HelpIntent')), /how many players/i);
  assert.match(speech(await s.intent('AMAZON.FallbackIntent')), /How many players/);
  await s.count(2);
  assert.match(speech(await s.intent('AMAZON.HelpIntent')), /player names/);
  await s.name('Anna');
  await s.name('Ben');
  const help = await s.intent('AMAZON.HelpIntent');
  assert.match(speech(help), /say the composer's name/);
  await s.answer('right', s.answerId);
  const stop = await s.intent('AMAZON.CancelIntent');
  assert.equal(stop.shouldEndSession, true);
  assert.match(speech(stop), /Anna has one point/);
});

test('start over resets to player selection', async () => {
  const { s } = await setUp(['Anna', 'Ben']);
  const res = await s.intent('AMAZON.StartOverIntent');
  assert.match(speech(res), /start over/);
  assert.equal(s.game.phase, 'SETUP_COUNT');
});

test('session end returns an empty response', async () => {
  const s = new Session();
  const res = await s.send({ type: 'SessionEndedRequest', reason: 'USER_INITIATED' });
  assert.equal(res.outputSpeech, undefined);
});

// ---------------------------------------------------------------- German (de-DE)

test('German: setup, rounds, hints and commands', async () => {
  const s = new Session('de-DE');
  const hi = await s.launch();
  assert.match(speech(hi), /Willkommen beim Komponisten-Quiz/);
  assert.match(speech(hi), /Wie viele Spieler seid ihr/);
  assert.match(speech(await s.count(6)), /eine bis vier Personen/);
  assert.match(speech(await s.count(3)), /Super, drei Spieler! Spieler eins, wie heißt du\?/);

  await s.name('Anna');
  assert.match(speech(await s.name('anna')), /schon jemanden namens Anna/);
  const skipped = await s.name('überspringen');
  assert.match(speech(skipped), /du bist Spieler zwei/);
  const start = await s.name('Cleo');
  assert.deepEqual(s.game.players.map((p) => p.name), ['Anna', 'Spieler 2', 'Cleo']);
  assert.match(speech(start), /Wir spielen 9 Runden/);
  assert.match(speech(start), /Runde 1 von 9/);
  assert.match(speech(start), /Anna, (wer|von wem)/);

  // Round 1: Anna is wrong, Spieler 2 is right; the reveal uses the German title and name.
  const wrongName = getComposer(s.wrongId).de.name || getComposer(s.wrongId).name;
  const wrong = await s.answer('x', s.wrongId);
  assert.match(speech(wrong), new RegExp(`Leider falsch, Anna, es ist nicht ${wrongName}`));
  const song = s.song;
  const composer = getComposer(song.composer);
  const right = await s.answer('x', s.answerId);
  assert.ok(speech(right).includes(`Das war ${song.de.title} von ${composer.de.fullName || composer.fullName}.`), speech(right));
  assert.match(speech(right), /Spieler 2 bekommt einen Punkt und hat jetzt einen Punkt/);
  assert.match(speech(right), /Runde 2 von 9/);

  // Round 2: Spieler 2 starts. Hints, then commands that land in the composer slot.
  assert.match(speech(await s.intent('HintIntent')), /Ein Tipp: Dieser Komponist kam aus .+\. Seine Musik stammt aus/);
  assert.match(speech(await s.intent('HintIntent')), /beginnt mit <say-as interpret-as="spell-out">[A-Z]<\/say-as>/);
  assert.match(speech(await s.intent('HintIntent')), /Mehr Tipps habe ich/);
  assert.match(speech(await s.answer('keine ahnung')), /Okay, Spieler 2 passt/);
  assert.match(speech(await s.answer('nochmal bitte')), /Hier ist es noch einmal/);
  assert.match(speech(await s.answer('wie ist der punktestand')), /Nach 1 von 9 Runden: Spieler 2 hat einen Punkt/);
  assert.match(speech(await s.intent('AMAZON.HelpIntent')), /sag einfach den Namen des Komponisten/);

  // A German spelling without entity resolution is still understood.
  const guess = await s.answer('tschaikowski');
  assert.match(speech(guess), /Tschaikowsky/);

  let res;
  while (s.game.phase === 'PLAYING') res = await s.answer('x', s.answerId);
  assert.match(speech(res), /Das Spiel ist zu Ende!/);
  assert.match(speech(res), /Endstand:/);
  assert.match(speech(res), /Wollt ihr noch einmal spielen\?/);
  assert.match(speech(await s.intent('AMAZON.YesIntent')), /Super, ein neues Spiel mit denselben Spielern/);
  const bye = await s.intent('AMAZON.StopIntent');
  assert.equal(bye.shouldEndSession, true);
  assert.match(speech(bye), /Tschüss/);
});

test('German: solo game', async () => {
  const s = new Session('de-DE');
  await s.launch();
  assert.match(speech(await s.count(1)), /Ein Solospiel, super! Wie heißt du\?/);
  const start = await s.name('Kim');
  assert.match(speech(start), /Du hast zwei Versuche pro Stück/);
  assert.match(speech(await s.answer('blorp')), /das habe ich nicht verstanden/);
  assert.match(speech(await s.answer('x', s.answerId)), /Du hast jetzt einen Punkt/);
  let res;
  while (s.game.phase === 'PLAYING') res = await s.intent('PassIntent');
  assert.match(speech(res), /Du hast 1 von 8 richtig/);
  assert.match(speech(res), /Willst du noch einmal spielen\?/);
  assert.match(speech(await s.intent('AMAZON.NoIntent')), /Danke fürs Spielen/);
});

test('other locales fall back to English', async () => {
  const s = new Session('fr-FR');
  assert.match(speech(await s.launch()), /Welcome to Composer Quiz/);
});

test('player counts in words, per language', () => {
  const { parseCount, wordsFor } = _internals;
  const en = wordsFor(forLocale('en-US'));
  const de = wordsFor(forLocale('de-DE'));
  assert.equal(parseCount('3', en), 3);
  assert.equal(parseCount('three', en), 3);
  assert.equal(parseCount('for two players', en), 2, 'a real number word beats a sound-alike');
  assert.equal(parseCount('for', en), 4);
  assert.equal(parseCount('wir sind zu dritt', de), 3);
  assert.equal(parseCount('zwei spieler', de), 2);
  assert.equal(parseCount('ich spiele allein', de), 1);
  assert.ok(Number.isNaN(parseCount('hallo', de)));
});

test('German speech has the same functions as English', () => {
  const en = forLocale('en-US');
  const de = forLocale('de-DE');
  assert.deepEqual(Object.keys(de).sort(), Object.keys(en).sort());
  assert.deepEqual(Object.keys(de.words).sort(), Object.keys(en.words).sort());
  assert.deepEqual(Object.keys(de.words.commands).sort(), Object.keys(en.words.commands).sort());
});

test('responses carry no Dialog directives and keep the session open', async () => {
  const s = new Session('de-DE');
  for (const res of [await s.launch(), await s.count(2), await s.name('Anna'), await s.name('Ben')]) {
    assert.equal((res.directives || []).length, 0);
    assert.equal(res.shouldEndSession, false);
    assert.ok(res.reprompt);
  }
});
