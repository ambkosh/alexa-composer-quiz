'use strict';

// Picks the speech module for the request's locale. de-* gets German, everything else
// English. To add a language, copy en.js, translate it, and register it here.

const en = require('./en');
const de = require('./de');

const LANGUAGES = { en, de };

function forLocale(locale) {
  const lang = String(locale || '').slice(0, 2).toLowerCase();
  return LANGUAGES[lang] || en;
}

module.exports = { forLocale, LANGUAGES };
