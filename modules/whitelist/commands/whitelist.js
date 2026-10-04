'use strict';

const {
  SlashCommandBuilder,
  InteractionContextType,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UserSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const ui = require('../../../src/bot/ui');
const { isModuleAdmin } = require('../lib/access');
const { parseDuration, formatDuration } = require('../../../src/core/duration');
const { isTime, isTimezone } = require('../../../src/core/schedule');

const EMOJI = '🚪';
const PANEL_TIMEOUT_MS = 10 * 60_000;
const MAX_INVITE_SECONDS = 30 * 86_400;

function channelOption(option) {
  return option
    .setName('salon')
    .setDescription('Salon vocal')
    .setRequired(true)
    .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice);
}

function limitModal(current) {
  const input = new TextInputBuilder()
    .setCustomId('limit')
    .setLabel('Limite de places (vide = aucune)') // 45 caractères max côté Discord
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder('ex. 5')
    .setMaxLength(4);
  if (current !== null) input.setValue(String(current));
  return new ModalBuilder().setCustomId('wl:limit-modal').setTitle('Limite de places').addComponents(new ActionRowBuilder().addComponents(input));
}

function cloneConfig(config) {
  return { enabled: config.enabled, slotLimit: config.slotLimit, users: new Set(config.users), roles: new Set(config.roles) };
}

