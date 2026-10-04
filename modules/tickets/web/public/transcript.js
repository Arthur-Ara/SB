/* Page transcript : simulation de l'interface Discord + réponse live (si activée pour le type). */
(function () {
  'use strict';

  var el = Core.el;
  var fmt = Core.fmt;
  var API = '/m/tickets/api';
  var params = new URLSearchParams(window.location.search);
  var kind = params.get('modmail') ? 'modmail' : 'ticket';
  var recordId = params.get(kind) || '';
  var base = (kind === 'modmail' ? '/modmail/' : '/tickets/') + recordId;
  // Les pièces jointes du modmail sont stockées à part de celles des tickets (table et route distinctes).
  var attachmentBase = API + (kind === 'modmail' ? '/modmail-attachments/' : '/attachments/');
  var lastId = 0;
  var since = null; // heure serveur du dernier passage : messages modifiés depuis (aperçus de liens…)
  var pollTimer = null;
  var countdownTimer = null;
  var recordStatus = null;
  var liveEnabled = false;
  var snippets = []; // réponses prédéfinies du serveur (vide si le compte ne peut pas répondre)
  var messagesById = new Map();
  var meId = null; // compte connecté au panel
  var guildId = ''; // serveur du ticket (routes d'action)
  var canManage = false; // droit « gérer les tickets » : boutons prendre en charge / fermer
  var claimKey = null; // dernier « pris en charge par » connu : la zone de réponse en dépend
  var mentions = { users: {}, roles: {}, channels: {} };

  function showError(message) {
    var box = document.getElementById('error');
    box.textContent = message || '';
    box.hidden = !message;
  }

  function call(method, path, body) {
    return Core.request(method, API + path, body);
  }

  /**
   * Vide `box` puis y ajoute les éléments donnés, en ignorant null/undefined/false : `Node.append(null)` du
   * navigateur écrirait sinon le texte « null » (blocs facultatifs de l'en-tête, délais absents…).
   */
  function fill(box) {
    var nodes = Array.prototype.slice.call(arguments, 1).flat(Infinity).filter(function (node) { return node !== null && node !== undefined && node !== false; });
    Core.clear(box).append.apply(box, nodes);
    return box;
  }

  // ── Rendu façon Discord (léger, pas un clone pixel-perfect) ────────────────
  // Mise en forme Discord (gras/italique/souligné/barré/code/citations/mentions) : voir format.js,
  // partagé avec l'aperçu d'embed du panel (tickets.js).
  var renderContent = window.TicketFormat.renderContent;

  /** Texte sûr : jamais « null »/« undefined » affichés à l'écran. */
  function clean(value) {
    if (value === null || value === undefined) return '';
    var text = String(value);
    return text === 'null' || text === 'undefined' ? '' : text;
  }

  function isMediaEmbed(embed) {
    return embed && (embed.type === 'gifv' || embed.type === 'image' || embed.type === 'video') && !embed.title && !embed.description;
  }

  /** GIF/image/vidéo « nue » (Tenor, Giphy, lien direct) : affichée sans cadre, comme dans Discord. */
  function mediaEl(embed) {
    var box = el('div', { class: 'dmsg-media' });
    var still = (embed.thumbnail && embed.thumbnail.url) || (embed.image && embed.image.url) || '';
    var videoUrl = embed.video && embed.video.url;
    if (videoUrl && /\.(mp4|webm|mov)(\?|$)/i.test(videoUrl)) {
      var video = el('video', { src: videoUrl, poster: still || null, autoplay: true, loop: true, muted: true, playsinline: true, controls: embed.type === 'video' });
      video.muted = true;
      video.addEventListener('error', function () {
        if (still) box.replaceChildren(el('img', { src: still, alt: '', loading: 'lazy' }));
      });
      box.append(video);
    } else if (still) {
      box.append(el('img', { src: still, alt: '', loading: 'lazy' }));
    } else if (embed.url) {
      box.append(el('a', { href: embed.url, target: '_blank', rel: 'noopener noreferrer', text: embed.url }));
    }
    return box;
  }

  function embedEl(embed, mentions) {
    if (isMediaEmbed(embed)) return mediaEl(embed);
    var color = embed.color ? '#' + Number(embed.color).toString(16).padStart(6, '0') : '#5865f2';
    var box = el('div', { class: 'dmsg-embed', style: 'border-left-color:' + color });
    if (embed.title) box.append(el('div', { class: 'de-title', text: embed.title }));
    if (embed.description) {
      var desc = el('div', { class: 'de-desc' });
      desc.innerHTML = renderContent(embed.description, mentions);
      box.append(desc);
    }
    // Champs (ex. « Réponses au formulaire ») : nom en gras, valeur mise en forme comme la description.
    if (embed.fields && embed.fields.length) {
      box.append(
        el('div', { class: 'de-fields' }, embed.fields.map(function (field) {
          var value = el('div', { class: 'de-field-value' });
          value.innerHTML = renderContent(field.value || '', mentions);
          return el('div', { class: 'de-field' + (field.inline ? ' inline' : '') }, el('div', { class: 'de-field-name', text: field.name || '' }), value);
        })),
      );
    }
    if (embed.video && embed.video.url) {
      box.append(el('video', { src: embed.video.url, controls: true, preload: 'metadata' }));
    } else if (embed.image && embed.image.url) {
      box.append(el('img', { src: embed.image.url, alt: '', loading: 'lazy' }));
    } else if (embed.thumbnail && embed.thumbnail.url) {
      box.append(el('img', { src: embed.thumbnail.url, alt: '', loading: 'lazy' }));
    }
    if (embed.footer && embed.footer.text) box.append(el('div', { class: 'de-footer', text: embed.footer.text }));
    return box;
  }

  function attachmentEl(a) {
    if (!a) return null;
    if (a.external && a.url) {
      // Autocollant Discord : image servie par le CDN Discord (aucune copie locale).
      return el('div', { class: 'dmsg-attachment' }, el('img', { class: 'dmsg-sticker', src: a.url, alt: clean(a.name), title: clean(a.name), loading: 'lazy' }));
    }
    if (a.tooLarge || a.failed || !a.id) {
      return el('div', { class: 'dmsg-file', text: '⚠️ ' + (a.name || 'fichier') + (a.tooLarge ? ' (trop volumineux, non conservé)' : ' (indisponible)') });
    }
    var src = attachmentBase + a.id;
    // SVG : servi en téléchargement par sécurité (il peut contenir du script), donc affiché comme un fichier.
    if (a.contentType && a.contentType.indexOf('image/') === 0 && a.contentType.indexOf('svg') === -1) {
      return el('div', { class: 'dmsg-attachment' }, el('img', { src: src, alt: a.name || '', loading: 'lazy' }));
    }
    if (a.contentType && a.contentType.indexOf('video/') === 0) {
      return el('div', { class: 'dmsg-attachment' }, el('video', { src: src, controls: true, preload: 'metadata' }));
    }
    return el('a', { class: 'dmsg-file', href: src, target: '_blank', rel: 'noopener' }, '📎 ' + (a.name || 'fichier') + (a.size ? ' · ' + Math.round(a.size / 1024) + ' Ko' : ''));
  }

  function messageBody(m) {
    var nodes = [];
    var text = clean(m.content);
    // Message réduit à un lien déjà affiché en GIF/image par un embed : on masque l'URL brute.
    var onlyLink = /^https?:\/\/\S+$/.test(text.trim()) && (m.embeds || []).some(isMediaEmbed);
    if (text && !onlyLink) {
      var content = el('div', { class: 'dmsg-content' + (window.TicketFormat.isEmojiOnly(text) ? ' jumbo' : '') });
      content.innerHTML = renderContent(text, mentions);
      nodes.push(content);
    }
    (m.embeds || []).forEach(function (e) { nodes.push(embedEl(e, mentions)); });
    if (m.attachments && m.attachments.length) nodes.push(el('div', { class: 'dmsg-attachments' }, m.attachments.map(attachmentEl)));
    return nodes;
  }

  /** Insigne d'un message : réponse panel web (tickets), note interne / système (modmail). */
  function badgeOf(m) {
    if (m.badge) return m.badge;
    if (m.viaWeb) return '🌐 panel web';
    return null;
  }

  function renderMessages(messages) {
    var container = document.getElementById('messages');
    var groups = [];
    messages.forEach(function (m) {
      var badge = badgeOf(m);
      var last = groups[groups.length - 1];
      var sameAuthor = last && last.authorId === m.authorId && last.badge === badge;
      var closeInTime = last && new Date(m.createdAt).getTime() - new Date(last.items[last.items.length - 1].createdAt).getTime() < 7 * 60_000;
      if (sameAuthor && closeInTime) last.items.push(m);
      else groups.push({ authorId: m.authorId, authorName: m.authorName, authorAvatar: m.authorAvatar, authorRoleColor: m.authorRoleColor, authorBot: m.authorBot, badge: badge, items: [m] });
    });

    Core.clear(container);
    if (!groups.length) {
      container.append(el('div', { class: 'empty', text: 'Aucun message pour l’instant.' }));
      return;
    }
    groups.forEach(function (group) {
      var first = group.items[0];
      var header = el(
        'div',
        { class: 'dmsg-header' },
        el('span', { class: 'dmsg-author', style: group.authorRoleColor ? 'color:' + group.authorRoleColor : null, text: clean(group.authorName) || 'Inconnu' }),
        group.authorBot && !group.badge ? el('span', { class: 'dmsg-badge', text: 'BOT' }) : null,
        group.badge ? el('span', { class: 'dmsg-badge', text: group.badge }) : null,
        el('span', { class: 'dmsg-time', text: fmt.dateTime(first.createdAt) }),
      );
      container.append(
        el(
          'div',
          { class: 'dmsg-group' },
          el('div', { class: 'dmsg-avatar' }, el('img', { src: group.authorAvatar, alt: '' })),
          // Premier message seulement : les suivants du groupe sont ajoutés juste après en lignes « suite »
          // (ils étaient sinon affichés deux fois).
          el('div', { class: 'dmsg-body' }, header, messageBody(first)),
        ),
      );
      for (var i = 1; i < group.items.length; i += 1) {
        var m = group.items[i];
        // Gouttière : l'heure seule (comme Discord), la date complète au survol.
        var time = new Date(m.createdAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        container.append(el('div', { class: 'dmsg-group dmsg-continuation' }, el('span', { class: 'dmsg-time', text: time, title: fmt.dateTime(m.createdAt) }), el('div', { class: 'dmsg-body' }, messageBody(m))));
      }
    });
    container.scrollTop = container.scrollHeight;
  }

  /** « dans 3min 12s » / « imminent » à partir d'une date ISO cible (ou null). */
  function formatCountdown(targetIso) {
    if (!targetIso) return null;
    var diff = new Date(targetIso).getTime() - Date.now();
    if (diff <= 0) return 'imminent';
    var totalSeconds = Math.floor(diff / 1000);
    var h = Math.floor(totalSeconds / 3600);
    var m = Math.floor((totalSeconds % 3600) / 60);
    var s = totalSeconds % 60;
    if (h > 0) return h + 'h ' + String(m).padStart(2, '0') + 'min';
    if (m > 0) return m + 'min ' + String(s).padStart(2, '0') + 's';
    return s + 's';
  }

  function delaysEl(ticket) {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    if (ticket.status !== 'open' || (!ticket.repingAt && !ticket.autoCloseAt)) return null;

    var box = el('div', { class: 'transcript-meta transcript-delays' });
    function update() {
      fill(box,
        ticket.repingAt ? el('span', {}, '⏰ Prochain reping du staff : ', el('strong', { text: formatCountdown(ticket.repingAt) })) : null,
        ticket.autoCloseAt ? el('span', {}, '🔒 Clôture automatique : ', el('strong', { text: formatCountdown(ticket.autoCloseAt) })) : null,
        ticket.scheduleActive === false ? el('span', { class: 'muted' }, '😴 En pause (hors plage horaire)') : null,
      );
    }
    update();
    countdownTimer = setInterval(update, 1000);
    return box;
  }

  /** Action du staff sur le ticket depuis le panel, puis rafraîchissement immédiat de l'en-tête et des messages. */
  function ticketAction(path, body) {
    showError('');
    return call('POST', '/tickets/' + recordId + '/' + path + '?guild=' + encodeURIComponent(guildId), body)
      .then(function () { return poll(); })
      .catch(function (err) { showError(err.message); });
  }

  /** Boutons Prendre en charge / Relâcher / Fermer (droit « gérer les tickets » du panel), ticket ouvert seulement. */
  function ticketActions(ticket) {
    if (ticket.status !== 'open' || !canManage) return null;
    var mine = ticket.claimedBy && ticket.claimedBy.id === meId;
    var claim = ticket.claimedBy
      ? el('button', {
          type: 'button',
          class: 'btn btn-small',
          text: mine ? '🙋 Relâcher' : '🙋 Relâcher (pris par ' + ticket.claimedBy.name + ')',
          onclick: function () { ticketAction('claim', { claiming: false }); },
        })
      : el('button', { type: 'button', class: 'btn btn-primary btn-small', text: '🙋 Prendre en charge', onclick: function () { ticketAction('claim', { claiming: true }); } });
    var close = el('button', {
      type: 'button',
      class: 'btn btn-danger btn-small',
      text: '🔒 Fermer le ticket',
      onclick: function () {
        Core.prompt('Raison de la fermeture', { placeholder: 'Raison (facultatif)', maxlength: '512', confirmLabel: 'Fermer le ticket' }).then(function (reason) {
          if (reason !== null) ticketAction('close', { reason: reason || null });
        });
      },
    });
    return el('div', { class: 'reply-actions transcript-actions' }, claim, close);
  }

  function renderTicketHead(ticket) {
    var box = document.getElementById('head');
    fill(box,
      el('h1', { text: '🎫 Ticket #' + ticket.id + ' — ' + ticket.typeLabel }),
      el('div', { class: 'transcript-meta' },
        el('span', {}, 'Ouvert par ', el('strong', { text: ticket.opener ? ticket.opener.name : '—' })),
        el('span', {}, fmt.dateTime(ticket.createdAt)),
        el('span', { class: 'status-pill ' + ticket.status, text: ticket.status === 'open' ? 'Ouvert' : 'Fermé' }),
      ),
      ticket.status === 'closed'
        ? el('div', { class: 'transcript-meta' },
            ticket.closedBy ? el('span', {}, 'Fermé par ', el('strong', { text: ticket.closedBy.name })) : null,
            ticket.closeReason ? el('span', {}, 'Raison : ' + ticket.closeReason) : null,
          )
        : null,
      ticket.claimedBy ? el('div', { class: 'transcript-meta' }, el('span', {}, '🙋 Pris en charge par ', el('strong', { text: ticket.claimedBy.name }))) : null,
      ticketActions(ticket),
      ticket.tags && ticket.tags.length
        ? el('div', { class: 'transcript-meta' }, ticket.tags.map(function (tag) {
            return el('span', { class: 'transcript-tag', style: tag.color ? 'border-color:' + tag.color + ';color:' + tag.color : null, text: (tag.emoji ? tag.emoji + ' ' : '') + tag.name });
          }))
        : null,
      ticket.formAnswers && ticket.formAnswers.length
        ? el(
            'details',
            { class: 'transcript-answers' },
            el('summary', { text: '📝 Réponses au formulaire (' + ticket.formAnswers.length + ')' }),
            ticket.formAnswers.map(function (a) { return el('div', { class: 'answer' }, el('strong', { text: a.question }), el('div', { text: a.answer })); }),
          )
        : null,
      delaysEl(ticket),
    );
  }

  function renderModmailHead(thread) {
    var box = document.getElementById('head');
    fill(box,
      el('h1', { text: '📨 Modmail #' + thread.id + (thread.categoryName ? ' — ' + thread.categoryName : '') }),
      el('div', { class: 'transcript-meta' },
        el('span', {}, 'Avec ', el('strong', { text: thread.user ? thread.user.name : '—' })),
        el('span', {}, fmt.dateTime(thread.createdAt)),
        el('span', { class: 'status-pill ' + thread.status, text: thread.status === 'open' ? 'Ouvert' : 'Fermé' }),
      ),
      thread.panelOnly ? el('div', { class: 'transcript-meta' }, el('span', { class: 'muted', text: '🌐 Traité uniquement depuis le panel : aucun salon Discord pour ce fil.' })) : null,
      thread.status === 'closed'
        ? el('div', { class: 'transcript-meta' },
            thread.closedBy ? el('span', {}, 'Fermé par ', el('strong', { text: thread.closedBy.name })) : null,
            thread.closeReason ? el('span', {}, 'Raison : ' + thread.closeReason) : null,
          )
        : el('div', { class: 'reply-actions' },
            el('button', {
              type: 'button',
              class: 'btn btn-danger btn-small',
              text: '🔒 Fermer le fil',
              onclick: function () {
                Core.prompt('Raison de la fermeture (facultatif)', { placeholder: 'Raison', maxlength: '512', confirmLabel: 'Fermer le fil' }).then(function (reason) {
                  if (reason === null) return;
                  call('POST', base + '/close', { reason: reason || null })
                    .then(function () { return poll(); })
                    .catch(function (err) { showError(err.message); });
                });
              },
            }),
          ),
    );
  }

  function renderHead(record) {
    if (kind === 'modmail') renderModmailHead(record);
    else renderTicketHead(record);
  }

  /**
   * Zone de réponse : ticket (transcript live activé) ou fil modmail ouvert (droit « répondre depuis le panel »).
   * Les réponses prédéfinies s'insèrent dans la zone de texte (placeholders remplacés à l'envoi) ; en modmail,
   * la case « anonyme » masque le nom du staff au membre.
   */
  function setupReply(record, canReply) {
    var box = document.getElementById('reply');
    if (record.status !== 'open' || !canReply) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    // « Obliger à prendre en charge pour répondre » : seul le membre du staff qui a pris le ticket peut répondre.
    if (kind === 'ticket' && record.claimRequired && (!record.claimedBy || record.claimedBy.id !== meId)) {
      fill(box, el('div', { class: 'reply-locked muted', text: record.claimedBy
        ? '🔒 Ce ticket est pris en charge par ' + record.claimedBy.name + ' : lui seul peut y répondre.'
        : '🙋 Prends ce ticket en charge (bouton ci-dessus) pour pouvoir y répondre.' }));
      return;
    }
    var textarea = el('textarea', { placeholder: kind === 'modmail' ? 'Répondre au membre (message privé)…' : 'Répondre depuis le panel web…', maxlength: kind === 'modmail' ? '2000' : '1900' });
    var anonymous = kind === 'modmail' ? el('input', { type: 'checkbox' }) : null;
    var snippetSelect = snippets.length
      ? el(
          'select',
          {
            'aria-label': 'Insérer une réponse prédéfinie',
            onchange: function () {
              var found = snippets.find(function (s) { return s.name === snippetSelect.value; });
              if (found) textarea.value = (textarea.value ? textarea.value + '\n' : '') + found.content;
              snippetSelect.value = '';
              textarea.focus();
            },
          },
          el('option', { value: '', text: '💬 Réponse prédéfinie…' }),
          snippets.map(function (s) { return el('option', { value: s.name, text: s.name }); }),
        )
      : null;
    var button = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: 'Envoyer',
      onclick: function () {
        var content = textarea.value.trim();
        if (!content) return;
        button.disabled = true;
        var body = { content: content };
        if (anonymous) body.anonymous = anonymous.checked;
        call('POST', base + '/messages', body)
          .then(function (result) {
            textarea.value = '';
            if (result && result.delivered === false) showError('Message enregistré, mais non remis : le membre a fermé ses messages privés.');
            return poll();
          })
          .catch(function (err) { showError(err.message); })
          .finally(function () { button.disabled = false; });
      },
    });
    fill(box,
      textarea,
      el('div', { class: 'reply-actions' }, snippetSelect, anonymous ? el('label', { class: 'check' }, anonymous, '🕶️ Anonyme') : null, button),
    );
  }

  /** Ajoute (ou remplace, si modifiés) des messages reçus et leurs mentions résolues ; renvoie true si quelque chose a changé. */
  function merge(payload) {
    ['users', 'roles', 'channels'].forEach(function (key) {
      Object.assign(mentions[key], (payload.mentions && payload.mentions[key]) || {});
    });
    if (payload.serverTime) since = payload.serverTime;
    (payload.messages || []).forEach(function (m) {
      messagesById.set(String(m.id), m);
      if (Number(m.id) > lastId) lastId = Number(m.id);
    });
    return Boolean(payload.messages && payload.messages.length);
  }

  function orderedMessages() {
    return Array.from(messagesById.values()).sort(function (a, b) {
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || Number(a.id) - Number(b.id);
    });
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  /** Sondage incrémental : seuls les messages nouveaux (ou modifiés depuis le dernier passage) transitent. */
  async function poll() {
    try {
      var query = '?after=' + lastId + (since ? '&since=' + encodeURIComponent(since) : '');
      var fresh = await call('GET', base + '/messages' + query);
      var record = kind === 'modmail' ? fresh.thread : fresh.ticket;
      var changed = merge(fresh);
      if (changed) renderMessages(orderedMessages());
      // Un nouveau message décale les échéances (reping, clôture) ; une prise en charge change les boutons et
      // l'accès à la réponse : l'en-tête (et au besoin la zone de réponse) est alors redessiné.
      var key = record.claimedBy ? record.claimedBy.id : '';
      if (changed || record.status !== recordStatus || key !== claimKey) renderHead(record);
      if (record.status !== recordStatus || key !== claimKey) {
        recordStatus = record.status;
        claimKey = key;
        setupReply(record, liveEnabled);
      }
      if (record.status !== 'open') stopPolling();
    } catch (err) {
      /* échec silencieux d'un sondage : on retentera au prochain tick */
    }
  }

  async function start() {
    if (!recordId) {
      showError(kind === 'modmail' ? 'Identifiant de fil modmail manquant dans l’adresse.' : 'Identifiant de ticket manquant dans l’adresse.');
      return;
    }
    try {
      var session = await Core.ready;
      meId = session.me ? session.me.id : null;
      var result = await call('GET', base);
      var record = kind === 'modmail' ? result.thread : result.ticket;
      canManage = Boolean(result.canManage);
      guildId = record.guildId || '';
      claimKey = record.claimedBy ? record.claimedBy.id : '';
      merge(result);
      renderHead(record);
      renderMessages(orderedMessages());
      snippets = result.snippets || [];
      // Ticket : transcript live activé pour son type ; modmail : droit de répondre depuis le panel.
      liveEnabled = kind === 'modmail' ? Boolean(result.canReply) : Boolean(result.liveTranscript);
      setupReply(record, liveEnabled);
      recordStatus = record.status;
      if (recordStatus === 'open') pollTimer = setInterval(poll, 4000);
    } catch (err) {
      showError(err.message);
    }
  }

  window.addEventListener('beforeunload', function () {
    if (pollTimer) clearInterval(pollTimer);
    if (countdownTimer) clearInterval(countdownTimer);
  });

  start();
})();

