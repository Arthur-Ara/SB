'use strict';

const SNOWFLAKE = /^\d{17,20}$/;
const TYPE_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;
const MAX_ROLES_PER_CONDITION = 10;
const DAY_MS = 86_400_000;

function mentions(ids) {
  return ids.map((id) => `<@&${id}>`).join(', ');
}

function parseParams(text) {
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

/**
 * Conditions fournies d'origine. Une condition est { label, description, params, summary(params), check(member, params) }
 * où `params` décrit les champs configurables : { key, kind: 'roles' | 'number', label, min?, max? }.
 */
const BUILTINS = {
  has_roles: {
    label: 'Avoir tous ces rôles',
    description: 'Le membre doit posséder chacun des rôles listés.',
    params: [{ key: 'roles', kind: 'roles', label: 'Rôles requis' }],
    summary: (p) => `Avoir tous les rôles : ${mentions(p.roles)}`,
    check: (member, p) => {
      const missing = p.roles.filter((id) => !member.roles.cache.has(id));
      return missing.length ? { ok: false, reason: `Il te faut le ou les rôles ${mentions(missing)}.` } : { ok: true };
    },
  },
  has_any_role: {
    label: 'Avoir au moins un de ces rôles',
    description: 'Un seul des rôles listés suffit.',
    params: [{ key: 'roles', kind: 'roles', label: 'Rôles acceptés' }],
    summary: (p) => `Avoir l’un des rôles : ${mentions(p.roles)}`,
    check: (member, p) =>
      p.roles.some((id) => member.roles.cache.has(id)) ? { ok: true } : { ok: false, reason: `Il te faut l’un de ces rôles : ${mentions(p.roles)}.` },
  },
  lacks_roles: {
    label: 'Ne pas avoir ces rôles',
    description: 'Le membre ne doit posséder aucun des rôles listés.',
    params: [{ key: 'roles', kind: 'roles', label: 'Rôles interdits' }],
    summary: (p) => `Ne pas avoir : ${mentions(p.roles)}`,
    check: (member, p) => {
      const held = p.roles.filter((id) => member.roles.cache.has(id));
      return held.length ? { ok: false, reason: `Tu ne peux pas le prendre avec le ou les rôles ${mentions(held)}.` } : { ok: true };
    },
  },
  member_days: {
    label: 'Ancienneté sur le serveur',
    description: 'Être arrivé sur le serveur il y a au moins N jours.',
    params: [{ key: 'days', kind: 'number', label: 'Jours sur le serveur', min: 1, max: 3650 }],
    summary: (p) => `Sur le serveur depuis au moins ${p.days} jour(s)`,
    check: (member, p) => {
      const days = member.joinedTimestamp ? (Date.now() - member.joinedTimestamp) / DAY_MS : 0;
      return days >= p.days ? { ok: true } : { ok: false, reason: `Il faut être sur le serveur depuis au moins ${p.days} jour(s) (tu y es depuis ${Math.floor(days)}).` };
    },
  },
  account_days: {
    label: 'Ancienneté du compte Discord',
    description: 'Avoir un compte Discord créé il y a au moins N jours.',
    params: [{ key: 'days', kind: 'number', label: 'Jours depuis la création du compte', min: 1, max: 36500 }],
    summary: (p) => `Compte Discord de plus de ${p.days} jour(s)`,
    check: (member, p) => {
      const days = (Date.now() - member.user.createdTimestamp) / DAY_MS;
      return days >= p.days ? { ok: true } : { ok: false, reason: `Ton compte Discord doit avoir au moins ${p.days} jour(s).` };
    },
  },
  booster: {
    label: 'Booster du serveur',
    description: 'Le membre doit booster le serveur.',
    params: [],
    summary: () => 'Être booster du serveur',
    check: (member) => (member.premiumSince ? { ok: true } : { ok: false, reason: 'Ce rôle est réservé aux boosters du serveur.' }),
  },
};

/**
 * Registre des conditions d'accès. D'autres modules (système de niveaux, gestion d'invitations…) peuvent y
 * ajouter les leurs sans toucher à RôleMenu, depuis leur `ready(ctx)` :
 *
 *   ctx.modules.services('rolemenu')?.conditions.register('level', {
 *     label: 'Niveau minimum', description: '…',
 *     params: [{ key: 'level', kind: 'number', label: 'Niveau', min: 1, max: 1000 }],
 *     summary: (p) => `Niveau ${p.level} minimum`,
 *     check: async (member, p) => (await levelOf(member) >= p.level ? { ok: true } : { ok: false, reason: '…' }),
 *   });
 *
 * Une condition enregistrée en base mais dont le type n'existe plus (module retiré) **bloque** l'accès au rôle.
 */
class ConditionRegistry {
  constructor() {
    this.types = new Map();
    for (const [type, definition] of Object.entries(BUILTINS)) this.register(type, definition, 'rolemenu');
  }

  register(type, definition, source = 'externe') {
    if (!TYPE_PATTERN.test(type)) throw new Error(`Type de condition invalide : « ${type} »`);
    if (typeof definition?.check !== 'function' || !Array.isArray(definition.params) || !definition.label) {
      throw new Error(`Condition « ${type} » incomplète : label, params[] et check() sont requis`);
    }
    this.types.set(type, { summary: () => definition.label, description: '', ...definition, type, source });
  }

  unregister(type) {
    return this.types.delete(type);
  }

  has(type) {
    return this.types.has(type);
  }

  /** Description sérialisable des types disponibles (menus du panel web et de la commande). */
  list() {
    return [...this.types.values()].map((def) => ({
      type: def.type,
      label: def.label,
      description: def.description,
      params: def.params.map((p) => ({ key: p.key, kind: p.kind, label: p.label, min: p.min ?? null, max: p.max ?? null })),
      source: def.source,
    }));
  }

  /** Vérifie et normalise les paramètres saisis. @returns {{ params: object } | { error: string }} */
  validate(type, raw, guild) {
    const def = this.types.get(type);
    if (!def) return { error: `Type de condition inconnu : « ${type} ».` };
    const params = {};
    for (const spec of def.params) {
      const value = raw?.[spec.key];
      if (spec.kind === 'roles') {
        const ids = [...new Set((Array.isArray(value) ? value : value ? [value] : []).map(String))];
        if (!ids.length) return { error: `${spec.label} : choisis au moins un rôle.` };
        if (ids.length > MAX_ROLES_PER_CONDITION) return { error: `${spec.label} : ${MAX_ROLES_PER_CONDITION} rôles au maximum.` };
        if (ids.some((id) => !SNOWFLAKE.test(id) || !guild.roles.cache.has(id))) return { error: `${spec.label} : rôle introuvable sur ce serveur.` };
        params[spec.key] = ids;
      } else if (spec.kind === 'number') {
        const number = Number(value);
        const min = spec.min ?? 0;
        const max = spec.max ?? 1_000_000;
        if (value === null || value === undefined || value === '' || !Number.isInteger(number) || number < min || number > max) {
          return { error: `${spec.label} : un nombre entier entre ${min} et ${max} est attendu.` };
        }
        params[spec.key] = number;
      } else {
        return { error: `Paramètre « ${spec.key} » de type inconnu.` };
      }
    }
    const custom = def.validate?.(params, guild);
    if (typeof custom === 'string' && custom) return { error: custom };
    return { params };
  }

  summarize(type, params) {
    const def = this.types.get(type);
    if (!def) return `Condition « ${type} » indisponible (bloque l’accès)`;
    try {
      return def.summary(params);
    } catch {
      return def.label;
    }
  }

  /** Évalue une condition pour un membre. Toute erreur ou type inconnu **refuse** (sécurité par défaut). */
  async check(type, params, member) {
    const def = this.types.get(type);
    if (!def) return { ok: false, reason: 'Une condition de ce rôle est indisponible pour le moment : contacte un administrateur.' };
    try {
      const verdict = await def.check(member, params);
      return verdict?.ok ? { ok: true } : { ok: false, reason: verdict?.reason ?? 'Condition non remplie.' };
    } catch {
      return { ok: false, reason: 'Une condition n’a pas pu être vérifiée pour le moment : réessaie plus tard.' };
    }
  }
}

module.exports = { ConditionRegistry, parseParams };
