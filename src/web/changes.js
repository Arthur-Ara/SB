'use strict';

/**
 * Détail des modifications faites depuis le panel web, pour les journaux (salon de journal Discord et journal
 * d'activité du panel) : « **Libellé** : ancienne valeur → nouvelle valeur », uniquement pour les champs qui ont
 * réellement changé. Les routes passent la ligne en base avant modification et le correctif (noms de colonnes).
 */

/** Libellés des colonnes communes aux modules (repli : nom de colonne lisible). */
const LABELS = {
  label: 'Libellé',
  name: 'Nom',
  emoji: 'Émoji',
  style: 'Style',
  button_style: 'Couleur du bouton',
  select_description: 'Description (sélecteur)',
  placeholder: 'Texte du menu',
  category_id: 'Catégorie Discord',
  channel_id: 'Salon',
  log_channel_id: 'Salon de journal',
  max_open: 'Limite en cours',
  channel_name_pattern: 'Nom du salon',
  claimed_channel_name_pattern: 'Nom du salon (pris en charge)',
  closed_channel_name_pattern: 'Nom du salon (fermé)',
  title: 'Titre',
  description: 'Description',
  color: 'Couleur',
  footer: 'Pied de page',
  image: 'Image',
  thumbnail: 'Vignette',
  open_title: 'Titre du panel',
  open_description: 'Description du panel',
  open_color: 'Couleur du panel',
  open_footer: 'Pied de page du panel',
  open_image: 'Image du panel',
  open_thumbnail: 'Vignette du panel',
  opened_title: 'Titre du message d’ouverture',
  opened_description: 'Description du message d’ouverture',
  opened_color: 'Couleur du message d’ouverture',
  opened_footer: 'Pied du message d’ouverture',
  opened_image: 'Image du message d’ouverture',
  opened_thumbnail: 'Vignette du message d’ouverture',
  embed_title: 'Titre',
  embed_description: 'Description',
  embed_color: 'Couleur',
  embed_footer: 'Pied de page',
  embed_image: 'Image',
  embed_thumbnail: 'Vignette',
  mod_role_ids: 'Rôles modérateur',
  recruiter_role_ids: 'Rôles recruteurs',
  notify_role_ids: 'Rôles notifiés',
  helper_role_ids: 'Rôles helper',
  reping_role_ids: 'Rôles repingés',
  allowed_role_ids: 'Rôles autorisés',
  accept_role_ids: 'Rôles à l’acceptation',
  reping_same_as_notify: 'Repinger les rôles notifiés',
  reping_message: 'Message de reping',
  close_on_leave: 'Fermeture si le membre part',
  auto_transcript: 'Transcript automatique',
  transcript_prompt: 'Proposer le transcript',
  live_transcript: 'Transcript live',
  user_can_close: 'Fermeture par l’ouvreur',
  rating_enabled: 'Notation',
  claim_required: 'Prise en charge obligatoire',
  auto_close_minutes: 'Clôture automatique (min)',
  reping_minutes: 'Reping (min)',
  auto_delete_hours: 'Suppression du salon (h)',
  form_enabled: 'Formulaire',
  form_title: 'Titre du formulaire',
  form_questions: 'Questions du formulaire',
  schedule_enabled: 'Plage horaire',
  schedule_start: 'Début de plage',
  schedule_end: 'Fin de plage',
  schedule_timezone: 'Fuseau horaire',
  allow_ticket: 'Proposer un ticket',
  ticket_type_id: 'Type de ticket',
  ticket_extra_message: 'Message pour le staff',
  cooldown_days: 'Délai de représentation (j)',
  accept_message: 'Message d’acceptation',
  accept_invite_guild_id: 'Serveur d’invitation',
  accept_invite_hours: 'Validité de l’invitation (h)',
  refusal_reason_required: 'Refus motivé obligatoire',
  auto_replies: 'Réponses automatiques',
};

