'use strict';

const { SlashCommandBuilder, InteractionContextType, MessageFlags } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { actionCard } = require('../lib/format');
const { isBlacklistBan, unbanEverywhere } = require('../lib/blacklist');

module.exports = {
  // Même portée que /blacklist (tous les serveurs du bot) : réservée aux propriétaires du bot.
  ownerOnly: true,

  data: new SlashCommandBuilder()
    .setName('unblacklist')
    .setDescription('Propriétaires du bot : retirer un utilisateur de la blacklist (lève les bans de blacklist)')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName('user').setDescription('Utilisateur à retirer de la blacklist').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison du retrait').setMaxLength(480)),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const { moderation, logs } = ctx.services;
    const target = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('raison');

    if (!(await moderation.blacklistEntry(target.id))) {
      return ui.replyError(interaction, `<@${target.id}> n’est pas blacklisté.`, 'Action impossible', '✅');
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    // Retiré de la liste AVANT le débannissement, sinon l'événement « ban levé » le re-bannirait aussitôt.
    await moderation.removeBlacklist(target.id);
    // Ici comme ailleurs, seul un bannissement posé par la blacklist est levé (un ban antérieur pour une autre raison reste).
    let unbanned = false;
    const ban = await guild.bans.fetch({ user: target.id, force: true }).catch(() => null);
    if (ban && isBlacklistBan(ban)) {
      try {
        await guild.members.unban(target.id, `Fin de blacklist${reason ? ` : ${reason}` : ''}`);
        unbanned = true;
      } catch (err) {
        return ui.replyError(interaction, `Retiré de la blacklist, mais le débannissement a échoué : ${err.message}`, 'Erreur', '✅');
      }
    }
    const otherServers = await unbanEverywhere(ctx, target.id, reason, { excludeGuildId: guild.id, executorId: interaction.user.id });

    const id = await moderation.record({ guildId: guild.id, action: 'unblacklist', targetId: target.id, executorId: interaction.user.id, reason });
    await ui.respond(
      interaction,
      actionCard(
        'unblacklist',
        `<@${target.id}> n’est plus blacklisté${unbanned ? ' et a été débanni ici' : ''}${otherServers ? ` ainsi que sur ${otherServers} autre(s) serveur(s)` : ''}.${ban && !unbanned ? '\n-# Le bannissement de ce serveur n’a pas été posé par la blacklist : il reste en place.' : ''}`,
        [
          { name: 'Raison', value: reason ?? '—' },
          { name: 'Sanction', value: `#${id}` },
        ],
      ),
    );
    await logs.action({ guildId: guild.id, action: 'unblacklist', targetId: target.id, executorId: interaction.user.id, reason, id });
  },
};
