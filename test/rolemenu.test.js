'use strict';

// RôleMenu : sélecteur personnel (réponse éphémère) avec les rôles déjà possédés présélectionnés.
const test = require('node:test');
const assert = require('node:assert/strict');

test('menu déroulant : publié vide, personnel avec les rôles du membre cochés', (t) => {
  let selectRow;
  try {
    ({ selectRow } = require('../modules/rolemenu/lib/message'));
  } catch {
    t.skip('discord.js non installé (npm install)');
    return;
  }
  const guild = { roles: { cache: new Map([['11', { name: 'Rouge' }], ['12', { name: 'Bleu' }], ['13', { name: 'Vert' }]]) } };
  const options = [{ id: 1, role_id: '11' }, { id: 2, role_id: '12' }, { id: 3, role_id: '13' }];
  const menu = { id: 4, mode: 'multiple', max_selected: null };

  const published = selectRow(guild, menu, options).toJSON().components[0];
  assert.equal(published.custom_id, 'rm:s:4');
  assert.ok(published.options.every((o) => !o.default));

  const personal = selectRow(guild, menu, options, { personal: true, ownedIds: ['1', '3'] }).toJSON().components[0];
  assert.equal(personal.custom_id, 'rm:p:4');
  assert.deepEqual(personal.options.filter((o) => o.default).map((o) => o.value), ['1', '3']);

  // « Un seul rôle » : jamais plus d'une option présélectionnée (Discord refuserait le menu).
  const single = selectRow(guild, { ...menu, mode: 'single' }, options, { personal: true, ownedIds: ['1', '3'] }).toJSON().components[0];
  assert.equal(single.options.filter((o) => o.default).length, 1);
});
