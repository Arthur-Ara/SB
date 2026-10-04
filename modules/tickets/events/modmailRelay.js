'use strict';

const { Events, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { NOTE_PREFIX, setPending, relayToStaff, relayToUser, captureModmailMessage, pickCategoryOrStart } = require('../lib/modmail');
const { KeyedMutex } = require('../../../src/core/keyedMutex');

// Messages privés d'un même membre traités un par un : une rafale de messages n'ouvre qu'un seul fil
// (le 2e message attend que le 1er ait créé le fil, puis y est simplement relayé).
const dmLocks = new KeyedMutex();

/**
 * Serveurs où ce membre peut ouvrir un modmail : module actif, modmail activé avec au moins une catégorie
 * (une seule requête pour tous les serveurs), et il en fait partie (vérifié en parallèle).
 */
async function candidateGuilds(ctx, user) {
  const configured = await ctx.services.tickets.modmailReadyGuildIds();
  const guilds = [...ctx.client.guilds.cache.values()].filter((guild) => configured.has(guild.id) && ctx.modules.isEnabledFor('tickets', guild.id));
  const members = await Promise.all(guilds.map((guild) => guild.members.cache.get(user.id) ?? guild.members.fetch(user.id).catch(() => null)));
  return guilds.filter((guild, index) => members[index]);
}

async function handleDirectMessage(ctx, message) {
  const { tickets } = ctx.services;
  const threads = await tickets.openModmailsForUser(message.author.id);
  if (threads.length) {
    // Plusieurs fils ouverts (plusieurs serveurs) : le plus récent reçoit le message.
    const thread = threads[0];
    const guild = ctx.client.guilds.cache.get(thread.guild_id);
    // Fil « panel uniquement » : pas de salon, le message est seulement enregistré (le staff le lit sur le panel).
    if (!thread.channel_id) {
      await captureModmailMessage(ctx, thread.id, {
        kind: 'member',
        authorId: message.author.id,
        authorName: message.author.globalName ?? message.author.username,
        authorAvatar: message.author.displayAvatarURL({ size: 64 }),
        content: message.content || null,
        discordMessage: message,
      });
      await message.react('✅').catch(() => {});
      return;
    }
    const channel = guild?.channels.cache.get(String(thread.channel_id));
    if (channel?.isTextBased()) {
      await relayToStaff(channel, message.author, message);
      await captureModmailMessage(ctx, thread.id, {
        kind: 'member',
        authorId: message.author.id,
        authorName: message.author.globalName ?? message.author.username,
        authorAvatar: message.author.displayAvatarURL({ size: 64 }),
        content: message.content || null,
        discordMessage: message,
      });
      await message.react('✅').catch(() => {});
      return;
    }
  }

  const guilds = await candidateGuilds(ctx, message.author);
  if (!guilds.length) return;
  if (guilds.length === 1) {
    await pickCategoryOrStart(ctx, guilds[0], message.author, message, message.channel);
    return;
  }

  setPending(message.author.id, { message, guildId: null });
  const select = new StringSelectMenuBuilder()
    .setCustomId('modmail:pick')
    .setPlaceholder('Choisir le serveur à contacter…')
    .addOptions(guilds.slice(0, 25).map((guild) => ({ label: guild.name.slice(0, 100), value: guild.id })));
  await message.channel.send({
    ...ui.payload(ui.card({ description: '📨 Tu es présent sur plusieurs serveurs : à quel staff veux-tu écrire ?' })),
    components: [new ActionRowBuilder().addComponents(select)],
  });
}

async function handleStaffMessage(ctx, message) {
  const { tickets } = ctx.services;
  const thread = await tickets.modmailByChannel(message.channel.id);
  if (!thread) return;
  const authorName = message.member?.displayName ?? message.author.username;
  const authorAvatar = message.author.displayAvatarURL({ size: 64 });

  if (message.content.startsWith(NOTE_PREFIX)) {
    await captureModmailMessage(ctx, thread.id, {
      kind: 'note',
      authorId: message.author.id,
      authorName,
      authorAvatar,
      content: message.content.slice(NOTE_PREFIX.length).trim(),
      discordMessage: message,
    });
    await message.react('📝').catch(() => {});
    return;
  }

  const user = await ctx.client.users.fetch(thread.user_id).catch(() => null);
  const delivered = user ? await relayToUser(ctx, message.guild, user, message) : false;
  await captureModmailMessage(ctx, thread.id, { kind: 'staff', authorId: message.author.id, authorName, authorAvatar, content: message.content || null, discordMessage: message });
  if (delivered) await message.react('✅').catch(() => {});
  else {
    await message.react('❌').catch(() => {});
    await message.reply(ui.payload(ui.errorCard('Message non remis : le membre a fermé ses messages privés ou ne partage plus de serveur avec le bot.', 'Envoi impossible', '📨'))).catch(() => {});
  }
}

module.exports = {
  event: Events.MessageCreate,

  async execute(ctx, message) {
    if (message.author.bot || message.system) return;
    try {
      if (!message.guild) await dmLocks.run(message.author.id, () => handleDirectMessage(ctx, message));
      else if (ctx.services.tickets.isModmailChannel(message.channel.id)) await handleStaffMessage(ctx, message);
    } catch (err) {
      ctx.logger.error('Relais modmail impossible', err);
    }
  },
};
