'use strict';

/**
 * Statuts d'une candidature. `draft` (en rédaction) est le seul statut interne : le candidat écrit encore sa candidature
 * dans son salon. Les six statuts demandés suivent, dans l'ordre du parcours ; « retirée » est le retrait volontaire.
 */
const STATUSES = {
  draft: { label: 'En rédaction', emoji: '📝', final: false },
  pending: { label: 'En attente', emoji: '⏳', final: false },
  acknowledged: { label: 'Prise en compte', emoji: '👀', final: false },
  processing: { label: 'En traitement', emoji: '⚙️', final: false },
  interview: { label: 'Attente entretien', emoji: '🎤', final: false },
  accepted: { label: 'Acceptée', emoji: '✅', final: true },
  refused: { label: 'Refusée', emoji: '❌', final: true },
  withdrawn: { label: 'Retirée', emoji: '↩️', final: true },
};

/** Statuts que les recruteurs peuvent donner (commande, menu du salon, panel web), dans l'ordre du parcours. */
const RECRUITER_STATUSES = ['pending', 'acknowledged', 'processing', 'interview', 'accepted', 'refused'];

/** Étapes affichées dans la frise de /candidature status. */
const STEPS = ['pending', 'acknowledged', 'processing', 'interview'];

const FINAL_STATUSES = Object.keys(STATUSES).filter((key) => STATUSES[key].final);
const ACTIVE_STATUSES = Object.keys(STATUSES).filter((key) => !STATUSES[key].final);

function isFinal(status) {
  return Boolean(STATUSES[status]?.final);
}

function statusLabel(status) {
  const def = STATUSES[status];
  return def ? `${def.emoji} ${def.label}` : String(status);
}

/** Frise du parcours : « ⏳ En attente › **👀 Prise en compte** › … › ✅/❌ » (l'étape courante en gras). */
function timeline(status) {
  if (status === 'draft') return `**${statusLabel('draft')}** › ${STEPS.map(statusLabel).join(' › ')}`;
  if (status === 'withdrawn') return statusLabel('withdrawn');
  const parts = STEPS.map((step) => (step === status ? `**${statusLabel(step)}**` : statusLabel(step)));
  parts.push(status === 'accepted' ? '**✅ Acceptée**' : status === 'refused' ? '**❌ Refusée**' : '✅ Acceptée / ❌ Refusée');
  return parts.join(' › ');
}

module.exports = { STATUSES, RECRUITER_STATUSES, STEPS, FINAL_STATUSES, ACTIVE_STATUSES, isFinal, statusLabel, timeline };
