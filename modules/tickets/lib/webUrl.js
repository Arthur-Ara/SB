'use strict';

const { webBaseUrl, webUrl } = require('../../../src/web/url');

/** Lien vers une page du panel Tickets (`/m/tickets/<path>`), ou null si le panel web est indisponible. */
function ticketsUrl(config, path = '') {
  return webUrl(config, `m/tickets/${path}`);
}

module.exports = { webBaseUrl, ticketsUrl };
