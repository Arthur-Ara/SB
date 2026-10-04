'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function write(level, scope, args) {
  if (LEVELS[level] < threshold) return;
  const prefix = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  out(prefix, ...args);
}

function createLogger(scope) {
  return {
    scope,
    debug: (...args) => write('debug', scope, args),
    info: (...args) => write('info', scope, args),
    warn: (...args) => write('warn', scope, args),
    error: (...args) => write('error', scope, args),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

module.exports = { createLogger };
