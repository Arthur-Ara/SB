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
const { parseDuration } = require('../lib/duration');
const render = require('../lib/render');

const PROGRESS_THROTTLE_MS = 1500;

module.exports = {
  permission: { default: 'admin' },

  data: new SlashCommandBuilder()
    .setName('rollback')
    .setDescription('Annuler les modifications du serveur (rôles, salons, modération) sur une période')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o
        .setName('type')
        .setDescription('Ce qu’il faut annuler')
        .setRequired(true)
        .addChoices(
          { name: 'Tout (rôles + salons + modération)', value: 'all' },
          { name: 'Rôles (créer, supprimer, modifier, ajout/retrait aux membres)', value: 'rank' },
          { name: 'Salons (créer, supprimer, modifier)', value: 'channel' },
          { name: 'Modération (bans, exclusions, avertissements…)', value: 'moderation' },
        ),
    )
    .addStringOption((o) =>
      o.setName('duree').setDescription('Jusqu’où remonter (ex : 30m, 2h, 1d, 1d12h — 7 jours maximum par défaut)').setRequired(true).setMaxLength(20),
    )
    .addUserOption((o) => o.setName('utilisateur').setDescription('N’annuler que les actions de cet utilisateur'))
    .addBooleanOption((o) => o.setName('simulation').setDescription('Aperçu seulement : ne rien exécuter')),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const { engine } = ctx.services;

    const scope = interaction.options.getString('type', true);
    const windowS = parseDuration(interaction.options.getString('duree', true));
    if (!windowS) return ui.replyError(interaction, 'Durée invalide. Exemples : `30m`, `2h`, `1d`, `1d12h`.', 'Durée', '⏪');
    const target = interaction.options.getUser('utilisateur');
    const simulation = interaction.options.getBoolean('simulation') ?? false;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const invoker = await guild.members.fetch(interaction.user.id);
    const plan = await engine.plan({ guild, invoker, scope, windowS, targetUserId: target?.id ?? null });
    if (plan.error) return ui.respond(interaction, ui.errorCard(plan.error, 'Rollback impossible', '⏪'));

    if (simulation || !plan.stats.ok || plan.tooMany) {
      return ui.respond(interaction, render.previewCard(plan, { simulation: simulation || !plan.stats.ok }));
    }

    // ── Étape 1 : aperçu + bouton ─────────────────────────────────────────────
    const prefix = `sm:${interaction.id}`;
    const preview = render.previewCard(plan);
    const choiceRow = (disabled = false) =>
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${prefix}:go`)
          .setLabel(`Exécuter (${plan.stats.ok})`)
          .setEmoji('⏪')
          .setStyle(plan.sensitive ? ButtonStyle.Danger : ButtonStyle.Primary)
          .setDisabled(disabled),
        new ButtonBuilder().setCustomId(`${prefix}:no`).setLabel('Annuler').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      );
    const message = await interaction.editReply(ui.message(ui.withRows(preview, [choiceRow()])));

    let click;
    try {
      click = await message.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: 90_000,
        filter: (i) => i.user.id === interaction.user.id && i.customId.startsWith(prefix),
      });
    } catch {
      await interaction.editReply(ui.message(ui.withRows(preview, [choiceRow(true)]))).catch(() => {});
      return;
    }

    if (click.customId === `${prefix}:no`) {
      await click.update(ui.message(ui.card({ description: '⏹️ Rollback annulé : rien n’a été modifié.' })));
      return;
    }

    // ── Étape 2 : confirmation renforcée (saisie d'un code) pour les plans sensibles ──
    if (plan.sensitive) {
      const code = `ROLLBACK ${plan.stats.ok}`;
      await click.showModal(
        new ModalBuilder()
          .setCustomId(`${prefix}:modal`)
          .setTitle('Confirmation du rollback')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('code').setLabel(`Recopie : ${code}`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30),
            ),
          ),
      );
      const submit = await click
        .awaitModalSubmit({ time: 120_000, filter: (i) => i.customId === `${prefix}:modal` && i.user.id === interaction.user.id })
        .catch(() => null);
      if (!submit) {
        await interaction.editReply(ui.message(ui.card({ description: '⌛ Confirmation expirée : rien n’a été modifié.' }))).catch(() => {});
        return;
      }
      const typed = submit.fields.getTextInputValue('code').trim().toUpperCase();
      await submit.deferUpdate();
      if (typed !== code) {
        await interaction.editReply(ui.message(ui.errorCard('Code incorrect : rollback annulé, rien n’a été modifié.', 'Confirmation refusée', '⏪')));
        return;
      }
    } else {
      await click.deferUpdate();
    }

    // ── Étape 3 : exécution avec suivi et bouton d'arrêt ──────────────────────
    const abort = { requested: false };
    const stopRow = () =>
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${prefix}:stop`).setLabel('Arrêter').setEmoji('🛑').setStyle(ButtonStyle.Danger),
      );
    await interaction.editReply(ui.message(ui.withRows(render.progressCard({ index: 0, total: plan.stats.ok, item: null }), [stopRow()])));
    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 20 * 60_000,
      filter: (i) => i.user.id === interaction.user.id && i.customId === `${prefix}:stop`,
    });
    collector.on('collect', (i) => {
      abort.requested = true;
      i.deferUpdate().catch(() => {});
    });

    let lastEdit = 0;
    let result;
    try {
      result = await engine.run(plan, {
        guild,
        invoker,
        abort,
        onProgress: (progress) => {
          const now = Date.now();
          if (progress.index < progress.total && now - lastEdit < PROGRESS_THROTTLE_MS) return;
          lastEdit = now;
          interaction.editReply(ui.message(ui.withRows(render.progressCard(progress), [stopRow()]))).catch(() => {});
        },
      });
    } catch (err) {
      ctx.logger.error('Rollback interrompu par une erreur', err);
      result = { error: `Erreur inattendue pendant le rollback : ${err.message}` };
    } finally {
      collector.stop();
    }

    if (result.error) {
      await interaction.editReply(ui.message(ui.errorCard(result.error, 'Rollback non exécuté', '⏪'))).catch(() => {});
      return;
    }
    await interaction.editReply(ui.message(render.resultCard(result))).catch(() => {});
  },
};
