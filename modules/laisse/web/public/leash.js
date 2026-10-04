/* Panel web du module Laisse : qui est en laisse, réglages, listes de statuts. */
(function () {
  'use strict';

  var el = Core.el;
  var fmt = Core.fmt;
  var API = '/m/laisse/api';
  var main = document.getElementById('main');
  var guildId = '';
  var data = null;

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

  function voiceEl(voice) {
    return voice
      ? el('span', { text: '🔊 #' + voice.name + ' (' + voice.members + ')' })
      : el('span', { class: 'muted', text: 'Hors vocal' });
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

  function table(columns, rows, emptyText) {
    if (!rows.length) return el('div', { class: 'empty', text: emptyText || 'Aucune donnée.' });
    return el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        { class: 'data' },
        el('thead', {}, el('tr', {}, columns.map(function (c) { return el('th', { text: c.label }); }))),
        el(
          'tbody',
          {},
          rows.map(function (row) {
            return el(
              'tr',
              {},
              columns.map(function (c) {
                var value = c.value(row);
                return el('td', {}, value === null || value === undefined ? '—' : value);
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

  // ── Sections ──────────────────────────────────────────────────────────────
  function renderTiles() {
    var s = data.settings;
    Core.clear(document.getElementById('tiles')).append(
      tile('Laisses actives', fmt.number(data.links.length)),
      tile('Autorisés', fmt.number(data.flags.allowed.length)),
      tile('Immunisés', fmt.number(data.flags.immune.length)),
      tile('God mode', fmt.number(data.flags.godmode.length)),
      tile('Admins du module', fmt.number(data.flags.admin.length)),
      tile('Limite par défaut', fmt.number(s.globalLimit)),
      tile('Leash-leasher', s.leashLeashers ? 'Activé' : 'Désactivé'),
    );
  }

  function renderSettings() {
    var s = data.settings;
    var limitInput = el('input', { type: 'number', min: '0', max: '100', value: String(s.globalLimit) });
    var leasherCheck = el('input', { type: 'checkbox' });
    leasherCheck.checked = s.leashLeashers;
    var channelSelect = el(
      'select',
      { 'aria-label': 'Salon de journal' },
      el('option', { value: '', text: '(aucun)' }),
      data.channels.map(function (c) { return el('option', { value: c.id, text: '#' + c.name }); }),
    );
    channelSelect.value = s.logChannelId || '';

    var save = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: 'Enregistrer',
      onclick: function () {
        save.disabled = true;
        refresh(
          call('POST', '/settings' + query(), {
            globalLimit: Number(limitInput.value),
            leashLeashers: leasherCheck.checked,
            logChannelId: channelSelect.value || null,
          }),
        ).finally(function () { save.disabled = false; });
      },
    });

    Core.clear(document.getElementById('settings-card')).append(
      el(
        'div',
        { class: 'filters' },
        el('label', { class: 'field' }, el('span', { text: 'Limite par défaut' }), limitInput),
        el('label', { class: 'check' }, leasherCheck, 'Mettre en laisse ceux qui peuvent eux-mêmes mettre en laisse'),
        el('label', { class: 'field' }, el('span', { text: 'Salon de journal' }), channelSelect),
        save,
      ),
    );
  }

  function renderAddLink() {
    var leasherInput = idInput('ID du maître');
    var leashedInput = idInput('ID du membre à mettre en laisse');
    var button = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: 'Mettre en laisse',
      onclick: function () {
        var leasherId = validId(leasherInput);
        var leashedId = leasherId && validId(leashedInput);
        if (!leasherId || !leashedId) return;
        refresh(call('POST', '/links' + query(), { leasherId: leasherId, leashedId: leashedId })).then(function () {
          leasherInput.value = '';
          leashedInput.value = '';
        });
      },
    });
    Core.clear(document.getElementById('add-link-card')).append(
      el(
        'div',
        { class: 'filters' },
        el('label', { class: 'field' }, el('span', { text: 'Maître' }), leasherInput),
        el('label', { class: 'field' }, el('span', { text: 'Membre' }), leashedInput),
        button,
      ),
    );
  }

  function removeLinkButton(leashedId) {
    return el('button', {
      type: 'button',
      class: 'btn btn-ghost btn-small',
      text: 'Retirer',
      onclick: function () { refresh(call('DELETE', '/links/' + leashedId + query())); },
    });
  }

  function clearListButton(leasherId) {
    return el('button', {
      type: 'button',
      class: 'btn btn-ghost btn-small',
      text: 'Vider sa laisse',
      onclick: function () { refresh(call('POST', '/leashers/' + leasherId + '/clear' + query())); },
    });
  }

  function renderLinks() {
    var byLeasher = {};
    data.links.forEach(function (row) {
      byLeasher[row.leasherId] = (byLeasher[row.leasherId] || 0) + 1;
    });
    Core.clear(document.getElementById('links-card')).append(
      table(
        [
          { label: 'Maître', value: function (row) { return personEl(row.leasher); } },
          { label: 'Membre en laisse', value: function (row) { return personEl(row.leashed); } },
          { label: 'Vocal (maître)', value: function (row) { return voiceEl(row.leasherVoice); } },
          { label: 'Vocal (membre)', value: function (row) { return voiceEl(row.leashedVoice); } },
          { label: 'Immunisé', value: function (row) { return row.immune ? '🛡️ Oui' : '—'; } },
          { label: 'Ajouté par', value: function (row) { return row.addedByPerson ? personEl(row.addedByPerson) : '—'; } },
          { label: 'Depuis', value: function (row) { return fmt.dateTime(row.createdAt); } },
          {
            label: '',
            value: function (row) {
              return el('div', { class: 'row-actions' }, removeLinkButton(row.leashedId), byLeasher[row.leasherId] > 1 ? clearListButton(row.leasherId) : null);
            },
          },
        ],
        data.links,
        'Aucune laisse active.',
      ),
    );
  }

  function flagToggleButton(flag, userId, label) {
    return el('button', {
      type: 'button',
      class: 'btn btn-ghost btn-small',
      text: label,
      onclick: function () { refresh(call('POST', '/members/' + userId + '/' + flag + query(), { value: false })); },
    });
  }

  function renderFlagSection(containerId, flag, addPlaceholder, removeLabel) {
    var rows = data.flags[flag];
    var input = idInput(addPlaceholder);
    var addButton = el('button', {
      type: 'button',
      class: 'btn btn-small',
      text: 'Ajouter',
      onclick: function () {
        var id = validId(input);
        if (!id) return;
        refresh(call('POST', '/members/' + id + '/' + flag + query(), { value: true })).then(function () { input.value = ''; });
      },
    });
    Core.clear(document.getElementById(containerId)).append(
      el('div', { class: 'filters' }, el('label', { class: 'field' }, el('span', { text: 'Ajouter par ID' }), input), addButton),
      table(
        [
          { label: 'Membre', value: function (row) { return personEl(row.person); } },
          { label: 'Par', value: function (row) { return row.byPerson ? personEl(row.byPerson) : '—'; } },
          { label: 'Depuis', value: function (row) { return fmt.dateTime(row.at); } },
          { label: '', value: function (row) { return flagToggleButton(flag, row.userId, removeLabel); } },
        ],
        rows,
        'Personne.',
      ),
    );
  }

  function renderAll() {
    renderTiles();
    renderSettings();
    renderAddLink();
    renderLinks();
    renderFlagSection('allowed-card', 'allowed', 'ID à autoriser', 'Retirer l’autorisation');
    renderFlagSection('immune-card', 'immune', 'ID à immuniser', 'Retirer l’immunité');
    renderFlagSection('godmode-card', 'godmode', 'ID à passer en god mode', 'Retirer le god mode');
    renderFlagSection('admin-card', 'admin', 'ID à ajouter comme admin', 'Retirer les droits admin');
  }

  function bindClearAll() {
    document.getElementById('clear-all').addEventListener('click', function () {
      Core.confirm('Vider toutes les laisses actives de ce serveur ? Cette action est irréversible.').then(function (ok) {
        if (ok) refresh(call('POST', '/clear-all' + query()));
      });
    });
  }

  async function loadGuild() {
    document.getElementById('content').hidden = true;
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
      bindClearAll();
      await loadGuild();
    } catch (err) {
      showError(err.message);
    }
  }

  start();
})();
