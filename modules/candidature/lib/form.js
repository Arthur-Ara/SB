'use strict';

const { ActionRowBuilder, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const ui = require('../../../src/bot/ui');

/** Discord : 5 champs au plus par fenêtre, libellé ≤ 45 caractères, texte d'exemple ≤ 100, réponse ≤ 4000. */
const MAX_QUESTIONS = 5;

function bounded(value, fallback, max) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

/** Questions saisies sur le panel web → liste propre. `minLength` / `maxLength` sont aussi contrôlés par le bot. */
function normalizeQuestions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((q) => {
      const paragraph = q?.style === 'paragraph';
      const maxLength = bounded(q?.maxLength, paragraph ? 1000 : 200, 4000);
      return {
        label: String(q?.label ?? '').trim().slice(0, 45),
        placeholder: String(q?.placeholder ?? '').trim().slice(0, 100),
        style: paragraph ? 'paragraph' : 'short',
        required: q?.required !== false,
        minLength: Math.min(bounded(q?.minLength, 0, 4000), maxLength),
        maxLength,
      };
    })
    .filter((q) => q.label)
    .slice(0, MAX_QUESTIONS);
}

/** Le formulaire de cette catégorie est-il actif (activé ET au moins une question) ? */
function hasForm(category) {
  return Boolean(Number(category?.form_enabled)) && normalizeQuestions(category.form_questions).length > 0;
}

function formModal(category, customId) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle((category.form_title || category.label || 'Candidature').slice(0, 45));
  normalizeQuestions(category.form_questions).forEach((q, index) => {
    const input = new TextInputBuilder()
      .setCustomId(`q${index}`)
      .setLabel(q.label)
      .setStyle(q.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(q.required)
      .setMaxLength(q.maxLength);
    if (q.minLength) input.setMinLength(q.minLength);
    if (q.placeholder) input.setPlaceholder(q.placeholder);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  });
  return modal;
}

/** Réponses d'une fenêtre soumise : [{ question, answer }] (réponses vides ignorées). */
function readAnswers(interaction, category) {
  return normalizeQuestions(category.form_questions)
    .map((q, index) => {
      let answer = '';
      try {
        answer = interaction.fields.getTextInputValue(`q${index}`) ?? '';
      } catch {
        answer = '';
      }
      return { question: q.label, answer: answer.trim() };
    })
    .filter((entry) => entry.answer);
}

function answersEmbed(answers) {
  if (!answers?.length) return null;
  return new EmbedBuilder()
    .setColor(ui.DARK)
    .setTitle('・ Réponses au formulaire')
    .addFields(answers.slice(0, 25).map((entry) => ({ name: entry.question.slice(0, 256), value: entry.answer.slice(0, 1024) || '—' })));
}

module.exports = { MAX_QUESTIONS, normalizeQuestions, hasForm, formModal, readAnswers, answersEmbed };
