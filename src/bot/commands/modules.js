'use strict';

const {
  SlashCommandBuilder,
  InteractionContextType,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ComponentType,
  MessageFlags,
} = require('discord.js');
const ui = require('../ui');

const TIMEOUT_MS = 10 * 60_000;

function moduleItem(core, module, guildId) {
  const enabled = core.modules.isEnabledFor(module.name, guildId);
  const status = module.required
    ? '🔒 Toujours actif'
    : enabled
      ? `${ui.EMOJIS.allowed} Activé sur ce serveur`
      : `${ui.EMOJIS.denied} Désactivé sur ce serveur`;
  return {
    item: {
      emoji: module.emoji ?? ui.EMOJIS.modules,
      title: module.label,
      lines: [status],
      details: [
        `Description: ${module.description || '—'}`,
        `Commandes: ${module.commands.length ? module.commands.map((c) => `/${c}`).join(', ') : 'aucune'}`,
      ],
    },
  };
}

function toggleMenu(core, guildId, disabled) {
  const optional = core.modules.list().filter((m) => !m.required);
  if (!optional.length) return null;
  const menu = new StringSelectMenuBuilder()
    .setCustomId('modules:toggle')
    .setPlaceholder('Choisir les modules actifs sur ce serveur')
    .setMinValues(0)
    .setMaxValues(optional.length)
    .setDisabled(disabled)
    .addOptions(
      optional.map((m) => {
        const option = new StringSelectMenuOptionBuilder()
          .setLabel(m.label.slice(0, 100))
          .setValue(m.name)
          .setDescription((m.description || m.name).slice(0, 100))
          .setDefault(core.modules.isEnabledFor(m.name, guildId));
        if (m.emoji) option.setEmoji(m.emoji);
        return option;
      }),
    );
  return new ActionRowBuilder().addComponents(menu);
}

function reloadMenu(core, disabled) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('modules:reload')
    .setPlaceholder('Propriétaires du bot : recharger les commandes d’un module…')
    .setDisabled(disabled)
    .addOptions(
      core.modules.list().map((m) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`Recharger ${m.label}`.slice(0, 100))
          .setValue(m.name)
          .setDescription(`${m.commands.length} commande(s), ${m.events} écouteur(s)`.slice(0, 100)),
      ),
    );
  return new ActionRowBuilder().addComponents(menu);
}

module.exports = {
  permission: { default: 'admin' },

  data: new SlashCommandBuilder()
    .setName('modules')
    .setDescription('Activer ou désactiver les modules du bot sur ce serveur')
    .setContexts(InteractionContextType.Guild),

  async execute(core, interaction) {
    const { guildId } = interaction;
    const isOwner = core.config.owners.has(interaction.user.id);
    let notice = null;

    const render = (disabled = false) => {
      const modules = core.modules.list();
      const active = modules.filter((m) => core.modules.isEnabledFor(m.name, guildId)).length;
      return ui.card({
        title: `Voici la liste des modules du serveur. (${modules.length})`,
        body: [
          { stats: [['Actifs', active], ['Désactivés', modules.length - active]] },
          ...modules.map((m) => moduleItem(core, m, guildId)),
          notice ? `\n${notice}` : null,
          toggleMenu(core, guildId, disabled),
          isOwner ? reloadMenu(core, disabled) : null,
        ],
      });
    };

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const message = await ui.respond(interaction, render());

    const collector = message.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: TIMEOUT_MS });
    collector.on('collect', async (select) => {
      if (select.user.id !== interaction.user.id) return ui.rejectForeignClick(select);
      try {
        if (select.customId === 'modules:toggle') {
          const chosen = new Set(select.values);
          const changes = [];
          for (const module of core.modules.list().filter((m) => !m.required)) {
            const enabled = chosen.has(module.name);
            if (enabled === core.modules.isEnabledFor(module.name, guildId)) continue;
            await core.modules.setEnabledFor(module.name, guildId, enabled, interaction.user.id);
            changes.push(`${module.label} ${enabled ? 'activé' : 'désactivé'}`);
          }
          notice = changes.length ? `${ui.EMOJIS.success} ${changes.join(' · ')}` : 'Aucun changement.';
        } else if (select.customId === 'modules:reload') {
          if (!core.config.owners.has(select.user.id)) return ui.rejectForeignClick(select);
          const name = select.values[0];
          const { commands, events } = core.modules.loadHandlers(name);
          await core.commands.deploy();
          notice = `${ui.EMOJIS.success} ${core.modules.labelOf(name)} rechargé : ${commands.length} commande(s), ${events.length} écouteur(s). Slash commands republiées.`;
        }
      } catch (err) {
        core.logger.error('Action /modules impossible', err);
        notice = `${ui.EMOJIS.error} Action impossible : ${err.message}`;
      }
      return select.update(ui.message(render())).catch(() => {});
    });
    collector.on('end', () => {
      interaction.editReply(ui.message(render(true))).catch(() => {});
    });
  },
};
