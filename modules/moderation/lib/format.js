'use strict';

const ui = require('../../../src/bot/ui');

/** Émoji et libellé standard de chaque type d'action, réutilisés partout dans le module. */
const ACTION_META = {
  ban: { emoji: '🔨', label: 'Bannissement' },
  unban: { emoji: '🕊️', label: 'Débannissement' },
  kick: { emoji: '👢', label: 'Expulsion' },
  tempmute: { emoji: '🔇', label: 'Exclusion temporaire' },
  unmute: { emoji: '🔊', label: 'Levée d’exclusion' },
  tempvocmute: { emoji: '🎙️', label: 'Mute vocal temporaire' },
  untempvocmute: { emoji: '🎤', label: 'Fin de mute vocal' },
  warn: { emoji: '⚠️', label: 'Avertissement' },
  removewarn: { emoji: '🧹', label: 'Avertissement retiré' },
  shadowban: { emoji: '🚷', label: 'Shadow-ban' },
  unshadowban: { emoji: '🔓', label: 'Fin de shadow-ban' },
  lock: { emoji: '🔒', label: 'Verrouillage' },
  unlock: { emoji: '🔓', label: 'Déverrouillage' },
  lockall: { emoji: '🔒', label: 'Verrouillage global' },
  unlockall: { emoji: '🔓', label: 'Déverrouillage global' },
  clear: { emoji: '🧹', label: 'Suppression de messages' },
  slowmode: { emoji: '🐢', label: 'Mode lent' },
  purge: { emoji: '♻️', label: 'Purge de salon' },
  modlogs: { emoji: '🛠️', label: 'Salon de journal modifié' },
  blacklist: { emoji: '⛔', label: 'Blacklist' },
  unblacklist: { emoji: '✅', label: 'Retrait de la blacklist' },
  tempban: { emoji: '⏳', label: 'Bannissement temporaire' },
  untempban: { emoji: '🕊️', label: 'Fin de ban temporaire' },
  automod: { emoji: '🤖', label: 'Automod' },
};

function meta(action) {
  return ACTION_META[action] ?? { emoji: '📋', label: action };
}

/** « 1 j 4 h », « 45 min »… à partir d'une durée en secondes. */
function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s} s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`;
  const days = Math.floor(hours / 24);
  return `${days} j ${hours % 24} h`;
}

/** Confirmation d'une action : « 🔨 texte » + bloc « Détails » optionnel. */
function actionCard(action, description, fields) {
  const { emoji } = meta(action);
  const stats = (fields ?? []).map(({ name, value }) => [name, String(value)]);
  return ui.successCard(meta(action).label, description, emoji, stats.length ? [{ stats }] : []);
}

/**
 * Une sanction au format « élément » de la charte (/history, /sanction) à partir d'une ligne `moderation_actions`.
 * Mentions et dates restent dans les lignes de texte : Discord ne les interprète pas dans un bloc de code,
 * le bloc de détails n'affiche donc que du texte brut (noms, raison, durée, preuves).
 * @param {{ client?: object, proofCount?: number }} [options]
 */
function historyItem(row, { client, proofCount = 0 } = {}) {
  const { emoji, label } = meta(row.action);
  const lines = [];
  if (row.target_id) lines.push(`👤 <@${row.target_id}>`);
  if (row.channel_id) lines.push(`📍 <#${row.channel_id}>`);
  lines.push(`🛠️ <@${row.executor_id}> · ${ui.ts(row.created_at, 'f')} (${ui.ts(row.created_at, 'R')})`);
  if (row.action === 'warn' && !Number(row.active)) lines.push('*(avertissement retiré)*');
  else if (['ban', 'tempban', 'tempmute', 'tempvocmute'].includes(row.action) && !Number(row.active)) lines.push('*(sanction levée)*');
  if (row.action === 'tempban' && row.expires_at && Number(row.active)) lines.push(`⏳ Jusqu’au ${ui.ts(row.expires_at, 'f')}`);
  if (row.edited_at) lines.push(`✏️ Modifiée par <@${row.edited_by}> ${ui.ts(row.edited_at, 'R')}`);

  const details = [`Identifiant: #${row.id}`];
  if (row.target_id) details.push(`Cible: ${ui.userLabel(client, row.target_id)}`);
  details.push(`Modérateur: ${ui.userLabel(client, row.executor_id)}`);
  if (row.duration_s) details.push(`Durée: ${formatDuration(row.duration_s)}`);
  details.push(`Raison: ${row.reason ? String(row.reason).replace(/\s+/g, ' ').slice(0, 200) : 'aucune'}`);
  details.push(`Preuves: ${proofCount ? `${proofCount} (/sanction voir ${row.id})` : 'aucune'}`);
  return { item: { emoji, title: `${label} n°${row.id}`, lines, details } };
}

/** Tente d'avertir la cible en message privé ; renvoie false en silence si ses DM sont fermés. */
async function notifyTarget(user, guildName, action, reason) {
  const { emoji, label } = meta(action);
  try {
    await user.send(
      ui.payload(
        ui.card({ description: `${emoji} **${label}** sur **${guildName}**${reason ? `\n📝 Raison : ${reason}` : ''}` }),
      ),
    );
    return true;
  } catch {
    return false;
  }
}

/** N'envoie le MP que si l'option `dm` de la commande est cochée (faux par défaut) ; renvoie null si non demandé. */
async function maybeNotify(interaction, user, guildName, action, reason) {
  if (!interaction.options.getBoolean('dm')) return null;
  return notifyTarget(user, guildName, action, reason);
}

/** Mention à ajouter à la confirmation quand le MP demandé n'a pas pu partir. */
function dmNote(dmSent) {
  return dmSent === false ? '\n-# Message privé impossible (DM fermés).' : '';
}

/**
 * Enregistre la preuve (si fournie) sur la sanction et renvoie le champ « Preuve » à afficher
 * dans la confirmation (tableau vide sinon).
 */
async function attachProof(moderation, guildId, actionId, proof, userId) {
  if (!proof) return [];
  const proofId = await moderation.addProof(guildId, actionId, proof, userId);
  return [{ name: 'Preuve', value: `n°${proofId} — /sanction voir ${actionId}` }];
}

module.exports = { ACTION_META, meta, formatDuration, actionCard, historyItem, notifyTarget, maybeNotify, dmNote, attachProof };
