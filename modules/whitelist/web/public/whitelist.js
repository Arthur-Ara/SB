/* Panel web du module Whitelist Vocal : configuration par salon (plage horaire, accès temporaires, admins du salon),
   réglages, admins du module. */
(function () {
  'use strict';

  var el = Core.el;
  var fmt = Core.fmt;
  var API = '/m/whitelist/api';
  var main = document.getElementById('main');
  var guildId = '';
  var data = null;
  var selectedChannelId = '';

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

  function currentChannel() {
    return data.channels.find(function (c) { return c.id === selectedChannelId; }) || null;
  }

  // ── Brouillon de configuration d'un salon ────────────────────────────────
  // Les contrôles (whitelist, limite, membres, rôles) ne modifient que ce brouillon local ;
  // rien n'est envoyé au serveur ni journalisé avant le clic sur « Enregistrer les modifications »,
  // qui regroupe tout en un seul appel et un seul log Discord.
  var draft = null;

  function draftFromChannel(channel) {
    return { channelId: channel.id, enabled: channel.enabled, slotLimit: channel.slotLimit, users: channel.users.slice(), roleIds: channel.roleIds.slice() };
  }

  function sortedKey(list, key) {
    return list.map(function (item) { return key ? item[key] : item; }).slice().sort().join(',');
  }

  function draftPending() {
    var channel = currentChannel();
    if (!channel || !draft || draft.channelId !== channel.id) return false;
    return (
      draft.enabled !== channel.enabled ||
      draft.slotLimit !== channel.slotLimit ||
      sortedKey(draft.users, 'id') !== sortedKey(channel.users, 'id') ||
      sortedKey(draft.roleIds) !== sortedKey(channel.roleIds)
    );
  }

  /** Avertit avant de perdre un brouillon non enregistré (changement de salon ou de serveur). */
  function confirmDiscardIfPending() {
    if (!draftPending()) return Promise.resolve(true);
    var channel = currentChannel();
    return Core.confirm('Des modifications non enregistrées sur #' + (channel ? channel.name : 'ce salon') + ' seront perdues. Continuer ?', {
      confirmLabel: 'Abandonner les modifications',
    });
  }

  function defaultAvatarUrl(id) {
    try {
      var index = Number((BigInt(id) >> 22n) % 6n);
      return 'https://cdn.discordapp.com/embed/avatars/' + index + '.png';
    } catch (e) {
      return 'https://cdn.discordapp.com/embed/avatars/0.png';
    }
  }

  // ── Sections ──────────────────────────────────────────────────────────────
  function renderTiles() {
    var configured = data.channels.filter(function (c) { return c.enabled || c.slotLimit !== null; });
    Core.clear(document.getElementById('tiles')).append(
      tile('Salons configurés', fmt.number(configured.length), fmt.number(data.channels.length) + ' salon(s) vocal(aux) au total'),
      tile('Whitelist activées', fmt.number(configured.filter(function (c) { return c.enabled; }).length)),
      tile('Limites de places', fmt.number(configured.filter(function (c) { return c.slotLimit !== null; }).length)),
      tile('Admins du module', fmt.number(data.admins.length)),
    );
  }

  function renderSettings() {
    var channelSelect = el(
      'select',
      { 'aria-label': 'Salon de journal' },
      el('option', { value: '', text: '(aucun)' }),
      data.textChannels.map(function (c) { return el('option', { value: c.id, text: '#' + c.name }); }),
    );
    channelSelect.value = data.settings.logChannelId || '';

    var save = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: 'Enregistrer',
      onclick: function () {
        save.disabled = true;
        refresh(call('POST', '/settings' + query(), { logChannelId: channelSelect.value || null })).finally(function () {
          save.disabled = false;
        });
      },
    });

    Core.clear(document.getElementById('settings-card')).append(
      el('div', { class: 'filters' }, el('label', { class: 'field' }, el('span', { text: 'Salon de journal' }), channelSelect), save),
    );
  }

  function renderChannelPicker() {
    if (!selectedChannelId && data.channels.length) selectedChannelId = data.channels[0].id;
    var select = el(
      'select',
      { 'aria-label': 'Salon à configurer' },
      data.channels.map(function (c) {
        return el('option', { value: c.id, text: '#' + c.name + (c.enabled || c.slotLimit !== null ? '  ·  configuré' : '') });
      }),
    );
    select.value = selectedChannelId;
    select.addEventListener('change', function () {
      var wanted = select.value;
      select.value = selectedChannelId; // reste sur l'ancien salon tant que l'abandon du brouillon n'est pas confirmé
      confirmDiscardIfPending().then(function (ok) {
        if (!ok) return;
        selectedChannelId = wanted;
        select.value = wanted;
        draft = null;
        renderChannelEditor();
      });
    });
    Core.clear(document.getElementById('channel-picker')).append(
      el('div', { class: 'filters' }, el('label', { class: 'field' }, el('span', { text: 'Salon vocal' }), select)),
    );
  }

  function renderChannelEditor() {
    var channel = currentChannel();
    var section = document.getElementById('channel-editor');
    if (!channel) {
      section.hidden = true;
      draft = null;
      return;
    }
    section.hidden = false;
    if (!draft || draft.channelId !== channel.id) draft = draftFromChannel(channel);
    var pending = draftPending();

    var enabledCheck = el('input', {
      type: 'checkbox',
      onchange: function () {
        draft.enabled = enabledCheck.checked;
        renderChannelEditor();
      },
    });
    enabledCheck.checked = draft.enabled;

    var limitInput = el('input', {
      type: 'number',
      min: '0',
      max: '500',
      placeholder: 'aucune',
      onchange: function () {
        var raw = limitInput.value.trim();
        draft.slotLimit = raw === '' ? null : Number(raw);
        renderChannelEditor();
      },
    });
    if (draft.slotLimit !== null) limitInput.value = String(draft.slotLimit);

    var addUserInput = idInput('ID à whitelister');
    var addUserButton = el('button', {
      type: 'button',
      class: 'btn btn-small',
      text: 'Ajouter',
      onclick: function () {
        var id = validId(addUserInput);
        if (!id) return;
        if (draft.users.some(function (p) { return p.id === id; })) {
          showError('Ce membre est déjà dans la liste.');
          return;
        }
        draft.users.push({ id: id, name: id, avatar: defaultAvatarUrl(id), username: null });
        renderChannelEditor();
      },
    });

    var roleChecks = data.roles.map(function (role) {
      var check = el('input', {
        type: 'checkbox',
        onchange: function () {
          var idx = draft.roleIds.indexOf(role.id);
          if (check.checked && idx === -1) draft.roleIds.push(role.id);
          else if (!check.checked && idx !== -1) draft.roleIds.splice(idx, 1);
          renderChannelEditor();
        },
      });
      check.checked = draft.roleIds.indexOf(role.id) !== -1;
      return { role: role, check: check };
    });

    var saveButton = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: '💾 Enregistrer les modifications',
      disabled: !pending,
      onclick: function () {
        // Ne repart pas via refresh() : on ne veut vider le brouillon (pour reprendre les noms
        // résolus par le serveur) qu'en cas de succès, jamais en cas d'échec.
        saveButton.disabled = true;
        showError('');
        main.classList.add('is-loading');
        call('POST', '/channels/' + channel.id + query(), {
          enabled: draft.enabled,
          slotLimit: draft.slotLimit,
          userIds: draft.users.map(function (p) { return p.id; }),
          roleIds: draft.roleIds,
        })
          .then(function (result) {
            data = result;
            draft = null;
            renderAll();
          })
          .catch(function (err) { showError(err.message); })
          .finally(function () {
            main.classList.remove('is-loading');
            saveButton.disabled = false;
          });
      },
    });
    var discardButton = el('button', {
      type: 'button',
      class: 'btn btn-small',
      text: '↩️ Annuler les modifications',
      disabled: !pending,
      onclick: function () {
        draft = draftFromChannel(channel);
        renderChannelEditor();
      },
    });

    var resetButton = el('button', {
      type: 'button',
      class: 'btn btn-danger btn-small',
      text: 'Réinitialiser ce salon',
      onclick: function () {
        Core.confirm('Réinitialiser la configuration de #' + channel.name + ' ? La whitelist, la limite et les listes seront effacées.').then(function (ok) {
          if (!ok) return;
          draft = null;
          refresh(call('POST', '/channels/' + channel.id + '/reset' + query()));
        });
      },
    });

    Core.clear(section).append(
      el(
        'div',
        { class: 'channel-editor-head' },
        el('h3', { text: '#' + channel.name }),
        el('span', { class: 'badge-status' + (draft.enabled ? ' on' : ''), text: draft.enabled ? 'Whitelist activée' : 'Whitelist désactivée' }),
        el('span', { class: 'muted', text: fmt.number(channel.memberCount) + ' présent(s)' }),
      ),
      el(
        'div',
        { class: 'filters' },
        el('label', { class: 'check' }, enabledCheck, 'Activer la whitelist'),
        el('label', { class: 'field' }, el('span', { text: 'Limite de places' }), limitInput),
      ),
      el('p', { class: 'muted', text: '✅ Peut rejoindre : un membre de la liste ci-dessous OU ayant l’un des rôles plus bas — les deux se combinent, ce n’est jamais l’un ou l’autre.' }),
      el('h4', { class: 'section-title', text: 'Membres whitelistés (accès individuel)' }),
      el('div', { class: 'filters' }, el('label', { class: 'field' }, el('span', { text: 'Ajouter par ID' }), addUserInput), addUserButton),
      table(
        [
          { label: 'Membre', value: function (p) { return personEl(p); } },
          {
            label: '',
            value: function (p) {
              return el('button', {
                type: 'button',
                class: 'btn btn-ghost btn-small',
                text: 'Retirer',
                onclick: function () {
                  draft.users = draft.users.filter(function (u) { return u.id !== p.id; });
                  renderChannelEditor();
                },
              });
            },
          },
        ],
        draft.users,
        'Aucun membre whitelisté.',
      ),
      el('h4', { class: 'section-title', text: 'Rôles whitelistés (accès en plus des membres)' }),
      data.roles.length
        ? el('div', { class: 'role-grid' }, roleChecks.map(function (r) { return el('label', {}, r.check, r.role.name); }))
        : el('div', { class: 'empty', text: 'Aucun rôle configurable sur ce serveur.' }),
      el(
        'div',
        { class: 'filters' },
        saveButton,
        discardButton,
        pending ? el('span', { class: 'muted', text: '⚠️ Modifications non enregistrées' }) : null,
      ),
      channelExtras(channel),
      el('div', { class: 'filters' }, resetButton),
    );
  }

  /**
   * Plage horaire, accès temporaires et admins du salon : appliqués immédiatement (chacun son propre appel,
   * journalisé), indépendamment du brouillon ci-dessus qui reste en attente s'il y en a un.
   */
  function channelExtras(channel) {
    var s = channel.schedule;
    var scheduleOn = el('input', { type: 'checkbox' });
    scheduleOn.checked = s.enabled;
    var start = el('input', { type: 'time', value: s.start || '20:00', 'aria-label': 'Début' });
    var end = el('input', { type: 'time', value: s.end || '02:00', 'aria-label': 'Fin' });
    var timezone = el('input', { type: 'text', value: s.timezone || 'Europe/Paris', maxlength: '64', 'aria-label': 'Fuseau horaire' });
    var saveSchedule = el('button', {
      type: 'button',
      class: 'btn btn-small',
      text: 'Appliquer la plage',
      onclick: function () {
        refresh(call('POST', '/channels/' + channel.id + '/schedule' + query(), { enabled: scheduleOn.checked, start: start.value, end: end.value, timezone: timezone.value.trim() }));
      },
    });

    var inviteId = idInput('ID du membre');
    var inviteDuration = el('input', { type: 'text', maxlength: '20', placeholder: '2h, 3j…' });
    var inviteButton = el('button', {
      type: 'button',
      class: 'btn btn-small',
      text: 'Inviter',
      onclick: function () {
        var id = validId(inviteId);
        if (!id) return;
        if (!inviteDuration.value.trim()) return showError('Indique une durée (ex. 2h, 3j).');
        refresh(call('POST', '/channels/' + channel.id + '/invites' + query(), { userId: id, duration: inviteDuration.value.trim() }));
      },
    });

    var adminId = idInput('ID du membre');
    var adminButton = el('button', {
      type: 'button',
      class: 'btn btn-small',
      text: 'Ajouter',
      onclick: function () {
        var id = validId(adminId);
        if (!id) return;
        refresh(call('POST', '/channels/' + channel.id + '/admins/' + id + query()));
      },
    });

    return el(
      'div',
      { class: 'channel-extras' },
      el('h4', { class: 'section-title', text: 'Plage horaire' }),
      el('p', {
        class: 'muted',
        text: s.enabled
          ? 'Restrictions actives de ' + s.start + ' à ' + s.end + ' (' + s.timezone + ') — ' + (s.activeNow ? 'actuellement actives.' : 'actuellement suspendues, le salon est ouvert.')
          : 'Aucune plage : les restrictions s’appliquent en permanence. Au début d’une plage, les membres présents sont revérifiés.',
      }),
      el(
        'div',
        { class: 'filters' },
        el('label', { class: 'check' }, scheduleOn, 'Limiter à une plage horaire'),
        el('label', { class: 'field' }, el('span', { text: 'Début' }), start),
        el('label', { class: 'field' }, el('span', { text: 'Fin' }), end),
        el('label', { class: 'field' }, el('span', { text: 'Fuseau horaire' }), timezone),
        saveSchedule,
      ),
      el('h4', { class: 'section-title', text: 'Accès temporaires' }),
      el('div', { class: 'filters' },
        el('label', { class: 'field' }, el('span', { text: 'Membre' }), inviteId),
        el('label', { class: 'field' }, el('span', { text: 'Durée (30 j max)' }), inviteDuration),
        inviteButton,
      ),
      table(
        [
          { label: 'Membre', value: function (t) { return personEl(t.person); } },
          { label: 'Jusqu’au', value: function (t) { return fmt.dateTime(t.expiresAt); } },
          {
            label: '',
            value: function (t) {
              return el('button', {
                type: 'button',
                class: 'btn btn-ghost btn-small',
                text: 'Retirer',
                onclick: function () { refresh(call('DELETE', '/channels/' + channel.id + '/invites/' + t.person.id + query())); },
              });
            },
          },
        ],
        channel.temp,
        'Aucun accès temporaire en cours (/whitelist invite sur Discord, ou ci-dessus).',
      ),
      el('h4', { class: 'section-title', text: 'Admins de ce salon' }),
      el('p', { class: 'muted', text: 'Ils entrent librement dans ce salon et peuvent y donner des accès temporaires avec /whitelist invite, sans être admins du module.' }),
      el('div', { class: 'filters' }, el('label', { class: 'field' }, el('span', { text: 'Ajouter par ID' }), adminId), adminButton),
      table(
        [
          { label: 'Membre', value: function (p) { return personEl(p); } },
          {
            label: '',
            value: function (p) {
              return el('button', {
                type: 'button',
                class: 'btn btn-ghost btn-small',
                text: 'Retirer',
                onclick: function () { refresh(call('DELETE', '/channels/' + channel.id + '/admins/' + p.id + query())); },
              });
            },
          },
        ],
        channel.admins,
        'Aucun admin propre à ce salon.',
      ),
    );
  }

  function renderChannelsTable() {
    Core.clear(document.getElementById('channels-card')).append(
      table(
        [
          { label: 'Salon', value: function (c) { return '#' + c.name; } },
          { label: 'Présents', num: true, value: function (c) { return fmt.number(c.memberCount); } },
          { label: 'Whitelist', value: function (c) { return c.enabled ? '🔒 Activée' : '🔓 Désactivée'; } },
          { label: 'Limite', num: true, value: function (c) { return c.slotLimit === null ? '—' : fmt.number(c.slotLimit); } },
          { label: 'Membres', num: true, value: function (c) { return fmt.number(c.users.length); } },
          { label: 'Rôles', num: true, value: function (c) { return fmt.number(c.roleIds.length); } },
          { label: 'Accès temp.', num: true, value: function (c) { return fmt.number(c.temp.length); } },
          { label: 'Plage', value: function (c) { return c.schedule.enabled ? c.schedule.start + ' → ' + c.schedule.end : null; } },
          {
            label: '',
            value: function (c) {
              return el('button', {
                type: 'button',
                class: 'btn btn-ghost btn-small',
                text: 'Configurer',
                onclick: function () {
                  confirmDiscardIfPending().then(function (ok) {
                    if (!ok) return;
                    selectedChannelId = c.id;
                    draft = null;
                    renderChannelPicker();
                    renderChannelEditor();
                    document.getElementById('channel-picker').scrollIntoView({ behavior: 'smooth', block: 'center' });
                  });
                },
              });
            },
          },
        ],
        data.channels,
        'Aucun salon vocal sur ce serveur.',
      ),
    );
  }

  function removeAdminButton(userId) {
    return el('button', {
      type: 'button',
      class: 'btn btn-ghost btn-small',
      text: 'Retirer',
      onclick: function () { refresh(call('DELETE', '/admins/' + userId + query())); },
    });
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
        refresh(call('POST', '/admins/' + id + query())).then(function () { input.value = ''; });
      },
    });
    Core.clear(document.getElementById('admins-card')).append(
      el('div', { class: 'filters' }, el('label', { class: 'field' }, el('span', { text: 'Ajouter par ID' }), input), addButton),
      table(
        [
          { label: 'Membre', value: function (a) { return personEl(a.person); } },
          { label: 'Ajouté par', value: function (a) { return a.addedByPerson ? personEl(a.addedByPerson) : '—'; } },
          { label: 'Depuis', value: function (a) { return fmt.dateTime(a.addedAt); } },
          { label: '', value: function (a) { return removeAdminButton(a.userId); } },
        ],
        data.admins,
        'Aucun admin de module (les administrateurs Discord et propriétaires du bot le sont déjà).',
      ),
    );
  }

  function renderAll() {
    renderTiles();
    renderSettings();
    renderChannelPicker();
    renderChannelEditor();
    renderChannelsTable();
    renderAdmins();
  }

  async function loadGuild() {
    document.getElementById('content').hidden = true;
    selectedChannelId = '';
    draft = null;
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
        var wanted = select.value;
        select.value = guildId; // reste sur l'ancien serveur tant que l'abandon du brouillon n'est pas confirmé
        confirmDiscardIfPending().then(function (ok) {
          if (!ok) return;
          guildId = wanted;
          select.value = wanted;
          loadGuild();
        });
      });
      await loadGuild();
    } catch (err) {
      showError(err.message);
    }
  }

  start();
})();
