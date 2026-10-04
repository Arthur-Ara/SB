'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, EmbedBuilder, MessageFlags } = require('discord.js');

/**
 * Charte des messages du bot : embeds sombres (barre invisible #2B2D31), titre « ・ … »,
 * blocs de code aux valeurs bleues, éléments « **⚙️ Élément n°1** » avec dates Discord,
 * boutons sous l'embed et pagination ❮ ❯ + indicateur de page.
 *
 * Une « carte » = { embed: EmbedBuilder, rows: ActionRowBuilder[] } construite par card().
 */

const DARK = 0x2b2d31;
const BLUE = '\u001b[0;34m';
const RESET = '\u001b[0m';

const EMOJIS = {
  stats: '📊',
  permissions: '🛡️',
  modules: '🧩',
  panel: '🌐',
  help: '📖',
  leash: '🔗',
  dog: '🐶',
  log: '📝',
  success: '✅',
  error: '❌',
  warning: '⚠️',
  allowed: '✅',
  denied: '⛔',
  voice: '🔊',
  user: '👤',
  clock: '⌚',
  hourglass: '⏳',
  gear: '⚙️',
};

// ── Mise en forme ─────────────────────────────────────────────────────────────

/** Horodatage Discord (affiché dans le fuseau de chaque lecteur). */
function ts(date, style = 'd') {
  if (!date) return '—';
  const seconds = Math.floor(new Date(date).getTime() / 1000);
  return Number.isFinite(seconds) ? `<t:${seconds}:${style}>` : '—';
}

/** « 13/07/2023 15:44:01 » sous forme d'horodatages Discord. */
function dateTime(date) {
  return date ? `${ts(date, 'd')} ${ts(date, 'T')}` : '—';
}

function ansiBlock(lines) {
  return `\`\`\`ansi\n${lines.join('\n')}\n\`\`\``;
}

/** Nom lisible pour un bloc de détails (pas de mention possible dans un bloc de code). */
function userLabel(client, userId) {
  const user = client?.users?.cache.get(userId);
  return user ? `${user.username} (ID: ${userId})` : `ID: ${userId}`;
}

function renderBlock(block) {
  if (block === 'separator' || block === 'space') return '';
  if (typeof block === 'string') return block;
  if (Array.isArray(block.stats)) {
    return ansiBlock(block.stats.map(([key, value]) => `${key}: ${BLUE}${value}${RESET}`));
  }
  if (Array.isArray(block.details)) {
    return ansiBlock(block.details.map((line) => `${BLUE}${line}${RESET}`));
  }
  if (Array.isArray(block.fields)) {
    return block.fields
      .filter(Boolean)
      .map(({ name, value }) => `**${name}** · ${value}`)
      .join('\n');
  }
  if (block.item) {
    const { emoji, title, lines = [], details = [] } = block.item;
    return [`**${emoji ? `${emoji} ` : ''}${title}**`, ...lines.filter(Boolean), details.length ? renderBlock({ details }) : null]
      .filter((part) => part !== null && part !== undefined)
      .join('\n');
  }
  return '';
}

/**
 * Carte (embed + boutons).
 * @param {object} options
 * @param {string} [options.title]       titre, préfixé par « ・ »
 * @param {string} [options.emoji]       émoji en tête de la description (cartes sans titre : notifications)
 * @param {string} [options.description]
 * @param {{ name: string, iconURL?: string }} [options.author] auteur avec avatar (à gauche du titre)
 * @param {string} [options.thumbnail]
 * @param {Array} [options.body] blocs : texte, 'separator', { stats: [[clé, valeur]] }, { details: [lignes] },
 *                               { fields: [{ name, value }] }, { item: { emoji, title, lines, details } }, ActionRowBuilder
 * @param {string} [options.footer]      texte simple en pied d'embed
 * @param {boolean} [options.timestamp]  heure d'envoi en pied d'embed
 */
function card({ title, emoji, description, author, thumbnail, body = [], footer, timestamp } = {}) {
  const embed = new EmbedBuilder().setColor(DARK);
  const rows = [];
  if (author?.name) embed.setAuthor({ name: author.name.slice(0, 256), iconURL: author.iconURL ?? undefined });
  if (title) embed.setTitle(`・ ${title}`.slice(0, 256));
  if (thumbnail) embed.setThumbnail(thumbnail);

  const parts = [];
  if (description) parts.push(!title && emoji ? `${emoji} ${description}` : description);
  for (const block of body) {
    if (block === null || block === undefined || block === false || block === '') continue;
    if (block instanceof ActionRowBuilder) rows.push(block);
    else parts.push(renderBlock(block));
  }
  const text = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text) embed.setDescription(text.length > 4096 ? `${text.slice(0, 4090)}\n…` : text);
  if (footer) embed.setFooter({ text: footer.slice(0, 2048) });
  if (timestamp) embed.setTimestamp(new Date());
  return { embed, rows };
}

