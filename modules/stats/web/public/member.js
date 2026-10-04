/* Outil d'investigation : toutes les données d'un membre à partir de son ID Discord. */
(function () {
  'use strict';

  var el = Core.el;
  var fmt = Core.fmt;
  var UI = StatsUI;
  var byId = UI.byId;

  var main = byId('main');
  var state = null;
  var sequence = 0;
  var panels = null;

  var SOURCES = { live: 'en direct', backfill: 'rétroactivité', sync: 'rattrapage au démarrage' };
  var NAME_TYPES = { username: 'Nom d’utilisateur', global_name: 'Nom affiché' };
  var ACTIONS = { ban: 'Bannissement', kick: 'Expulsion', timeout: 'Exclusion temporaire' };

  function change(oldValue, newValue) {
    return el(
      'span',
      {},
      oldValue || '(aucun)',
      el('span', { class: 'change-arrow', 'aria-label': 'devient', text: '→' }),
      newValue || '(aucun)',
    );
  }

  function executor(user) {
    return user ? UI.person(user, UI.memberHref(state, user.id)) : el('span', { class: 'muted', text: 'inconnu' });
  }

  function ensurePanels() {
    if (panels) return;
    var grid = byId('panels');
    panels = {
      messages: UI.createPanel(grid, { id: 'member-messages', title: 'Messages envoyés', seriesLabel: 'Messages', fill: true, summary: 'sum' }),
      voice: UI.createPanel(grid, { id: 'member-voice', title: 'Temps passé en vocal', seriesLabel: 'Heures', unit: 'h', decimals: 1, fill: true, summary: 'sum' }),
    };
  }

  function renderCard(profile) {
    var id = profile.identity;
    var m = profile.membership;
    var badges = [];
    if (id.bot) badges.push('Bot');
    if (!m) badges.push('Jamais vu sur ce serveur');
    else badges.push(m.isMember ? 'Membre du serveur' : 'A quitté le serveur');
    if (m && m.boostingSince) badges.push('Booster depuis le ' + fmt.date(m.boostingSince));
    if (m && m.nitro) badges.push('Nitro (estimé)');

    var details = ['Compte créé le ' + fmt.date(id.createdAt)];
    if (m && m.joinedAt) details.push('arrivé sur le serveur le ' + fmt.dateTime(m.joinedAt));
    if (m && !m.isMember && m.leftAt) details.push('parti le ' + fmt.dateTime(m.leftAt));

    Core.clear(byId('profile-card')).append(
      el('img', { src: id.avatar, alt: '' }),
      el(
        'div',
        { class: 'profile-names' },
        el('h1', { text: (m && m.nickname) || id.globalName || id.username || id.id }),
        el('div', { class: 'muted', text: [id.username ? '@' + id.username : null, id.globalName ? 'nom affiché : ' + id.globalName : null, 'ID ' + id.id].filter(Boolean).join(' · ') }),
        el('div', { class: 'muted', text: details.join(' · ') }),
        el('div', { class: 'badges' }, badges.map(function (b) { return el('span', { class: 'badge', text: b }); })),
      ),
    );
  }

  function renderTiles(profile) {
    var p = profile.period;
    var a = profile.allTime;
    Core.clear(byId('tiles-period')).append(
      UI.tile('Messages', fmt.number(p.messages), p.rank ? 'rang ' + fmt.number(p.rank) + ' sur le serveur' : null),
      UI.tile('Longueur moyenne', p.avgLength ? fmt.decimal(p.avgLength) + ' car.' : '—'),
      UI.tile('Temps vocal', fmt.duration(p.voiceSeconds), fmt.number(p.voiceSessions) + ' session(s)'),
      UI.tile('Messages supprimés', fmt.number(p.deletions)),
      UI.tile('@everyone / @here', fmt.number(p.everyone) + ' / ' + fmt.number(p.here)),
      UI.tile('Dernier message', p.lastMessageAt ? fmt.dateTime(p.lastMessageAt) : '—', p.firstMessageAt ? 'premier : ' + fmt.dateTime(p.firstMessageAt) : null),
    );
    Core.clear(byId('tiles-all')).append(
      UI.tile('Messages', fmt.number(a.messages)),
      UI.tile('Temps vocal', fmt.duration(a.voiceSeconds), fmt.number(a.voiceSessions) + ' session(s)'),
      UI.tile('Premier message vu', a.firstMessageAt ? fmt.dateTime(a.firstMessageAt) : '—'),
      UI.tile('Dernier message vu', a.lastMessageAt ? fmt.dateTime(a.lastMessageAt) : '—'),
    );
  }

  function renderPanels(profile) {
    ensurePanels();
    var s = profile.series;
    panels.messages.setData({ labels: s.labels, interval: s.interval, values: s.messages });
    panels.voice.setData({ labels: s.labels, interval: s.interval, values: s.voiceHours });
  }

  function renderHistory(profile) {
    var globalNames = profile.names.filter(function (h) { return h.type !== 'nickname'; });
    var nicknames = profile.names.filter(function (h) { return h.type === 'nickname'; });
    var date = function (key) { return function (row) { return fmt.dateTime(row[key]); }; };
    var source = { label: 'Source', value: function (row) { return SOURCES[row.source] || row.source; } };

    var roleChips = profile.roles.length
      ? el('div', { class: 'chips' }, profile.roles.map(function (role) {
          return el('span', { class: 'badge' }, UI.swatch(role.color), role.name);
        }))
      : el('div', { class: 'empty', text: 'Aucun rôle (ou membre absent du serveur).' });

    Core.clear(byId('history')).append(
      UI.card('Rôles actuels', roleChips),
      UI.card('Pseudonymes globaux (Discord)', UI.table([
        { label: 'Date', value: date('changedAt') },
        { label: 'Type', value: function (row) { return NAME_TYPES[row.type] || row.type; } },
        { label: 'Changement', value: function (row) { return change(row.oldValue, row.newValue); } },
        source,
      ], globalNames, 'Aucun changement enregistré.')),
      UI.card('Surnoms par serveur', UI.table([
        { label: 'Date', value: date('changedAt') },
        { label: 'Serveur', value: function (row) { return row.guildName || row.guildId; } },
        { label: 'Changement', value: function (row) { return change(row.oldValue, row.newValue); } },
        source,
      ], nicknames, 'Aucun changement enregistré.')),
      UI.card('Arrivées et départs', UI.table([
        { label: 'Date', value: date('at') },
        { label: 'Événement', value: function (row) { return row.type === 'join' ? 'Arrivée' : 'Départ'; } },
        source,
      ], profile.presence, 'Aucun mouvement enregistré.')),
      UI.card('Historique des rôles', UI.table([
        { label: 'Date', value: date('at') },
        { label: 'Rôle', value: function (row) { return el('span', { class: 'channel-name' }, UI.swatch(row.color), row.name); } },
        { label: 'Action', value: function (row) { return row.action === 'add' ? 'Ajout' : 'Retrait'; } },
        { label: 'Par', value: function (row) { return executor(row.executor); } },
      ], profile.roleHistory, 'Aucun changement de rôle enregistré.')),
      UI.card('Sanctions reçues', UI.table([
        { label: 'Date', value: date('at') },
        { label: 'Type', value: function (row) { return ACTIONS[row.action] || row.action; } },
        { label: 'Par', value: function (row) { return executor(row.executor); } },
        { label: 'Raison', value: function (row) { return row.reason || '—'; } },
        { label: 'Fin', value: function (row) { return row.expiresAt ? fmt.dateTime(row.expiresAt) : '—'; } },
      ], profile.moderation, 'Aucune sanction enregistrée.')),
      UI.card('Boosts', UI.table([
        { label: 'Début', value: date('startedAt') },
        { label: 'Fin', value: function (row) { return row.endedAt ? fmt.dateTime(row.endedAt) : 'en cours'; } },
        { label: 'Durée', num: true, value: function (row) {
          var end = row.endedAt ? new Date(row.endedAt) : new Date();
          return fmt.days((end - new Date(row.startedAt)) / 86400000);
        } },
      ], profile.boosts, 'Aucun boost enregistré.')),
      UI.card('Salons favoris (période)', UI.table([
        { label: 'Salon', value: function (row) { return (row.isThread ? '🧵 ' : '#') + row.name; } },
        { label: 'Messages', num: true, value: function (row) { return fmt.number(row.messages); } },
      ], profile.channels)),
      UI.card('Serveurs suivis', UI.table([
        {
          label: 'Serveur',
          value: function (row) {
            var target = Object.assign({}, state, { guild: row.id });
            return el('a', { href: '/m/stats/membre?' + UI.stateQuery(target, { id: profile.identity.id }), text: row.name });
          },
        },
        { label: 'Statut', value: function (row) { return row.isMember ? 'Membre' : 'Parti'; } },
        { label: 'Surnom', value: function (row) { return row.nickname || '—'; } },
        { label: 'Arrivée', num: true, value: function (row) { return fmt.date(row.joinedAt); } },
      ], profile.guilds, 'Aucun serveur.')),
      UI.card('Derniers messages', UI.table([
        { label: 'Date', value: date('at') },
        { label: 'Salon', value: function (row) { return '#' + row.channelName; } },
        {
          label: 'Contenu',
          class: 'message-content',
          value: function (row) {
            if (row.content) return row.content;
            return el('span', { class: 'muted', text: fmt.number(row.length) + ' caractère(s)' + (row.attachments ? ' · ' + row.attachments + ' pièce(s) jointe(s)' : '') });
          },
        },
        { label: 'État', value: function (row) { return row.deletedAt ? el('span', { class: 'badge', text: 'supprimé' }) : ''; } },
      ], profile.recentMessages, 'Aucun message enregistré.')),
    );
  }

  async function load(nextState) {
    state = nextState;
    var id = state.id;
    byId('f-member').value = id;
    byId('back-link').href = '/m/stats/?' + UI.stateQuery(state);
    UI.writeState(state, { id: id });
    UI.showError('');
    if (!id) {
      byId('hint').hidden = false;
      byId('profile').hidden = true;
      return;
    }

    var token = ++sequence;
    main.classList.add('is-loading');
    try {
      var profile = await Core.api(UI.API + '/member/' + encodeURIComponent(id) + '?' + UI.apiParams(state.guild, state));
      if (token !== sequence) return;
      byId('hint').hidden = true;
      byId('profile').hidden = false;
      document.title = (profile.identity.globalName || profile.identity.username || id) + ' · Fiche membre';
      renderCard(profile);
      renderTiles(profile);
      renderPanels(profile);
      renderHistory(profile);
    } catch (err) {
      if (token !== sequence) return;
      byId('profile').hidden = true;
      byId('hint').hidden = false;
      UI.showError(err.message);
    } finally {
      if (token === sequence) main.classList.remove('is-loading');
    }
  }

  async function start() {
    try {
      await Core.ready;
      var filters = await UI.initFilters(load);
      state = filters.state;
      byId('member-search').addEventListener('submit', function (event) {
        event.preventDefault();
        var input = byId('f-member');
        var id = input.value.trim();
        if (!/^\d{17,20}$/.test(id)) {
          input.setCustomValidity('ID Discord : 17 à 20 chiffres');
          input.reportValidity();
          return;
        }
        state.id = id;
        load(state);
      });
      byId('f-member').addEventListener('input', function () {
        byId('f-member').setCustomValidity('');
      });
      if (!filters.guilds.length) {
        UI.showError('Aucun serveur suivi pour le moment.');
        return;
      }
      await load(filters.state);
    } catch (err) {
      UI.showError(err.message);
    }
  }

  start();
})();
