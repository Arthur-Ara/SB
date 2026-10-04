/* Utilitaires partagés par toutes les pages du dashboard (barre de navigation, API, formatage). */
(function () {
  'use strict';

  var Core = {};

  /** Crée un élément DOM. Les enfants texte passent par des nœuds texte (jamais innerHTML). */
  Core.el = function (tag, attrs) {
    var node = document.createElement(tag);
    var children = Array.prototype.slice.call(arguments, 2);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === undefined || value === null || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.slice(0, 2) === 'on' && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else if (value === true) node.setAttribute(key, '');
        else node.setAttribute(key, String(value));
      });
    }
    children.flat(Infinity).forEach(function (child) {
      if (child === undefined || child === null || child === false) return;
      node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return node;
  };

  Core.clear = function (node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  };

  /** Adresse de connexion qui ramène ensuite sur la page actuelle. */
  Core.loginUrl = function () {
    var here = window.location.pathname + window.location.search;
    return here === '/' || here.indexOf('/login') === 0 ? '/login' : '/login?next=' + encodeURIComponent(here);
  };

  /** Appel JSON (GET) vers l'API ; redirige vers la connexion si la session a expiré. */
  Core.api = function (url) {
    return Core.request('GET', url);
  };

  /**
   * Requête JSON quelconque (GET, POST, DELETE…) vers l'API d'un module, partagée par toutes les pages.
   * Session expirée : retour à la connexion. Erreur HTTP : exception avec le message renvoyé par le serveur.
   */
  Core.request = async function (method, url, body) {
    var response = await fetch(url, {
      method: method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (response.status === 401) {
      // Après reconnexion, retour sur la page en cours (et non sur l'accueil).
      window.location.href = Core.loginUrl();
      throw new Error('Session expirée');
    }
    var payload = null;
    try {
      payload = await response.json();
    } catch (e) {
      /* réponse vide */
    }
    if (!response.ok) throw new Error((payload && payload.error) || 'Erreur ' + response.status);
    return payload;
  };

  /**
   * Boîte de dialogue au style du dashboard (remplace prompt()/confirm() du navigateur).
   * options : { title, message, input: { placeholder, value, maxlength } | null,
   *             fields: [{ name, label, placeholder, value, maxlength }] | null, confirmLabel, danger }
   * Résout : texte saisi (ou null si annulé) avec `input`, objet { name: texte } (ou null) avec `fields`, sinon true/false.
   */
  Core.dialog = function (options) {
    return new Promise(function (resolve) {
      var input = options.input
        ? Core.el('input', { type: 'text', maxlength: options.input.maxlength || '512', placeholder: options.input.placeholder || '', value: options.input.value || null })
        : null;
      var fields = (options.fields || []).map(function (field) {
        return {
          name: field.name,
          input: Core.el('input', { type: 'text', maxlength: field.maxlength || '512', placeholder: field.placeholder || '', value: field.value || null }),
          label: field.label,
        };
      });
      var dialog = Core.el('dialog', { class: 'dialog' });
      var done = false;
      function finish(value) {
        if (done) return;
        done = true;
        if (dialog.open) dialog.close();
        dialog.remove();
        resolve(value);
      }
      var cancelValue = input || fields.length ? null : false;
      function collect() {
        if (input) return input.value.trim();
        if (!fields.length) return true;
        var values = {};
        fields.forEach(function (field) { values[field.name] = field.input.value.trim(); });
        return values;
      }
      var submit = Core.el('button', { type: 'submit', class: 'btn ' + (options.danger ? 'btn-danger' : 'btn-primary'), text: options.confirmLabel || 'Confirmer' });
      dialog.append(
        Core.el(
          'form',
          {
            onsubmit: function (event) {
              event.preventDefault();
              finish(collect());
            },
          },
          Core.el('h2', { text: options.title || 'Confirmation' }),
          options.message ? Core.el('p', { text: options.message }) : null,
          input,
          fields.map(function (field) {
            return Core.el('label', { class: 'field' }, Core.el('span', { text: field.label }), field.input);
          }),
          Core.el(
            'div',
            { class: 'dialog-actions' },
            Core.el('button', { type: 'button', class: 'btn btn-ghost', text: 'Annuler', onclick: function () { finish(cancelValue); } }),
            submit,
          ),
        ),
      );
      dialog.addEventListener('cancel', function (event) {
        event.preventDefault();
        finish(cancelValue);
      });
      document.body.append(dialog);
      dialog.showModal();
      (input || (fields[0] && fields[0].input) || submit).focus();
    });
  };

  /** Confirmation (Promise<boolean>) ; `danger` colore le bouton en rouge (action destructrice). */
  Core.confirm = function (message, options) {
    var opts = options || {};
    return Core.dialog({ title: opts.title || 'Confirmation', message: message, confirmLabel: opts.confirmLabel, danger: opts.danger !== false });
  };

  /** Saisie d'un texte (Promise<string|null>, null si annulé). */
  Core.prompt = function (message, options) {
    var opts = options || {};
    return Core.dialog({ title: opts.title || message, message: opts.title ? message : null, input: { placeholder: opts.placeholder || '', maxlength: opts.maxlength }, confirmLabel: opts.confirmLabel || 'Valider' });
  };

  /**
   * Sélecteur de rôles avec recherche : liste défilante (rôles déjà triés dans l'ordre Discord), filtrable par nom,
   * rôles choisis rappelés en puces au-dessus (retrait en un clic). Modifie `selectedIds` en place, puis appelle
   * `onChange`. `roles` : [{ id, name, color }].
   */
  Core.rolePicker = function (roles, selectedIds, onChange) {
    var el = Core.el;
    onChange = onChange || function () {};
    if (!roles.length) return el('div', { class: 'empty', text: 'Aucun rôle configurable sur ce serveur.' });

    var search = el('input', { type: 'text', placeholder: 'Rechercher un rôle…', class: 'role-picker-search' });
    var list = el('div', { class: 'role-picker-list' });
    var chips = el('div', { class: 'role-picker-chips' });

    function toggle(id, on) {
      var index = selectedIds.indexOf(id);
      if (on && index === -1) selectedIds.push(id);
      else if (!on && index !== -1) selectedIds.splice(index, 1);
      onChange();
    }

    function renderChips() {
      Core.clear(chips);
      if (!selectedIds.length) {
        chips.append(el('span', { class: 'muted', text: 'Aucun rôle sélectionné.' }));
        return;
      }
      selectedIds.forEach(function (id) {
        var role = roles.find(function (r) { return r.id === id; });
        chips.append(
          el('span', { class: 'role-chip' }, role ? role.name : id, el('button', {
            type: 'button',
            'aria-label': 'Retirer',
            text: '✕',
            onclick: function () { toggle(id, false); renderChips(); renderList(); },
          })),
        );
      });
    }

    function renderList() {
      var term = search.value.trim().toLowerCase();
      var matches = roles.filter(function (role) { return !term || role.name.toLowerCase().indexOf(term) !== -1; });
      Core.clear(list);
      if (!matches.length) {
        list.append(el('div', { class: 'empty', text: 'Aucun rôle ne correspond.' }));
        return;
      }
      matches.forEach(function (role) {
        var check = el('input', { type: 'checkbox', onchange: function () { toggle(role.id, check.checked); renderChips(); } });
        check.checked = selectedIds.indexOf(role.id) !== -1;
        list.append(el('label', { class: 'role-picker-row' }, check, el('span', { style: role.color ? 'color:' + role.color : null, text: role.name })));
      });
    }

    search.addEventListener('input', renderList);
    renderChips();
    renderList();
    return el('div', { class: 'role-picker' }, chips, search, list);
  };

  /** Lit un jeton CSS (couleur du thème courant). */
  Core.token = function (name) {
    return getComputedStyle(document.documentElement).getPropertyValue('--' + name).trim();
  };

  // ── Formatage ──────────────────────────────────────────────────────────
  var numberFmt = new Intl.NumberFormat('fr-FR');
  var decimalFmt = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
  var compactFmt = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });
  var dateFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' });
  var dateTimeFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

  Core.fmt = {
    number: function (value) {
      return value === null || value === undefined ? '—' : numberFmt.format(value);
    },
    decimal: function (value, digits) {
      if (value === null || value === undefined) return '—';
      if (digits === undefined) return decimalFmt.format(value);
      return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits }).format(value);
    },
    compact: function (value) {
      if (value === null || value === undefined) return '—';
      return Math.abs(value) >= 10000 ? compactFmt.format(value) : numberFmt.format(value);
    },
    percent: function (value) {
      if (value === null || value === undefined) return '—';
      return new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 1 }).format(value);
    },
    date: function (value) {
      return value ? dateFmt.format(new Date(value)) : '—';
    },
    dateTime: function (value) {
      return value ? dateTimeFmt.format(new Date(value)) : '—';
    },
    /** Durée lisible à partir de secondes : « 3 h 12 min », « 2 j 4 h »… */
    duration: function (seconds) {
      if (seconds === null || seconds === undefined) return '—';
      var s = Math.max(0, Math.round(seconds));
      if (s < 60) return s + ' s';
      var minutes = Math.floor(s / 60);
      if (minutes < 60) return minutes + ' min';
      var hours = Math.floor(minutes / 60);
      if (hours < 48) return hours + ' h ' + String(minutes % 60).padStart(2, '0') + ' min';
      var days = Math.floor(hours / 24);
      return numberFmt.format(days) + ' j ' + (hours % 24) + ' h';
    },
    /** Ancienneté en jours : « 1 an 3 mois », « 45 j »… */
    days: function (days) {
      if (days === null || days === undefined) return '—';
      var d = Math.max(0, Math.round(days));
      if (d < 60) return d + ' j';
      if (d < 730) return Math.floor(d / 30.44) + ' mois';
      var years = Math.floor(d / 365.25);
      var months = Math.floor((d - years * 365.25) / 30.44);
      return years + ' an' + (years > 1 ? 's' : '') + (months ? ' ' + months + ' mois' : '');
    },
  };

  // ── Thème (sombre par défaut, clair en option) ─────────────────────────
  Core.currentTheme = function () {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  };

  function setTheme(theme) {
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    try {
      localStorage.setItem('mtb-theme', theme);
    } catch (e) {
      /* stockage indisponible */
    }
    window.dispatchEvent(new CustomEvent('themechange'));
  }

  // ── Barre de navigation ────────────────────────────────────────────────
  function avatarOf(user) {
    if (user.avatar) return 'https://cdn.discordapp.com/avatars/' + user.id + '/' + user.avatar + '.png?size=64';
    var index = Number((BigInt(user.id) >> 22n) % 6n);
    return 'https://cdn.discordapp.com/embed/avatars/' + index + '.png';
  }

  // ── Notifications (tickets en attente, détections de l'automod, nouveaux rapports…) ──
  var SEEN_KEY = 'sciensbot.notifSeenAt';

  function seenAt() {
    try {
      return Number(window.localStorage.getItem(SEEN_KEY)) || 0;
    } catch (e) {
      return 0;
    }
  }

  function markSeen() {
    try {
      window.localStorage.setItem(SEEN_KEY, String(Date.now()));
    } catch (e) {
      /* stockage indisponible : le compteur reviendra au prochain chargement */
    }
  }

  /** Cloche de la barre du haut : compteur des nouveautés depuis la dernière ouverture, liste au clic. */
  function notificationBell() {
    var el = Core.el;
    var items = [];
    var count = el('span', { class: 'notif-count', hidden: true });
    var list = el('div', { class: 'notif-panel', hidden: true, role: 'dialog', 'aria-label': 'Notifications' });
    var button = el('button', { type: 'button', class: 'btn btn-ghost btn-small notif-button', title: 'Notifications', 'aria-label': 'Notifications', text: '🔔' }, count);

    function renderCount() {
      var unread = items.filter(function (item) { return new Date(item.at).getTime() > seenAt(); }).length;
      count.textContent = unread > 9 ? '9+' : String(unread);
      count.hidden = !unread;
    }

    function renderList() {
      Core.clear(list).append(
        el('div', { class: 'notif-head', text: 'Notifications' }),
        items.length
          ? items.map(function (item) {
              var unread = new Date(item.at).getTime() > seenAt();
              return el(
                'a',
                { class: 'notif-item' + (unread ? ' unread' : ''), href: item.href || '#' },
                el('span', { class: 'notif-text', text: (item.emoji ? item.emoji + ' ' : '') + item.text }),
                el('span', { class: 'notif-meta', text: [item.guildName, Core.fmt.dateTime(item.at)].filter(Boolean).join(' · ') }),
              );
            })
          : el('div', { class: 'notif-empty', text: 'Rien de nouveau.' }),
      );
    }

    function load() {
      if (document.hidden) return;
      Core.request('GET', '/api/notifications')
        .then(function (result) {
          items = Array.isArray(result) ? result : [];
          renderCount();
          if (!list.hidden) renderList();
        })
        .catch(function () { /* silencieux : nouvel essai à la prochaine minute */ });
    }

    button.addEventListener('click', function (event) {
      event.stopPropagation();
      list.hidden = !list.hidden;
      if (!list.hidden) {
        renderList();
        markSeen();
        renderCount();
      }
    });
    document.addEventListener('click', function (event) {
      if (!list.hidden && !list.contains(event.target)) list.hidden = true;
    });
    load();
    setInterval(load, 60000);
    return el('div', { class: 'notif' }, button, list);
  }

  /** `me` null = visiteur non connecté (page publique) : seul le changelog et la connexion sont proposés. */
  function renderTopbar(me, modules) {
    var bar = document.getElementById('topbar');
    if (!bar) return;
    var path = window.location.pathname;
    var themeButton = Core.el('button', {
      type: 'button',
      class: 'btn btn-ghost btn-small',
      title: 'Changer de thème',
      'aria-label': 'Changer de thème',
      onclick: function () {
        setTheme(Core.currentTheme() === 'dark' ? 'light' : 'dark');
        themeButton.textContent = Core.currentTheme() === 'dark' ? '☀' : '☾';
      },
      text: Core.currentTheme() === 'dark' ? '☀' : '☾',
    });

    // Sur téléphone, les modules passent dans un menu déroulant (☰) : une bande défilante est peu pratique au doigt.
    var menuButton = Core.el('button', {
      type: 'button',
      class: 'btn btn-ghost btn-small nav-toggle',
      'aria-label': 'Menu',
      'aria-expanded': 'false',
      text: '☰',
      onclick: function (event) {
        event.stopPropagation();
        var open = !bar.classList.contains('nav-open');
        bar.classList.toggle('nav-open', open);
        menuButton.setAttribute('aria-expanded', String(open));
        menuButton.textContent = open ? '✕' : '☰';
      },
    });
    document.addEventListener('click', function (event) {
      if (!bar.classList.contains('nav-open') || bar.contains(event.target)) return;
      bar.classList.remove('nav-open');
      menuButton.setAttribute('aria-expanded', 'false');
      menuButton.textContent = '☰';
    });

    Core.clear(bar).append(
      Core.el('a', { class: 'brand', href: '/' }, Core.el('span', { class: 'brand-mark', text: 'S' }), 'SciensBot'),
      menuButton,
      Core.el(
        'nav',
        { class: 'nav', 'aria-label': 'Modules' },
        me ? Core.el('a', { href: '/', 'aria-current': path === '/' ? 'page' : null, text: 'Accueil' }) : null,
        modules.map(function (module) {
          var active = path.indexOf(module.path) === 0 || path + '/' === module.path;
          return Core.el('a', { href: module.path, 'aria-current': active ? 'page' : null, text: module.label });
        }),
        Core.el('a', { href: '/features', 'aria-current': path === '/features' ? 'page' : null, text: 'Fonctionnalités' }),
        Core.el('a', { href: '/changelog', 'aria-current': path === '/changelog' ? 'page' : null, text: 'Changelog' }),
        me ? Core.el('a', { href: '/activity', 'aria-current': path === '/activity' ? 'page' : null, text: 'Activité' }) : null,
      ),
      me ? notificationBell() : Core.el('span', { hidden: true }),
      themeButton,
      me
        ? Core.el(
            'div',
            { class: 'user-chip' },
            Core.el('img', { src: avatarOf(me), alt: '' }),
            Core.el('span', { class: 'user-name', text: me.globalName || me.username }),
            Core.el(
              'form',
              { method: 'post', action: '/auth/logout' },
              Core.el('button', { type: 'submit', class: 'btn btn-ghost btn-small', text: 'Déconnexion' }),
            ),
          )
        : Core.el('a', { class: 'btn btn-primary btn-small', href: Core.loginUrl(), text: 'Se connecter' }),
    );
  }

  /**
   * Page publique (`<html data-public>`, ex. changelog) : consultable sans connexion. On demande la session sans
   * jamais être redirigé vers /login ; un visiteur non connecté obtient { me: null, modules: [] }.
   */
  var isPublicPage = document.documentElement.hasAttribute('data-public');

  function loadSession() {
    if (!isPublicPage) return Promise.all([Core.api('/api/me'), Core.api('/api/modules')]);
    return Core.request('GET', '/api/session').then(function (session) {
      if (!session.user) return [null, []];
      return Core.api('/api/modules').then(function (modules) { return [session.user, modules]; });
    });
  }

  Core.ready = loadSession().then(function (results) {
    var me = results[0];
    var modules = results[1];
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        renderTopbar(me, modules);
      });
    } else {
      renderTopbar(me, modules);
    }
    return { me: me, modules: modules };
  });

  window.Core = Core;
})();
