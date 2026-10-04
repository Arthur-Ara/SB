/* Panel web du module Permissions : règles de commandes (rôles, utilisateurs), commandes publiques, accès au panel web,
   accords temporaires, modèles, copie de rôle et diagnostic d'accès. */
(function () {
  'use strict';

  var el = Core.el;
  var API = '/m/permissions/api';
  var main = document.getElementById('main');
  var guildId = '';
  var data = null;
  var activeTab = 'roles';

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

  function button(text, cls, onclick) {
    return el('button', { type: 'button', class: 'btn btn-small ' + (cls || ''), text: text, onclick: onclick });
  }

  function selected(select) {
    return Array.prototype.map.call(select.selectedOptions, function (option) { return option.value; });
  }

  // ── Affichage groupé ──────────────────────────────────────────────────────

  /** Module d'un joker « module.* » (toutes les commandes du module), ou null pour une commande. */
  function wildcardModule(name) {
    return /\.\*$/.test(name) ? name.slice(0, -2) : null;
  }

  function moduleOf(name) {
    var module = wildcardModule(name);
    var command = data.commands.find(function (c) { return module ? c.module === module : c.name === name; });
    return command ? command.moduleLabel : 'Autres';
  }

  /** Badge « ⏳ jusqu’au … » d'un accord temporaire. */
  function expiryBadge(date) {
    return date ? el('span', { class: 'expiry', title: 'Accord temporaire : retiré automatiquement à cette date', text: '⏳ ' + Core.fmt.dateTime(date) }) : null;
  }

  /** Une ligne par module (catégorie) : « ✅ Modération : /ban ×, /kick × », commandes séparées par une virgule. */
  function ruleLines(icon, names, onRemove, expiring) {
    var groups = {};
    expiring = expiring || {};
    names.forEach(function (name) { (groups[moduleOf(name)] = groups[moduleOf(name)] || []).push(name); });
    return Object.keys(groups).sort().map(function (label) {
      var chips = [];
      groups[label].forEach(function (name, index) {
        if (index) chips.push(', ');
        chips.push(
          el(
            'span',
            { class: 'chip' },
            el('code', { text: wildcardModule(name) ? name + ' (toutes les commandes)' : '/' + name }),
            expiryBadge(expiring[name]),
            onRemove ? el('button', { type: 'button', class: 'chip-x', title: 'Retirer cette règle', text: '×', onclick: function () { onRemove(name); } }) : null,
          ),
        );
      });
      return el('div', { class: 'rule-line' }, icon + ' ', el('strong', { text: label }), ' : ', chips);
    });
  }

  function personEl(person) {
    return el('span', { class: 'person' }, person.avatar ? el('img', { src: person.avatar, alt: '', loading: 'lazy' }) : null, el('span', { text: person.name, title: person.username ? '@' + person.username : person.id }));
  }

  function targetCard(head, rule, kind, targetId) {
    function clear(name) {
      refresh(call('POST', '/rules' + query(), { kind: kind, targetId: targetId, commands: [name], mode: 'clear' }));
    }
    return el(
      'section',
      { class: 'card target-card' },
      head,
      ruleLines('✅', rule.allowed, clear, rule.expiring),
      ruleLines('⛔', rule.denied, clear, rule.expiring),
    );
  }

  /**
   * Sélecteur multiple des commandes, groupées par module, avec en tête de chaque module le joker « module.* »
   * (toutes ses commandes, y compris les futures). `keep(nom)` écarte ce qui n'a pas lieu d'être proposé.
   */
  function commandSelect(keep) {
    var select = el('select', { multiple: true, size: '10', 'aria-label': 'Commandes' });
    var groups = {};
    data.commands.forEach(function (c) { (groups[c.moduleLabel] = groups[c.moduleLabel] || []).push(c); });
    Object.keys(groups).sort().forEach(function (label) {
      var wildcard = groups[label][0].module + '.*';
      var options = [];
      if (keep(wildcard)) options.push(el('option', { value: wildcard, text: '📦 ' + wildcard + ' — toutes les commandes du module' }));
      groups[label].forEach(function (c) {
        if (keep(c.name)) options.push(el('option', { value: c.name, text: '/' + c.name + ' — ' + c.description }));
      });
      if (options.length) select.append(el('optgroup', { label: label }, options));
    });
    if (!select.options.length) select.append(el('option', { disabled: true, text: 'Rien à proposer pour cette cible et cette action.' }));
    return select;
  }

  function ruleForm(host, kind, targetControl, readTarget) {
    var mode = el('select', {}, el('option', { value: 'allow', text: '✅ Autoriser' }), el('option', { value: 'deny', text: '⛔ Interdire' }), el('option', { value: 'clear', text: '↩️ Retirer la règle' }));
    var duration = durationInput();
    var commandsHost = el('div', { class: 'command-picker' });
    var commands = null;

    /**
     * Les commandes déjà dans l'état demandé pour cette cible ne sont pas proposées (déjà autorisées pour
     * « Autoriser », déjà interdites pour « Interdire ») ; « Retirer la règle » ne propose que celles qui en ont une.
     */
    function rebuild() {
      var targetId = readTarget();
      var list = kind === 'role' ? data.roleRules : data.userRules;
      var rule = list.find(function (r) { return r.id === targetId; }) || { allowed: [], denied: [] };
      var allowed = new Set(rule.allowed);
      var denied = new Set(rule.denied);
      var keep =
        mode.value === 'allow'
          ? function (name) { return !allowed.has(name); }
          : mode.value === 'deny'
            ? function (name) { return !denied.has(name); }
            : function (name) { return allowed.has(name) || denied.has(name); };
      commands = commandSelect(keep);
      Core.clear(commandsHost).append(commands);
    }

    mode.addEventListener('change', function () {
      duration.disabled = mode.value !== 'allow';
      if (duration.disabled) duration.value = '';
      rebuild();
    });
    targetControl.addEventListener(targetControl.tagName === 'SELECT' ? 'change' : 'input', rebuild);
    rebuild();
    var apply = button('Appliquer', 'btn-primary', function () {
      var targetId = readTarget();
      if (!targetId) return showError(kind === 'role' ? 'Choisis un rôle.' : 'Saisis l’ID Discord de l’utilisateur (17 à 20 chiffres).');
      var names = selected(commands);
      if (!names.length) return showError('Choisis au moins une commande (Ctrl/Cmd + clic pour en choisir plusieurs).');
      apply.disabled = true;
      refresh(call('POST', '/rules' + query(), { kind: kind, targetId: targetId, commands: names, mode: mode.value, duration: duration.value.trim() || null })).finally(function () { apply.disabled = false; });
    });
    Core.clear(host).append(
      el('div', { class: 'filters' },
        el('label', { class: 'field' }, el('span', { text: kind === 'role' ? 'Rôle' : 'Utilisateur (ID Discord)' }), targetControl),
        el('label', { class: 'field' }, el('span', { text: 'Commandes (plusieurs possibles)' }), commandsHost),
        el('label', { class: 'field' }, el('span', { text: 'Action' }), mode),
        el('label', { class: 'field' }, el('span', { text: 'Durée (autorisation temporaire)' }), duration),
        apply,
      ),
    );
  }

  function durationInput() {
    return el('input', { type: 'text', maxlength: '20', placeholder: 'permanent', title: 'Vide : permanent. Sinon 2h, 3j, 2sem… (1 an max) : retiré automatiquement à l’échéance.' });
  }

  function roleSelect(withEveryone) {
    return el(
      'select',
      {},
      data.roles
        .filter(function (role) { return withEveryone || role.id !== data.guild.id; })
        .map(function (role) { return el('option', { value: role.id, text: role.name }); }),
    );
  }

  // ── Onglets ───────────────────────────────────────────────────────────────

  function renderRoleRules() {
    var host = Core.clear(document.getElementById('role-rules'));
    var rules = data.roleRules.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    if (!rules.length) host.append(el('div', { class: 'card empty', text: 'Aucune règle de rôle : les accès par défaut s’appliquent.' }));
    rules.forEach(function (rule) {
      var swatch = el('span', { class: 'swatch' });
      if (rule.color) swatch.style.background = rule.color;
      host.append(targetCard(el('div', { class: 'target-head' }, swatch, el('span', { text: rule.name })), rule, 'role', rule.id));
    });

    var roleSelect = el('select', {}, data.roles.map(function (role) { return el('option', { value: role.id, text: role.name }); }));
    ruleForm(document.getElementById('role-form'), 'role', roleSelect, function () { return roleSelect.value; });
  }

  function renderUserRules() {
    var host = Core.clear(document.getElementById('user-rules'));
    if (!data.userRules.length) host.append(el('div', { class: 'card empty', text: 'Aucune règle individuelle.' }));
    data.userRules.forEach(function (rule) {
      host.append(targetCard(el('div', { class: 'target-head' }, personEl(rule.person), el('code', { text: rule.id })), rule, 'user', rule.id));
    });

    var idInput = el('input', { inputmode: 'numeric', maxlength: '20', placeholder: '123456789012345678' });
    ruleForm(document.getElementById('user-form'), 'user', idInput, function () {
      var value = idInput.value.trim();
      return /^\d{17,20}$/.test(value) ? value : '';
    });
  }

  function renderPublic() {
    var chips = [];
    data.publics.forEach(function (name, index) {
      if (index) chips.push(', ');
      chips.push(
        el('span', { class: 'chip' }, el('code', { text: '/' + name }), el('button', {
          type: 'button',
          class: 'chip-x',
          title: 'Ne plus rendre publique',
          text: '×',
          onclick: function () { refresh(call('POST', '/public' + query(), { command: name, public: false })); },
        })),
      );
    });
    var candidates = data.commands.filter(function (c) { return data.publics.indexOf(c.name) === -1; });
    var select = el('select', {}, candidates.map(function (c) { return el('option', { value: c.name, text: '/' + c.name + ' — ' + c.moduleLabel }); }));
    var add = button('Rendre publique', 'btn-primary', function () {
      if (!select.value) return;
      add.disabled = true;
      refresh(call('POST', '/public' + query(), { command: select.value, public: true })).finally(function () { add.disabled = false; });
    });
    Core.clear(document.getElementById('public-card')).append(
      el('div', { class: 'target-card' },
        data.publics.length ? el('div', { class: 'rule-line' }, '🌍 ', chips) : el('div', { class: 'muted', text: 'Aucune commande publique.' }),
        el('div', { class: 'filters' }, el('label', { class: 'field' }, el('span', { text: 'Commande' }), select), add),
      ),
    );
  }

  function renderWebGrants() {
    var host = Core.clear(document.getElementById('web-grants'));
    if (!data.webGrants.length) host.append(el('div', { class: 'card empty', text: 'Aucune restriction : tout compte autorisé du dashboard a accès à tout.' }));
    data.webGrants.forEach(function (grant) {
      var swatch = el('span', { class: 'swatch' });
      if (grant.color) swatch.style.background = grant.color;
      var lines = grant.entries.map(function (entry) {
        var chips = [];
        entry.rights.forEach(function (right, index) {
          if (index) chips.push(', ');
          chips.push(
            el('span', { class: 'chip' }, right.label, expiryBadge(right.expiresAt), el('button', {
              type: 'button',
              class: 'chip-x',
              title: 'Retirer ce droit',
              text: '×',
              onclick: function () {
                refresh(call('POST', '/web-grants' + query(), { roleId: grant.roleId, category: entry.category, rights: right.key === '' ? [] : [right.key], mode: 'revoke' }));
              },
            })),
          );
        });
        return el('div', { class: 'rule-line' }, '📂 ', el('strong', { text: entry.categoryLabel }), ' : ', chips);
      });
      host.append(el('section', { class: 'card target-card' }, el('div', { class: 'target-head' }, swatch, el('span', { text: grant.roleName })), lines));
    });

    var role = el('select', {}, data.roles.map(function (r) { return el('option', { value: r.id, text: r.name }); }));
    var category = el('select', {}, data.webCategories.map(function (c) { return el('option', { value: c.key, text: c.label }); }));
    var rights = el('select', { multiple: true, size: '6', 'aria-label': 'Droits' });
    /** Droits de la catégorie encore non accordés à ce rôle (ceux déjà donnés ne sont pas reproposés). */
    function renderRights() {
      Core.clear(rights);
      var current = data.webCategories.find(function (c) { return c.key === category.value; });
      var grant = data.webGrants.find(function (g) { return g.roleId === role.value; });
      var entry = grant ? grant.entries.find(function (e) { return e.category === category.value; }) : null;
      var granted = new Set(entry ? entry.rights.map(function (r) { return r.key; }) : []);
      if (granted.has('')) {
        rights.append(el('option', { disabled: true, text: 'Tous les droits de cette catégorie sont déjà accordés à ce rôle.' }));
        return;
      }
      var remaining = (current ? current.rights : []).filter(function (r) { return !granted.has(r.key); });
      remaining.forEach(function (r) { rights.append(el('option', { value: r.key, text: r.label })); });
      if (!remaining.length) rights.append(el('option', { disabled: true, text: 'Tous les droits sont déjà accordés (un par un) à ce rôle.' }));
    }
    category.addEventListener('change', renderRights);
    role.addEventListener('change', renderRights);
    renderRights();

    var duration = durationInput();
    function send(mode) {
      return function () {
        refresh(call('POST', '/web-grants' + query(), { roleId: role.value, category: category.value, rights: selected(rights), mode: mode, duration: mode === 'grant' ? duration.value.trim() || null : null }));
      };
    }
    Core.clear(document.getElementById('web-form')).append(
      el('div', { class: 'filters' },
        el('label', { class: 'field' }, el('span', { text: 'Rôle' }), role),
        el('label', { class: 'field' }, el('span', { text: 'Catégorie' }), category),
        el('label', { class: 'field' }, el('span', { text: 'Droits (aucun = tous les droits de la catégorie)' }), rights),
        el('label', { class: 'field' }, el('span', { text: 'Durée (accès temporaire)' }), duration),
        button('Accorder', 'btn-primary', send('grant')),
        button('Retirer', 'btn-danger', send('revoke')),
      ),
    );
  }

  // ── Modèles et copie ──────────────────────────────────────────────────────

  function renderTemplates() {
    var host = Core.clear(document.getElementById('templates-list'));
    if (!data.templates.length) host.append(el('div', { class: 'card empty', text: 'Aucun modèle : crée-en un ci-dessous à partir des règles d’un rôle.' }));
    data.templates.forEach(function (template) {
      var target = roleSelect(true);
      var replace = el('input', { type: 'checkbox' });
      host.append(
        el(
          'section',
          { class: 'card target-card' },
          el('div', { class: 'target-head' }, el('strong', { text: '📋 ' + template.name }), template.description ? el('span', { class: 'muted', text: template.description }) : null),
          ruleLines('✅', template.allowed, null),
          ruleLines('⛔', template.denied, null),
          template.web.length ? el('div', { class: 'rule-line' }, '📂 ', template.web.map(function (w) { return w.label; }).join(', ')) : null,
          el(
            'div',
            { class: 'filters' },
            el('label', { class: 'field' }, el('span', { text: 'Appliquer au rôle' }), target),
            el('label', { class: 'check' }, replace, el('span', { text: 'Remplacer ses règles actuelles' })),
            button('Appliquer', 'btn-primary', function () {
              refresh(call('POST', '/templates/' + template.id + '/apply' + query(), { roleId: target.value, replace: replace.checked }));
            }),
            button('Supprimer le modèle', 'btn-danger', function () {
              Core.confirm('Supprimer le modèle « ' + template.name + ' » ? Les rôles où il a été appliqué gardent leurs règles.', { confirmLabel: 'Supprimer' }).then(function (ok) {
                if (ok) refresh(call('DELETE', '/templates/' + template.id + query()));
              });
            }),
          ),
        ),
      );
    });

    var name = el('input', { type: 'text', maxlength: '50', placeholder: 'Ex. Modérateur' });
    var description = el('input', { type: 'text', maxlength: '200', placeholder: 'Facultatif' });
    var source = roleSelect(true);
    Core.clear(document.getElementById('template-form')).append(
      el('div', { class: 'filters' },
        el('label', { class: 'field' }, el('span', { text: 'Nom du modèle' }), name),
        el('label', { class: 'field' }, el('span', { text: 'Rôle de référence' }), source),
        el('label', { class: 'field field-grow' }, el('span', { text: 'Description' }), description),
        button('Enregistrer le modèle', 'btn-primary', function () {
          if (!name.value.trim()) return showError('Donne un nom au modèle.');
          refresh(call('POST', '/templates' + query(), { name: name.value.trim(), roleId: source.value, description: description.value.trim() || null }));
        }),
      ),
    );

    var from = roleSelect(true);
    var to = roleSelect(true);
    var replaceClone = el('input', { type: 'checkbox' });
    Core.clear(document.getElementById('clone-form')).append(
      el('div', { class: 'filters' },
        el('label', { class: 'field' }, el('span', { text: 'Rôle source' }), from),
        el('label', { class: 'field' }, el('span', { text: 'Rôle cible' }), to),
        el('label', { class: 'check' }, replaceClone, el('span', { text: 'Remplacer les règles du rôle cible' })),
        button('Copier', 'btn-primary', function () {
          if (from.value === to.value) return showError('Choisis deux rôles différents.');
          refresh(call('POST', '/clone' + query(), { sourceId: from.value, targetId: to.value, replace: replaceClone.checked }));
        }),
      ),
    );
  }

  // ── Vérifier un accès ─────────────────────────────────────────────────────

  var lastCheck = null;

  function renderCheck() {
    var userInput = el('input', { inputmode: 'numeric', maxlength: '20', placeholder: 'ID Discord du membre', value: lastCheck ? lastCheck.userId : null });
    var command = el('select', { 'aria-label': 'Commande' }, data.commands.map(function (c) { return el('option', { value: c.name, text: '/' + c.name + ' — ' + c.moduleLabel }); }));
    if (lastCheck) command.value = lastCheck.command;
    var run = button('Vérifier', 'btn-primary', function () {
      var userId = userInput.value.trim();
      if (!/^\d{17,20}$/.test(userId)) return showError('ID Discord invalide (17 à 20 chiffres).');
      showError('');
      lastCheck = { userId: userId, command: command.value };
      call('POST', '/check' + query(), { userId: userId, command: command.value }).then(renderCheckResult).catch(function (err) { showError(err.message); });
    });
    Core.clear(document.getElementById('check-form')).append(
      el('div', { class: 'filters' },
        el('label', { class: 'field' }, el('span', { text: 'Membre' }), userInput),
        el('label', { class: 'field' }, el('span', { text: 'Commande' }), command),
        run,
      ),
    );
  }

  function renderCheckResult(result) {
    Core.clear(document.getElementById('check-result')).append(
      el(
        'section',
        { class: 'card target-card' },
        el('div', { class: 'target-head' }, personEl(result.person), el('code', { text: '/' + result.command }),
          el('span', { class: 'badge-status ' + (result.allowed ? 'on' : 'warn'), text: result.allowed ? 'Autorisé' : 'Refusé' })),
        el('div', { class: 'rule-line' }, (result.allowed ? '✅ ' : '⛔ ') + result.explanation),
        el('div', { class: 'rule-line muted', text: 'Décidé par : ' + result.source + ' · accès par défaut : ' + (result.defaultAccess === 'everyone' ? 'tout le monde' : 'administrateurs') }),
        result.moduleEnabled ? null : el('div', { class: 'rule-line', text: '⚠️ Le module ' + result.moduleLabel + ' est désactivé sur ce serveur : la commande est refusée à tous.' }),
        result.roleRules.length
          ? el('div', { class: 'rule-line' }, el('strong', { text: 'Règles de ses rôles : ' }), result.roleRules.map(function (rule, index) {
              return [index ? ', ' : '', (rule.allowed ? '✅ ' : '⛔ ') + rule.role, expiryBadge(rule.expiresAt)];
            }))
          : null,
      ),
    );
  }

  function renderAll() {
    renderRoleRules();
    renderUserRules();
    renderPublic();
    renderWebGrants();
    renderTemplates();
    renderCheck();
  }

  function setupTabs() {
    var buttons = [].slice.call(document.querySelectorAll('.tab-btn'));
    function activate(name) {
      activeTab = name;
      buttons.forEach(function (b) { b.classList.toggle('active', b.dataset.tab === name); });
      document.querySelectorAll('.tab-panel').forEach(function (panel) { panel.hidden = panel.id !== 'tab-' + name; });
    }
    buttons.forEach(function (b) { b.addEventListener('click', function () { activate(b.dataset.tab); }); });
    activate(activeTab);
  }

  async function loadGuild() {
    document.getElementById('content').hidden = true;
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
        guildId = select.value;
        loadGuild();
      });
      setupTabs();
      await loadGuild();
    } catch (err) {
      showError(err.message);
    }
  }

  start();
})();
