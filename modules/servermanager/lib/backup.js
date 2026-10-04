'use strict';

const crypto = require('node:crypto');
const { PermissionFlagsBits } = require('discord.js');
const { TRACKED_CHANNEL_TYPES, CHANNEL_FIELDS, ROLE_FIELDS, OVERWRITE_ROLE, snapshotChannel, snapshotRole } = require('./serialize');

const CATEGORY = 4;
const VOICE_TYPES = new Set([2, 13]);
const TEXT_TYPES = new Set([0, 5, 15, 16]);
const ITEM_DELAY_MS = 350;
const MAX_ACTIONS = 250;
const PAUSE_MS = 20 * 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sauvegarde de la structure d'un serveur : rôles (hors rôles d'intégration), permissions de @everyone,
 * salons et catégories avec leurs dérogations. Ni les messages, ni les membres ne sont sauvegardés.
 */
function capture(guild, excluded = new Set()) {
  const roles = [...guild.roles.cache.values()]
    .filter((role) => !role.managed && role.id !== guild.id)
    .sort((a, b) => b.position - a.position)
    .map(snapshotRole);
  const channels = [...guild.channels.cache.values()]
    .filter((channel) => TRACKED_CHANNEL_TYPES.has(channel.type) && !excluded.has(channel.id))
    .sort((a, b) => (a.type === CATEGORY ? 0 : 1) - (b.type === CATEGORY ? 0 : 1) || a.rawPosition - b.rawPosition)
    .map((channel) => ({ ...snapshotChannel(channel), parentName: channel.parent?.name ?? null }));
  return {
    version: 1,
    takenAt: new Date().toISOString(),
    guild: { id: guild.id, name: guild.name, everyonePermissions: guild.roles.everyone.permissions.bitfield.toString() },
    roles,
    channels,
  };
}

/** Rôle actuel correspondant à un rôle sauvegardé : même ID, sinon un seul rôle du même nom. */
function matchRole(guild, saved, taken) {
  const byId = guild.roles.cache.get(saved.id);
  if (byId) return byId;
  const sameName = [...guild.roles.cache.values()].filter((role) => !role.managed && role.name === saved.name && !taken.has(role.id));
  return sameName.length === 1 ? sameName[0] : null;
}

