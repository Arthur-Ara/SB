'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } = require('discord.js');
const { buildEmbed } = require('../../tickets/lib/embed');
const { parseEmoji, reactionKey } = require('./safety');

/** Nombre maximal d'options par type de menu (limites Discord). */
const LIMITS = { reaction: 20, button: 25, select: 25 };
const TYPE_LABEL = { reaction: 'Réactions', button: 'Boutons', select: 'Menu déroulant' };
const MODE_LABEL = { multiple: 'Plusieurs rôles', single: 'Un seul rôle' };
const BUTTON_STYLE = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};
const REACTION_DELAY_MS = 350;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function optionName(guild, option) {
  return option.label || guild.roles.cache.get(String(option.role_id))?.name || 'Rôle';
}

function defaultEmbed(guild, menu, options) {
  const lines = options.map((option) => {
    const emoji = parseEmoji(option.emoji);
    return `${emoji ? `${emoji.raw} ` : '• '}**${optionName(guild, option)}** — <@&${option.role_id}>`;
  });
  const how = { reaction: 'Réagis avec l’émoji correspondant', button: 'Clique sur un bouton', select: 'Choisis dans le menu' }[menu.type];
  const goal = menu.mode === 'single' ? 'pour choisir **un seul** rôle' : 'pour obtenir ou retirer des rôles';
  return new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle(menu.name.slice(0, 256))
    .setDescription(`${lines.join('\n')}\n\n-# ${how} ${goal}.`.slice(0, 4096));
}

function buttonRows(guild, options) {
  const buttons = options.map((option) => {
    const emoji = parseEmoji(option.emoji);
    const button = new ButtonBuilder().setCustomId(`rm:b:${option.id}`).setStyle(BUTTON_STYLE[option.style] ?? ButtonStyle.Secondary);
    if (emoji) button.setEmoji(emoji.button);
    const label = option.label || (emoji ? null : optionName(guild, option));
    if (label) button.setLabel(label.slice(0, 80));
    return button;
  });
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(...buttons.slice(i, i + 5)));
  return rows;
}

/**
 * Menu déroulant d'un RôleMenu. Publié : sélection vide pour tous. Personnel (`personal`, réponse éphémère) : les
 * options dont le membre a déjà le rôle sont présélectionnées, pour qu'il n'ait qu'à cocher / décocher.
 */
function selectRow(guild, menu, options, { personal = false, ownedIds = [] } = {}) {
  const max = menu.mode === 'single' ? 1 : Math.min(options.length, Number(menu.max_selected) || options.length);
  const owned = new Set(ownedIds.map(String).slice(0, Math.max(1, max)));
  const select = new StringSelectMenuBuilder()
    .setCustomId(`rm:${personal ? 'p' : 's'}:${menu.id}`)
    .setPlaceholder((menu.placeholder || 'Choisis tes rôles…').slice(0, 150))
    .setMinValues(0)
    .setMaxValues(Math.max(1, max))
    .addOptions(
      options.map((option) => {
        const item = { label: optionName(guild, option).slice(0, 100), value: String(option.id) };
        if (option.description) item.description = option.description.slice(0, 100);
        if (personal && owned.has(String(option.id))) item.default = true;
        const emoji = parseEmoji(option.emoji);
        if (emoji) item.emoji = emoji.button;
        return item;
      }),
    );
  return new ActionRowBuilder().addComponents(select);
}

