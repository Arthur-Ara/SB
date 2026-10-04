'use strict';

const { Events, PermissionFlagsBits } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { scan } = require('../lib/automod');
const { applyWarnRules, MAX_TIMEOUT_S } = require('../lib/sanctions');

const NOTICE_TTL_MS = 6_000;

function isExempt(message, automod) {
  const member = message.member;
  if (!member) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageMessages)) return true;
  if (automod.exemptRoleIds.some((id) => member.roles.cache.has(id))) return true;
  const channelIds = [message.channelId, message.channel.parentId].filter(Boolean);
  return channelIds.some((id) => automod.exemptChannelIds.includes(id));
}

/**
 * Automod « mots interdits » (désactivé par défaut, réglé sur le panel) : supprime le message, puis
 * selon le réglage avertit (avec sanctions automatiques au cumul) ou exclut temporairement l'auteur.
 * Chaque détection est conservée pour la revue des faux positifs sur le panel.
 */
module.exports = {
  event: Events.MessageCreate,

  async execute(ctx, message) {
    if (!message.guild || !message.author || message.author.bot || message.system || !message.content) return;
    const { moderation, logs } = ctx.services;
    try {
      const { automod } = await moderation.settings(message.guild.id);
      if (!automod.enabled || isExempt(message, automod)) return;
      const hit = scan(message.content, await moderation.automodLists(message.guild.id), automod.threshold);
      if (!hit) return;

      const guild = message.guild;
      const botId = ctx.client.user.id;
      const reason = `Automod : mot interdit « ${hit.word} » (${hit.score} %)`;
      await message.delete().catch(() => {});

      let actionId;
      let extra = '';
      let applied = automod.action;
      if (automod.action === 'warn') {
        actionId = await moderation.record({ guildId: guild.id, action: 'warn', targetId: message.author.id, channelId: message.channelId, executorId: botId, reason });
        await logs.action({ guildId: guild.id, action: 'warn', targetId: message.author.id, channelId: message.channelId, executorId: botId, reason, id: actionId });
        const automatic = await applyWarnRules(ctx.services, guild, message.author.id, ctx.client);
        if (automatic) extra = ` — ${automatic}`;
      } else if (automod.action === 'mute' && message.member?.moderatable) {
        const seconds = Math.min(automod.muteMinutes * 60, MAX_TIMEOUT_S);
        await message.member.timeout(seconds * 1000, reason).catch(() => {});
        actionId = await moderation.record({
          guildId: guild.id,
          action: 'tempmute',
          targetId: message.author.id,
          channelId: message.channelId,
          executorId: botId,
          reason,
          durationS: seconds,
          expiresAt: new Date(Date.now() + seconds * 1000),
        });
        await logs.action({ guildId: guild.id, action: 'tempmute', targetId: message.author.id, channelId: message.channelId, executorId: botId, reason, id: actionId });
      } else {
        applied = 'delete';
        actionId = await moderation.record({ guildId: guild.id, action: 'automod', targetId: message.author.id, channelId: message.channelId, executorId: botId, reason, metadata: { word: hit.word, token: hit.token, score: hit.score } });
        await logs.action({ guildId: guild.id, action: 'automod', targetId: message.author.id, channelId: message.channelId, executorId: botId, reason, id: actionId });
      }

      await moderation.recordAutomodHit({
        guildId: guild.id,
        userId: message.author.id,
        channelId: message.channelId,
        content: message.content,
        word: hit.word,
        token: hit.token,
        score: hit.score,
        action: applied,
      });

      const notice = await message.channel
        .send({ ...ui.payload(ui.card({ description: `🤖 <@${message.author.id}>, ton message a été supprimé : il contient un mot interdit sur ce serveur.${extra}` })), allowedMentions: { users: [message.author.id] } })
        .catch(() => null);
      if (notice) setTimeout(() => notice.delete().catch(() => {}), NOTICE_TTL_MS).unref?.();
    } catch (err) {
      ctx.logger.error('Automod : analyse du message impossible', err);
    }
  },
};
