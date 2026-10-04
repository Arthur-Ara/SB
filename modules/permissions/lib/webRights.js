'use strict';

/**
 * Catalogue des catégories et droits du panel web, pour /permission grant-panel/revoke-panel/list-panel
 * et pour la vérification d'accès de chaque module (voir lib/webAccess.js#hasWebRight). Découpage
 * volontairement plus fin pour Tickets (module le plus riche côté panel web à ce jour) ; les autres
 * modules gardent un simple view/manage, à affiner plus tard module par module si besoin.
 */
const WEB_CATEGORIES = {
  tickets: {
    label: 'Tickets',
    rights: {
      'view-tickets': 'Voir la liste des tickets (ouverts et historique)',
      'view-transcripts': 'Voir les transcriptions',
      'reply-live': 'Répondre depuis le panel (transcript live)',
      'manage-tickets': 'Fermer un ticket / supprimer un salon',
      'manage-panels': 'Créer, modifier, publier les panels et leurs types',
      'manage-settings': 'Réglages du module (salon de journal, admins)',
    },
  },
  whitelist: {
    label: 'Whitelist Vocal',
    rights: {
      view: 'Voir la configuration des salons',
      manage: 'Modifier la configuration (salons, réglages, admins)',
    },
  },
  laisse: {
    label: 'Laisse',
    rights: {
      view: 'Voir qui est en laisse',
      manage: 'Modifier les laisses, réglages et admins',
    },
  },
  moderation: {
    label: 'Modération',
    rights: {
      view: 'Voir les bannis, avertissements, salons verrouillés, shadow-bans, mutes vocaux',
      manage: 'Effectuer des actions (ban, warn, lock, shadow-ban, unmute…)',
    },
  },
  rolemenu: {
    label: 'RôleMenu',
    rights: {
      view: 'Voir les menus de rôles et leur configuration',
      manage: 'Créer, modifier, publier et supprimer les menus et leurs conditions',
    },
  },
  stats: {
    label: 'Statistiques',
    rights: {
      view: 'Voir le dashboard de statistiques et les rapports',
      manage: 'Régler les rapports hebdomadaires et le suivi des invitations',
    },
  },
  servermanager: {
    label: 'Server Manager',
    rights: {
      view: 'Voir le journal des modifications, l’historique des rollbacks et les sauvegardes',
      rollback: 'Lancer des rollbacks (droits Discord de l’auteur toujours vérifiés)',
      backup: 'Créer, restaurer et supprimer des sauvegardes',
      manage: 'Réglages du module (salon de journal, sauvegardes automatiques)',
    },
  },
  support: {
    label: 'Support automatique',
    rights: {
      view: 'Voir la configuration du support automatique',
      manage: 'Modifier la configuration (panels, catégories, réponses)',
    },
  },
};

function categoryLabel(category) {
  return WEB_CATEGORIES[category]?.label ?? category;
}

function rightLabel(category, right) {
  if (!right) return 'tous les droits';
  return WEB_CATEGORIES[category]?.rights?.[right] ?? right;
}

function categoryChoices() {
  return Object.entries(WEB_CATEGORIES).map(([value, def]) => ({ name: def.label, value }));
}

function rightChoices(category) {
  const def = WEB_CATEGORIES[category];
  if (!def) return [];
  return Object.entries(def.rights).map(([value, label]) => ({ name: label.slice(0, 100), value }));
}

module.exports = { WEB_CATEGORIES, categoryLabel, rightLabel, categoryChoices, rightChoices };
