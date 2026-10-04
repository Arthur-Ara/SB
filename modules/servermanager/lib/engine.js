'use strict';

const crypto = require('node:crypto');
const { PermissionFlagsBits } = require('discord.js');
const { CHANNEL_FIELDS, ROLE_FIELDS, OVERWRITE_ROLE, TRACKED_CHANNEL_TYPES, snapshotChannel, snapshotRole } = require('./serialize');
const { SCOPE_KINDS, SCOPE_PERMISSION, SCOPE_PERMISSION_LABEL, MOD_REVERSIBLE, SENSITIVE_COUNT } = require('./constants');
const { formatDuration } = require('./duration');
const render = require('./render');
const ui = require('../../../src/bot/ui');
const { restoreChannelAccess } = require('../../moderation/lib/prison');
const { isChannelLocked, unlockChannel } = require('../../moderation/lib/channelLock');

const P = PermissionFlagsBits;
const MAX_ROWS = 300;
const MEMBER_READD_CAP = 300;
const ITEM_DELAY_MS = 400;
const MAX_CONSECUTIVE_FAILURES = 5;
const PAUSE_DURING_RUN_MS = 15 * 60_000;
const PAUSE_AFTER_RUN_MS = 8_000;

const FIELD_LABEL = {
  name: 'nom',
  topic: 'sujet',
  nsfw: 'NSFW',
  rateLimitPerUser: 'mode lent',
  bitrate: 'débit',
  userLimit: 'limite de membres',
  parentId: 'catégorie',
  color: 'couleur',
  hoist: 'affichage séparé',
  mentionable: 'mentionnable',
  permissions: 'permissions',
};

