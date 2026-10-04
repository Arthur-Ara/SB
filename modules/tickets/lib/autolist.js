'use strict';

const ui = require('../../../src/bot/ui');

const REFRESH_DELAY_MS = 3000;
const MAX_LINES = 20;
const NO_PRIORITY = Number.MAX_SAFE_INTEGER;

/** Priorité d'un ticket : position de sa plus prioritaire étiquette (0 = la plus haute), sinon en dernier. */
function priorityOf(tags) {
  return tags.length ? Math.min(...tags.map((tag) => tag.position)) : NO_PRIORITY;
}

/**
 * Tickets ouverts triés par priorité des étiquettes (la plus haute d'abord), puis du plus ancien au plus récent.
 * @returns {Array<{ ticket, type, tags }>}
 */
async function sortedOpenTickets(tickets, guildId, { typeId = null } = {}) {
  const [open, types] = await Promise.all([tickets.listOpenTickets(guildId), tickets.listAllTypes(guildId)]);
  const typesById = new Map(types.map((type) => [String(type.id), type]));
  const rows = open.filter((ticket) => !typeId || String(ticket.type_id) === String(typeId));
  const tagMap = await tickets.tagsForTickets(rows.map((ticket) => ticket.id));
  return rows
    .map((ticket) => ({ ticket, type: typesById.get(String(ticket.type_id)) ?? null, tags: tagMap.get(String(ticket.id)) ?? [] }))
    .sort((a, b) => priorityOf(a.tags) - priorityOf(b.tags) || new Date(a.ticket.created_at) - new Date(b.ticket.created_at));
}

/**
 * Qui doit parler ensuite : le staff (le membre a écrit en dernier), le membre (le staff a répondu en dernier), ou
 * ticket encore muet. Même règle que le reping / la clôture automatique (lib/schedule.js#computeTimers).
 */
function waitingFor(ticket) {
  if (Number(ticket.last_message_is_staff)) return 'member';
  if (ticket.first_opener_message_at) return 'staff';
  return 'new';
}

const WAITING_TEXT = { staff: '💬 attente du staff', member: '🕓 attente du membre', new: '🆕 sans message' };

/** Une ligne de liste : étiquettes, salon, type, ouvreur, ancienneté, qui doit répondre (et qui l'a pris en charge). */
function ticketLine({ ticket, type, tags }, { showType = true } = {}) {
  const badges = tags.map((tag) => `${tag.emoji ? `${tag.emoji} ` : ''}${tag.name}`).join(' · ');
  const parts = [
    `${badges ? `**${badges}** · ` : ''}<#${ticket.channel_id}>`,
    showType && type ? type.label : null,
    `<@${ticket.opener_id}>`,
    ui.ts(ticket.created_at, 'R'),
  ].filter(Boolean);
  return `${parts.join(' — ')} · ${WAITING_TEXT[waitingFor(ticket)]}${ticket.claimed_by ? ` · 🙋 <@${ticket.claimed_by}>` : ''}`;
}

/** Section titrée : au plus MAX_LINES lignes et `budget` caractères (description d'embed limitée à 4096). */
function section(title, entries, options, budget) {
  if (!entries.length) return `**${title} (0)**\n*Aucun.*`;
  const head = `**${title} (${entries.length})**`;
  const lines = [];
  let length = head.length + 40; // réserve pour la ligne « … et N autre(s) »
  for (const entry of entries.slice(0, MAX_LINES)) {
    const line = `• ${ticketLine(entry, options)}`;
    if (length + line.length + 1 > budget) break;
    lines.push(line);
    length += line.length + 1;
  }
  if (entries.length > lines.length) lines.push(`-# … et ${entries.length - lines.length} autre(s)`);
  return `${head}\n${lines.join('\n')}`;
}

/**
 * Carte « tickets ouverts », triée par priorité. La section « En attente de prise en charge » n'existe que pour les
 * types où la prise en charge est obligatoire (`claimSection`, déduit des tickets listés si non précisé) ; tous les
 * autres tickets forment la liste « Tickets ouverts ». Chaque ligne indique si le staff ou le membre doit répondre.
 */
