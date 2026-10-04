'use strict';

const { Events } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { isModmailStaff, closeModmail, pending, startThread, pickCategoryOrStart } = require('../lib/modmail');

/** Boutons/sélecteurs du modmail : bouton « Fermer le fil » (salon staff) et choix du serveur/catégorie (MP). */
module.exports = {
  event: Events.InteractionCreate,

  async execute(ctx, interaction) {
    try {
      if (interaction.isStringSelectMenu() && interaction.customId === 'modmail:pick') {
        const entry = pending.get(interaction.user.id);
        if (!entry) return void (await interaction.update({ content: 'Ce choix a expiré : renvoie-moi ton message.', embeds: [], components: [] }));
        const guild = ctx.client.guilds.cache.get(interaction.values[0]);
        pending.delete(interaction.user.id);
        if (!guild) return void (await interaction.update({ content: 'Serveur introuvable.', embeds: [], components: [] }));
        await interaction.update({ ...ui.payload(ui.card({ description: `📨 Envoi au staff de **${guild.name}**…` })), components: [] });
        const dmChannel = interaction.channel ?? (await interaction.user.createDM());
        await pickCategoryOrStart(ctx, guild, interaction.user, entry.message, dmChannel);
        return;
      }

      if (interaction.isStringSelectMenu() && interaction.customId === 'modmail:pickcategory') {
        const entry = pending.get(interaction.user.id);
        if (!entry || !entry.guildId) return void (await interaction.update({ content: 'Ce choix a expiré : renvoie-moi ton message.', embeds: [], components: [] }));
        const guild = ctx.client.guilds.cache.get(entry.guildId);
        pending.delete(interaction.user.id);
        if (!guild) return void (await interaction.update({ content: 'Serveur introuvable.', embeds: [], components: [] }));
        const category = await ctx.services.tickets.getModmailCategory(Number(interaction.values[0]));
        if (!category || category.guild_id !== guild.id) return void (await interaction.update({ content: 'Catégorie introuvable.', embeds: [], components: [] }));
        await interaction.update({ ...ui.payload(ui.card({ description: `📨 Envoi au staff de **${guild.name}** (${category.name})…` })), components: [] });
        const dmChannel = interaction.channel ?? (await interaction.user.createDM());
        await startThread(ctx, guild, interaction.user, entry.message, dmChannel, category);
        return;
      }

      if (interaction.isButton() && interaction.customId.startsWith('modmail:close:')) {
        if (!interaction.inGuild()) return;
        const thread = await ctx.services.tickets.modmailByChannel(interaction.channelId);
        if (!thread) return void (await ui.replyError(interaction, 'Ce fil est déjà fermé.'));
        if (!(await isModmailStaff(ctx, interaction.member, thread.staff_role_ids))) {
          return void (await ui.replyError(interaction, 'Réservé au staff du modmail.', 'Accès refusé', ui.EMOJIS.permissions));
        }
        await interaction.reply(ui.payload(ui.successCard('Fil fermé', 'Le salon sera supprimé dans quelques secondes.', '🔒'), { ephemeral: true }));
        await closeModmail(ctx, thread, { closedBy: interaction.user.id });
      }
    } catch (err) {
      ctx.logger.error('Interaction modmail impossible', err);
      await ui.replyError(interaction, 'Une erreur est survenue.').catch(() => {});
    }
  },
};
