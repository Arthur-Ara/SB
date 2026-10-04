'use strict';

const { SlashCommandBuilder, InteractionContextType, MessageFlags } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { basicChecks, canModerate } = require('../lib/guard');
const { actionCard, maybeNotify, dmNote, attachProof } = require('../lib/format');
const { addSanctionOptions, resolveProof } = require('../lib/proofs');
const { banEverywhere, blacklistReason } = require('../lib/blacklist');

module.exports = {
  // Effet sur TOUS les serveurs du bot : réservée à ses propriétaires (BOT_OWNERS), jamais à l'admin d'un seul serveur.
  ownerOnly: true,

  data: addSanctionOptions(
    new SlashCommandBuilder()
      .setName('blacklist')
      .setDescription('Propriétaires du bot : bannissement global (tous les serveurs du bot), sauf /unblacklist')
      .setContexts(InteractionContextType.Guild)
      .addUserOption((o) => o.setName('user').setDescription('Utilisateur à blacklister').setRequired(true))
      .addStringOption((o) => o.setName('raison').setDescription('Raison de la blacklist').setMaxLength(480)),
  ),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const { moderation, logs } = ctx.services;
    const target = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('raison');

    const basic = basicChecks(interaction, target);
    if (!basic.allowed) return ui.replyError(interaction, basic.reason, 'Action impossible', '⛔');
    const member = guild.members.cache.get(target.id) ?? (await guild.members.fetch(target.id).catch(() => null));
    if (member) {
      const hierarchy = canModerate(interaction.member, member);
      if (!hierarchy.allowed) return ui.replyError(interaction, hierarchy.reason, 'Action impossible', '⛔');
    }
    if (await moderation.blacklistEntry(target.id)) {
      return ui.replyError(interaction, `<@${target.id}> est déjà blacklisté.`, 'Action impossible', '⛔');
    }

    const { proof, error: proofError } = await resolveProof(interaction);
    if (proofError) return ui.replyError(interaction, proofError, 'Preuve invalide', '🔎');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const dmSent = await maybeNotify(interaction, target, guild.name, 'blacklist', reason);
    const alreadyBanned = await guild.bans.fetch({ user: target.id, force: true }).catch(() => null);
    if (!alreadyBanned) {
      try {
        await guild.members.ban(target.id, { reason: blacklistReason(reason) });
      } catch (err) {
        return ui.replyError(interaction, `Blacklist impossible : ${err.message}`, 'Erreur', '⛔');
      }
    }

    const id = await moderation.record({ guildId: guild.id, action: 'blacklist', targetId: target.id, executorId: interaction.user.id, reason });
    await moderation.addBlacklist(guild.id, target.id, id, interaction.user.id, reason);
    const proofFields = await attachProof(moderation, guild.id, id, proof, interaction.user.id);
    const otherServers = await banEverywhere(ctx, target.id, reason, { excludeGuildId: guild.id, executorId: interaction.user.id });
    await ui.respond(
      interaction,
      actionCard(
        'blacklist',
        `<@${target.id}> est blacklisté : banni ici${otherServers ? ` et sur ${otherServers} autre(s) serveur(s)` : ''}, et re-banni automatiquement s’il revient ou est débanni à la main (y compris sur les serveurs rejoints plus tard par le bot).${dmNote(dmSent)}`,
        [
          { name: 'Raison', value: reason ?? '—' },
          { name: 'Sanction', value: `#${id}` },
          ...proofFields,
        ],
      ),
    );
    await logs.action({ guildId: guild.id, action: 'blacklist', targetId: target.id, executorId: interaction.user.id, reason, id, proof });
  },
};
