'use strict';

const {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const ui = require('../../../src/bot/ui');

const EMOJI = '💾';
const PREVIEW_ITEMS = 12;

function sizeText(bytes) {
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} Mo` : `${Math.max(1, Math.round(bytes / 1024))} Ko`;
}

function previewCard(backup, plan) {
  const lines = plan.actions.slice(0, PREVIEW_ITEMS).map((a) => `${a.type.endsWith('create') ? '➕' : '↩️'} ${a.label}`);
  if (plan.actions.length > PREVIEW_ITEMS) lines.push(`… et **${plan.actions.length - PREVIEW_ITEMS}** autre(s)`);
  return ui.card({
    title: `${EMOJI} Restauration de la sauvegarde #${backup.id}`,
    description: `**${backup.name}** · ${ui.ts(backup.created_at, 'f')}`,
    body: [
      { stats: [['Opérations', plan.actions.length], ['Ignorées', plan.skipped.length]] },
      plan.actions.length ? `\n**Prévu**\n${lines.join('\n')}` : '\n*Le serveur correspond déjà à cette sauvegarde : rien à restaurer.*',
      plan.skipped.length ? `\n**Ignoré**\n${plan.skipped.slice(0, 6).map((s) => `• ${s.label} — ${s.reason}`).join('\n')}` : null,
      '\n⚠️ Restauration **non destructive** : ce qui a été créé depuis la sauvegarde est conservé ; les positions et les messages ne sont pas restaurés.',
    ],
    footer: 'Aperçu : rien n’a encore été modifié.',
  });
}

async function restoreCommand(ctx, interaction) {
  const { backups } = ctx.services;
  const guild = interaction.guild;
  const id = interaction.options.getInteger('id', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const invoker = await guild.members.fetch(interaction.user.id);
  const preview = await backups.preview(guild, id, invoker);
  if (preview.error) return ui.respond(interaction, ui.errorCard(preview.error, 'Restauration impossible', EMOJI));
  const { backup, plan } = preview;
  if (!plan.actions.length) return ui.respond(interaction, previewCard(backup, plan));

  const prefix = `smb:${interaction.id}`;
  const row = (disabled = false) =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${prefix}:go`).setLabel(`Restaurer (${plan.actions.length})`).setEmoji('♻️').setStyle(ButtonStyle.Danger).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`${prefix}:no`).setLabel('Annuler').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    );
  const card = previewCard(backup, plan);
  const message = await interaction.editReply(ui.message(ui.withRows(card, [row()])));
  let click;
  try {
    click = await message.awaitMessageComponent({ componentType: ComponentType.Button, time: 90_000, filter: (i) => i.user.id === interaction.user.id && i.customId.startsWith(prefix) });
  } catch {
    await interaction.editReply(ui.message(ui.withRows(card, [row(true)]))).catch(() => {});
    return;
  }
  if (click.customId === `${prefix}:no`) {
    await click.update(ui.message(ui.card({ description: '⏹️ Restauration annulée : rien n’a été modifié.' })));
    return;
  }

  // Confirmation renforcée systématique : une restauration touche à toute la structure du serveur.
  const code = `RESTAURER ${backup.id}`;
  await click.showModal(
    new ModalBuilder()
      .setCustomId(`${prefix}:modal`)
      .setTitle('Confirmation de la restauration')
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('code').setLabel(`Recopie : ${code}`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30))),
  );
  const submit = await click.awaitModalSubmit({ time: 120_000, filter: (i) => i.customId === `${prefix}:modal` && i.user.id === interaction.user.id }).catch(() => null);
  if (!submit) {
    await interaction.editReply(ui.message(ui.card({ description: '⌛ Confirmation expirée : rien n’a été modifié.' }))).catch(() => {});
    return;
  }
  await submit.deferUpdate();
  if (submit.fields.getTextInputValue('code').trim().toUpperCase() !== code) {
    await interaction.editReply(ui.message(ui.errorCard('Code incorrect : restauration annulée, rien n’a été modifié.', 'Confirmation refusée', EMOJI)));
    return;
  }

  let lastEdit = 0;
  const result = await backups.restore(guild, backup.id, invoker, {
    expectedHash: plan.hash,
    onProgress: ({ index, total, label }) => {
      if (index < total && Date.now() - lastEdit < 1500) return;
      lastEdit = Date.now();
      interaction.editReply(ui.message(ui.card({ title: '♻️ Restauration en cours', description: `**${index}/${total}** — ${label}` }))).catch(() => {});
    },
  });
  if (result.error) {
    await interaction.editReply(ui.message(ui.errorCard(result.error, 'Restauration non exécutée', EMOJI))).catch(() => {});
    return;
  }
  const failed = result.results.filter((r) => r.status === 'failed');
  await interaction
    .editReply(
      ui.message(
        ui.card({
          title: `♻️ Restauration de la sauvegarde #${backup.id} terminée`,
          body: [
            { stats: [['Réussies', result.done], ['Échecs', result.failed], ['Ignorées', result.skipped.length]] },
            failed.length ? `\n**Échecs**\n${failed.slice(0, 8).map((r) => `❌ ${r.label} — ${r.reason}`).join('\n')}` : null,
          ],
        }),
      ),
    )
    .catch(() => {});
}