function setsEqual(a, b) {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

function hasPendingChanges(saved, draft) {
  return saved.enabled !== draft.enabled || saved.slotLimit !== draft.slotLimit || !setsEqual(saved.users, draft.users) || !setsEqual(saved.roles, draft.roles);
}

/** Résume les changements entre l'état enregistré et le brouillon, pour un seul log groupé. */
function describeChanges(saved, draft) {
  const parts = [];
  if (saved.enabled !== draft.enabled) parts.push(`whitelist ${draft.enabled ? 'activée' : 'désactivée'}`);
  if (saved.slotLimit !== draft.slotLimit) parts.push(`limite : ${saved.slotLimit ?? 'aucune'} → ${draft.slotLimit ?? 'aucune'}`);
  const addedUsers = [...draft.users].filter((id) => !saved.users.has(id));
  const removedUsers = [...saved.users].filter((id) => !draft.users.has(id));
  if (addedUsers.length) parts.push(`membres ajoutés : ${addedUsers.map((id) => `<@${id}>`).join(', ')}`);
  if (removedUsers.length) parts.push(`membres retirés : ${removedUsers.map((id) => `<@${id}>`).join(', ')}`);
  const addedRoles = [...draft.roles].filter((id) => !saved.roles.has(id));
  const removedRoles = [...saved.roles].filter((id) => !draft.roles.has(id));
  if (addedRoles.length) parts.push(`rôles ajoutés : ${addedRoles.map((id) => `<@&${id}>`).join(', ')}`);
  if (removedRoles.length) parts.push(`rôles retirés : ${removedRoles.map((id) => `<@&${id}>`).join(', ')}`);
  return parts;
}

// ── /whitelist channel : embed interactif propre au salon ──────────────────────

async function channelCommand(ctx, interaction) {
  const { whitelist, logs } = ctx.services;
  const guild = interaction.guild;
  const channel = interaction.options.getChannel('salon', true);

  // « saved » = dernier état enregistré en base ; « draft » = modifications en cours, non
  // appliquées tant que l'utilisateur n'a pas cliqué sur Sauvegarder (un seul log groupé à la fin).
  let saved = cloneConfig(whitelist.channelConfig(await whitelist.state(guild.id), channel.id));
  let draft = cloneConfig(saved);
  let confirmingReset = false;
  let notice = null;

  function render() {
    const pending = hasPendingChanges(saved, draft);
    const userList = [...draft.users].map((id) => `<@${id}>`).join(', ') || '—';
    const roleList = [...draft.roles].map((id) => `<@&${id}>`).join(', ') || '—';

    const actionRow = confirmingReset
      ? new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('wl:reset-confirm').setLabel('⚠️ Confirmer la réinitialisation').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('wl:reset-cancel').setLabel('Annuler').setStyle(ButtonStyle.Secondary),
        )
      : new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('wl:toggle')
            .setLabel(draft.enabled ? 'Désactiver la whitelist' : 'Activer la whitelist')
            .setStyle(draft.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
          new ButtonBuilder().setCustomId('wl:limit').setLabel('Définir la limite').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('wl:reset').setLabel('Réinitialiser ce salon').setStyle(ButtonStyle.Secondary),
        );

    const usersSelect = new UserSelectMenuBuilder()
      .setCustomId('wl:users')
      .setPlaceholder('Membres whitelistés (remplace la liste actuelle)')
      .setMinValues(0)
      .setMaxValues(25);
    const defaultUsers = [...draft.users].slice(0, 25);
    if (defaultUsers.length) usersSelect.setDefaultUsers(...defaultUsers);

    const rolesSelect = new RoleSelectMenuBuilder()
      .setCustomId('wl:roles')
      .setPlaceholder('Rôles whitelistés (remplace la liste actuelle)')
      .setMinValues(0)
      .setMaxValues(25);
    const defaultRoles = [...draft.roles].slice(0, 25);
    if (defaultRoles.length) rolesSelect.setDefaultRoles(...defaultRoles);

    const saveRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('wl:save').setLabel('💾 Sauvegarder').setStyle(ButtonStyle.Primary).setDisabled(!pending),
      new ButtonBuilder().setCustomId('wl:discard').setLabel('↩️ Annuler les modifications').setStyle(ButtonStyle.Secondary).setDisabled(!pending),
    );

    return ui.card({
      title: `Configuration de #${channel.name}`,
      body: [
        {
          stats: [
            ['Whitelist', draft.enabled ? 'Activée' : 'Désactivée'],
            ['Limite de places', draft.slotLimit ?? 'Aucune'],
            ['Présents', channel.members.size],
          ],
        },
        '✅ Peut rejoindre : un membre **de la liste** *ou* ayant **l’un des rôles** ci-dessous — les deux se combinent, ce n’est jamais l’un ou l’autre.',
        { item: { emoji: '👤', title: 'Membres whitelistés (accès individuel)', lines: [userList] } },
        { item: { emoji: '🏷️', title: 'Rôles whitelistés (accès en plus des membres)', lines: [roleList] } },
        actionRow,
        new ActionRowBuilder().addComponents(usersSelect),
        new ActionRowBuilder().addComponents(rolesSelect),
        saveRow,
        pending ? '\n⚠️ Modifications non enregistrées — clique sur 💾 Sauvegarder pour les appliquer.' : null,
        notice ? `\n${notice}` : null,
      ],
      footer:
        'Les deux listes remplacent la sélection précédente au clic (25 max chacune — au-delà, utilise le panel web) ; ' +
        'elles s’additionnent, un membre dans l’une ou l’autre peut rejoindre. ' +
        'Rien n’est appliqué avant Sauvegarder, qui écrit un seul log groupé. ' +
        'Les admins du module et les membres déplacés par le système de laisse sont toujours exemptés.',
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const message = await ui.respond(interaction, render());

  // La limite ouvre une fenêtre (modal) : elle acquitte l'interaction elle-même (submitted.update),
  // jamais via le component.update() partagé ci-dessous (on ne peut acquitter un clic qu'une fois).
  // Comme les autres contrôles, elle ne touche que le brouillon — Sauvegarder applique tout.
  async function handleLimitClick(component) {
    try {
      await component.showModal(limitModal(draft.slotLimit));
    } catch (err) {
      ctx.logger.error('Ouverture du formulaire de limite impossible', err);
      notice = `${ui.EMOJIS.error} Impossible d’ouvrir le formulaire : ${err.message}`;
      return component.update(ui.message(render())).catch(() => {});
    }
    let submitted;
    try {
      submitted = await component.awaitModalSubmit({
        time: 120_000,
        filter: (i) => i.customId === 'wl:limit-modal' && i.user.id === interaction.user.id,
      });
    } catch {
      return; // délai dépassé : le panel reste tel quel
    }
    const raw = submitted.fields.getTextInputValue('limit').trim();
    if (raw) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 500) {
        await ui.replyError(submitted, 'Limite invalide : indique un nombre entier de 0 à 500, ou laisse vide pour aucune limite.');
        return;
      }
      draft.slotLimit = n;
    } else {
      draft.slotLimit = null;
    }
    notice = null;
    await submitted.update(ui.message(render())).catch(() => {});
  }

  /** Applique le brouillon en base en un seul appel par champ modifié, puis écrit un log groupé. */
  async function save() {
    const changes = describeChanges(saved, draft);
    if (!changes.length) {
      notice = 'Aucune modification à enregistrer.';
      return;
    }
    if (saved.enabled !== draft.enabled) await whitelist.setEnabled(guild.id, channel.id, draft.enabled, interaction.user.id);
    if (saved.slotLimit !== draft.slotLimit) await whitelist.setSlotLimit(guild.id, channel.id, draft.slotLimit, interaction.user.id);
    if (!setsEqual(saved.users, draft.users)) await whitelist.replaceUsers(guild.id, channel.id, [...draft.users], interaction.user.id);
    if (!setsEqual(saved.roles, draft.roles)) await whitelist.replaceRoles(guild.id, channel.id, [...draft.roles], interaction.user.id);
    await logs.command(guild.id, interaction, `<#${channel.id}> — ${changes.join(' · ')}.`);
    saved = cloneConfig(draft);
    notice = `${ui.EMOJIS.success} Modifications enregistrées.`;
  }

  const collector = message.createMessageComponentCollector({ time: PANEL_TIMEOUT_MS });
  collector.on('collect', async (component) => {
    if (component.user.id !== interaction.user.id) return ui.rejectForeignClick(component);
    if (component.customId === 'wl:limit') return handleLimitClick(component);

    notice = null;
    try {
      if (component.customId === 'wl:toggle') {
        draft.enabled = !draft.enabled;
      } else if (component.customId === 'wl:reset') {
        confirmingReset = true;
      } else if (component.customId === 'wl:reset-cancel') {
        confirmingReset = false;
      } else if (component.customId === 'wl:reset-confirm') {
        await whitelist.resetChannel(guild.id, channel.id);
        await logs.command(guild.id, interaction, `configuration de <#${channel.id}> réinitialisée.`);
        confirmingReset = false;
        saved = cloneConfig({ enabled: false, slotLimit: null, users: new Set(), roles: new Set() });
        draft = cloneConfig(saved);
      } else if (component.customId === 'wl:users') {
        draft.users = new Set(component.values);
      } else if (component.customId === 'wl:roles') {
        draft.roles = new Set(component.values);
      } else if (component.customId === 'wl:save') {
        await save();
      } else if (component.customId === 'wl:discard') {
        draft = cloneConfig(saved);
      }
    } catch (err) {
      ctx.logger.error('Action /whitelist channel impossible', err);
      notice = `${ui.EMOJIS.error} Action impossible : ${err.message}`;
    }
    return component.update(ui.message(render())).catch(() => {});
  });
  collector.on('end', () => {
    interaction.editReply({ components: [] }).catch(() => {});
  });
}

