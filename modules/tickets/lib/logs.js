'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { ticketsUrl } = require('./webUrl');

/** Journal du module dans le salon défini par /ticket logs : une carte détaillée par événement. */
class TicketLogs {
  constructor({ client, service, logger, config }) {
    this.client = client;
    this.service = service;
    this.logger = logger;
    this.config = config;
  }

  async send(guildId, card) {
    const { logChannelId } = await this.service.settings(guildId);
    if (!logChannelId) return;
    try {
      const channel = this.client.channels.cache.get(logChannelId) ?? (await this.client.channels.fetch(logChannelId));
      if (!channel?.isTextBased()) return;
      try {
        await channel.send(ui.payload(card));
      } catch (err) {
        // Discord refuse un bouton lien dont l'URL est invalide (ex. localhost) : on renvoie sans les boutons.
        if (!card.rows?.length) throw err;
        this.logger.warn(`Journal des tickets : boutons refusés par Discord, renvoi sans boutons (${err.message})`);
        await channel.send(ui.payload({ embed: card.embed, rows: [] }));
      }
    } catch (err) {
      this.logger.warn(`Journal des tickets indisponible (salon ${logChannelId})`, err.message);
    }
  }

  /**
   * Carte détaillée commune à tous les événements d'un ticket : ouvreur, type, catégorie et salon
   * systématiques, puis un auteur d'action et des lignes libres en plus selon l'événement.
   */
  async event(guild, { emoji, label, ticket, type, executorId, extraLines = [], components = [] }) {
    const category = type?.category_id ? guild.channels.cache.get(type.category_id) : null;
    const lines = [
      `${emoji} **${label}** — #${ticket.id}`,
      `👤 Ouvreur : <@${ticket.opener_id}>`,
      type ? `📂 Type : ${type.label}` : null,
      category ? `🗂️ Catégorie : ${category.name}` : null,
      `📍 Salon : <#${ticket.channel_id}>`,
      executorId ? `🛠️ Par : <@${executorId}>` : null,
      ...extraLines,
    ].filter(Boolean);
    return this.send(guild.id, ui.card({ description: lines.join('\n'), body: components, timestamp: true }));
  }

  opened(guild, ticket, type) {
    return this.event(guild, { emoji: '🎫', label: 'Ticket ouvert', ticket, type });
  }

  claim(guild, ticket, type, executorId, claiming) {
    return this.event(guild, { emoji: '🙋', label: claiming ? 'Ticket pris en charge' : 'Ticket relâché', ticket, type, executorId });
  }

  rated(guild, ticket, type, stars) {
    return this.event(guild, { emoji: '⭐', label: `Ticket noté par l’ouvreur (${stars}/5)`, ticket, type });
  }

  memberChange(guild, ticket, type, executorId, targetId, added) {
    return this.event(guild, {
      emoji: added ? '➕' : '➖',
      label: added ? 'Membre ajouté au ticket' : 'Membre retiré du ticket',
      ticket,
      type,
      executorId,
      extraLines: [`👥 Membre concerné : <@${targetId}>`],
    });
  }

  /**
   * Log unique posté à la suppression du salon, récapitulant tout l'historique (fermetures,
   * réouvertures) au lieu de journaliser chaque étape séparément — un ticket fermé mais jamais
   * supprimé ne publie donc aucun log tant qu'il n'est pas supprimé.
   */
  archived(guild, ticket, type, events, { deletedBy, channelName }) {
    const category = type?.category_id ? guild.channels.cache.get(type.category_id) : null;
    const EVENT_LABEL = { closed: '🔒 Fermé', reopened: '🔓 Réouvert', transferred: '🔀 Transféré' };
    const lines = [
      `🗑️ **Ticket archivé** — #${ticket.id}`,
      `👤 Ouvreur : <@${ticket.opener_id}>`,
      type ? `📂 Type : ${type.label}` : null,
      category ? `🗂️ Catégorie : ${category.name}` : null,
      `📍 Salon (supprimé) : #${channelName}`,
    ].filter(Boolean);

    const history = events.filter((e) => e.event !== 'deleted');
    if (history.length) {
      lines.push('', '**Historique :**');
      for (const ev of history) {
        const who = ev.actor_id ? `<@${ev.actor_id}>` : 'automatiquement';
        let line = `${EVENT_LABEL[ev.event] ?? ev.event} par ${who} — ${ui.ts(ev.created_at, 'f')}`;
        if (ev.reason) line += ` — ${ev.reason}`;
        lines.push(line);
      }
    }
    lines.push('', `🗑️ Supprimé par ${deletedBy ? `<@${deletedBy}>` : 'automatiquement'}`);

    // Le transcript reste consultable après la suppression du salon (les messages restent en base).
    const url = ticketsUrl(this.config, `transcript?ticket=${ticket.id}`);
    if (!url) this.logger.warn(`Lien du transcript du ticket #${ticket.id} indisponible (panel web désactivé ou WEB_CALLBACK_URL invalide)`);
    // Lien aussi dans le texte de l'embed : il reste visible même si Discord retire le bouton.
    if (url) lines.push(`📄 [Voir le transcript](${url})`);
    const body = url
      ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setURL(url).setLabel('Voir le transcript').setStyle(ButtonStyle.Link).setEmoji('📄'))]
      : [];
    return this.send(guild.id, ui.card({ description: lines.join('\n'), body, timestamp: true }));
  }
}

module.exports = { TicketLogs };
