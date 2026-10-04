'use strict';

const ui = require('../../../src/bot/ui');
const { SCOPE_LABEL } = require('./constants');
const { formatDuration } = require('./duration');

const PREVIEW_ITEMS = 10;
const RESULT_ITEMS = 12;

function executorText(item) {
  return item.executorId ? `<@${item.executorId}>` : '*auteur inconnu*';
}

/** Une ligne de plan ou de rapport. Mentions et dates restent hors des blocs de code (elles n'y fonctionnent pas). */
function itemLine(item, icon, extra = '') {
  const notes = item.notes.length ? ` *(${item.notes.join(' · ')})*` : '';
  return `${icon} ${item.title} — ${executorText(item)} · ${ui.ts(item.at, 'R')}${notes}${extra}`;
}

function scopeHeader(plan) {
  const lines = [`Période : **${formatDuration(plan.windowS)}** (depuis ${ui.ts(plan.since, 'f')})`];
  if (plan.targetUserId) lines.push(`🎯 Actions de <@${plan.targetUserId}> uniquement`);
  return lines.join('\n');
}

/** Aperçu d'un rollback : ce qui sera annulé, ce qui sera ignoré (et pourquoi), avertissements. */
function previewCard(plan, { simulation = false } = {}) {
  const { stats } = plan;
  const body = [
    {
      stats: [
        ['Type', SCOPE_LABEL[plan.scope]],
        ['À annuler', stats.ok],
        ['Ignorées', stats.skipped],
        ['Destructives', stats.destructive],
        ['Auteur inconnu', stats.unknownExecutor],
      ],
    },
  ];

  const ok = plan.items.filter((item) => item.status === 'ok');
  if (ok.length) {
    const lines = ok.slice(0, PREVIEW_ITEMS).map((item) => itemLine(item, item.destructive ? '🗑️' : '↩️'));
    if (ok.length > PREVIEW_ITEMS) lines.push(`… et **${ok.length - PREVIEW_ITEMS}** autre(s)`);
    body.push(`\n**À annuler** (du plus récent au plus ancien)\n${lines.join('\n')}`);
  } else {
    body.push('\n*Rien à annuler sur cette période.*');
  }

  if (stats.reasons.length) {
    body.push(`\n**Ignorées**\n${stats.reasons.slice(0, 6).map(([reason, count]) => `• ${reason} × ${count}`).join('\n')}`);
  }
  for (const warning of plan.warnings) body.push(`\n⚠️ ${warning}`);
  if (plan.tooMany) body.push('\n⛔ **Trop d’actions pour un seul rollback** : réduis la durée ou cible un utilisateur.');

  return ui.card({
    title: `⏪ Rollback — ${SCOPE_LABEL[plan.scope]}`,
    description: scopeHeader(plan),
    body,
    footer: simulation ? 'Simulation : rien n’a été modifié.' : 'Aperçu : rien n’a encore été modifié.',
  });
}

function progressCard({ index, total, item }) {
  const bar = '▰'.repeat(Math.round((index / Math.max(total, 1)) * 10)).padEnd(10, '▱');
  return ui.card({
    title: '⏪ Rollback en cours',
    description: `${bar} **${index}/${total}**\n${item ? itemLine(item, item.status === 'done' ? '✅' : item.status === 'failed' ? '❌' : '⏭️') : ''}`,
    footer: 'Le bouton « Arrêter » interrompt le rollback après l’action en cours.',
  });
}

/** Rapport final (réponse à l'auteur de la commande). */
function resultCard(result) {
  const done = result.items.filter((item) => item.status === 'done');
  const failed = result.items.filter((item) => item.status === 'failed');
  const body = [
    {
      stats: [
        ['Annulées', result.applied],
        ['Ignorées', result.skipped],
        ['Échecs', result.failed],
        ['Non exécutées', result.cancelled],
      ],
    },
  ];
  if (done.length) {
    const lines = done.slice(0, RESULT_ITEMS).map((item) => itemLine(item, '✅'));
    if (done.length > RESULT_ITEMS) lines.push(`… et **${done.length - RESULT_ITEMS}** autre(s)`);
    body.push(`\n**Annulées**\n${lines.join('\n')}`);
  }
  if (failed.length) {
    body.push(`\n**Échecs**\n${failed.slice(0, 8).map((item) => itemLine(item, '❌', ` — ${item.reason}`)).join('\n')}`);
  }
  if (result.aborted) body.push(`\n⚠️ Rollback interrompu : ${result.aborted}.`);
  return ui.card({
    title: `⏪ Rollback n°${result.batchId} — ${result.aborted ? 'interrompu' : 'terminé'}`,
    body,
    footer: 'Rapport complet : /rollbackhistory',
  });
}

/** Carte du salon de journal : une au lancement, une à la fin. */
function logCard({ phase, batchId, invokerId, plan, result }) {
  const lines = [
    phase === 'start' ? `⏪ **Rollback #${batchId} lancé**` : `⏪ **Rollback #${batchId} ${result.aborted ? 'interrompu' : 'terminé'}**`,
    `🛠️ Par : <@${invokerId}>`,
    `🎯 Type : ${SCOPE_LABEL[plan.scope]} · période ${formatDuration(plan.windowS)}${plan.targetUserId ? ` · actions de <@${plan.targetUserId}>` : ''}`,
  ];
  if (phase === 'start') {
    lines.push(`📋 ${plan.stats.ok} action(s) prévue(s)${plan.stats.destructive ? ` dont ${plan.stats.destructive} destructive(s)` : ''}`);
  } else {
    lines.push(
      `✅ ${result.applied} annulée(s) · ⏭️ ${result.skipped} ignorée(s) · ❌ ${result.failed} échec(s)${result.cancelled ? ` · ⏹️ ${result.cancelled} non exécutée(s)` : ''}`,
    );
    if (result.aborted) lines.push(`⚠️ ${result.aborted}`);
  }
  return ui.card({ description: lines.join('\n'), timestamp: true });
}

module.exports = { previewCard, progressCard, resultCard, logCard };
