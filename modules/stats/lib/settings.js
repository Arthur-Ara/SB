'use strict';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Paramètres du module, lus depuis le .env (préfixe STATS_). */
function loadSettings(env) {
  return {
    storeMessageContent: env.bool('STATS_STORE_MESSAGE_CONTENT', false),
    backfillDays: clamp(env.int('STATS_BACKFILL_DAYS', 7), 0, 30),
    snapshotIntervalMinutes: clamp(env.int('STATS_SNAPSHOT_INTERVAL_MINUTES', 60), 5, 1440),
    voiceExcludeAfk: env.bool('STATS_VOICE_EXCLUDE_AFK', true),
    // Contenu des messages effacé (métadonnées conservées) au-delà de ce nombre de jours ; 0 (défaut) = jamais effacé.
    // Pas de valeur par défaut destructrice : l'effacement est irréversible, c'est à l'administrateur de le choisir.
    contentRetentionDays: clamp(env.int('STATS_CONTENT_RETENTION_DAYS', 0), 0, 3650),
  };
}

module.exports = { loadSettings };
