'use strict';

// Cœur : détail des modifications pour les journaux, admins globaux (/admin).
const test = require('node:test');
const assert = require('node:assert/strict');
const { describeChanges, withChanges } = require('../src/web/changes');
const { BotAdmins } = require('../src/core/botAdmins');

test('journaux : seuls les champs réellement modifiés sont listés, ancienne → nouvelle valeur', () => {
  const before = { label: 'Support', mod_role_ids: '["2","1"]', auto_transcript: 1, max_open: null, category_id: '123456789012345678', emoji: '' };
  const patch = { label: 'Aide', mod_role_ids: ['1', '2'], auto_transcript: 0, max_open: 3, category_id: '123456789012345678', emoji: null };
  assert.deepEqual(describeChanges(before, patch), [
    '• **Libellé** : « Support » → « Aide »',
    '• **Transcript automatique** : oui → non',
    '• **Limite en cours** : *vide* → 3',
  ]);
});

test('journaux : rôles et salons en mentions, libellés propres à la route, rien de changé', () => {
  const lines = describeChanges({ notify_role_ids: [], log_channel_id: null, custom: 'a' }, { notify_role_ids: ['111111111111111111'], log_channel_id: '222222222222222222', custom: 'b' }, { custom: 'Mon champ' });
  assert.deepEqual(lines, ['• **Rôles notifiés** : *vide* → <@&111111111111111111>', '• **Salon de journal** : *vide* → <#222222222222222222>', '• **Mon champ** : « a » → « b »']);
  assert.equal(withChanges('panel modifié', []), 'panel modifié (aucun changement)');
  assert.equal(withChanges('panel modifié', ['• x']), 'panel modifié\n• x');
});

test('journaux : un long texte modifié est signalé sans recopier les deux versions', () => {
  const [line] = describeChanges({ opened_description: 'a'.repeat(100) }, { opened_description: 'b'.repeat(100) });
  assert.match(line, /^• \*\*Description du message d’ouverture\*\* : modifié \(« b+… »\)$/);
});

function fakeConfig() {
  const envOwners = new Set(['1']);
  const envWeb = new Set(['1', '5']);
  return { envOwners, owners: new Set(envOwners), web: { envAuthorizedUsers: envWeb, authorizedUsers: new Set(envWeb) } };
}

test('/admin : un admin global devient propriétaire et accède au panel, son retrait le lui reprend', async () => {
  const queries = [];
  const db = { query: async (sql, params) => { queries.push([sql, params]); return sql.startsWith('SELECT') ? [{ user_id: '7' }] : {}; } };
  const config = fakeConfig();
  const admins = new BotAdmins({ db, config, logger: console });
  await admins.load();
  assert.ok(config.owners.has('7') && config.web.authorizedUsers.has('7'));
  await admins.add('9', '1');
  assert.ok(config.owners.has('9') && config.web.authorizedUsers.has('9') && admins.has('9'));
  await admins.remove('9');
  assert.ok(!config.owners.has('9') && !config.web.authorizedUsers.has('9'));
  // Les comptes du .env ne sont jamais retirés.
  assert.ok(config.owners.has('1') && config.web.authorizedUsers.has('5'));
  assert.ok(admins.isEnvOwner('1') && !admins.isEnvOwner('7'));
});
