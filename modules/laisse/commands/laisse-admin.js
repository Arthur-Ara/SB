'use strict';

const { SlashCommandBuilder, InteractionContextType, ChannelType, PermissionFlagsBits } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { isModuleAdmin } = require('../lib/access');
const { E, onOff, mentions, voiceLine, success, sendList, flagView } = require('../lib/render');

/**
 * Administration du module Laisse. Séparée de /laisse (nommage en « -admin ») pour la
 * distinguer clairement des commandes publiques. Réservée aux admins du module (voir isModuleAdmin) :
 * l'accès n'est pas géré par le système de permissions Discord (/permission) mais par le module
 * lui-même, pour que /laisse-admin set puisse donner ce droit sans passer par le rôle Administrateur.
 */

const userOption = (description, required = true) => (option) =>
  option.setName('user').setDescription(description).setRequired(required);
const stateOption = (description) => (option) => option.setName('etat').setDescription(description).setRequired(true);
const numberOption = (description) => (option) =>
  option.setName('nombre').setDescription(description).setRequired(true).setMinValue(0).setMaxValue(100);

const handlers = {
  async allow({ interaction, leash, logs, guild }) {
    const target = interaction.options.getUser('user', true);
    if (target.bot) return ui.replyError(interaction, 'Un bot ne peut pas utiliser le mode laisse.');
    await leash.updateMember(guild.id, target.id, { allowed: true, allowedBy: interaction.user.id, allowedAt: new Date() });
    await ui.respond(interaction, success('Accès accordé', `<@${target.id}> peut maintenant mettre des membres en laisse.`), { ephemeral: true });
    await logs.command(guild.id, interaction, `<@${target.id}> est autorisé à utiliser le mode laisse.`);
  },

  async deny({ interaction, leash, logs, guild }) {
    const target = interaction.options.getUser('user', true);
    await leash.updateMember(guild.id, target.id, { allowed: false, allowedBy: interaction.user.id, allowedAt: new Date() });
    const released = await leash.clearList(guild.id, target.id);
    const note = released.length ? ` Sa laisse a été vidée (${mentions(released)}).` : '';
    await ui.respond(interaction, success('Accès retiré', `<@${target.id}> ne peut plus utiliser le mode laisse.${note}`), { ephemeral: true });
    await logs.command(guild.id, interaction, `<@${target.id}> n’est plus autorisé à utiliser le mode laisse.${note}`);
  },

  async limit({ interaction, state, leash, logs, guild }) {
    const target = interaction.options.getUser('user', true);
    const value = interaction.options.getInteger('nombre', true);
    const before = leash.limitFor(state, target.id);
    await leash.updateMember(guild.id, target.id, { maxLeashes: value });
    await ui.respond(
      interaction,
      success('Limite modifiée', `Nombre maximal de membres en laisse pour <@${target.id}>.`, [
        { name: 'Limite', value: `${before} → **${value}**` },
      ]),
      { ephemeral: true },
    );
    await logs.command(guild.id, interaction, `limite de <@${target.id}> : ${before} → ${value}.`);
  },

  async 'global-limit'({ interaction, leash, logs, guild }) {
    const value = interaction.options.getInteger('nombre', true);
    const { previous } = await leash.updateSettings(guild.id, { globalLimit: value });
    await ui.respond(
      interaction,
      success('Limite par défaut modifiée', 'S’applique aux membres autorisés sans limite personnelle.', [
        { name: 'Limite par défaut', value: `${previous.globalLimit} → **${value}**` },
      ]),
      { ephemeral: true },
    );
    await logs.command(guild.id, interaction, `limite par défaut : ${previous.globalLimit} → ${value}.`);
  },

  async add({ interaction, state, leash, logs, mover, guild }) {
    const target = interaction.options.getUser('user', true);
    const owner = interaction.options.getUser('user2', true);
    if (owner.bot) return ui.replyError(interaction, 'Un bot ne peut pas tenir de laisse.');
    const error = leash.checkAdd(state, { leasherId: owner.id, target, bypassLimit: true });
    if (error) return ui.replyError(interaction, error, 'Ajout impossible', E.leash);
    await leash.addLink(guild.id, target.id, owner.id, interaction.user.id);
    await ui.respond(interaction, success('Membre mis en laisse', `<@${target.id}> est maintenant en laisse de <@${owner.id}>.`), {
      ephemeral: true,
    });
    await logs.command(guild.id, interaction, `<@${target.id}> ajouté à la laisse de <@${owner.id}>.`);
    await mover.syncPair(guild, target.id, owner.id);
  },

  async remove({ interaction, leash, logs, guild }) {
    const target = interaction.options.getUser('user', true);
    const link = await leash.removeLink(guild.id, target.id);
    if (!link) return ui.replyError(interaction, `<@${target.id}> n’est dans aucune laisse.`, 'Retrait impossible', E.leash);
    await ui.respond(interaction, success('Membre libéré', `<@${target.id}> a été retiré de la laisse de <@${link.leasherId}>.`), {
      ephemeral: true,
    });
    await logs.command(guild.id, interaction, `<@${target.id}> retiré de la laisse de <@${link.leasherId}>.`);
  },

  async immune({ interaction, state, leash, logs, mover, guild }) {
    const target = interaction.options.getUser('user') ?? interaction.user;
    const value = interaction.options.getBoolean('etat', true);
    const before = leash.member(state, target.id).immune;
    await leash.updateMember(guild.id, target.id, { immune: value, immuneBy: interaction.user.id, immuneAt: new Date() });
    await ui.respond(
      interaction,
      success(
        'Immunité mise à jour',
        value
          ? `<@${target.id}> reste dans les listes mais n’est plus déplacé automatiquement.`
          : `<@${target.id}> est de nouveau déplacé automatiquement s’il est en laisse.`,
        [{ name: 'Immunité', value: `${onOff(before)} → **${onOff(value)}**` }],
      ),
      { ephemeral: true },
    );
    await logs.command(guild.id, interaction, `immunité de <@${target.id}> : ${onOff(value)}.`);
    const link = state.links.get(target.id);
    if (!value && link) await mover.syncPair(guild, target.id, link.leasherId);
  },

  async godmode({ interaction, state, leash, logs, guild }) {
    const target = interaction.options.getUser('user') ?? interaction.user;
    const value = interaction.options.getBoolean('etat', true);
    const before = leash.member(state, target.id).godmode;
    await leash.updateMember(guild.id, target.id, { godmode: value, godmodeBy: interaction.user.id, godmodeAt: new Date() });
    const link = value ? await leash.removeLink(guild.id, target.id) : null;
    const note = link ? ` Retiré de la laisse de <@${link.leasherId}>.` : '';
    await ui.respond(
      interaction,
      success(
        'God mode mis à jour',
        `${value ? `<@${target.id}> ne peut plus être mis en laisse.` : `<@${target.id}> peut de nouveau être mis en laisse.`}${note}`,
        [{ name: 'God mode', value: `${onOff(before)} → **${onOff(value)}**` }],
      ),
      { ephemeral: true },
    );
    await logs.command(guild.id, interaction, `god mode de <@${target.id}> : ${onOff(value)}.${note}`);
  },

  async log({ interaction, leash, logs, guild }) {
    const channel = interaction.options.getChannel('salon', true);
    const me = guild.members.me;
    if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      return ui.replyError(interaction, `Le bot ne peut pas écrire dans <#${channel.id}>.`, 'Salon inaccessible', E.leash);
    }
    await leash.updateSettings(guild.id, { logChannelId: channel.id });
    await ui.respond(interaction, success('Journal configuré', `Les déplacements et commandes du module seront journalisés dans <#${channel.id}>.`), {
      ephemeral: true,
    });
    await logs.command(guild.id, interaction, `salon de journal : <#${channel.id}>.`);
  },

  async set({ interaction, state, leash, logs, guild }) {
    const target = interaction.options.getUser('user', true);
    if (target.bot) return ui.replyError(interaction, 'Un bot ne peut pas être admin du module.');
    const value = !leash.member(state, target.id).admin;
    await leash.updateMember(guild.id, target.id, { admin: value, adminBy: interaction.user.id, adminAt: new Date() });
    const text = value ? `<@${target.id}> est maintenant admin du module laisse.` : `<@${target.id}> n’est plus admin du module laisse.`;
    await ui.respond(interaction, success('Admins du module', text), { ephemeral: true });
    await logs.command(guild.id, interaction, text);
  },

  async clear({ interaction, leash, logs, guild }) {
    const target = interaction.options.getUser('user', true);
    const released = await leash.clearList(guild.id, target.id);
    if (!released.length) {
      return ui.respond(interaction, ui.card({ description: `${E.leash} La laisse de <@${target.id}> était déjà vide.` }), {
        ephemeral: true,
      });
    }
    await ui.respond(interaction, success('Laisse vidée', `Laisse de <@${target.id}> vidée : ${mentions(released)}.`), { ephemeral: true });
    await logs.command(guild.id, interaction, `laisse de <@${target.id}> vidée (${mentions(released)}).`);
  },

  async list(args) {
    const target = args.interaction.options.getUser('user', true);
    await sendList(args.interaction, args, target.id, `Voici la liste des membres en laisse de ${target.username}.`);
  },

  async 'clear-all'({ interaction, leash, logs, guild }) {
    const confirmed = await ui.confirm(interaction, {
      prompt: ui.card({
        title: 'Vider toutes les laisses ?',
        description: `${E.warning} Tous les membres en laisse sur ce serveur seront **libérés**.`,
      }),
      confirmLabel: 'Tout vider',
    });
    if (!confirmed) return ui.respond(interaction, ui.card({ description: `${E.error} Opération annulée : aucune laisse n’a été modifiée.` }));
    const count = await leash.clearAll(guild.id);
    await ui.respond(interaction, success('Toutes les laisses vidées', `${count} membre(s) libéré(s).`));
    await logs.command(guild.id, interaction, `toutes les laisses ont été vidées (${count} membre(s) libéré(s)).`);
  },

  'view-allowed': (args) => flagView(args, 'allowed', 'Voici la liste des membres autorisés.', E.allowed),
  'view-immune': (args) => flagView(args, 'immune', 'Voici la liste des membres immunisés.', '🛡️'),
  'view-godmode': (args) => flagView(args, 'godmode', 'Voici la liste des membres en god mode.', '✨'),

  async isdog({ interaction, state, leash }) {
    const target = interaction.options.getUser('user', true);
    const link = state.links.get(target.id);
    const immune = leash.member(state, target.id).immune;
    const card = link
      ? ui.card({
          title: 'Ce membre est en laisse.',
          body: [
            {
              item: {
                emoji: E.dog,
                title: target.username,
                lines: [
                  `${E.clock} En laisse depuis le ${ui.dateTime(link.createdAt)}`,
                  `${E.user} <@${target.id}> · maître : <@${link.leasherId}>`,
                  voiceLine(interaction.guild, target.id),
                  immune ? '🛡️ Immunisé : n’est pas déplacé' : null,
                ],
                details: [
                  `Maître: ${ui.userLabel(interaction.client, link.leasherId)}`,
                  `Ajouté par: ${link.addedBy ? ui.userLabel(interaction.client, link.addedBy) : '—'}`,
                ],
              },
            },
          ],
        })
      : ui.card({ description: `${E.dog} <@${target.id}> n’est dans **aucune** laisse.` });
    await ui.respond(interaction, card, { ephemeral: true });
  },

  async 'leash-leasher'({ interaction, leash, logs, guild }) {
    const value = interaction.options.getBoolean('etat', true);
    const { previous } = await leash.updateSettings(guild.id, { leashLeashers: value });
    const removed = value ? [] : await leash.removeLeashers(guild.id);
    const note = removed.length ? ` Retiré(s) des laisses : ${mentions(removed.map((link) => link.leashedId))}.` : '';
    await ui.respond(
      interaction,
      success(
        'Leash-leasher mis à jour',
        `${value ? 'Les membres pouvant mettre en laisse peuvent eux-mêmes être mis en laisse.' : 'Les membres pouvant mettre en laisse ne peuvent plus être mis en laisse.'}${note}`,
        [{ name: 'Leash-leasher', value: `${onOff(previous.leashLeashers)} → **${onOff(value)}**` }],
      ),
      { ephemeral: true },
    );
    await logs.command(guild.id, interaction, `leash-leasher : ${onOff(value)}.${note}`);
  },
};

