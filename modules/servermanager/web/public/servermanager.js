/* Panel web du Server Manager : rollback (aperçu, confirmation, suivi en direct), journal, historique,
   sauvegardes (création, restauration non destructive) et réglages. */
(function () {
  'use strict';

  var el = Core.el;
  var fmt = Core.fmt;
  var API = '/m/servermanager/api';
  var main = document.getElementById('main');
  var guildId = '';
  var state = null;
  var activeTab = 'rollback';
  var journalState = { page: 1, kind: '', executor: '' };

  var KIND_LABEL = { channel: 'Salon', role: 'Rôle', member_role: 'Rôle d’un membre', moderation: 'Modération' };
  var OP_LABEL = { create: 'création', update: 'modification', delete: 'suppression', add: 'ajout', remove: 'retrait' };
  var STATUS_LABEL = { ok: 'à annuler', skip: 'ignorée', done: 'annulée', failed: 'échec', cancelled: 'non exécutée', running: 'en cours', aborted: 'interrompu' };

  function byId(id) {
    return document.getElementById(id);
  }

  function showError(message) {
    var box = byId('error');
    box.textContent = message || '';
    box.hidden = !message;
  }

  function query(extra) {
    return '?guild=' + encodeURIComponent(guildId) + (extra ? '&' + extra : '');
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

  function personEl(person) {
    if (!person) return el('span', { class: 'muted', text: 'inconnu' });
    return el('span', { class: 'person' }, el('img', { src: person.avatar, alt: '', loading: 'lazy' }), el('span', { text: person.name }));
  }

  function table(columns, rows, emptyText) {
    if (!rows.length) return el('div', { class: 'empty', text: emptyText });
    return el(
      'div',
      { class: 'table-wrap' },
      el('table', { class: 'data' },
        el('thead', {}, el('tr', {}, columns.map(function (c) { return el('th', { text: c.label }); }))),
        el('tbody', {}, rows.map(function (row) {
          return el('tr', {}, columns.map(function (c) {
            var value = c.value(row);
            return el('td', {}, value === null || value === undefined ? '—' : value);
          }));
        })),
      ),
    );
  }

  function statusBadge(status) {
    var cls = status === 'done' || status === 'ok' ? 'on' : status === 'failed' || status === 'aborted' ? 'warn' : '';
    return el('span', { class: 'badge-status ' + cls, text: STATUS_LABEL[status] || status });
  }

  function tile(label, value, sub) {
    return el('div', { class: 'card tile' }, el('div', { class: 'tile-label', text: label }), el('div', { class: 'tile-value', text: value }), sub ? el('div', { class: 'tile-sub', text: sub }) : null);
  }

  // ── Suivi d'une tâche longue (rollback, restauration) ────────────────────
  function followJob(jobId, host, title, renderResult) {
    var bar = el('div', { class: 'progress' }, el('div', { class: 'progress-fill' }));
    var label = el('p', { class: 'muted', text: 'Démarrage…' });
    var stop = el('button', {
      type: 'button',
      class: 'btn btn-danger btn-small',
      text: '🛑 Arrêter',
      onclick: function () {
        stop.disabled = true;
        call('POST', '/jobs/' + jobId + '/stop').catch(function (err) { showError(err.message); });
      },
    });
    Core.clear(host).append(el('section', { class: 'card job-card' }, el('h3', { text: title }), bar, label, el('div', { class: 'filters' }, stop)));
    function poll() {
      call('GET', '/jobs/' + jobId)
        .then(function (job) {
          var p = job.progress || {};
          var pct = p.total ? Math.round((p.index / p.total) * 100) : 0;
          bar.firstChild.style.width = pct + '%';
          label.textContent = (p.total ? p.index + ' / ' + p.total : 'En cours…') + (p.label ? ' — ' + p.label : '');
          if (job.status === 'running') {
            setTimeout(poll, 1200);
            return;
          }
          if (job.result && job.result.error) {
            Core.clear(host);
            showError(job.result.error);
            return;
          }
          renderResult(job.result);
          loadState();
        })
        .catch(function (err) {
          showError(err.message);
        });
    }
    poll();
  }

  // ── Rollback ─────────────────────────────────────────────────────────────
  function renderTiles() {
    var s = state.settings;
    Core.clear(byId('tiles')).append(
      tile('Modifications journalisées', fmt.number(state.journal.count), state.journal.oldest ? 'depuis le ' + fmt.dateTime(state.journal.oldest) : null),
      tile('Couverture du journal', s.trackingSince ? fmt.date(s.trackingSince) : '—', 'conservation ' + state.limits.retentionDays + ' j'),
      tile('Période maximale', state.limits.maxWindow, state.limits.maxActions + ' actions max par rollback'),
      tile('Sauvegardes auto', s.backupEnabled ? 'toutes les ' + s.backupIntervalHours + ' h' : 'désactivées', s.lastBackupAt ? 'dernière : ' + fmt.dateTime(s.lastBackupAt) : null),
    );
  }

  function renderRollbackForm() {
    var scope = el('select', { 'aria-label': 'Type' }, state.scopes.map(function (s) { return el('option', { value: s.key, text: s.label }); }));
    var duration = el('input', { type: 'text', maxlength: '20', placeholder: '30m, 2h, 1d…' });
    var user = el('input', { inputmode: 'numeric', maxlength: '20', placeholder: 'facultatif' });
    var preview = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: '🔎 Voir l’aperçu',
      onclick: function () {
        if (!duration.value.trim()) return showError('Indique une durée (ex. 2h).');
        if (user.value.trim() && !/^\d{17,20}$/.test(user.value.trim())) return showError('ID Discord invalide (17 à 20 chiffres).');
        busy(call('POST', '/rollback/preview' + query(), { scope: scope.value, duration: duration.value.trim(), userId: user.value.trim() || null })).then(function (plan) {
          if (plan) renderRollbackPreview(plan);
        });
      },
    });
    Core.clear(byId('rollback-form')).append(
      el('p', { class: 'muted', style: 'padding:14px 14px 0;margin:0', text: 'Rien n’est modifié avant ta confirmation : l’aperçu montre exactement ce qui sera annulé, ce qui sera ignoré et pourquoi. Le plan est re-vérifié juste avant l’exécution.' }),
      el('div', { class: 'filters' },
        el('label', { class: 'field' }, el('span', { text: 'Type' }), scope),
        el('label', { class: 'field' }, el('span', { text: 'Remonter jusqu’à' }), duration),
        el('label', { class: 'field' }, el('span', { text: 'Seulement les actions de (ID)' }), user),
        preview,
      ),
    );
  }

  function itemsTable(items, emptyText) {
    return table(
      [
        { label: 'Action', value: function (i) { return el('span', {}, i.destructive ? '🗑️ ' : '', i.title); } },
        { label: 'Auteur', value: function (i) { return personEl(i.executor); } },
        { label: 'Quand', value: function (i) { return fmt.dateTime(i.at); } },
        { label: 'État', value: function (i) { return statusBadge(i.status); } },
        { label: 'Détail', value: function (i) { return i.reason || (i.notes.length ? i.notes.join(' · ') : null); } },
      ],
      items,
      emptyText,
    );
  }

  function renderRollbackPreview(plan) {
    var host = byId('rollback-preview');
    var ok = plan.items.filter(function (i) { return i.status === 'ok'; });
    var skipped = plan.items.filter(function (i) { return i.status !== 'ok'; });
    var codeInput = plan.sensitive ? el('input', { type: 'text', maxlength: '30', placeholder: plan.code }) : null;
    var execute = el('button', {
      type: 'button',
      class: 'btn ' + (plan.sensitive ? 'btn-danger' : 'btn-primary'),
      text: '⏪ Exécuter (' + plan.stats.ok + ')',
      disabled: !plan.stats.ok || plan.tooMany,
      onclick: function () {
        execute.disabled = true;
        busy(call('POST', '/rollback/execute' + query(), { token: plan.token, code: codeInput ? codeInput.value : null })).then(function (res) {
          if (!res) {
            execute.disabled = false;
            return;
          }
          followJob(res.jobId, host, '⏪ Rollback en cours', function (result) {
            Core.clear(host).append(
              el('h2', { class: 'section-title', text: 'Rollback n°' + result.batchId + ' — ' + (result.aborted ? 'interrompu' : 'terminé') }),
              el('section', { class: 'card' },
                el('p', { class: 'muted', style: 'padding:14px 14px 0;margin:0', text: '✅ ' + result.applied + ' annulée(s) · ⏭️ ' + result.skipped + ' ignorée(s) · ❌ ' + result.failed + ' échec(s)' + (result.cancelled ? ' · ⏹️ ' + result.cancelled + ' non exécutée(s)' : '') + (result.aborted ? ' — ' + result.aborted : '') }),
                itemsTable(result.items, 'Aucune action exécutée.'),
              ),
            );
          });
        });
      },
    });
    Core.clear(host).append(
      el('h2', { class: 'section-title', text: 'Aperçu — ' + plan.scope + ' · ' + plan.window }),
      el('section', { class: 'card' },
        el('div', { class: 'filters' },
          el('span', { text: '↩️ ' + plan.stats.ok + ' à annuler · ⏭️ ' + plan.stats.skipped + ' ignorée(s) · 🗑️ ' + plan.stats.destructive + ' destructive(s)' }),
        ),
        plan.warnings.length ? el('ul', { class: 'warnings' }, plan.warnings.map(function (w) { return el('li', { text: '⚠️ ' + w }); })) : null,
        plan.tooMany ? el('p', { class: 'error-text', text: '⛔ Trop d’actions pour un seul rollback : réduis la durée ou cible un utilisateur.' }) : null,
        el('h3', { class: 'card-sub', text: 'À annuler (du plus récent au plus ancien)' }),
        itemsTable(ok, 'Rien à annuler sur cette période.'),
        skipped.length ? el('h3', { class: 'card-sub', text: 'Ignorées' }) : null,
        skipped.length ? itemsTable(skipped, '') : null,
        el('div', { class: 'filters' },
          codeInput ? el('label', { class: 'field' }, el('span', { text: 'Confirmation : recopie « ' + plan.code + ' »' }), codeInput) : null,
          execute,
        ),
      ),
    );
  }

  // ── Journal ──────────────────────────────────────────────────────────────
  async function loadJournal() {
    var params = 'page=' + journalState.page + (journalState.kind ? '&kind=' + journalState.kind : '') + (journalState.executor ? '&executor=' + journalState.executor : '');
    var result = await busy(call('GET', '/changes' + query(params)));
    if (!result) return;
    var kind = el('select', { 'aria-label': 'Type' }, el('option', { value: '', text: 'Tout' }), ['channel', 'role', 'member_role'].map(function (k) { return el('option', { value: k, text: KIND_LABEL[k] }); }));
    kind.value = journalState.kind;
    var executor = el('input', { inputmode: 'numeric', maxlength: '20', placeholder: 'ID de l’auteur', value: journalState.executor || null });
    var pager = el('div', { class: 'hist-pager' },
      el('button', { type: 'button', class: 'btn btn-ghost btn-small', text: '❮ Précédent', disabled: result.page <= 1, onclick: function () { journalState.page -= 1; loadJournal(); } }),
      'Page ' + result.page + ' / ' + result.pages + ' · ' + fmt.number(result.total) + ' modification(s)',
      el('button', { type: 'button', class: 'btn btn-ghost btn-small', text: 'Suivant ❯', disabled: result.page >= result.pages, onclick: function () { journalState.page += 1; loadJournal(); } }),
    );
    Core.clear(byId('journal-card')).append(
      el('form', {
        class: 'filters',
        onsubmit: function (event) {
          event.preventDefault();
          var id = executor.value.trim();
          if (id && !/^\d{17,20}$/.test(id)) return showError('ID Discord invalide (17 à 20 chiffres).');
          journalState = { page: 1, kind: kind.value, executor: id };
          loadJournal();
        },
      },
        el('label', { class: 'field' }, el('span', { text: 'Type' }), kind),
        el('label', { class: 'field' }, el('span', { text: 'Auteur' }), executor),
        el('button', { type: 'submit', class: 'btn btn-small', text: 'Filtrer' }),
      ),
      table(
        [
          { label: 'Quand', value: function (r) { return fmt.dateTime(r.createdAt); } },
          { label: 'Type', value: function (r) { return (KIND_LABEL[r.kind] || r.kind) + ' · ' + (OP_LABEL[r.op] || r.op); } },
          { label: 'Objet', value: function (r) { return r.label + (r.roleName ? ' (' + r.roleName + ')' : ''); } },
          { label: 'Auteur', value: function (r) { return personEl(r.executor); } },
          { label: 'État', value: function (r) { return r.rolledBackAt ? el('span', { class: 'badge-status', text: 'annulée (rollback #' + r.batchId + ')' }) : null; } },
        ],
        result.rows,
        'Aucune modification enregistrée.',
      ),
      pager,
    );
  }

  // ── Historique ───────────────────────────────────────────────────────────
  async function loadHistory() {
    var rows = await busy(call('GET', '/batches' + query()));
    if (!rows) return;
    Core.clear(byId('history-card')).append(
      table(
        [
          { label: '#', value: function (b) { return String(b.id); } },
          { label: 'Lancé par', value: function (b) { return personEl(b.invoker); } },
          { label: 'Type', value: function (b) { return b.scope + ' · ' + b.window + (b.target ? ' · ' + b.target.name : ''); } },
          { label: 'Résultat', value: function (b) { return '✅ ' + b.applied + ' · ⏭️ ' + b.skipped + ' · ❌ ' + b.failed; } },
          { label: 'État', value: function (b) { return statusBadge(b.status); } },
          { label: 'Date', value: function (b) { return fmt.dateTime(b.createdAt); } },
          {
            label: '',
            value: function (b) {
              return el('button', {
                type: 'button',
                class: 'btn btn-ghost btn-small',
                text: 'Rapport',
                onclick: function () {
                  busy(call('GET', '/batches/' + b.id + query())).then(function (detail) {
                    if (!detail) return;
                    Core.clear(byId('batch-detail')).append(
                      el('h2', { class: 'section-title', text: 'Rapport du rollback #' + detail.id }),
                      el('section', { class: 'card' }, table(
                        [
                          { label: 'Action', value: function (i) { return i.title; } },
                          { label: 'Auteur d’origine', value: function (i) { return personEl(i.executor); } },
                          { label: 'État', value: function (i) { return statusBadge(i.status); } },
                          { label: 'Détail', value: function (i) { return i.reason; } },
                        ],
                        detail.report,
                        'Rapport vide.',
                      )),
                    );
                  });
                },
              });
            },
          },
        ],
        rows,
        'Aucun rollback exécuté sur ce serveur.',
      ),
    );
  }

  // ── Sauvegardes ──────────────────────────────────────────────────────────
  function sizeText(bytes) {
    return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' Mo' : Math.max(1, Math.round(bytes / 1024)) + ' Ko';
  }

  async function loadBackups() {
    var rows = await busy(call('GET', '/backups' + query()));
    if (!rows) return;
    var name = el('input', { type: 'text', maxlength: '80', placeholder: 'Nom (facultatif)' });
    var create = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: '💾 Créer une sauvegarde',
      onclick: function () {
        create.disabled = true;
        busy(call('POST', '/backups' + query(), { name: name.value.trim() || null })).then(function () {
          create.disabled = false;
          loadBackups();
        });
      },
    });
    Core.clear(byId('backups-card')).append(
      el('p', { class: 'muted', style: 'padding:14px 14px 0;margin:0', text: 'Une sauvegarde contient les rôles, les permissions de @everyone, les catégories et salons avec leurs permissions. Les messages et les membres ne sont pas sauvegardés.' }),
      el('div', { class: 'filters' }, el('label', { class: 'field field-grow' }, el('span', { text: 'Nouvelle sauvegarde' }), name), create),
      table(
        [
          { label: '#', value: function (b) { return String(b.id); } },
          { label: 'Nom', value: function (b) { return el('span', {}, b.origin === 'auto' ? '🕒 ' : '💾 ', b.name); } },
          { label: 'Contenu', value: function (b) { return b.roles + ' rôles · ' + b.channels + ' salons · ' + sizeText(b.size); } },
          { label: 'Créée', value: function (b) { return fmt.dateTime(b.createdAt); } },
          { label: 'Restaurée', value: function (b) { return b.restoredAt ? fmt.dateTime(b.restoredAt) : null; } },
          {
            label: '',
            value: function (b) {
              return el('div', { class: 'row-actions' },
                el('button', { type: 'button', class: 'btn btn-small', text: 'Restaurer…', onclick: function () { previewRestore(b.id); } }),
                el('button', {
                  type: 'button',
                  class: 'btn btn-ghost btn-small',
                  text: 'Supprimer',
                  onclick: function () {
                    Core.confirm('Supprimer définitivement la sauvegarde #' + b.id + ' ?', { confirmLabel: 'Supprimer' }).then(function (ok) {
                      if (ok) busy(call('DELETE', '/backups/' + b.id + query())).then(loadBackups);
                    });
                  },
                }),
              );
            },
          },
        ],
        rows,
        'Aucune sauvegarde pour l’instant.',
      ),
    );
  }

  async function previewRestore(id) {
    var preview = await busy(call('POST', '/backups/' + id + '/preview' + query()));
    if (!preview) return;
    var host = byId('restore-preview');
    var code = el('input', { type: 'text', maxlength: '30', placeholder: preview.code });
    var go = el('button', {
      type: 'button',
      class: 'btn btn-danger',
      text: '♻️ Restaurer (' + preview.actions.length + ')',
      disabled: !preview.actions.length,
      onclick: function () {
        go.disabled = true;
        busy(call('POST', '/backups/' + id + '/restore' + query(), { token: preview.token, code: code.value })).then(function (res) {
          if (!res) {
            go.disabled = false;
            return;
          }
          followJob(res.jobId, host, '♻️ Restauration en cours', function (result) {
            Core.clear(host).append(
              el('h2', { class: 'section-title', text: 'Restauration de la sauvegarde #' + id + ' terminée' }),
              el('section', { class: 'card' },
                el('p', { class: 'muted', style: 'padding:14px 14px 0;margin:0', text: '✅ ' + result.done + ' réussie(s) · ❌ ' + result.failed + ' échec(s) · ⏭️ ' + result.skipped.length + ' ignorée(s)' }),
                table(
                  [
                    { label: 'Opération', value: function (r) { return r.label; } },
                    { label: 'État', value: function (r) { return statusBadge(r.status); } },
                    { label: 'Détail', value: function (r) { return r.reason; } },
                  ],
                  result.results,
                  'Aucune opération.',
                ),
              ),
            );
            loadBackups();
          });
        });
      },
    });
    Core.clear(host).append(
      el('h2', { class: 'section-title', text: 'Aperçu — restauration de « ' + preview.backup.name + ' »' }),
      el('section', { class: 'card' },
        el('p', { class: 'muted', style: 'padding:14px 14px 0;margin:0', text: 'Restauration non destructive : ce qui a été créé depuis la sauvegarde est conservé ; les positions et les messages ne sont pas restaurés. Exige la permission Discord « Administrateur ».' }),
        table([{ label: 'Prévu', value: function (a) { return (a.type.indexOf('create') !== -1 ? '➕ ' : '↩️ ') + a.label; } }], preview.actions, 'Le serveur correspond déjà à cette sauvegarde : rien à restaurer.'),
        preview.skipped.length ? table([
          { label: 'Ignoré', value: function (s) { return s.label; } },
          { label: 'Raison', value: function (s) { return s.reason; } },
        ], preview.skipped, '') : null,
        preview.actions.length
          ? el('div', { class: 'filters' }, el('label', { class: 'field' }, el('span', { text: 'Confirmation : recopie « ' + preview.code + ' »' }), code), go)
          : null,
      ),
    );
    host.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ── Réglages ─────────────────────────────────────────────────────────────
  function renderSettings() {
    var s = state.settings;
    var log = el('select', { 'aria-label': 'Salon de journal' }, el('option', { value: '', text: '(aucun)' }), state.textChannels.map(function (c) { return el('option', { value: c.id, text: '#' + c.name }); }));
    log.value = s.logChannelId || '';
    var auto = el('input', { type: 'checkbox' });
    auto.checked = s.backupEnabled;
    var interval = el('input', { type: 'number', min: '1', max: '720', value: String(s.backupIntervalHours) });
    var keep = el('input', { type: 'number', min: '1', max: '50', value: String(s.backupKeep) });
    var save = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: 'Enregistrer',
      onclick: function () {
        busy(call('POST', '/settings' + query(), { logChannelId: log.value || null, backupEnabled: auto.checked, backupIntervalHours: Number(interval.value), backupKeep: Number(keep.value) })).then(function (res) {
          if (res) loadState();
        });
      },
    });
    Core.clear(byId('settings-card')).append(
      el('div', { class: 'filters' },
        el('label', { class: 'field' }, el('span', { text: 'Salon de journal (rollbacks, sauvegardes)' }), log),
      ),
      el('div', { class: 'filters' },
        el('label', { class: 'check' }, auto, 'Sauvegardes automatiques'),
        el('label', { class: 'field' }, el('span', { text: 'Toutes les (heures)' }), interval),
        el('label', { class: 'field' }, el('span', { text: 'Sauvegardes auto conservées' }), keep),
        save,
      ),
    );
  }

  // ── Onglets et chargement ────────────────────────────────────────────────
  function selectTab(tab) {
    activeTab = tab;
    document.querySelectorAll('#tabs .tab-btn').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === tab)); });
    document.querySelectorAll('.tab-panel').forEach(function (panel) { panel.hidden = panel.dataset.tab !== tab; });
    if (tab === 'journal') loadJournal();
    if (tab === 'history') loadHistory();
    if (tab === 'backups') loadBackups();
  }

  async function loadState() {
    var result = await busy(call('GET', '/state' + query()));
    if (!result) return;
    state = result;
    renderTiles();
    renderSettings();
  }

  async function loadGuild() {
    byId('content').hidden = true;
    ['rollback-preview', 'batch-detail', 'restore-preview'].forEach(function (id) { Core.clear(byId(id)); });
    journalState = { page: 1, kind: '', executor: '' };
    await loadState();
    if (!state) return;
    renderRollbackForm();
    byId('content').hidden = false;
    selectTab(activeTab);
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
      guildId = guilds[0].id;
      select.value = guildId;
      select.addEventListener('change', function () {
        guildId = select.value;
        loadGuild();
      });
      byId('f-refresh').addEventListener('click', function () { loadGuild(); });
      document.querySelectorAll('#tabs .tab-btn').forEach(function (b) { b.addEventListener('click', function () { selectTab(b.dataset.tab); }); });
      await loadGuild();
    } catch (err) {
      showError(err.message);
    }
  }

  start();
})();
