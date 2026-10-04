/* Panel web du module RôleMenu : menus, options et conditions. */
(function () {
  'use strict';

  var el = Core.el;
  var API = '/m/rolemenu/api';
  var main = document.getElementById('main');
  var guildId = '';
  var data = null;
  var expandedMenus = new Set();
  var expandedOptions = new Set();

  var TYPES = [['reaction', 'Réactions (emojis)'], ['button', 'Boutons'], ['select', 'Menu déroulant']];
  var MODES = [['multiple', 'Plusieurs rôles'], ['single', 'Un seul rôle parmi la liste']];
  var STYLES = [['secondary', 'Gris'], ['primary', 'Bleu'], ['success', 'Vert'], ['danger', 'Rouge']];

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

  function label(list, value) {
    var found = list.find(function (item) { return item[0] === value; });
    return found ? found[1] : value;
  }

  function selectOf(list, value) {
    var select = el('select', {}, list.map(function (item) { return el('option', { value: item[0], text: item[1] }); }));
    select.value = value;
    return select;
  }

  /** Sélecteur de rôle : les rôles que le bot refuserait d'attribuer sont grisés, avec la raison. */
  function roleSelect(selected) {
    var select = el(
      'select',
      {},
      data.roles.map(function (role) {
        return el('option', { value: role.id, disabled: role.problem ? true : null, text: '@' + role.name + (role.problem ? ' — refusé : ' + role.problem : '') });
      }),
    );
    if (selected) select.value = selected;
    return select;
  }

  function button(text, cls, onclick) {
    return el('button', { type: 'button', class: 'btn btn-small ' + (cls || ''), text: text, onclick: onclick });
  }

  function confirmThen(message, action) {
    return function (event) {
      if (event) event.stopPropagation();
      Core.confirm(message).then(function (ok) {
        if (ok) action();
      });
    };
  }

  // ── Embed (aperçu + formulaire) ───────────────────────────────────────────
  function embedPreview(fields) {
    if (!fields.title && !fields.description) {
      return el('div', { class: 'embed-preview empty', text: 'Aucun texte personnalisé : le bot génère le message avec la liste des rôles.' });
    }
    return el(
      'div',
      { class: 'embed-preview', style: 'border-left-color:' + (fields.color || '#5865F2') },
      fields.title ? el('div', { class: 'ep-title', text: fields.title }) : null,
      fields.description ? el('div', { class: 'ep-desc', text: fields.description }) : null,
      fields.footer ? el('div', { class: 'ep-footer', text: fields.footer }) : null,
    );
  }

  function embedForm(menu) {
    var titleInput = el('input', { type: 'text', value: menu.embedTitle || '', maxlength: '256' });
    var descInput = el('textarea', { maxlength: '4000', rows: '3' }, menu.embedDescription || '');
    var colorInput = el('input', { type: 'color', value: menu.embedColor || '#2b2d31' });
    var footerInput = el('input', { type: 'text', value: menu.embedFooter || '', maxlength: '2048' });
    var imageInput = el('input', { type: 'text', placeholder: 'https://…', value: menu.embedImage || '' });
    var thumbInput = el('input', { type: 'text', placeholder: 'https://…', value: menu.embedThumbnail || '' });
    var previewBox = el('div', {});
    function refreshPreview() {
      Core.clear(previewBox).append(embedPreview({ title: titleInput.value, description: descInput.value, color: colorInput.value, footer: footerInput.value }));
    }
    [titleInput, descInput, colorInput, footerInput].forEach(function (input) { input.addEventListener('input', refreshPreview); });
    refreshPreview();

    var box = el(
      'div',
      { class: 'type-body' },
      el('div', { class: 'field-row' },
        el('label', { class: 'field field-grow' }, el('span', { text: 'Titre' }), titleInput),
        el('label', { class: 'field' }, el('span', { text: 'Couleur' }), colorInput),
      ),
      el('label', { class: 'field' }, el('span', { text: 'Description (vide = liste des rôles générée automatiquement)' }), descInput),
      el('label', { class: 'field' }, el('span', { text: 'Pied de page' }), footerInput),
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

  // ── Conditions ────────────────────────────────────────────────────────────
  function conditionAddForm(menu, optionId) {
    var typeSelect = el('select', {}, data.conditionTypes.map(function (t) { return el('option', { value: t.type, text: t.label, title: t.description }); }));
    var paramsBox = el('div', { class: 'field-row' });
    var inputs = {};

    function renderParams() {
      Core.clear(paramsBox);
      inputs = {};
      var def = data.conditionTypes.find(function (t) { return t.type === typeSelect.value; });
      if (!def) return;
      def.params.forEach(function (spec) {
        var input;
        if (spec.kind === 'roles') {
          input = el('select', { multiple: true, size: '5' }, data.roles.map(function (r) { return el('option', { value: r.id, text: '@' + r.name }); }));
        } else {
          input = el('input', { type: 'number', min: String(spec.min === null ? 0 : spec.min), max: spec.max === null ? null : String(spec.max), value: String(spec.min === null ? 1 : spec.min) });
        }
        inputs[spec.key] = { spec: spec, input: input };
        paramsBox.append(el('label', { class: 'field field-grow' }, el('span', { text: spec.label + (spec.kind === 'roles' ? ' (Ctrl/Cmd + clic pour en choisir plusieurs)' : '') }), input));
      });
      if (!def.params.length) paramsBox.append(el('span', { class: 'muted', text: 'Aucun paramètre.' }));
    }
    typeSelect.addEventListener('change', renderParams);
    renderParams();

    var add = button('+ Ajouter la condition', '', function () {
      var params = {};
      Object.keys(inputs).forEach(function (key) {
        var item = inputs[key];
        params[key] = item.spec.kind === 'roles' ? Array.prototype.map.call(item.input.selectedOptions, function (o) { return o.value; }) : item.input.value;
      });
      add.disabled = true;
      refresh(call('POST', '/conditions' + query(), { menuId: menu.id, optionId: optionId, type: typeSelect.value, params: params })).finally(function () { add.disabled = false; });
    });
    return el('div', { class: 'field-row' }, el('label', { class: 'field' }, el('span', { text: 'Nouvelle condition' }), typeSelect), paramsBox, add);
  }

  /** Conditions d'un menu (optionId nul) ou d'une option : toutes doivent être remplies pour obtenir le rôle. */
  function conditionsBox(menu, optionId) {
    var rows = menu.conditions.filter(function (c) { return String(c.optionId || '') === String(optionId || ''); });
    return el(
      'div',
      { class: 'cond-box' },
      el('h5', { text: optionId ? '🔒 Conditions pour ce rôle (toutes requises)' : '🔒 Conditions pour tout le menu (toutes requises)' }),
      rows.length
        ? rows.map(function (c) {
            return el(
              'div',
              { class: 'cond-row' },
              el('span', { text: c.summary + (c.known ? '' : ' ⚠️ type indisponible : bloque l’accès') }),
              button('Retirer', 'btn-ghost', function () { refresh(call('DELETE', '/conditions/' + c.id + query())); }),
            );
          })
        : el('div', { class: 'muted', text: 'Aucune condition : tout le monde peut prendre ' + (optionId ? 'ce rôle.' : 'les rôles de ce menu.') }),
      conditionAddForm(menu, optionId),
    );
  }

  // ── Options ───────────────────────────────────────────────────────────────
  function renderOption(menu, option) {
    var open = expandedOptions.has(option.id);
    var title = (option.emoji ? option.emoji + ' ' : '') + (option.label || '@' + (option.roleName || 'rôle supprimé'));
    var head = el(
      'div',
      { class: 'type-head', onclick: function () { if (open) expandedOptions.delete(option.id); else expandedOptions.add(option.id); renderAll(); } },
      el('h4', { text: (open ? '▾ ' : '▸ ') + title }),
      el('span', {},
        option.problem ? el('span', { class: 'badge warn', text: '⚠️ ' + option.problem, title: option.problem }) : null,
        ' ',
        el('span', { class: 'badge', text: '@' + (option.roleName || option.roleId) }),
      ),
    );
    var body = null;
    if (open) {
      var labelInput = el('input', { type: 'text', value: option.label || '', maxlength: '80', placeholder: option.roleName || 'Nom du rôle' });
      var emojiInput = el('input', { type: 'text', value: option.emoji || '', maxlength: '80', placeholder: menu.type === 'reaction' ? 'Obligatoire' : 'Facultatif' });
      var descInput = el('input', { type: 'text', value: option.description || '', maxlength: '100' });
      var styleSelect = selectOf(STYLES, option.style);
      var save = button('💾 Enregistrer', 'btn-primary', function () {
        save.disabled = true;
        refresh(call('POST', '/options/' + option.id + query(), { label: labelInput.value, emoji: emojiInput.value, description: descInput.value, style: styleSelect.value })).finally(function () { save.disabled = false; });
      });
      body = el(
        'div',
        { class: 'type-body' },
        el('div', { class: 'field-row' },
          el('label', { class: 'field field-grow' }, el('span', { text: 'Texte affiché' }), labelInput),
          el('label', { class: 'field' }, el('span', { text: 'Émoji' }), emojiInput),
        ),
        menu.type === 'select' ? el('label', { class: 'field field-grow' }, el('span', { text: 'Description (sous le texte, dans le menu déroulant)' }), descInput) : null,
        menu.type === 'button' ? el('label', { class: 'field' }, el('span', { text: 'Couleur du bouton' }), styleSelect) : null,
        el('div', { class: 'actions' },
          save,
          button('▲', 'btn-ghost', function () { refresh(call('POST', '/options/' + option.id + '/move' + query(), { direction: -1 })); }),
          button('▼', 'btn-ghost', function () { refresh(call('POST', '/options/' + option.id + '/move' + query(), { direction: 1 })); }),
          button('Retirer du menu', 'btn-danger', confirmThen('Retirer ce rôle du menu ?', function () { refresh(call('DELETE', '/options/' + option.id + query())); })),
        ),
        conditionsBox(menu, option.id),
      );
    }
    return el('div', { class: 'type-card' }, head, body);
  }

  function addOptionForm(menu) {
    var role = roleSelect('');
    var labelInput = el('input', { type: 'text', maxlength: '80', placeholder: 'Nom du rôle par défaut' });
    var emojiInput = el('input', { type: 'text', maxlength: '80', placeholder: menu.type === 'reaction' ? '😀 (obligatoire)' : '😀 (facultatif)' });
    var descInput = el('input', { type: 'text', maxlength: '100' });
    var styleSelect = selectOf(STYLES, 'secondary');
    var add = button('+ Ajouter ce rôle', 'btn-primary', function () {
      add.disabled = true;
      refresh(call('POST', '/menus/' + menu.id + '/options' + query(), { roleId: role.value, label: labelInput.value, emoji: emojiInput.value, description: descInput.value, style: styleSelect.value })).finally(function () { add.disabled = false; });
    });
    if (menu.options.length >= menu.limit) {
      return el('div', { class: 'muted', text: 'Ce type de menu est plein (' + menu.limit + ' options maximum).' });
    }
    return el(
      'div',
      { class: 'cond-box' },
      el('h5', { text: '➕ Ajouter un rôle au menu' }),
      el('div', { class: 'field-row' },
        el('label', { class: 'field field-grow' }, el('span', { text: 'Rôle' }), role),
        el('label', { class: 'field' }, el('span', { text: 'Texte affiché' }), labelInput),
        el('label', { class: 'field' }, el('span', { text: 'Émoji' }), emojiInput),
        menu.type === 'select' ? el('label', { class: 'field' }, el('span', { text: 'Description' }), descInput) : null,
        menu.type === 'button' ? el('label', { class: 'field' }, el('span', { text: 'Couleur' }), styleSelect) : null,
        add,
      ),
    );
  }

  // ── Menus ─────────────────────────────────────────────────────────────────
  function renderPublish(menu) {
    var select = el('select', {}, data.textChannels.map(function (c) { return el('option', { value: c.id, text: '#' + c.name }); }));
    if (menu.channelId) select.value = menu.channelId;
    var publish = button(menu.messageId ? 'Mettre à jour / republier' : 'Publier', 'btn-primary', function () {
      publish.disabled = true;
      refresh(call('POST', '/menus/' + menu.id + '/publish' + query(), { channelId: select.value })).finally(function () { publish.disabled = false; });
    });
    var channel = data.textChannels.find(function (c) { return c.id === menu.channelId; });
    return el(
      'div',
      { class: 'field-row' },
      el('label', { class: 'field' }, el('span', { text: 'Salon du menu' }), select),
      publish,
      menu.messageId ? el('span', { class: 'muted', text: 'Publié dans #' + (channel ? channel.name : menu.channelId) }) : el('span', { class: 'muted', text: 'Pas encore publié' }),
    );
  }

  function renderMenu(menu) {
    var open = expandedMenus.has(menu.id);
    var summary = label(TYPES, menu.type) + ' · ' + label(MODES, menu.mode) + ' · ' + menu.options.length + ' option(s)' + (menu.messageId ? ' · publié' : ' · non publié');
    var head = el(
      'div',
      { class: 'panel-head-row' },
      el('div', { class: 'panel-head', onclick: function () { if (open) expandedMenus.delete(menu.id); else expandedMenus.add(menu.id); renderAll(); } },
        el('h3', { text: (open ? '▾ ' : '▸ ') + menu.name }),
        el('span', { class: 'muted', text: summary }),
      ),
      button('Supprimer ce menu', 'btn-danger', confirmThen('Supprimer ce menu, ses options, ses conditions et son message publié ?', function () { refresh(call('DELETE', '/menus/' + menu.id + query())); })),
    );

    var body = null;
    if (open) {
      var nameInput = el('input', { type: 'text', value: menu.name, maxlength: '100' });
      var typeSelect = selectOf(TYPES, menu.type);
      var modeSelect = selectOf(MODES, menu.mode);
      var maxInput = el('input', { type: 'number', min: '0', max: '25', value: String(menu.maxSelected || 0) });
      var removable = el('input', { type: 'checkbox' });
      removable.checked = menu.removable;
      var placeholderInput = el('input', { type: 'text', value: menu.placeholder || '', maxlength: '150', placeholder: 'Choisis tes rôles…' });
      var embed = embedForm(menu);
      var save = button('💾 Enregistrer le menu', 'btn-primary', function () {
        save.disabled = true;
        var payload = Object.assign(
          { name: nameInput.value, type: typeSelect.value, mode: modeSelect.value, maxSelected: maxInput.value, removable: removable.checked, placeholder: placeholderInput.value },
          embed.values(),
        );
        refresh(call('POST', '/menus/' + menu.id + query(), payload)).finally(function () { save.disabled = false; });
      });

      body = el(
        'div',
        { class: 'menu-body' },
        el('div', { class: 'field-row' },
          el('label', { class: 'field field-grow' }, el('span', { text: 'Nom du menu' }), nameInput),
          el('label', { class: 'field' }, el('span', { text: 'Type' }), typeSelect),
          el('label', { class: 'field' }, el('span', { text: 'Mode' }), modeSelect),
          el('label', { class: 'field' }, el('span', { text: 'Maximum (0 = illimité)' }), maxInput),
        ),
        el('div', { class: 'toggle-row' },
          el('label', { class: 'check' }, removable, 'Le membre peut se retirer le rôle depuis le menu'),
        ),
        menu.type === 'select' ? el('label', { class: 'field field-grow' }, el('span', { text: 'Texte du menu déroulant (placeholder)' }), placeholderInput) : null,
        el('p', { class: 'muted', text: 'Plusieurs rôles : le membre peut cumuler les rôles du menu (jusqu’au maximum). Un seul rôle : choisir un rôle retire les autres rôles du menu.' }),
        el('h4', { class: 'section-title', text: 'Message du menu (facultatif)' }),
        embed,
        el('div', { class: 'actions' }, save),
        el('h4', { class: 'section-title', text: 'Publication' }),
        renderPublish(menu),
        el('h4', { class: 'section-title', text: 'Rôles du menu' }),
        menu.options.length ? menu.options.map(function (option) { return renderOption(menu, option); }) : el('div', { class: 'empty', text: 'Aucun rôle pour l’instant.' }),
        addOptionForm(menu),
        conditionsBox(menu, null),
      );
    }
    return el('section', { class: 'card panel-block' }, head, body);
  }

  function renderMenus() {
    var list = Core.clear(document.getElementById('menus-list'));
    if (!data.menus.length) list.append(el('div', { class: 'card empty', text: 'Aucun menu pour l’instant. Crée-en un ci-dessous.' }));
    data.menus.forEach(function (menu) { list.append(renderMenu(menu)); });
  }

  function renderNewMenu() {
    var nameInput = el('input', { type: 'text', maxlength: '100', placeholder: 'Ex : Rôles de notifications' });
    var typeSelect = selectOf(TYPES, 'button');
    var modeSelect = selectOf(MODES, 'multiple');
    var create = button('+ Nouveau menu', 'btn-primary', function () {
      create.disabled = true;
      refresh(call('POST', '/menus' + query(), { name: nameInput.value, type: typeSelect.value, mode: modeSelect.value }))
        .then(function () {
          nameInput.value = '';
          if (data && data.menus.length) expandedMenus.add(data.menus[data.menus.length - 1].id);
          renderAll();
        })
        .finally(function () { create.disabled = false; });
    });
    Core.clear(document.getElementById('new-menu')).append(
      el('label', { class: 'field field-grow' }, el('span', { text: 'Nom' }), nameInput),
      el('label', { class: 'field' }, el('span', { text: 'Type' }), typeSelect),
      el('label', { class: 'field' }, el('span', { text: 'Mode' }), modeSelect),
      create,
    );
  }

  function renderSettings() {
    var select = el('select', { 'aria-label': 'Salon de journal' }, el('option', { value: '', text: '(aucun)' }), data.textChannels.map(function (c) { return el('option', { value: c.id, text: '#' + c.name }); }));
    select.value = data.settings.logChannelId || '';
    var save = button('Enregistrer', 'btn-primary', function () {
      save.disabled = true;
      refresh(call('POST', '/settings' + query(), { logChannelId: select.value || null })).finally(function () { save.disabled = false; });
    });
    Core.clear(document.getElementById('settings-card')).append(
      el('div', { class: 'filters' }, el('label', { class: 'field' }, el('span', { text: 'Salon de journal (modifications de la configuration)' }), select), save),
    );
  }

  function renderAll() {
    renderSettings();
    renderMenus();
    renderNewMenu();
  }

  async function loadGuild() {
    document.getElementById('content').hidden = true;
    expandedMenus.clear();
    expandedOptions.clear();
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
      guildId = new URLSearchParams(window.location.search).get('guild') || guilds[0].id;
      if (!guilds.some(function (g) { return g.id === guildId; })) guildId = guilds[0].id;
      select.value = guildId;
      select.addEventListener('change', function () {
        guildId = select.value;
        loadGuild();
      });
      await loadGuild();
    } catch (err) {
      showError(err.message);
    }
  }

  start();
})();
