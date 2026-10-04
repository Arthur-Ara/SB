'use strict';

const ui = require('../../../src/bot/ui');
const { formatDuration } = require('../../../src/core/duration');

/**
 * Sanctions partagées par les commandes, le panel web, l'automod et le planificateur : ban temporaire,
 * sanctions automatiques au cumul d'avertissements, modification et annulation d'une sanction publiée.
 * `services` = ctx.services du module (moderation, logs) ; aucune de ces fonctions ne répond à une interaction.
 */

const MAX_TIMEOUT_S = 28 * 86_400; // limite Discord des exclusions temporaires
const WARN_RULE_ACTIONS = ['tempmute', 'kick', 'ban', 'tempban'];
/** Sanctions dont la durée peut être modifiée après coup. */
const DURATION_ACTIONS = new Set(['tempmute', 'tempvocmute', 'tempban']);
const ACTION_LABELS = { tempmute: 'Exclusion temporaire', kick: 'Expulsion', ban: 'Bannissement', tempban: 'Bannissement temporaire' };

async function fetchMember(guild, userId) {
  return guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
}

/** Une exclusion temporaire (timeout Discord) prend fin seule : elle n'est active que jusqu'à son échéance. */
function isActive(row) {
  if (!Number(row.active)) return false;
  return row.action === 'tempmute' ? Boolean(row.expires_at) && new Date(row.expires_at) > new Date() : true;
}

/** Bannit pour une durée donnée ; le planificateur lève le ban à l'échéance. Renvoie { id, expiresAt }. */
async function applyTempBan(services, guild, userId, { seconds, reason, executorId, deleteDays = 0 }) {
  await guild.members.ban(userId, { reason: `${reason ?? 'Ban temporaire'} (${formatDuration(seconds)})`.slice(0, 512), deleteMessageSeconds: deleteDays * 86_400 });
  const expiresAt = new Date(Date.now() + seconds * 1000);
  const id = await services.moderation.record({ guildId: guild.id, action: 'tempban', targetId: userId, executorId, reason, durationS: seconds, expiresAt });
  return { id, expiresAt };
}

/**
 * Après un avertissement : si le membre atteint exactement un palier réglé sur le panel, applique la
 * sanction correspondante (au nom du bot). Chaque palier ne se déclenche donc qu'une fois par cumul.
 * @returns {Promise<string|null>} description de la sanction appliquée, à ajouter à la confirmation
 */
async function applyWarnRules(services, guild, userId, client) {
  const { moderation, logs } = services;
  const rules = await moderation.listWarnRules(guild.id);
  if (!rules.length) return null;
  const count = await moderation.warnCount(guild.id, userId);
  const rule = rules.find((r) => Number(r.warn_count) === count);
  if (!rule) return null;

  const executorId = client.user.id;
  const seconds = rule.duration_minutes ? Number(rule.duration_minutes) * 60 : null;
  const reason = `Sanction automatique : ${count} avertissements`;
  try {
    let id;
    if (rule.action === 'tempmute' || rule.action === 'kick') {
      const member = await fetchMember(guild, userId);
      if (!member) return null;
      if (rule.action === 'kick') {
        await member.kick(reason);
        id = await moderation.record({ guildId: guild.id, action: 'kick', targetId: userId, executorId, reason });
      } else {
        const duration = Math.min(seconds ?? 3600, MAX_TIMEOUT_S);
        await member.timeout(duration * 1000, reason);
        id = await moderation.record({ guildId: guild.id, action: 'tempmute', targetId: userId, executorId, reason, durationS: duration, expiresAt: new Date(Date.now() + duration * 1000) });
      }
    } else if (rule.action === 'tempban' && seconds) {
      ({ id } = await applyTempBan(services, guild, userId, { seconds, reason, executorId }));
    } else {
      await guild.members.ban(userId, { reason });
      id = await moderation.record({ guildId: guild.id, action: 'ban', targetId: userId, executorId, reason });
    }
    const durationText = rule.action === 'tempmute' || rule.action === 'tempban' ? ` (${formatDuration(seconds ?? 3600)})` : '';
    await logs.action({ guildId: guild.id, action: rule.action, targetId: userId, executorId, reason: `${reason}${durationText}`, id });
    return `${ACTION_LABELS[rule.action]}${durationText} — sanction automatique #${id}`;
  } catch (err) {
    await logs.send(guild.id, ui.card({ description: `⚠️ Sanction automatique (${count} avertissements) impossible pour <@${userId}> : ${err.message}`, timestamp: true }));
    return null;
  }
}

