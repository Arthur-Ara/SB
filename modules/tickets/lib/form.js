'use strict';

const { ActionRowBuilder, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const ui = require('../../../src/bot/ui');

/** Discord : 5 champs au plus par fenêtre, libellé ≤ 45 caractères, texte d'exemple ≤ 100, réponse ≤ 4000. */
const MAX_QUESTIONS = 5;

/** Questions saisies sur le panel web → liste propre (vides ignorées, limites de Discord appliquées). */
function normalizeQuestions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((q) => ({
      label: String(q?.label ?? '').trim().slice(0, 45),
      placeholder: String(q?.placeholder ?? '').trim().slice(0, 100),
      style: q?.style === 'paragraph' ? 'paragraph' : 'short',
      required: q?.required !== false,
      maxLength: Math.min(Math.max(parseInt(q?.maxLength, 10) || (q?.style === 'paragraph' ? 1000 : 200), 1), 4000),
    }))
    .filter((q) => q.label)
    .slice(0, MAX_QUESTIONS);
}

/** Le formulaire de ce type est-il actif (activé ET au moins une question) ? */
function hasForm(type) {
  return Boolean(Number(type?.form_enabled)) && normalizeQuestions(type.form_questions).length > 0;
}

/** Fenêtre Discord posant les questions du type (customId fourni par l'appelant : tickets ou support). */
function formModal(type, customId) {
  const questions = normalizeQuestions(type.form_questions);
  const modal = new ModalBuilder().setCustomId(customId).setTitle((type.form_title || type.label || 'Ouvrir un ticket').slice(0, 45));
  questions.forEach((q, index) => {
    const input = new TextInputBuilder()
      .setCustomId(`q${index}`)
      .setLabel(q.label)
      .setStyle(q.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(q.required)
      .setMaxLength(q.maxLength);
    if (q.placeholder) input.setPlaceholder(q.placeholder);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  });
  return modal;
}

/** Réponses d'une fenêtre soumise : [{ question, answer }] (réponses vides des questions facultatives ignorées). */
function readAnswers(interaction, type) {
  return normalizeQuestions(type.form_questions)
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

/** Embed sombre récapitulant les réponses, affiché dans le message d'accueil du ticket. */
function answersEmbed(answers) {
  if (!answers?.length) return null;
  return new EmbedBuilder()
    .setColor(ui.DARK)
    .setTitle('・ Réponses au formulaire')
    .addFields(answers.slice(0, 25).map((entry) => ({ name: entry.question.slice(0, 256), value: entry.answer.slice(0, 1024) || '—' })));
}

module.exports = { MAX_QUESTIONS, normalizeQuestions, hasForm, formModal, readAnswers, answersEmbed };