module.exports = {
  permission: { default: 'admin' },

  data: new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Sauvegarder et restaurer la structure du serveur (rôles, salons, permissions)')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName('create')
        .setDescription('Créer une sauvegarde de la structure du serveur')
        .addStringOption((o) => o.setName('nom').setDescription('Nom de la sauvegarde (facultatif)').setMaxLength(80)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Lister les sauvegardes du serveur'))
    .addSubcommand((s) =>
      s
        .setName('restore')
        .setDescription('Restaurer une sauvegarde (aperçu puis confirmation, non destructif)')
        .addIntegerOption((o) => o.setName('id').setDescription('Numéro de la sauvegarde').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName('delete')
        .setDescription('Supprimer une sauvegarde')
        .addIntegerOption((o) => o.setName('id').setDescription('Numéro de la sauvegarde').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName('auto')
        .setDescription('Régler les sauvegardes automatiques')
        .addBooleanOption((o) => o.setName('actif').setDescription('Activer les sauvegardes automatiques').setRequired(true))
        .addIntegerOption((o) => o.setName('intervalle').setDescription('Heures entre deux sauvegardes (défaut 24)').setMinValue(1).setMaxValue(720))
        .addIntegerOption((o) => o.setName('garder').setDescription('Nombre de sauvegardes automatiques conservées (défaut 7)').setMinValue(1).setMaxValue(50)),
    ),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const { backups, store } = ctx.services;
    const sub = interaction.options.getSubcommand();

    if (sub === 'create') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await backups.create(guild, { name: interaction.options.getString('nom'), createdBy: interaction.user.id });
      return ui.respond(interaction, ui.successCard('Sauvegarde créée', `Sauvegarde **#${result.id}** : ${result.roles} rôles et ${result.channels} salons.`, EMOJI));
    }

    if (sub === 'list') {
      const [rows, settings] = await Promise.all([store.listBackups(guild.id), store.settings(guild.id)]);
      const pages = ui.paginateLines(rows, {
        perPage: 8,
        build: (chunk) =>
          ui.card({
            title: `Sauvegardes du serveur (${rows.length})`,
            body: [
              { stats: [['Automatiques', settings.backupEnabled ? `toutes les ${settings.backupIntervalHours} h, ${settings.backupKeep} gardées` : 'désactivées']] },
              ...chunk.map((row) => ({
                item: {
                  emoji: row.origin === 'auto' ? '🕒' : EMOJI,
                  title: `#${row.id} — ${row.name}`,
                  lines: [
                    `${ui.ts(row.created_at, 'f')} · ${row.roles_count} rôles · ${row.channels_count} salons · ${sizeText(row.size_bytes)}`,
                    row.restored_at ? `♻️ Restaurée ${ui.ts(row.restored_at, 'R')}` : null,
                  ],
                },
              })),
              chunk.length ? null : 'Aucune sauvegarde : `/backup create` pour en créer une.',
            ],
          }),
      });
      return ui.sendPaginated(interaction, pages, { ephemeral: true });
    }

    if (sub === 'restore') return restoreCommand(ctx, interaction);

    if (sub === 'delete') {
      const id = interaction.options.getInteger('id', true);
      if (!(await store.deleteBackup(guild.id, id))) return ui.replyError(interaction, `Aucune sauvegarde #${id} sur ce serveur.`, 'Introuvable', EMOJI);
      await backups.log(guild.id, `🗑️ Sauvegarde **#${id}** supprimée par <@${interaction.user.id}>.`);
      return ui.respond(interaction, ui.successCard('Sauvegarde supprimée', `La sauvegarde #${id} a été supprimée.`, EMOJI), { ephemeral: true });
    }

    const enabled = interaction.options.getBoolean('actif', true);
    const current = await store.settings(guild.id);
    const interval = interaction.options.getInteger('intervalle') ?? current.backupIntervalHours;
    const keep = interaction.options.getInteger('garder') ?? current.backupKeep;
    await store.updateBackupSettings(guild.id, { backup_enabled: enabled ? 1 : 0, backup_interval_hours: interval, backup_keep: keep });
    return ui.respond(
      interaction,
      ui.successCard(
        'Sauvegardes automatiques',
        enabled ? `Activées : une sauvegarde toutes les **${interval} h**, les **${keep}** plus récentes sont conservées (les manuelles ne sont jamais supprimées).` : 'Désactivées.',
        EMOJI,
      ),
      { ephemeral: true },
    );
  },
};