function listCard(entries, { typeLabel = null, claimSection = null } = {}) {
  const needsClaim = (entry) => Number(entry.type?.claim_required) && !entry.ticket.claimed_by;
  const waiting = entries.filter(needsClaim);
  const others = entries.filter((entry) => !needsClaim(entry));
  const showClaim = claimSection ?? entries.some((entry) => Number(entry.type?.claim_required));
  const options = { showType: !typeLabel };
  // Budget partagé selon le nombre de lignes de chaque section (une section courte laisse de la place à l'autre).
  const total = 4000;
  const claimBudget = showClaim ? Math.max(600, Math.round((total * Math.min(waiting.length, MAX_LINES)) / Math.max(1, Math.min(waiting.length, MAX_LINES) + Math.min(others.length, MAX_LINES)))) : 0;
  const sections = [
    showClaim ? section('⏳ En attente de prise en charge', waiting, options, claimBudget) : null,
    section('📬 Tickets ouverts', others, options, total - claimBudget),
  ];
  return ui.card({
    title: `📋 Tickets ouverts${typeLabel ? ` — ${typeLabel}` : ''} (${entries.length})`,
    description: sections.filter(Boolean).join('\n\n'),
    footer: 'Triés par priorité des étiquettes, puis du plus ancien au plus récent · 💬 le staff doit répondre · 🕓 le membre doit répondre',
    timestamp: true,
  });
}

/**
 * Messages publiés par /ticket autolist : tenus à jour à chaque changement (ouverture, prise en charge, fermeture,
 * transfert, étiquette…). Les changements rapprochés d'un même serveur sont regroupés en une seule mise à jour.
 * Un message supprimé à la main est simplement oublié.
 */
class AutolistService {
  constructor({ client, tickets, logger }) {
    this.client = client;
    this.tickets = tickets;
    this.logger = logger;
    this.timers = new Map();
  }

  refresh(guildId) {
    if (!guildId) return;
    const key = String(guildId);
    if (this.timers.has(key)) return;
    const timer = setTimeout(() => {
      this.timers.delete(key);
      this.refreshNow(key).catch((err) => this.logger.warn(`Listes de tickets de ${key} non mises à jour`, err.message));
    }, REFRESH_DELAY_MS);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  async render(guildId, typeId) {
    const type = typeId ? await this.tickets.getType(typeId) : null;
    const entries = await sortedOpenTickets(this.tickets, guildId, { typeId });
    return ui.payload(listCard(entries, { typeLabel: type?.label ?? null, claimSection: type ? Boolean(Number(type.claim_required)) : null }));
  }

  /**
   * Rafraîchissement périodique : les réponses dans les tickets ne déclenchent pas de mise à jour (trop fréquentes),
   * l'indicateur « attente du staff / du membre » est donc recalculé toutes les `intervalMs`.
   */
  start(intervalMs) {
    if (this.timer || !intervalMs) return;
    this.timer = setInterval(() => {
      this.tickets
        .autolistGuildIds()
        .then((guildIds) => guildIds.forEach((guildId) => this.refresh(guildId)))
        .catch((err) => this.logger.warn('Rafraîchissement des listes de tickets impossible', err.message));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async refreshNow(guildId) {
    for (const list of await this.tickets.listAutolists(guildId)) {
      const channel = this.client.channels.cache.get(String(list.channel_id)) ?? (await this.client.channels.fetch(String(list.channel_id)).catch(() => null));
      const message = channel?.isTextBased() ? await channel.messages.fetch(String(list.message_id)).catch(() => null) : null;
      if (!message) {
        await this.tickets.deleteAutolist(list.id);
        continue;
      }
      await message.edit({ ...(await this.render(guildId, list.type_id)), allowedMentions: { parse: [] } }).catch((err) => this.logger.warn('Liste de tickets non modifiée', err.message));
    }
  }
}

module.exports = { AutolistService, sortedOpenTickets, listCard, priorityOf, waitingFor };