// ── /whitelist list ──────────────────────────────────────────────────────────

async function listCommand(ctx, interaction) {
  const { whitelist } = ctx.services;
  const guild = interaction.guild;
  const state = await whitelist.state(guild.id);
  const channels = whitelist
    .configuredChannels(state)
    .sort((a, b) => (guild.channels.cache.get(a.channelId)?.name ?? '').localeCompare(guild.channels.cache.get(b.channelId)?.name ?? ''));

  const pages = ui.paginateLines(channels, {
    perPage: 5,
    build: (chunk, offset) =>
      ui.card({
        title: `Voici la liste des salons configurés. (${channels.length})`,
        body: [
          { stats: [['Total', channels.length]] },
          ...chunk.map((c, i) => {
            const channel = guild.channels.cache.get(c.channelId);
            return {
              item: {
                emoji: EMOJI,
                title: channel ? `#${channel.name}` : `Salon n°${offset + i + 1}`,
                lines: [
                  c.enabled ? '🔒 Whitelist activée' : '🔓 Whitelist désactivée',
                  `🎚️ Limite : ${c.slotLimit ?? 'aucune'}${channel ? ` ( actuellement \`${channel.members.size}\` )` : ''}`,
                  c.schedule.scheduleEnabled ? `🕒 Active de ${c.schedule.scheduleStart} à ${c.schedule.scheduleEnd} (${c.schedule.scheduleTimezone})` : null,
                  c.admins.size ? `🛡️ Admins du salon : ${[...c.admins].map((id) => `<@${id}>`).join(', ')}` : null,
                ],
                details: [`Membres whitelistés: ${c.users.size}`, `Accès temporaires: ${c.temp.size}`, `Rôles whitelistés: ${c.roles.size}`],
              },
            };
          }),
          chunk.length ? null : '\nAucun salon configuré pour le moment.',
        ],
      }),
  });
  await ui.sendPaginated(interaction, pages, { ephemeral: true });
}

// ── /whitelist log ───────────────────────────────────────────────────────────

async function logCommand(ctx, interaction) {
  const { whitelist, logs } = ctx.services;
  const guild = interaction.guild;
  const channel = interaction.options.getChannel('salon', true);
  const me = guild.members.me;
  if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    return ui.replyError(interaction, `Le bot ne peut pas écrire dans <#${channel.id}>.`, 'Salon inaccessible', EMOJI);
  }
  await whitelist.setLogChannel(guild.id, channel.id, interaction.user.id);
  await ui.respond(
    interaction,
    ui.successCard('Journal configuré', `Les expulsions et commandes du module seront journalisées dans <#${channel.id}>.`, EMOJI),
    { ephemeral: true },
  );
  await logs.command(guild.id, interaction, `salon de journal : <#${channel.id}>.`);
}

// ── /whitelist admin set / list ──────────────────────────────────────────────

async function adminSet(ctx, interaction) {
  const { whitelist, logs } = ctx.services;
  const guild = interaction.guild;
  const target = interaction.options.getUser('user', true);
  if (target.bot) return ui.replyError(interaction, 'Un bot ne peut pas être admin du module.');
  const state = await whitelist.state(guild.id);
  const wasAdmin = state.admins.has(target.id);
  if (wasAdmin) await whitelist.removeAdmin(guild.id, target.id);
  else await whitelist.addAdmin(guild.id, target.id, interaction.user.id);
  const text = wasAdmin ? `<@${target.id}> n’est plus admin du module.` : `<@${target.id}> est maintenant admin du module.`;
  await ui.respond(interaction, ui.successCard('Admins du module', text, EMOJI), { ephemeral: true });
  await logs.command(guild.id, interaction, text);
}

async function adminList(ctx, interaction) {
  const { whitelist } = ctx.services;
  const guild = interaction.guild;
  const admins = await whitelist.listAdmins(guild.id);
  const client = interaction.client;
  const pages = ui.paginateLines(admins, {
    perPage: 10,
    build: (chunk, offset) =>
      ui.card({
        title: `Voici la liste des admins du module. (${admins.length})`,
        body: [
          { stats: [['Total', admins.length]] },
          ...chunk.map((a, i) => ({
            item: {
              emoji: EMOJI,
              title: `Admin n°${offset + i + 1}`,
              lines: [`👤 <@${a.userId}>`],
              details: [`Membre: ${ui.userLabel(client, a.userId)}`, `Ajouté par: ${a.addedBy ? ui.userLabel(client, a.addedBy) : '—'}`, `Le: ${ui.dateTime(a.addedAt)}`],
            },
          })),
          chunk.length ? null : '\nAucun admin de module (les administrateurs du serveur et propriétaires du bot le sont déjà).',
        ],
      }),
  });
  await ui.sendPaginated(interaction, pages, { ephemeral: true });
}

// ── /whitelist invite / uninvite : accès temporaires ─────────────────────────

async function inviteCommand(ctx, interaction) {
  const { whitelist, logs } = ctx.services;
  const guild = interaction.guild;
  const channel = interaction.options.getChannel('salon', true);
  const target = interaction.options.getUser('user', true);
  if (target.bot) return ui.replyError(interaction, 'Un bot n’a pas besoin d’accès : les bots sont toujours exemptés.');
  const seconds = parseDuration(interaction.options.getString('duree', true));
  if (!seconds || seconds > MAX_INVITE_SECONDS) return ui.replyError(interaction, 'Durée invalide : par exemple `30m`, `2h` ou `3j` (30 jours maximum).', 'Durée invalide', '⏳');
  const expiresAt = new Date(Date.now() + seconds * 1000);
  const result = await whitelist.inviteUser(guild.id, channel.id, target.id, expiresAt, interaction.user.id);
  if (result === 'permanent') {
    return ui.respond(interaction, ui.successCard('Déjà autorisé', `<@${target.id}> est déjà whitelisté en permanence sur <#${channel.id}> : rien à changer.`, EMOJI), { ephemeral: true });
  }
  const text = `<@${target.id}> peut rejoindre <#${channel.id}> pendant **${formatDuration(seconds)}** (jusqu’à ${ui.ts(expiresAt, 'f')}).`;
  await ui.respond(interaction, ui.successCard(result === 'extended' ? 'Accès prolongé' : 'Accès temporaire accordé', text, '⏳'), { ephemeral: true });
  await logs.command(guild.id, interaction, text);
}

async function uninviteCommand(ctx, interaction) {
  const { whitelist, logs, enforcer } = ctx.services;
  const guild = interaction.guild;
  const channel = interaction.options.getChannel('salon', true);
  const target = interaction.options.getUser('user', true);
  const removed = await whitelist.uninviteUser(guild.id, channel.id, target.id);
  if (!removed) return ui.replyError(interaction, `<@${target.id}> n’a pas d’accès temporaire à <#${channel.id}>.`, 'Rien à retirer', '⏳');
  const text = `accès temporaire de <@${target.id}> à <#${channel.id}> retiré.`;
  await ui.respond(interaction, ui.successCard('Accès retiré', `L’${text}`, '⏳'), { ephemeral: true });
  await logs.command(guild.id, interaction, text);
  await enforcer.enforceChannel(guild, channel.id);
}

// ── /whitelist horaire : plage d'application des restrictions ────────────────

async function scheduleCommand(ctx, interaction) {
  const { whitelist, logs, enforcer } = ctx.services;
  const guild = interaction.guild;
  const channel = interaction.options.getChannel('salon', true);
  const start = interaction.options.getString('debut');
  const end = interaction.options.getString('fin');
  const timezone = interaction.options.getString('fuseau') ?? 'Europe/Paris';

  if (!start && !end) {
    await whitelist.setSchedule(guild.id, channel.id, { enabled: false }, interaction.user.id);
    const text = `plage horaire de <#${channel.id}> retirée : restrictions appliquées en permanence.`;
    await ui.respond(interaction, ui.successCard('Plage horaire retirée', `Les restrictions de <#${channel.id}> s’appliquent de nouveau en permanence.`, '🕒'), { ephemeral: true });
    await logs.command(guild.id, interaction, text);
    await enforcer.enforceChannel(guild, channel.id);
    return;
  }
  if (!isTime(start) || !isTime(end)) return ui.replyError(interaction, 'Heures invalides : indique `debut` et `fin` au format HH:MM (ex. 20:00 et 02:00).', 'Plage invalide', '🕒');
  if (!isTimezone(timezone)) return ui.replyError(interaction, `Fuseau horaire inconnu : \`${timezone}\` (ex. Europe/Paris).`, 'Plage invalide', '🕒');
  await whitelist.setSchedule(guild.id, channel.id, { enabled: true, start, end, timezone }, interaction.user.id);
  const text = `restrictions de <#${channel.id}> actives de **${start}** à **${end}** (${timezone}).`;
  await ui.respond(
    interaction,
    ui.successCard('Plage horaire définie', `Les restrictions (whitelist et limite) de <#${channel.id}> ne s’appliquent que de **${start}** à **${end}** (${timezone}) ; en dehors, le salon est ouvert. Au début de la plage, les membres présents sont revérifiés.`, '🕒'),
    { ephemeral: true },
  );
  await logs.command(guild.id, interaction, text);
  await enforcer.enforceChannel(guild, channel.id);
}

// ── /whitelist admin salon : admins d'un salon précis ────────────────────────

async function channelAdminCommand(ctx, interaction) {
  const { whitelist, logs } = ctx.services;
  const guild = interaction.guild;
  const channel = interaction.options.getChannel('salon', true);
  const target = interaction.options.getUser('user', true);
  if (target.bot) return ui.replyError(interaction, 'Un bot ne peut pas être admin d’un salon.');
  const config = whitelist.channelConfig(await whitelist.state(guild.id), channel.id);
  const wasAdmin = config.admins.has(target.id);
  if (wasAdmin) await whitelist.removeChannelAdmin(guild.id, channel.id, target.id);
  else await whitelist.addChannelAdmin(guild.id, channel.id, target.id, interaction.user.id);
  const text = wasAdmin
    ? `<@${target.id}> n’est plus admin de <#${channel.id}>.`
    : `<@${target.id}> est maintenant admin de <#${channel.id}> : il peut y entrer librement et y donner des accès temporaires (/whitelist invite).`;
  await ui.respond(interaction, ui.successCard('Admins du salon', text, EMOJI), { ephemeral: true });
  await logs.command(guild.id, interaction, text);
}

// ── Définition de la commande ─────────────────────────────────────────────────

module.exports = {
  // Accès entièrement géré par isModuleAdmin (voir help.isAdmin), pas par le système /permission.
  permission: { default: 'everyone' },

  help: {
    async isAdmin(ctx, interaction) {
      if (!interaction.inGuild()) return false;
      const state = await ctx.services.whitelist.state(interaction.guildId);
      // Les admins d'un salon voient aussi la commande (pour /whitelist invite).
      return isModuleAdmin(ctx, interaction.member, state) || [...state.channels.values()].some((config) => config.admins.has(interaction.user.id));
    },
  },

  data: new SlashCommandBuilder()
    .setName('whitelist')
    .setDescription('Configurer la whitelist et la limite de places des salons vocaux')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) => sub.setName('channel').setDescription('Ouvrir la configuration interactive d’un salon vocal').addChannelOption(channelOption))
    .addSubcommand((sub) => sub.setName('list').setDescription('Lister les salons configurés'))
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
    .addSubcommand((sub) =>
      sub
        .setName('invite')
        .setDescription('Donner un accès temporaire à un salon (admins du module ou du salon)')
        .addChannelOption(channelOption)
        .addUserOption((option) => option.setName('user').setDescription('Membre invité').setRequired(true))
        .addStringOption((option) => option.setName('duree').setDescription('Durée : 30m, 2h, 3j… (30 jours max)').setRequired(true).setMaxLength(20)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('uninvite')
        .setDescription('Retirer un accès temporaire avant son échéance')
        .addChannelOption(channelOption)
        .addUserOption((option) => option.setName('user').setDescription('Membre concerné').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('horaire')
        .setDescription('Restrictions actives seulement sur une plage horaire (vide = en permanence)')
        .addChannelOption(channelOption)
        .addStringOption((option) => option.setName('debut').setDescription('Début, au format HH:MM (ex. 20:00)').setMaxLength(5))
        .addStringOption((option) => option.setName('fin').setDescription('Fin, au format HH:MM (ex. 02:00)').setMaxLength(5))
        .addStringOption((option) => option.setName('fuseau').setDescription('Fuseau horaire (défaut : Europe/Paris)').setMaxLength(64)),
    )
    .addSubcommandGroup((group) =>
      group
        .setName('admin')
        .setDescription('Administration du module')
        .addSubcommand((sub) => sub.setName('set').setDescription('Ajouter ou retirer un admin du module').addUserOption((option) => option.setName('user').setDescription('Membre concerné').setRequired(true)))
        .addSubcommand((sub) => sub.setName('list').setDescription('Lister les admins du module'))
        .addSubcommand((sub) =>
          sub
            .setName('salon')
            .setDescription('Ajouter ou retirer un admin limité à un salon')
            .addChannelOption(channelOption)
            .addUserOption((option) => option.setName('user').setDescription('Membre concerné').setRequired(true)),
        ),
    ),

  async execute(ctx, interaction) {
    const { whitelist } = ctx.services;
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');

    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();
    const state = await whitelist.state(guild.id);
    const moduleAdmin = isModuleAdmin(ctx, interaction.member, state);

    // Accès temporaires : aussi ouverts aux admins du salon visé.
    if (!group && (sub === 'invite' || sub === 'uninvite')) {
      const channel = interaction.options.getChannel('salon', true);
      if (!moduleAdmin && !whitelist.isChannelAdmin(whitelist.channelConfig(state, channel.id), interaction.user.id)) {
        return ui.replyError(interaction, `Réservé aux admins du module whitelist et aux admins de <#${channel.id}>.`, 'Accès refusé', EMOJI);
      }
      return sub === 'invite' ? inviteCommand(ctx, interaction) : uninviteCommand(ctx, interaction);
    }

    if (!moduleAdmin) {
      return ui.replyError(interaction, 'Réservé aux admins du module whitelist.', 'Accès refusé', EMOJI);
    }

    if (group === 'admin') {
      if (sub === 'set') return adminSet(ctx, interaction);
      if (sub === 'list') return adminList(ctx, interaction);
      if (sub === 'salon') return channelAdminCommand(ctx, interaction);
    }
    if (sub === 'horaire') return scheduleCommand(ctx, interaction);
    if (sub === 'channel') return channelCommand(ctx, interaction);
    if (sub === 'list') return listCommand(ctx, interaction);
    if (sub === 'log') return logCommand(ctx, interaction);
    return ui.replyError(interaction, 'Sous-commande inconnue.');
  },
};
