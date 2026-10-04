'use strict';

const { PermissionFlagsBits } = require('discord.js');
const ui = require('../../../src/bot/ui');

const MESSAGE_LINK = /discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/i;

/** Ajoute les options communes aux sanctions : `preuve` (lien de message) et `dm` (prévenir en MP, faux par défaut). */
function addSanctionOptions(builder) {
  return builder
    .addStringOption((o) => o.setName('preuve').setDescription('Lien d’un message Discord à attacher comme preuve').setMaxLength(200))
    .addBooleanOption((o) => o.setName('dm').setDescription('Prévenir le membre par message privé (non par défaut)'));
}

/**
 * Récupère le message visé par un lien et en copie le contenu : la preuve reste consultable même
 * si le message est supprimé ensuite. `viewer` (membre qui ajoute la preuve) doit pouvoir lire ce salon :
 * le bot ne sert jamais à recopier un salon privé. Renvoie { proof } ou { error } (texte prêt à afficher).
 */
async function captureProof(guild, link, viewer) {
  const match = MESSAGE_LINK.exec(String(link ?? ''));
  if (!match) return { error: 'Lien de message invalide (clic droit sur le message → « Copier le lien du message »).' };
  const [, guildId, channelId, messageId] = match;
  if (guildId !== guild.id) return { error: 'Ce message n’appartient pas à ce serveur.' };
  const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  if (!channel?.isTextBased()) return { error: 'Salon du message introuvable.' };
  if (!viewer || !channel.permissionsFor(viewer)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
    return { error: 'Tu n’as pas accès au salon de ce message.' };
  }
  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message) return { error: 'Message introuvable (supprimé, ou le bot n’a pas accès à ce salon).' };
  return {
    proof: {
      channelId,
      messageId,
      authorId: message.author?.id ?? null,
      content: message.content ? message.content.slice(0, 1500) : null,
      attachments: [...message.attachments.values()].slice(0, 10).map((a) => a.url),
    },
  };
}

/** Lit l'option `preuve` d'une commande et la capture (avant d'exécuter la sanction, pour refuser un lien invalide). */
async function resolveProof(interaction) {
  const link = interaction.options.getString('preuve');
  if (!link) return { proof: null };
  return captureProof(interaction.guild, link, interaction.member);
}

function proofUrl(guildId, proof) {
  return `https://discord.com/channels/${guildId}/${proof.channel_id ?? proof.channelId}/${proof.message_id ?? proof.messageId}`;
}

/**
 * Preuve enregistrée (ligne `moderation_proofs`) au format « élément » : lien, auteur et dates hors du bloc
 * de code (mentions et timestamps n'y fonctionnent pas), contenu copié et pièces jointes en texte.
 */
function proofItem(guildId, row, client) {
  const attachments = row.attachments ? (typeof row.attachments === 'string' ? JSON.parse(row.attachments) : row.attachments) : [];
  const lines = [`🔗 [Aller au message](${proofUrl(guildId, row)})${row.author_id ? ` · 👤 <@${row.author_id}>` : ''}`];
  if (row.created_at) lines.push(`🕒 Ajoutée ${ui.ts(row.created_at, 'f')}${row.added_by ? ` par <@${row.added_by}>` : ''}`);
  if (row.content) lines.push(`> ${String(row.content).replace(/\n/g, '\n> ').slice(0, 600)}`);
  if (attachments.length) lines.push(attachments.map((url, i) => `[pièce jointe ${i + 1}](${url})`).join(' · '));
  const details = [];
  if (row.author_id) details.push(`Auteur: ${ui.userLabel(client, row.author_id)}`);
  details.push(`Message: ${row.message_id}`);
  return { item: { emoji: '🔎', title: `Preuve n°${row.id}`, lines, details } };
}

/** Lignes d'affichage d'une preuve enregistrée (ligne `moderation_proofs`). */
function proofLine(guildId, row) {
  const attachments = row.attachments ? (typeof row.attachments === 'string' ? JSON.parse(row.attachments) : row.attachments) : [];
  const lines = [`🔎 **Preuve n°${row.id}** — [message](${proofUrl(guildId, row)})${row.author_id ? ` de <@${row.author_id}>` : ''}`];
  if (row.content) lines.push(`> ${String(row.content).replace(/\n/g, '\n> ').slice(0, 400)}`);
  if (attachments.length) lines.push(attachments.map((url, i) => `[pièce jointe ${i + 1}](${url})`).join(' · '));
  return lines.join('\n');
}

module.exports = { addSanctionOptions, captureProof, resolveProof, proofUrl, proofItem, proofLine };
