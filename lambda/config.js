'use strict';

// Tunable settings for the skill. Environment variables override the defaults,
// which is handy for self-hosted Lambda deployments. Alexa-hosted skills can't
// set environment variables, so edit the defaults here instead.
module.exports = {
  // HTTPS folder that holds the clips built by `npm run build:clips` (audio/<song id>.mp3).
  // The default serves the audio/ folder of the public GitHub repo through the jsDelivr CDN.
  // Pin it to a tag or commit (…@v1.0.0/audio) once the clips are final, so CDN caching
  // can't serve stale files.
  audioBaseUrl: process.env.AUDIO_BASE_URL
    || 'https://cdn.jsdelivr.net/gh/ambkosh/alexa-composer-quiz@main/audio',

  maxPlayers: 4,

  // A game has at least this many rounds, rounded up to a multiple of the player count
  // so every player opens the same number of rounds (1, 2 or 4 players: 8 rounds; 3 players: 9).
  minRounds: 8,

  // How many guesses a solo player gets per song. In multiplayer games, every player
  // gets one guess per song, in turn.
  soloGuesses: 2,

  // Sounds from the Alexa Skills Kit sound library.
  sounds: {
    intro: 'soundbank://soundlibrary/ui/gameshow/amzn_ui_sfx_gameshow_intro_01',
    correct: 'soundbank://soundlibrary/ui/gameshow/amzn_ui_sfx_gameshow_positive_response_01',
    wrong: 'soundbank://soundlibrary/ui/gameshow/amzn_ui_sfx_gameshow_negative_response_01',
    outro: 'soundbank://soundlibrary/ui/gameshow/amzn_ui_sfx_gameshow_outro_01',
  },
};
