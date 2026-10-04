'use strict';

const ui = require('../../../src/bot/ui');
const { meta } = require('./format');

/** Journal du module dans le salon défini par /modlogs : une carte par action. */
class ModerationLogs {
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
      this.logger.warn(`Journal de modération indisponible (salon ${logChannelId})`, err.message);
    }
  }

  /**
   * Publie une action enregistrée. La description reste du texte normal (pas un bloc de code) pour
   * que les mentions <@id>/<#id> restent cliquables — un bloc de code les afficherait en clair.
   */
  async action({ guildId, action, targetId, channelId, executorId, reason, extra, viaWeb = false, id = null, proof = null }) {
    const { emoji, label } = meta(action);
    const lines = [`${emoji} **${label}**${id ? ` — sanction \`#${id}\`` : ''}`];
    if (targetId) lines.push(`👤 Cible : <@${targetId}>`);
    if (channelId) lines.push(`📍 Salon : <#${channelId}>`);
    lines.push(`🛠️ Par : <@${executorId}>${viaWeb ? ' — 🌐 depuis le panel web' : ''}`);
    if (reason) lines.push(`📝 Raison : ${reason}`);
    if (proof) lines.push(`🔎 Preuve : [message](https://discord.com/channels/${guildId}/${proof.channelId}/${proof.messageId})`);
    const card = ui.card({ description: lines.join('\n'), body: [extra ?? null], timestamp: true });
    await this.send(guildId, card);
  }
}

module.exports = { ModerationLogs };
