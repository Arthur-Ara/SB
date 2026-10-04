/* Panel web du module Support automatique : panels, arbre de catégories/réponses. */
(function () {
  'use strict';

  var el = Core.el;
  var API = '/m/support/api';
  var main = document.getElementById('main');
  var guildId = '';
  var data = null;
  var expandedPanels = new Set();
  var expandedNodes = new Set();

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
      renderAll();
    } catch (err) {
      showError(err.message);
    } finally {
      main.classList.remove('is-loading');
    }
  }

  // ── Aperçu / formulaire d'embed (réutilisé pour un panel comme pour un nœud) ──────────────────
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

  function embedForm(fields) {
    var titleInput = el('input', { type: 'text', value: fields.title || '', maxlength: '256' });
    var descInput = el('textarea', { maxlength: '4096', rows: '3' }, fields.description || '');
    var colorInput = el('input', { type: 'color', value: fields.color || '#2b2d31' });
    var footerInput = el('input', { type: 'text', value: fields.footer || '', maxlength: '2048' });
    var imageInput = el('input', { type: 'text', placeholder: 'https://…', value: fields.image || '' });
    var thumbInput = el('input', { type: 'text', placeholder: 'https://…', value: fields.thumbnail || '' });

    var previewBox = el('div', {}, embedPreview({ title: fields.title, description: fields.description, color: fields.color, footer: fields.footer, image: fields.image }));
    function refreshPreview() {
      Core.clear(previewBox).append(embedPreview({ title: titleInput.value, description: descInput.value, color: colorInput.value, footer: footerInput.value, image: imageInput.value }));
    }
    [titleInput, descInput, colorInput, footerInput, imageInput].forEach(function (input) { input.addEventListener('input', refreshPreview); });

    var box = el(
      'div',
      { class: 'stack' },
      el('div', { class: 'field-row' },
        el('label', { class: 'field field-grow' }, el('span', { text: 'Titre' }), titleInput),
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
    );
    box.values = function () {
      return {
        embedTitle: titleInput.value.trim() || null,
        embedDescription: descInput.value.trim() || null,
        embedColor: colorInput.value || null,
        embedFooter: footerInput.value.trim() || null,
        embedImage: imageInput.value.trim() || null,
        embedThumbnail: thumbInput.value.trim() || null,
      };
    };
    return box;
  }

  // ── Panels ──────────────────────────────────────────────────────────────
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
      panel.messageId
        ? el('span', { class: 'muted', text: 'Publié dans #' + ((data.textChannels.find(function (c) { return c.id === panel.channelId; }) || {}).name || panel.channelId) })
        : el('span', { class: 'muted', text: 'Pas encore publié' }),
    );
  }

  function renderPanelForm(panel) {
    var form = embedForm({ title: panel.embedTitle, description: panel.embedDescription, color: panel.embedColor, footer: panel.embedFooter, image: panel.embedImage, thumbnail: panel.embedThumbnail });
    var placeholderInput = el('input', { type: 'text', value: panel.placeholder || '', maxlength: '150', placeholder: 'Choisis une catégorie…' });
    var save = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: '💾 Enregistrer l’embed du panel',
      onclick: function () {
        save.disabled = true;
        var payload = form.values();
        payload.placeholder = placeholderInput.value.trim() || null;
        refresh(call('POST', '/panels/' + panel.id + query(), payload)).finally(function () { save.disabled = false; });
      },
    });
    return el(
      'div',
      { class: 'stack' },
      form,
      el('label', { class: 'field field-grow' }, el('span', { text: 'Texte du menu déroulant (placeholder)' }), placeholderInput),
      el('div', { class: 'filters' }, save),
    );
  }

  function childrenOf(panel, parentId) {
    return panel.nodes.filter(function (n) { return n.parentId === parentId; });
  }

  /** Chemin complet depuis la racine du panel jusqu'à ce nœud (breadcrumb « à quel niveau je suis »). */
  function nodePath(panel, node) {
    var chain = [];
    var current = node;
    var guard = 0;
    while (current && guard < 25) {
      chain.unshift(current);
      current = panel.nodes.find(function (n) { return n.id === current.parentId; });
      guard += 1;
    }
    return chain;
  }

  function breadcrumbEl(panel, node) {
    var chain = nodePath(panel, node);
    var parts = [el('span', { class: 'crumb-node', text: '📋 Panel #' + panel.id })];
    chain.forEach(function (n) {
      parts.push(el('span', { class: 'crumb-sep', text: '›' }));
      parts.push(
        el('span', {
          class: 'crumb-node' + (n.id === node.id ? ' current' : ''),
          text: (n.emoji ? n.emoji + ' ' : '') + n.label + (n.kind === 'response' ? ' (réponse)' : ' (catégorie)'),
        }),
      );
    });
    return el('div', { class: 'breadcrumb' }, parts);
  }

  function addNodeButtons(panel, parentId) {
    return el(
      'div',
      { class: 'filters' },
      el('button', {
        type: 'button',
        class: 'btn btn-small',
        text: '+ Catégorie',
        onclick: function () { refresh(call('POST', '/nodes' + query(), { panelId: panel.id, parentId: parentId, kind: 'category', label: 'Nouvelle catégorie' })); },
      }),
      el('button', {
        type: 'button',
        class: 'btn btn-small',
        text: '+ Réponse',
        onclick: function () { refresh(call('POST', '/nodes' + query(), { panelId: panel.id, parentId: parentId, kind: 'response', label: 'Nouvelle réponse' })); },
      }),
    );
  }

  /** Taux de résolution d'une réponse : part des avis « Ça m'a aidé » (null sans avis). */
  function resolutionRate(stats) {
    var votes = stats.helpful + stats.unhelpful;
    return votes ? stats.helpful / votes : null;
  }

  function statsText(node) {
    var s = node.stats;
    var parts = ['👁 ' + Core.fmt.number(s.views)];
    if (node.kind === 'response') {
      parts.push('👍 ' + s.helpful, '👎 ' + s.unhelpful, '🎫 ' + s.tickets);
      var rate = resolutionRate(s);
      if (rate !== null) parts.push(Core.fmt.percent(rate) + ' résolu');
    }
    return parts.join(' · ');
  }

  function moveButton(node, direction) {
    return el('button', {
      type: 'button',
      class: 'btn btn-ghost btn-small',
      text: direction < 0 ? '▲' : '▼',
      title: direction < 0 ? 'Monter' : 'Descendre',
      onclick: function (event) {
        event.stopPropagation();
        refresh(call('POST', '/nodes/' + node.id + '/move' + query(), { direction: direction }));
      },
    });
  }

  function renderNode(panel, node) {
    var isOpen = expandedNodes.has(node.id);
    var siblings = childrenOf(panel, node.parentId);
    var index = siblings.indexOf(node);
    var head = el(
      'div',
      { class: 'type-head', onclick: function () { if (isOpen) expandedNodes.delete(node.id); else expandedNodes.add(node.id); renderAll(); } },
      el('h4', { text: (isOpen ? '▾ ' : '▸ ') + (node.emoji ? node.emoji + ' ' : '') + node.label }),
      el(
        'span',
        { class: 'node-head-meta' },
        node.allowedRoleIds.length ? el('span', { class: 'node-kind-badge restricted', text: '🔒 ' + node.allowedRoleIds.length + ' rôle(s)', title: 'Réservé à certains rôles' }) : null,
        el('span', { class: 'node-stats', text: statsText(node) }),
        el('span', { class: 'node-kind-badge' + (node.kind === 'response' ? ' response' : ''), text: node.kind === 'response' ? 'réponse' : 'catégorie' }),
        index > 0 ? moveButton(node, -1) : null,
        index < siblings.length - 1 ? moveButton(node, 1) : null,
      ),
    );

    var body = el('div', { class: 'type-body' });
    body.hidden = !isOpen;
    if (isOpen) {
      var labelInput = el('input', { type: 'text', value: node.label, maxlength: '100' });
      var emojiInput = el('input', { type: 'text', value: node.emoji || '', maxlength: '64', placeholder: '❓' });
      var descInput = el('input', { type: 'text', value: node.selectDescription || '', maxlength: '100', placeholder: 'Description affichée dans le menu (facultatif)' });
      var form = embedForm({ title: node.embedTitle, description: node.embedDescription, color: node.embedColor, footer: node.embedFooter, image: node.embedImage, thumbnail: node.embedThumbnail });
      var allowedRoles = node.allowedRoleIds.slice();

      var extraFields = [];
      var allowTicket = null;
      var ticketTypeSelect = null;
      var extraMessageInput = null;
      if (node.kind === 'response') {
        allowTicket = el('input', { type: 'checkbox' });
        allowTicket.checked = node.allowTicket;
        ticketTypeSelect = el('select', {}, el('option', { value: '', text: '(aucune)' }), data.ticketTypes.map(function (t) { return el('option', { value: t.id, text: t.label }); }));
        ticketTypeSelect.value = node.ticketTypeId || '';
        extraMessageInput = el('textarea', { rows: '2', maxlength: '1000', placeholder: 'Message automatique ajouté dans le ticket pour prévenir le staff (facultatif)' }, node.ticketExtraMessage || '');
        extraFields = [
          el(
            'div',
            { class: 'ticket-escalation' },
            el('h4', { class: 'section-title', text: '🎫 Créer un ticket si la réponse ne suffit pas' }),
            !data.ticketsModuleEnabled
              ? el('p', { class: 'muted', text: '⚠️ Le module Tickets est désactivé sur ce serveur : active-le avec /modules pour proposer la création de ticket.' })
              : !data.ticketTypes.length
                ? el('p', { class: 'muted', text: '⚠️ Aucun type de ticket configuré : crée-en un depuis le panel Tickets (/ticket createpanel) pour pouvoir en choisir un ici.' })
                : null,
            el('div', { class: 'toggle-row' }, el('label', { class: 'check' }, allowTicket, 'Proposer un bouton « Créer un ticket » si la réponse ne convient pas')),
            el('label', { class: 'field' }, el('span', { text: 'Type de ticket ouvert' }), ticketTypeSelect),
            el('label', { class: 'field field-grow' }, el('span', { text: 'Message automatique pour le staff' }), extraMessageInput),
          ),
        ];
      }

      var save = el('button', {
        type: 'button',
        class: 'btn btn-primary',
        text: '💾 Enregistrer',
        onclick: function () {
          save.disabled = true;
          var payload = Object.assign(
            { label: labelInput.value.trim() || 'Sans nom', emoji: emojiInput.value.trim() || null, selectDescription: descInput.value.trim() || null, allowedRoleIds: allowedRoles },
            form.values(),
          );
          if (node.kind === 'response') {
            payload.allowTicket = allowTicket.checked;
            payload.ticketTypeId = ticketTypeSelect.value || null;
            payload.ticketExtraMessage = extraMessageInput.value.trim() || null;
          }
          refresh(call('POST', '/nodes/' + node.id + query(), payload)).finally(function () { save.disabled = false; });
        },
      });
      var remove = el('button', {
        type: 'button',
        class: 'btn btn-danger btn-small',
        text: node.kind === 'category' ? 'Supprimer (et son contenu)' : 'Supprimer',
        onclick: function () {
          Core.confirm('Supprimer « ' + node.label + ' »' + (node.kind === 'category' ? ' et tout son contenu' : '') + ' ?').then(function (ok) {
            if (ok) refresh(call('DELETE', '/nodes/' + node.id + query()));
          });
        },
      });

      body.append(
        breadcrumbEl(panel, node),
        el('p', {
          class: 'muted',
          text:
            node.kind === 'category'
              ? '📁 Catégorie : regroupe d’autres catégories et/ou réponses, affichées dans un sous-menu au clic.'
              : '💬 Réponse : affiche une solution au clic. C’est le seul type de nœud qui peut proposer « Créer un ticket » ci-dessous.',
        }),
        el('div', { class: 'field-row' },
          el('label', { class: 'field field-grow' }, el('span', { text: 'Libellé (affiché dans le menu)' }), labelInput),
          el('label', { class: 'field' }, el('span', { text: 'Émoji' }), emojiInput),
        ),
        el('label', { class: 'field field-grow' }, el('span', { text: 'Description (sous le libellé, dans le menu)' }), descInput),
        el('details', { class: 'role-restriction', open: allowedRoles.length > 0 },
          el('summary', { text: '🔒 Réserver à certains rôles' + (allowedRoles.length ? ' (' + allowedRoles.length + ')' : ' (ouvert à tous)') }),
          el('p', { class: 'muted', text: 'Aucun rôle coché = visible par tout le monde. Une catégorie réservée réserve aussi tout son contenu. Dans le menu principal (public), l’option reste affichée mais l’accès est refusé aux autres membres ; dans les sous-menus, elle n’apparaît même pas pour eux.' }),
          Core.rolePicker(data.roles, allowedRoles),
        ),
        ...extraFields,
        el('h4', { class: 'section-title', text: node.kind === 'category' ? 'Message affiché avant le sous-menu (facultatif)' : 'Réponse' }),
        form,
        el('div', { class: 'filters' }, save, remove),
      );

      if (node.kind === 'category') {
        var children = childrenOf(panel, node.id);
        body.append(
          el('h4', { class: 'section-title', text: 'Contenu de cette catégorie' }),
          children.length
            ? el('div', { class: 'node-tree node-children' }, children.map(function (child) { return renderNode(panel, child); }))
            : el('div', { class: 'empty', text: 'Vide pour l’instant.' }),
          addNodeButtons(panel, node.id),
        );
      }
    }

    return el('div', { class: 'type-card' }, head, body);
  }

  /**
   * Efficacité des réponses du panel : affichages, avis, tickets ouverts et taux de résolution — les réponses qui
   * mènent le plus souvent à un ticket (ou à « Pas résolu ») en premier, ce sont celles à améliorer.
   */
  function renderEfficiency(panel) {
    var responses = panel.nodes
      .filter(function (n) { return n.kind === 'response'; })
      .sort(function (a, b) { return b.stats.tickets - a.stats.tickets || b.stats.unhelpful - a.stats.unhelpful || b.stats.views - a.stats.views; });
    if (!responses.length) return null;
    var rows = responses.map(function (n) {
      var rate = resolutionRate(n.stats);
      return el(
        'tr',
        {},
        el('td', {}, nodePath(panel, n).map(function (x) { return (x.emoji ? x.emoji + ' ' : '') + x.label; }).join(' › ')),
        el('td', { class: 'num', text: Core.fmt.number(n.stats.views) }),
        el('td', { class: 'num', text: String(n.stats.helpful) }),
        el('td', { class: 'num', text: String(n.stats.unhelpful) }),
        el('td', { class: 'num', text: String(n.stats.tickets) }),
        el('td', { class: 'num' }, rate === null ? el('span', { class: 'muted', text: '—' }) : el('span', { class: rate >= 0.6 ? 'rate-good' : rate < 0.4 ? 'rate-bad' : '', text: Core.fmt.percent(rate) })),
      );
    });
    return el(
      'div',
      { class: 'stack' },
      el('h4', { class: 'section-title', text: '📈 Efficacité des réponses' }),
      el('p', { class: 'muted', text: 'Taux de résolution = avis « Ça m’a aidé » / avis donnés. Les réponses qui mènent le plus à un ticket sont en tête : ce sont celles à compléter.' }),
      el(
        'div',
        { class: 'table-wrap' },
        el(
          'table',
          { class: 'data' },
          el('thead', {}, el('tr', {}, el('th', { text: 'Réponse' }), el('th', { class: 'num', text: 'Vues' }), el('th', { class: 'num', text: '👍' }), el('th', { class: 'num', text: '👎' }), el('th', { class: 'num', text: '🎫 Tickets' }), el('th', { class: 'num', text: 'Résolu' }))),
          el('tbody', {}, rows),
        ),
      ),
    );
  }

  function renderPanels() {
    var list = Core.clear(document.getElementById('panels-list'));
    data.panels.forEach(function (panel) {
      var topNodes = childrenOf(panel, null);
      var isOpen = expandedPanels.has(panel.id);
      var summary = topNodes.length + ' élément(s) racine' + (panel.channelId ? ' · publié' : ' · non publié');

      var toggle = el(
        'div',
        { class: 'panel-head', onclick: function () { if (isOpen) expandedPanels.delete(panel.id); else expandedPanels.add(panel.id); renderAll(); } },
        el('h3', { text: (isOpen ? '▾ ' : '▸ ') + 'Panel #' + panel.id }),
        el('span', { class: 'muted', text: summary }),
      );
      var deletePanel = el('button', {
        type: 'button',
        class: 'btn btn-danger btn-small',
        text: 'Supprimer ce panel',
        onclick: function (event) {
          event.stopPropagation();
          Core.confirm('Supprimer ce panel et tout son contenu ? Le message Discord associé sera aussi supprimé.').then(function (ok) {
            if (ok) refresh(call('DELETE', '/panels/' + panel.id + query()));
          });
        },
      });
      var head = el('div', { class: 'panel-head-row' }, toggle, deletePanel);

      var body = null;
      if (isOpen) {
        body = el(
          'div',
          { class: 'card-body' },
          renderPublish(panel),
          renderPanelForm(panel),
          el('h4', { class: 'section-title', text: 'Catégories et réponses (menu principal)' }),
          topNodes.length
            ? el('div', { class: 'node-tree' }, topNodes.map(function (n) { return renderNode(panel, n); }))
            : el('div', { class: 'empty', text: 'Aucune catégorie ni réponse pour l’instant.' }),
          addNodeButtons(panel, null),
          renderEfficiency(panel),
        );
      }

      list.append(el('section', { class: 'card panel-block' }, head, body));
    });
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
      el('div', { class: 'filters' },
        el('label', { class: 'field' }, el('span', { text: 'Salon de journal (modifications de la configuration)' }), select),
        save,
      ),
    );
  }

  function renderTicketsWarning() {
    var box = document.getElementById('tickets-warning');
    if (data.ticketsModuleEnabled) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    Core.clear(box).append(
      el('p', { class: 'muted', text: '⚠️ Le module Tickets est désactivé sur ce serveur : la création de ticket depuis une réponse ne sera pas proposée tant qu’il n’est pas réactivé (/modules sur Discord).' }),
    );
  }

  function renderAll() {
    renderSettings();
    renderTicketsWarning();
    renderPanels();
  }

  async function loadGuild() {
    document.getElementById('content').hidden = true;
    expandedPanels.clear();
    expandedNodes.clear();
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
      await loadGuild();
    } catch (err) {
      showError(err.message);
    }
  }

  start();
})();
