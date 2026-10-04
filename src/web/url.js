'use strict';

/**
 * Adresse publique du dashboard, déduite de WEB_CALLBACK_URL (null si le panel web est désactivé ou l'URL
 * invalide). Sans proxy inverse (TRUST_PROXY), le port réellement écouté (config.web.port, ex. SERVER_PORT en
 * conteneur Docker) fait foi plutôt que celui de l'URL de callback : si WEB_CALLBACK_URL a été renseigné sans
 * port dans le .env, `.origin` seul le perdrait et le lien envoyé serait injoignable. Derrière un proxy, le port
 * public peut légitimement différer : on garde alors celui de l'URL de callback.
 */
function webBaseUrl(config) {
  if (!config.web.enabled) return null;
  try {
    const url = new URL(config.web.callbackUrl);
    if (config.web.trustProxy) return url.origin;
    return `${url.protocol}//${url.hostname}:${config.web.port}`;
  } catch {
    return null;
  }
}

/** Lien absolu vers une page du dashboard (`path` sans « / » initial), ou null. */
function webUrl(config, path = '') {
  const base = webBaseUrl(config);
  return base ? `${base}/${path}` : null;
}

module.exports = { webBaseUrl, webUrl };
