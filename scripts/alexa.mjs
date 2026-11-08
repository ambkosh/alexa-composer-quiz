#!/usr/bin/env node
// Develop against the Alexa-hosted skill from the command line instead of the developer
// console. Needs the ASK CLI, logged in once with `ask configure` (no AWS account needed).
//
//   npm run alexa -- setup <skill-id>     once: check out the hosted skill's code repo into .alexa/hosted
//   npm run alexa -- deploy               deploy lambda/ (git push) and the interaction models, wait for both
//   npm run alexa -- deploy --code        only the code
//   npm run alexa -- deploy --models      only the interaction models
//   npm run alexa -- dialog de-DE "starte komponisten quiz" "zwei" "Anna"   talk to the skill
//   npm run alexa -- dialog de-DE --file test/dialogs/de-DE.txt [--io out.json]
//   npm run alexa -- status               build and deployment status
//
// The hosted repo only holds lambda/. The skill's manifest (name, locales, endpoint) stays
// as it is on Amazon's side; models are only deployed for locales the skill already has.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const alexaDir = join(root, '.alexa');
const hostedDir = join(alexaDir, 'hosted');

function run(cmd, args, { cwd = root, input, quiet = false } = {}) {
  const res = spawnSync(cmd, args, { cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const msg = `${cmd} ${args.slice(0, 3).join(' ')} … failed (exit ${res.status})\n${hide(res.stderr || res.stdout)}`;
    if (quiet) return null;
    throw new Error(msg);
  }
  return res.stdout;
}

/** Status responses contain temporary AWS sign-in links; never print them. */
function hide(text) {
  return String(text).replace(/https:\/\/signin\.aws\.amazon\.com\/\S+/g, '<sign-in link hidden>');
}

function smapi(...args) {
  const out = run('ask', ['smapi', ...args]);
  return out.trim() ? JSON.parse(out) : {};
}

function skillId() {
  if (process.env.ALEXA_SKILL_ID) return process.env.ALEXA_SKILL_ID;
  const states = join(hostedDir, '.ask/ask-states.json');
  if (!existsSync(states)) fail('No skill set up yet. Run: npm run alexa -- setup <skill-id>  (ask smapi list-skills-for-vendor lists your skills)');
  return JSON.parse(readFileSync(states, 'utf8')).profiles.default.skillId;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- setup

function setup(id) {
  if (!id) fail('Usage: npm run alexa -- setup <skill-id>');
  if (existsSync(hostedDir)) fail(`${relative(root, hostedDir)} already exists.`);
  mkdirSync(alexaDir, { recursive: true });
  // `ask init` asks for a folder name; answer "hosted".
  run('ask', ['init', '--hosted-skill-id', id], { cwd: alexaDir, input: 'hosted\n' });
  console.log(`Checked out the hosted skill into ${relative(root, hostedDir)}.`);
}

// ---------------------------------------------------------------- deploy

function listFiles(dir, base = dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...listFiles(path, base));
    else files.push(relative(base, path));
  }
  return files;
}

/** Make .alexa/hosted/lambda an exact copy of lambda/ (without node_modules). */
function syncLambda() {
  const src = join(root, 'lambda');
  const dest = join(hostedDir, 'lambda');
  const wanted = new Set(listFiles(src));
  if (existsSync(dest)) {
    for (const file of listFiles(dest)) if (!wanted.has(file)) rmSync(join(dest, file));
  }
  cpSync(src, dest, { recursive: true, filter: (path) => !relative(src, path).split(/[\\/]/).includes('node_modules') });
}

function deployCode() {
  const git = (...args) => run('git', args, { cwd: hostedDir });
  // Build on whatever is deployed now (e.g. after an edit in the console's Code tab);
  // this project's lambda/ then replaces it.
  git('fetch', '-q', 'origin', 'master');
  git('reset', '-q', '--mixed', 'origin/master');
  syncLambda();
  git('add', '--all', 'lambda');
  if (existsSync(join(hostedDir, '.gitignore'))) git('add', '.gitignore');
  if (spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: hostedDir }).status === 0) {
    console.log('Code: no changes since the last deploy.');
    return null;
  }
  const rev = run('git', ['rev-parse', '--short', 'HEAD'], { quiet: true })?.trim() || 'unknown';
  const dirty = run('git', ['status', '--porcelain', '--', 'lambda'], { quiet: true })?.trim() ? '+local changes' : '';
  git('commit', '-q', '-m', `Deploy alexa-composer-quiz ${rev}${dirty}`);
  const sha = git('rev-parse', 'HEAD').trim();
  console.log(`Code: pushing ${sha.slice(0, 7)} to the hosted skill…`);
  git('push', '-q', 'origin', 'HEAD:master');
  return sha;
}

function skillLocales(id) {
  return Object.keys(smapi('get-skill-manifest', '-s', id, '-g', 'development').manifest.publishingInformation.locales);
}

function deployModels(id) {
  const deployed = [];
  const enabled = skillLocales(id);
  const modelsDir = join(root, 'skill-package/interactionModels/custom');
  for (const file of readdirSync(modelsDir).filter((f) => f.endsWith('.json'))) {
    const locale = file.replace(/\.json$/, '');
    if (!enabled.includes(locale)) {
      console.log(`Models: skipping ${locale}, the skill doesn't have that language (it has ${enabled.join(', ')}).`);
      continue;
    }
    run('ask', ['smapi', 'set-interaction-model', '-s', id, '-g', 'development', '-l', locale,
      '--interaction-model', `file:${join(modelsDir, file)}`]);
    console.log(`Models: uploaded ${locale}, building…`);
    deployed.push(locale);
  }
  return deployed;
}

