'use strict';

// Module Candidatures : statuts et composants du panel.
const test = require('node:test');
const assert = require('node:assert/strict');
const { STATUSES, RECRUITER_STATUSES, isFinal, timeline } = require('../modules/candidature/lib/statuses');

test('statuts : les six statuts demandés, dans l’ordre, modifiables par les recruteurs', () => {
  assert.deepEqual(RECRUITER_STATUSES.map((key) => STATUSES[key].label), ['En attente', 'Prise en compte', 'En traitement', 'Attente entretien', 'Acceptée', 'Refusée']);
  assert.equal(isFinal('accepted'), true);
  assert.equal(isFinal('refused'), true);
  assert.equal(isFinal('withdrawn'), true);
  assert.equal(isFinal('interview'), false);
  assert.match(timeline('processing'), /\*\*⚙️ En traitement\*\*/);
  assert.match(timeline('refused'), /\*\*❌ Refusée\*\*$/);
});

test('panel : un bouton par catégorie (5 par ligne) ou un sélecteur', (t) => {
  let components;
  try {
    components = require('../modules/candidature/lib/components');
  } catch {
    t.skip('discord.js non installé (npm install)');
    return;
  }
  const categories = [...Array(7)].map((_, i) => ({ id: String(i + 1), label: `Catégorie ${i + 1}`, emoji: null, button_style: 'success' }));
  const rows = components.panelComponents(categories, 'buttons').map((row) => row.toJSON());
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.components.length), [5, 2]);
  assert.equal(rows[0].components[0].custom_id, 'cand:open:1');
  const select = components.panelComponents(categories, 'select').map((row) => row.toJSON());
  assert.equal(select.length, 1);
  assert.equal(select[0].components[0].custom_id, 'cand:open');
  assert.equal(select[0].components[0].options.length, 7);
  assert.deepEqual(components.panelComponents([], 'buttons'), []);
});
