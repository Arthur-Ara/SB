'use strict';

const ui = require('../../../src/bot/ui');

/** Journal « système » du module (salon défini sur le panel web) : une carte par modification finale. */
class SupportLogs {
  constructor({ client, service, logger }) {
    this.client = client;
    this.service = service;
    this.logger = logger;
  }

  async send(guildId, card) {
    const { logChannelId } = await this.service.settings(guildId);
    if (!logChannelId) return;
    try {
      const channel = this.client.channels.cache.get(logChannelId) ?? (await this.client.channels.fetch(logChannelId));
      if (!channel?.isTextBased()) return;
      await channel.send(ui.payload(card));
    } catch (err) {
      this.logger.warn(`Journal du support automatique indisponible (salon ${logChannelId})`, err.message);
    }
  }
}

module.exports = { SupportLogs };
