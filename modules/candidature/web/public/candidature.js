/* Panel web du module Candidatures : candidatures en cours, historique par candidat, catégories, réglages. */
(function () {
  'use strict';

  var el = Core.el;
  var fmt = Core.fmt;
  var API = '/m/candidature/api';
  var main = document.getElementById('main');
  var guildId = '';
  var data = null;
  var expandedPanels = new Set();
  var expandedCategories = new Set();
  var historyFilters = { applicant: '', status: '', category: '', scope: 'all', page: 1 };
  var history = null;

  var PLACEHOLDERS = '{user} (mention) · {username} · {category} · {id} (#42) · {number} (0042) · {status} · {reason} · {retry} (délai de représentation) · {recruiters} · {server}';

  function showError(message) {
    var box = document.getElementById('error');
    box.textContent = message || '';
    box.hidden = !message;
    if (message) box.scrollIntoView({ block: 'nearest' });
  }

  function call(method, path, body) {
    return Core.request(method, API + path, body);
  }

  function query() {
    return '?guild=' + encodeURIComponent(guildId);
  }

  async function refresh(promise) {
    showError('');
    main.classList.add('is-loading');
    try {
      data = await promise;
      renderAll();
      return true;
    } catch (err) {
      showError(err.message);
      return false;
    } finally {
      main.classList.remove('is-loading');
    }
  }

  // ── Petits composants ──────────────────────────────────────────────────────
  function personEl(person, onclick) {
    if (!person) return el('span', { class: 'muted', text: '—' });
    return el(
      onclick ? 'button' : 'span',
      { type: onclick ? 'button' : null, class: 'person' + (onclick ? ' person-link' : ''), onclick: onclick || null, title: onclick ? 'Voir toutes ses candidatures' : null },
      el('img', { src: person.avatar, alt: '', loading: 'lazy' }),
      el('span', { text: person.name + (person.inGuild ? '' : ' (parti)'), title: person.username ? '@' + person.username : person.id }),
    );
  }

  function statusOf(key) {
    return data.statuses.find(function (s) { return s.key === key; }) || { key: key, label: key, emoji: '' };
  }

  function statusBadge(key) {
    var s = statusOf(key);
    return el('span', { class: 'cand-status cand-status-' + key, text: s.emoji + ' ' + s.label });
  }

  function categoryLabel(id) {
    var found = data.categories.find(function (c) { return String(c.id) === String(id); });
    return found ? (found.emoji ? found.emoji + ' ' : '') + found.label : 'Catégorie supprimée';
  }

  function transcriptLink(id) {
    return '/m/candidature/transcript?candidature=' + encodeURIComponent(id);
  }

  function channelLink(c) {
    return 'https://discord.com/channels/' + guildId + '/' + c.channelId;
  }

  function table(columns, rows, emptyText) {
    columns = columns.filter(Boolean);
    if (!rows.length) return el('div', { class: 'empty', text: emptyText || 'Rien à afficher.' });
    return el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        { class: 'data' },
        el('thead', {}, el('tr', {}, columns.map(function (col) { return el('th', { class: col.cls || null, text: col.label }); }))),
        el('tbody', {}, rows.map(function (row) {
          return el('tr', {}, columns.map(function (col) {
            var value = col.value(row);
            return el('td', { class: col.cls || null }, value instanceof Node ? value : String(value === null || value === undefined ? '—' : value));
          }));
        })),
      ),
    );
  }

  function tile(label, value, sub) {
    return el('div', { class: 'tile' }, el('div', { class: 'tile-label', text: label }), el('div', { class: 'tile-value', text: value }), sub ? el('div', { class: 'tile-sub', text: sub }) : null);
  }

  function options(list, selected, emptyLabel) {
    var nodes = emptyLabel !== undefined ? [el('option', { value: '', text: emptyLabel })] : [];
    list.forEach(function (item) { nodes.push(el('option', { value: item.value, text: item.text })); });
    var select = el('select', {}, nodes);
    select.value = selected === null || selected === undefined ? '' : String(selected);
    return select;
  }

  function numberInput(value, max, placeholder) {
    return el('input', { type: 'number', min: '0', max: String(max), step: '1', value: value ? String(value) : '', placeholder: placeholder || '—' });
  }

  function intValue(input) {
    var n = parseInt(input.value, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // ── Actions sur une candidature (statut, catégorie, salon) ───────────────────
  /**
   * Change le statut. Refus : motif demandé (obligatoire si l'admin l'exige) ; acceptation : précision facultative.
   * `after` est appelé avec l'état renvoyé par le serveur.
   */
  function changeStatus(candidature, status, after) {
    var ask = status === 'refused' || status === 'accepted';
    var required = status === 'refused' && data.settings.refusalReasonRequired;
    var reasonPromise = ask
      ? Core.prompt(status === 'refused' ? 'Motif du refus' + (required ? ' (obligatoire)' : ' (facultatif)') : 'Précision pour le candidat (facultatif)', {
          title: statusOf(status).emoji + ' ' + statusOf(status).label + ' — candidature #' + candidature.id,
          placeholder: status === 'refused' ? 'Ex. : expérience insuffisante, candidature incomplète…' : 'Ex. : bienvenue dans l’équipe !',
          maxlength: '900',
          confirmLabel: statusOf(status).label,
        })
      : Promise.resolve('');
    return reasonPromise.then(function (reason) {
      if (reason === null) return null;
      if (required && !reason) {
        showError('Le refus doit être motivé : indique la raison.');
        return null;
      }
      return refresh(call('POST', '/candidatures/' + candidature.id + '/status' + query(), { status: status, reason: reason || null })).then(after || null);
    });
  }

  function statusControl(candidature) {
    var select = options(
      data.statuses.filter(function (s) { return s.recruiter; }).map(function (s) { return { value: s.key, text: s.emoji + ' ' + s.label }; }),
      candidature.status === 'draft' ? '' : candidature.status,
      candidature.status === 'draft' ? '📝 En rédaction…' : undefined,
    );
    select.setAttribute('aria-label', 'Statut de la candidature #' + candidature.id);
    select.addEventListener('change', function () {
      if (!select.value || select.value === candidature.status) return;
      var chosen = select.value;
      select.value = candidature.status === 'draft' ? '' : candidature.status;
      changeStatus(candidature, chosen);
    });
    return select;
  }

  function moveControl(candidature) {
    var others = data.categories.filter(function (c) { return String(c.id) !== String(candidature.categoryId); });
    if (!others.length) return null;
    var select = options(others.map(function (c) { return { value: c.id, text: (c.emoji ? c.emoji + ' ' : '') + c.label }; }), '', '🔀 Changer de catégorie…');
    select.setAttribute('aria-label', 'Changer la catégorie de la candidature #' + candidature.id);
    select.addEventListener('change', function () {
      var target = select.value;
      select.value = '';
      if (!target) return;
      Core.confirm('Déplacer la candidature #' + candidature.id + ' vers « ' + categoryLabel(target) + ' » ? Le salon change de catégorie Discord et de recruteurs.', { confirmLabel: 'Déplacer', danger: false }).then(function (ok) {
        if (ok) refresh(call('POST', '/candidatures/' + candidature.id + '/category' + query(), { categoryId: target }));
      });
    });
    return select;
  }

  function deleteChannelButton(candidature, after) {
    return el('button', {
      type: 'button',
      class: 'btn btn-danger btn-small',
      text: '🗑️ Supprimer le salon',
      onclick: function () {
        Core.confirm('Supprimer le salon de la candidature #' + candidature.id + ' ? La candidature et sa transcription restent consultables ici.').then(function (ok) {
          if (ok) refresh(call('POST', '/candidatures/' + candidature.id + '/delete-channel' + query(), {})).then(after || null);
        });
      },
    });
  }

  // ── Indicateurs ─────────────────────────────────────────────────────────────
  function renderTiles() {
    var count = function (key) { return data.candidatures.filter(function (c) { return c.status === key; }).length; };
    Core.clear(document.getElementById('tiles')).append(
      tile('Panels', fmt.number(data.panels.length)),
      tile('Catégories', fmt.number(data.categories.length)),
      tile('Candidatures en cours', fmt.number(data.candidatures.length), fmt.number(count('draft')) + ' en rédaction'),
      tile('⏳ À prendre en compte', fmt.number(count('pending'))),
      tile('🎤 En attente d’entretien', fmt.number(count('interview'))),
    );
  }

  // ── Onglet « En cours » : un bloc par catégorie visible ────────────────────
  function renderActive() {
    var container = Core.clear(document.getElementById('active-blocks'));
    var visible = data.categories.filter(function (c) { return data.visibleCategoryIds.map(String).indexOf(String(c.id)) !== -1; });
    if (!data.categories.length) {
      container.append(el('div', { class: 'card empty', text: 'Aucune catégorie de candidature : crée un panel et ses catégories dans l’onglet « Panels ».' }));
      return;
    }
    if (!visible.length) {
      container.append(el('div', { class: 'card empty', text: 'Tu n’es recruteur d’aucune catégorie : aucune candidature à afficher.' }));
      return;
    }
    visible.forEach(function (category) {
      var rows = data.candidatures.filter(function (c) { return String(c.categoryId) === String(category.id); });
      var waiting = rows.filter(function (c) { return c.status === 'pending'; }).length;
      container.append(
        el(
          'section',
          { class: 'card panel-block' },
          el(
            'div',
            { class: 'panel-head' },
            el('h3', { text: (category.emoji ? category.emoji + ' ' : '') + category.label }),
            el(
              'span',
              { class: 'section-actions' },
              el('span', { class: 'badge-status' + (rows.length ? ' on' : ''), text: rows.length + ' en cours' }),
              waiting ? el('span', { class: 'badge-status warn', text: '⏳ ' + waiting + ' à prendre en compte' }) : null,
            ),
          ),
          table(
            [
              { label: '#', value: function (c) { return String(c.id); } },
              { label: 'Candidat', value: function (c) { return personEl(c.applicant, function () { openHistoryFor(c.applicant.id); }); } },
              { label: 'Statut', value: function (c) { return statusBadge(c.status); } },
              { label: 'Ouverte', value: function (c) { return fmt.dateTime(c.createdAt); } },
              { label: 'Envoyée', value: function (c) { return c.submittedAt ? fmt.dateTime(c.submittedAt) : el('span', { class: 'muted', text: 'en rédaction' }); } },
              { label: 'Changer le statut', value: statusControl },
              { label: 'Catégorie', value: function (c) { return moveControl(c) || el('span', { class: 'muted', text: '—' }); } },
              {
                label: '',
                value: function (c) {
                  return el(
                    'span',
                    { class: 'row-actions' },
                    el('a', { href: transcriptLink(c.id), target: '_blank', rel: 'noopener', text: '📄 Transcription' }),
                    c.channelExists ? el('a', { href: channelLink(c), target: '_blank', rel: 'noopener', text: '💬 Salon' }) : null,
                  );
                },
              },
            ],
            rows,
            'Aucune candidature en cours dans cette catégorie.',
          ),
        ),
      );
    });
  }

  // ── Onglet « Historique » ──────────────────────────────────────────────────
  function openHistoryFor(applicantId) {
    historyFilters = { applicant: applicantId, status: '', category: '', scope: 'all', page: 1 };
    activateTab('history');
    renderHistoryFilters();
    reloadHistory();
  }

  async function reloadHistory() {
    showError('');
    var params = new URLSearchParams({ guild: guildId, scope: historyFilters.scope, page: String(historyFilters.page) });
    if (historyFilters.applicant) params.set('applicant', historyFilters.applicant);
    if (historyFilters.status) params.set('status', historyFilters.status);
    if (historyFilters.category) params.set('category', historyFilters.category);
    try {
      history = await call('GET', '/candidatures/search?' + params.toString());
      renderHistory();
    } catch (err) {
      showError(err.message);
    }
  }

  function renderHistoryFilters() {
    var applicant = el('input', { type: 'text', inputmode: 'numeric', placeholder: 'ID Discord du candidat', value: historyFilters.applicant });
    var status = options(data.statuses.map(function (s) { return { value: s.key, text: s.emoji + ' ' + s.label }; }), historyFilters.status, 'Tous les statuts');
    var category = options(data.categories.map(function (c) { return { value: c.id, text: (c.emoji ? c.emoji + ' ' : '') + c.label }; }), historyFilters.category, 'Toutes les catégories');
    var scope = options([{ value: 'all', text: 'Toutes (en cours comprises)' }, { value: 'closed', text: 'Clôturées seulement' }], historyFilters.scope);
    Core.clear(document.getElementById('history-filters-card')).append(
      el(
        'form',
        {
          class: 'filters',
          onsubmit: function (event) {
            event.preventDefault();
            historyFilters = { applicant: applicant.value.trim(), status: status.value, category: category.value, scope: scope.value, page: 1 };
            reloadHistory();
          },
        },
        el('label', { class: 'field' }, el('span', { text: 'Candidat' }), applicant),
        el('label', { class: 'field' }, el('span', { text: 'Statut' }), status),
        el('label', { class: 'field' }, el('span', { text: 'Catégorie' }), category),
        el('label', { class: 'field' }, el('span', { text: 'Portée' }), scope),
        el('button', { type: 'submit', class: 'btn btn-primary', text: '🔎 Rechercher' }),
        el('button', {
          type: 'button',
          class: 'btn btn-ghost',
          text: 'Réinitialiser',
          onclick: function () {
            historyFilters = { applicant: '', status: '', category: '', scope: 'all', page: 1 };
            renderHistoryFilters();
            reloadHistory();
          },
        }),
      ),
    );
  }

  function reasonCell(c) {
    var parts = [];
    if (c.reason) parts.push(el('div', { class: 'cand-reason', text: c.reason }));
    if (!parts.length) return el('span', { class: 'muted', text: '—' });
    return el('div', {}, parts);
  }

  function decidedBy(c) {
    if (c.statusBy) return personEl(c.statusBy);
    if (c.auto) return el('span', { class: 'badge-status warn', text: '🤖 Automatique' });
    return el('span', { class: 'muted', text: '—' });
  }

  /** Synthèse d'un candidat (filtre « Candidat » renseigné) : nombre de candidatures par issue. */
  function renderHistorySummary() {
    var box = document.getElementById('history-summary-card');
    if (!historyFilters.applicant || !history || !history.rows.length || historyFilters.status || historyFilters.scope !== 'all') {
      box.hidden = true;
      return;
    }
    var who = history.rows[0].applicant;
    var counts = {};
    history.rows.forEach(function (c) { counts[c.status] = (counts[c.status] || 0) + 1; });
    box.hidden = false;
    Core.clear(box).append(
      el(
        'div',
        { class: 'filters' },
        personEl(who),
        el('strong', { text: fmt.number(history.total) + ' candidature(s)' }),
        Object.keys(counts).map(function (key) { return el('span', { class: 'cand-status cand-status-' + key, text: statusOf(key).emoji + ' ' + counts[key] + ' ' + statusOf(key).label.toLowerCase() }); }),
        history.pages > 1 ? el('span', { class: 'muted', text: '(page courante)' }) : null,
      ),
    );
  }

  function renderHistory() {
    renderHistorySummary();
    var pager = el(
      'div',
      { class: 'hist-pager' },
      el('button', { type: 'button', class: 'btn btn-ghost btn-small', text: '❮ Précédent', disabled: history.page <= 1, onclick: function () { historyFilters.page -= 1; reloadHistory(); } }),
      'Page ' + history.page + ' / ' + history.pages + ' · ' + fmt.number(history.total) + ' candidature(s)',
      el('button', { type: 'button', class: 'btn btn-ghost btn-small', text: 'Suivant ❯', disabled: history.page >= history.pages, onclick: function () { historyFilters.page += 1; reloadHistory(); } }),
    );
    Core.clear(document.getElementById('history-card')).append(
      table(
        [
          { label: '#', value: function (c) { return String(c.id); } },
          { label: 'Candidat', value: function (c) { return personEl(c.applicant, function () { openHistoryFor(c.applicant.id); }); } },
          { label: 'Catégorie', value: function (c) { return c.categoryLabel; } },
          { label: 'Issue', value: function (c) { return statusBadge(c.status); } },
          { label: 'Motif', value: reasonCell },
          { label: 'Décidé par', value: decidedBy },
          { label: 'Ouverte', value: function (c) { return fmt.dateTime(c.createdAt); } },
          { label: 'Clôturée', value: function (c) { return c.closedAt ? fmt.dateTime(c.closedAt) : el('span', { class: 'muted', text: 'en cours' }); } },
          {
            label: '',
            value: function (c) {
              return el(
                'span',
                { class: 'row-actions' },
                el('a', { href: transcriptLink(c.id), target: '_blank', rel: 'noopener', text: '📄 Transcription' }),
                c.final && c.channelExists ? deleteChannelButton(c) : null,
              );
            },
          },
        ],
        history.rows,
        'Aucune candidature ne correspond.',
      ),
      pager,
    );
  }

  // ── Onglet « Panels » : un panel = un message dans un salon, avec ses catégories ─
  function embedPreview(fields) {
    if (!fields.title && !fields.description) return el('div', { class: 'embed-preview empty', text: 'Aucun aperçu (titre ou description requis).' });
    var box = el(
      'div',
      { class: 'embed-preview', style: 'border-left-color:' + (fields.color || '#5865F2') },
      fields.title ? el('div', { class: 'ep-title', text: fields.title }) : null,
      fields.description ? el('div', { class: 'ep-desc', text: fields.description }) : null,
      fields.footer ? el('div', { class: 'ep-footer', text: fields.footer }) : null,
    );
    if (fields.image) box.append(el('img', { src: fields.image, alt: '' }));
    return box;
  }

  /** Champs d'un embed (titre, description, couleur, pied, image, vignette) avec aperçu ; `values()` les renvoie. */
  function embedFields(fields, extraField) {
    var title = el('input', { type: 'text', value: fields.title || '', maxlength: '256' });
    var description = el('textarea', { maxlength: '4096', rows: '4' }, fields.description || '');
    var color = el('input', { type: 'color', value: fields.color || '#2b2d31' });
    var footer = el('input', { type: 'text', value: fields.footer || '', maxlength: '2048' });
    var image = el('input', { type: 'text', placeholder: 'https://…', value: fields.image || '' });
    var thumbnail = el('input', { type: 'text', placeholder: 'https://…', value: fields.thumbnail || '' });
    var preview = el('div', {});
    function update() {
      Core.clear(preview).append(embedPreview({ title: title.value, description: description.value, color: color.value, footer: footer.value, image: image.value }));
    }
    [title, description, color, footer, image].forEach(function (input) { input.addEventListener('input', update); });
    update();
    var box = el(
      'div',
      { class: 'stack' },
      el('div', { class: 'field-row' }, el('label', { class: 'field field-grow' }, el('span', { text: 'Titre' }), title), extraField || null, el('label', { class: 'field' }, el('span', { text: 'Couleur' }), color)),
      el('label', { class: 'field' }, el('span', { text: 'Description' }), description),
      el('label', { class: 'field field-grow' }, el('span', { text: 'Pied de page' }), footer),
      el('div', { class: 'field-row' }, el('label', { class: 'field field-grow' }, el('span', { text: 'Image (URL)' }), image), el('label', { class: 'field field-grow' }, el('span', { text: 'Vignette (URL)' }), thumbnail)),
      el('label', { class: 'field' }, el('span', { text: 'Aperçu' }), preview),
    );
    box.values = function () {
      return { title: title.value.trim() || null, description: description.value.trim() || null, color: color.value || null, footer: footer.value.trim() || null, image: image.value.trim() || null, thumbnail: thumbnail.value.trim() || null };
    };
    return box;
  }

  function channelName(id) {
    var found = data.textChannels.find(function (c) { return c.id === id; });
    return found ? '#' + found.name : id;
  }

  function renderPublish(panel) {
    var select = options(data.textChannels.map(function (c) { return { value: c.id, text: '#' + c.name }; }), panel.channelId);
    var button = el('button', {
      type: 'button',
      class: 'btn btn-small',
      text: panel.messageId ? 'Republier ici' : 'Publier',
      onclick: function () {
        button.disabled = true;
        refresh(call('POST', '/panels/' + panel.id + '/publish' + query(), { channelId: select.value })).finally(function () { button.disabled = false; });
      },
    });
    return el(
      'div',
      { class: 'filters' },
      el('label', { class: 'field' }, el('span', { text: 'Salon du panel' }), select),
      button,
      el('span', { class: 'muted', text: panel.messageId ? 'Publié dans ' + channelName(panel.channelId) : 'Pas encore publié' }),
    );
  }

  function renderPanelEmbedForm(panel) {
    var style = options([{ value: 'buttons', text: 'Boutons' }, { value: 'select', text: 'Sélecteur (menu déroulant)' }], panel.style);
    var form = embedFields(panel, el('label', { class: 'field' }, el('span', { text: 'Style du panel' }), style));
    var save = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: '💾 Enregistrer l’embed du panel',
      onclick: function () {
        save.disabled = true;
        refresh(call('POST', '/panels/' + panel.id + query(), Object.assign({ style: style.value }, form.values()))).finally(function () { save.disabled = false; });
      },
    });
    return el('div', { class: 'stack' }, form, el('div', { class: 'filters' }, save));
  }

  function renderCategoryCard(panel, category) {
    var isOpen = expandedCategories.has(String(category.id));
    var problems = [];
    if (!category.categoryId) problems.push('catégorie Discord manquante');
    if (!category.recruiterRoleIds.length) problems.push('aucun recruteur');
    var head = el(
      'div',
      {
        class: 'type-head',
        onclick: function () {
          if (isOpen) expandedCategories.delete(String(category.id));
          else expandedCategories.add(String(category.id));
          renderPanels();
        },
      },
      el('h4', { text: (isOpen ? '▾ ' : '▸ ') + (category.emoji ? category.emoji + ' ' : '') + category.label }),
      el(
        'span',
        { class: 'section-actions' },
        problems.length ? el('span', { class: 'badge-status warn', text: '⚠️ ' + problems.join(', ') }) : null,
        el('span', { class: 'muted', text: panel.style === 'select' ? 'option' : 'bouton' }),
      ),
    );
    var body = el('div', { class: 'type-body' });
    body.hidden = !isOpen;
    if (!isOpen) return el('div', { class: 'type-card' }, head, body);

    var label = el('input', { type: 'text', maxlength: '80', value: category.label });
    var emoji = el('input', { type: 'text', maxlength: '64', placeholder: '📨', value: category.emoji || '' });
    var styleField;
    var styleInput;
    if (panel.style === 'select') {
      styleInput = el('input', { type: 'text', maxlength: '100', placeholder: 'Description de l’option', value: category.selectDescription || '' });
      styleField = el('label', { class: 'field field-grow' }, el('span', { text: 'Description (sélecteur)' }), styleInput);
    } else {
      styleInput = options([{ value: 'primary', text: 'Bleu' }, { value: 'secondary', text: 'Gris' }, { value: 'success', text: 'Vert' }, { value: 'danger', text: 'Rouge' }], category.buttonStyle || 'primary');
      styleField = el('label', { class: 'field' }, el('span', { text: 'Couleur du bouton' }), styleInput);
    }
    var discordCategory = options(data.discordCategories.map(function (c) { return { value: c.id, text: c.name }; }), category.categoryId, '(choisir une catégorie)');
    var maxOpen = numberInput(category.maxOpen, 1000, 'illimité');
    var namePattern = el('input', { type: 'text', maxlength: '100', placeholder: 'candidature-{number}-{username}', value: category.channelNamePattern || '' });
    var cooldown = numberInput(category.cooldownDays, 36500, 'aucun');
    var acceptRoles = (category.acceptRoleIds || []).slice();
    var acceptMessage = el('textarea', { rows: '3', maxlength: '1500', placeholder: 'Ex. : Bienvenue dans l’équipe {username} ! Rejoins le Discord staff : {invite}' }, category.acceptMessage || '');
    var guildChoices = data.inviteGuilds.map(function (g) { return { value: g.id, text: g.name }; });
    if (category.acceptInviteGuildId && !data.inviteGuilds.some(function (g) { return g.id === category.acceptInviteGuildId; })) {
      guildChoices.unshift({ value: category.acceptInviteGuildId, text: 'Serveur actuel (' + category.acceptInviteGuildId + ')' });
    }
    var inviteGuild = options(guildChoices, category.acceptInviteGuildId, '(aucune invitation)');
    var inviteHours = numberInput(category.acceptInviteHours, data.inviteHours.max, String(data.inviteHours.default));
    var recruiters = category.recruiterRoleIds.slice();
    var notify = category.notifyRoleIds.slice();
    var template = embedFields({ title: category.openedTitle, description: category.openedDescription, color: category.openedColor, footer: category.openedFooter, image: category.openedImage, thumbnail: category.openedThumbnail });

    var save = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: '💾 Enregistrer',
      onclick: function () {
        var embed = template.values();
        var payload = {
          label: label.value.trim(),
          emoji: emoji.value.trim() || null,
          categoryId: discordCategory.value || null,
          channelNamePattern: namePattern.value.trim() || null,
          maxOpen: intValue(maxOpen),
          cooldownDays: intValue(cooldown),
          acceptRoleIds: acceptRoles,
          acceptMessage: acceptMessage.value.trim() || null,
          acceptInviteGuildId: inviteGuild.value || null,
          acceptInviteHours: intValue(inviteHours),
          recruiterRoleIds: recruiters,
          notifyRoleIds: notify,
          openedTitle: embed.title,
          openedDescription: embed.description,
          openedColor: embed.color,
          openedFooter: embed.footer,
          openedImage: embed.image,
          openedThumbnail: embed.thumbnail,
        };
        if (panel.style === 'select') payload.selectDescription = styleInput.value.trim() || null;
        else payload.buttonStyle = styleInput.value;
        if (!payload.label) return showError('Le libellé de la catégorie est obligatoire.');
        save.disabled = true;
        refresh(call('POST', '/categories/' + category.id + query(), payload)).finally(function () { save.disabled = false; });
      },
    });
    var remove = el('button', {
      type: 'button',
      class: 'btn btn-danger btn-small',
      text: 'Supprimer cette catégorie',
      onclick: function () {
        Core.confirm('Supprimer la catégorie « ' + category.label + ' » ? Les candidatures clôturées restent dans l’historique.').then(function (ok) {
          if (ok) refresh(call('DELETE', '/categories/' + category.id + query()));
        });
      },
    });

    body.append(
      el('div', { class: 'field-row' }, el('label', { class: 'field field-grow' }, el('span', { text: 'Libellé' }), label), el('label', { class: 'field' }, el('span', { text: 'Émoji' }), emoji), styleField),
      el('div', { class: 'field-row' },
        el('label', { class: 'field' }, el('span', { text: 'Catégorie Discord des salons' }), discordCategory),
        el('label', { class: 'field' }, el('span', { text: 'Limite de candidatures en cours' }), maxOpen),
      ),
      el('label', { class: 'field field-grow' }, el('span', { text: 'Nom du salon' }), namePattern),
      el('p', { class: 'muted', text: 'Placeholders : {number} (0042) · {username} · {type} (libellé de la catégorie). Par défaut : candidature-{number}-{username}.' }),
      el('h4', { class: 'section-title', text: 'Rôle(s) recruteur — voient les salons, changent le statut et la catégorie' }),
      Core.rolePicker(data.roles, recruiters),
      el('h4', { class: 'section-title', text: 'Rôle(s) notifié(s) — mentionnés à l’ouverture et à l’envoi (vide = les recruteurs)' }),
      Core.rolePicker(data.roles, notify),
      el('h4', { class: 'section-title', text: 'Refus' }),
      el('div', { class: 'field-row' }, el('label', { class: 'field' }, el('span', { text: 'Délai avant de se représenter après un refus (jours)' }), cooldown)),
      el('h4', { class: 'section-title', text: 'Acceptation — rôle(s) donné(s) au candidat' }),
      Core.rolePicker(data.roles, acceptRoles),
      el('h4', { class: 'section-title', text: 'Acceptation — message privé au candidat' }),
      el('p', { class: 'muted', text: 'Envoyé en message privé avec l’annonce de l’acceptation (dans le salon de la candidature si ses messages privés sont fermés) : lien d’un Discord, consignes… Mêmes placeholders que le modèle, plus {invite} (invitation générée ci-dessous).' }),
      el('label', { class: 'field field-grow' }, el('span', { text: 'Message' }), acceptMessage),
      el('div', { class: 'field-row' },
        el('label', { class: 'field field-grow' }, el('span', { text: 'Générer une invitation vers' }), inviteGuild),
        el('label', { class: 'field' }, el('span', { text: 'Validité (heures, ' + data.inviteHours.max + ' max)' }), inviteHours),
      ),
      el('p', { class: 'muted', text: 'Le bot crée une invitation à une seule utilisation, propre à ce candidat et envoyée uniquement à lui. Discord ne permet pas de réserver une invitation à un compte précis : l’usage unique et la courte validité en limitent l’usage. Seuls les serveurs où tu as « Gérer le serveur » (et où le bot est présent) sont proposés ; le bot doit pouvoir y créer une invitation.' }),
      el('h4', { class: 'section-title', text: 'Modèle : embed affiché à l’ouverture de la candidature' }),
      el('p', { class: 'muted', text: 'Placeholders : ' + PLACEHOLDERS + '. Vide = message par défaut invitant le candidat à rédiger puis à cliquer sur « Terminer ma candidature ».' }),
      template,
      el('div', { class: 'filters' }, save, remove),
    );
    return el('div', { class: 'type-card' }, head, body);
  }

  function renderPanels() {
    var list = Core.clear(document.getElementById('panels-list'));
    if (!data.panels.length) list.append(el('div', { class: 'card empty', text: 'Aucun panel pour l’instant : crée-en un, ajoute-lui des catégories, puis publie-le dans un salon.' }));
    data.panels.forEach(function (panel) {
      var isOpen = expandedPanels.has(panel.id);
      var summary = (panel.title || 'Sans titre') + ' · ' + panel.categories.length + ' catégorie(s)' + (panel.messageId ? ' · publié dans ' + channelName(panel.channelId) : ' · non publié');
      var toggle = el(
        'div',
        { class: 'panel-head', onclick: function () { if (isOpen) expandedPanels.delete(panel.id); else expandedPanels.add(panel.id); renderPanels(); } },
        el('h3', { text: (isOpen ? '▾ ' : '▸ ') + 'Panel #' + panel.id }),
        el('span', { class: 'muted', text: summary }),
      );
      var deletePanel = el('button', {
        type: 'button',
        class: 'btn btn-danger btn-small',
        text: 'Supprimer ce panel',
        onclick: function (event) {
          event.stopPropagation();
          Core.confirm('Supprimer ce panel et ses catégories ? Le message Discord associé sera aussi supprimé ; les candidatures clôturées restent dans l’historique.').then(function (ok) {
            if (ok) refresh(call('DELETE', '/panels/' + panel.id + query()));
          });
        },
      });
      var body = null;
      if (isOpen) {
        var addCategory = el('button', {
          type: 'button',
          class: 'btn btn-small',
          text: '+ Ajouter une catégorie (bouton/option)',
          onclick: function () {
            refresh(call('POST', '/panels/' + panel.id + '/categories' + query(), { label: 'Nouvelle catégorie' })).then(function (ok) {
              var created = ok && data.panels.find(function (p) { return p.id === panel.id; });
              if (created && created.categories.length) {
                expandedCategories.add(String(created.categories[created.categories.length - 1].id));
                renderPanels();
              }
            });
          },
        });
        body = el(
          'div',
          { class: 'card-body' },
          renderPublish(panel),
          renderPanelEmbedForm(panel),
          el('h4', { class: 'section-title', text: 'Catégories de candidature (boutons/options)' }),
          panel.categories.length ? panel.categories.map(function (c) { return renderCategoryCard(panel, c); }) : el('div', { class: 'empty', text: 'Aucune catégorie pour l’instant.' }),
          el('div', { class: 'section-actions' }, addCategory),
        );
      }
      list.append(el('section', { class: 'card panel-block' }, el('div', { class: 'panel-head-row' }, toggle, deletePanel), body));
    });
  }

  // ── Onglet « Réglages » ────────────────────────────────────────────────────
  function renderSettings() {
    var log = options(data.textChannels.map(function (c) { return { value: c.id, text: '#' + c.name }; }), data.settings.logChannelId, '(aucun)');
    var required = el('input', { type: 'checkbox' });
    required.checked = data.settings.refusalReasonRequired;
    var save = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: 'Enregistrer',
      onclick: function () {
        save.disabled = true;
        refresh(call('POST', '/settings' + query(), { logChannelId: log.value || null, refusalReasonRequired: required.checked })).finally(function () { save.disabled = false; });
      },
    });
    Core.clear(document.getElementById('settings-card')).append(
      el(
        'div',
        { class: 'stack' },
        el('div', { class: 'filters' }, el('label', { class: 'field' }, el('span', { text: 'Salon de journal' }), log)),
        el('div', { class: 'toggle-row' }, el('label', { class: 'check' }, required, 'Le refus doit être motivé (raison obligatoire pour les recruteurs)')),
        el('div', { class: 'filters' }, save),
      ),
    );
  }

  function renderReplies() {
    var keys = data.statuses.filter(function (s) { return s.recruiter || s.key === 'withdrawn'; });
    var fields = keys.map(function (s) {
      var entry = (data.settings.autoReplies || {})[s.key] || {};
      var message = el('textarea', { rows: '2', maxlength: '1500', placeholder: 'Aucune réponse automatique' }, entry.message || '');
      var dm = el('input', { type: 'checkbox' });
      dm.checked = Boolean(entry.dm);
      return {
        key: s.key,
        node: el('div', { class: 'stack cand-reply' }, el('label', { class: 'field' }, el('span', { text: s.emoji + ' ' + s.label }), message), el('label', { class: 'check' }, dm, 'Aussi en message privé au candidat')),
        value: function () { return { message: message.value.trim(), dm: dm.checked }; },
      };
    });
    var save = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: 'Enregistrer les réponses',
      onclick: function () {
        var replies = {};
        fields.forEach(function (f) { replies[f.key] = f.value(); });
        save.disabled = true;
        refresh(call('POST', '/settings' + query(), { autoReplies: replies })).finally(function () { save.disabled = false; });
      },
    });
    Core.clear(document.getElementById('replies-card')).append(
      el(
        'div',
        { class: 'stack' },
        el('p', { class: 'muted', text: 'Message posté automatiquement dans le salon quand la candidature passe à ce statut (l’annonce du statut est, elle, toujours envoyée au candidat en privé). Placeholders : ' + PLACEHOLDERS + '.' }),
        fields.map(function (f) { return f.node; }),
        el('div', { class: 'filters' }, save),
      ),
    );
  }

  // ── Onglets et chargement ──────────────────────────────────────────────────
  function activateTab(name) {
    document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === name); });
    document.querySelectorAll('.tab-panel').forEach(function (panel) { panel.hidden = panel.id !== 'tab-' + name; });
  }

  function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        activateTab(b.dataset.tab);
        if (b.dataset.tab === 'history' && !history) reloadHistory();
      });
    });
    activateTab('settings');
  }

  function renderAll() {
    renderTiles();
    renderSettings();
    renderReplies();
    renderPanels();
    renderActive();
    if (history) reloadHistory();
  }

  async function loadGuild() {
    document.getElementById('content').hidden = true;
    expandedPanels.clear();
    expandedCategories.clear();
    historyFilters = { applicant: '', status: '', category: '', scope: 'all', page: 1 };
    history = null;
    if (await refresh(call('GET', '/state' + query()))) {
      renderHistoryFilters();
      document.getElementById('content').hidden = false;
    }
  }

  async function start() {
    try {
      await Core.ready;
      var guilds = await Core.api(API + '/guilds');
      if (!guilds.length) {
        document.getElementById('empty').hidden = false;
        return;
      }
      var select = document.getElementById('f-guild');
      Core.clear(select).append(...guilds.map(function (g) { return el('option', { value: g.id, text: g.name }); }));
      var wanted = new URLSearchParams(window.location.search).get('guild');
      guildId = guilds.some(function (g) { return g.id === wanted; }) ? wanted : guilds[0].id;
      select.value = guildId;
      select.addEventListener('change', function () {
        guildId = select.value;
        loadGuild();
      });
      document.getElementById('add-panel').addEventListener('click', function () {
        refresh(call('POST', '/panels' + query(), {})).then(function (ok) {
          if (ok && data.panels.length) {
            expandedPanels.add(data.panels[data.panels.length - 1].id);
            renderPanels();
          }
        });
      });
      setupTabs();
      await loadGuild();
    } catch (err) {
      showError(err.message);
    }
  }

  start();
})();
