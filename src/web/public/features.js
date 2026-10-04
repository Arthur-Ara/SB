/* Page « Fonctionnalités » : modules, commandes (lues dans les définitions des slash commands) et fonctionnalités. */
(function () {
  'use strict';

  var el = Core.el;
  var data = null;

  function showError(message) {
    var box = document.getElementById('error');
    box.textContent = message || '';
    box.hidden = !message;
  }

  /** « <option> » obligatoire, « [option] » facultative, comme dans /help. */
  function usage(options) {
    return (options || []).map(function (o) { return o.required ? '<' + o.name + '>' : '[' + o.name + ']'; }).join(' ');
  }

  function commandLines(command) {
    if (command.subcommands.length) {
      return command.subcommands.map(function (sub) {
        return { usage: '/' + command.name + ' ' + sub.name + (sub.options.length ? ' ' + usage(sub.options) : ''), description: sub.description };
      });
    }
    return [{ usage: '/' + command.name + (command.options.length ? ' ' + usage(command.options) : ''), description: command.description }];
  }

  function matches(entry, term) {
    if (!term) return true;
    var text = [entry.label, entry.description].concat(entry.features).concat(entry.commands.map(function (c) {
      return [c.name, c.description].concat(c.subcommands.map(function (s) { return s.name + ' ' + s.description; })).join(' ');
    })).join(' ').toLowerCase();
    return text.indexOf(term) !== -1;
  }

  function badges(entry) {
    var list = [];
    if (entry.core) list.push(el('span', { class: 'badge-status on', text: 'Toujours actif' }));
    else if (entry.required) list.push(el('span', { class: 'badge-status on', text: '🔒 Toujours actif' }));
    else list.push(el('span', { class: 'badge-status' + (entry.defaultEnabled ? ' on' : ''), text: entry.defaultEnabled ? 'Activé par défaut' : 'À activer avec /modules' }));
    if (entry.loaded === false) list.push(el('span', { class: 'badge-status warn', text: 'Désactivé sur ce bot' }));
    list.push(el('span', { class: 'badge-status', text: entry.commands.length + ' commande' + (entry.commands.length > 1 ? 's' : '') }));
    if (entry.web) list.push(el('a', { class: 'badge-status', href: entry.web, text: '🌐 Panel web' }));
    return list;
  }

  function moduleCard(entry) {
    var commands = entry.commands.map(function (command) {
      return el(
        'details',
        { class: 'feature-command' },
        el('summary', {}, el('code', { text: '/' + command.name }), ' — ' + command.description, command.ownerOnly ? el('span', { class: 'badge-status warn', text: 'propriétaires' }) : null),
        el('ul', {}, commandLines(command).map(function (line) { return el('li', {}, el('code', { text: line.usage }), line.description ? ' — ' + line.description : null); })),
      );
    });
    return el(
      'section',
      { class: 'card feature-card', id: 'module-' + entry.name },
      el('div', { class: 'feature-head' }, el('h2', { text: (entry.emoji ? entry.emoji + ' ' : '') + entry.label }), el('div', { class: 'section-actions' }, badges(entry))),
      entry.description ? el('p', { class: 'muted', text: entry.description }) : null,
      entry.features.length ? el('ul', { class: 'feature-list' }, entry.features.map(function (f) { return el('li', { text: f }); })) : null,
      commands.length ? el('div', { class: 'stack' }, el('h3', { class: 'section-title', text: 'Commandes' }), commands) : el('p', { class: 'muted', text: 'Aucune commande : tout se règle sur le panel web.' }),
    );
  }

  function render() {
    var term = document.getElementById('search').value.trim().toLowerCase();
    var entries = [data.core].concat(data.modules).filter(function (entry) { return matches(entry, term); });
    Core.clear(document.getElementById('index')).append.apply(
      document.getElementById('index'),
      entries.map(function (entry) { return el('a', { class: 'badge-status', href: '#module-' + entry.name, text: (entry.emoji ? entry.emoji + ' ' : '') + entry.label }); }),
    );
    var box = Core.clear(document.getElementById('modules'));
    if (!entries.length) box.append(el('div', { class: 'card empty', text: 'Aucun module ne correspond.' }));
    entries.forEach(function (entry) { box.append(moduleCard(entry)); });
    // Recherche sur une commande : ses détails sont dépliés.
    if (term) box.querySelectorAll('details').forEach(function (d) { if (d.textContent.toLowerCase().indexOf(term) !== -1) d.open = true; });
  }

  async function start() {
    try {
      await Core.ready;
      data = await Core.request('GET', '/api/features');
      data.core = Object.assign({ name: 'core', core: true, web: null }, data.core);
      var commands = [data.core].concat(data.modules).reduce(function (n, m) { return n + m.commands.length; }, 0);
      document.getElementById('summary').textContent = 'SciensBot v' + data.version + ' · ' + data.modules.length + ' modules · ' + commands + ' commandes. Sur Discord : /help.';
      document.getElementById('search').addEventListener('input', render);
      render();
    } catch (err) {
      showError(err.message);
    }
  }

  start();
})();
