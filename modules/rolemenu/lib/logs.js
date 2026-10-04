'use strict';

const ui = require('../../../src/bot/ui');

/** Journal du module (salon défini avec /rolemenu ou sur le panel web) : une carte par modification de configuration. */
class RoleMenuLogs {
  constructor({ client, service, logger }) {
    this.client = client;
    this.service = service;
    this.logger = logger;
  }

  async send(guildId, card) {
    const { logChannelId } = await this.service.settings(guildId);
    if (!logChannelId) return;
    try {
      const channel = this.client.channels.cache.get(String(logChannelId)) ?? (await this.client.channels.fetch(String(logChannelId)));
      if (!channel?.isTextBased()) return;
      await channel.send(ui.payload(card));
    } catch (err) {
      this.logger.warn(`Journal de RôleMenu indisponible (salon ${logChannelId})`, err.message);
    }
  }

  /** « 🌐 Nom (panel web) — … » ou « 🛠️ <@id> — … » selon l'origine de la modification. */
  async change(guildId, actor, text) {
    const who = actor.web ? `🌐 **${actor.name}** (panel web)` : `🛠️ <@${actor.id}>`;
    await this.send(guildId, ui.card({ description: `🎭 ${who} — ${text}`, timestamp: true }));
  }
}

module.exports = { RoleMenuLogs };
