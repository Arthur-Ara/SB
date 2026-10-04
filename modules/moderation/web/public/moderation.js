/* Panel web du module Modération : bannis, avertissements (paliers automatiques), salons verrouillés, shadow-bans,
   mutes vocaux, automod, notes internes, contestations, modification et annulation des sanctions. */
(function () {
  'use strict';

  var el = Core.el;
  var fmt = Core.fmt;
  var API = '/m/moderation/api';
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

  function query(extra) {
    var q = '?guild=' + encodeURIComponent(guildId);
    if (extra) q += '&' + extra;
    return q;
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

  function table(columns, rows, emptyText) {
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

  function reasonText(reason) {
    return reason ? el('span', { class: 'reason-text', text: reason, title: reason }) : el('span', { class: 'muted', text: '—' });
  }

  /** Raison facultative saisie dans la boîte de dialogue du dashboard ; Promise<string|null> (null = annulé). */
  function promptReason(label) {
    return Core.prompt((label || 'Raison (facultatif)').replace(/\s*:\s*$/, ''), { placeholder: 'Raison (facultatif)', maxlength: '512' });
  }

  /** Demande une raison puis appelle `action(reason)` (rien si annulé). */
  function withReason(label, action) {
    promptReason(label).then(function (reason) {
      if (reason !== null) action(reason);
    });
  }

  function actionButton(label, cls, onclick) {
    return el('button', { type: 'button', class: 'btn btn-small ' + (cls || ''), text: label, onclick: onclick });
  }

  /** Échéance d'une sanction temporaire : « dans 2 h 05 min » (date exacte au survol). */
  function remainingBadge(date) {
    var remaining = new Date(date).getTime() - Date.now();
    var label = remaining > 0 ? 'dans ' + fmt.duration(remaining / 1000) : 'dépassée (levée automatique imminente)';
    return el('span', { class: 'badge-status warn', text: label, title: fmt.dateTime(date) });
  }

  // ── Réglages ──────────────────────────────────────────────────────────────
  function renderSettings() {
    var select = el(
      'select',
      { 'aria-label': 'Salon de journal' },
      el('option', { value: '', text: '(aucun)' }),
      data.textChannels.map(function (c) { return el('option', { value: c.id, text: '#' + c.name }); }),
    );
    select.value = data.settings.logChannelId || '';

    var save = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: 'Enregistrer',
      onclick: function () {
        save.disabled = true;
        refresh(call('POST', '/settings' + query(), { logChannelId: select.value || null })).finally(function () {
          save.disabled = false;
        });
      },
    });

    Core.clear(document.getElementById('settings-card')).append(
      el('div', { class: 'filters' }, el('label', { class: 'field' }, el('span', { text: 'Salon de journal' }), select), save),
    );
  }

  var RULE_LABELS = { tempmute: 'Exclusion temporaire', kick: 'Expulsion', ban: 'Bannissement', tempban: 'Bannissement temporaire' };

  /** Paliers : à N avertissements actifs, sanction appliquée automatiquement par le bot. */
  function renderWarnRules() {
    var countInput = el('input', { type: 'number', min: '1', max: '50', value: '3', 'aria-label': 'Nombre d’avertissements' });
    var actionSelect = el(
      'select',
      { 'aria-label': 'Sanction' },
      Object.keys(RULE_LABELS).map(function (key) { return el('option', { value: key, text: RULE_LABELS[key] }); }),
    );
    var durationInput = el('input', { type: 'text', placeholder: '1h, 1j, 7j…', maxlength: '20' });
    function syncDuration() {
      var needs = actionSelect.value === 'tempmute' || actionSelect.value === 'tempban';
      durationInput.disabled = !needs;
      if (!needs) durationInput.value = '';
    }
    actionSelect.addEventListener('change', syncDuration);
    syncDuration();
    var add = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: 'Ajouter le palier',
      onclick: function () {
        add.disabled = true;
        refresh(call('POST', '/warn-rules' + query(), { warnCount: Number(countInput.value), action: actionSelect.value, duration: durationInput.value.trim() || null })).finally(function () {
          add.disabled = false;
        });
      },
    });
    Core.clear(document.getElementById('warn-rules-card')).append(
      el('p', { class: 'muted', style: 'padding:0 14px', text: 'Quand un membre atteint exactement ce nombre d’avertissements actifs, le bot applique la sanction (une seule fois par palier). Un palier existant au même nombre est remplacé.' }),
      el(
        'div',
        { class: 'filters' },
        el('label', { class: 'field' }, el('span', { text: 'Avertissements' }), countInput),
        el('label', { class: 'field' }, el('span', { text: 'Sanction' }), actionSelect),
        el('label', { class: 'field' }, el('span', { text: 'Durée' }), durationInput),
        add,
      ),
      table(
        [
          { label: 'Palier', value: function (r) { return r.warnCount + ' avertissement(s)'; } },
          { label: 'Sanction', value: function (r) { return RULE_LABELS[r.action] || r.action; } },
          { label: 'Durée', value: function (r) { return r.durationMinutes ? fmt.duration(r.durationMinutes * 60) : null; } },
          {
            label: '',
            value: function (r) {
              return actionButton('Supprimer', 'btn-ghost', function () { refresh(call('DELETE', '/warn-rules/' + r.id + query())); });
            },
          },
        ],
        data.warnRules,
        'Aucun palier : les avertissements ne déclenchent aucune sanction automatique.',
      ),
    );
  }

  /** Contestation (/contester) : désactivée tant qu'aucun type de ticket n'est choisi. */
  function renderAppeal() {
    var host = Core.clear(document.getElementById('appeal-card'));
    if (!data.ticketTypes.length) {
      host.append(el('div', { class: 'empty', text: 'Les contestations ouvrent un ticket : active le module Tickets et crée au moins un type de ticket pour pouvoir les activer.' }));
      return;
    }
    var enabled = el('input', { type: 'checkbox' });
    enabled.checked = data.settings.appealEnabled;
    var typeSelect = el(
      'select',
      { 'aria-label': 'Type de ticket' },
      el('option', { value: '', text: '(choisir un type)' }),
      data.ticketTypes.map(function (t) { return el('option', { value: t.id, text: (t.emoji ? t.emoji + ' ' : '') + t.label }); }),
    );
    typeSelect.value = data.settings.appealTicketTypeId || '';
    var save = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: 'Enregistrer',
      onclick: function () {
        save.disabled = true;
        refresh(call('POST', '/appeal' + query(), { enabled: enabled.checked, ticketTypeId: typeSelect.value || null })).finally(function () {
          save.disabled = false;
        });
      },
    });
    host.append(
      el('p', { class: 'muted', style: 'padding:0 14px', text: 'Avec /contester, un membre peut contester une de ses sanctions des 30 derniers jours (avertissement, exclusion, mute vocal, shadow-ban, automod) : un ticket du type choisi est ouvert avec la sanction et son motif. Une seule contestation par sanction.' }),
      el(
        'div',
        { class: 'filters' },
        el('label', { class: 'check' }, enabled, el('span', { text: 'Contestations activées' })),
        el('label', { class: 'field' }, el('span', { text: 'Type de ticket' }), typeSelect),
        save,
      ),
    );
  }

  // ── Tuiles ────────────────────────────────────────────────────────────────
  function renderTiles() {
    Core.clear(document.getElementById('tiles')).append(
      tile('Bannis', fmt.number(data.bans.length)),
      tile('Avertissements actifs', fmt.number(data.warns.length)),
      tile('Salons verrouillés', fmt.number(data.lockedChannels.length)),
      tile('Shadow-bans', fmt.number(data.shadowbans.length)),
      tile('Mutes vocaux actifs', fmt.number(data.tempVocMutes.length)),
    );
  }

  // ── Bannis ────────────────────────────────────────────────────────────────
  function renderBanForm() {
    var userInput = idInput('ID à bannir');
    var reasonInput = el('input', { type: 'text', placeholder: 'Raison (facultatif)', maxlength: '512' });
    var daysSelect = el(
      'select',
      { 'aria-label': 'Jours de messages à supprimer' },
      [0, 1, 2, 3, 4, 5, 6, 7].map(function (n) { return el('option', { value: String(n), text: n === 0 ? 'Aucun message supprimé' : n + ' jour(s) de messages' }); }),
    );
    var durationInput = el('input', { type: 'text', placeholder: 'définitif', maxlength: '20', title: 'Vide : bannissement définitif. Sinon 12h, 7j, 2sem… (1 an max)' });
    var button = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: '🔨 Bannir',
      onclick: function () {
        var id = validId(userInput);
        if (!id) return;
        button.disabled = true;
        refresh(call('POST', '/bans' + query(), { userId: id, reason: reasonInput.value.trim() || null, deleteMessageDays: Number(daysSelect.value), duration: durationInput.value.trim() || null }))
          .then(function () {
            userInput.value = '';
            reasonInput.value = '';
            durationInput.value = '';
          })
          .finally(function () { button.disabled = false; });
      },
    });

    Core.clear(document.getElementById('ban-form-card')).append(
      el(
        'div',
        { class: 'filters' },
        el('label', { class: 'field' }, el('span', { text: 'Membre à bannir' }), userInput),
        el('label', { class: 'field field-grow' }, el('span', { text: 'Raison' }), reasonInput),
        el('label', { class: 'field' }, el('span', { text: 'Messages à supprimer' }), daysSelect),
        el('label', { class: 'field' }, el('span', { text: 'Durée (facultatif)' }), durationInput),
        button,
      ),
    );
  }

  var banFilter = '';
  var banLimit = 100;

  /** Tous les bannis (toutes dates confondues) : recherche par nom, pseudo ou ID, affichage par paquets de 100. */
  function renderBansTable() {
    var needle = banFilter.trim().toLowerCase();
    var matches = data.bans.filter(function (b) {
      if (!needle) return true;
      var person = b.person || {};
      return [b.userId, person.name, person.username, b.reason].some(function (value) { return value && String(value).toLowerCase().indexOf(needle) !== -1; });
    });
    var shown = matches.slice(0, banLimit);
    var search = el('input', { type: 'search', placeholder: 'Rechercher un banni (nom, ID, raison)…', value: banFilter, 'aria-label': 'Rechercher un banni' });
    search.addEventListener('input', function () {
      banFilter = search.value;
      banLimit = 100;
      var position = search.selectionStart;
      renderBansTable();
      var again = document.querySelector('#bans-card input[type="search"]');
      if (again) { again.focus(); again.setSelectionRange(position, position); }
    });
    var summary = el('p', { class: 'muted', style: 'padding:0 14px', text: fmt.number(data.bans.length) + ' banni(s) au total' + (needle ? ' · ' + fmt.number(matches.length) + ' correspondant(s)' : '') + ' — dates et auteurs connus selon l’historique disponible (bot, statistiques, journal d’audit).' });
    var more = matches.length > shown.length
      ? el('div', { class: 'filters' }, actionButton('Afficher 100 de plus (' + fmt.number(matches.length - shown.length) + ' restants)', 'btn-ghost', function () { banLimit += 100; renderBansTable(); }))
      : el('span');
    Core.clear(document.getElementById('bans-card')).append(
      el('div', { class: 'filters' }, el('label', { class: 'field field-grow' }, el('span', { text: 'Recherche' }), search)),
      summary,
      table(
        [
          { label: 'Membre', value: function (b) { return personEl(b.person); } },
          { label: 'Raison', value: function (b) { return reasonText(b.reason); } },
          { label: 'Banni par', value: function (b) { return b.executorPerson ? personEl(b.executorPerson) : el('span', { class: 'muted', text: 'hors du bot' }); } },
          { label: 'Depuis', value: function (b) { return fmt.dateTime(b.bannedAt); } },
          { label: 'Jusqu’au', value: function (b) { return b.expiresAt ? remainingBadge(b.expiresAt) : el('span', { class: 'muted', text: 'définitif' }); } },
          {
            label: '',
            value: function (b) {
              return actionButton('Débannir', 'btn-ghost', function () {
                withReason('Raison du débannissement (facultatif) :', function (reason) {
                  refresh(call('DELETE', '/bans/' + b.userId + query(reason ? 'reason=' + encodeURIComponent(reason) : '')));
                });
              });
            },
          },
        ],
        shown,
        needle ? 'Aucun banni ne correspond à cette recherche.' : 'Aucun membre banni.',
      ),
      more,
    );
  }

  // ── Avertissements ───────────────────────────────────────────────────────
  function renderWarnForm() {
    var userInput = idInput('ID à avertir');
    var reasonInput = el('input', { type: 'text', placeholder: 'Raison (obligatoire)', maxlength: '512' });
    var button = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: '⚠️ Avertir',
      onclick: function () {
        var id = validId(userInput);
        if (!id) return;
        var reason = reasonInput.value.trim();
        if (!reason) {
          showError('La raison est obligatoire pour un avertissement.');
          return;
        }
        button.disabled = true;
        refresh(call('POST', '/warns' + query(), { userId: id, reason: reason }))
          .then(function () {
            userInput.value = '';
            reasonInput.value = '';
          })
          .finally(function () { button.disabled = false; });
      },
    });

    Core.clear(document.getElementById('warn-form-card')).append(
      el(
        'div',
        { class: 'filters' },
        el('label', { class: 'field' }, el('span', { text: 'Membre à avertir' }), userInput),
        el('label', { class: 'field field-grow' }, el('span', { text: 'Raison' }), reasonInput),
        button,
      ),
    );
  }

  function renderWarnsTable() {
    Core.clear(document.getElementById('warns-card')).append(
      table(
        [
          { label: 'Membre', value: function (w) { return personEl(w.person); } },
          { label: 'Raison', value: function (w) { return reasonText(w.reason); } },
          { label: 'Averti par', value: function (w) { return personEl(w.executorPerson); } },
          { label: 'Depuis', value: function (w) { return fmt.dateTime(w.createdAt); } },
          {
            label: '',
            value: function (w) {
              return actionButton('Retirer', 'btn-ghost', function () {
                refresh(call('DELETE', '/warns/' + w.id + query()));
              });
            },
          },
        ],
        data.warns,
        'Aucun avertissement actif.',
      ),
    );
  }

  // ── Salons verrouillés ───────────────────────────────────────────────────
  function renderLockForm() {
    if (!data.lockableChannels.length) {
      Core.clear(document.getElementById('lock-form-card')).append(el('div', { class: 'empty', text: 'Tous les salons textuels sont déjà verrouillés.' }));
      return;
    }
    var select = el('select', { 'aria-label': 'Salon à verrouiller' }, data.lockableChannels.map(function (c) { return el('option', { value: c.id, text: '#' + c.name }); }));
    var reasonInput = el('input', { type: 'text', placeholder: 'Raison (facultatif)', maxlength: '512' });
    var durationInput = el('input', { type: 'text', placeholder: 'sans limite', maxlength: '20', title: 'Vide : jusqu’au déverrouillage manuel. Sinon 10m, 2h, 1j… (30 j max)' });
    var button = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: '🔒 Verrouiller',
      onclick: function () {
        button.disabled = true;
        refresh(call('POST', '/locks/' + select.value + query(), { reason: reasonInput.value.trim() || null, duration: durationInput.value.trim() || null })).finally(function () {
          button.disabled = false;
        });
      },
    });
    Core.clear(document.getElementById('lock-form-card')).append(
      el(
        'div',
        { class: 'filters' },
        el('label', { class: 'field' }, el('span', { text: 'Salon' }), select),
        el('label', { class: 'field field-grow' }, el('span', { text: 'Raison' }), reasonInput),
        el('label', { class: 'field' }, el('span', { text: 'Durée (facultatif)' }), durationInput),
        button,
      ),
    );
  }

  function renderLocksTable() {
    Core.clear(document.getElementById('locks-card')).append(
      table(
        [
          { label: 'Salon', value: function (c) { return '#' + c.name; } },
          { label: 'Déverrouillage', value: function (c) { return c.unlockAt ? remainingBadge(c.unlockAt) : el('span', { class: 'muted', text: 'manuel' }); } },
          {
            label: '',
            value: function (c) {
              return actionButton('Déverrouiller', 'btn-ghost', function () {
                withReason('Raison du déverrouillage (facultatif) :', function (reason) {
                  refresh(call('DELETE', '/locks/' + c.id + query(reason ? 'reason=' + encodeURIComponent(reason) : '')));
                });
              });
            },
          },
        ],
        data.lockedChannels,
        'Aucun salon verrouillé.',
      ),
    );
  }

  // ── Shadow-bans ───────────────────────────────────────────────────────────
  function renderShadowbanForm() {
    var userInput = idInput('ID à isoler');
    var reasonInput = el('input', { type: 'text', placeholder: 'Raison (facultatif)', maxlength: '512' });
    var button = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: '🚷 Shadow-ban',
      onclick: function () {
        var id = validId(userInput);
        if (!id) return;
        button.disabled = true;
        refresh(call('POST', '/shadowbans' + query(), { userId: id, reason: reasonInput.value.trim() || null }))
          .then(function () {
            userInput.value = '';
            reasonInput.value = '';
          })
          .finally(function () { button.disabled = false; });
      },
    });
    Core.clear(document.getElementById('shadowban-form-card')).append(
      el(
        'div',
        { class: 'filters' },
        el('label', { class: 'field' }, el('span', { text: 'Membre à isoler (doit être sur le serveur)' }), userInput),
        el('label', { class: 'field field-grow' }, el('span', { text: 'Raison' }), reasonInput),
        button,
      ),
    );
  }

  function renderShadowbansTable() {
    Core.clear(document.getElementById('shadowbans-card')).append(
      table(
        [
          { label: 'Membre', value: function (s) { return personEl(s.person); } },
          { label: 'Salon prison', value: function (s) { return s.prisonChannelName ? '#' + s.prisonChannelName : '—'; } },
          { label: 'Raison', value: function (s) { return reasonText(s.reason); } },
          { label: 'Depuis', value: function (s) { return fmt.dateTime(s.createdAt); } },
          {
            label: '',
            value: function (s) {
              return actionButton('Lever', 'btn-ghost', function () {
                withReason('Raison de la levée (facultatif) :', function (reason) {
                  refresh(call('DELETE', '/shadowbans/' + s.userId + query(reason ? 'reason=' + encodeURIComponent(reason) : '')));
                });
              });
            },
          },
        ],
        data.shadowbans,
        'Aucun shadow-ban actif.',
      ),
    );
  }

  // ── Mutes vocaux temporaires ─────────────────────────────────────────────
  function renderTempVocMutesTable() {
    Core.clear(document.getElementById('tempvocmutes-card')).append(
      table(
        [
          { label: 'Membre', value: function (m) { return personEl(m.person); } },
          { label: 'Raison', value: function (m) { return reasonText(m.reason); } },
          { label: 'Mute par', value: function (m) { return personEl(m.executorPerson); } },
          { label: 'Échéance', value: function (m) { return remainingBadge(m.expiresAt); } },
          {
            label: '',
            value: function (m) {
              return actionButton('Lever', 'btn-ghost', function () {
                withReason('Raison de la levée (facultatif) :', function (reason) {
                  refresh(call('DELETE', '/tempvocmutes/' + m.userId + query(reason ? 'reason=' + encodeURIComponent(reason) : '')));
                });
              });
            },
          },
        ],
        data.tempVocMutes,
        'Aucun mute vocal temporaire actif.',
      ),
    );
  }

  // ── Onglets & historique ──────────────────────────────────────────────────
  var TABS = [
    ['general', 'Général'],
    ['ban', 'Bannissements'],
    ['kick', 'Expulsions'],
    ['warn', 'Avertissements'],
    ['mute', 'Exclusions'],
    ['vocmute', 'Mutes vocaux'],
    ['shadowban', 'Shadow-bans'],
    ['channels', 'Salons'],
    ['automod', 'Automod'],
    ['blacklist', 'Blacklist'],
    ['player', 'Joueur'],
  ];
  var activeTab = 'general';
  var historyState = {}; // catégorie → { page, user }

  function tabCount(id) {
    if (!data) return null;
    var counts = { ban: data.bans.length, warn: data.warns.length, vocmute: data.tempVocMutes.length, shadowban: data.shadowbans.length, channels: data.lockedChannels.length };
    return counts[id] === undefined ? null : counts[id];
  }

  function renderTabs() {
    var nav = Core.clear(document.getElementById('tabs'));
    TABS.forEach(function (tab) {
      var count = tabCount(tab[0]);
      nav.append(
        el(
          'button',
          {
            type: 'button',
            class: 'tab-btn',
            role: 'tab',
            'aria-selected': String(tab[0] === activeTab),
            onclick: function () { selectTab(tab[0]); },
          },
          tab[1],
          count === null ? null : el('span', { class: 'count', text: String(count) }),
        ),
      );
    });
    document.querySelectorAll('.tab-panel').forEach(function (panel) {
      panel.hidden = panel.dataset.tab !== activeTab;
    });
  }

  function selectTab(id) {
    activeTab = id;
    renderTabs();
    loadHistory(id);
    if (id === 'automod') loadAutomod();
  }

  // ── Automod ──────────────────────────────────────────────────────────────
  var automod = null;

  async function loadAutomod(promise) {
    showError('');
    var host = document.querySelector('.tab-panel[data-tab="automod"]');
    host.classList.add('is-loading');
    try {
      automod = await (promise || call('GET', '/automod' + query()));
      renderAutomod();
    } catch (err) {
      showError(err.message);
    } finally {
      host.classList.remove('is-loading');
    }
  }

  var ACTION_TEXT = { delete: 'Suppression seule', warn: 'Suppression + avertissement', mute: 'Suppression + exclusion temporaire' };

  function renderAutomod() {
    renderAutomodSettings();
    renderAutomodWords();
    renderAutomodTest();
    renderAutomodHits();
    renderAutomodAllow();
  }

  function renderAutomodSettings() {
    var s = automod.settings;
    var enabled = el('input', { type: 'checkbox' });
    enabled.checked = s.enabled;
    var action = el('select', { 'aria-label': 'Action' }, Object.keys(ACTION_TEXT).map(function (key) { return el('option', { value: key, text: ACTION_TEXT[key] }); }));
    action.value = s.action;
    var threshold = el('input', { type: 'number', min: '50', max: '100', value: String(s.threshold), 'aria-label': 'Seuil de similarité' });
    var muteMinutes = el('input', { type: 'number', min: '1', max: '40320', value: String(s.muteMinutes), 'aria-label': 'Durée de l’exclusion' });
    var exemptRoles = s.exemptRoleIds.slice();
    var exemptChannels = s.exemptChannelIds.slice();
    var channelList = el(
      'div',
      { class: 'role-picker-list' },
      automod.channels.map(function (c) {
        var check = el('input', {
          type: 'checkbox',
          onchange: function () {
            var index = exemptChannels.indexOf(c.id);
            if (check.checked && index === -1) exemptChannels.push(c.id);
            if (!check.checked && index !== -1) exemptChannels.splice(index, 1);
          },
        });
        check.checked = exemptChannels.indexOf(c.id) !== -1;
        return el('label', { class: 'role-picker-row' }, check, el('span', { text: c.category ? '📁 ' + c.name + ' (toute la catégorie)' : '#' + c.name }));
      }),
    );
    var save = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: 'Enregistrer',
      onclick: function () {
        save.disabled = true;
        loadAutomod(
          call('POST', '/automod/settings' + query(), {
            enabled: enabled.checked,
            action: action.value,
            threshold: Number(threshold.value),
            muteMinutes: Number(muteMinutes.value),
            exemptRoleIds: exemptRoles,
            exemptChannelIds: exemptChannels,
          }),
        ).finally(function () { save.disabled = false; });
      },
    });
    Core.clear(document.getElementById('automod-settings-card')).append(
      el('p', {
        class: 'muted',
        style: 'padding:0 14px',
        text: 'Les messages contenant un mot interdit sont supprimés, y compris les contournements (accents, majuscules, chiffres à la place des lettres « c0nn@rd », lettres répétées ou espacées). Le seuil fixe la ressemblance minimale avec un mot interdit : 100 % = mot exact uniquement, 80 % = tolère environ une faute sur cinq lettres. Les administrateurs et les membres pouvant gérer les messages ne sont jamais concernés.',
      }),
      el(
        'div',
        { class: 'filters' },
        el('label', { class: 'check' }, enabled, el('span', { text: 'Automod activé' })),
        el('label', { class: 'field' }, el('span', { text: 'Action' }), action),
        el('label', { class: 'field' }, el('span', { text: 'Seuil de similarité (%)' }), threshold),
        el('label', { class: 'field' }, el('span', { text: 'Exclusion (minutes)' }), muteMinutes),
      ),
      el(
        'div',
        { class: 'automod-exempt' },
        el('div', {}, el('h3', { class: 'subsection-title', text: 'Rôles exemptés' }), Core.rolePicker(automod.roles, exemptRoles)),
        el('div', {}, el('h3', { class: 'subsection-title', text: 'Salons exemptés' }), channelList),
      ),
      el('div', { class: 'filters' }, save),
    );
  }

  function renderAutomodWords() {
    var textarea = el('textarea', { rows: '3', placeholder: 'Un mot par ligne, ou séparés par des virgules', maxlength: '20000' });
    var filter = el('input', { type: 'search', placeholder: 'Filtrer la liste…', 'aria-label': 'Filtrer les mots interdits' });
    var list = el('div', { class: 'word-list' });
    function renderList() {
      var needle = filter.value.trim().toLowerCase();
      var words = automod.words.filter(function (w) { return !needle || w.word.indexOf(needle) !== -1; });
      Core.clear(list).append(
        words.length
          ? words.map(function (w) {
              return el('span', { class: 'word-chip' }, w.word, el('button', {
                type: 'button',
                'aria-label': 'Retirer ' + w.word,
                text: '✕',
                onclick: function () { loadAutomod(call('DELETE', '/automod/words/' + w.id + query())); },
              }));
            })
          : el('div', { class: 'empty', text: automod.words.length ? 'Aucun mot ne correspond.' : 'Aucun mot interdit : l’automod ne bloque rien pour l’instant.' }),
      );
    }
    filter.addEventListener('input', renderList);
    renderList();
    var add = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: 'Ajouter',
      onclick: function () {
        if (!textarea.value.trim()) return;
        add.disabled = true;
        loadAutomod(call('POST', '/automod/words' + query(), { words: textarea.value })).finally(function () { add.disabled = false; });
      },
    });
    Core.clear(document.getElementById('automod-words-card')).append(
      el('div', { class: 'filters' }, el('label', { class: 'field field-grow' }, el('span', { text: 'Nouveaux mots' }), textarea), add),
      el('div', { class: 'filters' }, el('label', { class: 'field field-grow' }, el('span', { text: fmt.number(automod.words.length) + ' mot(s) bloqué(s)' }), filter)),
      list,
    );
  }

  function renderAutomodTest() {
    var input = el('input', { type: 'text', placeholder: 'Écris un message pour voir s’il serait bloqué…', maxlength: '2000' });
    var result = el('div', { class: 'muted', style: 'padding:0 14px 14px', text: 'Aucun effet : simple simulation avec les réglages enregistrés.' });
    var button = el('button', {
      type: 'button',
      class: 'btn',
      text: 'Tester',
      onclick: function () {
        call('POST', '/automod/test' + query(), { content: input.value })
          .then(function (res) {
            Core.clear(result).append(
              res.hit
                ? el('span', { class: 'badge-status warn', text: 'Bloqué : « ' + res.hit.token + ' » ressemble à « ' + res.hit.word + ' » (' + res.hit.score + ' %)' })
                : el('span', { class: 'badge-status on', text: 'Autorisé' }),
            );
          })
          .catch(function (err) { showError(err.message); });
      },
    });
    Core.clear(document.getElementById('automod-test-card')).append(
      el('div', { class: 'filters' }, el('label', { class: 'field field-grow' }, el('span', { text: 'Message' }), input), button),
      result,
    );
  }

  function renderAutomodHits() {
    Core.clear(document.getElementById('automod-hits-card')).append(
      table(
        [
          { label: 'Membre', value: function (h) { return personEl(h.user); } },
          { label: 'Salon', value: function (h) { return '#' + (h.channel.name || h.channel.id); } },
          { label: 'Message', value: function (h) { return reasonText(h.content); } },
          {
            label: 'Détection',
            value: function (h) {
              return el('span', { title: 'Mot du message : « ' + h.token + ' »' }, '« ' + h.word + ' » · ' + h.score + ' %');
            },
          },
          { label: 'Action', value: function (h) { return ACTION_TEXT[h.action] || h.action; } },
          { label: 'Date', value: function (h) { return fmt.dateTime(h.createdAt); } },
          {
            label: '',
            value: function (h) {
              if (h.falsePositive) {
                return el(
                  'div',
                  { class: 'row-actions' },
                  el('span', { class: 'badge-status on', text: 'faux positif', title: h.reviewedBy ? 'Marqué par ' + h.reviewedBy.name : '' }),
                  actionButton('Rétablir', 'btn-ghost', function () {
                    loadAutomod(call('POST', '/automod/hits/' + h.id + '/false-positive' + query(), { value: false }));
                  }),
                );
              }
              return actionButton('Faux positif', 'btn-ghost', function () {
                Core.confirm('« ' + h.token + ' » sera ajouté aux mots autorisés et ne sera plus jamais bloqué. La sanction déjà appliquée n’est pas annulée (utilise l’historique pour l’annuler).', {
                  title: 'Marquer comme faux positif',
                  confirmLabel: 'Marquer',
                  danger: false,
                }).then(function (ok) {
                  if (ok) loadAutomod(call('POST', '/automod/hits/' + h.id + '/false-positive' + query(), { value: true }));
                });
              });
            },
          },
        ],
        automod.hits,
        'Aucun message bloqué pour l’instant.',
      ),
    );
  }

  function renderAutomodAllow() {
    Core.clear(document.getElementById('automod-allow-card')).append(
      automod.allow.length
        ? el(
            'div',
            { class: 'word-list' },
            automod.allow.map(function (a) {
              return el('span', { class: 'word-chip allowed' }, a.token, el('button', {
                type: 'button',
                'aria-label': 'Retirer ' + a.token,
                text: '✕',
                onclick: function () { loadAutomod(call('DELETE', '/automod/allow/' + encodeURIComponent(a.token) + query())); },
              }));
            }),
          )
        : el('div', { class: 'empty', text: 'Aucun mot autorisé. Marque une détection comme faux positif pour l’ajouter ici.' }),
    );
  }

  // ── Notes internes (onglet Joueur) ───────────────────────────────────────
  async function loadNotes(userId) {
    var host = document.getElementById('notes-card');
    if (!userId) {
      Core.clear(host).append(el('div', { class: 'empty', text: 'Recherche un membre pour afficher ses notes internes.' }));
      return;
    }
    try {
      renderNotes(await call('GET', '/notes' + query('user=' + userId)));
    } catch (err) {
      showError(err.message);
    }
  }

  function renderNotes(result) {
    var textarea = el('textarea', { rows: '2', placeholder: 'Nouvelle note (visible uniquement par le staff)', maxlength: '2000' });
    var add = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: 'Ajouter la note',
      onclick: function () {
        if (!textarea.value.trim()) return;
        add.disabled = true;
        call('POST', '/notes' + query(), { userId: result.userId, content: textarea.value })
          .then(renderNotes)
          .catch(function (err) { showError(err.message); })
          .finally(function () { add.disabled = false; });
      },
    });
    Core.clear(document.getElementById('notes-card')).append(
      el('div', { class: 'filters' }, el('label', { class: 'field field-grow' }, el('span', { text: 'Note' }), textarea), add),
      result.notes.length
        ? el(
            'div',
            { class: 'note-list' },
            result.notes.map(function (note) {
              return el(
                'div',
                { class: 'note-item' },
                el(
                  'div',
                  { class: 'note-head' },
                  personEl(note.author),
                  el('span', { class: 'muted', text: 'n°' + note.id + ' · ' + fmt.dateTime(note.createdAt) }),
                  actionButton('Supprimer', 'btn-ghost', function () {
                    Core.confirm('Supprimer définitivement la note n°' + note.id + ' ?', { confirmLabel: 'Supprimer' }).then(function (ok) {
                      if (!ok) return;
                      call('DELETE', '/notes/' + note.id + query())
                        .then(renderNotes)
                        .catch(function (err) { showError(err.message); });
                    });
                  }),
                ),
                el('p', { class: 'note-content', text: note.content }),
              );
            }),
          )
        : el('div', { class: 'empty', text: 'Aucune note interne sur ce membre.' }),
    );
  }

  function proofsCell(entry) {
    if (!entry.proofs.length) return el('span', { class: 'muted', text: '—' });
    return el(
      'div',
      { class: 'proof-list' },
      entry.proofs.map(function (p) {
        var title = p.content || '';
        return el(
          'span',
          {},
          el('a', { href: p.url, target: '_blank', rel: 'noopener', text: 'Preuve n°' + p.id, title: title }),
          p.content ? ' — ' + (p.content.length > 60 ? p.content.slice(0, 60) + '…' : p.content) : '',
          p.attachments.map(function (url, i) {
            return [' ', el('a', { href: url, target: '_blank', rel: 'noopener', text: '[pj ' + (i + 1) + ']' })];
          }),
        );
      }),
    );
  }

  var HISTORY_COLUMNS = [
    { label: '#', value: function (e) { return String(e.id); } },
    {
      label: 'Action',
      value: function (e) {
        var lifted = !e.active && ['warn', 'ban', 'tempban', 'tempmute', 'tempvocmute'].indexOf(e.action) !== -1;
        return el(
          'span',
          {},
          e.emoji + ' ' + e.label,
          lifted ? el('span', { class: 'badge-status badge-off', text: e.action === 'warn' ? 'retiré' : 'levée' }) : null,
          e.editedAt
            ? el('span', { class: 'badge-status', text: 'modifiée', title: 'Par ' + (e.editedBy ? e.editedBy.name : '?') + ' le ' + fmt.dateTime(e.editedAt) })
            : null,
        );
      },
    },
    { label: 'Membre', value: function (e) { return e.target ? personEl(e.target) : null; } },
    { label: 'Modérateur', value: function (e) { return personEl(e.executor); } },
    {
      label: 'Détails',
      value: function (e) {
        var parts = [];
        if (e.channel) parts.push('#' + (e.channel.name || e.channel.id));
        if (e.durationS) parts.push(fmt.duration(e.durationS));
        if (e.active && e.expiresAt && new Date(e.expiresAt) > new Date()) parts.push('jusqu’au ' + fmt.dateTime(e.expiresAt));
        return parts.length ? parts.join(' · ') : null;
      },
    },
    { label: 'Raison', value: function (e) { return reasonText(e.reason); } },
    { label: 'Date', value: function (e) { return fmt.dateTime(e.createdAt); } },
    { label: 'Preuves', value: proofsCell },
    { label: '', value: sanctionActions },
  ];

  /** Modifier (raison, durée) ou annuler une sanction publiée ; l'historique affiché est ensuite rechargé. */
  function sanctionActions(entry) {
    var buttons = [];
    if (entry.target) {
      buttons.push(
        actionButton('Modifier', 'btn-ghost', function () {
          var fields = [{ name: 'reason', label: 'Raison', value: entry.reason || '', maxlength: '512' }];
          if (entry.durationEditable) fields.push({ name: 'duration', label: 'Nouvelle durée totale (vide : inchangée)', placeholder: '30m, 12h, 7j…', maxlength: '20' });
          Core.dialog({ title: 'Modifier la sanction #' + entry.id, fields: fields, confirmLabel: 'Enregistrer' }).then(function (values) {
            if (!values) return;
            var body = { reason: values.reason };
            if (values.duration) body.duration = values.duration;
            afterAction(call('POST', '/actions/' + entry.id + '/edit' + query(), body));
          });
        }),
      );
    }
    if (entry.revocable) {
      buttons.push(
        actionButton('Annuler', 'btn-ghost', function () {
          Core.dialog({
            title: 'Annuler la sanction #' + entry.id,
            message: 'La sanction est levée sur Discord et marquée comme annulée dans l’historique.',
            input: { placeholder: 'Raison de l’annulation (facultatif)', maxlength: '512' },
            confirmLabel: 'Annuler la sanction',
            danger: true,
          }).then(function (reason) {
            if (reason === null) return;
            afterAction(call('POST', '/actions/' + entry.id + '/revoke' + query(), { reason: reason || null }));
          });
        }),
      );
    }
    return buttons.length ? el('div', { class: 'row-actions' }, buttons) : null;
  }

  function afterAction(promise) {
    showError('');
    promise
      .then(function () {
        loadHistory(activeTab);
        return silentRefresh();
      })
      .catch(function (err) { showError(err.message); });
  }

  /** Historique paginé d'une catégorie (ou, pour l'onglet Joueur, de toutes les catégories d'un membre). */
  async function loadHistory(cat) {
    var host = document.getElementById('hist-' + cat);
    if (!host || !data) return;
    var state = (historyState[cat] = historyState[cat] || { page: 1, user: '' });
    var isPlayer = cat === 'player';

    if (isPlayer && !state.user) {
      Core.clear(host).append(el('div', { class: 'empty', text: 'Saisis l’ID d’un membre pour afficher tout son historique (sanctions subies et actions de modération effectuées).' }));
      return;
    }

    var userInput = el('input', { inputmode: 'numeric', placeholder: 'Filtrer par ID de membre', maxlength: '20', value: isPlayer ? '' : state.user });
    var bar = isPlayer
      ? null
      : el(
          'form',
          {
            class: 'hist-bar',
            onsubmit: function (event) {
              event.preventDefault();
              var value = userInput.value.trim();
              if (value && !/^\d{17,20}$/.test(value)) return showError('ID Discord invalide (17 à 20 chiffres attendus).');
              showError('');
              state.user = value;
              state.page = 1;
              loadHistory(cat);
            },
          },
          el('label', { class: 'field' }, el('span', { text: 'Membre (sanctionné ou modérateur)' }), userInput),
          el('button', { type: 'submit', class: 'btn btn-small', text: 'Filtrer' }),
          state.user ? actionButton('Effacer', 'btn-ghost', function () { state.user = ''; state.page = 1; loadHistory(cat); }) : null,
        );

    host.classList.add('is-loading');
    try {
      var result = await call('GET', '/history' + query('category=' + (isPlayer ? 'all' : cat) + '&page=' + state.page + (state.user ? '&user=' + state.user : '')));
      var pager = el(
        'div',
        { class: 'hist-pager' },
        actionButton('❮ Précédent', 'btn-ghost', function () { state.page -= 1; loadHistory(cat); }),
        'Page ' + result.page + ' / ' + result.pages + ' · ' + fmt.number(result.total) + ' entrée(s)',
        actionButton('Suivant ❯', 'btn-ghost', function () { state.page += 1; loadHistory(cat); }),
      );
      pager.firstChild.disabled = result.page <= 1;
      pager.lastChild.disabled = result.page >= result.pages;
      Core.clear(host).append(el('div', {}, bar, table(HISTORY_COLUMNS, result.entries, isPlayer ? 'Aucune entrée pour ce membre.' : 'Aucune entrée enregistrée.'), pager));
    } catch (err) {
      showError(err.message);
    } finally {
      host.classList.remove('is-loading');
    }
  }

  function renderPlayerForm() {
    var input = idInput('ID du joueur');
    var form = el(
      'form',
      {
        class: 'filters',
        onsubmit: function (event) {
          event.preventDefault();
          var id = validId(input);
          if (!id) return;
          showError('');
          historyState.player = { page: 1, user: id };
          loadHistory('player');
          loadNotes(id);
        },
      },
      el('label', { class: 'field' }, el('span', { text: 'Membre' }), input),
      el('button', { type: 'submit', class: 'btn btn-primary', text: '🔎 Rechercher' }),
    );
    var current = historyState.player && historyState.player.user;
    if (current) input.value = current;
    Core.clear(document.getElementById('player-form-card')).append(form);
    loadNotes(current);
  }

  function renderAll() {
    renderTabs();
    renderPlayerForm();
    loadHistory(activeTab);
    if (activeTab === 'automod') loadAutomod();
    renderTiles();
    renderSettings();
    renderWarnRules();
    renderAppeal();
    renderBanForm();
    renderBansTable();
    renderWarnForm();
    renderWarnsTable();
    renderLockForm();
    renderLocksTable();
    renderShadowbanForm();
    renderShadowbansTable();
    renderTempVocMutesTable();
  }

  /** Resynchronise avec Discord sans toucher à l'onglet affiché (bans/débans faits hors du panel). */
  async function silentRefresh() {
    if (!data || document.hidden || !guildId) return;
    try {
      data = await call('GET', '/state' + query());
      renderTabs();
      renderTiles();
      // Pas de réaffichage de la liste pendant la saisie dans la recherche (il ferait perdre le curseur).
      if (!document.activeElement || document.activeElement.type !== 'search') renderBansTable();
      renderWarnsTable();
      renderLocksTable();
      renderShadowbansTable();
      renderTempVocMutesTable();
    } catch (err) {
      /* silencieux : la prochaine tentative réessaiera */
    }
  }

  /** `fresh` : relit la liste des bannis auprès de Discord (sinon cache serveur d'une minute). */
  async function loadGuild(fresh) {
    historyState = {};
    document.getElementById('content').hidden = true;
    await refresh(call('GET', '/state' + query(fresh ? 'fresh=1' : '')));
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
      document.getElementById('f-refresh').addEventListener('click', function () {
        loadGuild(true).then(function () { loadHistory(activeTab); });
      });
      setInterval(silentRefresh, 30000);
      document.addEventListener('visibilitychange', silentRefresh);
      await loadGuild();
    } catch (err) {
      showError(err.message);
    }
  }

  start();
})();
