'use strict';

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const { createScope } = require('../lib/queries');
const ui = require('../../../src/bot/ui');

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_LABELS = { 1: '24 dernières heures', 7: '7 derniers jours', 30: '30 derniers jours', 90: '90 derniers jours' };
const LEADERBOARD_SIZE = 50;
const PAGE_SIZE = 10;

const numberFmt = new Intl.NumberFormat('fr-FR');
const n = (value) => (value === null || value === undefined ? '—' : numberFmt.format(value));

function duration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (hours >= 48) return `${n(Math.floor(hours / 24))} j ${hours % 24} h`;
  if (hours) return `${hours} h ${String(minutes).padStart(2, '0')} min`;
  return `${minutes} min`;
}

function days(value) {
  if (value === null || value === undefined) return '—';
  if (value < 60) return `${Math.round(value)} j`;
  if (value < 730) return `${Math.floor(value / 30.44)} mois`;
  return `${(value / 365.25).toFixed(1).replace('.', ',')} ans`;
}

const timestamp = (date, style = 'D') => (date ? `<t:${Math.floor(new Date(date).getTime() / 1000)}:${style}>` : '—');

function periodOption(option) {
  return option
    .setName('periode')
    .setDescription('Période analysée (7 jours par défaut)')
    .addChoices(
      { name: '24 heures', value: 1 },
      { name: '7 jours', value: 7 },
      { name: '30 jours', value: 30 },
      { name: '90 jours', value: 90 },
    );
}

function scopeFor(interaction) {
  const period = interaction.options.getInteger('periode') ?? 7;
  const to = new Date();
  const from = new Date(to.getTime() - period * DAY_MS);
  return { period, scope: createScope({ guildId: interaction.guildId, from, to, interval: 'day', offset: 0 }) };
}

function dashboardUrl(ctx, guildId, path = '') {
  try {
    const url = new URL(ctx.config.web.callbackUrl);
    const origin = ctx.config.web.trustProxy ? url.origin : `${url.protocol}//${url.hostname}:${ctx.config.web.port}`;
    return `${origin}/m/stats/${path}?guild=${guildId}`;
  } catch {
    return null;
  }
}

async function serverSummary(ctx, interaction) {
  const { queries } = ctx.services;
  const { period, scope } = scopeFor(interaction);
  const [totals, voice, current, channels] = await Promise.all([
    queries.periodTotals(scope),
    queries.voiceTotals(scope),
    queries.currentState(scope.guildId),
    queries.topChannels(scope, 3),
  ]);

  const link = ctx.config.web.enabled ? dashboardUrl(ctx, scope.guildId) : null;
  const card = ui.card({
    author: { name: interaction.guild.name, iconURL: interaction.guild.iconURL({ size: 64 }) ?? undefined },
    title: `Statistiques du serveur (${PERIOD_LABELS[period]})`,
    body: [
      {
        stats: [
          ['Messages', n(totals.messages)],
          ['Longueur moyenne', totals.avgLength ? `${n(Math.round(totals.avgLength))} caractères` : '—'],
          ['Membres actifs', `${n(totals.authors)} (écrit) · ${n(voice.users)} (vocal)`],
          ['Temps vocal', duration(voice.seconds)],
          ['Arrivées', `+${n(totals.joins)}`],
          ['Départs', `-${n(totals.leaves)}`],
          ['Supprimés', n(totals.deletions)],
          ['Sanctions', `${n(totals.bans)} ban · ${n(totals.kicks)} kick · ${n(totals.timeouts)} timeout`],
        ],
      },
      {
        item: {
          emoji: ui.EMOJIS.gear,
          title: 'État actuel',
          details: [
            `Membres: ${n(current.memberCount)}`,
            `Boosts: ${n(current.boosts)} (niveau ${current.premiumTier ?? 0}) · ${n(current.boosters)} booster(s)`,
            `Nitro (estimation): ${n(current.nitro)}`,
            `Ancienneté: moyenne ${days(current.seniority.avgDays)} · médiane ${days(current.seniority.medianDays)}`,
          ],
        },
      },
      {
        item: {
          emoji: '#',
          title: 'Salons les plus actifs',
          lines: channels.length
            ? channels.map((c, i) => `💬 **${i + 1}.** <#${c.channelId}> ( \`${n(c.messages)}\` )`)
            : ['Aucun message sur la période.'],
        },
      },
      link ? `\n🔗 [Ouvrir dans le dashboard](${link})` : null,
    ],
  });
  await ui.respond(interaction, card);
}

