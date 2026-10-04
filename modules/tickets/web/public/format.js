/* Mise en forme Discord minimale, partagée entre le panel (aperçu d'embed) et la page transcript. */
(function () {
  'use strict';

  function escapeHtml(text) {
    return text.replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Émojis personnalisés : <:nom:id> ou <a:nom:id> (animé).
  var CUSTOM_EMOJI = /<(a?):(\w{2,32}):(\d{15,25})>/g;

  function emojiUrl(id, animated) {
    return 'https://cdn.discordapp.com/emojis/' + id + (animated ? '.gif' : '.webp') + '?size=64&quality=lossless';
  }

  /** Vrai si le message ne contient que des émojis (unicode ou personnalisés) : Discord les affiche alors en grand. */
  function isEmojiOnly(raw) {
    var text = String(raw == null ? '' : raw).replace(CUSTOM_EMOJI, '').replace(/\s+/g, '');
    if (!text && /<a?:\w{2,32}:\d{15,25}>/.test(String(raw))) return true;
    if (!text) return false;
    try {
      return /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️)+$/u.test(text) && !/^[\d#*]+$/.test(text);
    } catch (e) {
      return false;
    }
  }

  /** Markdown Discord minimal : blocs de code, code, gras, italique, souligné, barré, liens, mentions (non résolues), émojis. */
  function renderContent(raw, mentions) {
    mentions = mentions || {};
    var users = mentions.users || {};
    var roles = mentions.roles || {};
    var channels = mentions.channels || {};
    var source = raw == null ? '' : String(raw);
    var text = escapeHtml(source);

    // Les émojis sont mis de côté avant le reste du markdown (leur nom peut contenir des « _ »), puis réinjectés.
    var emojis = [];
    text = text.replace(/&lt;(a?):(\w{2,32}):(\d{15,25})&gt;/g, function (m, animated, name, id) {
      emojis.push('<img class="emoji" src="' + emojiUrl(id, animated === 'a') + '" alt=":' + name + ':" title=":' + name + ':" loading="lazy" />');
      return '\u0000E' + (emojis.length - 1) + '\u0000';
    });

    text = text.replace(/```(?:\w+\n)?([\s\S]*?)```/g, function (m, code) { return '<pre>' + code + '</pre>'; });
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    text = text.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__([^_]+)__/g, '<u>$1</u>');
    text = text.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    text = text.replace(/\b_([^_\n]+)_\b/g, '<em>$1</em>');
    text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    text = text.replace(/&gt;&gt;&gt; ([\s\S]+)$/, '<blockquote>$1</blockquote>');
    text = text.replace(/(^|\n)&gt; (.*)/g, '$1<blockquote>$2</blockquote>');
    function pill(prefix, entry, fallback) {
      var color = entry && entry.color && /^#[0-9a-f]{6}$/i.test(entry.color) ? ' style="color:' + entry.color + ';background:' + entry.color + '26"' : '';
      return '<span class="mention"' + color + '>' + prefix + escapeHtml(entry && entry.name ? entry.name : fallback) + '</span>';
    }
    text = text.replace(/&lt;@!?(\d+)&gt;/g, function (m, id) { return pill('@', users[id], 'utilisateur'); });
    text = text.replace(/&lt;@&amp;(\d+)&gt;/g, function (m, id) { return pill('@', roles[id], 'rôle'); });
    text = text.replace(/&lt;#(\d+)&gt;/g, function (m, id) { return pill('#', channels[id], 'salon'); });
    text = text.replace(/@(everyone|here)\b/g, '<span class="mention">@$1</span>');
    text = text.replace(/&lt;t:(-?\d+)(?::[tTdDfFR])?&gt;/g, function (m, seconds) {
      var date = new Date(Number(seconds) * 1000);
      return '<span class="mention">' + (isNaN(date.getTime()) ? '—' : date.toLocaleString('fr-FR')) + '</span>';
    });
    text = text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');

    return text.replace(/\u0000E(\d+)\u0000/g, function (m, index) { return emojis[Number(index)] || ''; });
  }

  window.TicketFormat = { renderContent: renderContent, escapeHtml: escapeHtml, isEmojiOnly: isEmojiOnly };
})();
