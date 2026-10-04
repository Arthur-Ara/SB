/* Journal d'activité du panel : propriétaires du bot = tous les comptes ; autres comptes = leurs propres actions. */
(function () {
  'use strict';

  var el = Core.el;
  var fmt = Core.fmt;
  var filters = { page: 1, user: '', module: '' };
  var ACTION_LABEL = { login: 'Connexion', logout: 'Déconnexion', POST: 'Action', PUT: 'Modification', PATCH: 'Modification', DELETE: 'Suppression' };

  function showError(message) {
    var box = document.getElementById('error');
    box.textContent = message || '';
    box.hidden = !message;
  }

  async function load() {
    var params = new URLSearchParams({ page: String(filters.page) });
    if (filters.user) params.set('user', filters.user);
    if (filters.module) params.set('module', filters.module);
    var main = document.getElementById('main');
    main.classList.add('is-loading');
    try {
      render(await Core.api('/api/activity?' + params.toString()));
      showError('');
    } catch (err) {
      showError(err.message);
    } finally {
      main.classList.remove('is-loading');
    }
  }

  function render(data) {
    document.getElementById('scope-line').textContent = data.isOwner
      ? 'Connexions et actions de tous les comptes du panel (90 derniers jours).'
      : 'Tes connexions et actions sur le panel (90 derniers jours).';
    var module = el('select', { 'aria-label': 'Module' }, el('option', { value: '', text: 'Tous les modules' }), data.modules.map(function (m) { return el('option', { value: m.key, text: m.label }); }));
    module.value = filters.module;
    var user = data.isOwner ? el('input', { inputmode: 'numeric', maxlength: '20', placeholder: 'ID du compte', value: filters.user || null }) : null;
    var rows = data.rows.map(function (r) {
      var failed = r.status && r.status >= 400;
      return el('tr', {},
        el('td', { text: fmt.dateTime(r.createdAt) }),
        el('td', {}, el('span', { text: r.username, title: r.userId })),
        el('td', {}, el('span', { class: 'badge-status' + (failed ? ' warn' : r.action === 'login' ? ' on' : ''), text: (ACTION_LABEL[r.action] || r.action) + (failed ? ' (refusée)' : '') })),
        el('td', { text: r.moduleLabel || '—' }),
        el('td', { text: r.guild || '—' }),
        el('td', {}, el('code', { text: r.path })),
      );
    });
    var pager = el('div', { class: 'hist-pager' },
      el('button', { type: 'button', class: 'btn btn-ghost btn-small', text: '❮ Précédent', disabled: data.page <= 1, onclick: function () { filters.page -= 1; load(); } }),
      'Page ' + data.page + ' / ' + data.pages + ' · ' + fmt.number(data.total) + ' entrée(s)',
      el('button', { type: 'button', class: 'btn btn-ghost btn-small', text: 'Suivant ❯', disabled: data.page >= data.pages, onclick: function () { filters.page += 1; load(); } }),
    );
    Core.clear(document.getElementById('activity-card')).append(
      el('form', {
        class: 'filters',
        onsubmit: function (event) {
          event.preventDefault();
          var id = user ? user.value.trim() : '';
          if (id && !/^\d{17,20}$/.test(id)) return showError('ID Discord invalide (17 à 20 chiffres).');
          filters = { page: 1, user: id, module: module.value };
          load();
        },
      },
        user ? el('label', { class: 'field' }, el('span', { text: 'Compte' }), user) : null,
        el('label', { class: 'field' }, el('span', { text: 'Module' }), module),
        el('button', { type: 'submit', class: 'btn btn-small', text: 'Filtrer' }),
      ),
      rows.length
        ? el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
            el('thead', {}, el('tr', {}, ['Date', 'Compte', 'Action', 'Module', 'Serveur', 'Adresse'].map(function (h) { return el('th', { text: h }); }))),
            el('tbody', {}, rows)))
        : el('div', { class: 'empty', text: 'Aucune activité enregistrée.' }),
      pager,
    );
  }

  Core.ready.then(load).catch(function (err) { showError(err.message); });
})();