async function memberSummary(ctx, interaction) {
  const { queries } = ctx.services;
  const user = interaction.options.getUser('membre') ?? interaction.user;
  if (user.bot) {
    await ui.replyError(interaction, 'Les bots ne sont pas suivis par le module de statistiques.');
    return;
  }
  const { period, scope } = scopeFor(interaction);
  const profile = await queries.memberProfile(scope, user.id);
  if (!profile) {
    await ui.replyError(interaction, 'Aucune donnée pour ce membre.');
    return;
  }
  const p = profile.period;
  const nicknames = profile.names.filter((h) => h.type === 'nickname' && h.guildId === scope.guildId).length;
  const globals = profile.names.filter((h) => h.type !== 'nickname').length;

  const memberPage = ctx.config.web.enabled ? dashboardUrl(ctx, scope.guildId, 'membre') : null;

  const card = ui.card({
    author: { name: profile.identity.globalName ?? profile.identity.username ?? user.id, iconURL: profile.identity.avatar },
    title: `Statistiques du membre (${PERIOD_LABELS[period]})`,
    body: [
      {
        stats: [
          ['Messages', `${n(p.messages)}${p.rank ? ` (rang ${p.rank})` : ''}`],
          ['Longueur moyenne', p.avgLength ? `${n(Math.round(p.avgLength))} caractères` : '—'],
          ['Temps vocal', duration(p.voiceSeconds)],
          ['Supprimés', n(p.deletions)],
        ],
      },
      {
        item: {
          emoji: ui.EMOJIS.user,
          title: 'Profil',
          lines: [
            `${ui.EMOJIS.user} <@${user.id}>`,
            `${ui.EMOJIS.clock} Sur le serveur depuis le ${ui.dateTime(profile.membership?.joinedAt)}`,
            `💬 Dernier message ${timestamp(profile.allTime.lastMessageAt, 'R')}`,
          ],
          details: [
            `Utilisateur: ${profile.identity.username ?? '—'} (ID: ${user.id})`,
            `Pseudos: ${n(globals)} changement(s) global(aux) · ${n(nicknames)} surnom(s) ici`,
          ],
        },
      },
      {
        item: {
          emoji: '#',
          title: 'Salons favoris',
          lines: profile.channels.length
            ? profile.channels.slice(0, 3).map((c, i) => `💬 **${i + 1}.** <#${c.channelId}> ( \`${n(c.messages)}\` )`)
            : ['Aucun message sur la période.'],
        },
      },
      memberPage ? `\n🔗 [Fiche complète dans le dashboard](${memberPage}&id=${user.id})` : null,
    ],
  });
  await ui.respond(interaction, card);
}

async function leaderboard(ctx, interaction) {
  const { queries } = ctx.services;
  const type = interaction.options.getString('type') ?? 'messages';
  const { period, scope } = scopeFor(interaction);
  let lines;
  let title;

  if (type === 'salons') {
    title = 'Voici les salons les plus actifs du serveur';
    const rows = await queries.topChannels(scope, LEADERBOARD_SIZE);
    lines = rows.map((row, i) => `💬 **${i + 1}.** <#${row.channelId}> ( \`${n(row.messages)} messages\` )`);
  } else if (type === 'vocal') {
    title = 'Voici les membres les plus présents en vocal';
    const rows = await queries.topVoice(scope, LEADERBOARD_SIZE);
    lines = rows.map((row, i) => `${ui.EMOJIS.voice} **${i + 1}.** <@${row.userId}> ( \`${duration(row.seconds)}\` )`);
  } else {
    title = 'Voici les membres les plus actifs à l’écrit';
    const rows = await queries.topSenders(scope, LEADERBOARD_SIZE);
    lines = rows.map((row, i) => `💬 **${i + 1}.** <@${row.userId}> ( \`${n(row.messages)} messages\` )`);
  }

  const pages = ui.paginateLines(lines, {
    perPage: PAGE_SIZE,
    build: (chunk) =>
      ui.card({
        title: `${title}. (${lines.length})`,
        body: [
          { stats: [['Total', lines.length], ['Période', PERIOD_LABELS[period]]] },
          chunk.length ? chunk.join('\n') : 'Aucune donnée sur la période.',
        ],
      }),
  });
  await ui.sendPaginated(interaction, pages);
}

module.exports = {
  // Commande sensible (données de membres) : administrateurs par défaut, ouvrable via /permission.
  permission: { default: 'admin' },

  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Statistiques d’activité du serveur')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub.setName('serveur').setDescription('Résumé de l’activité du serveur').addIntegerOption(periodOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName('membre')
        .setDescription('Statistiques d’un membre')
        .addUserOption((option) => option.setName('membre').setDescription('Membre ciblé (vous par défaut)'))
        .addIntegerOption(periodOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName('top')
        .setDescription('Classements du serveur')
        .addStringOption((option) =>
          option
            .setName('type')
            .setDescription('Type de classement (messages par défaut)')
            .addChoices(
              { name: 'Messages', value: 'messages' },
              { name: 'Vocal', value: 'vocal' },
              { name: 'Salons', value: 'salons' },
            ),
        )
        .addIntegerOption(periodOption),
    ),

  async execute(ctx, interaction) {
    if (!interaction.inGuild()) {
      await ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
      return;
    }
    await interaction.deferReply();
    const sub = interaction.options.getSubcommand();
    if (sub === 'serveur') await serverSummary(ctx, interaction);
    else if (sub === 'membre') await memberSummary(ctx, interaction);
    else await leaderboard(ctx, interaction);
  },
};