/** Contenu du message Discord d'un menu (embed + composants selon le type). */
function menuPayload(guild, menu, options) {
  if (!options.length) {
    return { embeds: [new EmbedBuilder().setColor(0x2b2d31).setDescription('Ce menu n’a plus aucune option.')], components: [], allowedMentions: { parse: [] } };
  }
  const embed =
    buildEmbed({
      title: menu.embed_title,
      description: menu.embed_description,
      color: menu.embed_color,
      footer: menu.embed_footer,
      image: menu.embed_image,
      thumbnail: menu.embed_thumbnail,
    }) ?? defaultEmbed(guild, menu, options);
  let components = [];
  if (menu.type === 'button') components = buttonRows(guild, options);
  else if (menu.type === 'select') components = [selectRow(guild, menu, options)];
  return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

/** Limites du type, émojis des menus à réactions : erreur lisible, ou null. (Un menu vide est valide ici.) */
function checkOptions(menu, options) {
  if (options.length > LIMITS[menu.type]) {
    return `Un menu « ${TYPE_LABEL[menu.type]} » accepte ${LIMITS[menu.type]} options au maximum (il en a ${options.length}).`;
  }
  if (menu.type === 'reaction') {
    const seen = new Set();
    for (const option of options) {
      const emoji = parseEmoji(option.emoji);
      if (!emoji) return 'Chaque option d’un menu à réactions a besoin d’un émoji valide.';
      if (seen.has(emoji.key)) return `L’émoji ${emoji.raw} est utilisé par plusieurs options.`;
      seen.add(emoji.key);
    }
  }
  return null;
}

function checkPublishable(menu, options) {
  if (!options.length) return 'Ajoute au moins une option (un rôle) avant de publier ce menu.';
  return checkOptions(menu, options);
}

async function fetchMenuMessage(client, menu) {
  if (!menu.channel_id || !menu.message_id) return null;
  const channel = client.channels.cache.get(String(menu.channel_id)) ?? (await client.channels.fetch(String(menu.channel_id)).catch(() => null));
  if (!channel?.isTextBased()) return null;
  return channel.messages.fetch(String(menu.message_id)).catch(() => null);
}

/** Aligne les réactions du bot sur les options du menu. Renvoie les avertissements (émojis inaccessibles…). */
async function syncReactions(message, options) {
  const warnings = [];
  const wanted = new Map();
  for (const option of options) {
    const emoji = parseEmoji(option.emoji);
    if (emoji) wanted.set(emoji.key, emoji);
  }
  for (const reaction of message.reactions.cache.values()) {
    if (!wanted.has(reactionKey(reaction.emoji))) await reaction.remove().catch(() => {});
  }
  for (const [key, emoji] of wanted) {
    if (message.reactions.cache.some((reaction) => reactionKey(reaction.emoji) === key && reaction.me)) continue;
    try {
      await message.react(emoji.raw);
    } catch (err) {
      warnings.push(`Réaction ${emoji.raw} impossible : ${err.message}`);
    }
    await sleep(REACTION_DELAY_MS);
  }
  return warnings;
}

async function clearReactions(message) {
  if (message.reactions.cache.size) await message.reactions.removeAll().catch(() => {});
}

/**
 * Publie un menu dans un salon : édite le message existant s'il est dans le même salon, sinon en envoie un
 * nouveau (et supprime l'ancien). @returns {{ error?: string, message?, warnings?: string[] }}
 */
async function publishMenu(client, service, menu, channel) {
  const options = await service.listOptions(menu.id);
  const problem = checkPublishable(menu, options);
  if (problem) return { error: problem };

  const need = ['ViewChannel', 'SendMessages', 'EmbedLinks', ...(menu.type === 'reaction' ? ['AddReactions', 'ReadMessageHistory'] : [])];
  const permissions = channel.permissionsFor(channel.guild.members.me);
  const missing = need.filter((name) => !permissions?.has(name));
  if (missing.length) return { error: `Il manque des permissions au bot dans <#${channel.id}> : ${missing.join(', ')}.` };

  const payload = menuPayload(channel.guild, menu, options);
  const previous = await fetchMenuMessage(client, menu);
  let message;
  if (previous && previous.channelId === channel.id) {
    message = await previous.edit(payload);
  } else {
    message = await channel.send(payload);
    if (previous) await previous.delete().catch(() => {});
  }
  await service.setMenuMessage(menu.id, channel.id, message.id);
  const warnings = menu.type === 'reaction' ? await syncReactions(message, options) : (await clearReactions(message), []);
  return { message, warnings };
}

/** Met à jour le message publié après une modification de la configuration (sans rien faire s'il n'est pas publié). */
async function refreshMenuMessage(client, service, menu) {
  const message = await fetchMenuMessage(client, menu);
  if (!message) return { warnings: [] };
  const options = await service.listOptions(menu.id);
  if (options.length && checkOptions(menu, options)) return { warnings: ['Le message publié n’a pas pu être mis à jour : configuration invalide.'] };
  await message.edit(menuPayload(message.guild, menu, options)).catch(() => {});
  const warnings = menu.type === 'reaction' && options.length ? await syncReactions(message, options) : (await clearReactions(message), []);
  return { warnings };
}

module.exports = {
  selectRow,
  LIMITS,
  TYPE_LABEL,
  MODE_LABEL,
  optionName,
  menuPayload,
  checkOptions,
  checkPublishable,
  publishMenu,
  refreshMenuMessage,
  fetchMenuMessage,
};
