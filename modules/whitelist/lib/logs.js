'use strict';

const ui = require('../../../src/bot/ui');

const REASON_TEXT = {
  not_whitelisted: 'n’est pas whitelisté sur ce salon',
  slot_limit: 'a dépassé la limite de places du salon',
};

/** Journal du module dans le salon défini par /whitelist log (expulsions et commandes). */
class WhitelistLogs {
  constructor({ client, service, logger }) {
    this.client = client;
    this.service = service;
    this.logger = logger;
  }

  async send(guildId, { emoji, text }) {
    const { logChannelId } = (await this.service.state(guildId)).settings;
    if (!logChannelId) return;
    try {
      const channel = this.client.channels.cache.get(logChannelId) ?? (await this.client.channels.fetch(logChannelId));
      if (!channel?.isTextBased()) return;
      await channel.send(ui.payload(ui.card({ description: `${emoji} ${text}`, timestamp: true })));
    } catch (err) {
      this.logger.warn(`Journal whitelist indisponible (salon ${logChannelId})`, err.message);
    }
  }

  kick(guildId, member, channel, reason) {
    return this.send(guildId, {
      emoji: '⛔',
      text: `<@${member.id}> a été déconnecté de <#${channel.id}> : ${REASON_TEXT[reason] ?? reason}.`,
    });
  }

  inviteExpired(guildId, userId, channelId) {
    return this.send(guildId, { emoji: '⏳', text: `Fin de l’accès temporaire de <@${userId}> à <#${channelId}>.` });
  }

  /** Utilisation d'une commande (hors commandes d'affichage). */
  command(guildId, interaction, text) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand(false);
    const name = ['/' + interaction.commandName, group, sub].filter(Boolean).join(' ');
    return this.send(guildId, { emoji: '🛠️', text: `<@${interaction.user.id}> a utilisé \`${name}\` — ${text}` });
  }

  /** Action effectuée depuis le panel web (dashboard). */
  webAction(guildId, webUser, text) {
    return this.send(guildId, { emoji: '🌐', text: `**${webUser.name}** (panel web) — ${text}` });
  }
}

module.exports = { WhitelistLogs };
