/*
 * Onglet Changelog : journal des versions (changelog.json), filtrable par module (sélecteur, ou clic sur
 * l'étiquette d'une modification) et par catégorie (onglets). Les deux filtres se combinent ; le module choisi
 * est gardé dans l'adresse (?module=tickets) pour pouvoir partager le lien.
 */
(function () {
  'use strict';

  var el = Core.el;
  var data = null;
  var activeType = 'all';
  var activeModule = new URLSearchParams(window.location.search).get('module') || 'all';
  var activeVersion = new URLSearchParams(window.location.search).get('version') || 'all';

  /** Versions retenues par le filtre de version (toutes, ou une seule). */
  function shownEntries() {
    return data.entries.filter(function (entry) { return activeVersion === 'all' || entry.version === activeVersion; });
  }

  /** Garde les filtres dans l'adresse (?module=…&version=…) pour partager le lien. */
  function syncUrl() {
    var url = new URL(window.location.href);
    if (activeModule === 'all') url.searchParams.delete('module');
    else url.searchParams.set('module', activeModule);
    if (activeVersion === 'all') url.searchParams.delete('version');
    else url.searchParams.set('version', activeVersion);
    url.hash = '';
    window.history.replaceState(null, '', url.pathname + url.search);
  }

  /** « 1.3.2 » → [1, 3, 2] (parties manquantes = 0), pour trier et regrouper les versions. */
  function versionParts(version) {
    var parts = String(version).split('.').map(function (n) { return parseInt(n, 10) || 0; });
    while (parts.length < 3) parts.push(0);
    return parts;
  }

  /**
   * Options du sélecteur, de la plus ancienne à la plus récente, regroupées par version mineure :
   *   v1.0            (= 1.0.0)
   *      └ v1.0.1
   *      └ v1.0.2
   *   v1.1 …
   * Une version mineure sans x.y.0 publiée garde sa ligne de titre, non sélectionnable.
   */
  function versionOptions() {
    var latest = data.entries[0] && data.entries[0].version;
    var indent = String.fromCharCode(160, 160, 160, 160) + '└ ';
    var sorted = data.entries.slice().sort(function (a, b) {
      var x = versionParts(a.version);
      var y = versionParts(b.version);
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    });
    var options = [];
    var currentMinor = null;
    sorted.forEach(function (entry) {
      var parts = versionParts(entry.version);
      var minor = parts[0] + '.' + parts[1];
      var suffix = (entry.version === latest ? ' (dernière)' : '') + (entry.title ? ' — ' + entry.title : '');
      if (minor !== currentMinor) {
        currentMinor = minor;
        if (parts[2] === 0) {
          options.push(el('option', { value: entry.version, text: 'v' + minor + suffix }));
          return;
        }
        options.push(el('option', { value: '', disabled: true, text: 'v' + minor }));
      }
      options.push(el('option', { value: entry.version, text: indent + 'v' + entry.version + suffix }));
    });
    return options;
  }

  function setVersion(version) {
    activeVersion = version;
    syncUrl();
    if (activeType !== 'all' && !countVisible(activeType)) activeType = 'all';
    renderAll();
  }
  var dateFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

  function formatDate(iso) {
    if (!iso) return '';
    var date = new Date(iso + 'T12:00:00Z');
    return isNaN(date.getTime()) ? iso : dateFmt.format(date);
  }

  function plural(n, word) {
    return n + ' ' + word + (n > 1 ? 's' : '');
  }

  function matchesModule(change) {
    return activeModule === 'all' || change.module === activeModule;
  }

  function matchesType(change, type) {
    return type === 'all' || change.type === type;
  }

  /** Modifications retenues par les deux filtres (`type` permet de compter un onglet sans le sélectionner). */
  function visibleChanges(entry, type) {
    return entry.changes.filter(function (c) { return matchesModule(c) && matchesType(c, type === undefined ? activeType : type); });
  }

  function countVisible(type) {
    return shownEntries().reduce(function (n, entry) { return n + visibleChanges(entry, type).length; }, 0);
  }

  /** Modules présents dans le changelog, avec leur nombre de modifications, triés par libellé (« Général » en tête). */
  function moduleList() {
    var map = {};
    shownEntries().forEach(function (entry) {
      entry.changes.forEach(function (c) {
        if (!map[c.module]) map[c.module] = { key: c.module, label: c.moduleLabel, count: 0 };
        map[c.module].count += 1;
      });
    });
    return Object.keys(map)
      .map(function (key) { return map[key]; })
      .sort(function (a, b) {
        if (a.key === 'core') return -1;
        if (b.key === 'core') return 1;
        return a.label.localeCompare(b.label, 'fr');
      });
  }

  function setModule(key) {
    activeModule = key;
    syncUrl();
    // Une catégorie sans modification pour ce module n'a plus d'onglet : retour à « Tout ».
    if (activeType !== 'all' && !countVisible(activeType)) activeType = 'all';
    renderAll();
  }

  function renderModuleFilter() {
    var modules = moduleList();
    if (activeModule !== 'all' && !modules.some(function (m) { return m.key === activeModule; })) activeModule = 'all';
    var total = modules.reduce(function (n, m) { return n + m.count; }, 0);
    var select = el(
      'select',
      { id: 'f-module', 'aria-label': 'Filtrer par module' },
      el('option', { value: 'all', text: 'Tous les modules (' + total + ')' }),
      modules.map(function (m) { return el('option', { value: m.key, text: m.label + ' (' + m.count + ')' }); }),
    );
    select.value = activeModule;
    select.addEventListener('change', function () { setModule(select.value); });

    if (activeVersion !== 'all' && !data.entries.some(function (e) { return e.version === activeVersion; })) activeVersion = 'all';
    var versionSelect = el(
      'select',
      { id: 'f-version', 'aria-label': 'Choisir une version' },
      el('option', { value: 'all', text: 'Toutes les versions (' + data.entries.length + ')' }),
      versionOptions(),
    );
    versionSelect.value = activeVersion;
    versionSelect.addEventListener('change', function () { setVersion(versionSelect.value); });

    // Uniquement des éléments (jamais null) : Node.append(null) afficherait le texte « null ».
    var nodes = [
      el('label', { class: 'field' }, el('span', { text: 'Version' }), versionSelect),
      el('label', { class: 'field' }, el('span', { text: 'Module' }), select),
    ];
    if (activeModule !== 'all' || activeVersion !== 'all') {
      nodes.push(el('button', {
        type: 'button',
        class: 'btn btn-ghost btn-small',
        text: '✕ Réinitialiser les filtres',
        onclick: function () {
          activeModule = 'all';
          setVersion('all');
        },
      }));
    }
    nodes.push(el('span', { class: 'status-line', text: plural(countVisible(), 'modification') + ' affichée' + (countVisible() > 1 ? 's' : '') }));
    Core.clear(document.getElementById('module-filter')).append.apply(document.getElementById('module-filter'), nodes);
    document.getElementById('module-filter').hidden = false;
  }

  function renderTypeFilter() {
    var nav = Core.clear(document.getElementById('type-filter'));
    var types = [['all', '📋', 'Tout']].concat(
      Object.keys(data.types).map(function (key) { return [key, data.types[key].emoji, data.types[key].label]; }),
    );
    types.forEach(function (t) {
      var count = countVisible(t[0]);
      if (!count && t[0] !== 'all') return;
      nav.append(
        el(
          'button',
          {
            type: 'button',
            class: 'tab-btn',
            role: 'tab',
            'aria-selected': String(activeType === t[0]),
            onclick: function () {
              activeType = t[0];
              renderAll();
            },
          },
          t[1] + ' ' + t[2],
          el('span', { class: 'count', text: String(count) }),
        ),
      );
    });
    nav.hidden = false;
  }

  function releaseEl(entry, index) {
    var shown = visibleChanges(entry);
    if (!shown.length) return null;
    var groups = Object.keys(data.types)
      .map(function (type) {
        var changes = shown.filter(function (c) { return c.type === type; });
        if (!changes.length) return null;
        var meta = data.types[type];
        return el(
          'div',
          { class: 'release-group' },
          el('h3', {}, meta.emoji + ' ' + meta.label, el('span', { class: 'muted', text: '(' + changes.length + ')' })),
          el(
            'ul',
            { class: 'release-list' },
            changes.map(function (c) {
              // Étiquette cliquable : filtre sur ce module (re-clic sur le module actif = tous les modules).
              var tag = el('button', {
                type: 'button',
                class: 'module-tag' + (activeModule === c.module ? ' active' : ''),
                text: c.moduleLabel,
                title: activeModule === c.module ? 'Afficher tous les modules' : 'Voir uniquement : ' + c.moduleLabel,
                onclick: function () { setModule(activeModule === c.module ? 'all' : c.module); },
              });
              return el('li', {}, tag, el('span', { text: c.text }));
            }),
          ),
        );
      })
      .filter(Boolean);

    var filtered = shown.length !== entry.changes.length;
    // Modules concernés par cette version (toutes ses modifications), cliquables comme les étiquettes des lignes.
    var seen = {};
    var modules = entry.changes.filter(function (c) {
      if (seen[c.module]) return false;
      seen[c.module] = true;
      return true;
    });
    var moduleTags = el(
      'div',
      { class: 'release-modules' },
      modules.map(function (c) {
        return el('button', {
          type: 'button',
          class: 'module-tag' + (activeModule === c.module ? ' active' : ''),
          text: c.moduleLabel,
          title: activeModule === c.module ? 'Afficher tous les modules' : 'Voir uniquement : ' + c.moduleLabel,
          onclick: function () { setModule(activeModule === c.module ? 'all' : c.module); },
        });
      }),
    );
    return el(
      'article',
      { class: 'card release', id: 'v' + entry.version },
      el(
        'div',
        { class: 'release-head' },
        el('h2', {}, el('span', { class: 'release-version', text: 'v' + entry.version }), entry.title ? ' — ' + entry.title : ''),
        index === 0 ? el('span', { class: 'badge', text: 'Dernière version' }) : null,
      ),
      el('div', {
        class: 'release-meta',
        text: [formatDate(entry.date), filtered ? shown.length + ' sur ' + plural(entry.changes.length, 'modification') : plural(entry.changes.length, 'modification')]
          .filter(Boolean)
          .join(' · '),
      }),
      moduleTags,
      groups,
    );
  }

  function renderReleases() {
    var host = Core.clear(document.getElementById('releases'));
    var cards = shownEntries().map(function (entry) { return releaseEl(entry, data.entries.indexOf(entry)); }).filter(Boolean);
    if (!cards.length) host.append(el('div', { class: 'card empty', text: 'Aucune modification ne correspond à ces filtres.' }));
    else host.append.apply(host, cards);
  }

  function renderAll() {
    renderModuleFilter();
    renderTypeFilter();
    renderReleases();
  }

  async function start() {
    try {
      await Core.ready;
      data = await Core.api('/api/changelog');
      if (!data.entries.length) {
        document.getElementById('releases').append(el('div', { class: 'card empty', text: 'Aucun changelog disponible (changelog.json absent ou invalide).' }));
        return;
      }
      renderAll();
      // Lien direct depuis Discord (/changelog → « Changelog complet ») : aller à la version demandée.
      if (window.location.hash) {
        var target = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
        if (target) target.scrollIntoView({ block: 'start' });
      }
    } catch (err) {
      var box = document.getElementById('error');
      box.textContent = err.message;
      box.hidden = false;
    }
  }

  start();
})();
