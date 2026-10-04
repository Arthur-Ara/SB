/* Composants partagés des pages Statistiques : filtres, panneaux de graphiques, tableaux. */
(function () {
  'use strict';

  var el = Core.el;
  var fmt = Core.fmt;
  var API = '/m/stats/api';
  var DAY_MS = 24 * 60 * 60 * 1000;
  var UI = { API: API };

  function byId(id) {
    return document.getElementById(id);
  }
  UI.byId = byId;

  function isNum(value) {
    return typeof value === 'number' && isFinite(value);
  }

  // ── Statistiques descriptives ─────────────────────────────────────────────
  UI.mean = function (values) {
    var list = values.filter(isNum);
    if (!list.length) return null;
    return list.reduce(function (a, b) { return a + b; }, 0) / list.length;
  };

  UI.median = function (values) {
    var list = values.filter(isNum).sort(function (a, b) { return a - b; });
    if (!list.length) return null;
    var mid = Math.floor(list.length / 2);
    return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
  };

  UI.sum = function (values) {
    return values.filter(isNum).reduce(function (a, b) { return a + b; }, 0);
  };

  UI.last = function (values) {
    for (var i = values.length - 1; i >= 0; i -= 1) if (isNum(values[i])) return values[i];
    return null;
  };

  // ── Libellés des intervalles ──────────────────────────────────────────────
  var formatters = {};
  function formatter(key, options) {
    if (!formatters[key]) formatters[key] = new Intl.DateTimeFormat('fr-FR', Object.assign({ timeZone: 'UTC' }, options));
    return formatters[key];
  }

  /** Clé SQL (« 2026-09-28 14:05 », « 2026-09 »…) → libellé lisible. */
  UI.formatBucket = function (key, interval, long) {
    var parts = String(key).split(/[- :]/).map(Number);
    var date = new Date(Date.UTC(parts[0], (parts[1] || 1) - 1, parts[2] || 1, parts[3] || 0, parts[4] || 0));
    switch (interval) {
      case 'minute':
        return long
          ? formatter('nl', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date)
          : formatter('ns', { hour: '2-digit', minute: '2-digit' }).format(date);
      case 'hour':
        return long
          ? formatter('hl', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date)
          : formatter('hs', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
      case 'week':
        return long
          ? 'Semaine du ' + formatter('wl', { day: 'numeric', month: 'long', year: 'numeric' }).format(date)
          : 'Sem. ' + formatter('ws', { day: 'numeric', month: 'short' }).format(date);
      case 'month':
        return long
          ? formatter('ml', { month: 'long', year: 'numeric' }).format(date)
          : formatter('ms', { month: 'short', year: 'numeric' }).format(date);
      default:
        return long
          ? formatter('dl', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(date)
          : formatter('ds', { day: 'numeric', month: 'short' }).format(date);
    }
  };

  var INTERVAL_LABELS = { minute: 'par minute', hour: 'par heure', day: 'par jour', week: 'par semaine', month: 'par mois' };
  UI.intervalLabel = function (interval) {
    return INTERVAL_LABELS[interval] || '';
  };

  // ── Période : préréglages, jour précis, heure précise, plage libre ────────
  var HOUR_MS = 60 * 60 * 1000;
  var PRESETS = [
    ['1h', 'Dernière heure', 1 / 24],
    ['24h', 'Dernières 24 heures', 1],
    ['7d', '7 derniers jours', 7],
    ['30d', '30 derniers jours', 30],
    ['90d', '90 derniers jours', 90],
    ['365d', '12 derniers mois', 365],
  ];
  UI.RANGES = {};
  PRESETS.forEach(function (p) { UI.RANGES[p[0]] = p[2]; });
  var MODES = [['day', 'Jour précis…'], ['hour', 'Heure précise…'], ['custom', 'Plage personnalisée…']];
  var PERIOD_KEYS = ['range', 'day', 'hour', 'from', 'to', 'interval'];

  function pad(v) {
    return String(v).padStart(2, '0');
  }
  function toLocalDate(date) {
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }
  function toLocalInput(date) {
    return toLocalDate(date) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  /** Période par défaut (7 derniers jours, fréquence automatique). */
  UI.defaultPeriod = function () {
    return { range: '7d', day: '', hour: '', from: '', to: '', interval: 'auto' };
  };

  /** Une période est complète quand le mode choisi a ses dates. */
  UI.periodComplete = function (p) {
    if (p.range === 'day') return Boolean(p.day);
    if (p.range === 'hour') return Boolean(p.hour);
    if (p.range === 'custom') return Boolean(p.from && p.to);
    return Boolean(UI.RANGES[p.range]);
  };

  /** Bornes [début, fin[ d'une période, en heure locale du navigateur. */
  UI.periodBounds = function (p) {
    if (p.range === 'day' && p.day) {
      var dayStart = new Date(p.day + 'T00:00');
      var dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);
      return [dayStart, dayEnd];
    }
    if (p.range === 'hour' && p.hour) {
      var hourStart = new Date(p.hour);
      hourStart.setMinutes(0, 0, 0);
      return [hourStart, new Date(hourStart.getTime() + HOUR_MS)];
    }
    if (p.range === 'custom' && p.from && p.to) return [new Date(p.from), new Date(p.to)];
    var now = new Date();
    return [new Date(now.getTime() - (UI.RANGES[p.range] || 7) * DAY_MS), now];
  };

  /** Libellé court d'une période (bouton « période » des graphiques). */
  UI.periodLabel = function (p) {
    var preset = PRESETS.find(function (x) { return x[0] === p.range; });
    if (preset) return preset[1];
    var bounds = UI.periodBounds(p);
    if (p.range === 'day') return bounds[0].toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    if (p.range === 'hour') {
      return bounds[0].toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + ', ' +
        pad(bounds[0].getHours()) + 'h–' + pad(bounds[1].getHours()) + 'h';
    }
    return fmt.dateTime(bounds[0]) + ' → ' + fmt.dateTime(bounds[1]);
  };

  UI.readState = function () {
    var params = new URLSearchParams(window.location.search);
    var state = UI.defaultPeriod();
    PERIOD_KEYS.forEach(function (key) {
      if (params.get(key)) state[key] = params.get(key);
    });
    if (!UI.RANGES[state.range] && !MODES.some(function (m) { return m[0] === state.range; })) state.range = '7d';
    if (!UI.periodComplete(state)) state.range = '7d';
    state.guild = params.get('guild') || '';
    state.id = params.get('id') || '';
    return state;
  };

  UI.stateQuery = function (state, extra) {
    var params = new URLSearchParams();
    if (state.guild) params.set('guild', state.guild);
    params.set('range', state.range);
    if (state.range === 'day') params.set('day', state.day);
    if (state.range === 'hour') params.set('hour', state.hour);
    if (state.range === 'custom') {
      params.set('from', state.from);
      params.set('to', state.to);
    }
    if (state.interval && state.interval !== 'auto') params.set('interval', state.interval);
    Object.keys(extra || {}).forEach(function (key) {
      if (extra[key]) params.set(key, extra[key]);
    });
    return params.toString();
  };

  UI.writeState = function (state, extra) {
    window.history.replaceState(null, '', window.location.pathname + '?' + UI.stateQuery(state, extra));
  };

  /** Paramètres d'API : serveur, période (ISO UTC), fréquence et décalage horaire du navigateur. */
  UI.apiParams = function (guildId, period) {
    var bounds = UI.periodBounds(period);
    return new URLSearchParams({
      guild: guildId,
      from: bounds[0].toISOString(),
      to: bounds[1].toISOString(),
      interval: period.interval || 'auto',
      tz: String(-new Date().getTimezoneOffset()),
    }).toString();
  };

  function field(label, control, key) {
    return el('label', { class: 'field', dataset: key ? { when: key } : undefined }, el('span', { text: label }), control);
  }

  /**
   * Sélecteur de période réutilisable : préréglages, jour précis, heure précise, plage libre et fréquence.
   * @returns {{ root: HTMLElement, read(): object, write(period): void }}
   */
  UI.periodPicker = function (options) {
    options = options || {};
    var range = el(
      'select',
      { 'aria-label': 'Période' },
      PRESETS.map(function (p) { return el('option', { value: p[0], text: p[1] }); }),
      MODES.map(function (m) { return el('option', { value: m[0], text: m[1] }); }),
    );
    var day = el('input', { type: 'date' });
    var hour = el('input', { type: 'datetime-local', step: '3600' });
    var from = el('input', { type: 'datetime-local' });
    var to = el('input', { type: 'datetime-local' });
    var interval = el(
      'select',
      { 'aria-label': 'Fréquence' },
      el('option', { value: 'auto', text: 'Automatique' }),
      el('option', { value: 'minute', text: 'Par minute' }),
      el('option', { value: 'hour', text: 'Par heure' }),
      el('option', { value: 'day', text: 'Par jour' }),
      el('option', { value: 'week', text: 'Par semaine' }),
      el('option', { value: 'month', text: 'Par mois' }),
    );
    var root = el(
      'div',
      { class: 'period-fields' },
      field('Période', range),
      field('Jour', day, 'day'),
      field('Heure', hour, 'hour'),
      field('Du', from, 'custom'),
      field('Au', to, 'custom'),
      field('Fréquence', interval),
    );

    function toggle() {
      root.querySelectorAll('[data-when]').forEach(function (node) {
        node.hidden = node.dataset.when !== range.value;
      });
    }

    // Valeurs par défaut utiles quand on bascule sur un mode précis.
    range.addEventListener('change', function () {
      var now = new Date();
      if (range.value === 'day' && !day.value) day.value = toLocalDate(now);
      if (range.value === 'hour' && !hour.value) {
        now.setMinutes(0, 0, 0);
        hour.value = toLocalInput(now);
      }
      if (range.value === 'custom' && (!from.value || !to.value)) {
        to.value = toLocalInput(now);
        from.value = toLocalInput(new Date(now.getTime() - 7 * DAY_MS));
      }
      toggle();
    });

    var api = {
      root: root,
      read: function () {
        return { range: range.value, day: day.value, hour: hour.value, from: from.value, to: to.value, interval: interval.value };
      },
      write: function (p) {
        range.value = p.range;
        day.value = p.day || '';
        hour.value = p.hour || '';
        from.value = p.from || '';
        to.value = p.to || '';
        interval.value = p.interval || 'auto';
        toggle();
      },
    };
    if (options.onChange) {
      [range, day, hour, from, to, interval].forEach(function (control) {
        control.addEventListener('change', function () {
          var p = api.read();
          if (UI.periodComplete(p)) options.onChange(p);
        });
      });
    }
    toggle();
    return api;
  };

  /**
   * Relie la barre de filtres (#f-guild, #f-period, #filters) à l'état de la page
   * et appelle onChange(state) à chaque modification complète.
   */
  UI.initFilters = async function (onChange) {
    var state = UI.readState();
    var guildSelect = byId('f-guild');

    var guilds = await Core.api(API + '/guilds');
    Core.clear(guildSelect);
    guilds.forEach(function (guild) {
      guildSelect.append(el('option', { value: guild.id, text: guild.name }));
    });
    if (!guilds.some(function (g) { return g.id === state.guild; })) state.guild = guilds.length ? guilds[0].id : '';
    guildSelect.value = state.guild;

    function commit(period) {
      state.guild = guildSelect.value;
      PERIOD_KEYS.forEach(function (key) { state[key] = period[key]; });
      onChange(state);
    }

    var picker = UI.periodPicker({ onChange: commit });
    picker.write(state);
    Core.clear(byId('f-period')).append(picker.root);

    guildSelect.addEventListener('change', function () {
      commit(picker.read());
    });
    byId('filters').addEventListener('submit', function (event) {
      event.preventDefault();
      var period = picker.read();
      if (UI.periodComplete(period)) commit(period);
    });

    return { state: state, guilds: guilds, guild: function () { return guilds.find(function (g) { return g.id === state.guild; }); } };
  };

  /** Période courante de l'état de page (sans le serveur ni l'ID de membre). */
  UI.periodOf = function (state) {
    var p = {};
    PERIOD_KEYS.forEach(function (key) { p[key] = state[key]; });
    return p;
  };

  /** Formulaire « Rechercher un membre » : ouvre la fiche d'investigation. */
  UI.bindMemberSearch = function (state) {
    var form = byId('member-search');
    if (!form) return;
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var id = byId('f-member').value.trim();
      if (!/^\d{17,20}$/.test(id)) {
        byId('f-member').setCustomValidity('ID Discord : 17 à 20 chiffres');
        byId('f-member').reportValidity();
        return;
      }
      window.location.href = '/m/stats/membre?' + UI.stateQuery(state, { id: id });
    });
    byId('f-member').addEventListener('input', function () {
      byId('f-member').setCustomValidity('');
    });
  };

  UI.memberHref = function (state, userId) {
    return '/m/stats/membre?' + UI.stateQuery(state, { id: userId });
  };

  // ── Messages d'erreur ─────────────────────────────────────────────────────
  UI.showError = function (message) {
    var box = byId('error');
    if (!box) return;
    box.textContent = message;
    box.hidden = !message;
  };

  // ── Graphiques ────────────────────────────────────────────────────────────
  /** Couleurs de la charte (style.md) lues dans les jetons CSS du thème courant. */
  function palette() {
    return {
      primary: Core.token('chart-primary'),
      positive: Core.token('chart-positive'),
      negative: Core.token('chart-negative'),
      mean: Core.token('chart-mean'),
      median: Core.token('chart-median'),
      surface: Core.token('surface-solid'),
      text1: Core.token('text-primary'),
      text2: Core.token('text-secondary'),
      muted: Core.token('axis-text'),
      grid: Core.token('grid'),
      axis: Core.token('axis'),
      border: Core.token('border-strong'),
    };
  }

  function alpha(hex, opacity) {
    var match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!match) return hex;
    return 'rgba(' + parseInt(match[1], 16) + ',' + parseInt(match[2], 16) + ',' + parseInt(match[3], 16) + ',' + opacity + ')';
  }

  /** Ligne verticale qui suit le survol (repère de lecture de l'axe X). */
  var crosshair = {
    id: 'crosshair',
    afterDatasetsDraw: function (chart, args, options) {
      var active = chart.tooltip && chart.tooltip.getActiveElements();
      if (!active || !active.length) return;
      var x = active[0].element.x;
      var area = chart.chartArea;
      var ctx = chart.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x, area.top);
      ctx.lineTo(x, area.bottom);
      ctx.lineWidth = 1;
      ctx.strokeStyle = options.color || '#898781';
      ctx.stroke();
      ctx.restore();
    },
  };

  UI.formatValue = function (value, decimals) {
    if (!isNum(value)) return '—';
    return decimals ? fmt.decimal(value, decimals) : fmt.number(Math.round(value));
  };

  function referenceLine(label, shortLabel, value, length, color, dash) {
    return {
      label: label,
      shortLabel: shortLabel,
      data: new Array(length).fill(value),
      borderColor: color,
      backgroundColor: color,
      borderWidth: 2,
      borderDash: dash,
      pointRadius: 0,
      pointHoverRadius: 0,
      pointHitRadius: 0,
      fill: false,
      tension: 0,
    };
  }

  /** Dégradé vertical sous la courbe (fondu vers le bas), recalculé à chaque redimensionnement. */
  function fadeGradient(color) {
    return function (context) {
      var chart = context.chart;
      var area = chart.chartArea;
      if (!area) return alpha(color, 0.12);
      var gradient = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
      gradient.addColorStop(0, alpha(color, 0.35));
      gradient.addColorStop(0.6, alpha(color, 0.08));
      gradient.addColorStop(1, alpha(color, 0));
      return gradient;
    };
  }

  /**
   * Graphique en courbe (Chart.js) avec, en option, la moyenne et la médiane
   * superposées en lignes de référence.
   * cfg : { labels, interval, values, seriesLabel, decimals, fill, beginAtZero, mean, median,
   *         tone: 'primary' | 'positive' | 'negative' }
   */
  UI.lineChart = function (canvas, cfg) {
    var c = palette();
    var color = c[cfg.tone] || c.primary;
    var count = cfg.values.length;
    var datasets = [
      {
        label: cfg.seriesLabel,
        shortLabel: cfg.seriesLabel,
        data: cfg.values,
        borderColor: color,
        backgroundColor: cfg.fill ? fadeGradient(color) : color,
        fill: cfg.fill ? (cfg.beginAtZero === false ? 'start' : 'origin') : false,
        borderWidth: 2,
        borderCapStyle: 'round',
        borderJoinStyle: 'round',
        cubicInterpolationMode: 'monotone',
        // Les moyennes n'ont pas de valeur sur les intervalles vides : on relie les points connus
        // et on les rend visibles (sinon un point isolé entre deux vides n'apparaît pas).
        spanGaps: true,
        pointRadius: count <= 2 || cfg.values.some(function (v) { return v === null; }) ? 3 : 0,
        pointBackgroundColor: color,
        pointBorderColor: c.surface,
        pointHoverRadius: 5,
        pointHoverBorderWidth: 2,
        pointHoverBackgroundColor: color,
        pointHoverBorderColor: c.surface,
        pointHitRadius: 12,
      },
    ];

    if (cfg.mean) {
      var mean = UI.mean(cfg.values);
      if (mean !== null) {
        datasets.push(referenceLine('Moyenne · ' + UI.formatValue(mean, cfg.decimals || 1), 'Moyenne', mean, count, c.mean, [6, 4]));
      }
    }
    if (cfg.median) {
      var median = UI.median(cfg.values);
      if (median !== null) {
        datasets.push(referenceLine('Médiane · ' + UI.formatValue(median, cfg.decimals || 1), 'Médiane', median, count, c.median, [2, 3]));
      }
    }

    return new Chart(canvas, {
      type: 'line',
      data: {
        labels: cfg.labels.map(function (key) { return UI.formatBucket(key, cfg.interval, false); }),
        datasets: datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { top: 4, right: 4 } },
        plugins: {
          legend: {
            display: datasets.length > 1,
            position: 'top',
            align: 'end',
            labels: { color: c.text2, usePointStyle: true, pointStyle: 'line', boxWidth: 24, font: { size: 12 } },
          },
          tooltip: {
            backgroundColor: c.surface,
            titleColor: c.text2,
            bodyColor: c.text1,
            borderColor: c.border,
            borderWidth: 1,
            cornerRadius: 10,
            padding: 12,
            caretSize: 0,
            usePointStyle: true,
            boxWidth: 14,
            boxHeight: 2,
            titleFont: { weight: 'normal', size: 12 },
            bodyFont: { size: 13 },
            callbacks: {
              title: function (items) {
                return items.length ? UI.formatBucket(cfg.labels[items[0].dataIndex], cfg.interval, true) : '';
              },
              label: function (item) {
                return ' ' + UI.formatValue(item.parsed.y, cfg.decimals) + '   ' + item.dataset.shortLabel;
              },
              labelPointStyle: function () {
                return { pointStyle: 'line', rotation: 0 };
              },
            },
          },
          crosshair: { color: c.axis },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { color: c.axis },
            ticks: { color: c.muted, maxRotation: 0, autoSkip: true, autoSkipPadding: 18, font: { size: 11 } },
          },
          y: {
            beginAtZero: cfg.beginAtZero !== false,
            grace: '5%',
            grid: { color: c.grid },
            border: { display: false },
            ticks: {
              color: c.muted,
              font: { size: 11 },
              precision: cfg.decimals ? undefined : 0,
              maxTicksLimit: 6,
              callback: function (value) { return fmt.compact(value); },
            },
          },
        },
      },
      plugins: [crosshair],
    });
  };

  /** Couleurs distinctes pour les graphiques à plusieurs courbes (lisibles en thème clair et sombre). */
  UI.SERIES_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6', '#ef4444', '#84cc16', '#f97316', '#14b8a6', '#a855f7', '#eab308', '#3b82f6', '#d946ef', '#64748b'];

  /**
   * Graphique à plusieurs courbes (une par série).
   * cfg : { labels, interval, series: [{ label, values, color, hidden? }] }
   * La légende native est masquée : l'appelant fournit la sienne (tableau cliquable).
   */
  UI.multiLineChart = function (canvas, cfg) {
    var c = palette();
    return new Chart(canvas, {
      type: 'line',
      data: {
        labels: cfg.labels.map(function (key) { return UI.formatBucket(key, cfg.interval, false); }),
        datasets: cfg.series.map(function (s) {
          return {
            label: s.label,
            shortLabel: s.label,
            data: s.values,
            borderColor: s.color,
            backgroundColor: s.color,
            hidden: Boolean(s.hidden),
            fill: false,
            borderWidth: 2,
            borderCapStyle: 'round',
            borderJoinStyle: 'round',
            cubicInterpolationMode: 'monotone',
            pointRadius: cfg.labels.length <= 2 ? 3 : 0,
            pointBackgroundColor: s.color,
            pointBorderColor: c.surface,
            pointHoverRadius: 5,
            pointHoverBorderWidth: 2,
            pointHitRadius: 12,
          };
        }),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { top: 4, right: 4 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: c.surface,
            titleColor: c.text2,
            bodyColor: c.text1,
            borderColor: c.border,
            borderWidth: 1,
            cornerRadius: 10,
            padding: 12,
            caretSize: 0,
            usePointStyle: true,
            boxWidth: 14,
            boxHeight: 2,
            itemSort: function (a, b) { return b.parsed.y - a.parsed.y; },
            titleFont: { weight: 'normal', size: 12 },
            bodyFont: { size: 13 },
            callbacks: {
              title: function (items) {
                return items.length ? UI.formatBucket(cfg.labels[items[0].dataIndex], cfg.interval, true) : '';
              },
              label: function (item) {
                return ' ' + UI.formatValue(item.parsed.y) + '   ' + item.dataset.shortLabel;
              },
              labelPointStyle: function () {
                return { pointStyle: 'line', rotation: 0 };
              },
            },
          },
          crosshair: { color: c.axis },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { color: c.axis },
            ticks: { color: c.muted, maxRotation: 0, autoSkip: true, autoSkipPadding: 18, font: { size: 11 } },
          },
          y: {
            beginAtZero: true,
            grace: '5%',
            grid: { color: c.grid },
            border: { display: false },
            ticks: {
              color: c.muted,
              font: { size: 11 },
              precision: 0,
              maxTicksLimit: 6,
              callback: function (value) { return fmt.compact(value); },
            },
          },
        },
      },
      plugins: [crosshair],
    });
  };

  /**
   * Panneau de graphique avec cases « Moyenne » / « Médiane », vue tableau et résumé.
   * options : { id, title, subtitle, seriesLabel, decimals, fill, beginAtZero, summary: 'sum'|'last'|'none', unit, control,
   *             tone: 'primary'|'positive'|'negative' (émeraude pour les hausses, rose pour les baisses/suppressions),
   *             onPeriodChange(period|null), globalPeriod() } — les deux derniers activent la période propre au graphique.
   */
  UI.createPanel = function (container, options) {
    var meanBox = el('input', { type: 'checkbox' });
    var medianBox = el('input', { type: 'checkbox' });
    var tableButton = el('button', { type: 'button', class: 'btn btn-ghost btn-small', 'aria-pressed': 'false', text: 'Tableau' });
    var csvButton = UI.csvButton(function () {
      if (!data) return;
      UI.downloadCsv(
        options.title + ' ' + new Date().toISOString().slice(0, 10),
        ['Période', seriesLabel],
        data.labels.map(function (key, i) { return [UI.formatBucket(key, data.interval, true), data.values[i]]; }),
      );
    });
    var canvas = el('canvas', { role: 'img', 'aria-label': options.title });
    var summary = el('p', { class: 'panel-summary' });
    var subtitle = el('p', { class: 'panel-sub', text: options.subtitle || '' });
    var tableWrap = el('div', { class: 'panel-table table-wrap', hidden: true });

    // Période propre au graphique (sinon : période globale de la page)
    var override = null;
    var periodButton = null;
    var periodBox = null;
    if (options.onPeriodChange) {
      var picker = UI.periodPicker();
      periodButton = el('button', { type: 'button', class: 'btn btn-ghost btn-small period-button', 'aria-expanded': 'false' });
      var close = function () {
        periodBox.hidden = true;
        periodButton.setAttribute('aria-expanded', 'false');
      };
      var apply = el('button', {
        type: 'button',
        class: 'btn btn-primary btn-small',
        text: 'Appliquer à ce graphique',
        onclick: function () {
          var p = picker.read();
          if (!UI.periodComplete(p)) return;
          override = p;
          updatePeriodButton();
          close();
          options.onPeriodChange(override);
        },
      });
      var reset = el('button', {
        type: 'button',
        class: 'btn btn-small',
        text: 'Revenir à la période globale',
        onclick: function () {
          override = null;
          updatePeriodButton();
          close();
          options.onPeriodChange(null);
        },
      });
      periodBox = el('div', { class: 'panel-period', hidden: true }, picker.root, el('div', { class: 'panel-period-actions' }, apply, reset));
      periodButton.addEventListener('click', function () {
        var opening = periodBox.hidden;
        if (opening) picker.write(override || (options.globalPeriod ? options.globalPeriod() : UI.defaultPeriod()));
        periodBox.hidden = !opening;
        periodButton.setAttribute('aria-expanded', String(opening));
      });
    }

    function updatePeriodButton() {
      if (!periodButton) return;
      periodButton.textContent = '⏱ ' + (override ? UI.periodLabel(override) : 'Période globale');
      periodButton.classList.toggle('is-override', Boolean(override));
    }
    updatePeriodButton();

    var root = el(
      'article',
      { class: 'card panel', id: 'panel-' + options.id },
      el(
        'header',
        { class: 'panel-head' },
        el('div', {}, el('h2', { text: options.title }), subtitle),
        el(
          'div',
          { class: 'panel-tools' },
          options.control || null,
          periodButton,
          el('label', { class: 'check' }, meanBox, 'Moyenne'),
          el('label', { class: 'check' }, medianBox, 'Médiane'),
          tableButton,
          csvButton,
        ),
      ),
      periodBox,
      summary,
      el('div', { class: 'panel-body' }, canvas),
      tableWrap,
    );
    container.appendChild(root);

    var chart = null;
    var data = null;
    var seriesLabel = options.seriesLabel || options.title;

    function summaryPart(label, value) {
      return [label + ' : ', el('strong', { text: UI.formatValue(value, options.decimals) + (options.unit ? ' ' + options.unit : '') })];
    }

    function renderSummary() {
      var parts = [];
      if (options.summary === 'sum') parts.push(summaryPart('Total', UI.sum(data.values)));
      if (options.summary === 'last') parts.push(summaryPart('Dernière valeur', UI.last(data.values)));
      if (meanBox.checked) parts.push(summaryPart('Moyenne', UI.mean(data.values)));
      if (medianBox.checked) parts.push(summaryPart('Médiane', UI.median(data.values)));
      var nodes = [];
      parts.forEach(function (part, i) {
        if (i) nodes.push('  ·  ');
        nodes.push(part);
      });
      if (data.note) nodes.push(parts.length ? '  ·  ' : '', data.note);
      Core.clear(summary).append.apply(summary, nodes.flat().map(function (n) { return n instanceof Node ? n : document.createTextNode(n); }));
      subtitle.textContent = [options.subtitle, override ? 'période propre' : null, UI.intervalLabel(data.interval)]
        .filter(Boolean)
        .join(' · ');
    }

    function renderTable() {
      if (tableWrap.hidden) return;
      Core.clear(tableWrap).append(
        el(
          'table',
          { class: 'data' },
          el('thead', {}, el('tr', {}, el('th', { text: 'Période' }), el('th', { class: 'num', text: seriesLabel }))),
          el(
            'tbody',
            {},
            data.labels.map(function (key, i) {
              return el(
                'tr',
                {},
                el('td', { text: UI.formatBucket(key, data.interval, true) }),
                el('td', { class: 'num', text: UI.formatValue(data.values[i], options.decimals) }),
              );
            }),
          ),
        ),
      );
    }

    function render() {
      if (!data) return;
      if (chart) chart.destroy();
      chart = UI.lineChart(canvas, {
        labels: data.labels,
        interval: data.interval,
        values: data.values,
        seriesLabel: seriesLabel,
        decimals: options.decimals,
        fill: options.fill,
        tone: options.tone,
        beginAtZero: options.beginAtZero,
        mean: meanBox.checked,
        median: medianBox.checked,
      });
      renderSummary();
      renderTable();
    }

    meanBox.addEventListener('change', render);
    medianBox.addEventListener('change', render);
    tableButton.addEventListener('click', function () {
      tableWrap.hidden = !tableWrap.hidden;
      tableButton.setAttribute('aria-pressed', String(!tableWrap.hidden));
      renderTable();
    });
    window.addEventListener('themechange', render);

    return {
      root: root,
      /** data : { labels, interval, values, seriesLabel?, note? } */
      setData: function (next) {
        data = next;
        if (next.seriesLabel) seriesLabel = next.seriesLabel;
        render();
      },
      /** Période propre au graphique, ou null s'il suit la période globale. */
      period: function () {
        return override;
      },
      setLoading: function (loading) {
        root.classList.toggle('is-loading', Boolean(loading));
      },
    };
  };

  // ── Export CSV (côté navigateur : rien n'est recalculé par le serveur) ────
  function csvCell(value) {
    if (value === null || value === undefined) return '';
    var text = String(value);
    return /[";\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  /** Télécharge un CSV (séparateur « ; » et BOM UTF-8 : s'ouvre directement dans Excel en français). */
  UI.downloadCsv = function (filename, header, rows) {
    var lines = [header].concat(rows).map(function (row) { return row.map(csvCell).join(';'); });
    var blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = el('a', { href: url, download: filename.replace(/[^\w.-]+/g, '_') + '.csv' });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  };

  UI.csvButton = function (onclick) {
    return el('button', { type: 'button', class: 'btn btn-ghost btn-small', title: 'Exporter en CSV', text: 'CSV', onclick: onclick });
  };

  // ── Blocs réutilisables ───────────────────────────────────────────────────
  /**
   * Tuile d'indicateur. `compare` (facultatif) : { current, previous, inverse } — affiche l'évolution par rapport
   * à la période précédente (`inverse` : une hausse est une mauvaise nouvelle, ex. départs ou sanctions).
   */
  UI.tile = function (label, value, sub, compare) {
    var deltaNode = null;
    if (compare && isNum(compare.previous) && isNum(compare.current)) {
      var diff = compare.current - compare.previous;
      var pct = compare.previous ? Math.round((diff / compare.previous) * 100) : null;
      var good = compare.inverse ? diff < 0 : diff > 0;
      var text = !diff ? '= période précédente' : (diff > 0 ? '▲ ' : '▼ ') + (pct === null ? 'nouveau' : Math.abs(pct) + ' %') + ' vs période précédente';
      deltaNode = el('div', { class: 'tile-delta ' + (!diff ? 'flat' : good ? 'up' : 'down'), text: text, title: 'Période précédente : ' + fmt.number(compare.previous) });
    }
    return el(
      'div',
      { class: 'card tile' },
      el('div', { class: 'tile-label', text: label }),
      el('div', { class: 'tile-value', text: value }),
      sub ? el('div', { class: 'tile-sub', text: sub }) : null,
      deltaNode,
    );
  };

  UI.person = function (user, href) {
    var content = [el('img', { src: user.avatar, alt: '', loading: 'lazy' }), el('span', { text: user.name, title: user.username ? '@' + user.username : user.id })];
    return href ? el('a', { class: 'person', href: href }, content) : el('span', { class: 'person' }, content);
  };

  UI.swatch = function (color) {
    var node = el('span', { class: 'swatch', 'aria-hidden': 'true' });
    if (color) node.style.background = color;
    return node;
  };

  /**
   * Tableau de données. columns : [{ label, num?, value(row, index) → texte | Node }]
   */
  UI.table = function (columns, rows, emptyText) {
    if (!rows.length) return el('div', { class: 'empty', text: emptyText || 'Aucune donnée sur la période.' });
    return el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        { class: 'data' },
        el('thead', {}, el('tr', {}, columns.map(function (col) {
          return el('th', { class: [col.num ? 'num' : '', col.class || ''].join(' ').trim() || null, text: col.label });
        }))),
        el('tbody', {}, rows.map(function (row, i) {
          return el('tr', {}, columns.map(function (col) {
            var value = col.value(row, i);
            return el('td', { class: [col.num ? 'num' : '', col.class || ''].join(' ').trim() || null }, value === null || value === undefined ? '—' : value);
          }));
        })),
      ),
    );
  };

  /** Carte de classement ; `onCsv` (facultatif) ajoute un bouton d'export CSV dans l'en-tête. */
  UI.card = function (title, body, onCsv) {
    var head = onCsv ? el('div', { class: 'board-head' }, el('h2', { text: title }), UI.csvButton(onCsv)) : el('h2', { text: title });
    return el('section', { class: 'card board' }, head, body);
  };

  window.StatsUI = UI;
})();
