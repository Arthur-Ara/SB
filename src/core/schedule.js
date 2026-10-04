'use strict';

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** « HH:MM » valide (00:00 à 23:59) ? */
function isTime(value) {
  return TIME.test(String(value ?? ''));
}

/** Fuseau horaire reconnu par le moteur Intl ? */
function isTimezone(value) {
  try {
    new Intl.DateTimeFormat('fr-FR', { timeZone: String(value) });
    return true;
  } catch {
    return false;
  }
}

/**
 * L'heure actuelle (dans le fuseau de la plage) est-elle dans la plage `scheduleStart` → `scheduleEnd` ?
 * Pas de plage configurée (ou désactivée) = toujours actif. Gère les plages qui traversent minuit
 * (ex. 22:00 → 06:00). Partagé par les tickets (auto-clôture/reping) et la whitelist vocale.
 * @param {{ scheduleEnabled: boolean, scheduleStart: string|null, scheduleEnd: string|null, scheduleTimezone?: string }} settings
 */
function isWithinSchedule(settings, now = new Date()) {
  if (!settings.scheduleEnabled || !settings.scheduleStart || !settings.scheduleEnd) return true;
  try {
    const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: settings.scheduleTimezone || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(now);
    const [hh, mm] = formatted.split(':').map(Number);
    const minutes = hh * 60 + mm;
    const [sh, sm] = String(settings.scheduleStart).split(':').map(Number);
    const [eh, em] = String(settings.scheduleEnd).split(':').map(Number);
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    if (start === end) return true;
    if (start < end) return minutes >= start && minutes < end;
    return minutes >= start || minutes < end;
  } catch {
    return true;
  }
}

module.exports = { isTime, isTimezone, isWithinSchedule };
