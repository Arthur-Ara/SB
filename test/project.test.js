'use strict';

// Cohérence du projet : changelog, version, catalogue des droits du panel et définitions des slash commands.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const changelog = JSON.parse(fs.readFileSync(path.join(root, 'changelog.json'), 'utf8'));

test('changelog : la plus récente version correspond à package.json', () => {
  assert.ok(Array.isArray(changelog) && changelog.length);
  assert.equal(changelog[0].version, pkg.version);
});

test('changelog : versions uniques, dates valides, entrées non vides', () => {
  const versions = changelog.map((entry) => entry.version);
  assert.equal(new Set(versions).size, versions.length);
  for (const entry of changelog) {
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/, entry.version);
    assert.ok(entry.changes.length, `${entry.version} : aucune modification`);
    for (const change of entry.changes) assert.ok(change.text && change.module && change.type, `${entry.version} : modification incomplète`);
  }
});

test('catalogue des droits du panel : libellés présents et compatibles avec Discord (≤ 100 caractères)', () => {
  const { WEB_CATEGORIES } = require('../modules/permissions/lib/webRights');
  for (const [key, def] of Object.entries(WEB_CATEGORIES)) {
    assert.ok(def.label, key);
    for (const [right, label] of Object.entries(def.rights)) {
      assert.ok(right.length <= 32, `${key}.${right} : clé trop longue`);
      assert.ok(label && label.length <= 100, `${key}.${right} : libellé absent ou trop long`);
    }
  }
});

/** Fichiers de commandes : src/bot/commands et modules/<nom>/commands. */
function commandFiles() {
  const files = [];
  const add = (dir) => fs.existsSync(dir) && fs.readdirSync(dir).filter((f) => f.endsWith('.js')).forEach((f) => files.push(path.join(dir, f)));
  add(path.join(root, 'src', 'bot', 'commands'));
  for (const name of fs.readdirSync(path.join(root, 'modules'))) add(path.join(root, 'modules', name, 'commands'));
  return files;
}

test('slash commands : définitions valides pour Discord (noms, descriptions, options)', (t) => {
  let discord;
  try {
    discord = require('discord.js');
  } catch {
    t.skip('discord.js non installé (npm install)');
    return;
  }
  void discord;
  const names = new Set();
  for (const file of commandFiles()) {
    const command = require(file);
    const label = path.relative(root, file);
    assert.ok(command.data && typeof command.execute === 'function', `${label} : data/execute manquant`);
    const json = command.data.toJSON(); // les builders de discord.js valident longueurs et formats
    assert.ok(!names.has(json.name), `${label} : nom /${json.name} déjà utilisé`);
    names.add(json.name);
    const walk = (options = [], where = `/${json.name}`) => {
      assert.ok(options.length <= 25, `${where} : plus de 25 options`);
      for (const option of options) {
        assert.ok(option.description.length <= 100, `${where} ${option.name} : description trop longue`);
        if (option.options) walk(option.options, `${where} ${option.name}`);
      }
    };
    assert.ok(json.description.length <= 100, `/${json.name} : description trop longue`);
    walk(json.options);
  }
  assert.ok(names.size > 10);
});
