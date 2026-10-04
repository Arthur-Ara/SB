/* Panel web du module Tickets : panels multi-types, réglages, admins, tickets. */
(function () {
  'use strict';

  var el = Core.el;
  var fmt = Core.fmt;
  var API = '/m/tickets/api';
  var main = document.getElementById('main');
  var guildId = '';
  var data = null;
  var closedTickets = [];
  var closedMeta = { page: 1, pages: 1, total: 0 };
  // Filtres de l'historique (texte, ouvreur, staff qui l'a pris en charge, type, étiquette, période) + page.
  var historyFilters = { q: '', opener: '', staff: '', type: '', tag: '', from: '', to: '', page: 1 };
  var editingSnippet = null; // réponse prédéfinie en cours de modification (null = création)
  var closedModmailThreads = [];
  var expandedTypes = new Set();
  var expandedPanels = new Set();
  var expandedModmailCategories = new Set();

  function showError(message) {
    var box = document.getElementById('error');
    box.textContent = message || '';
    box.hidden = !message;
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
      await Promise.all([loadClosedTickets(), loadClosedModmailThreads()]);
      renderAll();
    } catch (err) {
      showError(err.message);
    } finally {
      main.classList.remove('is-loading');
    }
  }

  async function loadClosedTickets() {
    var params = Object.keys(historyFilters)
      .filter(function (key) { return historyFilters[key] !== '' && historyFilters[key] !== null; })
      .map(function (key) { return key + '=' + encodeURIComponent(historyFilters[key]); })
      .join('&');
    var result = await call('GET', '/tickets/closed' + query() + (params ? '&' + params : ''));
    closedTickets = result.rows;
    closedMeta = { page: result.page, pages: result.pages, total: result.total };
  }

  /** Recharge seulement l'historique (filtres, pagination), sans tout redessiner. */
  async function reloadHistory() {
    showError('');
    try {
      await loadClosedTickets();
      renderClosedTickets();
    } catch (err) {
      showError(err.message);
    }
  }

  function tagChip(tag, onRemove) {
    return el(
      'span',
      { class: 'tag-chip', style: tag.color ? 'border-color:' + tag.color + ';color:' + tag.color : null },
      (tag.emoji ? tag.emoji + ' ' : '') + tag.name,
      onRemove ? el('button', { type: 'button', 'aria-label': 'Retirer', title: 'Retirer cette étiquette', text: '✕', onclick: onRemove }) : null,
    );
  }

  function tagsCell(tags) {
    if (!tags || !tags.length) return el('span', { class: 'muted', text: '—' });
    return el('span', { class: 'tag-list' }, tags.map(function (tag) { return tagChip(tag); }));
  }

  async function loadClosedModmailThreads() {
    closedModmailThreads = await call('GET', '/modmail/closed' + query());
  }

  // ── Petits composants ──────────────────────────────────────────────────────
  function personEl(person) {
    if (!person) return el('span', { class: 'muted', text: '—' });
    return el(
      'span',
      { class: 'person' },
      el('img', { src: person.avatar, alt: '', loading: 'lazy' }),
      el('span', { text: person.name, title: person.username ? '@' + person.username : person.id }),
    );
  }

  function tile(label, value, sub) {
    return el(
      'div',
      { class: 'card tile' },
      el('div', { class: 'tile-label', text: label }),
      el('div', { class: 'tile-value', text: value }),
      sub ? el('div', { class: 'tile-sub', text: sub }) : null,
    );
  }

  /** `columns` : les entrées null (colonne masquée selon la configuration) sont ignorées. */
  function table(columns, rows, emptyText) {
    columns = columns.filter(Boolean);
    if (!rows.length) return el('div', { class: 'empty', text: emptyText || 'Aucune donnée.' });
    return el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        { class: 'data' },
        el('thead', {}, el('tr', {}, columns.map(function (c) { return el('th', { class: c.num ? 'num' : null, text: c.label }); }))),
        el(
          'tbody',
          {},
          rows.map(function (row) {
            return el(
              'tr',
              {},
              columns.map(function (c) {
                var value = c.value(row);
                return el('td', { class: c.num ? 'num' : null }, value === null || value === undefined ? '—' : value);
              }),
            );
          }),
        ),
      ),
    );
  }

  function idInput(placeholder) {
    return el('input', { inputmode: 'numeric', placeholder: placeholder || 'ID Discord', maxlength: '20' });
  }

  function validId(input) {
    var value = input.value.trim();
    if (!/^\d{17,20}$/.test(value)) {
      showError('ID Discord invalide (17 à 20 chiffres attendus).');
      return null;
    }
    return value;
  }

  function embedPreview(fields) {
    if (!fields.title && !fields.description) return el('div', { class: 'embed-preview empty', text: 'Aucun aperçu (titre ou description requis).' });
    var descEl = null;
    if (fields.description) {
      descEl = el('div', { class: 'ep-desc' });
      descEl.innerHTML = window.TicketFormat.renderContent(fields.description);
    }
    var box = el(
      'div',
      { class: 'embed-preview', style: 'border-left-color:' + (fields.color || '#5865F2') },
      fields.title ? el('div', { class: 'ep-title', text: fields.title }) : null,
      descEl,
      fields.footer ? el('div', { class: 'ep-footer', text: fields.footer }) : null,
    );
    if (fields.image) box.append(el('img', { src: fields.image, alt: '' }));
    return box;
  }

  // ── Réglages ──────────────────────────────────────────────────────────────
  function renderTiles() {
    Core.clear(document.getElementById('tiles')).append(
      tile('Panels', fmt.number(data.panels.length)),
      tile('Types de tickets', fmt.number(data.panels.reduce(function (n, p) { return n + p.types.length; }, 0))),
      tile('Tickets ouverts', fmt.number(data.openTickets.length)),
      tile('Admins du module', fmt.number(data.admins.length)),
      tile('Note moyenne', data.ratingStats.count ? data.ratingStats.average.toFixed(1) + '/5' : '—', data.ratingStats.count ? fmt.number(data.ratingStats.count) + ' avis' : 'Aucun avis'),
    );
  }

  function renderSettings() {
    var select = el('select', { 'aria-label': 'Salon de journal' }, el('option', { value: '', text: '(aucun)' }), data.textChannels.map(function (c) { return el('option', { value: c.id, text: '#' + c.name }); }));
    select.value = data.settings.logChannelId || '';

    var save = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: 'Enregistrer',
      onclick: function () {
        save.disabled = true;
        refresh(call('POST', '/settings' + query(), { logChannelId: select.value || null })).finally(function () { save.disabled = false; });
      },
    });
    Core.clear(document.getElementById('settings-card')).append(
      el('div', { class: 'filters' }, el('label', { class: 'field' }, el('span', { text: 'Salon de journal' }), select), save),
    );
  }

  function renderModmail() {
    var enabled = el('input', { type: 'checkbox' });
    enabled.checked = data.modmail.enabled;

    var save = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: 'Enregistrer',
      onclick: function () {
        save.disabled = true;
        refresh(call('POST', '/modmail' + query(), { enabled: enabled.checked })).finally(function () { save.disabled = false; });
      },
    });

    Core.clear(document.getElementById('modmail-card')).append(
      el('p', {
        class: 'muted',
        text: 'Les membres écrivent en message privé au bot ; un salon est créé dans la catégorie choisie pour le staff (voir « Catégories » ci-dessous — plusieurs peuvent être configurées, le membre choisit celle qui l’intéresse, et le serveur si plusieurs partagent le modmail). Tout message écrit dans le salon est transmis au membre — préfixe // pour une note interne. Ouverture/fermeture : /modmail ouvrir et /modmail fermer sur Discord.',
      }),
      el('div', { class: 'filters' }, el('label', { class: 'check' }, enabled, 'Activer le modmail'), save),
    );
  }

  function renderModmailCategoryCard(category) {
    var isOpen = expandedModmailCategories.has(category.id);
    var head = el(
      'div',
      { class: 'type-head', onclick: function () { if (isOpen) expandedModmailCategories.delete(category.id); else expandedModmailCategories.add(category.id); renderModmailCategories(); } },
      el('h4', { text: (isOpen ? '▾ ' : '▸ ') + category.name }),
      el('span', { class: 'muted', text: category.panelOnly ? '🌐 panel uniquement' : category.categoryId ? 'configurée' : '⚠️ catégorie Discord manquante' }),
    );

    var body = el('div', { class: 'type-body' });
    body.hidden = !isOpen;
    if (isOpen) {
      var nameInput = el('input', { type: 'text', value: category.name, maxlength: '100' });
      var categorySelect = el('select', {}, el('option', { value: '', text: '(choisir une catégorie)' }), data.categories.map(function (c) { return el('option', { value: c.id, text: c.name }); }));
      categorySelect.value = category.categoryId || '';
      var staffRoles = category.staffRoleIds.slice();
      var welcomeInput = el('textarea', { rows: '3', maxlength: '2000', placeholder: 'Merci pour ton message ! Le staff de {server} te répond au plus vite (délai habituel : 24 h).' }, category.welcomeMessage || '');
      var autoCloseInput = el('input', { type: 'number', min: '1', max: '8760', placeholder: 'désactivée', value: category.autoCloseHours || '' });
      var panelOnly = el('input', { type: 'checkbox' });
      panelOnly.checked = category.panelOnly;

      var save = el('button', {
        type: 'button',
        class: 'btn btn-primary',
        text: '💾 Enregistrer',
        onclick: function () {
          save.disabled = true;
          refresh(
            call('POST', '/modmail-categories/' + category.id + query(), {
              name: nameInput.value.trim() || 'Catégorie',
              categoryId: categorySelect.value || null,
              staffRoleIds: staffRoles,
              welcomeMessage: welcomeInput.value.trim() || null,
              autoCloseHours: autoCloseInput.value === '' ? null : Number(autoCloseInput.value),
              panelOnly: panelOnly.checked,
            }),
          ).finally(function () { save.disabled = false; });
        },
      });
      var remove = el('button', {
        type: 'button',
        class: 'btn btn-danger btn-small',
        text: 'Supprimer cette catégorie',
        onclick: function () {
          Core.confirm('Supprimer la catégorie « ' + category.name + ' » ? Les fils déjà ouverts ne sont pas affectés.').then(function (ok) {
            if (ok) refresh(call('DELETE', '/modmail-categories/' + category.id + query()));
          });
        },
      });

      body.append(
        el('div', { class: 'field-row' },
          el('label', { class: 'field field-grow' }, el('span', { text: 'Nom (affiché au membre)' }), nameInput),
          el('label', { class: 'field' }, el('span', { text: 'Catégorie Discord des salons' }), categorySelect),
        ),
        el('div', { class: 'toggle-row' },
          el('label', { class: 'check' }, panelOnly, 'Traiter uniquement depuis le panel (aucun salon Discord)'),
        ),
        el('p', { class: 'muted', text: 'Panel uniquement : les messages du membre ne sont lus et traités que sur le panel web (onglet Modmail → Transcript : réponse, réponse anonyme, fermeture). Aucun salon n’est créé, la catégorie Discord n’est alors pas nécessaire.' }),
        el('h4', { class: 'section-title', text: 'Rôle(s) staff — voient et répondent aux modmails de cette catégorie' }),
        rolePicker(staffRoles, function () {}),
        el('h4', { class: 'section-title', text: 'Message d’accueil envoyé au membre' }),
        el('label', { class: 'field field-grow' }, el('span', { text: 'Vide = message par défaut. Placeholders : {server} · {category} · {user}' }), welcomeInput),
        el('h4', { class: 'section-title', text: 'Fermeture automatique' }),
        el('div', { class: 'field-row' },
          el('label', { class: 'field' }, el('span', { text: 'Fermer le fil après (heures sans message du membre ni du staff)' }), autoCloseInput),
        ),
        el('div', { class: 'filters' }, save, remove),
      );
    }

    return el('div', { class: 'type-card' }, head, body);
  }

  function renderModmailCategories() {
    var list = Core.clear(document.getElementById('modmail-categories-list'));
    if (!data.modmail.categories.length) {
      list.append(el('div', { class: 'card empty', text: 'Aucune catégorie configurée : le modmail reste indisponible pour les membres tant qu’il n’y en a pas au moins une.' }));
      return;
    }
    data.modmail.categories.forEach(function (c) { list.append(el('section', { class: 'card panel-block' }, renderModmailCategoryCard(c))); });
  }

  function modmailTranscriptLink(threadId) {
    return '/m/tickets/transcript?modmail=' + encodeURIComponent(threadId);
  }

  function renderModmailOpen() {
    Core.clear(document.getElementById('modmail-open-card')).append(
      table(
        [
          { label: '#', value: function (t) { return String(t.id); } },
          { label: 'Membre', value: function (t) { return personEl(t.user); } },
          { label: 'Catégorie', value: function (t) { return (t.categoryName || '—') + (t.panelOnly ? ' · 🌐 panel' : ''); } },
          { label: 'Ouvert par', value: function (t) { return t.openedBy ? personEl(t.openedBy) : el('span', { class: 'muted', text: 'le membre' }); } },
          { label: 'Ouvert', value: function (t) { return fmt.dateTime(t.createdAt); } },
          { label: 'Transcript', value: function (t) { return el('a', { href: modmailTranscriptLink(t.id), target: '_blank', rel: 'noopener', text: t.panelOnly && t.status === 'open' ? 'Traiter' : 'Voir' }); } },
        ],
        data.openModmailThreads,
        'Aucun fil modmail ouvert.',
      ),
    );
  }

  function renderModmailClosed() {
    Core.clear(document.getElementById('modmail-closed-card')).append(
      table(
        [
          { label: '#', value: function (t) { return String(t.id); } },
          { label: 'Membre', value: function (t) { return personEl(t.user); } },
          { label: 'Catégorie', value: function (t) { return t.categoryName || '—'; } },
          { label: 'Fermé par', value: function (t) { return t.closedBy ? personEl(t.closedBy) : el('span', { class: 'muted', text: 'automatique' }); } },
          { label: 'Le', value: function (t) { return fmt.dateTime(t.closedAt); } },
          { label: 'Transcript', value: function (t) { return el('a', { href: modmailTranscriptLink(t.id), target: '_blank', rel: 'noopener', text: t.panelOnly && t.status === 'open' ? 'Traiter' : 'Voir' }); } },
        ],
        closedModmailThreads,
        'Aucun fil modmail fermé récemment.',
      ),
    );
  }

  function renderAdmins() {
    var input = idInput('ID à ajouter');
    var addButton = el('button', {
      type: 'button',
      class: 'btn btn-small',
      text: 'Ajouter',
      onclick: function () {
        var id = validId(input);
        if (!id) return;
        refresh(call('POST', '/admins/' + id + query()));
      },
    });
    Core.clear(document.getElementById('admins-card')).append(
      el('div', { class: 'filters' }, el('label', { class: 'field' }, el('span', { text: 'Ajouter par ID' }), input), addButton),
      table(
        [
          { label: 'Membre', value: function (a) { return personEl(a.person); } },
          { label: 'Ajouté par', value: function (a) { return a.addedByPerson ? personEl(a.addedByPerson) : '—'; } },
          { label: 'Depuis', value: function (a) { return fmt.dateTime(a.addedAt); } },
          { label: '', value: function (a) { return el('button', { type: 'button', class: 'btn btn-ghost btn-small', text: 'Retirer', onclick: function () { refresh(call('DELETE', '/admins/' + a.userId + query())); } }); } },
        ],
        data.admins,
        'Aucun admin de module (les administrateurs et propriétaires du serveur/bot le sont déjà).',
      ),
    );
  }

  // ── Réponses prédéfinies ─────────────────────────────────────────────────
  function renderSnippets() {
    var current = editingSnippet;
    var nameInput = el('input', { type: 'text', maxlength: '50', placeholder: 'ex. bienvenue', value: current ? current.name : '' });
    var contentInput = el('textarea', { rows: '3', maxlength: '2000', placeholder: 'Bonjour {user}, merci pour ton message…' }, current ? current.content : '');
    var save = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: current ? '💾 Enregistrer les modifications' : '+ Ajouter la réponse',
      onclick: function () {
        save.disabled = true;
        refresh(call('POST', '/snippets' + query(), { id: current ? current.id : null, name: nameInput.value.trim(), content: contentInput.value.trim() }))
          .then(function () { editingSnippet = null; renderSnippets(); })
          .finally(function () { save.disabled = false; });
      },
    });
    var cancel = current ? el('button', { type: 'button', class: 'btn btn-ghost', text: 'Annuler', onclick: function () { editingSnippet = null; renderSnippets(); } }) : null;

    Core.clear(document.getElementById('snippets-card')).append(
      el('p', { class: 'muted', style: 'padding:0 14px', text: 'Utilisables par le staff avec /ticket reponse dans un ticket, et depuis la zone de réponse des transcripts (tickets et modmail). Placeholders : {user} (ouvreur / membre) · {staff} (celui qui répond) · {ticket} · {number} · {type}.' }),
      el('div', { class: 'filters' },
        el('label', { class: 'field' }, el('span', { text: 'Nom (utilisé dans /ticket reponse)' }), nameInput),
        el('label', { class: 'field field-grow' }, el('span', { text: 'Contenu' }), contentInput),
        save,
        cancel,
      ),
      table(
        [
          { label: 'Nom', value: function (s) { return el('code', { text: s.name }); } },
          { label: 'Contenu', value: function (s) { return el('span', { class: 'snippet-preview', text: s.content, title: s.content }); } },
          {
            label: '',
            value: function (s) {
              return el(
                'div',
                { class: 'row-actions' },
                el('button', { type: 'button', class: 'btn btn-ghost btn-small', text: 'Modifier', onclick: function () { editingSnippet = s; renderSnippets(); } }),
                el('button', {
                  type: 'button',
                  class: 'btn btn-ghost btn-small',
                  text: 'Supprimer',
                  onclick: function () {
                    Core.confirm('Supprimer la réponse prédéfinie « ' + s.name + ' » ?').then(function (ok) {
                      if (ok) refresh(call('DELETE', '/snippets/' + s.id + query()));
                    });
                  },
                }),
              );
            },
          },
        ],
        data.snippets,
        'Aucune réponse prédéfinie.',
      ),
    );
  }

  // ── Étiquettes ───────────────────────────────────────────────────────────
  var editingTag = null; // id de l'étiquette dont le formulaire est ouvert ('new' = création)

  /** Formulaire d'une étiquette : apparence + effets à la pose (catégorie, préfixe du salon, rôles mentionnés). */
  function tagForm(tag) {
    var nameInput = el('input', { type: 'text', maxlength: '50', placeholder: 'ex. Urgent', value: tag ? tag.name : '' });
    var emojiInput = el('input', { type: 'text', maxlength: '64', placeholder: '🔴', value: tag && tag.emoji ? tag.emoji : '' });
    var colorInput = el('input', { type: 'color', value: (tag && tag.color) || '#f43f5e' });
    var categorySelect = el('select', {}, el('option', { value: '', text: '(ne pas déplacer)' }), data.categories.map(function (c) { return el('option', { value: c.id, text: c.name }); }));
    categorySelect.value = (tag && tag.categoryId) || '';
    var prefixInput = el('input', { type: 'text', maxlength: '20', placeholder: 'ex. urgent ou 🔴', value: tag && tag.channelPrefix ? tag.channelPrefix : '' });
    var mentionRoles = tag ? tag.mentionRoleIds.slice() : [];
    var save = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: tag ? '💾 Enregistrer' : '+ Ajouter',
      onclick: function () {
        if (!nameInput.value.trim()) return showError('Donne un nom à l’étiquette.');
        save.disabled = true;
        refresh(
          call('POST', '/tags' + query(), {
            id: tag ? tag.id : null,
            name: nameInput.value.trim(),
            emoji: emojiInput.value.trim() || null,
            color: colorInput.value,
            categoryId: categorySelect.value || null,
            channelPrefix: prefixInput.value.trim() || null,
            mentionRoleIds: mentionRoles,
          }),
        )
          .then(function () { editingTag = null; renderTags(); })
          .finally(function () { save.disabled = false; });
      },
    });
    var cancel = el('button', { type: 'button', class: 'btn btn-ghost', text: 'Annuler', onclick: function () { editingTag = null; renderTags(); } });
    return el('div', { class: 'tag-editor' },
      el('div', { class: 'filters' },
        el('label', { class: 'field' }, el('span', { text: 'Nom' }), nameInput),
        el('label', { class: 'field' }, el('span', { text: 'Émoji' }), emojiInput),
        el('label', { class: 'field' }, el('span', { text: 'Couleur' }), colorInput),
      ),
      el('div', { class: 'filters' },
        el('label', { class: 'field' }, el('span', { text: 'Déplacer le ticket dans la catégorie' }), categorySelect),
        el('label', { class: 'field' }, el('span', { text: 'Ajouter au nom du salon (préfixe)' }), prefixInput),
      ),
      el('h4', { class: 'section-title', style: 'padding:0 14px', text: 'Rôles mentionnés quand l’étiquette est posée' }),
      el('div', { style: 'padding:0 14px' }, rolePicker(mentionRoles, function () {})),
      el('div', { class: 'filters' }, save, cancel),
    );
  }

  function renderTags() {
    var rows = data.tags.map(function (tag, index) {
      var effects = [];
      if (tag.categoryId) {
        var category = data.categories.find(function (c) { return c.id === tag.categoryId; });
        effects.push('📂 ' + (category ? category.name : 'catégorie supprimée'));
      }
      if (tag.channelPrefix) effects.push('✏️ « ' + tag.channelPrefix + '- »');
      if (tag.mentionRoleIds.length) effects.push('🔔 ' + tag.mentionRoleIds.length + ' rôle(s)');
      var move = function (direction) {
        return function () { refresh(call('POST', '/tags/' + tag.id + '/move' + query(), { direction: direction })); };
      };
      return el('div', { class: 'tag-row' },
        el('div', { class: 'tag-row-head' },
          el('span', { class: 'tag-rank', text: '#' + (index + 1) }),
          tagChip(tag),
          el('span', { class: 'muted tag-effects', text: effects.join(' · ') }),
          el('span', { class: 'row-actions' },
            el('button', { type: 'button', class: 'btn btn-ghost btn-small', text: '▲', title: 'Plus prioritaire', disabled: index === 0, onclick: move('up') }),
            el('button', { type: 'button', class: 'btn btn-ghost btn-small', text: '▼', title: 'Moins prioritaire', disabled: index === data.tags.length - 1, onclick: move('down') }),
            el('button', { type: 'button', class: 'btn btn-small', text: 'Modifier', onclick: function () { editingTag = tag.id; renderTags(); } }),
            el('button', {
              type: 'button',
              class: 'btn btn-ghost btn-small',
              text: 'Supprimer',
              onclick: function () {
                Core.confirm('Supprimer l’étiquette « ' + tag.name + ' » ? Elle sera retirée de tous les tickets.').then(function (ok) {
                  if (ok) refresh(call('DELETE', '/tags/' + tag.id + query()));
                });
              },
            }),
          ),
        ),
        editingTag === tag.id ? tagForm(tag) : null,
      );
    });
    Core.clear(document.getElementById('tags-card')).append(
      el('p', { class: 'muted', style: 'padding:0 14px', text: 'Posées par les modérateurs (/ticket tag, ou onglet « Tickets ouverts »). L’ordre fixe la priorité : la première étiquette est la plus prioritaire (/ticket list, /ticket autolist et la liste des tickets ouverts sont triés ainsi). Quand une étiquette est posée, elle peut déplacer le ticket dans une autre catégorie, ajouter un préfixe au nom du salon et mentionner des rôles ; retirée, le ticket revient dans la catégorie de son type.' }),
      rows.length ? el('div', { class: 'tag-rows' }, rows) : el('div', { class: 'empty', text: 'Aucune étiquette.' }),
      editingTag === 'new'
        ? tagForm(null)
        : el('div', { class: 'filters' }, el('button', { type: 'button', class: 'btn btn-primary', text: '+ Nouvelle étiquette', onclick: function () { editingTag = 'new'; renderTags(); } })),
    );
  }

  // ── Liste noire ──────────────────────────────────────────────────────────
  function renderBlacklist() {
    var input = idInput('ID du membre');
    var reasonInput = el('input', { type: 'text', maxlength: '300', placeholder: 'Raison (facultatif)' });
    var add = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: '⛔ Ajouter',
      onclick: function () {
        var id = validId(input);
        if (!id) return;
        refresh(call('POST', '/blacklist' + query(), { userId: id, reason: reasonInput.value.trim() || null }));
      },
    });
    Core.clear(document.getElementById('blacklist-card')).append(
      el('p', { class: 'muted', style: 'padding:0 14px', text: 'Membres interdits d’ouvrir un ticket et d’écrire au staff par modmail sur ce serveur (aussi : /ticket blacklist).' }),
      el('div', { class: 'filters' },
        el('label', { class: 'field' }, el('span', { text: 'Membre' }), input),
        el('label', { class: 'field field-grow' }, el('span', { text: 'Raison' }), reasonInput),
        add,
      ),
      table(
        [
          { label: 'Membre', value: function (b) { return personEl(b.person); } },
          { label: 'Raison', value: function (b) { return b.reason || '—'; } },
          { label: 'Ajouté par', value: function (b) { return b.addedBy ? personEl(b.addedBy) : '—'; } },
          { label: 'Depuis', value: function (b) { return fmt.dateTime(b.addedAt); } },
          { label: '', value: function (b) { return el('button', { type: 'button', class: 'btn btn-ghost btn-small', text: 'Retirer', onclick: function () { refresh(call('DELETE', '/blacklist/' + b.userId + query())); } }); } },
        ],
        data.blacklist,
        'Personne n’est sur la liste noire.',
      ),
    );
  }

  // ── Préfixes de grade (modmail) ──────────────────────────────────────────
  function renderModmailPrefixes() {
    var roleSelect = el('select', {}, data.roles.map(function (r) { return el('option', { value: r.id, text: r.name }); }));
    var prefixInput = el('input', { type: 'text', maxlength: '32', placeholder: '[Admin]' });
    var add = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: 'Enregistrer',
      onclick: function () {
        if (!prefixInput.value.trim()) return showError('Saisis un préfixe.');
        refresh(call('POST', '/modmail-prefixes' + query(), { roleId: roleSelect.value, prefix: prefixInput.value.trim() }));
      },
    });
    Core.clear(document.getElementById('modmail-prefixes-card')).append(
      el('p', { class: 'muted', style: 'padding:0 14px', text: 'Affiché au membre devant le nom du staff qui lui répond (ex. « [Admin] Alex — Serveur »). Si le membre du staff a plusieurs rôles avec un préfixe, c’est celui du rôle le plus haut qui s’affiche. Les réponses anonymes n’en ont pas.' }),
      el('div', { class: 'filters' },
        el('label', { class: 'field' }, el('span', { text: 'Rôle' }), roleSelect),
        el('label', { class: 'field' }, el('span', { text: 'Préfixe' }), prefixInput),
        add,
      ),
      table(
        [
          { label: 'Rôle', value: function (p) { return p.roleName; } },
          { label: 'Préfixe', value: function (p) { return el('code', { text: p.prefix }); } },
          { label: '', value: function (p) { return el('button', { type: 'button', class: 'btn btn-ghost btn-small', text: 'Retirer', onclick: function () { refresh(call('DELETE', '/modmail-prefixes/' + p.roleId + query())); } }); } },
        ],
        data.modmail.prefixes,
        'Aucun préfixe défini.',
      ),
    );
  }

  // ── Panels ────────────────────────────────────────────────────────────────
  function panelFieldsFrom(form) {
    return {
      openTitle: form.title.value.trim() || null,
      openDescription: form.description.value.trim() || null,
      openColor: form.color.value || null,
      openFooter: form.footer.value.trim() || null,
      openImage: form.image.value.trim() || null,
      openThumbnail: form.thumbnail.value.trim() || null,
      style: form.style.value,
    };
  }

  function renderPanelEmbedForm(panel) {
    var titleInput = el('input', { type: 'text', value: panel.openTitle || '', maxlength: '256' });
    var descInput = el('textarea', { maxlength: '4096', rows: '3' }, panel.openDescription || '');
    var colorInput = el('input', { type: 'color', value: panel.openColor || '#2b2d31' });
    var footerInput = el('input', { type: 'text', value: panel.openFooter || '', maxlength: '2048' });
    var imageInput = el('input', { type: 'text', placeholder: 'https://…', value: panel.openImage || '' });
    var thumbInput = el('input', { type: 'text', placeholder: 'https://…', value: panel.openThumbnail || '' });
    var styleSelect = el('select', {}, el('option', { value: 'buttons', text: 'Boutons' }), el('option', { value: 'select', text: 'Sélecteur (menu déroulant)' }));
    styleSelect.value = panel.style;

    var preview = embedPreview({ title: panel.openTitle, description: panel.openDescription, color: panel.openColor, footer: panel.openFooter, image: panel.openImage });
    var previewBox = el('div', {}, preview);
    function refreshPreview() {
      Core.clear(previewBox).append(embedPreview({ title: titleInput.value, description: descInput.value, color: colorInput.value, footer: footerInput.value, image: imageInput.value }));
    }
    [titleInput, descInput, colorInput, footerInput, imageInput].forEach(function (input) { input.addEventListener('input', refreshPreview); });

    var form = { title: titleInput, description: descInput, color: colorInput, footer: footerInput, image: imageInput, thumbnail: thumbInput, style: styleSelect };
    var save = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: '💾 Enregistrer l’embed d’ouverture',
      onclick: function () {
        save.disabled = true;
        refresh(call('POST', '/panels/' + panel.id + query(), panelFieldsFrom(form))).finally(function () { save.disabled = false; });
      },
    });

    return el(
      'div',
      { class: 'stack' },
      el('div', { class: 'field-row' },
        el('label', { class: 'field field-grow' }, el('span', { text: 'Titre' }), titleInput),
        el('label', { class: 'field' }, el('span', { text: 'Style du panel' }), styleSelect),
        el('label', { class: 'field' }, el('span', { text: 'Couleur' }), colorInput),
      ),
      el('label', { class: 'field' }, el('span', { text: 'Description' }), descInput),
      el('div', { class: 'field-row' },
        el('label', { class: 'field field-grow' }, el('span', { text: 'Pied de page' }), footerInput),
      ),
      el('div', { class: 'field-row' },
        el('label', { class: 'field field-grow' }, el('span', { text: 'Image (URL)' }), imageInput),
        el('label', { class: 'field field-grow' }, el('span', { text: 'Vignette (URL)' }), thumbInput),
      ),
      el('label', { class: 'field' }, el('span', { text: 'Aperçu' }), previewBox),
      el('div', { class: 'filters' }, save),
    );
  }

  /** Plage horaire d'activation (clôture automatique + reping) propre à ce panel. */
  function renderPanelScheduleForm(panel) {
    var schedEnabled = el('input', { type: 'checkbox' });
    schedEnabled.checked = panel.scheduleEnabled;
    var schedStart = el('input', { type: 'time', value: (panel.scheduleStart || '08:00').slice(0, 5) });
    var schedEnd = el('input', { type: 'time', value: (panel.scheduleEnd || '22:00').slice(0, 5) });
    var schedTz = el('input', { type: 'text', value: panel.scheduleTimezone || 'Europe/Paris', placeholder: 'Europe/Paris' });

    var save = el('button', {
      type: 'button',
      class: 'btn btn-small',
      text: 'Enregistrer la plage horaire',
      onclick: function () {
        save.disabled = true;
        refresh(
          call('POST', '/panels/' + panel.id + query(), {
            scheduleEnabled: schedEnabled.checked,
            scheduleStart: schedStart.value || null,
            scheduleEnd: schedEnd.value || null,
            scheduleTimezone: schedTz.value.trim() || 'Europe/Paris',
          }),
        ).finally(function () { save.disabled = false; });
      },
    });

    return el(
      'div',
      { class: 'stack' },
      el('h4', { class: 'section-title', text: 'Plage horaire d’activation de ce panel (clôture automatique et reping)' }),
      el('p', { class: 'muted', text: 'En dehors de cette plage, aucune clôture automatique ni reping n’a lieu pour les tickets de ce panel (pratique pour désactiver le système la nuit). Sans activation, le système reste actif en permanence.' }),
      el(
        'div',
        { class: 'filters' },
        el('label', { class: 'check' }, schedEnabled, 'Activer la plage horaire'),
        el('label', { class: 'field' }, el('span', { text: 'Début' }), schedStart),
        el('label', { class: 'field' }, el('span', { text: 'Fin' }), schedEnd),
        el('label', { class: 'field' }, el('span', { text: 'Fuseau (IANA)' }), schedTz),
        save,
      ),
    );
  }

  function renderPublish(panel) {
    var select = el('select', {}, data.textChannels.map(function (c) { return el('option', { value: c.id, text: '#' + c.name }); }));
    if (panel.channelId) select.value = panel.channelId;
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
      panel.messageId ? el('span', { class: 'muted', text: 'Publié dans #' + ((data.textChannels.find(function (c) { return c.id === panel.channelId; }) || {}).name || panel.channelId) }) : el('span', { class: 'muted', text: 'Pas encore publié' }),
    );
  }

  /**
   * Sélecteur de rôles avec recherche : liste défilante triée dans l'ordre d'affichage Discord
   * (data.roles est déjà trié par position décroissante), filtrable par nom, avec les rôles
   * déjà choisis rappelés sous forme de puces au-dessus (retrait en un clic).
   */
  function rolePicker(selectedIds, onChange) {
    return Core.rolePicker(data.roles, selectedIds, onChange);
  }

  function renderTypeCard(panel, type) {
    var isOpen = expandedTypes.has(type.id);
    var head = el(
      'div',
      { class: 'type-head', onclick: function () { if (isOpen) expandedTypes.delete(type.id); else expandedTypes.add(type.id); renderPanels(); } },
      el('h4', { text: (isOpen ? '▾ ' : '▸ ') + type.label }),
      el('span', { class: 'muted', text: (panel.style === 'select' ? 'option' : 'bouton') }),
    );

    var body = el('div', { class: 'type-body' });
    body.hidden = !isOpen;
    if (isOpen) {
      var labelInput = el('input', { type: 'text', value: type.label, maxlength: '80' });
      var emojiInput = el('input', { type: 'text', value: type.emoji || '', maxlength: '64', placeholder: '🎫' });
      var styleField;
      if (panel.style === 'select') {
        var descInput = el('input', { type: 'text', value: type.selectDescription || '', maxlength: '100', placeholder: 'Description de l’option' });
        styleField = el('label', { class: 'field field-grow' }, el('span', { text: 'Description (sélecteur)' }), descInput);
        styleField.input = descInput;
      } else {
        var buttonStyleSelect = el('select', {}, ['primary', 'secondary', 'success', 'danger'].map(function (s) { return el('option', { value: s, text: s }); }));
        buttonStyleSelect.value = type.buttonStyle || 'primary';
        styleField = el('label', { class: 'field' }, el('span', { text: 'Couleur du bouton' }), buttonStyleSelect);
        styleField.input = buttonStyleSelect;
      }

      var categorySelect = el('select', {}, el('option', { value: '', text: '(choisir une catégorie)' }), data.categories.map(function (c) { return el('option', { value: c.id, text: c.name }); }));
      categorySelect.value = type.categoryId || '';
      var maxOpenInput = el('input', { type: 'number', min: '1', max: '1000', placeholder: 'illimité', value: type.maxOpen || '' });
      var channelNameInput = el('input', { type: 'text', value: type.channelNamePattern || '', maxlength: '100', placeholder: 'ticket-{number}-{username}' });

      var claimedNameInput = el('input', { type: 'text', value: type.claimedChannelNamePattern || '', maxlength: '100', placeholder: 'ex. claim-{claimer}-{number} (vide = nom inchangé)' });
      var closedNameInput = el('input', { type: 'text', value: type.closedChannelNamePattern || '', maxlength: '100', placeholder: 'ex. ferme-{number}-{username} (vide = nom inchangé)' });
      var repingMessageInput = el('textarea', { rows: '2', maxlength: '1000', placeholder: '{staff} Rappel : {user} attend une réponse dans {channel}.' }, type.repingMessage || '');
      var closeOnLeave = el('input', { type: 'checkbox' });
      closeOnLeave.checked = type.closeOnLeave;

      var modRoles = type.modRoleIds.slice();
      var notifyRoles = type.notifyRoleIds.slice();
      var helperRoles = type.helperRoleIds.slice();
      var repingRoles = type.repingRoleIds.slice();

      var openedTitle = el('input', { type: 'text', value: type.openedTitle || '', maxlength: '256' });
      var openedDesc = el('textarea', { rows: '3', maxlength: '4096' }, type.openedDescription || '');
      var openedColor = el('input', { type: 'color', value: type.openedColor || '#2b2d31' });
      var openedFooter = el('input', { type: 'text', value: type.openedFooter || '', maxlength: '2048' });
      var openedImage = el('input', { type: 'text', value: type.openedImage || '', placeholder: 'https://…' });
      var previewBox = el('div', {}, embedPreview({ title: type.openedTitle, description: type.openedDescription, color: type.openedColor, footer: type.openedFooter, image: type.openedImage }));
      function refreshPreview() {
        Core.clear(previewBox).append(embedPreview({ title: openedTitle.value, description: openedDesc.value, color: openedColor.value, footer: openedFooter.value, image: openedImage.value }));
      }
      [openedTitle, openedDesc, openedColor, openedFooter, openedImage].forEach(function (i) { i.addEventListener('input', refreshPreview); });
      var placeholderHint = el(
        'p',
        { class: 'muted' },
        'Placeholders disponibles : {user} (mention) · {username} (nom, sans mention) · {type} · {ticket} (#42) · {number} (0042) · {server} · {category} · {mods} (mention des rôles modérateur). ',
        el('strong', { text: 'Les mentions ({user}, {mods}) ne s’affichent pas dans le titre ni le pied de page' }),
        ' (limitation Discord : seule la description les affiche correctement) — utilise plutôt {username} dans le titre.',
      );

      var autoTranscript = el('input', { type: 'checkbox' });
      autoTranscript.checked = type.autoTranscript;
      var transcriptPrompt = el('input', { type: 'checkbox' });
      transcriptPrompt.checked = type.transcriptPrompt;
      var liveTranscript = el('input', { type: 'checkbox' });
      liveTranscript.checked = type.liveTranscript;
      var userCanClose = el('input', { type: 'checkbox' });
      userCanClose.checked = type.userCanClose;
      var ratingEnabled = el('input', { type: 'checkbox' });
      ratingEnabled.checked = type.ratingEnabled;
      var claimRequired = el('input', { type: 'checkbox' });
      claimRequired.checked = type.claimRequired;
      var autoCloseInput = el('input', { type: 'number', min: '1', max: '43200', placeholder: 'désactivée', value: type.autoCloseMinutes || '' });
      var repingInput = el('input', { type: 'number', min: '1', max: '43200', placeholder: 'désactivé', value: type.repingMinutes || '' });
      var autoDeleteInput = el('input', { type: 'number', min: '1', max: '8760', placeholder: 'désactivée', value: type.autoDeleteHours || '' });

      // Formulaire d'ouverture : jusqu'à 5 questions posées dans une fenêtre Discord avant la création du ticket.
      var formEnabled = el('input', { type: 'checkbox' });
      formEnabled.checked = type.formEnabled;
      var formTitle = el('input', { type: 'text', maxlength: '45', placeholder: type.label, value: type.formTitle || '' });
      var questions = (type.formQuestions || []).map(function (q) { return Object.assign({}, q); });
      var questionsBox = el('div', { class: 'question-list' });
      function renderQuestions() {
        Core.clear(questionsBox);
        questions.forEach(function (q, index) {
          var labelInput = el('input', { type: 'text', maxlength: '45', placeholder: 'Question (45 caractères max)', value: q.label, oninput: function () { q.label = labelInput.value; } });
          var placeholderInput = el('input', { type: 'text', maxlength: '100', placeholder: 'Texte d’exemple (facultatif)', value: q.placeholder || '', oninput: function () { q.placeholder = placeholderInput.value; } });
          var styleSelect = el('select', { onchange: function () { q.style = styleSelect.value; } }, el('option', { value: 'short', text: 'Réponse courte' }), el('option', { value: 'paragraph', text: 'Paragraphe' }));
          styleSelect.value = q.style || 'short';
          var maxInput = el('input', { type: 'number', min: '1', max: '4000', value: q.maxLength || '', title: 'Longueur maximale', oninput: function () { q.maxLength = Number(maxInput.value) || null; } });
          var required = el('input', { type: 'checkbox', onchange: function () { q.required = required.checked; } });
          required.checked = q.required !== false;
          questionsBox.append(
            el('div', { class: 'question-row' },
              el('span', { class: 'question-index', text: String(index + 1) }),
              el('label', { class: 'field field-grow' }, el('span', { text: 'Question' }), labelInput),
              el('label', { class: 'field field-grow' }, el('span', { text: 'Exemple' }), placeholderInput),
              el('label', { class: 'field' }, el('span', { text: 'Format' }), styleSelect),
              el('label', { class: 'field' }, el('span', { text: 'Max.' }), maxInput),
              el('label', { class: 'check' }, required, 'Obligatoire'),
              el('button', { type: 'button', class: 'btn btn-ghost btn-small', text: '✕', title: 'Retirer la question', onclick: function () { questions.splice(index, 1); renderQuestions(); } }),
            ),
          );
        });
        if (questions.length < 5) {
          questionsBox.append(
            el('button', {
              type: 'button',
              class: 'btn btn-small',
              text: '+ Ajouter une question (' + questions.length + '/5)',
              onclick: function () { questions.push({ label: '', placeholder: '', style: 'short', required: true, maxLength: 200 }); renderQuestions(); },
            }),
          );
        }
      }
      renderQuestions();

      var repingSameAsNotify = el('input', { type: 'checkbox', onchange: function () { refreshRepingRolesBox(); } });
      repingSameAsNotify.checked = type.repingSameAsNotify;
      var repingRolesBox = el('div', {});
      function refreshRepingRolesBox() {
        Core.clear(repingRolesBox);
        if (!repingSameAsNotify.checked) repingRolesBox.append(rolePicker(repingRoles, function () {}));
      }
      refreshRepingRolesBox();

      var save = el('button', {
        type: 'button',
        class: 'btn btn-primary',
        text: '💾 Enregistrer ce type',
        onclick: function () {
          var payload = {
            label: labelInput.value.trim() || 'Ticket',
            emoji: emojiInput.value.trim() || null,
            categoryId: categorySelect.value || null,
            maxOpen: maxOpenInput.value === '' ? null : Number(maxOpenInput.value),
            channelNamePattern: channelNameInput.value.trim() || null,
            claimedChannelNamePattern: claimedNameInput.value.trim() || null,
            closedChannelNamePattern: closedNameInput.value.trim() || null,
            repingMessage: repingMessageInput.value.trim() || null,
            closeOnLeave: closeOnLeave.checked,
            modRoleIds: modRoles,
            notifyRoleIds: notifyRoles,
            helperRoleIds: helperRoles,
            repingRoleIds: repingRoles,
            repingSameAsNotify: repingSameAsNotify.checked,
            openedTitle: openedTitle.value.trim() || null,
            openedDescription: openedDesc.value.trim() || null,
            openedColor: openedColor.value || null,
            openedFooter: openedFooter.value.trim() || null,
            openedImage: openedImage.value.trim() || null,
            autoTranscript: autoTranscript.checked,
            transcriptPrompt: transcriptPrompt.checked,
            liveTranscript: liveTranscript.checked,
            userCanClose: userCanClose.checked,
            ratingEnabled: ratingEnabled.checked,
            claimRequired: claimRequired.checked,
            autoCloseMinutes: autoCloseInput.value === '' ? null : Number(autoCloseInput.value),
            repingMinutes: repingInput.value === '' ? null : Number(repingInput.value),
            autoDeleteHours: autoDeleteInput.value === '' ? null : Number(autoDeleteInput.value),
            formEnabled: formEnabled.checked,
            formTitle: formTitle.value.trim() || null,
            formQuestions: questions.filter(function (q) { return q.label && q.label.trim(); }),
          };
          if (panel.style === 'select') payload.selectDescription = styleField.input.value.trim() || null;
          else payload.buttonStyle = styleField.input.value;
          save.disabled = true;
          refresh(call('POST', '/types/' + type.id + query(), payload)).finally(function () { save.disabled = false; });
        },
      });
      var remove = el('button', {
        type: 'button',
        class: 'btn btn-danger btn-small',
        text: 'Supprimer ce type',
        onclick: function () {
          Core.confirm('Supprimer le type « ' + type.label + ' » ? Cette action est irréversible (les tickets déjà ouverts ne sont pas affectés).').then(function (ok) {
            if (ok) refresh(call('DELETE', '/types/' + type.id + query()));
          });
        },
      });

      body.append(
        el('div', { class: 'field-row' }, el('label', { class: 'field field-grow' }, el('span', { text: 'Libellé' }), labelInput), el('label', { class: 'field' }, el('span', { text: 'Émoji' }), emojiInput), styleField),
        el('div', { class: 'field-row' }, el('label', { class: 'field' }, el('span', { text: 'Catégorie' }), categorySelect), el('label', { class: 'field' }, el('span', { text: 'Limite de tickets ouverts' }), maxOpenInput)),
        el('label', { class: 'field field-grow' }, el('span', { text: 'Nom du salon' }), channelNameInput),
        el('p', { class: 'muted', text: 'Placeholders : {number} (0042) · {username} (ou {user}, alias) · {type}. Par défaut : ticket-{number}-{username}.' }),
        el('div', { class: 'field-row' },
          el('label', { class: 'field field-grow' }, el('span', { text: 'Nom du salon une fois pris en charge (claim)' }), claimedNameInput),
          el('label', { class: 'field field-grow' }, el('span', { text: 'Nom du salon une fois fermé' }), closedNameInput),
        ),
        el('p', { class: 'muted', text: 'Mêmes placeholders, plus {claimer} (nom du modérateur qui a pris le ticket en charge). Discord limite le renommage d’un salon à 2 fois par 10 minutes : le changement peut être retardé.' }),
        el('h4', { class: 'section-title', text: 'Rôle(s) modérateur — voir, écrire, fermer, claim, ajouter/retirer' }),
        rolePicker(modRoles, function () {}),
        el('h4', { class: 'section-title', text: 'Rôle(s) notifié(s) — mentionnés à l’ouverture' }),
        rolePicker(notifyRoles, function () {}),
        el('h4', { class: 'section-title', text: 'Rôle(s) helper — voir et écrire, sans claim ni fermer' }),
        rolePicker(helperRoles, function () {}),
        el('h4', { class: 'section-title', text: 'Embed affiché à l’ouverture du ticket' }),
        placeholderHint,
        el('label', { class: 'field field-grow' }, el('span', { text: 'Titre' }), openedTitle),
        el('label', { class: 'field field-grow' }, el('span', { text: 'Description' }), openedDesc),
        el('div', { class: 'field-row' }, el('label', { class: 'field' }, el('span', { text: 'Couleur' }), openedColor), el('label', { class: 'field field-grow' }, el('span', { text: 'Pied de page' }), openedFooter)),
        el('label', { class: 'field field-grow' }, el('span', { text: 'Image (URL)' }), openedImage),
        el('label', { class: 'field' }, el('span', { text: 'Aperçu' }), previewBox),
        el('h4', { class: 'section-title', text: 'Clôture automatique et reping' }),
        el('p', { class: 'muted', text: 'Soumis à la plage horaire d’activation de ce panel (ci-dessus). Vide = désactivé.' }),
        el('div', { class: 'field-row' },
          el('label', { class: 'field' }, el('span', { text: 'Proposer la clôture après (min) si le staff attend une réponse (le staff confirme)' }), autoCloseInput),
          el('label', { class: 'field' }, el('span', { text: 'Reping après (min) si le staff n’a pas répondu' }), repingInput),
        ),
        el('label', { class: 'check' }, repingSameAsNotify, 'Repinger les mêmes rôles que les rôles notifiés'),
        repingRolesBox,
        el('label', { class: 'field field-grow' }, el('span', { text: 'Message de rappel (reping) — vide = message par défaut' }), repingMessageInput),
        el('p', { class: 'muted', text: 'Si le ticket est pris en charge, le reping mentionne uniquement celui qui l’a pris (les rôles ci-dessus ne servent que pour un ticket non pris en charge). Placeholders : {staff} (mention de celui qui a pris le ticket, sinon des rôles repingés — ajoutée devant si absent) · {user} (ouvreur) · {ticket} · {number} · {type} · {channel}.' }),
        el('div', { class: 'toggle-row' },
          el('label', { class: 'check' }, closeOnLeave, 'Fermer automatiquement le ticket si le membre quitte le serveur'),
        ),
        el('div', { class: 'field-row' },
          el('label', { class: 'field' }, el('span', { text: 'Supprimer le salon d’un ticket fermé après (heures)' }), autoDeleteInput),
        ),
        el('p', { class: 'muted', text: 'Vide = suppression manuelle uniquement. Même effet que « Supprimer le salon » : archive dans le journal (transcript toujours consultable) et, si activée, demande de notation.' }),
        el('h4', { class: 'section-title', text: 'Formulaire d’ouverture' }),
        el('p', { class: 'muted', text: 'Si activé, le membre répond à ces questions (fenêtre Discord, 5 au maximum) avant la création du ticket ; les réponses s’affichent dans le message d’accueil et sont consultables dans l’historique.' }),
        el('div', { class: 'field-row' },
          el('label', { class: 'check' }, formEnabled, 'Activer le formulaire'),
          el('label', { class: 'field field-grow' }, el('span', { text: 'Titre de la fenêtre (vide = libellé du type)' }), formTitle),
        ),
        questionsBox,
        el('div', { class: 'toggle-row' },
          el('label', { class: 'check' }, autoTranscript, 'Transcript automatique'),
          el('label', { class: 'check' }, transcriptPrompt, 'Proposer le transcript à la fermeture'),
          el('label', { class: 'check' }, liveTranscript, 'Transcript live + réponse depuis le panel web'),
          el('label', { class: 'check' }, userCanClose, 'L’ouvreur peut fermer son propre ticket'),
        ),
        el('h4', { class: 'section-title', text: 'Prise en charge et notation' }),
        el('p', { class: 'muted', text: 'Prise en charge obligatoire : le staff doit prendre en charge (🙋) le ticket avant de pouvoir y répondre (message supprimé + avertissement sinon, aussi pour /ticket reponse et le panel). Notation : à la suppression du salon, l’ouvreur reçoit une invitation à noter le support (1 à 5 étoiles, facultatif) en message privé — seulement si le ticket a été pris en charge.' }),
        el('div', { class: 'toggle-row' },
          el('label', { class: 'check' }, claimRequired, 'Obliger à prendre en charge pour répondre'),
          el('label', { class: 'check' }, ratingEnabled, 'Activer la notation de fin de ticket'),
        ),
        el('div', { class: 'filters' }, save, remove),
      );
    }

    return el('div', { class: 'type-card' }, head, body);
  }

  function renderPanels() {
    var list = Core.clear(document.getElementById('panels-list'));
    data.panels.forEach(function (panel) {
      var types = panel.types;
      var isOpen = expandedPanels.has(panel.id);
      var summary = (panel.openTitle || 'Sans titre') + ' · ' + types.length + ' type(s)' + (panel.channelId ? ' · publié' : ' · non publié');

      var toggle = el(
        'div',
        {
          class: 'panel-head',
          onclick: function () { if (isOpen) expandedPanels.delete(panel.id); else expandedPanels.add(panel.id); renderPanels(); },
        },
        el('h3', { text: (isOpen ? '▾ ' : '▸ ') + 'Panel #' + panel.id }),
        el('span', { class: 'muted', text: summary }),
      );
      var deletePanel = el('button', {
        type: 'button',
        class: 'btn btn-danger btn-small',
        text: 'Supprimer ce panel',
        onclick: function (event) {
          event.stopPropagation();
          Core.confirm('Supprimer ce panel et tous ses types ? Le message Discord associé sera aussi supprimé.').then(function (ok) {
            if (ok) refresh(call('DELETE', '/panels/' + panel.id + query()));
          });
        },
      });
      var head = el('div', { class: 'panel-head-row' }, toggle, deletePanel);

      var body = null;
      if (isOpen) {
        var addType = el('button', {
          type: 'button',
          class: 'btn btn-small',
          text: '+ Ajouter un type (bouton/option)',
          onclick: function () { refresh(call('POST', '/panels/' + panel.id + '/types' + query(), { label: 'Nouveau type' })); },
        });
        body = el(
          'div',
          { class: 'card-body' },
          renderPublish(panel),
          renderPanelEmbedForm(panel),
          renderPanelScheduleForm(panel),
          el('h4', { class: 'section-title', text: 'Types de tickets (boutons/options)' }),
          types.length ? types.map(function (t) { return renderTypeCard(panel, t); }) : el('div', { class: 'empty', text: 'Aucun type pour l’instant.' }),
          el('div', { class: 'section-actions' }, addType),
        );
      }

      list.append(el('section', { class: 'card panel-block' }, head, body));
    });
  }

  // ── Tickets ───────────────────────────────────────────────────────────────
  function discordLink(channelId) {
    return 'https://discord.com/channels/' + guildId + '/' + channelId;
  }

  function transcriptLink(ticketId) {
    return '/m/tickets/transcript?ticket=' + encodeURIComponent(ticketId);
  }

  /** Colonnes de la table des tickets ouverts (un bloc par catégorie, la colonne Type est alors inutile). */
  function openTicketColumns() {
    return [
      { label: '#', value: function (t) { return String(t.id); } },
      { label: 'Ouvreur', value: function (t) { return personEl(t.opener); } },
      {
        label: 'Pris en charge',
        value: function (t) {
          if (t.claimedBy) return personEl(t.claimedBy);
          return t.claimRequired ? el('span', { class: 'badge-status warn', text: '⏳ À prendre en charge' }) : '—';
        },
      },
      { label: 'À répondre', value: waitingBadge },
      data.tags.length ? { label: 'Étiquettes', value: openTicketTagsCell } : null,
      { label: 'Ouvert', value: function (t) { return fmt.dateTime(t.createdAt); } },
      { label: 'Salon', value: function (t) { return el('a', { href: discordLink(t.channelId), target: '_blank', rel: 'noopener', text: 'Ouvrir' }); } },
      { label: 'Transcript', value: function (t) { return el('a', { href: transcriptLink(t.id), target: '_blank', rel: 'noopener', text: 'Voir' }); } },
      {
        label: '',
        value: function (t) {
          return el(
            'div',
            { class: 'row-actions' },
            el('button', {
              type: 'button',
              class: 'btn btn-ghost btn-small',
              text: t.claimedBy ? '🙋 Relâcher' : '🙋 Prendre en charge',
              onclick: function () { refresh(call('POST', '/tickets/' + t.id + '/claim' + query(), { claiming: !t.claimedBy })); },
            }),
            el('button', {
              type: 'button',
              class: 'btn btn-ghost btn-small',
              text: '🔒 Fermer',
              onclick: function () {
                Core.prompt('Raison de la fermeture', { placeholder: 'Raison (obligatoire)', maxlength: '512', confirmLabel: 'Fermer le ticket' }).then(function (reason) {
                  if (reason) refresh(call('POST', '/tickets/' + t.id + '/close' + query(), { reason: reason }));
                });
              },
            }),
          );
        },
      },
    ];
  }

  /**
   * Onglet « Tickets ouverts » : un bloc par catégorie (type de ticket), même vide, dans l'ordre des panels. Seules
   * les catégories visibles par ce compte sont listées (toutes pour un admin) ; « Autres » regroupe les tickets d'un
   * type supprimé.
   */
  function renderOpenTickets() {
    var host = Core.clear(document.getElementById('open-tickets-blocks'));
    var types = data.openTicketTypes || [];
    var known = {};
    types.forEach(function (type) { known[String(type.id)] = true; });
    var blocks = types.map(function (type) {
      return {
        title: (type.emoji ? type.emoji + ' ' : '') + type.label,
        claimRequired: type.claimRequired,
        rows: data.openTickets.filter(function (t) { return String(t.typeId) === String(type.id); }),
      };
    });
    var orphans = data.openTickets.filter(function (t) { return !known[String(t.typeId)]; });
    if (orphans.length) blocks.push({ title: '📁 Autres', claimRequired: false, rows: orphans });

    if (!blocks.length) {
      host.append(el('section', { class: 'card empty', text: 'Aucune catégorie de ticket visible : il faut un rôle staff (mod ou helper) d’un type de ticket.' }));
      return;
    }
    var columns = openTicketColumns();
    host.append.apply(
      host,
      blocks.map(function (block) {
        var waitingClaim = block.rows.filter(function (t) { return t.claimRequired && !t.claimedBy; }).length;
        var waitingStaff = block.rows.filter(function (t) { return t.waitingFor === 'staff'; }).length;
        var badges = [el('span', { class: 'badge-status' + (block.rows.length ? ' on' : ''), text: block.rows.length + ' ouvert' + (block.rows.length > 1 ? 's' : '') })];
        if (waitingStaff) badges.push(el('span', { class: 'badge-status warn', text: '💬 ' + waitingStaff + ' à répondre' }));
        if (waitingClaim) badges.push(el('span', { class: 'badge-status warn', text: '⏳ ' + waitingClaim + ' à prendre en charge' }));
        if (block.claimRequired) badges.push(el('span', { class: 'muted', text: 'prise en charge obligatoire' }));
        return el(
          'section',
          { class: 'card open-block' },
          el('div', { class: 'open-block-head' }, el('h3', { text: block.title }), badges),
          table(columns, block.rows, 'Aucun ticket ouvert dans cette catégorie.'),
        );
      }),
    );
  }

  var WAITING = {
    staff: { cls: 'badge-status warn', text: '💬 Staff', title: 'Le membre a écrit en dernier : au staff de répondre' },
    member: { cls: 'badge-status on', text: '🕓 Membre', title: 'Le staff a répondu en dernier : en attente du membre' },
    new: { cls: 'badge-status', text: '🆕 Sans message', title: 'Personne n’a encore écrit dans ce ticket' },
  };

  /** Qui doit répondre (calculé côté serveur, actualisé périodiquement). */
  function waitingBadge(t) {
    var w = WAITING[t.waitingFor];
    return w ? el('span', { class: w.cls, text: w.text, title: w.title }) : '—';
  }

  /**
   * Actualisation discrète des tickets ouverts (« qui doit répondre », nouveaux tickets) toutes les minutes, page
   * visible et sans fenêtre ouverte ; le reste du panel (formulaires en cours d'édition) n'est pas redessiné.
   */
  var OPEN_TICKETS_REFRESH_MS = 60 * 1000;
  setInterval(function () {
    if (!data || !guildId || document.hidden || document.querySelector('dialog[open]')) return;
    var forGuild = guildId;
    call('GET', '/state' + query())
      .then(function (state) {
        if (forGuild !== guildId || !data) return;
        data.openTickets = state.openTickets;
        data.openTicketTypes = state.openTicketTypes;
        renderOpenTickets();
      })
      .catch(function () {});
  }, OPEN_TICKETS_REFRESH_MS);

  /** Étiquettes d'un ticket ouvert : retrait en un clic, ajout par menu déroulant. */
  function openTicketTagsCell(t) {
    var setTag = function (tagId, on) { refresh(call('POST', '/tickets/' + t.id + '/tags' + query(), { tagId: tagId, on: on })); };
    var missing = data.tags.filter(function (tag) { return !t.tags.some(function (x) { return x.id === tag.id; }); });
    var picker = missing.length
      ? el(
          'select',
          { class: 'tag-add', 'aria-label': 'Ajouter une étiquette', onchange: function (event) { if (event.target.value) setTag(Number(event.target.value), true); } },
          el('option', { value: '', text: '+ étiquette' }),
          missing.map(function (tag) { return el('option', { value: String(tag.id), text: (tag.emoji ? tag.emoji + ' ' : '') + tag.name }); }),
        )
      : null;
    return el('span', { class: 'tag-list' }, t.tags.map(function (tag) { return tagChip(tag, function () { setTag(tag.id, false); }); }), picker);
  }

  /** Barre de recherche de l'historique : texte, ouvreur, staff qui l'a pris en charge, type, étiquette, période. */
  function renderHistoryFilters() {
    var f = historyFilters;
    var text = el('input', { type: 'search', placeholder: 'N° de ticket, sujet, raison, réponses, contenu des messages…', value: f.q });
    var opener = el('input', { inputmode: 'numeric', maxlength: '20', placeholder: 'ID de l’ouvreur', value: f.opener });
    var staff = el('select', {}, el('option', { value: '', text: 'Tout le staff' }), data.staffChoices.map(function (p) { return el('option', { value: p.id, text: p.name }); }));
    staff.value = f.staff;
    var typeSelect = el('select', {}, el('option', { value: '', text: 'Tous les types' }), data.types.map(function (t) { return el('option', { value: String(t.id), text: t.label }); }));
    typeSelect.value = f.type;
    var tagSelect = data.tags.length
      ? el('select', {}, el('option', { value: '', text: 'Toutes' }), data.tags.map(function (t) { return el('option', { value: String(t.id), text: (t.emoji ? t.emoji + ' ' : '') + t.name }); }))
      : null;
    if (tagSelect) tagSelect.value = f.tag;
    var from = el('input', { type: 'date', value: f.from });
    var to = el('input', { type: 'date', value: f.to });

    function apply(event) {
      if (event) event.preventDefault();
      var openerId = opener.value.trim();
      if (openerId && !/^\d{17,20}$/.test(openerId)) return showError('ID Discord invalide (17 à 20 chiffres attendus).');
      historyFilters = { q: text.value.trim(), opener: openerId, staff: staff.value, type: typeSelect.value, tag: tagSelect ? tagSelect.value : '', from: from.value, to: to.value, page: 1 };
      reloadHistory();
    }

    Core.clear(document.getElementById('history-filters-card')).append(
      el(
        'form',
        { class: 'filters', onsubmit: apply },
        el('label', { class: 'field field-grow' }, el('span', { text: 'Recherche' }), text),
        el('label', { class: 'field' }, el('span', { text: 'Ouvreur' }), opener),
        el('label', { class: 'field' }, el('span', { text: 'Pris en charge par' }), staff),
        el('label', { class: 'field' }, el('span', { text: 'Type' }), typeSelect),
        tagSelect ? el('label', { class: 'field' }, el('span', { text: 'Étiquette' }), tagSelect) : null,
        el('label', { class: 'field' }, el('span', { text: 'Fermé du' }), from),
        el('label', { class: 'field' }, el('span', { text: 'au' }), to),
        el('button', { type: 'submit', class: 'btn btn-primary', text: '🔎 Rechercher' }),
        el('button', {
          type: 'button',
          class: 'btn btn-ghost',
          text: 'Réinitialiser',
          onclick: function () {
            historyFilters = { q: '', opener: '', staff: '', type: '', tag: '', from: '', to: '', page: 1 };
            renderHistoryFilters();
            reloadHistory();
          },
        }),
      ),
    );
  }

  function renderClosedTickets() {
    var pager = el(
      'div',
      { class: 'hist-pager' },
      el('button', { type: 'button', class: 'btn btn-ghost btn-small', text: '❮ Précédent', disabled: closedMeta.page <= 1, onclick: function () { historyFilters.page -= 1; reloadHistory(); } }),
      'Page ' + closedMeta.page + ' / ' + closedMeta.pages + ' · ' + fmt.number(closedMeta.total) + ' ticket(s)',
      el('button', { type: 'button', class: 'btn btn-ghost btn-small', text: 'Suivant ❯', disabled: closedMeta.page >= closedMeta.pages, onclick: function () { historyFilters.page += 1; reloadHistory(); } }),
    );
    Core.clear(document.getElementById('closed-tickets-card')).append(
      table(
        [
          { label: '#', value: function (t) { return String(t.id); } },
          { label: 'Ouvreur', value: function (t) { return personEl(t.opener); } },
          { label: 'Type', value: function (t) { return t.typeLabel; } },
          { label: 'Pris en charge par', value: function (t) { return t.claimedBy ? personEl(t.claimedBy) : el('span', { class: 'muted', text: '—' }); } },
          data.tags.length ? { label: 'Étiquettes', value: function (t) { return tagsCell(t.tags); } } : null,
          { label: 'Fermé par', value: function (t) { return t.closedBy ? personEl(t.closedBy) : el('span', { class: 'muted', text: 'automatique' }); } },
          { label: 'Le', value: function (t) { return fmt.dateTime(t.closedAt); } },
          { label: 'Note', value: function (t) { return t.ratingStars ? '⭐'.repeat(t.ratingStars) : el('span', { class: 'muted', text: '—' }); } },
          { label: 'Transcript', value: function (t) { return t.transcriptGenerated ? el('a', { href: transcriptLink(t.id), target: '_blank', rel: 'noopener', text: 'Voir' }) : el('span', { class: 'muted', text: 'non généré' }); } },
          {
            label: '',
            value: function (t) {
              // Salon supprimé : le ticket est définitivement archivé, ni réouverture ni suppression possibles.
              if (!t.channelExists) return el('span', { class: 'muted', text: 'Salon supprimé' });
              return el(
                'div',
                { class: 'row-actions' },
                el('button', {
                  type: 'button',
                  class: 'btn btn-ghost btn-small',
                  text: 'Réouvrir',
                  onclick: function () { refresh(call('POST', '/tickets/' + t.id + '/reopen' + query())); },
                }),
                el('button', {
                  type: 'button',
                  class: 'btn btn-ghost btn-small',
                  text: 'Supprimer le salon',
                  onclick: function () {
                    Core.confirm('Supprimer le salon Discord de ce ticket ? Le transcript reste consultable.').then(function (ok) {
                      if (ok) refresh(call('DELETE', '/tickets/' + t.id + '/channel' + query()));
                    });
                  },
                }),
              );
            },
          },
        ],
        closedTickets,
        'Aucun ticket fermé ne correspond.',
      ),
      closedMeta.pages > 1 || closedMeta.total ? pager : el('span'),
    );
  }

  /** « 4.3/5 ⭐⭐⭐⭐ (12) » : la moyenne, ses étoiles, puis le nombre d'avis entre parenthèses. */
  function averageText(average, count) {
    return average.toFixed(1) + '/5 ' + '⭐'.repeat(Math.max(1, Math.round(average))) + ' (' + fmt.number(count) + ')';
  }

  var EMPTY_RATINGS = 'Aucune notation reçue pour l’instant (demandée une fois le salon d’un ticket pris en charge supprimé).';

  function renderRatingsByStaff() {
    Core.clear(document.getElementById('ratings-staff-card')).append(
      table(
        [
          { label: 'Membre du staff', value: function (r) { return personEl(r.person); } },
          { label: 'Moyenne (avis)', value: function (r) { return averageText(r.average, r.count); } },
        ],
        data.ratingsByStaff,
        EMPTY_RATINGS,
      ),
    );
  }

  function renderRatingsByType() {
    Core.clear(document.getElementById('ratings-types-card')).append(
      table(
        [
          { label: 'Type de ticket', value: function (r) { return r.typeLabel; } },
          { label: 'Moyenne (avis)', value: function (r) { return averageText(r.average, r.count); } },
        ],
        data.ratingsByType,
        EMPTY_RATINGS,
      ),
    );
  }

  function renderRatingReviews() {
    Core.clear(document.getElementById('ratings-reviews-card')).append(
      table(
        [
          { label: 'Ticket', value: function (r) { return '#' + r.ticketId; } },
          { label: 'Type', value: function (r) { return r.typeLabel; } },
          { label: 'Staff', value: function (r) { return r.staff ? personEl(r.staff) : el('span', { class: 'muted', text: '—' }); } },
          { label: 'Ouvreur', value: function (r) { return personEl(r.opener); } },
          { label: 'Note', value: function (r) { return '⭐'.repeat(r.stars) + ' (' + r.stars + '/5)'; } },
          { label: 'Le', value: function (r) { return fmt.dateTime(r.at); } },
        ],
        data.ratingReviews,
        EMPTY_RATINGS,
      ),
    );
  }

  var activeRatingSub = 'staff';
  function setupRatingSubtabs() {
    var buttons = [].slice.call(document.querySelectorAll('.subtab-btn'));
    function activate(name) {
      activeRatingSub = name;
      buttons.forEach(function (b) { b.classList.toggle('active', b.dataset.sub === name); });
      document.querySelectorAll('.subtab-panel').forEach(function (panel) { panel.hidden = panel.id !== 'sub-' + name; });
    }
    buttons.forEach(function (b) { b.addEventListener('click', function () { activate(b.dataset.sub); }); });
    activate(activeRatingSub);
  }

  function renderAll() {
    renderTiles();
    renderSettings();
    renderModmail();
    renderModmailCategories();
    renderModmailOpen();
    renderModmailClosed();
    renderAdmins();
    renderSnippets();
    renderTags();
    renderBlacklist();
    renderModmailPrefixes();
    renderPanels();
    renderOpenTickets();
    renderHistoryFilters();
    renderClosedTickets();
    renderRatingsByStaff();
    renderRatingsByType();
    renderRatingReviews();
  }

  function setupTabs() {
    var buttons = [...document.querySelectorAll('.tab-btn')];
    function activate(name) {
      buttons.forEach(function (b) { b.classList.toggle('active', b.dataset.tab === name); });
      document.querySelectorAll('.tab-panel').forEach(function (panel) {
        panel.hidden = panel.id !== 'tab-' + name;
      });
    }
    buttons.forEach(function (b) { b.addEventListener('click', function () { activate(b.dataset.tab); }); });
    activate(buttons[0] ? buttons[0].dataset.tab : 'overview');
  }

  async function loadGuild() {
    document.getElementById('content').hidden = true;
    expandedTypes.clear();
    expandedPanels.clear();
    expandedModmailCategories.clear();
    historyFilters = { q: '', opener: '', staff: '', type: '', tag: '', from: '', to: '', page: 1 };
    editingSnippet = null;
    await refresh(call('GET', '/state' + query()));
    document.getElementById('content').hidden = false;
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
      guildId = guilds[0].id;
      select.value = guildId;
      select.addEventListener('change', function () {
        guildId = select.value;
        loadGuild();
      });
      document.getElementById('add-panel').addEventListener('click', function () {
        refresh(call('POST', '/panels' + query(), {}));
      });
      document.getElementById('add-modmail-category').addEventListener('click', function () {
        refresh(call('POST', '/modmail-categories' + query(), { name: 'Nouvelle catégorie' }));
      });
      setupTabs();
      setupRatingSubtabs();
      await loadGuild();
    } catch (err) {
      showError(err.message);
    }
  }

  start();
})();
