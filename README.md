# Composer Quiz – an Alexa skill

A guess-the-composer party game for one to four players. Alexa plays a short clip of a
famous classical piece, and players take turns naming the composer. A correct answer
earns a point; the player with the most points at the end wins.

The skill speaks **English** (en-US, "Alexa, open composer quiz") and **German** (de-DE,
"Alexa, starte Komponisten Quiz"). Alexa picks the language from the Echo's language setting.

```
"Alexa, open composer quiz"
  How many players are there?          → "three"
  Player one, what's your name?        → "Anna"   (then Ben, Cleo)
  Round 1 of 9. Listen carefully. ♪ … ♪ Anna, who's the composer?
                                       → "Mozart"
  Sorry Anna, it's not Mozart. Ben, your turn. Who's the composer?
                                       → "I think it's Beethoven"
  Correct! That was Für Elise by Ludwig van Beethoven. Ben gets a point and now has one point.
  Round 2 of 9. ♪ … ♪ Ben, who wrote this?   (the first guesser rotates every round)
```

## How a game works

- **Players:** 1–4. Each player gives a name (or says "skip" to be "Player 2"). Alexa
  can't tell voices apart, so it calls out whose turn it is.
- **Rounds:** at least 8, rounded up to a multiple of the player count so everybody opens
  the same number of rounds (8 rounds for 1, 2 or 4 players; 9 for 3).
- **Turns:** each round a different player guesses first. On a wrong guess or a pass, the
  next player gets a try; if nobody gets it, Alexa reveals the answer. A composer that was
  already guessed wrong in a round doesn't cost a turn. Solo players get two guesses per song.
- **Songs:** picked at random from 55 clips by 30 composers. Within a game, no composer
  repeats until every composer has had a turn. A rematch prefers songs you haven't heard yet.
- **During a round you can say:** a composer's name ("Bach", "it's Tchaikovsky"), "pass",
  "hint" (nationality and era, then the first letter), "repeat", "skip this song",
  "what's the score", "help", or "stop".
  In German: "Bach", "ich glaube Tschaikowsky", "passe", "Tipp", "nochmal", "nächstes Stück",
  "wie ist der Punktestand", "Hilfe", "Stopp".
- Alexa recognises 64 composers, so guesses like "Mahler" are accepted as (wrong) answers
  rather than misheard.

## Repository layout

```
lambda/                    skill code (Node.js, ASK SDK v2)
  index.js                 request handlers: routing by game phase
  game.js                  game rules (pure functions, no Alexa code)
  speech/en.js, speech/de.js  everything Alexa says, in English and German
  speech/index.js          picks the language from the request locale
  composers.js             composer lookup + fuzzy matching of what Alexa heard
  config.js                settings: audio URL, rounds, sounds, …
  data/composers.json      composers: names, synonyms, hint data (German in the "de" fields)
  data/songs.json          the song catalog (piece, composer, source recording, clip start, German title)
skill-package/             skill manifest and interaction models (en-US, de-DE)
scripts/build-model.mjs    writes the COMPOSER slot type of both models from composers.json
scripts/build-clips.mjs    downloads source recordings and builds audio/*.mp3
audio/                     the clips Alexa plays (+ clips.json with clip offsets/sources)
CREDITS.md                 performer, license and source page of every recording
test/                      unit and end-to-end tests (node --test)
```

## Deploying

The clips must be reachable over HTTPS. By default the skill loads them from this repo
through the jsDelivr CDN (`config.audioBaseUrl`):

```
https://cdn.jsdelivr.net/gh/ambkosh/alexa-composer-quiz@main/audio/<song id>.mp3
```

so **push the repo (including `audio/`) to GitHub first**, and keep it public.

### Option A: Alexa-hosted skill (free, no AWS account)