async function waitFor(id, { sha, locales }) {
  const deadline = Date.now() + 10 * 60 * 1000;
  await sleep(3000);
  for (;;) {
    const status = smapi('get-skill-status', '-s', id);
    const pending = [];
    const report = [];
    if (sha) {
      const last = (status.hostedSkillDeployment || {}).lastUpdateRequest || {};
      const current = last.deploymentDetails && last.deploymentDetails.commitId === sha;
      if (!current || last.status === 'IN_PROGRESS') pending.push('code');
      else report.push(`code ${last.status}${errors(last)}`);
    }
    for (const locale of locales) {
      const last = (((status.interactionModel || {})[locale]) || {}).lastUpdateRequest || {};
      if (!last.status || last.status === 'IN_PROGRESS') pending.push(locale);
      else report.push(`${locale} model ${last.status}${errors(last)}`);
    }
    if (!pending.length) {
      console.log(report.join('\n'));
      return !report.some((r) => /FAILED/.test(r));
    }
    if (Date.now() > deadline) {
      console.log(`Still waiting for: ${pending.join(', ')}. Check with: npm run alexa -- status`);
      return false;
    }
    await sleep(5000);
  }
}

function errors(update) {
  const list = [...(update.errors || []), ...((update.buildDetails || {}).steps || []).flatMap((s) => s.errors || [])];
  return list.length ? `\n  ${list.map((e) => hide(e.message || JSON.stringify(e))).join('\n  ')}` : '';
}

async function deploy(flags) {
  const id = skillId();
  const code = !flags.includes('--models');
  const models = !flags.includes('--code');
  const sha = code ? deployCode() : null;
  const locales = models ? deployModels(id) : [];
  if (!sha && !locales.length) return;
  const ok = await waitFor(id, { sha, locales });
  if (!ok) process.exit(1);
}

// ---------------------------------------------------------------- dialog

function dialog(args) {
  const [locale, ...rest] = args;
  if (!locale || !/^[a-z]{2}-[A-Z]{2}$/.test(locale)) fail('Usage: npm run alexa -- dialog <locale> "utterance" … | --file <path> [--io <file>]');
  let utterances = [];
  let io = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--file') {
      utterances.push(...readFileSync(rest[++i], 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
    } else if (rest[i] === '--io') {
      io = rest[++i];
    } else {
      utterances.push(rest[i]);
    }
  }
  if (!utterances.length) fail('Nothing to say.');
  mkdirSync(alexaDir, { recursive: true });
  const replay = join(alexaDir, 'replay.json');
  io = io || join(alexaDir, 'last-dialog.json');
  rmSync(io, { force: true });
  writeFileSync(replay, JSON.stringify({ skillId: skillId(), locale, type: 'text', userInput: [...utterances, '.quit'] }, null, 2));
  const res = spawnSync('ask', ['dialog', '-r', replay, '-g', 'development', '--save-skill-io', io],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (!existsSync(io)) fail(hide(`ask dialog failed:\n${res.stderr || res.stdout}`));
  printDialog(JSON.parse(readFileSync(io, 'utf8')));
  console.log(`\n(full requests and responses: ${relative(root, io)})`);
  if (res.status !== 0) process.exit(res.status || 1);
}

/** Print each turn from a --save-skill-io file: what was said, the intent, Alexa's answer. */
function printDialog(saved) {
  let utterance = '';
  for (const entry of saved.invocations || []) {
    if (entry.request && entry.request.utterance) utterance = entry.request.utterance;
    const body = (entry.response || {}).body || {};
    if (body.status === 'IN_PROGRESS') continue;
    console.log(`\nUser  > ${utterance}`);
    if (body.status !== 'SUCCESSFUL') {
      console.log(`Error > ${hide(JSON.stringify(body.result && body.result.error || body))}`);
      continue;
    }
    const result = body.result || {};
    for (const call of (result.skillExecutionInfo || {}).invocations || []) {
      const request = ((call.invocationRequest || {}).body || {}).request || {};
      const slots = Object.values((request.intent || {}).slots || {}).filter((s) => s.value).map((s) => `${s.name}=${s.value}`);
      console.log(`        [${request.type}${request.intent ? ` ${request.intent.name}` : ''}${slots.length ? ` ${slots.join(' ')}` : ''}${request.reason ? ` ${request.reason}` : ''}]`);
    }
    const said = ((result.alexaExecutionInfo || {}).alexaResponses || []).map((r) => (r.content || {}).caption || '').filter(Boolean);
    console.log(`Alexa > ${said.join(' ').replace(/<Short audio>/g, '♪') || '(nothing)'}`);
  }
}

// ---------------------------------------------------------------- status

function status() {
  const id = skillId();
  const s = smapi('get-skill-status', '-s', id);
  const deployment = (s.hostedSkillDeployment || {}).lastUpdateRequest || {};
  console.log(`Skill ${id}`);
  console.log(`code: ${deployment.status || 'unknown'} (commit ${((deployment.deploymentDetails || {}).commitId || '').slice(0, 7)})${errors(deployment)}`);
  for (const [locale, m] of Object.entries(s.interactionModel || {})) {
    console.log(`${locale} model: ${(m.lastUpdateRequest || {}).status || 'unknown'}${errors(m.lastUpdateRequest || {})}`);
  }
  console.log(`languages: ${skillLocales(id).join(', ')}`);
}

// ---------------------------------------------------------------- main

const [command, ...args] = process.argv.slice(2);
try {
  switch (command) {
    case 'setup': setup(args[0]); break;
    case 'deploy': await deploy(args); break;
    case 'dialog': dialog(args); break;
    case 'status': status(); break;
    default: fail('Commands: setup <skill-id> | deploy [--code|--models] | dialog <locale> … | status');
  }
} catch (err) {
  fail(hide(err.message));
}
