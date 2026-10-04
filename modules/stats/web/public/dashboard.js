/* Dashboard principal du module Statistiques. */
(function () {
  'use strict';

  var el = Core.el;
  var fmt = Core.fmt;
  var UI = StatsUI;
  var byId = UI.byId;

  var main = byId('main');
  var state = null;
  var overview = null;
  var sequence = 0;

  // ── Contrôles propres à certains graphiques ───────────────────────────────
  var roleSelect = el('select', { 'aria-label': 'Rôle analysé' });
  var activeSelect = el(
    'select',
    { 'aria-label': 'Type d’activité' },
    el('option', { value: 'text', text: 'À l’écrit' }),
    el('option', { value: 'voice', text: 'En vocal' }),
  );
  var moderationSelect = el(
    'select',
    { 'aria-label': 'Type de sanction' },
    el('option', { value: 'all', text: 'Toutes' }),
    el('option', { value: 'ban', text: 'Bannissements' }),
    el('option', { value: 'kick', text: 'Expulsions' }),
    el('option', { value: 'timeout', text: 'Exclusions temporaires' }),
  );

  // ── Graphiques (1 à 9 : liste de stats.md ; les suivants exploitent les autres métriques collectées) ──
  // group : famille de séries à recharger quand le graphique a sa propre période (/api/series).
  var grid = byId('panels');
  var PANELS = [
    { id: 'messages', group: 'messages', title: 'Messages envoyés', seriesLabel: 'Messages', fill: true, summary: 'sum', pick: function (s) { return s.messages; } },
    { id: 'avgPerMember', group: 'messages', title: 'Nombre moyen de messages', subtitle: 'Par membre actif à l’écrit', seriesLabel: 'Messages / membre', decimals: 1, summary: 'none', pick: function (s) { return s.avgMessagesPerMember; } },
    { id: 'avgLength', group: 'messages', title: 'Longueur moyenne des messages', subtitle: 'Messages contenant du texte', seriesLabel: 'Caractères', unit: 'car.', decimals: 1, summary: 'none', pick: function (s) { return s.avgLength; } },
    { id: 'members', group: 'members', title: 'Croissance du serveur', subtitle: 'Nombre total de membres', seriesLabel: 'Membres', tone: 'positive', fill: true, beginAtZero: false, summary: 'last', pick: function (s) { return s.members; } },
    { id: 'joins', group: 'events', title: 'Flux entrant', subtitle: 'Nouveaux membres', seriesLabel: 'Arrivées', tone: 'positive', fill: true, summary: 'sum', pick: function (s) { return s.joins; } },
    { id: 'leaves', group: 'events', title: 'Flux sortant', subtitle: 'Départs', seriesLabel: 'Départs', tone: 'negative', fill: true, summary: 'sum', pick: function (s) { return s.leaves; } },
    { id: 'everyone', group: 'messages', title: 'Mentions @everyone', seriesLabel: '@everyone', fill: true, summary: 'sum', pick: function (s) { return s.everyone; } },
    { id: 'here', group: 'messages', title: 'Mentions @here', seriesLabel: '@here', fill: true, summary: 'sum', pick: function (s) { return s.here; } },
    { id: 'roleMentions', group: null, title: 'Mentions de rôle', seriesLabel: 'Mentions', fill: true, summary: 'sum', control: roleSelect, pick: null },
    { id: 'deletions', group: 'deletions', title: 'Messages supprimés', seriesLabel: 'Suppressions', tone: 'negative', fill: true, summary: 'sum', pick: function (s) { return s.deletions; } },
    { id: 'voice', group: 'voice', title: 'Temps passé en vocal', seriesLabel: 'Heures', unit: 'h', decimals: 1, fill: true, summary: 'sum', pick: function (s) { return s.voiceHours; } },
    { id: 'active', group: function () { return activeSelect.value === 'voice' ? 'voice' : 'messages'; }, title: 'Membres actifs', subtitle: 'Membres distincts', seriesLabel: 'Membres actifs', summary: 'none', control: activeSelect, pick: function (s) { return activeSelect.value === 'voice' ? s.activeVoice : s.activeText; } },
    { id: 'moderation', group: 'moderation', title: 'Sanctions', seriesLabel: 'Sanctions', tone: 'negative', fill: true, summary: 'sum', control: moderationSelect, pick: function (s) { return s.moderation[moderationSelect.value]; } },
  ];
  var panels = {};
  var byPanelId = {};
  PANELS.forEach(function (def) {
    byPanelId[def.id] = def;
    panels[def.id] = UI.createPanel(
      grid,
      Object.assign({}, def, {
        globalPeriod: function () { return state ? UI.periodOf(state) : UI.defaultPeriod(); },
        onPeriodChange: function () { refreshPanel(def); },
      }),
    );
  });

  function panelData(def, source) {
    return { labels: source.labels, interval: source.range.interval, values: def.pick(source.series) };
  }

  /** Met à jour un graphique : période globale (données déjà chargées) ou période propre (requête dédiée). */
  async function refreshPanel(def) {
    if (!state) return;
    if (def.id === 'roleMentions') return loadRoleSeries(sequence).catch(function (err) { UI.showError(err.message); });
    var panel = panels[def.id];
    var period = panel.period();
    if (!period) {
      if (overview) panel.setData(panelData(def, overview));
      return;
    }
    var group = typeof def.group === 'function' ? def.group() : def.group;
    panel.setLoading(true);
    try {
      var data = await Core.api(UI.API + '/series?group=' + group + '&' + UI.apiParams(state.guild, period));
      panel.setData(panelData(def, data));
    } catch (err) {
      UI.showError(err.message);
    } finally {
      panel.setLoading(false);
    }
  }

  function renderPanels() {
    PANELS.forEach(function (def) {
      if (def.pick) refreshPanel(def);
    });
  }

  activeSelect.addEventListener('change', function () {
    refreshPanel(byPanelId.active);
  });
  moderationSelect.addEventListener('change', function () {
    refreshPanel(byPanelId.moderation);
  });

  // ── Mentions de rôle ──────────────────────────────────────────────────────
  function renderRoleOptions(roles) {
    var previous = roleSelect.value;
    Core.clear(roleSelect);
    roles.forEach(function (role) {
      var label = (role.deleted ? '[supprimé] ' : '') + role.name + ' — ' + fmt.number(role.mentions);
      roleSelect.append(el('option', { value: role.id, text: label }));
    });
    if (roles.some(function (r) { return r.id === previous; })) roleSelect.value = previous;
    roleSelect.disabled = !roles.length;
  }

  async function loadRoleSeries(token) {
    if (!overview) return;
    if (!roleSelect.value) {
      panels.roleMentions.setData({
        labels: overview.labels,
        interval: overview.range.interval,
        values: overview.labels.map(function () { return 0; }),
        note: 'Aucun rôle enregistré.',
      });
      return;
    }
    var period = panels.roleMentions.period() || UI.periodOf(state);
    var query = UI.apiParams(state.guild, period) + '&role=' + encodeURIComponent(roleSelect.value);
    var data = await Core.api(UI.API + '/role-mentions?' + query);
    if (token !== sequence) return;
    var role = roleSelect.options[roleSelect.selectedIndex];
    panels.roleMentions.setData({
      labels: data.labels,
      interval: data.interval,
      values: data.values,
      seriesLabel: role ? role.textContent.split(' — ')[0] : 'Mentions',
    });
  }

  roleSelect.addEventListener('change', function () {
    loadRoleSeries(sequence).catch(function (err) { UI.showError(err.message); });
  });

  // ── Classement des rôles les plus mentionnés (une courbe par rôle) ────────
  var rankLimit = el(
    'select',
    { 'aria-label': 'Nombre de rôles affichés' },
    el('option', { value: '5', text: 'Top 5' }),
    el('option', { value: '8', text: 'Top 8', selected: true }),
    el('option', { value: '10', text: 'Top 10' }),
    el('option', { value: '15', text: 'Top 15' }),
  );
  rankLimit.value = '8';
  var rankCanvas = el('canvas', { role: 'img', 'aria-label': 'Rôles les plus mentionnés' });
  var rankSummary = el('p', { class: 'panel-summary' });
  var rankSub = el('p', { class: 'panel-sub', text: 'Une courbe par rôle · cliquez une ligne du tableau pour la masquer' });
  var rankTable = el('div', { class: 'panel-table table-wrap' });
  var rankPanel = el(
    'article',
    { class: 'card panel panel-wide', id: 'panel-roleRanking' },
    el('header', { class: 'panel-head' }, el('div', {}, el('h2', { text: 'Rôles les plus mentionnés' }), rankSub), el('div', { class: 'panel-tools' }, rankLimit)),
    rankSummary,
    el('div', { class: 'panel-body' }, rankCanvas),
    rankTable,
  );
  grid.appendChild(rankPanel);
  var rankChart = null;
  var rankData = null;
  var rankHidden = {};

  function renderRoleRanking() {
    if (rankChart) rankChart.destroy();
    rankChart = null;
    Core.clear(rankTable);
    if (!rankData) return;
    var roles = rankData.roles;
    rankSub.textContent = ['Une courbe par rôle', roles.length ? 'cliquez une ligne du tableau pour la masquer' : null, UI.intervalLabel(rankData.range.interval)]
      .filter(Boolean)
      .join(' · ');
    Core.clear(rankSummary).append(
      document.createTextNode('Total des mentions de rôle : '),
      el('strong', { text: fmt.number(rankData.total) }),
    );
    if (!roles.length) {
      rankTable.append(el('div', { class: 'empty', text: 'Aucune mention de rôle sur la période.' }));
      return;
    }
    var colors = UI.SERIES_COLORS;
    rankChart = UI.multiLineChart(rankCanvas, {
      labels: rankData.labels,
      interval: rankData.range.interval,
      series: roles.map(function (role, i) {
        return { label: role.name, values: role.values, color: colors[i % colors.length], hidden: rankHidden[role.id] };
      }),
    });
    rankTable.append(
      UI.table(
        [
          { label: '#', class: 'rank', value: function (row, i) { return String(i + 1); } },
          {
            label: 'Rôle',
            value: function (row, i) {
              var line = el('span', { class: 'rank-line' });
              line.style.background = colors[i % colors.length];
              return el('span', {}, line, row.name, row.deleted ? el('span', { class: 'badge', text: 'supprimé' }) : null);
            },
          },
          { label: 'Mentions', num: true, value: function (row) { return fmt.number(row.mentions); } },
          { label: 'Part', num: true, value: function (row) { return rankData.total ? fmt.percent(row.mentions / rankData.total) : '—'; } },
        ],
        roles,
      ),
    );
    var table = rankTable.querySelector('table');
    table.classList.add('rank-table');
    Array.prototype.forEach.call(table.tBodies[0].rows, function (tr, i) {
      tr.classList.toggle('is-off', Boolean(rankHidden[roles[i].id]));
      tr.addEventListener('click', function () {
        var id = roles[i].id;
        rankHidden[id] = !rankHidden[id];
        tr.classList.toggle('is-off', rankHidden[id]);
        rankChart.setDatasetVisibility(i, !rankHidden[id]);
        rankChart.update();
      });
    });
  }

  async function loadRoleRanking(token) {
    rankPanel.classList.add('is-loading');
    try {
      var data = await Core.api(UI.API + '/role-ranking?' + UI.apiParams(state.guild, state) + '&limit=' + rankLimit.value);
      if (token !== undefined && token !== sequence) return;
      rankData = data;
      renderRoleRanking();
    } finally {
      rankPanel.classList.remove('is-loading');
    }
  }

  rankLimit.addEventListener('change', function () {
    loadRoleRanking().catch(function (err) { UI.showError(err.message); });
  });
  window.addEventListener('themechange', renderRoleRanking);

  // ── Indicateurs ───────────────────────────────────────────────────────────
  function renderTiles(data) {
    var t = data.totals;
    var c = data.current;
    var p = data.previous || null;
    var sanctions = t.bans + t.kicks + t.timeouts;
    // Évolution par rapport à la période précédente de même durée (si la comparaison est cochée).
    function cmp(current, previous, inverse) {
      return p ? { current: current, previous: previous, inverse: inverse } : null;
    }
    Core.clear(byId('tiles-period')).append(
      UI.tile('Messages envoyés', fmt.compact(t.messages), null, cmp(t.messages, p && p.messages)),
      UI.tile('Longueur moyenne', t.avgLength ? fmt.decimal(t.avgLength) + ' car.' : '—', 'par message contenant du texte', cmp(t.avgLength, p && p.avgLength)),
      UI.tile('Membres actifs à l’écrit', fmt.number(t.authors), t.authors ? fmt.decimal(t.messages / t.authors) + ' messages / membre' : null, cmp(t.authors, p && p.authors)),
      UI.tile('Membres actifs en vocal', fmt.number(t.voiceUsers), null, cmp(t.voiceUsers, p && p.voiceUsers)),
      UI.tile('Temps vocal cumulé', fmt.duration(t.voiceSeconds), null, cmp(t.voiceSeconds, p && p.voiceSeconds)),
      UI.tile('Arrivées / départs', '+' + fmt.number(t.joins) + ' / −' + fmt.number(t.leaves), 'solde ' + (t.joins - t.leaves >= 0 ? '+' : '−') + fmt.number(Math.abs(t.joins - t.leaves)), cmp(t.joins, p && p.joins)),
      UI.tile('Messages supprimés', fmt.number(t.deletions), null, cmp(t.deletions, p && p.deletions, true)),
      UI.tile('@everyone / @here', fmt.number(t.everyone) + ' / ' + fmt.number(t.here)),
      UI.tile('Sanctions', fmt.number(sanctions), fmt.number(t.bans) + ' ban · ' + fmt.number(t.kicks) + ' kick · ' + fmt.number(t.timeouts) + ' timeout', cmp(sanctions, p && p.bans + p.kicks + p.timeouts, true)),
    );
    Core.clear(byId('tiles-now')).append(
      UI.tile('Membres', fmt.number(c.memberCount)),
      UI.tile('Boosts actifs', fmt.number(c.boosts), 'Niveau ' + (c.premiumTier || 0) + ' · ' + fmt.number(c.boosters) + ' booster(s)'),
      UI.tile('Durée moyenne de boost', fmt.days(c.boosterAvgDays), 'ancienneté moyenne des boosters'),
      UI.tile('Membres Nitro', fmt.number(c.nitro), 'estimation (minimum détectable)'),
      UI.tile('Ancienneté moyenne', fmt.days(c.seniority.avgDays), 'médiane : ' + fmt.days(c.seniority.medianDays)),
    );
  }

  // ── Classements ───────────────────────────────────────────────────────────
  /** Export CSV d'un classement : une ligne par entrée, rang en première colonne. */
  function boardCsv(title, header, rows, cells) {
    return function () {
      UI.downloadCsv(title + ' ' + new Date().toISOString().slice(0, 10), ['Rang'].concat(header), rows.map(function (row, i) { return [i + 1].concat(cells(row)); }));
    };
  }

  function personName(row) {
    return row.user ? row.user.name : row.userId;
  }

  function renderBoards(boards, totals) {
    var rank = { label: '#', class: 'rank', value: function (row, i) { return String(i + 1); } };
    var member = { label: 'Membre', value: function (row) { return UI.person(row.user, UI.memberHref(state, row.userId)); } };

    Core.clear(byId('boards')).append(
      UI.card(
        'Palmarès textuel',
        UI.table([rank, member,
          { label: 'Messages', num: true, value: function (row) { return fmt.number(row.messages); } },
          { label: 'Part', num: true, value: function (row) { return totals.messages ? fmt.percent(row.messages / totals.messages) : '—'; } },
        ], boards.senders),
        boardCsv('Palmarès textuel', ['Membre', 'ID', 'Messages'], boards.senders, function (row) { return [personName(row), row.userId, row.messages]; }),
      ),
      UI.card(
        'Salons les plus actifs',
        UI.table([rank,
          {
            label: 'Salon',
            value: function (row) {
              return el('span', { class: 'channel-name' }, (row.isThread ? '🧵 ' : '#') + row.name, row.isDeleted ? el('span', { class: 'badge', text: 'supprimé' }) : null);
            },
          },
          { label: 'Messages', num: true, value: function (row) { return fmt.number(row.messages); } },
          { label: 'Part', num: true, value: function (row) { return totals.messages ? fmt.percent(row.messages / totals.messages) : '—'; } },
        ], boards.channels),
        boardCsv('Salons les plus actifs', ['Salon', 'ID', 'Messages'], boards.channels, function (row) { return [row.name, row.channelId, row.messages]; }),
      ),
      UI.card(
        'Présence en vocal',
        UI.table([rank, member,
          { label: 'Temps', num: true, value: function (row) { return fmt.duration(row.seconds); } },
        ], boards.voice),
        boardCsv('Présence en vocal', ['Membre', 'ID', 'Secondes'], boards.voice, function (row) { return [personName(row), row.userId, row.seconds]; }),
      ),
      UI.card(
        'Membres les plus anciens',
        UI.table([rank, member,
          { label: 'Arrivée', num: true, value: function (row) { return fmt.date(row.joinedAt); } },
          { label: 'Ancienneté', num: true, value: function (row) { return fmt.days((Date.now() - new Date(row.joinedAt)) / 86400000); } },
        ], boards.oldest, 'Aucun membre enregistré.'),
        boardCsv('Membres les plus anciens', ['Membre', 'ID', 'Arrivée'], boards.oldest, function (row) { return [personName(row), row.userId, row.joinedAt]; }),
      ),
      UI.card(
        'Plus anciens boosters',
        UI.table([rank, member,
          { label: 'Depuis', num: true, value: function (row) { return fmt.date(row.boostingSince); } },
          { label: 'Durée', num: true, value: function (row) { return fmt.days((Date.now() - new Date(row.boostingSince)) / 86400000); } },
        ], boards.boosters, 'Aucun booster actuellement.'),
        boardCsv('Plus anciens boosters', ['Membre', 'ID', 'Booste depuis'], boards.boosters, function (row) { return [personName(row), row.userId, row.boostingSince]; }),
      ),
    );
  }

  // ── Invitations (si le suivi est activé dans l'onglet Rapports) ───────────
  function renderInvites(data) {
    var section = byId('invites-section');
    section.hidden = !data.enabled;
    if (!data.enabled) return;
    var s = data.sources;
    var total = s.invite + s.vanity + s.unknown;
    Core.clear(byId('tiles-invites')).append(
      UI.tile('Arrivées suivies', fmt.number(total)),
      UI.tile('Par invitation', fmt.number(s.invite), total ? fmt.percent(s.invite / total) : null),
      UI.tile('Par l’URL personnalisée', fmt.number(s.vanity), total ? fmt.percent(s.vanity / total) : null),
      UI.tile('Origine inconnue', fmt.number(s.unknown), 'invitation non identifiable (ex. arrivées simultanées)'),
    );
    var rank = { label: '#', class: 'rank', value: function (row, i) { return String(i + 1); } };
    Core.clear(byId('boards-invites')).append(
      UI.card(
        'Meilleurs parrains',
        UI.table([rank,
          { label: 'Membre', value: function (row) { return row.user ? UI.person(row.user, UI.memberHref(state, row.userId)) : row.userId; } },
          { label: 'Arrivées', num: true, value: function (row) { return fmt.number(row.joins); } },
          { label: 'Restés', num: true, value: function (row) { return fmt.number(row.stayed); } },
          { label: 'Partis', num: true, value: function (row) { return fmt.number(row.left); } },
        ], data.leaderboard, 'Aucune arrivée par invitation sur la période.'),
        boardCsv('Meilleurs parrains', ['Membre', 'ID', 'Arrivées', 'Restés', 'Partis'], data.leaderboard, function (row) { return [personName(row), row.userId, row.joins, row.stayed, row.left]; }),
      ),
      UI.card(
        'Invitations les plus utilisées',
        UI.table([rank,
          { label: 'Code', value: function (row) { return el('span', {}, el('code', { text: row.code }), row.deleted ? el('span', { class: 'badge', text: 'supprimée' }) : null); } },
          { label: 'Créée par', value: function (row) { return row.inviter ? UI.person(row.inviter) : null; } },
          { label: 'Arrivées', num: true, value: function (row) { return fmt.number(row.joins); } },
        ], data.codes, 'Aucune invitation utilisée sur la période.'),
        boardCsv('Invitations les plus utilisées', ['Code', 'Créée par', 'Arrivées'], data.codes, function (row) { return [row.code, row.inviter ? row.inviter.name : '', row.joins]; }),
      ),
    );
  }

  function renderStatus(guild) {
    byId('page-title').textContent = guild ? 'Statistiques — ' + guild.name : 'Statistiques';
    var line = '';
    if (guild) {
      if (guild.backfillStatus === 'running' || guild.backfillStatus === 'pending') line = 'Rétroactivité en cours : les données des 7 derniers jours arrivent…';
      else if (guild.backfillStatus === 'failed') line = 'La rétroactivité a échoué (voir les logs du bot).';
      else if (guild.trackingSince) line = 'Données disponibles depuis le ' + fmt.date(guild.trackingSince);
    }
    byId('status-line').textContent = line;
  }

  // ── Chargement ────────────────────────────────────────────────────────────
  async function refresh(nextState, filters) {
    state = nextState;
    UI.writeState(state);
    renderStatus(filters.guild());
    var token = ++sequence;
    var params = UI.apiParams(state.guild, state);
    main.classList.add('is-loading');
    UI.showError('');
    try {
      var compare = byId('f-compare').checked ? '&compare=1' : '';
      var results = await Promise.all([
        Core.api(UI.API + '/overview?' + params + compare),
        Core.api(UI.API + '/leaderboards?' + params),
        Core.api(UI.API + '/roles?' + params),
        Core.api(UI.API + '/invites?' + params).catch(function () { return { enabled: false }; }),
      ]);
      if (token !== sequence) return;
      overview = results[0];
      renderTiles(overview);
      renderPanels();
      renderBoards(results[1], overview.totals);
      renderRoleOptions(results[2]);
      renderInvites(results[3]);
      await Promise.all([loadRoleSeries(token), loadRoleRanking(token)]);
    } catch (err) {
      if (token === sequence) UI.showError(err.message);
    } finally {
      if (token === sequence) main.classList.remove('is-loading');
    }
  }

  async function start() {
    try {
      await Core.ready;
      var filters = await UI.initFilters(function (next) { refresh(next, filters); });
      UI.bindMemberSearch(filters.state);
      byId('f-compare').addEventListener('change', function () { refresh(filters.state, filters); });
      // Le lien « Rapports » garde le serveur sélectionné.
      byId('link-reports').addEventListener('click', function (event) {
        event.preventDefault();
        window.location.href = '/m/stats/rapports?guild=' + encodeURIComponent(filters.state.guild);
      });
      if (!filters.guilds.length) {
        byId('empty').hidden = false;
        byId('content').hidden = true;
        return;
      }
      await refresh(filters.state, filters);
    } catch (err) {
      UI.showError(err.message);
    }
  }

  start();
})();
