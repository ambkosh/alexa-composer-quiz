'use strict';

// SSML helpers shared by all languages.

const config = require('../config');

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

function firstLetter(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').charAt(0).toUpperCase();
}

/**
 * A composer or song with its translated fields (the "de" object in the data files)
 * laid over the English ones.
 */
function localize(entity, lang) {
  return entity && entity[lang] ? { ...entity, ...entity[lang] } : entity;
}

module.exports = { escape, pick, audio, sound, pause, firstLetter, localize };
