'use strict';

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { isModuleAdmin } = require('../lib/access');
const { E, mentions, success, sendList } = require('../lib/render');

/**
 * Commandes publiques du module Laisse (réservées aux membres autorisés — voir /laisse-admin allow).
 * L'administration du module (limites, statuts, réglages…) est sous /laisse-admin.
 */

const userOption = (description, required = true) => (option) =>
  option.setName('user').setDescription(description).setRequired(required);

const handlers = {
  async add({ interaction, state, leash, logs, mover, guild }) {
    const target = interaction.options.getUser('user', true);
    const me = interaction.user.id;
    const error = leash.checkAdd(state, { leasherId: me, target });
    if (error) return ui.replyError(interaction, error, 'Ajout impossible', E.leash);
    await leash.addLink(guild.id, target.id, me, me);
    const fresh = await leash.state(guild.id);
    await ui.respond(
      interaction,
      success('Membre mis en laisse', `<@${target.id}> est maintenant en laisse.`, [
        { name: 'Ta laisse', value: `${leash.listOf(fresh, me).length}/${leash.limitFor(fresh, me)}` },
      ]),
      { ephemeral: true },
    );
    await logs.command(guild.id, interaction, `<@${target.id}> ajouté à sa laisse.`);
    await mover.syncPair(guild, target.id, me);
  },

  async remove({ interaction, state, leash, logs, guild }) {
    const target = interaction.options.getUser('user', true);
    const link = state.links.get(target.id);
    if (!link || link.leasherId !== interaction.user.id) {
      return ui.replyError(interaction, `<@${target.id}> n’est pas dans ta laisse.`, 'Retrait impossible', E.leash);
    }
    await leash.removeLink(guild.id, target.id);
    await ui.respond(interaction, success('Membre libéré', `<@${target.id}> n’est plus en laisse.`), { ephemeral: true });
    await logs.command(guild.id, interaction, `<@${target.id}> retiré de sa laisse.`);
  },

  async list(args) {
    await sendList(args.interaction, args, args.interaction.user.id, 'Voici la liste des membres que tu tiens en laisse.');
  },

  async clear({ interaction, leash, logs, guild }) {
    const released = await leash.clearList(guild.id, interaction.user.id);
    if (!released.length) return ui.respond(interaction, ui.card({ description: `${E.leash} Ta laisse était déjà vide.` }), { ephemeral: true });
    await ui.respond(interaction, success('Laisse vidée', `${released.length} membre(s) libéré(s) : ${mentions(released)}.`), { ephemeral: true });
    await logs.command(guild.id, interaction, `laisse vidée (${mentions(released)}).`);
  },
};

module.exports = {
  // Accès géré par le module lui-même (autorisés / admins du module — voir /laisse-admin).
  permission: { default: 'everyone' },

  data: new SlashCommandBuilder()
    .setName('laisse')
    .setDescription('Mettre des membres en laisse : ils te suivent en vocal')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) => sub.setName('add').setDescription('Mettre un membre en laisse').addUserOption(userOption('Membre à mettre en laisse')))
    .addSubcommand((sub) => sub.setName('remove').setDescription('Retirer un membre de ta laisse').addUserOption(userOption('Membre à libérer')))
    .addSubcommand((sub) => sub.setName('list').setDescription('Afficher les membres que tu tiens en laisse'))
    .addSubcommand((sub) => sub.setName('clear').setDescription('Vider ta laisse')),

  async execute(ctx, interaction) {
    const { leash, logs, mover } = ctx.services;
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const sub = interaction.options.getSubcommand();
    const state = await leash.state(guild.id);
    const isAdmin = isModuleAdmin(ctx, interaction, state);

    if (!isAdmin && !leash.canLeash(state, interaction.user.id)) {
      return ui.replyError(
        interaction,
        'Tu n’es pas autorisé à utiliser le mode laisse. Demande à un admin du module (`/laisse-admin allow`).',
        'Accès refusé',
        E.leash,
      );
    }

    const handler = handlers[sub];
    if (!handler) return ui.replyError(interaction, 'Sous-commande inconnue.');
    return handler({ ctx, interaction, state, guild, leash, logs, mover });
  },
};
