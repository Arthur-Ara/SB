'use strict';

const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const ui = require('../ui');

/**
 * /admin : admins globaux du bot — droits de propriétaire sur tout le bot, tous les serveurs et tous les modules
 * (pas sur un seul serveur ni un seul module), panel web compris. Réservé aux propriétaires déclarés dans le .env.
 */
module.exports = {
  ownerOnly: true,

  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Admins globaux du bot : tous les serveurs, tous les modules (propriétaires)')
    .addSubcommand((sub) =>
      sub
        .setName('ajouter')
        .setDescription('Rendre un utilisateur admin de tout le bot')
        .addUserOption((o) => o.setName('utilisateur').setDescription('Utilisateur').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('retirer')
        .setDescription('Retirer un admin global du bot')
        .addUserOption((o) => o.setName('utilisateur').setDescription('Utilisateur').setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName('liste').setDescription('Propriétaires et admins globaux du bot')),

  async execute(core, interaction) {
    const admins = core.botAdmins;
    if (!admins.isEnvOwner(interaction.user.id)) {
      return ui.replyError(interaction, 'Seuls les propriétaires déclarés dans la configuration du bot (BOT_OWNERS) gèrent les admins globaux.', 'Accès refusé', ui.EMOJIS.permissions);
    }
    const sub = interaction.options.getSubcommand();

    if (sub === 'liste') {
      const rows = await admins.list();
      const lines = [
        '**Propriétaires (.env)**',
        ...[...core.config.envOwners].map((id) => `• <@${id}>`),
        '',
        `**Admins globaux (${rows.length})**`,
        ...(rows.length ? rows.map((r) => `• <@${r.user_id}> — ajouté par <@${r.added_by}> ${ui.ts(r.added_at, 'R')}`) : ['Aucun.']),
      ];
      return ui.respond(interaction, ui.card({ title: 'Admins du bot', emoji: '👑', description: lines.join('\n') }), { ephemeral: true });
    }

    const user = interaction.options.getUser('utilisateur', true);
    if (user.bot) return ui.replyError(interaction, 'Un bot ne peut pas être admin du bot.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (sub === 'ajouter') {
      if (admins.isEnvOwner(user.id)) return ui.respond(interaction, ui.errorCard(`<@${user.id}> est déjà propriétaire du bot (.env).`, 'Rien à faire', 'ℹ️'));
      if (admins.has(user.id)) return ui.respond(interaction, ui.errorCard(`<@${user.id}> est déjà admin global.`, 'Rien à faire', 'ℹ️'));
      await admins.add(user.id, interaction.user.id);
      core.logger.info(`Admin global ajouté : ${user.username} (${user.id}) par ${interaction.user.username}`);
      return ui.respond(interaction, ui.successCard('Admin global ajouté', `<@${user.id}> est maintenant admin de **tout le bot** : tous les serveurs, tous les modules et le panel web.`, '👑'));
    }

    // retirer
    if (admins.isEnvOwner(user.id)) return ui.respond(interaction, ui.errorCard(`<@${user.id}> est propriétaire dans le .env : retire-le de BOT_OWNERS.`, 'Impossible', '⚠️'));
    if (!admins.has(user.id)) return ui.respond(interaction, ui.errorCard(`<@${user.id}> n’est pas admin global.`, 'Rien à faire', 'ℹ️'));
    await admins.remove(user.id);
    core.logger.info(`Admin global retiré : ${user.username} (${user.id}) par ${interaction.user.username}`);
    return ui.respond(interaction, ui.successCard('Admin global retiré', `<@${user.id}> n’est plus admin du bot.`, '🗑️'));
  },
};