const BOOLEAN_KEYS = /(^|_)(enabled|required|removable|only)$|^(auto_transcript|transcript_prompt|live_transcript|user_can_close|close_on_leave|allow_ticket|reping_same_as_notify)$/;
const MAX_LINES = 15;

function parse(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!/^[[{]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/** Valeur comparable : JSON parsé, listes d'IDs triées, vide = null, nombres et booléens en texte. */
function normalize(key, value) {
  const v = parse(value);
  if (v === undefined || v === null || v === '') return null;
  if (Array.isArray(v)) {
    const list = v.every((item) => typeof item !== 'object') ? v.map(String).sort() : v;
    return list.length ? JSON.stringify(list) : null;
  }
  if (typeof v === 'object') return Object.keys(v).length ? JSON.stringify(v) : null;
  if (BOOLEAN_KEYS.test(key)) return v === true || v === 1 || v === '1' ? '1' : '0';
  return String(v);
}

function short(text, max = 60) {
  const single = String(text).replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/** Valeur lisible dans un message Discord (mentions de rôles et de salons, oui/non, texte raccourci). */
function display(key, value) {
  const v = parse(value);
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return '*vide*';
  if (BOOLEAN_KEYS.test(key)) return v === true || v === 1 || v === '1' ? 'oui' : 'non';
  if (/role_ids$/.test(key) && Array.isArray(v)) return v.map((id) => `<@&${id}>`).join(' ');
  if (/role_id$/.test(key)) return `<@&${v}>`;
  if (/(^|_)(channel_id|category_id)$/.test(key)) return `<#${v}>`;
  if (Array.isArray(v)) return `${v.length} élément(s)`;
  if (typeof v === 'object') return `${Object.keys(v).length} élément(s)`;
  if (typeof v === 'number' || /^\d{1,9}$/.test(String(v))) return String(v);
  return `« ${short(v)} »`;
}

function labelOf(key, labels) {
  return labels[key] ?? LABELS[key] ?? key.replace(/_/g, ' ');
}

/**
 * @param {object} before  ligne avant modification (colonnes en base)
 * @param {object} patch   colonnes modifiées → nouvelles valeurs
 * @param {object} [labels] libellés propres à la route (prioritaires sur LABELS)
 * @returns {string[]} une ligne par champ réellement modifié
 */
function describeChanges(before, patch, labels = {}) {
  const lines = [];
  for (const [key, value] of Object.entries(patch ?? {})) {
    const old = before?.[key];
    if (normalize(key, old) === normalize(key, value)) continue;
    const oldText = display(key, old);
    const newText = display(key, value);
    // Long texte modifié : l'ancien et le nouveau sont tronqués, on signale simplement la modification.
    const long = typeof parse(value) === 'string' && String(value).length > 60 && typeof parse(old) === 'string' && String(old ?? '').length > 60;
    lines.push(long ? `• **${labelOf(key, labels)}** : modifié (${newText})` : `• **${labelOf(key, labels)}** : ${oldText} → ${newText}`);
  }
  if (lines.length > MAX_LINES) return [...lines.slice(0, MAX_LINES), `• … et ${lines.length - MAX_LINES} autre(s) champ(s)`];
  return lines;
}

/** Texte de journal : « résumé » suivi du détail, ou « (aucun changement) ». */
function withChanges(summary, lines) {
  return lines.length ? `${summary}\n${lines.join('\n')}` : `${summary} (aucun changement)`;
}

/**
 * Enregistre le détail pour le journal d'activité du panel (lu par web/activity.js à la fin de la requête). Les
 * mentions Discord sont gardées telles quelles : la page Activité les affiche en texte.
 */
function noteActivity(req, text) {
  if (req?.res?.locals) req.res.locals.activityDetail = String(text).replace(/\*\*/g, '').slice(0, 2000);
}

module.exports = { LABELS, describeChanges, withChanges, noteActivity, normalize };
