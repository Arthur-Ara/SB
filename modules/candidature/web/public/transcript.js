/* Transcription d'une candidature : en-tête (statut, motif, historique), messages façon Discord, actions. */
(function () {
  'use strict';

  var el = Core.el;
  var fmt = Core.fmt;
  var API = '/m/candidature/api';
  var candidatureId = new URLSearchParams(window.location.search).get('candidature') || '';
  var mentions = { users: {}, roles: {}, channels: {} };
  var renderContent = window.TicketFormat.renderContent;
  var current = null;

  var EVENT_LABELS = {
    opened: '📨 Candidature ouverte',
    submitted: '📬 Candidature terminée par le candidat',
    category: '🔀 Catégorie modifiée',
    deleted: '🗑️ Salon supprimé',
    invite: '🔗 Invitation à usage unique envoyée',
  };

  function showError(message) {
    var box = document.getElementById('error');
    box.textContent = message || '';
    box.hidden = !message;
  }

  function call(method, path, body) {
    return Core.request(method, API + path, body);
  }

  function clean(value) {
    if (value === null || value === undefined) return '';
    var text = String(value);
    return text === 'null' || text === 'undefined' ? '' : text;
  }

  /** Vide `box` puis y ajoute les éléments donnés, en ignorant null/undefined/false. */
  function fill(box) {
    var nodes = Array.prototype.slice.call(arguments, 1).flat(Infinity).filter(function (node) { return node !== null && node !== undefined && node !== false; });
    Core.clear(box).append.apply(box, nodes);
    return box;
  }

  // ── Messages (rendu léger façon Discord, styles partagés avec les tickets) ─
  function embedEl(embed) {
    var color = embed.color ? '#' + Number(embed.color).toString(16).padStart(6, '0') : '#5865f2';
    var box = el('div', { class: 'dmsg-embed', style: 'border-left-color:' + color });
    if (embed.title) box.append(el('div', { class: 'de-title', text: embed.title }));
    if (embed.description) {
      var desc = el('div', { class: 'de-desc' });
      desc.innerHTML = renderContent(embed.description, mentions);
      box.append(desc);
    }
    if (embed.fields && embed.fields.length) {
      box.append(
        el('div', { class: 'de-fields' }, embed.fields.map(function (field) {
          var value = el('div', { class: 'de-field-value' });
          value.innerHTML = renderContent(field.value || '', mentions);
          return el('div', { class: 'de-field' + (field.inline ? ' inline' : '') }, el('div', { class: 'de-field-name', text: field.name || '' }), value);
        })),
      );
    }
    if (embed.image && embed.image.url) box.append(el('img', { src: embed.image.url, alt: '', loading: 'lazy' }));
    else if (embed.thumbnail && embed.thumbnail.url) box.append(el('img', { src: embed.thumbnail.url, alt: '', loading: 'lazy' }));
    if (embed.footer && embed.footer.text) box.append(el('div', { class: 'de-footer', text: embed.footer.text }));
    return box;
  }

  function attachmentEl(a) {
    if (!a) return null;
    if (a.external && a.url) return el('div', { class: 'dmsg-attachment' }, el('img', { class: 'dmsg-sticker', src: a.url, alt: clean(a.name), title: clean(a.name), loading: 'lazy' }));
    if (a.tooLarge || a.failed || !a.id) return el('div', { class: 'dmsg-file', text: '⚠️ ' + (a.name || 'fichier') + (a.tooLarge ? ' (trop volumineux, non conservé)' : ' (indisponible)') });
    var src = API + '/attachments/' + a.id;
    if (a.contentType && a.contentType.indexOf('image/') === 0 && a.contentType.indexOf('svg') === -1) return el('div', { class: 'dmsg-attachment' }, el('img', { src: src, alt: a.name || '', loading: 'lazy' }));
    if (a.contentType && a.contentType.indexOf('video/') === 0) return el('div', { class: 'dmsg-attachment' }, el('video', { src: src, controls: true, preload: 'metadata' }));
    return el('a', { class: 'dmsg-file', href: src, target: '_blank', rel: 'noopener' }, '📎 ' + (a.name || 'fichier') + (a.size ? ' · ' + Math.round(a.size / 1024) + ' Ko' : ''));
  }

  function messageBody(m) {
    var nodes = [];
    var text = clean(m.content);
    if (text) {
      var content = el('div', { class: 'dmsg-content' + (window.TicketFormat.isEmojiOnly(text) ? ' jumbo' : '') });
      content.innerHTML = renderContent(text, mentions);
      nodes.push(content);
    }
    (m.embeds || []).forEach(function (e) { nodes.push(embedEl(e)); });
    if (m.attachments && m.attachments.length) nodes.push(el('div', { class: 'dmsg-attachments' }, m.attachments.map(attachmentEl)));
    if (m.updatedAt) nodes.push(el('span', { class: 'muted cand-edited', text: '(modifié)', title: fmt.dateTime(m.updatedAt) }));
    return nodes;
  }

  function renderMessages(messages, applicantId) {
    var container = document.getElementById('messages');
    var groups = [];
    messages.forEach(function (m) {
      var last = groups[groups.length - 1];
      var closeInTime = last && new Date(m.createdAt).getTime() - new Date(last.items[last.items.length - 1].createdAt).getTime() < 7 * 60000;
      if (last && last.authorId === m.authorId && closeInTime) last.items.push(m);
      else groups.push({ authorId: m.authorId, authorName: m.authorName, authorAvatar: m.authorAvatar, authorColor: m.authorColor, bot: m.bot, items: [m] });
    });
    Core.clear(container);
    if (!groups.length) {
      container.append(el('div', { class: 'empty', text: 'Aucun message dans cette candidature.' }));
      return;
    }
    groups.forEach(function (group) {
      var first = group.items[0];
      var badge = group.bot ? 'BOT' : group.authorId === applicantId ? 'CANDIDAT' : null;
      container.append(
        el(
          'div',
          { class: 'dmsg-group' },
          el('div', { class: 'dmsg-avatar' }, el('img', { src: group.authorAvatar, alt: '' })),
          el(
            'div',
            { class: 'dmsg-body' },
            el(
              'div',
              { class: 'dmsg-header' },
              el('span', { class: 'dmsg-author', style: group.authorColor ? 'color:' + group.authorColor : null, text: clean(group.authorName) || 'Inconnu' }),
              badge ? el('span', { class: 'dmsg-badge', text: badge }) : null,
              el('span', { class: 'dmsg-time', text: fmt.dateTime(first.createdAt) }),
            ),
            messageBody(first),
          ),
        ),
      );
      for (var i = 1; i < group.items.length; i += 1) {
        var m = group.items[i];
        var time = new Date(m.createdAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        container.append(el('div', { class: 'dmsg-group dmsg-continuation' }, el('span', { class: 'dmsg-time', text: time, title: fmt.dateTime(m.createdAt) }), el('div', { class: 'dmsg-body' }, messageBody(m))));
      }
    });
  }

  // ── En-tête ────────────────────────────────────────────────────────────────
  function action(path, body) {
    showError('');
    return call('POST', '/candidatures/' + candidatureId + '/' + path + '?guild=' + encodeURIComponent(current.guildId), body)
      .then(load)
      .catch(function (err) { showError(err.message); });
  }

  function actionsEl(result) {
    var c = result.candidature;
    if (!result.canManage) return null;
    if (c.final) {
      if (!c.channelExists) return null;
      return el('div', { class: 'reply-actions transcript-actions' }, el('button', {
        type: 'button',
        class: 'btn btn-danger btn-small',
        text: '🗑️ Supprimer le salon',
        onclick: function () {
          Core.confirm('Supprimer le salon Discord de cette candidature ? La transcription reste consultable ici.').then(function (ok) { if (ok) action('delete-channel', {}); });
        },
      }));
    }
    var status = el('select', { 'aria-label': 'Nouveau statut' }, el('option', { value: '', text: 'Changer le statut…' }), result.statuses.map(function (s) {
      return el('option', { value: s.key, text: s.emoji + ' ' + s.label, disabled: s.key === c.status });
    }));
    status.addEventListener('change', function () {
      var key = status.value;
      status.value = '';
      if (!key) return;
      var chosen = result.statuses.find(function (s) { return s.key === key; });
      var required = key === 'refused' && result.refusalReasonRequired;
      var ask = key === 'refused' || key === 'accepted'
        ? Core.prompt(key === 'refused' ? 'Motif du refus' + (required ? ' (obligatoire)' : ' (facultatif)') : 'Précision pour le candidat (facultatif)', { title: chosen.emoji + ' ' + chosen.label, maxlength: '900', confirmLabel: chosen.label })
        : Promise.resolve('');
      ask.then(function (reason) {
        if (reason === null) return;
        if (required && !reason) return showError('Le refus doit être motivé : indique la raison.');
        action('status', { status: key, reason: reason || null });
      });
    });
    var move = result.categories.length
      ? el('select', { 'aria-label': 'Changer de catégorie' }, el('option', { value: '', text: '🔀 Changer de catégorie…' }), result.categories.map(function (cat) { return el('option', { value: cat.id, text: cat.label }); }))
      : null;
    if (move) {
      move.addEventListener('change', function () {
        var target = move.value;
        move.value = '';
        if (target) action('category', { categoryId: target });
      });
    }
    return el('div', { class: 'reply-actions transcript-actions' }, status, move);
  }

  function eventsEl(events) {
    if (!events.length) return null;
    return el(
      'details',
      { class: 'transcript-answers' },
      el('summary', { text: '🕓 Historique de la candidature (' + events.length + ')' }),
      el('ol', { class: 'cand-events' }, events.map(function (e) {
        var label = e.kind === 'status' ? e.statusLabel : EVENT_LABELS[e.kind] || e.kind;
        return el(
          'li',
          {},
          el('span', { class: 'muted', text: fmt.dateTime(e.at) + ' · ' }),
          el('strong', { text: label }),
          e.actor ? ' — ' + e.actor.name : e.kind === 'status' ? ' — automatique' : null,
          e.detail ? el('div', { class: 'cand-reason', text: e.detail }) : null,
        );
      })),
    );
  }

  function renderHead(result) {
    var c = result.candidature;
    fill(
      document.getElementById('head'),
      el('h1', { text: '📨 Candidature #' + c.id + ' — ' + c.categoryLabel }),
      el(
        'div',
        { class: 'transcript-meta' },
        el('span', {}, 'Candidat : ', el('strong', { text: c.applicant ? c.applicant.name : '—' }), c.applicant && c.applicant.username ? ' (@' + c.applicant.username + ')' : null),
        el('span', { text: 'Ouverte le ' + fmt.dateTime(c.createdAt) }),
        c.submittedAt ? el('span', { text: 'Envoyée le ' + fmt.dateTime(c.submittedAt) }) : null,
        el('span', { class: 'cand-status cand-status-' + c.status, text: c.statusLabel }),
      ),
      c.final
        ? el(
            'div',
            { class: 'transcript-meta' },
            el('span', {}, 'Décision : ', el('strong', { text: c.statusBy ? c.statusBy.name : c.auto ? '🤖 automatique' : '—' })),
            c.closedAt ? el('span', { text: 'le ' + fmt.dateTime(c.closedAt) }) : null,
          )
        : null,
      c.reason ? el('div', { class: 'cand-reason-box' }, el('strong', { text: c.status === 'refused' ? 'Motif du refus' : 'Précision' }), el('div', { class: 'cand-reason', text: c.reason })) : null,
      actionsEl(result),
      eventsEl(result.events),
      el('div', { class: 'transcript-meta' }, el('a', { href: '/m/candidature/?guild=' + encodeURIComponent(result.guildId), text: '← Toutes les candidatures' })),
    );
  }

  async function load() {
    var result = await call('GET', '/candidatures/' + encodeURIComponent(candidatureId));
    current = result;
    ['users', 'roles', 'channels'].forEach(function (key) { Object.assign(mentions[key], (result.mentions && result.mentions[key]) || {}); });
    document.title = 'Candidature #' + result.candidature.id + ' · SciensBot';
    renderHead(result);
    renderMessages(result.messages, result.candidature.applicant ? result.candidature.applicant.id : null);
  }

  async function start() {
    if (!/^\d+$/.test(candidatureId)) {
      showError('Identifiant de candidature manquant dans l’adresse.');
      return;
    }
    try {
      await Core.ready;
      await load();
    } catch (err) {
      showError(err.message);
    }
  }

  start();
})();
