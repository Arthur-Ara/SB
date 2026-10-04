(function () {
  'use strict';
  var el = Core.el;
  var fmt = Core.fmt;

  function tile(label, value, sub) {
    return el(
      'div',
      { class: 'card tile' },
      el('div', { class: 'tile-label', text: label }),
      el('div', { class: 'tile-value' }, value),
      sub ? el('div', { class: 'tile-sub', text: sub }) : null,
    );
  }

  async function load() {
    try {
      await Core.ready;
      var status = await Core.api('/api/status');
      document.getElementById('bot-tag').textContent = status.tag ? 'Connecté en tant que ' + status.tag : '';

      Core.clear(document.getElementById('status-tiles')).append(
        tile('Bot', el('span', {}, el('span', { class: 'status-dot' + (status.online ? ' on' : '') }), ' ', status.online ? 'En ligne' : 'Hors ligne')),
        tile('Serveurs', fmt.number(status.guilds)),
        tile('Latence', status.ping >= 0 ? fmt.number(status.ping) + ' ms' : '—'),
        tile('Disponibilité', status.uptime ? fmt.duration(status.uptime / 1000) : '—'),
      );

      var grid = Core.clear(document.getElementById('modules'));
      if (!status.modules.length) grid.append(el('div', { class: 'card empty', text: 'Aucun module chargé.' }));
      status.modules.forEach(function (module) {
        var body = [
          el('h2', { text: module.label }),
          el('p', { class: 'muted', text: module.description || '—' }),
          el(
            'div',
            { class: 'muted' },
            el('span', { class: 'badge', text: module.loaded ? 'Actif' : 'Déchargé' }),
            ' ',
            module.commands.length ? module.commands.map(function (c) { return '/' + c; }).join(' · ') : 'Aucune commande',
          ),
        ];
        grid.append(
          module.hasWeb
            ? el('a', { class: 'card module-card', href: '/m/' + module.name + '/' }, body)
            : el('div', { class: 'card module-card' }, body),
        );
      });
    } catch (err) {
      var box = document.getElementById('error');
      box.textContent = err.message;
      box.hidden = false;
    }
  }

  load();
})();