/**
 * Modifie la raison et/ou la durée d'une sanction déjà publiée. La nouvelle durée part de la date de
 * la sanction ; une échéance déjà dépassée lève la sanction au prochain balayage (tempban, mute vocal)
 * ou immédiatement (exclusion temporaire, appliquée par Discord).
 * @returns {Promise<{ error?: string, changes?: string[] }>}
 */
async function editSanction(services, guild, row, { reason, durationS }, editorId) {
  const patch = {};
  const changes = [];
  if (reason !== undefined && (reason || null) !== (row.reason || null)) {
    patch.reason = reason || null;
    changes.push(`Raison : ${reason || '—'}`);
  }
  if (durationS !== undefined && durationS !== null && Number(durationS) !== Number(row.duration_s)) {
    if (!DURATION_ACTIONS.has(row.action)) return { error: 'Cette sanction n’a pas de durée modifiable.' };
    if (!isActive(row)) return { error: 'Cette sanction est déjà terminée : sa durée ne peut plus être modifiée.' };
    if (row.action === 'tempmute' && durationS > MAX_TIMEOUT_S) return { error: 'Une exclusion temporaire ne peut pas dépasser 28 jours.' };
    const expiresAt = new Date(new Date(row.created_at).getTime() + durationS * 1000);
    if (row.action === 'tempmute') {
      const member = await fetchMember(guild, row.target_id);
      if (!member) return { error: 'Ce membre n’est plus sur le serveur.' };
      const remaining = expiresAt.getTime() - Date.now();
      try {
        await member.timeout(remaining > 0 ? remaining : null, 'Durée de la sanction modifiée');
      } catch (err) {
        return { error: `Modification de l’exclusion impossible : ${err.message}` };
      }
    }
    patch.durationS = durationS;
    patch.expiresAt = expiresAt;
    changes.push(`Durée : ${formatDuration(durationS)} (jusqu’au ${ui.dateTime(expiresAt)})`);
  }
  if (!changes.length) return { error: 'Aucune modification.' };
  await services.moderation.editAction(row.id, patch, editorId);
  return { changes };
}

/**
 * Annule une sanction publiée (erreur de modération) : la lève côté Discord, la marque comme levée et
 * enregistre l'action inverse. Le shadow-ban garde sa commande dédiée (restauration des salons).
 * @returns {Promise<{ error?: string, inverse?: string }>}
 */
async function revokeSanction(services, guild, row, executorId, reason) {
  const { moderation } = services;
  const auditReason = reason ?? `Annulation de la sanction #${row.id}`;
  const base = { guildId: guild.id, targetId: row.target_id, executorId, reason: auditReason, metadata: { revokedId: Number(row.id) } };
  if (!isActive(row) && row.action !== 'ban') return { error: 'Cette sanction est déjà levée.' };
  try {
    switch (row.action) {
      case 'warn':
        await moderation.resolve(row.id, executorId);
        await moderation.record({ ...base, action: 'removewarn' });
        return { inverse: 'removewarn' };
      case 'tempmute': {
        const member = await fetchMember(guild, row.target_id);
        if (member?.communicationDisabledUntil) await member.timeout(null, auditReason);
        await moderation.resolve(row.id, executorId);
        await moderation.record({ ...base, action: 'unmute' });
        return { inverse: 'unmute' };
      }
      case 'tempvocmute': {
        const member = await fetchMember(guild, row.target_id);
        if (member?.voice?.serverMute) await member.voice.setMute(false, auditReason);
        await moderation.resolve(row.id, executorId);
        await moderation.record({ ...base, action: 'untempvocmute' });
        return { inverse: 'untempvocmute' };
      }
      case 'ban':
      case 'tempban': {
        if (await moderation.blacklistEntry(row.target_id)) return { error: 'Ce membre est blacklisté : utilise /unblacklist pour lever le bannissement.' };
        const ban = await guild.bans.fetch({ user: row.target_id, force: true }).catch(() => null);
        if (!ban && row.action === 'ban') return { error: 'Ce membre n’est plus banni.' };
        if (ban) await guild.members.unban(row.target_id, auditReason);
        await moderation.resolve(row.id, executorId);
        const inverse = row.action === 'tempban' ? 'untempban' : 'unban';
        await moderation.record({ ...base, action: inverse });
        return { inverse };
      }
      case 'shadowban':
        return { error: 'Un shadow-ban se lève avec /unshadow-ban (ou depuis l’onglet Shadow-bans) pour restaurer l’accès aux salons.' };
      default:
        return { error: 'Ce type de sanction ne peut pas être annulé.' };
    }
  } catch (err) {
    return { error: `Annulation impossible : ${err.message}` };
  }
}

module.exports = { MAX_TIMEOUT_S, WARN_RULE_ACTIONS, DURATION_ACTIONS, isActive, applyTempBan, applyWarnRules, editSanction, revokeSanction };