1. Open the [Alexa developer console](https://developer.amazon.com/alexa/console/ask) and
   click **Create Skill**.
2. Name it "Composer Quiz", primary locale **German (DE)** or **English (US)** (both are
   imported either way), type **Custom**, hosting **Alexa-hosted (Node.js)**.
3. On the template page choose **Import skill** and enter
   `https://github.com/ambkosh/alexa-composer-quiz.git`.
4. When the import finishes, open the **Build** tab and click **Build skill** if the
   model isn't built yet (do this for each language, using the language menu at the top).
   Then open **Test**, set testing to **Development**, pick the language, and type or say
   "starte Komponisten Quiz" (German) or "open composer quiz" (English).

To try it on an Echo, the device has to be registered to the same Amazon account. An Echo
set to German gets the German version, one set to English (United States) the English one.

The Alexa-hosted skill keeps its own copy of the code, so later changes on GitHub don't
reach it by themselves: import the skill again, or copy the changed files into the
console's **Code** tab and click **Deploy**. The clips are the exception, since they are
always loaded from GitHub.

### Option B: ASK CLI with your own AWS account

```sh
npm install -g ask-cli
ask configure
ask deploy          # uses ask-resources.json: Lambda on nodejs22.x in us-east-1
```

### Hosting the clips somewhere else

Upload `audio/*.mp3` to any HTTPS host (S3, GitHub Pages, your own server) and set
`audioBaseUrl` in `lambda/config.js` (or the `AUDIO_BASE_URL` environment variable on
Lambda). Once your clips are final, pin the jsDelivr URL to a tag or commit
(`…@v1.0.0/audio`), because jsDelivr can cache `@main` for up to a week.

## Changing the music

Add or edit entries in `lambda/data/songs.json`:

```json
{ "id": "grieg-morning-mood", "composer": "grieg", "title": "Morning Mood from Peer Gynt",
  "source": "Grieg - Peer Gynt Suite No. 1, Op. 46 - I. Morning Mood (Musopen Symphony).flac",
  "start": 0, "duration": 25 }
```

- `source` is a file name on [Wikimedia Commons](https://commons.wikimedia.org/) (without `File:`).
- `start` is where the clip starts, in seconds, or `"loudest"` to pick the loudest stretch
  (good for big finales such as the 1812 Overture). `duration` defaults to 25 seconds.
- `title` is what Alexa says when revealing the answer ("That was *title* by *composer*").
- `de.title` is the German title, with its article ("Das war *der Walkürenritt* von …").

Then rebuild:

```sh
npm run build:clips                         # builds missing clips, updates CREDITS.md
npm run build:clips -- --only grieg-morning-mood --force   # rebuild one clip
```

The script needs `ffmpeg`/`ffprobe`. It only accepts recordings marked public domain or
CC0 on Commons (`--allow-attribution` also allows CC BY/BY-SA; then you must credit them).
Clips are encoded to Alexa's SSML audio format: MP3, 48 kbps, 24 kHz.

The clip start points were chosen without listening to every recording, so some clips may
not start at the most recognisable part. Listen to `audio/*.mp3` and adjust `start` where
needed.

New composers go in `lambda/data/composers.json` (name, synonyms Alexa might hear,
nationality and era for hints). The `de` object holds the German version: `origin` and
`period` for the hint ("Dieser Komponist kam aus *Russland*. Seine Musik stammt aus *der
Romantik*."), plus `name`, `fullName` and `synonyms` where German spelling differs
("Tschaikowsky"). Run `npm run build:model` afterwards to update both interaction models,
then rebuild the models in the developer console.

## Development

```sh
(cd lambda && npm install)
npm test             # game rules, composer matching, interaction model, clips, full simulated games
npm run check        # also verifies the interaction model is in sync with composers.json
```

Settings in `lambda/config.js`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `audioBaseUrl` | jsDelivr URL of `audio/` | where the clips are served from |
| `maxPlayers` | 4 | maximum number of players |
| `minRounds` | 8 | minimum rounds per game |
| `soloGuesses` | 2 | guesses per song in a solo game |
| `useElicitSlot` | true | ask Alexa to expect a composer name next (see below) |

### Speech recognition notes

- While a clip is being guessed, the skill sends a `Dialog.ElicitSlot` directive for the
  composer slot, which biases Alexa's recognition towards composer names. Every phase also
  accepts answers that Alexa routed to the "wrong" intent (a name heard as a composer, a
  composer heard as a first name) and fuzzy-matches unresolved words ("tschaikowsky").
- If you find that Alexa doesn't reprompt a silent player on your device, set
  `useElicitSlot` to `false` (or `USE_ELICIT_SLOT=false` on Lambda) and compare.
- Players have about 8 seconds to answer, then Alexa reprompts once before the session ends.

## Credits

Recordings come from Wikimedia Commons, mostly from Musopen and US military bands. See
[CREDITS.md](CREDITS.md) for performers, licenses and source pages.
