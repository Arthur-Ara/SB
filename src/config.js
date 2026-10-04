'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const rootDir = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(rootDir, '.env') });

const SNOWFLAKE = /^\d{17,20}$/;

function str(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return fallback;
  return value.trim();
}

function required(name) {
  const value = str(name);
  if (value === undefined) {
    throw new Error(`Variable d'environnement manquante : ${name} (voir .env.example)`);
  }
  return value;
}

function int(name, fallback) {
  const value = str(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`La variable ${name} doit être un entier (reçu : "${value}")`);
  }
  return parsed;
}

function bool(name, fallback) {
  const value = str(name);
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'oui', 'on'].includes(value.toLowerCase());
}

function list(name) {
  return (str(name, '') || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function snowflakeList(name) {
  const values = list(name);
  const invalid = values.filter((value) => !SNOWFLAKE.test(value));
  if (invalid.length) {
    console.warn(`[config] ${name} contient des IDs Discord invalides, ignorés : ${invalid.join(', ')}`);
  }
  return values.filter((value) => SNOWFLAKE.test(value));
}

// Dans un conteneur Docker de panel (Pterodactyl, Pelican…), le port attribué au serveur
// est fourni par SERVER_PORT : il est prioritaire sur WEB_PORT.
const dockerPort = int('SERVER_PORT', null);
const configuredWebPort = int('WEB_PORT', null);
const webPort = dockerPort ?? configuredWebPort ?? 3000;
const webPortSource = dockerPort ? 'SERVER_PORT' : configuredWebPort ? 'WEB_PORT' : 'défaut';
if (dockerPort && configuredWebPort && dockerPort !== configuredWebPort) {
  console.warn(`[config] WEB_PORT=${configuredWebPort} ignoré : le port du conteneur (SERVER_PORT=${dockerPort}) est utilisé.`);
}
// IP publique de l'allocation Docker, utilisée pour l'URL de callback par défaut.
const serverIp = str('SERVER_IP');
const defaultHost = serverIp && serverIp !== '0.0.0.0' ? serverIp : 'localhost';

// Les commandes sont désormais publiées uniquement de façon globale.
for (const obsolete of ['DEV_GUILD_ID', 'COMMANDS_GUILD_ID']) {
  if (str(obsolete)) {
    console.warn(`[config] ${obsolete} n'est plus utilisée : les commandes sont publiées globalement (copies de serveur supprimées).`);
  }
}

const authorizedWebUsers = snowflakeList('AUTHORIZED_WEB_USERS');
const botOwners = snowflakeList('BOT_OWNERS');
const sessionSecret = str('SESSION_SECRET');

const config = {
  rootDir,
  env: { str, required, int, bool, list, snowflakeList },

  discord: {
    token: required('DISCORD_BOT_TOKEN'),
    clientId: required('DISCORD_CLIENT_ID'),
    clientSecret: required('DISCORD_CLIENT_SECRET'),
  },

  db: {
    host: str('DB_HOST', 'localhost'),
    port: int('DB_PORT', 3306),
    user: str('DB_USER', 'root'),
    password: str('DB_PASSWORD', ''),
    database: str('DB_NAME', 'discord_bot_db'),
  },

  web: {
    enabled: bool('WEB_ENABLED', true),
    port: webPort,
    portSource: webPortSource,
    callbackUrl: str('WEB_CALLBACK_URL', `http://${defaultHost}:${webPort}/auth/discord/callback`),
    sessionSecret: sessionSecret || crypto.randomBytes(48).toString('hex'),
    sessionSecretGenerated: !sessionSecret,
    trustProxy: bool('TRUST_PROXY', false),
    authorizedUsers: new Set(authorizedWebUsers),
  },

  // Propriétaires du bot : autorisés à gérer les modules via /modules.
  owners: new Set(botOwners.length ? botOwners : authorizedWebUsers),

  modules: {
    disabled: new Set(list('DISABLED_MODULES')),
  },
};

module.exports = config;