/** Salon actuel correspondant : même ID, sinon un seul salon de même nom, type et catégorie. */
function matchChannel(guild, saved, taken) {
  const byId = guild.channels.cache.get(saved.id);
  if (byId) return byId;
  const candidates = [...guild.channels.cache.values()].filter(
    (channel) => channel.name === saved.name && channel.type === saved.type && (channel.parent?.name ?? null) === (saved.parentName ?? null) && !taken.has(channel.id),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

function overwriteKey(list) {
  return JSON.stringify([...list].sort((a, b) => (a.id < b.id ? -1 : 1)).map((o) => [o.id, o.type, o.allow, o.deny]));
}

/**
 * Plan de restauration **non destructif** : recrée ce qui manque et rétablit les réglages de ce qui a changé ;
 * rien de ce qui a été créé depuis la sauvegarde n'est supprimé. Les positions ne sont pas restaurées.
 * Exige que l'auteur soit administrateur (ou propriétaire) : pas d'escalade possible au-delà de ses droits.
 * @returns {{ error?: string, actions, skipped, hash }}
 */
async function planRestore(guild, data, invoker, excluded = new Set()) {
  const owner = guild.ownerId === invoker.id;
  if (!owner && !invoker.permissions.has(PermissionFlagsBits.Administrator)) {
    return { error: 'Restaurer une sauvegarde exige la permission Discord « Administrateur ».' };
  }
  const me = guild.members.me ?? (await guild.members.fetchMe());
  const botTop = me.roles.highest.position;
  const invokerTop = invoker.roles.highest.position;
  const actions = [];
  const skipped = [];

  // ── Rôles ──
  const roleMatch = {}; // ID sauvegardé → ID actuel (null = à recréer)
  const takenRoles = new Set();
  for (const saved of data.roles) {
    const current = matchRole(guild, saved, takenRoles);
    if (!current) {
      roleMatch[saved.id] = null;
      actions.push({ key: `role-create:${saved.id}`, type: 'role-create', label: `Recréer le rôle « ${saved.name} »`, savedId: saved.id });
      continue;
    }
    takenRoles.add(current.id);
    roleMatch[saved.id] = current.id;
    const now = snapshotRole(current);
    const changes = ROLE_FIELDS.filter((field) => now[field] !== saved[field]);
    if (!changes.length) continue;
    if (current.managed) continue;
    const label = `Rétablir le rôle « ${saved.name} » (${changes.join(', ')})`;
    if (current.position >= botTop) skipped.push({ label, reason: 'rôle au-dessus (ou au niveau) du rôle du bot' });
    else if (!owner && current.position >= invokerTop) skipped.push({ label, reason: 'rôle au-dessus (ou au niveau) de ton rôle le plus haut' });
    else actions.push({ key: `role-update:${saved.id}:${changes.join(',')}`, type: 'role-update', label, savedId: saved.id, roleId: current.id, changes });
  }
  if (data.guild.everyonePermissions !== guild.roles.everyone.permissions.bitfield.toString()) {
    actions.push({ key: 'everyone', type: 'everyone', label: 'Rétablir les permissions de @everyone' });
  }

  // ── Salons ──
  const channelMatch = {};
  const takenChannels = new Set();
  const mapRole = (id) => (id === data.guild.id ? guild.id : roleMatch[id] ?? (guild.roles.cache.has(id) ? id : null));
  for (const saved of data.channels.filter((channel) => !excluded.has(String(channel.id)))) {
    const current = matchChannel(guild, saved, takenChannels);
    if (!current) {
      channelMatch[saved.id] = null;
      actions.push({ key: `channel-create:${saved.id}`, type: 'channel-create', label: `Recréer ${saved.type === CATEGORY ? 'la catégorie' : 'le salon'} « ${saved.name} »`, savedId: saved.id });
      continue;
    }
    takenChannels.add(current.id);
    channelMatch[saved.id] = current.id;
    const now = snapshotChannel(current);
    const changes = CHANNEL_FIELDS.filter((field) => {
      if (field === 'parentId') {
        if (saved.type === CATEGORY) return false;
        const wanted = saved.parentId ? channelMatch[saved.parentId] ?? (guild.channels.cache.has(saved.parentId) ? saved.parentId : 'pending') : null;
        return wanted !== now.parentId;
      }
      if ((field === 'bitrate' || field === 'userLimit') && !VOICE_TYPES.has(saved.type)) return false;
      if ((field === 'topic' || field === 'nsfw' || field === 'rateLimitPerUser') && !TEXT_TYPES.has(saved.type)) return false;
      return now[field] !== saved[field];
    });
    // Dérogations : comparées après correspondance des rôles ; un rôle à recréer compte comme un changement.
    const wanted = saved.overwrites
      .map((o) => (o.type === OVERWRITE_ROLE ? { ...o, id: mapRole(o.id) ?? `pending:${o.id}` } : o))
      .filter((o) => o.type === OVERWRITE_ROLE || guild.members.cache.has(o.id));
    if (overwriteKey(wanted) !== overwriteKey(now.overwrites)) changes.push('permissions');
    if (!changes.length) continue;
    const label = `Rétablir ${saved.type === CATEGORY ? 'la catégorie' : 'le salon'} « ${saved.name} » (${changes.join(', ')})`;
    if (!current.manageable) skipped.push({ label, reason: 'le bot ne peut pas gérer ce salon' });
    else actions.push({ key: `channel-update:${saved.id}:${changes.join(',')}`, type: 'channel-update', label, savedId: saved.id, channelId: current.id, changes });
  }

  if (actions.length > MAX_ACTIONS) return { error: `Plus de ${MAX_ACTIONS} opérations : restauration trop importante pour être faite d’un coup.` };
  // Ordre : rôles, @everyone, catégories, autres salons (les dérogations ont besoin des rôles recréés).
  const order = { 'role-create': 0, 'role-update': 1, everyone: 2, 'channel-create': 3, 'channel-update': 4 };
  const savedChannels = new Map(data.channels.map((c) => [c.id, c]));
  const isCategory = (action) => savedChannels.get(action.savedId)?.type === CATEGORY;
  actions.sort((a, b) => order[a.type] - order[b.type] || Number(isCategory(b)) - Number(isCategory(a)));
  return {
    actions,
    skipped,
    roleMatch,
    channelMatch,
    hash: crypto.createHash('sha1').update(actions.map((a) => a.key).join('|')).digest('hex'),
  };
}

/**
 * Exécute un plan de restauration (re-planifié juste avant : s'il a changé depuis l'aperçu, rien n'est fait).
 * @returns {{ error?: string, done, failed, results: Array<{ label, status, reason? }> }}
 */
async function executeRestore({ guild, data, invoker, expectedHash, backupId, journal, onProgress, abort, excluded = new Set() }) {
  const plan = await planRestore(guild, data, invoker, excluded);
  if (plan.error) return { error: plan.error };
  if (plan.hash !== expectedHash) return { error: 'Le serveur a changé depuis l’aperçu : **rien n’a été restauré**. Relance l’aperçu.' };

  journal?.pause(guild.id, PAUSE_MS);
  const reason = `Restauration de la sauvegarde #${backupId} par ${invoker.user.username}`.slice(0, 120);
  const roleIds = { [data.guild.id]: guild.id };
  for (const [savedId, currentId] of Object.entries(plan.roleMatch)) if (currentId) roleIds[savedId] = currentId;
  const channelIds = {};
  for (const [savedId, currentId] of Object.entries(plan.channelMatch)) if (currentId) channelIds[savedId] = currentId;
  const savedRoles = new Map(data.roles.map((r) => [r.id, r]));
  const savedChannels = new Map(data.channels.map((c) => [c.id, c]));

  const overwritesOf = (saved) =>
    saved.overwrites
      .map((o) => ({ id: o.type === OVERWRITE_ROLE ? roleIds[o.id] ?? (guild.roles.cache.has(o.id) ? o.id : null) : o.id, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) }))
      .filter((o) => o.id && (o.type === OVERWRITE_ROLE || guild.members.cache.has(o.id)));
  const channelOptions = (saved) => {
    const options = { name: saved.name, permissionOverwrites: overwritesOf(saved) };
    if (saved.type !== CATEGORY) options.parent = saved.parentId ? channelIds[saved.parentId] ?? (guild.channels.cache.has(saved.parentId) ? saved.parentId : null) : null;
    if (TEXT_TYPES.has(saved.type)) Object.assign(options, { topic: saved.topic ?? null, nsfw: saved.nsfw, rateLimitPerUser: saved.rateLimitPerUser ?? 0 });
    if (VOICE_TYPES.has(saved.type)) Object.assign(options, { bitrate: saved.bitrate ?? undefined, userLimit: saved.userLimit ?? 0 });
    return options;
  };

  const results = [];
  let index = 0;
  for (const action of plan.actions) {
    if (abort?.requested) {
      results.push({ label: action.label, status: 'cancelled', reason: 'arrêt demandé' });
      continue;
    }
    try {
      if (action.type === 'role-create') {
        const saved = savedRoles.get(action.savedId);
        const created = await guild.roles.create({ name: saved.name, color: saved.color, hoist: saved.hoist, mentionable: saved.mentionable, permissions: BigInt(saved.permissions), reason });
        roleIds[saved.id] = created.id;
      } else if (action.type === 'role-update') {
        const saved = savedRoles.get(action.savedId);
        await guild.roles.edit(action.roleId, { name: saved.name, color: saved.color, hoist: saved.hoist, mentionable: saved.mentionable, permissions: BigInt(saved.permissions), reason });
      } else if (action.type === 'everyone') {
        await guild.roles.everyone.setPermissions(BigInt(data.guild.everyonePermissions), reason);
      } else if (action.type === 'channel-create') {
        const saved = savedChannels.get(action.savedId);
        const created = await guild.channels.create({ ...channelOptions(saved), type: saved.type, reason });
        channelIds[saved.id] = created.id;
      } else if (action.type === 'channel-update') {
        const saved = savedChannels.get(action.savedId);
        const channel = guild.channels.cache.get(action.channelId);
        if (!channel) throw new Error('salon introuvable');
        await channel.edit({ ...channelOptions(saved), reason });
      }
      results.push({ label: action.label, status: 'done' });
    } catch (err) {
      results.push({ label: action.label, status: 'failed', reason: String(err.message).slice(0, 140) });
    }
    index += 1;
    onProgress?.({ index, total: plan.actions.length, label: action.label });
    await sleep(ITEM_DELAY_MS);
  }
  journal?.pause(guild.id, 8_000);
  return {
    results,
    skipped: plan.skipped,
    done: results.filter((r) => r.status === 'done').length,
    failed: results.filter((r) => r.status === 'failed').length,
    cancelled: results.filter((r) => r.status === 'cancelled').length,
  };
}

module.exports = { capture, planRestore, executeRestore };