/** Notification d'une ligne : « ✅ Texte ». */
function successCard(title, description, emoji = EMOJIS.success, body = []) {
  return card({ title, description: `${emoji} ${description}`, body });
}

function errorCard(description, title, emoji = EMOJIS.error) {
  return card({ description: `${emoji} ${title ? `**${title}** · ` : ''}${description}` });
}

// ── Envoi ─────────────────────────────────────────────────────────────────────

function toList(cards) {
  return Array.isArray(cards) ? cards : [cards];
}

/** Contenu d'un message (embeds + boutons) à partir d'une ou plusieurs cartes. */
function message(cards) {
  const list = toList(cards);
  return { embeds: list.map((c) => c.embed), components: list.flatMap((c) => c.rows).slice(0, 5) };
}

function payload(cards, { ephemeral = false } = {}) {
  return { ...message(cards), ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}) };
}

/**
 * Répond à une interaction : modifie la réponse différée, sinon répond
 * (ou envoie une suite si une réponse existe déjà).
 */
async function respond(interaction, cards, { ephemeral = false } = {}) {
  if (interaction.deferred) return interaction.editReply(message(cards));
  if (interaction.replied) return interaction.followUp(payload(cards, { ephemeral }));
  return interaction.reply(payload(cards, { ephemeral }));
}

function replyError(interaction, description, title, emoji) {
  return respond(interaction, errorCard(description, title, emoji), { ephemeral: true });
}

async function ensureDeferred(interaction, ephemeral) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
  }
}

function withRows(base, rows) {
  return { embed: EmbedBuilder.from(base.embed), rows: [...base.rows, ...rows] };
}

/** Répond « ce n'est pas ton message » à quelqu'un d'autre que l'auteur de la commande. */
function rejectForeignClick(click) {
  return click
    .reply(payload(errorCard('Seule la personne qui a lancé la commande peut utiliser ces boutons.'), { ephemeral: true }))
    .catch(() => {});
}

/**
 * Pages avec boutons ❮ ❯ et indicateur « 1/3 » sous l'embed.
 * Seul l'auteur de la commande peut naviguer ; les boutons se désactivent après `time`.
 */
async function sendPaginated(interaction, pages, { ephemeral = false, time = 5 * 60_000 } = {}) {
  await ensureDeferred(interaction, ephemeral);
  let index = 0;

  const render = (disabled = false) =>
    withRows(pages[index], [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('page:prev').setLabel('❮').setStyle(ButtonStyle.Secondary).setDisabled(disabled || index === 0),
        new ButtonBuilder()
          .setCustomId('page:next')
          .setLabel('❯')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled || index === pages.length - 1),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('page:index').setLabel(`${index + 1}/${pages.length}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
      ),
    ]);

  const reply = await interaction.editReply(message(render()));
  if (pages.length <= 1) return reply;

  const collector = reply.createMessageComponentCollector({ componentType: ComponentType.Button, time });
  collector.on('collect', async (click) => {
    if (click.user.id !== interaction.user.id) return rejectForeignClick(click);
    index = click.customId === 'page:next' ? Math.min(index + 1, pages.length - 1) : Math.max(index - 1, 0);
    return click.update(message(render())).catch(() => {});
  });
  collector.on('end', () => {
    interaction.editReply(message(render(true))).catch(() => {});
  });
  return reply;
}

/** Découpe des blocs (lignes ou éléments) en pages (au moins une page, même vide). */
function paginateLines(lines, { perPage = 10, build }) {
  const pages = [];
  for (let i = 0; i < Math.max(lines.length, 1); i += perPage) pages.push(build(lines.slice(i, i + perPage), i));
  return pages;
}

/**
 * Confirmation par boutons avant une action destructrice (réponse éphémère).
 * @returns {Promise<boolean>} true si l'auteur a confirmé avant l'expiration.
 */
async function confirm(interaction, { prompt, confirmLabel = 'Confirmer', time = 30_000 }) {
  await ensureDeferred(interaction, true);
  const view = withRows(prompt, [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('confirm:yes').setLabel(confirmLabel).setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('confirm:no').setLabel('Annuler').setStyle(ButtonStyle.Secondary),
    ),
  ]);
  const reply = await interaction.editReply(message(view));
  try {
    const click = await reply.awaitMessageComponent({
      componentType: ComponentType.Button,
      time,
      filter: (i) => i.user.id === interaction.user.id,
    });
    await click.deferUpdate();
    return click.customId === 'confirm:yes';
  } catch {
    return false; // délai dépassé
  }
}

module.exports = {
  DARK,
  EMOJIS,
  ts,
  dateTime,
  userLabel,
  card,
  successCard,
  errorCard,
  message,
  payload,
  respond,
  replyError,
  ensureDeferred,
  withRows,
  rejectForeignClick,
  sendPaginated,
  paginateLines,
  confirm,
};
