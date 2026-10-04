'use strict';

const { Events, MessageFlags } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { roleAccess, isTicketAdmin, claimBlock } = require('../lib/guard');
const { downloadAttachment, stickersOf } = require('../lib/attachments');

/** Suivi d'activité (pour l'auto-clôture/reping) et capture pour le transcript, si activé pour le type. */
module.exports = {
  event: Events.MessageCreate,

  async execute(ctx, message) {
    if (!message.guild || message.system) return;
    const { tickets } = ctx.services;
    // Filtre instantané (index mémoire) : un message hors salon de ticket ne coûte aucune requête.
    if (!tickets.isTicketChannel(message.channel.id)) return;
    // Réponses éphémères (ex. /permission, /ticket delay…) : jamais une vraie conversation du ticket,
    // et normalement jamais reçues ici (Discord ne les diffuse pas), mais on l'exclut explicitement
    // par sécurité plutôt que de compter sur ce seul postulat.
    if (message.flags?.has(MessageFlags.Ephemeral)) return;
    const ticket = await tickets.getTicketByChannel(message.channel.id);
    // Le bot poste aussi juste après la fermeture (avis de fermeture, boutons) : ces messages restent captés.
    if (!ticket || (ticket.status !== 'open' && !message.author.bot)) return;
    const type = await tickets.getType(ticket.type_id);
    if (!type) return;

    // Réponses envoyées depuis le panel web : déjà enregistrées par la route web (avec leur marque « panel web »).
    if (message.webhookId && String(message.webhookId) === String(ticket.webhook_id)) return;
    if (message.author.id === ctx.client.user.id && message.content.startsWith('🌐 **')) return;

    const isBot = message.author.bot;
    const member = message.member;
    // Les messages du bot (accueil, fermeture, rappels…) figurent au transcript mais ne comptent
    // jamais comme une activité de l'ouvreur ou du staff (auto-clôture / reping).
    if (!isBot) {
      // Staff = mêmes règles que partout ailleurs dans le module (lib/guard.js) : rôles modérateur/helper du
      // type, admins du module, administrateurs et propriétaire du serveur, propriétaires du bot.
      const isStaff = Boolean(member && message.author.id !== ticket.opener_id && (roleAccess(type, member) || (await isTicketAdmin(ctx, member))));

      // « Obliger à prendre en charge pour répondre » (réglage du type) : seul le membre du staff qui a pris
      // le ticket en charge y répond — un ticket a toujours un responsable identifié (et noté).
      const blocked = isStaff ? claimBlock(type, ticket, message.author.id) : null;
      if (blocked) {
        await message.delete().catch(() => {});
        const warn = await message.channel
          .send({ ...ui.payload(ui.errorCard(`<@${message.author.id}> ${blocked}`, 'Réponse réservée', '🙋')), allowedMentions: { parse: [] } })
          .catch(() => null);
        if (warn) setTimeout(() => warn.delete().catch(() => {}), 8000).unref();
        return;
      }

      const isOpener = message.author.id === ticket.opener_id;
      await tickets.touchActivity(ticket.id, { isStaff, isOpener });
    }

    if (!type.auto_transcript && !type.live_transcript) return;
    const roleColor = member?.displayHexColor && member.displayHexColor !== '#000000' ? member.displayHexColor : null;

    const messageRowId = await tickets.appendMessage({
      ticketId: ticket.id,
      messageId: message.id,
      authorId: message.author.id,
      authorName: member?.displayName ?? message.author.username,
      authorAvatar: message.author.displayAvatarURL({ size: 64 }),
      authorRoleColor: roleColor,
      authorBot: isBot,
      content: message.content || null,
      embeds: message.embeds.length ? message.embeds.map((e) => e.toJSON()) : null,
      attachments: null,
      createdAt: message.createdAt,
    });
    const stickers = stickersOf(message);
    if (!messageRowId || (!message.attachments.size && !stickers.length)) return;

    // Téléchargées après coup (l'id du message doit d'abord exister pour les rattacher) : les
    // liens Discord d'origine sont voués à expirer, on sert nos propres copies via le panel web.
    const save = (file) => tickets.saveAttachment({ messageRowId, ...file });
    const downloaded = await Promise.all([...message.attachments.values()].map((a) => downloadAttachment(a, save, ctx.logger)));
    await tickets.setMessageAttachments(messageRowId, [...downloaded, ...stickers]);
  },
};
