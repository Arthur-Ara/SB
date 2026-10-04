'use strict';

const { SlashCommandBuilder, InteractionContextType, MessageFlags } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { webUrl } = require('../../../src/web/url');
const { STATUSES, RECRUITER_STATUSES, isFinal, statusLabel, timeline } = require('../lib/statuses');
const { isAdmin, isRecruiter, isRecruiterAnywhere } = require('../lib/guard');
const { publishPanel, setStatus, finishCandidature, changeCategory, retryText, transcriptUrl } = require('../lib/lifecycle');

/** Candidature du salon courant (pas encore clôturée si `open`), avec sa catégorie. */
async function currentOf(ctx, interaction, { open = true } = {}) {
  const candidature = await ctx.services.candidatures.getByChannel(interaction.channelId);
  if (!candidature || Number(candidature.channel_deleted)) return { error: 'Cette commande s’utilise dans un salon de candidature.' };
  if (open && isFinal(candidature.status)) return { error: `Cette candidature est clôturée (${statusLabel(candidature.status)}).` };
  return { candidature, category: await ctx.services.candidatures.getCategory(candidature.category_id) };
}

/** Résumé d'une candidature : catégorie, statut, dates, motif, lien du salon. */
function summary(ctx, candidature, category, { withApplicant = false } = {}) {
  const lines = [`**#${candidature.id} — ${category?.label ?? 'Catégorie supprimée'}** · ${statusLabel(candidature.status)}`];
  if (withApplicant) lines.push(`👤 <@${candidature.applicant_id}>`);
  lines.push(`📅 Ouverte ${ui.ts(candidature.created_at, 'R')}${candidature.submitted_at ? ` · envoyée ${ui.ts(candidature.submitted_at, 'R')}` : ''}${candidature.closed_at ? ` · clôturée ${ui.ts(candidature.closed_at, 'R')}` : ''}`);
  if (candidature.status_reason && ['refused', 'accepted', 'withdrawn'].includes(candidature.status)) lines.push(`📝 ${candidature.status_reason.replace(/\n/g, '\n> ')}`);
  if (candidature.status_by) lines.push(`🛠️ Décidé par <@${candidature.status_by}>`);
  else if (isFinal(candidature.status) && candidature.status !== 'withdrawn') lines.push('🤖 Décision automatique');
  if (!isFinal(candidature.status) && !Number(candidature.channel_deleted)) lines.push(`📍 <#${candidature.channel_id}>`);
  const url = transcriptUrl(ctx, candidature);
  if (url && isFinal(candidature.status)) lines.push(`📄 [Transcription](${url})`);
  return lines.join('\n');
}

async function ownStatus(ctx, interaction) {
  const { candidatures } = ctx.services;
  const rows = await candidatures.listByApplicant(interaction.guildId, interaction.user.id, { limit: 10 });
  if (!rows.length) return ui.replyError(interaction, 'Tu n’as déposé aucune candidature sur ce serveur.', 'Aucune candidature', '📨');
  const categories = new Map((await candidatures.listCategories(interaction.guildId)).map((c) => [String(c.id), c]));
  const blocks = rows.map((candidature) => {
    const category = categories.get(String(candidature.category_id));
    const lines = [summary(ctx, candidature, category)];
    if (!isFinal(candidature.status)) lines.push(timeline(candidature.status));
    else if (candidature.status === 'refused' && category) lines.push(`🔁 ${retryText(category, new Date(candidature.status_at))}`);
    return lines.join('\n');
  });
  const pages = ui.paginateLines(blocks, {
    perPage: 3,
    build: (chunk) => ui.card({ title: `📨 Mes candidatures (${rows.length})`, description: chunk.join('\n\n'), footer: 'Les dernières candidatures, de la plus récente à la plus ancienne' }),
  });
  await ui.sendPaginated(interaction, pages, { ephemeral: true });
}

async function history(ctx, interaction) {
  const { candidatures } = ctx.services;
  const categories = await candidatures.listCategories(interaction.guildId);
  if (!isRecruiterAnywhere(ctx, interaction.member, categories)) return ui.replyError(interaction, 'Réservé aux recruteurs.', 'Accès refusé', ui.EMOJIS.permissions);
  const target = interaction.options.getUser('membre', true);
  const rows = await candidatures.listByApplicant(interaction.guildId, target.id, { limit: 100 });
  if (!rows.length) return ui.respond(interaction, ui.card({ description: `📭 **${target.username}** n’a déposé aucune candidature sur ce serveur.` }), { ephemeral: true });
  const byCategory = new Map(categories.map((c) => [String(c.id), c]));
  const tally = Object.entries(rows.reduce((acc, row) => ({ ...acc, [row.status]: (acc[row.status] ?? 0) + 1 }), {})).map(([status, n]) => `${STATUSES[status]?.emoji ?? ''} ${n}`).join(' · ');
  const pages = ui.paginateLines(
    rows.map((row) => summary(ctx, row, byCategory.get(String(row.category_id)))),
    {
      perPage: 4,
      build: (chunk) => ui.card({ title: `📚 Candidatures de ${target.username} (${rows.length})`, description: `${tally}\n\n${chunk.join('\n\n')}`, footer: 'Issues et motifs · la transcription complète est sur le panel web' }),
    },
  );
  await ui.sendPaginated(interaction, pages, { ephemeral: true });
}

