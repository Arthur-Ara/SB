'use strict';

const { Events, MessageFlags } = require('discord.js');
const { downloadAttachment, stickersOf } = require('../../tickets/lib/attachments');

/**
 * Transcription : tous les messages d'un salon de candidature (candidat, recruteurs, bot) sont enregistrés, avec
 * l'auteur tel qu'il était à l'envoi et une copie des pièces jointes (les liens Discord expirent). Ces messages
 * servent aussi au contrôle automatique des critères (nombre de caractères, de messages, de pièces jointes…).
 */
module.exports = {
  event: Events.MessageCreate,

  async execute(ctx, message) {
    if (!message.guild || message.system) return;
    const { candidatures } = ctx.services;
    // Filtre instantané (index mémoire) : un message hors salon de candidature ne coûte aucune requête.
    if (!candidatures.isCandidatureChannel(message.channel.id)) return;
    if (message.flags?.has(MessageFlags.Ephemeral)) return;
    const candidature = await candidatures.getByChannel(message.channel.id);
    if (!candidature) return;

    const member = message.member;
    const roleColor = member?.displayHexColor && member.displayHexColor !== '#000000' ? member.displayHexColor : null;
    const messageRowId = await candidatures.appendMessage({
      candidatureId: candidature.id,
      messageId: message.id,
      authorId: message.author.id,
      authorName: member?.displayName ?? message.author.username,
      authorAvatar: message.author.displayAvatarURL({ size: 64 }),
      authorRoleColor: roleColor,
      authorBot: message.author.bot,
      content: message.content || null,
      embeds: message.embeds.length ? message.embeds.map((e) => e.toJSON()) : null,
      attachments: null,
      createdAt: message.createdAt,
    });
    const stickers = stickersOf(message);
    if (!messageRowId || (!message.attachments.size && !stickers.length)) return;

    const save = (file) => candidatures.saveAttachment({ messageRowId, ...file });
    const downloaded = await Promise.all([...message.attachments.values()].map((a) => downloadAttachment(a, save, ctx.logger)));
    await candidatures.setMessageAttachments(messageRowId, [...downloaded, ...stickers]);
  },
};