module.exports = {
  // Accès entièrement géré par isModuleAdmin (voir help.isAdmin ci-dessous), pas par le
  // système de permissions Discord : un admin du module peut ne pas être Administrateur du serveur.
  permission: { default: 'everyone' },

  // Pour /help : commande entièrement admin, visible seulement si isModuleAdmin est vrai.
  help: {
    async isAdmin(ctx, interaction) {
      if (!interaction.inGuild()) return false;
      const state = await ctx.services.leash.state(interaction.guildId);
      return isModuleAdmin(ctx, interaction, state);
    },
  },

  data: new SlashCommandBuilder()
    .setName('laisse-admin')
    .setDescription('Administration du module Laisse')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) => sub.setName('allow').setDescription('Autoriser un membre à utiliser le mode laisse').addUserOption(userOption('Membre à autoriser')))
    .addSubcommand((sub) => sub.setName('deny').setDescription('Interdire le mode laisse à un membre').addUserOption(userOption('Membre à interdire')))
    .addSubcommand((sub) =>
      sub
        .setName('limit')
        .setDescription('Nombre maximal de membres en laisse pour un utilisateur')
        .addUserOption(userOption('Utilisateur concerné'))
        .addIntegerOption(numberOption('Nombre maximal')),
    )
    .addSubcommand((sub) =>
      sub.setName('global-limit').setDescription('Limite par défaut des membres autorisés').addIntegerOption(numberOption('Nombre maximal')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Mettre un membre dans la laisse d’un autre')
        .addUserOption(userOption('Membre à mettre en laisse'))
        .addUserOption((option) => option.setName('user2').setDescription('Propriétaire de la laisse').setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName('remove').setDescription('Retirer un membre de la laisse où il se trouve').addUserOption(userOption('Membre à libérer')))
    .addSubcommand((sub) =>
      sub
        .setName('immune')
        .setDescription('Immuniser un membre : il reste en laisse mais n’est plus déplacé')
        .addBooleanOption(stateOption('Activer ou désactiver'))
        .addUserOption(userOption('Membre concerné (toi par défaut)', false)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('godmode')
        .setDescription('God mode : le membre ne peut plus être mis en laisse')
        .addBooleanOption(stateOption('Activer ou désactiver'))
        .addUserOption(userOption('Membre concerné (toi par défaut)', false)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('log')
        .setDescription('Salon de journal du module')
        .addChannelOption((option) =>
          option
            .setName('salon')
            .setDescription('Salon textuel de journal')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((sub) => sub.setName('set').setDescription('Ajouter ou retirer un admin du module').addUserOption(userOption('Membre concerné')))
    .addSubcommand((sub) => sub.setName('clear').setDescription('Vider la laisse d’un membre').addUserOption(userOption('Propriétaire de la laisse')))
    .addSubcommand((sub) => sub.setName('list').setDescription('Afficher la laisse d’un membre').addUserOption(userOption('Propriétaire de la laisse')))
    .addSubcommand((sub) => sub.setName('clear-all').setDescription('Vider toutes les laisses du serveur'))
    .addSubcommand((sub) => sub.setName('view-allowed').setDescription('Membres autorisés à utiliser le mode laisse'))
    .addSubcommand((sub) => sub.setName('view-immune').setDescription('Membres immunisés'))
    .addSubcommand((sub) => sub.setName('view-godmode').setDescription('Membres en god mode'))
    .addSubcommand((sub) => sub.setName('isdog').setDescription('Savoir si un membre est en laisse').addUserOption(userOption('Membre concerné')))
    .addSubcommand((sub) =>
      sub
        .setName('leash-leasher')
        .setDescription('Autoriser à mettre en laisse ceux qui peuvent eux-mêmes mettre en laisse')
        .addBooleanOption(stateOption('Activer ou désactiver')),
    ),

  async execute(ctx, interaction) {
    const { leash, logs, mover } = ctx.services;
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const sub = interaction.options.getSubcommand();
    const state = await leash.state(guild.id);

    if (!isModuleAdmin(ctx, interaction, state)) {
      return ui.replyError(interaction, 'Réservé aux admins du module laisse.', 'Accès refusé', E.leash);
    }

    const handler = handlers[sub];
    if (!handler) return ui.replyError(interaction, 'Sous-commande inconnue.');
    return handler({ ctx, interaction, state, guild, leash, logs, mover });
  },
};
