'use strict';

// Module Candidatures : contrôle automatique des critères (fonctions pures), statuts et formulaire.
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCriteria, hasCriteria, checkCriteria, splitSections, criteriaSummary } = require('../modules/candidature/lib/criteria');
const { STATUSES, RECRUITER_STATUSES, isFinal, timeline } = require('../modules/candidature/lib/statuses');
const { normalizeQuestions } = require('../modules/candidature/lib/form');

const DAY = 24 * 60 * 60 * 1000;

test('critères : normalisation, bornes et valeurs invalides ignorées', () => {
  const c = normalizeCriteria({ minChars: '250', maxChars: -3, minMessages: 'abc', requiredKeywords: 'motivation, disponibilités\nâge', requiredRoleIds: ['123', '123456789012345678'] });
  assert.equal(c.minChars, 250);
  assert.equal(c.maxChars, 0);
  assert.equal(c.minMessages, 0);
  assert.deepEqual(c.requiredKeywords, ['motivation', 'disponibilités', 'âge']);
  assert.deepEqual(c.requiredRoleIds, ['123456789012345678']);
  assert.deepEqual(c.sections, []);
  assert.equal(hasCriteria({}), false);
  assert.equal(hasCriteria({ sections: [{ name: 'Présentation' }] }), true);
  assert.equal(hasCriteria({}, [{ label: 'Q', minLength: 10 }]), true);
});

test('critères : parties dédoublonnées (casse, accents) et bornes', () => {
  const { sections } = normalizeCriteria({ sections: [{ name: ' Présentation ', minChars: 50 }, { name: 'presentation' }, { name: '' }, { name: 'Motivations', required: false, minChars: 900, maxChars: 300 }] });
  assert.deepEqual(sections, [
    { name: 'Présentation', minChars: 50, maxChars: 0, required: true },
    { name: 'Motivations', minChars: 300, maxChars: 300, required: false },
  ]);
});

test('parties : titres reconnus (gras, Markdown, puce, « Nom : »), phrases ordinaires ignorées', () => {
  const sections = normalizeCriteria({ sections: [{ name: 'Présentation' }, { name: 'Motivations' }, { name: 'Expérience' }, { name: 'Expérience staff' }] }).sections;
  const text = [
    'Bonjour !',
    '**Présentation** : Arthur, 19 ans.',
    'J’aime le code.',
    '## motivations',
    'Aider la communauté.',
    'Motivations profondes : non, ceci est une phrase.',
    '- Expérience staff - deux ans',
    '1. Experience : aucune autre',
  ].join('\n');
  const parts = splitSections(text, sections);
  assert.equal(parts.get('Présentation'), 'Arthur, 19 ans.\nJ’aime le code.');
  assert.equal(parts.get('Motivations'), 'Aider la communauté.\nMotivations profondes : non, ceci est une phrase.');
  assert.equal(parts.get('Expérience staff'), 'deux ans');
  assert.equal(parts.get('Expérience'), 'aucune autre');
});

test('contrôle : candidature conforme', () => {
  const result = checkCriteria({
    criteria: { minChars: 20, minMessages: 2, requiredKeywords: ['disponibilites'], sections: [{ name: 'Présentation', minChars: 10 }] },
    messages: ['Présentation : je suis Arthur, étudiant.', 'Mes disponibilités : le soir.'],
    attachments: 0,
  });
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
  assert.equal(result.stats.messages, 2);
});

test('contrôle : chaque élément non respecté est listé', () => {
  const now = Date.now();
  const result = checkCriteria({
    criteria: {
      minChars: 500,
      minMessages: 3,
      minAttachments: 1,
      requiredKeywords: ['motivation'],
      forbiddenWords: ['nul'],
      minAccountAgeDays: 30,
      minMemberDays: 7,
      requiredRoleIds: ['111111111111111111'],
      forbiddenRoleIds: ['222222222222222222'],
      sections: [{ name: 'Présentation', minChars: 100 }, { name: 'Disponibilités' }, { name: 'Bonus', required: false }],
    },
    questions: [{ label: 'Âge', minLength: 2 }],
    answers: [{ question: 'Âge', answer: '9' }],
    messages: ['Présentation : court. Ce serveur est nul.'],
    attachments: 0,
    accountCreatedAt: now - 2 * DAY,
    joinedAt: now - DAY,
    roleIds: ['222222222222222222'],
    now,
  });
  assert.equal(result.ok, false);
  const text = result.failures.join('\n');
  for (const expected of ['trop courte', 'Pas assez de messages', 'Pièces jointes', '« Âge »', '« motivation »', '« nul »', 'Partie « Présentation » trop courte', 'Partie « Disponibilités » absente', 'Compte Discord trop récent', 'Ancienneté sur le serveur', 'Rôle(s) requis', 'incompatible']) {
    assert.ok(text.includes(expected), `attendu : ${expected}\n${text}`);
  }
  assert.ok(!text.includes('Bonus'), 'une partie facultative absente ne doit pas être signalée');
});

test('contrôle : mot interdit = mot entier, accents ignorés', () => {
  const criteria = { forbiddenWords: ['con'] };
  assert.equal(checkCriteria({ criteria, messages: ['Je connais bien le serveur.'] }).ok, true);
  assert.equal(checkCriteria({ criteria, messages: ['Quel CON !'] }).ok, false);
  assert.equal(checkCriteria({ criteria: { requiredKeywords: ['experience'] }, messages: ['Mon EXPÉRIENCE'] }).ok, true);
});

test('rappel des critères pour le candidat', () => {
  const summary = criteriaSummary({ minChars: 300, sections: [{ name: 'Présentation', minChars: 100 }, { name: 'Bonus', required: false }] }, [{ label: 'Pseudo', maxLength: 32 }]);
  assert.match(summary, /\*\*Présentation\*\* — 100 car\. min/);
  assert.match(summary, /\*\*Bonus\*\* \(facultative\)/);
  assert.match(summary, /Longueur totale : 300 caractères min/);
  assert.match(summary, /Formulaire « Pseudo » : 32 max/);
  assert.equal(criteriaSummary({}), '');
});

test('statuts : les six statuts demandés, dans l’ordre, modifiables par les recruteurs', () => {
  assert.deepEqual(RECRUITER_STATUSES.map((key) => STATUSES[key].label), ['En attente', 'Prise en compte', 'En traitement', 'Attente entretien', 'Acceptée', 'Refusée']);
  assert.equal(isFinal('accepted'), true);
  assert.equal(isFinal('refused'), true);
  assert.equal(isFinal('interview'), false);
  assert.match(timeline('processing'), /\*\*⚙️ En traitement\*\*/);
  assert.match(timeline('refused'), /\*\*❌ Refusée\*\*$/);
});

test('formulaire : questions normalisées (5 au plus, min ≤ max)', () => {
  const questions = normalizeQuestions([...Array(7)].map((_, i) => ({ label: `Q${i}`, style: 'paragraph', minLength: 5000, maxLength: 300 })));
  assert.equal(questions.length, 5);
  assert.equal(questions[0].maxLength, 300);
  assert.equal(questions[0].minLength, 300);
  assert.deepEqual(normalizeQuestions([{ label: '  ' }]), []);
});