async function statusCommand(ctx, interaction) {
  const { candidature, category, error } = await currentOf(ctx, interaction);
  if (error) return ui.replyError(interaction, error);
  if (!isRecruiter(ctx, interaction.member, category)) return ui.replyError(interaction, 'Réservé aux recruteurs de cette candidature.', 'Accès refusé', ui.EMOJIS.permissions);
  const status = interaction.options.getString('statut', true);
  if (!RECRUITER_STATUSES.includes(status)) return ui.replyError(interaction, 'Statut inconnu.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await setStatus(ctx, { candidature, category, guild: interaction.guild, channel: interaction.channel, status, reason: interaction.options.getString('raison'), by: interaction.user.id });
  if (result.error) return ui.respond(interaction, ui.errorCard(result.error, 'Statut inchangé', '⚠️'));
  await ui.respond(interaction, ui.successCard('Statut modifié', `${STATUSES[status].emoji} ${STATUSES[status].label}`));
}

async function categoryCommand(ctx, interaction) {
  const { candidature, category, error } = await currentOf(ctx, interaction);
  if (error) return ui.replyError(interaction, error);
  if (!isRecruiter(ctx, interaction.member, category)) return ui.replyError(interaction, 'Réservé aux recruteurs de cette candidature.', 'Accès refusé', ui.EMOJIS.permissions);
  const target = await ctx.services.candidatures.getCategory(interaction.options.getString('categorie', true));
  if (!target || String(target.guild_id) !== interaction.guildId) return ui.replyError(interaction, 'Catégorie inconnue (choisis-la dans la liste).');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await changeCategory(ctx, { candidature, fromCategory: category, toCategory: target, guild: interaction.guild, channel: interaction.channel, by: interaction.user.id });
  if (result.error) return ui.respond(interaction, ui.errorCard(result.error, 'Catégorie inchangée', '⚠️'));
  await ui.respond(interaction, ui.successCard('Catégorie modifiée', `Candidature #${candidature.id} → **${target.label}**.`, '🔀'));
}

async function finishCommand(ctx, interaction) {
  const { candidature, category, error } = await currentOf(ctx, interaction);
  if (error) return ui.replyError(interaction, error);
  if (interaction.user.id !== String(candidature.applicant_id)) return ui.replyError(interaction, 'Seul le candidat peut terminer sa candidature.', 'Accès refusé', ui.EMOJIS.permissions);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await finishCandidature(ctx, { candidature, category, guild: interaction.guild, channel: interaction.channel });
  if (result.error) return ui.respond(interaction, ui.errorCard(result.error, 'Candidature non envoyée', '⚠️'));
  await ui.respond(interaction, ui.successCard('Candidature terminée', `Statut : **${STATUSES[result.candidature.status].label}**.`, STATUSES[result.candidature.status].emoji));
}

module.exports = {
  permission: { default: 'everyone' },
  help: {
    adminSubcommands: ['panel', 'logs', 'config'],
    isAdmin: (ctx, interaction) => isAdmin(ctx, interaction.member),
  },

  async autocomplete(ctx, interaction) {
    const focused = interaction.options.getFocused(true);
    const typed = String(focused.value ?? '').toLowerCase();
    if (focused.name === 'panel') {
      const panels = await ctx.services.candidatures.listPanels(interaction.guildId);
      return interaction.respond(
        panels
          .map((p) => ({ name: `Panel #${p.id}${p.title ? ` — ${p.title}` : ''}`.slice(0, 100), value: Number(p.id) }))
          .filter((choice) => choice.name.toLowerCase().includes(typed))
          .slice(0, 25),
      );
    }
    const categories = await ctx.services.candidatures.listCategories(interaction.guildId);
    await interaction.respond(
      categories
        .filter((c) => c.label.toLowerCase().includes(typed))
        .slice(0, 25)
        .map((c) => ({ name: `${c.emoji ? `${c.emoji} ` : ''}${c.label}`.slice(0, 100), value: String(c.id) })),
    );
  },

  data: new SlashCommandBuilder()
    .setName('candidature')
    .setDescription('Candidatures : suivi, statuts et historique')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) => sub.setName('status').setDescription('Voir où en sont tes candidatures'))
    .addSubcommand((sub) => sub.setName('terminer').setDescription('Terminer ta candidature (dans ton salon de candidature)'))
    .addSubcommand((sub) =>
      sub
        .setName('statut')
        .setDescription('Changer le statut de la candidature courante (recruteurs)')
        .addStringOption((o) =>
          o
            .setName('statut')
            .setDescription('Nouveau statut')
            .setRequired(true)
            .addChoices(...RECRUITER_STATUSES.map((key) => ({ name: STATUSES[key].label, value: key }))),
        )
        .addStringOption((o) => o.setName('raison').setDescription('Motif ou précision (obligatoire pour un refus si l’admin l’exige)').setMaxLength(900)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('categorie')
        .setDescription('Changer la catégorie de la candidature courante, en cas d’erreur du candidat (recruteurs)')
        .addStringOption((o) => o.setName('categorie').setDescription('Nouvelle catégorie').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('historique')
        .setDescription('Toutes les candidatures d’un membre, leurs issues et leurs motifs (recruteurs)')
        .addUserOption((o) => o.setName('membre').setDescription('Candidat').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('panel')
        .setDescription('Publier un panel de candidatures dans un salon (admins)')
        .addIntegerOption((o) => o.setName('panel').setDescription('Panel à publier (facultatif s’il n’y en a qu’un)').setAutocomplete(true))
        .addChannelOption((o) => o.setName('salon').setDescription('Salon (par défaut : ici)')),
    )
    .addSubcommand((sub) =>
      sub.setName('logs').setDescription('Définir le salon de journal des candidatures (admins)').addChannelOption((o) => o.setName('salon').setDescription('Salon de journal').setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName('config').setDescription('Lien du panel web pour configurer les candidatures (admins)')),

  async execute(ctx, interaction) {
    if (!interaction.guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const sub = interaction.options.getSubcommand();
    if (sub === 'status') return ownStatus(ctx, interaction);
    if (sub === 'terminer') return finishCommand(ctx, interaction);
    if (sub === 'statut') return statusCommand(ctx, interaction);
    if (sub === 'categorie') return categoryCommand(ctx, interaction);
    if (sub === 'historique') return history(ctx, interaction);

    // Sous-commandes d'administration.
    if (!isAdmin(ctx, interaction.member)) return ui.replyError(interaction, 'Réservé aux administrateurs du serveur.', 'Accès refusé', ui.EMOJIS.permissions);
    const { candidatures } = ctx.services;
    if (sub === 'logs') {
      const channel = interaction.options.getChannel('salon', true);
      if (!channel.isTextBased() || channel.isThread() || channel.isVoiceBased()) return ui.replyError(interaction, 'Choisis un salon textuel.');
      await candidatures.updateSettings(interaction.guildId, { log_channel_id: channel.id });
      return ui.respond(interaction, ui.successCard('Journal défini', `Les événements des candidatures seront publiés dans <#${channel.id}>.`, ui.EMOJIS.log), { ephemeral: true });
    }
    if (sub === 'panel') {
      const channel = interaction.options.getChannel('salon') ?? interaction.channel;
      if (!channel?.isTextBased() || channel.isThread() || channel.isVoiceBased()) return ui.replyError(interaction, 'Choisis un salon textuel.');
      const panels = await candidatures.listPanels(interaction.guildId);
      const wanted = interaction.options.getInteger('panel');
      const panel = wanted ? panels.find((p) => Number(p.id) === wanted) : panels.length === 1 ? panels[0] : null;
      if (!panel) {
        return ui.replyError(interaction, panels.length ? 'Choisis le panel à publier (option `panel`).' : 'Aucun panel : crée-en un sur le panel web (`/candidature config`).', 'Publication impossible', '⚠️');
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await publishPanel(ctx, interaction.guild, panel, channel).catch((err) => ({ error: err.message }));
      if (result.error) return ui.respond(interaction, ui.errorCard(result.error, 'Publication impossible', '⚠️'));
      return ui.respond(interaction, ui.successCard('Panel publié', `Le panel #${panel.id} est publié dans <#${channel.id}>.`, '📨'));
    }
    // config
    const url = webUrl(ctx.config, 'm/candidature/');
    return ui.respond(
      interaction,
      ui.card({ description: url ? `⚙️ Configure les panels, les catégories, leur modèle et les réponses automatiques sur le panel web :\n${url}` : '⚠️ Le panel web est désactivé ou son adresse est invalide.' }),
      { ephemeral: true },
    );
  },
};
