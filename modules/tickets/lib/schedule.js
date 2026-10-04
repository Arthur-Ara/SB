'use strict';

const { isWithinSchedule } = require('../../../src/core/schedule');

/** Normalise les colonnes `schedule_*` d'un panel (ticket_panels) pour isWithinSchedule. */
function panelSchedule(panel) {
  return {
    scheduleEnabled: Boolean(Number(panel?.schedule_enabled ?? 0)),
    scheduleStart: panel?.schedule_start ?? null,
    scheduleEnd: panel?.schedule_end ?? null,
    scheduleTimezone: panel?.schedule_timezone || 'Europe/Paris',
  };
}

/**
 * Prochaines échéances de reping/clôture automatique d'un ticket (lignes brutes `tickets`/`ticket_types`),
 * pour l'affichage (/ticket delay, en-tête de la page transcript). Ne tient PAS compte de la plage
 * horaire d'activation (voir isWithinSchedule) : l'échéance affichée reste celle « en temps normal »,
 * même si elle est actuellement en pause.
 *
 * La clôture automatique compte dès l'ouverture (ticket resté muet = abandonné) ou dès que le staff
 * a répondu (en attente de l'ouvreur) ; le reping ne compte qu'une fois que l'ouvreur a envoyé au
 * moins un message et que le staff n'y a pas répondu depuis (voir dueForAutoClose/dueForReping
 * dans lib/service.js, qui appliquent exactement la même règle côté requête SQL).
 */
function computeTimers(ticket, type) {
  const result = { repingAt: null, autoCloseAt: null };
  if (!ticket.last_message_at || !type) return result;
  const lastMessageAt = new Date(ticket.last_message_at);
  const openerHasSpoken = Boolean(ticket.first_opener_message_at);

  if (ticket.last_message_is_staff || !openerHasSpoken) {
    if (type.auto_close_minutes) result.autoCloseAt = new Date(lastMessageAt.getTime() + type.auto_close_minutes * 60_000);
  } else if (type.reping_minutes) {
    const lastRepingAt = ticket.last_reping_at ? new Date(ticket.last_reping_at) : null;
    const base = lastRepingAt && lastRepingAt > lastMessageAt ? lastRepingAt : lastMessageAt;
    result.repingAt = new Date(base.getTime() + type.reping_minutes * 60_000);
  }
  return result;
}

module.exports = { isWithinSchedule, computeTimers, panelSchedule };
