'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');

const DISCORD_API = 'https://discord.com/api/v10';
const SESSION_COOKIE = 'mtb.sid';

function safeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

function isApiRequest(req) {
  return /\/api\//.test(req.originalUrl) || req.accepts(['html', 'json']) === 'json';
}

/**
 * Authentification Discord OAuth2 (scope "identify") + contrôle d'accès par liste
 * blanche d'IDs Discord (AUTHORIZED_WEB_USERS). Tout ID absent de la liste reçoit une 403.
 */
function createAuth(core, publicDir, { onLogin } = {}) {
  const { config } = core;
  const log = core.logger.child('web:auth');
  const { clientId, clientSecret } = config.discord;
  const { callbackUrl, authorizedUsers } = config.web;
  const callbackPath = new URL(callbackUrl).pathname;
  const forbiddenPage = path.join(publicDir, 'forbidden.html');
  const router = express.Router();

  async function exchangeCode(code) {
    const response = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl,
      }),
    });
    if (!response.ok) {
      throw new Error(`Échange du code OAuth2 refusé (${response.status}) : ${await response.text()}`);
    }
    return response.json();
  }

  async function fetchIdentity(accessToken) {
    const response = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`Lecture du profil Discord impossible (${response.status})`);
    return response.json();
  }

  router.get('/auth/login', (req, res, next) => {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;
    // `?next=` : page à rouvrir après la connexion (chemin local uniquement, jamais une autre origine).
    if (typeof req.query.next === 'string') req.session.returnTo = safeReturnTo(req.query.next);
    const url = new URL('https://discord.com/oauth2/authorize');
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl,
      response_type: 'code',
      scope: 'identify',
      state,
      prompt: 'none',
    }).toString();
    req.session.save((err) => (err ? next(err) : res.redirect(url.toString())));
  });

  router.get(callbackPath, async (req, res, next) => {
    const { code, state, error } = req.query;
    if (error) return res.redirect('/login?erreur=annule');
    const expectedState = req.session.oauthState;
    delete req.session.oauthState;
    if (typeof code !== 'string' || typeof state !== 'string' || !expectedState || state !== expectedState) {
      return res.redirect('/login?erreur=etat');
    }

    let identity;
    try {
      const token = await exchangeCode(code);
      identity = await fetchIdentity(token.access_token);
    } catch (err) {
      log.error('Échec de la connexion OAuth2', err);
      return res.redirect('/login?erreur=oauth');
    }

    if (!authorizedUsers.has(identity.id)) {
      log.warn(`Accès refusé au dashboard : ${identity.username} (${identity.id})`);
      return req.session.regenerate(() => res.status(403).sendFile(forbiddenPage));
    }

    const returnTo = safeReturnTo(req.session.returnTo);
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = {
        id: identity.id,
        username: identity.username,
        globalName: identity.global_name ?? null,
        avatar: identity.avatar ?? null,
      };
      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);
        log.info(`Connexion au dashboard : ${identity.username} (${identity.id})`);
        onLogin?.(req.session.user);
        res.redirect(returnTo);
      });
    });
  });

  router.post('/auth/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie(SESSION_COOKIE);
      res.redirect('/login');
    });
  });

  /** Middleware : exige une session valide appartenant à un utilisateur autorisé. */
  function requireAuth(req, res, next) {
    const user = req.session?.user;
    if (user && authorizedUsers.has(user.id)) return next();

    if (user) {
      // L'utilisateur a été retiré de AUTHORIZED_WEB_USERS depuis sa connexion.
      return req.session.destroy(() => {
        if (isApiRequest(req)) return res.status(403).json({ error: 'Accès refusé' });
        return res.status(403).sendFile(forbiddenPage);
      });
    }

    if (isApiRequest(req)) return res.status(401).json({ error: 'Non authentifié' });
    // Seule une navigation vers une page mémorise l'adresse de retour (pas les images, scripts…).
    const isPageNavigation = req.method === 'GET' && (req.get('accept') || '').includes('text/html');
    if (!isPageNavigation) return res.redirect('/login');
    req.session.returnTo = req.originalUrl;
    return req.session.save(() => res.redirect('/login'));
  }

  function isAuthenticated(req) {
    const user = req.session?.user;
    return Boolean(user && authorizedUsers.has(user.id));
  }

  return { router, requireAuth, isAuthenticated };
}

module.exports = { createAuth, SESSION_COOKIE, safeReturnTo };
