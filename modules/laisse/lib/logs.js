'use strict';

const ui = require('../../../src/bot/ui');

/** Journal du module dans le salon défini par /laisse-admin log (déplacements et commandes). */
class LeashLogs {
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
      this.logger.warn(`Journal de laisse indisponible (salon ${logChannelId})`, err.message);
    }
  }

  move(guildId, text) {
    return this.send(guildId, { emoji: ui.EMOJIS.leash, text });
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

  error(guildId, text) {
    return this.send(guildId, { emoji: ui.EMOJIS.warning, text });
  }
}

module.exports = { LeashLogs };