const MOD_TITLE = {
  ban: 'Débannir',
  tempban: 'Débannir',
  tempmute: 'Lever l’exclusion de',
  tempvocmute: 'Lever le mute vocal de',
  warn: 'Retirer l’avertissement de',
  shadowban: 'Lever le shadow-ban de',
  lock: 'Déverrouiller',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function short(message) {
  return String(message ?? 'erreur inconnue').replace(/\s+/g, ' ').slice(0, 140);
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── État simulé ───────────────────────────────────────────────────────────────

/**
 * État du serveur « tel qu'il serait » après chaque annulation déjà traitée : l'aperçu (simulation) et
 * l'exécution suivent exactement le même chemin, et les modifications empilées sur un même objet
 * (renommé puis supprimé, par exemple) s'annulent dans le bon ordre.
 */
class SimState {
  constructor(guild, idMap) {
    this.guild = guild;
    this.idMap = idMap; // { channel: Map, role: Map } ancien ID → nouvel ID
    this.channels = new Map();
    this.roles = new Map();
    this.members = new Map();
    this.memberRoles = new Map();
    this.lifted = new Set(); // sanctions de modération déjà levées par ce rollback
  }

  mapId(kind, id) {
    let current = String(id);
    const seen = new Set();
    const map = this.idMap[kind];
    while (map.has(current) && !seen.has(current)) {
      seen.add(current);
      current = map.get(current);
    }
    return current;
  }

  channel(id) {
    if (this.channels.has(id)) return this.channels.get(id);
    const live = this.guild.channels.cache.get(id);
    const snapshot = live && TRACKED_CHANNEL_TYPES.has(live.type) ? snapshotChannel(live) : null;
    this.channels.set(id, snapshot);
    return snapshot;
  }

  role(id) {
    if (this.roles.has(id)) return this.roles.get(id);
    const live = this.guild.roles.cache.get(id);
    const snapshot = live ? snapshotRole(live) : null;
    this.roles.set(id, snapshot);
    return snapshot;
  }

  async member(id) {
    if (this.members.has(id)) return this.members.get(id);
    const member = this.guild.members.cache.get(id) ?? (await this.guild.members.fetch(id).catch(() => null));
    this.members.set(id, member ?? null);
    return member ?? null;
  }

  async hasRole(userId, roleId) {
    const key = `${userId}:${roleId}`;
    if (this.memberRoles.has(key)) return this.memberRoles.get(key);
    const member = await this.member(userId);
    const has = Boolean(member?.roles.cache.has(roleId));
    this.memberRoles.set(key, has);
    return has;
  }
}

// ── Éléments du plan ──────────────────────────────────────────────────────────

function changeTitle(row, before, after) {
  const name = (before ?? after)?.name ?? row.label ?? '?';
  if (row.kind === 'channel') {
    return { create: `Supprimer le salon #${name}`, update: `Restaurer le salon #${name}`, delete: `Recréer le salon #${name}` }[row.op];
  }
  if (row.kind === 'role') {
    return { create: `Supprimer le rôle @${name}`, update: `Restaurer le rôle @${name}`, delete: `Recréer le rôle @${name}` }[row.op];
  }
  const role = row.label || String(row.role_id);
  return row.op === 'add' ? `Retirer @${role} à <@${row.target_id}>` : `Rendre @${role} à <@${row.target_id}>`;
}

function changeItem(row) {
  const before = parseJson(row.before_json);
  const after = parseJson(row.after_json);
  return {
    key: `c${row.id}`,
    source: 'change',
    row,
    before,
    after,
    kind: row.kind,
    op: row.op,
    executorId: row.executor_id ? String(row.executor_id) : null,
    at: new Date(row.created_at),
    status: 'pending',
    reason: null,
    destructive: false,
    notes: [],
    title: changeTitle(row, before, after),
  };
}

function modItem(row) {
  const subject = row.action === 'lock' ? `<#${row.channel_id}>` : `<@${row.target_id}>`;
  return {
    key: `m${row.id}`,
    source: 'mod',
    row,
    before: null,
    after: null,
    kind: 'moderation',
    op: row.action,
    executorId: row.executor_id ? String(row.executor_id) : null,
    at: new Date(row.created_at),
    status: 'pending',
    reason: null,
    destructive: false,
    notes: [],
    title: `${MOD_TITLE[row.action] ?? 'Annuler'} ${subject} (sanction #${row.id})`,
  };
}

/** Ordre d'exécution : rôles → catégories → autres salons → rôles des membres → modération. */
function phaseOf(item) {
  if (item.kind === 'role') return 1;
  if (item.kind === 'channel') return (item.before ?? item.after)?.type === 4 ? 2 : 3;
  if (item.kind === 'member_role') return 4;
  return 5;
}

function sortItems(items) {
  return items.sort((a, b) => phaseOf(a) - phaseOf(b) || b.at - a.at || Number(b.row.id) - Number(a.row.id));
}

// ── Garde-fous communs ────────────────────────────────────────────────────────

function skip(item, reason) {
  item.status = 'skip';
  item.reason = reason;
}

/**
 * Applique (exécution) ou simule (aperçu) une annulation. `apply` n'est appelée qu'en exécution ;
 * `simulate` met à jour l'état simulé dans les deux cas, une fois l'application réussie.
 */
async function perform(item, env, apply, simulate) {
  if (env.dry) {
    item.status = 'ok';
  } else {
    try {
      await apply();
    } catch (err) {
      item.status = 'failed';
      item.reason = short(err.message);
      return false;
    }
    item.status = 'done';
  }
  simulate();
  return true;
}

/** Un auteur de rang supérieur ou égal au tien (ou le propriétaire) est intouchable. */
async function executorGuard(item, env) {
  const id = item.executorId;
  if (!id || id === env.invoker.id) return null;
  if (id === env.client.user.id) return 'action du bot lui-même';
  if (env.invokerOwner) return null;
  if (id === env.guild.ownerId) return 'action du propriétaire du serveur';
  const member = await env.state.member(id);
  if (member && member.roles.highest.position >= env.invokerTop) return 'auteur de rang supérieur ou égal au tien';
  return null;
}

function roleBlocked(env, snapshot) {
  if (snapshot.managed) return 'rôle géré par une intégration';
  if (snapshot.position >= env.botTop) return 'rôle au-dessus (ou au niveau) du rôle le plus haut du bot';
  if (!env.invokerOwner && snapshot.position >= env.invokerTop) return 'rôle au-dessus (ou au niveau) de ton rôle le plus haut';
  return null;
}

function sameOverwrite(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.type === b.type && a.allow === b.allow && a.deny === b.deny;
}

function discordOverwrite(overwrite) {
  return { id: overwrite.id, type: overwrite.type, allow: BigInt(overwrite.allow), deny: BigInt(overwrite.deny) };
}

// ── Salons ────────────────────────────────────────────────────────────────────

async function handleChannel(item, env) {
  const { state, guild, me, invoker } = env;
  if (!me.permissions.has(P.ManageChannels)) return skip(item, 'le bot n’a pas la permission « Gérer les salons »');
  if (!invoker.permissions.has(P.ManageChannels)) return skip(item, 'tu n’as pas la permission « Gérer les salons »');
  const id = state.mapId('channel', item.row.target_id);
  const { before, after } = item;

  // Créé → on le supprime
  if (item.op === 'create') {
    const snapshot = state.channel(id);
    if (!snapshot) return skip(item, 'déjà supprimé');
    const live = guild.channels.cache.get(id);
    if (live?.lastMessageId) return skip(item, 'contient des messages (suppression irréversible)');
    if (live?.threads?.cache?.size) return skip(item, 'contient des fils de discussion');
    if ([...guild.channels.cache.values()].some((channel) => channel.parentId === id && state.channel(channel.id))) {
      return skip(item, 'catégorie non vide');
    }
    if (live && !live.deletable) return skip(item, 'le bot ne peut pas supprimer ce salon');
    item.destructive = true;
    return perform(
      item,
      env,
      async () => {
        if (!live) throw new Error('salon introuvable');
        await live.delete(env.reason);
      },
      () => state.channels.set(id, null),
    );
  }

  // Supprimé → on le recrée (nouvel identifiant, messages non restaurés)
  if (item.op === 'delete') {
    if (state.channel(id)) return skip(item, 'déjà recréé');
    if (guild.channels.cache.size >= 500) return skip(item, 'limite de 500 salons atteinte');
    const parentRef = before.parentId ? state.mapId('channel', before.parentId) : null;
    const parentOk = Boolean(parentRef && state.channel(parentRef));

    const overwrites = [];
    let dropped = 0;
    for (const overwrite of before.overwrites) {
      const ref = overwrite.type === OVERWRITE_ROLE ? state.mapId('role', overwrite.id) : overwrite.id;
      const exists = overwrite.type === OVERWRITE_ROLE ? Boolean(state.role(ref)) : Boolean(await state.member(ref));
      if (!exists || !invoker.permissions.has(BigInt(overwrite.allow))) {
        dropped += 1;
        continue;
      }
      overwrites.push({ ...overwrite, id: ref });
    }
    if (dropped) item.notes.push(`${dropped} permission(s) ignorée(s)`);
    item.notes.push('messages non restaurés');

    const payload = { name: before.name, type: before.type, position: before.position, reason: env.reason };
    if (parentOk) payload.parent = parentRef;
    if (before.topic) payload.topic = before.topic;
    if (before.nsfw) payload.nsfw = true;
    if (before.rateLimitPerUser && before.type !== 4) payload.rateLimitPerUser = before.rateLimitPerUser;
    if (before.type === 2 || before.type === 13) {
      if (before.bitrate) payload.bitrate = Math.min(before.bitrate, guild.maximumBitrate);
      if (before.userLimit) payload.userLimit = before.userLimit;
    }
    if (overwrites.length) payload.permissionOverwrites = overwrites.map(discordOverwrite);

    let createdId = `virtual:${item.row.target_id}`;
    const done = await perform(
      item,
      env,
      async () => {
        const created = await guild.channels.create(payload);
        createdId = created.id;
      },
      () => {},
    );
    if (!done) return;
    state.idMap.channel.set(String(item.row.target_id), createdId);
    state.channels.set(createdId, { ...before, id: createdId, parentId: parentOk ? parentRef : null, overwrites });
    if (!env.dry) await env.persistMap('channel', item.row.target_id, createdId);
    return;
  }

  // Modifié → on restaure les champs que personne n'a retouchés depuis
  const current = state.channel(id);
  if (!current) return skip(item, 'salon supprimé depuis');
  const patch = {};
  const changed = [];
  for (const field of CHANNEL_FIELDS) {
    if (before[field] === after[field]) continue;
    if (field === 'parentId') {
      const currentParent = current.parentId;
      const afterParent = after.parentId ? state.mapId('channel', after.parentId) : null;
      if (currentParent !== afterParent) continue;
      const target = before.parentId ? state.mapId('channel', before.parentId) : null;
      if (target && !state.channel(target)) continue;
      patch.parentId = target;
    } else {
      if (current[field] !== after[field]) continue;
      patch[field] = before[field];
    }
    changed.push(FIELD_LABEL[field]);
  }

  const refOf = (overwrite) => (overwrite.type === OVERWRITE_ROLE ? state.mapId('role', overwrite.id) : overwrite.id);
  const beforeMap = new Map(before.overwrites.map((o) => [refOf(o), o]));
  const afterMap = new Map(after.overwrites.map((o) => [refOf(o), o]));
  const currentMap = new Map(current.overwrites.map((o) => [o.id, o]));
  const nextMap = new Map(currentMap);
  let overwritesChanged = 0;
  for (const ref of new Set([...beforeMap.keys(), ...afterMap.keys()])) {
    const b = beforeMap.get(ref);
    const a = afterMap.get(ref);
    if (sameOverwrite(b, a)) continue; // non touché par cette modification
    if (!sameOverwrite(currentMap.get(ref), a)) continue; // modifié depuis
    if (b) {
      const exists = b.type === OVERWRITE_ROLE ? Boolean(state.role(ref)) : Boolean(await state.member(ref));
      if (!exists || !invoker.permissions.has(BigInt(b.allow))) continue;
      nextMap.set(ref, { ...b, id: ref });
    } else {
      nextMap.delete(ref);
    }
    overwritesChanged += 1;
  }
  if (overwritesChanged) changed.push('permissions');

  if (!changed.length) return skip(item, 'rien à annuler (modifié depuis)');
  item.notes.push(`Champs : ${changed.join(', ')}`);

  const edit = { reason: env.reason };
  for (const [field, value] of Object.entries(patch)) edit[field === 'parentId' ? 'parent' : field] = value;
  if (overwritesChanged) edit.permissionOverwrites = [...nextMap.values()].map(discordOverwrite);

  return perform(
    item,
    env,
    async () => {
      const live = guild.channels.cache.get(id);
      if (!live) throw new Error('salon introuvable');
      await live.edit(edit);
    },
    () => {
      Object.assign(current, patch);
      if (overwritesChanged) current.overwrites = [...nextMap.values()];
    },
  );
}

// ── Rôles ─────────────────────────────────────────────────────────────────────

async function handleRole(item, env) {
  const { state, guild, me, invoker } = env;
  if (!me.permissions.has(P.ManageRoles)) return skip(item, 'le bot n’a pas la permission « Gérer les rôles »');
  if (!invoker.permissions.has(P.ManageRoles)) return skip(item, 'tu n’as pas la permission « Gérer les rôles »');
  const id = state.mapId('role', item.row.target_id);
  const { before, after } = item;

  // Créé → on le supprime
  if (item.op === 'create') {
    const snapshot = state.role(id);
    if (!snapshot) return skip(item, 'déjà supprimé');
    const blocked = roleBlocked(env, snapshot);
    if (blocked) return skip(item, blocked);
    const live = guild.roles.cache.get(id);
    item.destructive = true;
    if (live?.members.size) item.notes.push(`${live.members.size} membre(s) le perdront`);
    return perform(
      item,
      env,
      async () => {
        if (!live) throw new Error('rôle introuvable');
        await live.delete(env.reason);
      },
      () => state.roles.set(id, null),
    );
  }

  // Supprimé → on le recrée avec ses propriétés, puis on le rend à ses anciens porteurs
  if (item.op === 'delete') {
    if (state.role(id)) return skip(item, 'déjà recréé');
    const permissions = BigInt(before.permissions);
    if (!invoker.permissions.has(permissions)) return skip(item, 'le rôle avait des permissions que tu ne possèdes pas');
    if (!me.permissions.has(permissions)) return skip(item, 'le rôle avait des permissions que le bot ne possède pas');
    if (!env.invokerOwner && before.position >= env.invokerTop) return skip(item, 'le rôle était au-dessus de ton rôle le plus haut');
    if (guild.roles.cache.size >= 250) return skip(item, 'limite de 250 rôles atteinte');
    const holders = (before.members ?? []).slice(0, MEMBER_READD_CAP);
    if (holders.length) item.notes.push(`${holders.length} membre(s) retrouveront le rôle`);
    if ((before.members ?? []).length > MEMBER_READD_CAP) item.notes.push('liste des porteurs tronquée');
    const position = Math.max(1, Math.min(before.position, env.botTop - 1));

    let createdId = `virtual:${item.row.target_id}`;
    const done = await perform(
      item,
      env,
      async () => {
        const created = await guild.roles.create({
          name: before.name,
          color: before.color,
          hoist: before.hoist,
          mentionable: before.mentionable,
          permissions,
          reason: env.reason,
        });
        createdId = created.id;
        await created.setPosition(position, { reason: env.reason }).catch(() => {});
        for (const holderId of holders) {
          const member = await guild.members.fetch(holderId).catch(() => null);
          if (member) await member.roles.add(created, env.reason).catch(() => {});
          await sleep(250);
        }
      },
      () => {},
    );
    if (!done) return;
    state.idMap.role.set(String(item.row.target_id), createdId);
    state.roles.set(createdId, { ...before, id: createdId, position, managed: false });
    if (!env.dry) await env.persistMap('role', item.row.target_id, createdId);
    return;
  }

  // Modifié → on restaure les champs que personne n'a retouchés depuis
  const current = state.role(id);
  if (!current) return skip(item, 'rôle supprimé depuis');
  const blocked = roleBlocked(env, current);
  if (blocked) return skip(item, blocked);
  const patch = {};
  const changed = [];
  const refused = [];
  for (const field of ROLE_FIELDS) {
    if (before[field] === after[field]) continue;
    if (current[field] !== after[field]) continue;
    if (field === 'permissions') {
      // On ne peut pas redonner à un rôle des permissions que l'on ne détient pas soi-même (ni le bot).
      const added = BigInt(before.permissions) & ~BigInt(current.permissions);
      if (added !== 0n && (!invoker.permissions.has(added) || !me.permissions.has(added))) {
        refused.push('permissions');
        continue;
      }
    }
    patch[field] = before[field];
    changed.push(FIELD_LABEL[field]);
  }
  if (!changed.length) return skip(item, refused.length ? 'permissions que tu ne possèdes pas' : 'rien à annuler (modifié depuis)');
  item.notes.push(`Champs : ${changed.join(', ')}`);
  if (refused.length) item.notes.push('permissions ignorées (droits insuffisants)');

  const edit = { ...patch, reason: env.reason };
  if (patch.permissions !== undefined) edit.permissions = BigInt(patch.permissions);
  return perform(
    item,
    env,
    async () => {
      const live = guild.roles.cache.get(id);
      if (!live) throw new Error('rôle introuvable');
      await live.edit(edit);
    },
    () => Object.assign(current, patch),
  );
}

// ── Rôles des membres ─────────────────────────────────────────────────────────

async function handleMemberRole(item, env) {
  const { state, guild, me, invoker } = env;
  if (!me.permissions.has(P.ManageRoles)) return skip(item, 'le bot n’a pas la permission « Gérer les rôles »');
  if (!invoker.permissions.has(P.ManageRoles)) return skip(item, 'tu n’as pas la permission « Gérer les rôles »');

  const roleId = state.mapId('role', item.row.role_id);
  const snapshot = state.role(roleId);
  if (!snapshot) return skip(item, 'rôle supprimé');
  const blocked = roleBlocked(env, snapshot);
  if (blocked) return skip(item, blocked);
  if ((BigInt(snapshot.permissions) & P.Administrator) !== 0n && !invoker.permissions.has(P.Administrator)) {
    return skip(item, 'rôle administrateur : réservé aux administrateurs');
  }

  const userId = String(item.row.target_id);
  const member = await state.member(userId);
  if (!member) return skip(item, 'membre absent du serveur');
  if (!env.invokerOwner && member.id !== invoker.id && member.roles.highest.position >= env.invokerTop) {
    return skip(item, 'membre de rang supérieur ou égal au tien');
  }
  if (!member.manageable) return skip(item, 'le bot ne peut pas modifier ce membre');

  const has = await state.hasRole(userId, roleId);
  const key = `${userId}:${roleId}`;
  if (item.op === 'add') {
    if (!has) return skip(item, 'rôle déjà retiré');
    return perform(item, env, () => member.roles.remove(roleId, env.reason), () => state.memberRoles.set(key, false));
  }
  if (has) return skip(item, 'rôle déjà présent');
  return perform(item, env, () => member.roles.add(roleId, env.reason), () => state.memberRoles.set(key, true));
}

// ── Modération ────────────────────────────────────────────────────────────────

async function handleMod(item, env) {
  const { state, guild, me, invoker, mod } = env;
  const { row } = item;
  if (!mod) return skip(item, 'module Modération indisponible');
  const { moderation, logs } = mod;
  const targetId = row.target_id ? String(row.target_id) : null;

  if (targetId && targetId === invoker.id) return skip(item, 'sanction te visant : tu ne peux pas la lever toi-même');
  if (targetId && !env.invokerOwner) {
    const targetMember = await state.member(targetId);
    if (targetMember && targetMember.roles.highest.position >= env.invokerTop) return skip(item, 'membre de rang supérieur ou égal au tien');
  }
  const liftKey = `${row.action}:${row.action === 'lock' ? row.channel_id : targetId}`;
  if (state.lifted.has(liftKey)) return skip(item, 'déjà levé par une autre ligne de ce rollback');

  const reason = `Rollback #${env.batchId ?? '?'} de la sanction #${row.id}`;
  const note = async (action, extra = {}) => {
    await moderation.record({
      guildId: guild.id,
      action,
      targetId,
      channelId: row.channel_id ?? null,
      executorId: invoker.id,
      reason: extra.reason ?? reason,
      metadata: extra.metadata ?? null,
    });
    await logs.action({ guildId: guild.id, action, targetId, channelId: row.channel_id ?? null, executorId: invoker.id, reason: extra.reason ?? reason });
  };
  const done = () => state.lifted.add(liftKey);
  const needs = (flag, label) => {
    if (!invoker.permissions.has(flag)) return `tu n’as pas la permission « ${label} »`;
    if (!me.permissions.has(flag)) return `le bot n’a pas la permission « ${label} »`;
    return null;
  };

  switch (row.action) {
    case 'ban':
    case 'tempban': {
      const missing = needs(P.BanMembers, 'Bannir des membres');
      if (missing) return skip(item, missing);
      if (await moderation.blacklistEntry(targetId)) return skip(item, 'utilisateur blacklisté : utilise /unblacklist');
      if (row.action === 'tempban' && Number(row.active) !== 1) return skip(item, 'déjà levé');
      const ban = await guild.bans.fetch(targetId).catch(() => null);
      if (!ban) return skip(item, 'déjà débanni');
      return perform(
        item,
        env,
        async () => {
          await guild.members.unban(targetId, reason);
          await moderation.resolveBans(guild.id, targetId, invoker.id);
          await note(row.action === 'tempban' ? 'untempban' : 'unban');
        },
        done,
      );
    }
    case 'tempmute': {
      const missing = needs(P.ModerateMembers, 'Exclure temporairement des membres');
      if (missing) return skip(item, missing);
      const member = await state.member(targetId);
      if (!member || !member.communicationDisabledUntilTimestamp || member.communicationDisabledUntilTimestamp <= Date.now()) {
        return skip(item, 'plus exclu');
      }
      if (!member.moderatable) return skip(item, 'le bot ne peut pas modérer ce membre');
      return perform(
        item,
        env,
        async () => {
          await member.timeout(null, reason);
          await note('unmute');
        },
        done,
      );
    }
    case 'tempvocmute': {
      const missing = needs(P.MuteMembers, 'Rendre muet des membres');
      if (missing) return skip(item, missing);
      if (Number(row.active) !== 1) return skip(item, 'déjà levé');
      const member = await state.member(targetId);
      return perform(
        item,
        env,
        async () => {
          if (member?.voice?.serverMute) await member.voice.setMute(false, reason);
          await moderation.resolve(row.id, invoker.id);
          await note('untempvocmute');
        },
        done,
      );
    }
    case 'warn': {
      if (Number(row.active) !== 1) return skip(item, 'déjà retiré');
      return perform(
        item,
        env,
        async () => {
          await moderation.resolve(row.id, invoker.id);
          await note('removewarn', { reason: `Avertissement #${row.id} retiré (${reason})`, metadata: { warnId: row.id } });
        },
        done,
      );
    }
    case 'shadowban': {
      const missing = needs(P.ManageChannels, 'Gérer les salons');
      if (missing) return skip(item, missing);
      const existing = await moderation.shadowban(guild.id, targetId);
      if (!existing) return skip(item, 'déjà levé');
      return perform(
        item,
        env,
        async () => {
          await restoreChannelAccess(guild, targetId, existing.previous_state, { prisonChannelId: existing.prison_channel_id, reason });
          await moderation.removeShadowban(guild.id, targetId);
          await note('unshadowban');
          const prison = guild.channels.cache.get(String(existing.prison_channel_id));
          if (prison) await prison.delete(reason).catch(() => {});
        },
        done,
      );
    }
    case 'lock': {
      const missing = needs(P.ManageChannels, 'Gérer les salons');
      if (missing) return skip(item, missing);
      const channel = guild.channels.cache.get(String(row.channel_id));
      if (!channel) return skip(item, 'salon supprimé');
      if (!isChannelLocked(channel)) return skip(item, 'déjà déverrouillé');
      return perform(
        item,
        env,
        async () => {
          await unlockChannel(moderation, channel, invoker.id, reason);
          await note('unlock');
        },
        done,
      );
    }
    default:
      return skip(item, 'sanction non annulable');
  }
}

async function evaluate(item, env) {
  item.status = 'pending';
  const refusal = await executorGuard(item, env);
  if (refusal) skip(item, refusal);
  else if (item.source === 'mod') await handleMod(item, env);
  else if (item.kind === 'channel') await handleChannel(item, env);
  else if (item.kind === 'role') await handleRole(item, env);
  else await handleMemberRole(item, env);
  if (item.status === 'pending') skip(item, 'rien à faire');
}

// ── Moteur ────────────────────────────────────────────────────────────────────

/**
 * Planification (simulation) et exécution des rollbacks. Les deux passent par `evaluate` : l'aperçu montre
 * donc exactement ce que l'exécution fera, et celle-ci est re-simulée juste avant de démarrer (empreinte
 * comparée à celle que l'utilisateur a confirmée).
 */
class RollbackEngine {
  constructor({ db, client, logger, journal, store, modules, limits }) {
    this.db = db;
    this.client = client;
    this.logger = logger;
    this.journal = journal;
    this.store = store;
    this.modules = modules;
    this.limits = limits;
    this.running = new Set();
    this.lastRun = new Map();
  }

  modServices(guildId) {
    if (!this.modules.isEnabledFor('moderation', guildId)) return null;
    const services = this.modules.services('moderation');
    return services?.moderation && services?.logs ? services : null;
  }

  cooldownLeft(guildId) {
    const last = this.lastRun.get(guildId);
    if (!last) return 0;
    return Math.max(0, last + this.limits.cooldownS * 1000 - Date.now());
  }

  async makeEnv({ guild, invoker, dry, batchId = null, idMap }) {
    const me = guild.members.me ?? (await guild.members.fetchMe());
    return {
      guild,
      client: this.client,
      me,
      invoker,
      invokerOwner: guild.ownerId === invoker.id,
      invokerTop: invoker.roles.highest.position,
      botTop: me.roles.highest.position,
      state: new SimState(guild, idMap),
      dry,
      batchId,
      mod: this.modServices(guild.id),
      reason: dry ? '' : `Rollback #${batchId} par ${invoker.user.username}`.slice(0, 120),
      persistMap: (kind, oldId, newId) => this.store.saveIdMap(guild.id, kind, oldId, newId),
    };
  }

  /** Salons (actuels ou passés) de tickets et de fils modmail du serveur ; vide si le module Tickets n'a jamais tourné. */
  async excludedChannelIds(guildId) {
    try {
      const rows = await this.db.query(
        `SELECT channel_id FROM tickets WHERE guild_id = ?
         UNION SELECT channel_id FROM modmail_threads WHERE guild_id = ? AND channel_id IS NOT NULL`,
        [guildId, guildId],
      );
      return rows.map((row) => String(row.channel_id));
    } catch {
      return []; // tables absentes : module Tickets jamais installé
    }
  }

  /** Lit le journal (et les sanctions) de la période, déjà triés dans l'ordre d'exécution. */
  async collect({ guild, scope, since, targetUserId }) {
    const botId = this.client.user.id;
    const items = [];
    const kinds = SCOPE_KINDS[scope];

    if (kinds.length) {
      let sql = `SELECT * FROM sm_changes
                  WHERE guild_id = ? AND created_at >= ? AND rolled_back_at IS NULL
                    AND (executor_id IS NULL OR executor_id <> ?) AND kind IN (?)`;
      const params = [guild.id, since, botId, kinds];
      // Salons de tickets et de modmail : gérés par leur module (création, déplacement, permissions, suppression),
      // jamais concernés par un rollback.
      const excluded = await this.excludedChannelIds(guild.id);
      if (excluded.length) {
        sql += ` AND NOT (kind = 'channel' AND target_id IN (?))`;
        params.push(excluded);
      }
      if (targetUserId) {
        sql += ' AND executor_id = ?';
        params.push(targetUserId);
      }
      sql += ' ORDER BY created_at DESC, id DESC LIMIT ?';
      params.push(MAX_ROWS + 1);
      for (const row of await this.db.query(sql, params)) items.push(changeItem(row));
    }

    if ((scope === 'moderation' || scope === 'all') && this.modServices(guild.id)) {
      let sql = `SELECT a.* FROM moderation_actions a
                  LEFT JOIN sm_mod_reverted r ON r.action_id = a.id
                  WHERE a.guild_id = ? AND a.created_at >= ? AND r.action_id IS NULL
                    AND a.action IN (?) AND a.executor_id <> ?`;
      const params = [guild.id, since, MOD_REVERSIBLE, botId];
      if (targetUserId) {
        sql += ' AND a.executor_id = ?';
        params.push(targetUserId);
      }
      sql += ' ORDER BY a.created_at DESC, a.id DESC LIMIT ?';
      params.push(MAX_ROWS + 1);
      for (const row of await this.db.query(sql, params)) items.push(modItem(row));
    }

    return { items: sortItems(items), truncated: items.length > MAX_ROWS };
  }

  /**
   * Aperçu (simulation) d'un rollback. Renvoie { error } ou le plan complet.
   * @param {{ guild, invoker: import('discord.js').GuildMember, scope: string, windowS: number, targetUserId?: string|null }} options
   */
  async plan({ guild, invoker, scope, windowS, targetUserId = null }) {
    const invokerOwner = guild.ownerId === invoker.id;
    if (!SCOPE_KINDS[scope]) return { error: 'Type de rollback inconnu.' };
    if (windowS < 60) return { error: 'La période minimale est de 1 minute.' };
    if (windowS > this.limits.maxWindowS) return { error: `La période maximale est de **${formatDuration(this.limits.maxWindowS)}**.` };
    if (!invokerOwner && !invoker.permissions.has(SCOPE_PERMISSION[scope])) {
      return { error: `Ce type de rollback exige la permission Discord « **${SCOPE_PERMISSION_LABEL[scope]}** ».` };
    }
    if (scope === 'moderation' && !this.modServices(guild.id)) {
      return { error: 'Le module **Modération** doit être activé sur ce serveur (voir `/modules`).' };
    }

    const idMap = await this.store.idMap(guild.id);
    const env = await this.makeEnv({ guild, invoker, dry: true, idMap });

    if (targetUserId) {
      if (targetUserId === this.client.user.id) return { error: 'Les actions du bot lui-même ne sont jamais annulées par un rollback.' };
      if (!invokerOwner) {
        if (targetUserId === guild.ownerId) return { error: 'Les actions du propriétaire du serveur ne peuvent pas être annulées.' };
        const targetMember = await env.state.member(targetUserId);
        if (targetMember && targetUserId !== invoker.id && targetMember.roles.highest.position >= env.invokerTop) {
          return { error: '<@' + targetUserId + '> a un rôle supérieur ou égal au tien : tu ne peux pas annuler ses actions.' };
        }
      }
    }

    const since = new Date(Date.now() - windowS * 1000);
    const { items, truncated } = await this.collect({ guild, scope, since, targetUserId });
    if (truncated) {
      return { error: `Plus de ${MAX_ROWS} événements sur cette période : réduis la durée ou cible un utilisateur.` };
    }

    for (const item of items) {
      try {
        await evaluate(item, env);
      } catch (err) {
        skip(item, `vérification impossible : ${short(err.message)}`);
      }
    }

    const okItems = items.filter((item) => item.status === 'ok');
    const reasons = new Map();
    for (const item of items) {
      if (item.status === 'skip') reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1);
    }
    const stats = {
      total: items.length,
      ok: okItems.length,
      skipped: items.length - okItems.length,
      destructive: okItems.filter((item) => item.destructive).length,
      unknownExecutor: okItems.filter((item) => !item.executorId).length,
      reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]),
    };

    const settings = await this.store.settings(guild.id);
    const warnings = [];
    if (scope !== 'moderation') {
      if (!settings.trackingSince || settings.trackingSince > since) {
        warnings.push(
          settings.trackingSince
            ? `Le journal des salons/rôles ne couvre que depuis ${ui.ts(settings.trackingSince, 'f')} : les modifications plus anciennes ne sont pas annulables.`
            : 'Le journal vient de démarrer : seules les modifications faites à partir de maintenant sont annulables.',
        );
      }
      if (okItems.some((item) => item.kind === 'channel' && item.op === 'delete')) {
        warnings.push('Un salon supprimé est recréé à l’identique (nom, permissions, catégorie) mais **ses messages ne sont pas restaurés**.');
      }
    }
    if (stats.unknownExecutor) {
      warnings.push(
        `**${stats.unknownExecutor}** action(s) sans auteur identifié (le bot a-t-il « Voir les logs du serveur » ?) : vérifie-les avant de confirmer.`,
      );
    }
    if (scope === 'moderation' || scope === 'all') {
      warnings.push('Les expulsions, purges et suppressions de messages ne sont pas annulables.');
    }

    return {
      guildId: guild.id,
      scope,
      windowS,
      since,
      targetUserId,
      items,
      stats,
      warnings,
      hash: crypto.createHash('sha1').update(okItems.map((item) => item.key).join(',')).digest('hex'),
      tooMany: okItems.length > this.limits.maxActions,
      sensitive: scope === 'all' || stats.destructive > 0 || stats.ok > SENSITIVE_COUNT,
    };
  }

  /**
   * Exécute un plan confirmé. Refait la simulation d'abord : si l'état du serveur ou du journal a changé
   * depuis l'aperçu, rien n'est exécuté.
   * @param {object} plan   résultat de plan()
   * @param {{ guild, invoker, abort: { requested: boolean }, onProgress?: Function }} options
   */
  async run(plan, { guild, invoker, abort, onProgress }) {
    if (plan.tooMany) return { error: `Plus de ${this.limits.maxActions} actions : réduis la durée ou cible un utilisateur.` };
    if (this.running.has(guild.id)) return { error: 'Un rollback est déjà en cours sur ce serveur.' };
    if (this.isRestoring?.(guild.id)) return { error: 'Une restauration de sauvegarde est en cours sur ce serveur : réessaie quand elle sera terminée.' };
    const wait = this.cooldownLeft(guild.id);
    if (wait > 0) return { error: `Délai de sécurité entre deux rollbacks : réessaie dans **${Math.ceil(wait / 1000)} s**.` };

    this.running.add(guild.id);
    this.journal.pause(guild.id, PAUSE_DURING_RUN_MS); // les actions du rollback ne sont pas journalisées
    try {
      return await this.runLocked(plan, { guild, invoker, abort, onProgress });
    } finally {
      this.journal.pause(guild.id, PAUSE_AFTER_RUN_MS);
      this.lastRun.set(guild.id, Date.now());
      this.running.delete(guild.id);
    }
  }

  async runLocked(plan, { guild, invoker, abort, onProgress }) {
    const fresh = await this.plan({ guild, invoker, scope: plan.scope, windowS: plan.windowS, targetUserId: plan.targetUserId });
    if (fresh.error) return { error: fresh.error };
    if (fresh.hash !== plan.hash) {
      return { error: 'Le serveur a changé depuis l’aperçu (nouvelles modifications ou état différent) : **rien n’a été exécuté**. Relance la commande pour revoir le plan.' };
    }
    if (fresh.tooMany) return { error: `Plus de ${this.limits.maxActions} actions : réduis la durée ou cible un utilisateur.` };

    const batchId = await this.store.createBatch({
      guildId: guild.id,
      invokerId: invoker.id,
      scope: plan.scope,
      windowS: plan.windowS,
      targetUserId: plan.targetUserId,
      planned: fresh.stats.ok,
    });
    await this.sendLog(guild.id, render.logCard({ phase: 'start', batchId, invokerId: invoker.id, plan: fresh }));

    const idMap = await this.store.idMap(guild.id);
    const env = await this.makeEnv({ guild, invoker, dry: false, batchId, idMap });
    const { items } = await this.collect({ guild, scope: plan.scope, since: fresh.since, targetUserId: plan.targetUserId });

    let consecutiveFailures = 0;
    let aborted = null;
    let processed = 0;
    for (const item of items) {
      if (abort.requested) {
        aborted = 'arrêt demandé';
        break;
      }
      try {
        await evaluate(item, env);
      } catch (err) {
        item.status = 'failed';
        item.reason = short(err.message);
      }
      processed += 1;
      if (item.status === 'done') {
        consecutiveFailures = 0;
        await this.markDone(item, env);
      } else if (item.status === 'failed') {
        consecutiveFailures += 1;
      }
      if (item.status === 'done' || item.status === 'failed') await sleep(ITEM_DELAY_MS);
      onProgress?.({ index: processed, total: items.length, item });
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        aborted = `${MAX_CONSECUTIVE_FAILURES} échecs consécutifs (coupe-circuit)`;
        break;
      }
    }
    for (const item of items.slice(processed)) {
      item.status = 'cancelled';
      item.reason = aborted;
    }

    const count = (status) => items.filter((item) => item.status === status).length;
    const result = {
      batchId,
      aborted,
      items,
      applied: count('done'),
      skipped: count('skip'),
      failed: count('failed'),
      cancelled: count('cancelled'),
    };
    await this.store
      .finishBatch(batchId, {
        status: aborted ? 'aborted' : 'done',
        applied: result.applied,
        skipped: result.skipped,
        failed: result.failed,
        report: items.map((item) => ({ key: item.key, title: item.title, status: item.status, reason: item.reason, executorId: item.executorId })),
      })
      .catch((err) => this.logger.error(`Rapport du rollback #${batchId} non enregistré`, err));
    await this.sendLog(guild.id, render.logCard({ phase: 'end', batchId, invokerId: invoker.id, plan: fresh, result }));
    return result;
  }

  async markDone(item, env) {
    try {
      if (item.source === 'mod') await this.store.markModReverted(item.row.id, env.guild.id, env.batchId, env.invoker.id);
      else await this.store.markRolledBack(item.row.id, env.invoker.id, env.batchId);
    } catch (err) {
      this.logger.error(`Marquage de ${item.key} impossible`, err);
    }
  }

  async sendLog(guildId, card) {
    try {
      const { logChannelId } = await this.store.settings(guildId);
      if (!logChannelId) return;
      const channel = this.client.channels.cache.get(String(logChannelId)) ?? (await this.client.channels.fetch(String(logChannelId)));
      if (!channel?.isTextBased()) return;
      await channel.send(ui.payload(card));
    } catch (err) {
      this.logger.warn(`Journal du rollback indisponible (${guildId})`, err.message);
    }
  }
}

module.exports = { RollbackEngine };
