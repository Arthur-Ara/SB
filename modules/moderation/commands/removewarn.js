'use strict';

const {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');
const ui = require('../../../src/bot/ui');
const { actionCard } = require('../lib/format');

module.exports = {
  permission: { default: 'admin' },

  data: new SlashCommandBuilder()
    .setName('removewarn')
    .setDescription('Retirer un avertissement actif d’un membre')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName('user').setDescription('Membre concerné').setRequired(true)),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const target = interaction.options.getUser('user', true);
    const { moderation, logs } = ctx.services;

    const warns = await moderation.activeWarns(guild.id, target.id);
    if (!warns.length) return ui.replyError(interaction, `<@${target.id}> n’a aucun avertissement actif.`, 'Rien à retirer', '⚠️');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const select = new StringSelectMenuBuilder()
      .setCustomId('removewarn:pick')
      .setPlaceholder('Choisir l’avertissement à retirer…')
      .addOptions(
        warns.map((row) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(`#${row.id} — ${ui.dateTime(row.created_at)}`.slice(0, 100))
            .setValue(String(row.id))
            .setDescription((row.reason ?? 'Sans raison précisée').slice(0, 100)),
        ),
      );
    const card = ui.card({
      title: `Avertissements actifs de ce membre. (${warns.length})`,
      body: [`👤 <@${target.id}>`, new ActionRowBuilder().addComponents(select)],
    });
    const message = await ui.respond(interaction, card);

    try {
      const picked = await message.awaitMessageComponent({ time: 60_000, filter: (i) => i.user.id === interaction.user.id });
      const warnId = Number(picked.values[0]);
      const row = warns.find((w) => Number(w.id) === warnId);
      await moderation.resolve(warnId, interaction.user.id);
      await moderation.record({ guildId: guild.id, action: 'removewarn', targetId: target.id, executorId: interaction.user.id, reason: `Avertissement #${warnId} retiré`, metadata: { warnId } });
      await picked.update(
        ui.message(actionCard('removewarn', `Avertissement **#${warnId}** de <@${target.id}> retiré.`, [{ name: 'Raison d’origine', value: row?.reason ?? '—' }])),
      );
      await logs.action({ guildId: guild.id, action: 'removewarn', targetId: target.id, executorId: interaction.user.id, reason: `Avertissement #${warnId} retiré` });
    } catch {
      await interaction.editReply({ components: [] }).catch(() => {});
    }
  },
};
