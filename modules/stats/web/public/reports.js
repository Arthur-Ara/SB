/* Page Rapports du module Statistiques : réglages par serveur (rapport hebdomadaire, suivi des invitations)
   et historique des rapports, consultables et exportables. */
(function () {
  'use strict';

  var el = Core.el;
  var fmt = Core.fmt;
  var API = '/m/stats/api';
  var main = document.getElementById('main');
  var guildId = '';
  var config = null;
  var reports = [];
  var WEEKDAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

  function byId(id) {
    return document.getElementById(id);
  }

  function showError(message) {
    var box = byId('error');
    box.textContent = message || '';
    box.hidden = !message;
  }

  function query() {
    return '?guild=' + encodeURIComponent(guildId);
  }

  function call(method, path, body) {
    return Core.request(method, API + path, body);
  }

  async function busy(promise) {
    showError('');
    main.classList.add('is-loading');
    try {
      return await promise;
    } catch (err) {
      showError(err.message);
      return null;
    } finally {
      main.classList.remove('is-loading');
    }
  }

  // ── Réglages ──────────────────────────────────────────────────────────────
  function renderConfig() {
    var enabled = el('input', { type: 'checkbox' });
    enabled.checked = config.reportEnabled;
    var channel = el('select', { 'aria-label': 'Salon de publication' }, el('option', { value: '', text: '(aucun : rapport seulement enregistré ici)' }), config.textChannels.map(function (c) {
      return el('option', { value: c.id, text: '#' + c.name });
    }));
    channel.value = config.reportChannelId || '';
    var weekday = el('select', { 'aria-label': 'Jour' }, WEEKDAYS.map(function (name, i) { return el('option', { value: String(i + 1), text: name }); }));
    weekday.value = String(config.reportWeekday);
    var hour = el('select', { 'aria-label': 'Heure' }, Array.from({ length: 24 }, function (_, h) { return el('option', { value: String(h), text: String(h).padStart(2, '0') + ' h' }); }));
    hour.value = String(config.reportHour);
    var timezone = el('input', { type: 'text', maxlength: '64', value: config.reportTimezone });
    var invites = el('input', { type: 'checkbox' });
    invites.checked = config.inviteTracking;

    var save = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: 'Enregistrer',
      onclick: function () {
        save.disabled = true;
        busy(
          call('POST', '/config' + query(), {
            reportEnabled: enabled.checked,
            reportChannelId: channel.value || null,
            reportWeekday: Number(weekday.value),
            reportHour: Number(hour.value),
            reportTimezone: timezone.value.trim(),
            inviteTracking: invites.checked,
          }),
        ).then(function (result) {
          save.disabled = false;
          if (result) {
            config = result;
            renderConfig();
          }
        });
      },
    });

    Core.clear(byId('config-card')).append(
      el('div', { class: 'stats-form' },
        el('p', { class: 'muted', text: 'Le rapport résume les 7 derniers jours (messages, vocal, arrivées, sanctions, classements) et les compare aux 7 jours précédents. Il est publié le jour et à l’heure choisis, et conservé ci-dessous.' }),
        el('div', { class: 'filters' },
          el('label', { class: 'check' }, enabled, 'Rapport hebdomadaire activé'),
          el('label', { class: 'field' }, el('span', { text: 'Salon de publication' }), channel),
          el('label', { class: 'field' }, el('span', { text: 'Jour' }), weekday),
          el('label', { class: 'field' }, el('span', { text: 'Heure' }), hour),
          el('label', { class: 'field' }, el('span', { text: 'Fuseau horaire' }), timezone),
        ),
      ),
      el('div', { class: 'stats-form' },
        el('p', { class: 'muted', text: config.canReadInvites
          ? 'Suivi des invitations : chaque arrivée est attribuée à l’invitation utilisée (ou à l’URL personnalisée). Les résultats apparaissent sur le tableau de bord et dans les rapports.'
          : '⚠️ Le bot n’a pas la permission « Gérer le serveur » : le suivi des invitations ne peut pas être activé.' }),
        el('div', { class: 'filters' },
          el('label', { class: 'check' }, invites, 'Suivi des invitations activé'),
          save,
          config.lastReportAt ? el('span', { class: 'muted', text: 'Dernier rapport automatique : ' + fmt.dateTime(config.lastReportAt) }) : null,
        ),
      ),
    );
    invites.disabled = !config.canReadInvites && !config.inviteTracking;
  }

  // ── Liste des rapports ────────────────────────────────────────────────────
  function renderReports() {
    var generate = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: 'Générer un rapport maintenant',
      onclick: function () {
        generate.disabled = true;
        busy(call('POST', '/reports' + query())).then(function (result) {
          generate.disabled = false;
          if (!result) return;
          if (result.error) showError(result.error + ' — le rapport est tout de même enregistré.');
          loadReports().then(function () { openReport(result.id); });
        });
      },
    });
    var rows = reports.map(function (r) {
      return el('tr', {},
        el('td', { text: fmt.date(r.from) + ' → ' + fmt.date(r.to) }),
        el('td', { text: r.origin === 'auto' ? 'Automatique' : 'À la demande' }),
        el('td', { text: fmt.dateTime(r.createdAt) }),
        el('td', {}, r.url ? el('a', { href: r.url, target: '_blank', rel: 'noopener', text: 'Voir sur Discord' }) : el('span', { class: 'muted', text: 'non publié' })),
        el('td', {}, el('div', { class: 'row-actions' },
          el('button', { type: 'button', class: 'btn btn-small', text: 'Afficher', onclick: function () { openReport(r.id); } }),
          el('button', {
            type: 'button',
            class: 'btn btn-ghost btn-small',
            text: 'Supprimer',
            onclick: function () {
              Core.confirm('Supprimer ce rapport de l’historique ? (Le message déjà publié sur Discord n’est pas supprimé.)', { confirmLabel: 'Supprimer' }).then(function (ok) {
                if (!ok) return;
                busy(call('DELETE', '/reports/' + r.id + query())).then(function (res) {
                  if (res) loadReports();
                });
              });
            },
          }),
        )),
      );
    });
    Core.clear(byId('reports-card')).append(
      el('div', { class: 'stats-form' }, el('div', { class: 'filters' }, generate)),
      reports.length
        ? el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
            el('thead', {}, el('tr', {}, ['Période', 'Origine', 'Généré le', 'Discord', ''].map(function (h) { return el('th', { text: h }); }))),
            el('tbody', {}, rows)))
        : el('div', { class: 'empty', text: 'Aucun rapport pour l’instant.' }),
    );
  }

  function deltaText(current, previous) {
    if (previous === null || previous === undefined) return null;
    if (!previous) return current ? 'nouveau' : '=';
    var change = Math.round(((current - previous) / previous) * 100);
    return change ? (change > 0 ? '▲ ' : '▼ ') + Math.abs(change) + ' % vs semaine précédente' : '= semaine précédente';
  }

  function tile(label, value, sub) {
    return el('div', { class: 'card tile' }, el('div', { class: 'tile-label', text: label }), el('div', { class: 'tile-value', text: value }), sub ? el('div', { class: 'tile-sub', text: sub }) : null);
  }

  function list(title, rows, line) {
    return el('div', {}, el('h3', { text: title }), rows && rows.length ? el('ol', {}, rows.map(function (r) { return el('li', { text: line(r) }); })) : el('p', { class: 'muted', text: 'Aucune donnée.' }));
  }

  async function openReport(id) {
    var report = await busy(call('GET', '/reports/' + id + query()));
    if (!report) return;
    var d = report.data;
    var t = d.totals;
    var p = d.previous || {};
    var exportButton = el('button', {
      type: 'button',
      class: 'btn btn-small',
      text: 'Exporter en CSV',
      onclick: function () {
        var rows = [
          ['Messages', t.messages, p.messages],
          ['Membres actifs (écrit)', t.authors, p.authors],
          ['Temps vocal (s)', t.voiceSeconds, p.voiceSeconds],
          ['Membres actifs (vocal)', t.voiceUsers, p.voiceUsers],
          ['Arrivées', t.joins, p.joins],
          ['Départs', t.leaves, p.leaves],
          ['Messages supprimés', t.deletions, p.deletions],
          ['Sanctions', t.sanctions, p.sanctions],
        ];
        downloadCsv('rapport ' + String(d.from).slice(0, 10), ['Indicateur', 'Semaine', 'Semaine précédente'], rows);
      },
    });
    Core.clear(byId('report-view')).append(
      el('h2', { class: 'section-title', text: 'Rapport du ' + fmt.date(d.from) + ' au ' + fmt.date(d.to) }),
      el('section', { class: 'card report-view' },
        el('div', { class: 'stats-form' }, el('div', { class: 'filters' }, exportButton, el('span', { class: 'muted', text: 'Membres : ' + fmt.number(d.memberCount) }))),
        el('div', { class: 'tiles' },
          tile('Messages', fmt.number(t.messages), deltaText(t.messages, p.messages)),
          tile('Membres actifs (écrit)', fmt.number(t.authors), deltaText(t.authors, p.authors)),
          tile('Temps vocal', fmt.duration(t.voiceSeconds), deltaText(t.voiceSeconds, p.voiceSeconds)),
          tile('Arrivées / départs', '+' + fmt.number(t.joins) + ' / −' + fmt.number(t.leaves)),
          tile('Messages supprimés', fmt.number(t.deletions), deltaText(t.deletions, p.deletions)),
          tile('Sanctions', fmt.number(t.sanctions), deltaText(t.sanctions, p.sanctions)),
        ),
        el('div', { class: 'report-lists' },
          list('💬 Les plus bavards', d.senders, function (r) { return r.name + ' — ' + fmt.number(r.messages) + ' messages'; }),
          list('📍 Salons les plus actifs', d.channels, function (r) { return '#' + r.name + ' — ' + fmt.number(r.messages) + ' messages'; }),
          list('🎙️ Présence en vocal', d.voice, function (r) { return r.name + ' — ' + fmt.duration(r.seconds); }),
          d.inviters ? list('📨 Meilleurs parrains', d.inviters, function (r) { return r.name + ' — ' + r.joins + ' arrivée(s), ' + r.stayed + ' restée(s)'; }) : null,
        ),
      ),
    );
    byId('report-view').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function csvCell(value) {
    if (value === null || value === undefined) return '';
    var text = String(value);
    return /[";\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function downloadCsv(name, header, rows) {
    var lines = [header].concat(rows).map(function (row) { return row.map(csvCell).join(';'); });
    var url = URL.createObjectURL(new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    var link = el('a', { href: url, download: name.replace(/[^\w.-]+/g, '_') + '.csv' });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ── Chargement ────────────────────────────────────────────────────────────
  async function loadReports() {
    var result = await busy(call('GET', '/reports' + query()));
    if (result) {
      reports = result;
      renderReports();
    }
  }

  async function loadGuild() {
    byId('content').hidden = true;
    Core.clear(byId('report-view'));
    var result = await busy(call('GET', '/config' + query()));
    if (!result) return;
    config = result;
    renderConfig();
    await loadReports();
    byId('content').hidden = false;
    byId('link-dashboard').href = '/m/stats/?guild=' + encodeURIComponent(guildId);
  }

  async function start() {
    try {
      await Core.ready;
      var guilds = await Core.api(API + '/guilds');
      if (!guilds.length) {
        byId('empty').hidden = false;
        return;
      }
      var select = byId('f-guild');
      Core.clear(select).append(...guilds.map(function (g) { return el('option', { value: g.id, text: g.name }); }));
      var wanted = new URLSearchParams(window.location.search).get('guild');
      guildId = guilds.some(function (g) { return g.id === wanted; }) ? wanted : guilds[0].id;
      select.value = guildId;
      select.addEventListener('change', function () {
        guildId = select.value;
        window.history.replaceState(null, '', '?guild=' + encodeURIComponent(guildId));
        loadGuild();
      });
      await loadGuild();
    } catch (err) {
      showError(err.message);
    }
  }

  start();
})();
