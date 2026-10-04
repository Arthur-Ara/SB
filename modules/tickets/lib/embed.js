'use strict';

const { EmbedBuilder } = require('discord.js');

const DEFAULT_COLOR = 0x2b2d31;

function parseColor(hex) {
  if (!hex || typeof hex !== 'string') return DEFAULT_COLOR;
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  return match ? parseInt(match[1], 16) : DEFAULT_COLOR;
}

function fill(text, placeholders) {
  if (!text) return text;
  return text.replace(/\{(\w+)\}/g, (match, key) => (Object.hasOwn(placeholders, key) ? String(placeholders[key]) : match));
}

/**
 * Construit un embed à partir des colonnes stockées (title/description/color/footer/image/thumbnail),
 * avec substitution de placeholders ({user}, {type}, {ticket}…). Renvoie `null` si rien à afficher.
 */
function buildEmbed(fields, placeholders = {}) {
  const title = fill(fields.title, placeholders);
  const description = fill(fields.description, placeholders);
  if (!title && !description) return null;
  const embed = new EmbedBuilder().setColor(parseColor(fields.color));
  if (title) embed.setTitle(title.slice(0, 256));
  if (description) embed.setDescription(description.slice(0, 4096));
  if (fields.footer) embed.setFooter({ text: fill(fields.footer, placeholders).slice(0, 2048) });
  if (fields.image) embed.setImage(fields.image);
  if (fields.thumbnail) embed.setThumbnail(fields.thumbnail);
  return embed;
}

module.exports = { buildEmbed, parseColor, DEFAULT_COLOR };
