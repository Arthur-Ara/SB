'use strict';

const { SlashCommandBuilder, InteractionContextType, MessageFlags } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { isModmailStaff, isModmailStaffAnywhere, openModmail, closeModmail, staffReply, captureModmailMessage } = require('../lib/modmail');
const { ticketsUrl } = require('../lib/webUrl');

module.exports = {
  // La configuration (activation, catégories, rôles staff) se fait uniquement sur le panel web
  // (/m/tickets/) — cette commande ne gère plus que l'usage courant (ouvrir/fermer un fil).
  permission: { default: 'everyone' },

  data: new SlashCommandBuilder()
    .setName('modmail')
    .setDescription('Modmail : discuter avec un membre en message privé via un salon staff')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('ouvrir')
        .setDescription('Ouvrir un modmail avec un membre (le bot lui écrit en premier)')
        .addUserOption((o) => o.setName('user').setDescription('Membre à contacter').setRequired(true))
        .addStringOption((o) => o.setName('message').setDescription('Premier message envoyé au membre').setRequired(true).setMaxLength(1500))
        .addStringOption((o) => o.setName('categorie').setDescription('Catégorie (si plusieurs sont configurées) — nom exact').setMaxLength(100)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('anonyme')
        .setDescription('Répondre au membre de ce fil sans révéler ton nom (« Staff — serveur »)')
        .addStringOption((o) => o.setName('message').setDescription('Réponse envoyée au membre').setRequired(true).setMaxLength(2000)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('fermer')
        .setDescription('Fermer le modmail de ce salon')
        .addStringOption((o) => o.setName('raison').setDescription('Raison de la fermeture').setMaxLength(512)),
    ),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const { tickets } = ctx.services;
    const sub = interaction.options.getSubcommand();

    if (sub === 'ouvrir') {
      if (!(await isModmailStaffAnywhere(ctx, guild, interaction.member))) {
        return ui.replyError(interaction, 'Réservé au staff du modmail (rôles définis sur le panel web) ou aux admins du module.', 'Accès refusé', ui.EMOJIS.permissions);
      }
      const enabled = await tickets.modmailEnabled(guild.id);
      const categories = await tickets.listModmailCategories(guild.id);
      if (!enabled || !categories.length) {
        return ui.replyError(interaction, 'Le modmail n’est pas configuré : réglez-le sur le panel web (`/m/tickets/`).', 'Modmail indisponible', '📨');
      }
      let category = null;
      const wanted = interaction.options.getString('categorie');
      if (wanted) {
        category = categories.find((c) => c.name.toLowerCase() === wanted.toLowerCase());
        if (!category) return ui.replyError(interaction, `Catégorie inconnue. Catégories disponibles : ${categories.map((c) => c.name).join(', ')}.`);
      } else if (categories.length > 1) {
        return ui.replyError(interaction, `Plusieurs catégories sont configurées : précise l’option \`categorie\` parmi ${categories.map((c) => c.name).join(', ')}.`);
      } else {
        [category] = categories;
      }

      const user = interaction.options.getUser('user', true);
      if (user.bot) return ui.replyError(interaction, 'Impossible d’écrire à un bot.');
      const text = interaction.options.getString('message', true);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const dm = await user
        .send(ui.payload(ui.card({ author: { name: guild.name, iconURL: guild.iconURL({ size: 64 }) ?? undefined }, description: text, footer: 'Réponds simplement à ce message pour écrire au staff.' })))
        .then(() => true)
        .catch(() => false);
      if (!dm) return ui.respond(interaction, ui.errorCard('Le membre a fermé ses messages privés : impossible de le contacter.', 'Envoi impossible', '📨'));
      const result = await openModmail(ctx, { guild, user, openedBy: interaction.user.id, category });
      if (result.error) return ui.respond(interaction, ui.errorCard(result.error, 'Modmail impossible', '📨'));
      if (!result.channel) {
        // Catégorie « panel uniquement » : le premier message est seulement enregistré, la suite se passe sur le panel.
        await captureModmailMessage(ctx, result.thread.id, {
          kind: 'staff',
          authorId: interaction.user.id,
          authorName: interaction.member?.displayName ?? interaction.user.username,
          authorAvatar: interaction.user.displayAvatarURL({ size: 64 }),
          content: text,
        });
        const url = ticketsUrl(ctx.config, `transcript?modmail=${result.thread.id}`);
        return ui.respond(interaction, ui.successCard('Modmail ouvert', `Discussion ouverte avec <@${user.id}>, à suivre depuis le panel web${url ? ` : ${url}` : ''}.`, '📨'));
      }
      await result.channel.send(ui.payload(ui.card({ description: `📤 Premier message envoyé par <@${interaction.user.id}> :\n>>> ${text}` }))).catch(() => {});
      return ui.respond(interaction, ui.successCard('Modmail ouvert', `Discussion ouverte avec <@${user.id}> : <#${result.channel.id}>`, '📨'));
    }

    // anonyme / fermer : dans le salon d'un fil ouvert, staff de sa catégorie uniquement
    const thread = await tickets.modmailByChannel(interaction.channelId);
    if (!thread) return ui.replyError(interaction, 'Cette commande s’utilise dans un salon de modmail ouvert.');
    if (!(await isModmailStaff(ctx, interaction.member, thread.staff_role_ids))) {
      return ui.replyError(interaction, 'Réservé au staff du modmail (rôles définis sur le panel web) ou aux admins du module.', 'Accès refusé', ui.EMOJIS.permissions);
    }

    if (sub === 'anonyme') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { delivered, error } = await staffReply(ctx, thread, {
        authorId: interaction.user.id,
        authorName: interaction.member?.displayName ?? interaction.user.username,
        authorAvatar: interaction.user.displayAvatarURL({ size: 64 }),
        member: interaction.member,
        content: interaction.options.getString('message', true),
        anonymous: true,
      });
      if (error || !delivered) {
        return ui.respond(interaction, ui.errorCard(error ?? 'Message non remis : le membre a fermé ses messages privés ou ne partage plus de serveur avec le bot.', 'Envoi impossible', '📨'));
      }
      return ui.respond(interaction, ui.successCard('Réponse anonyme envoyée', 'Le membre voit « Staff » au lieu de ton nom.', '🕶️'));
    }
    const reason = interaction.options.getString('raison');
    await interaction.reply(ui.payload(ui.successCard('Modmail fermé', 'Le salon sera supprimé dans quelques secondes.', '🔒'), { ephemeral: true }));
    await closeModmail(ctx, thread, { closedBy: interaction.user.id, reason });
  },
};
