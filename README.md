# SciensBot

Bot Discord modulaire (slash commands uniquement) accompagné d'un dashboard web centralisé, réservé à une liste de membres de confiance.
Spécifications : [main.md](main.md) (architecture globale), [style.md](style.md) (charte graphique),
[stats.md](stats.md) (module Statistiques) et [permissions.md](permissions.md) (module Permissions).

- **Bot** : Node.js + discord.js v14, gestionnaires dynamiques de commandes, d'événements et de modules.
- **Base de données** : MySQL 8 (ou MariaDB 10.6+), migrations SQL appliquées automatiquement au démarrage.
- **Dashboard** : Express, connexion Discord OAuth2, accès limité aux IDs de `AUTHORIZED_WEB_USERS` (sinon erreur 403),
  graphiques Chart.js. Chaque compte n'y voit que les serveurs dont il est membre (les propriétaires du bot voient tout),
  selon ses droits `/permission grant-panel`.
- **Changelog** : [changelog.json](changelog.json), affiché dans l'onglet « Changelog » du dashboard — **page publique**
  (`/changelog`, sans connexion), filtrable par module et par catégorie — et publié sur Discord avec `/changelog` —
  **à compléter à chaque mise à jour** (voir [Changelog](#changelog)).

## Installation

### 1. Application Discord (https://discord.com/developers/applications)

1. Créez une application, puis dans l'onglet **Bot** copiez le token (`DISCORD_BOT_TOKEN`).
2. Toujours dans **Bot**, activez les *Privileged Gateway Intents* :
   - **Server Members Intent** (arrivées/départs, rôles, pseudos, ancienneté) ;
   - **Message Content Intent** (longueur des messages, `@everyone` / `@here`).
3. Dans **OAuth2**, copiez le *Client ID* et le *Client Secret*, et ajoutez l'URL de redirection
   `http://localhost:3000/auth/discord/callback` (identique à `WEB_CALLBACK_URL`).
4. Au démarrage, le bot affiche son lien d'invitation dans les logs. Il demande les permissions utilisées par les modules
   (jamais *Administrateur*) : lire/écrire dans les salons, intégrer des liens et fichiers, réactions, *Gérer les messages*,
   *Gérer les salons*, *Gérer les rôles*, *Gérer les webhooks*, *Voir les logs du serveur*, expulser, bannir, exclure
   temporairement, couper le micro et déplacer des membres. Le rôle du bot doit être placé au-dessus des rôles qu'il gère.

### 2. Lancement

Prérequis : Node.js 18.17 ou plus récent, un serveur MySQL accessible.

```bash
npm install
cp .env.example .env      # Windows : copy .env.example .env
# compléter .env (token, client ID/secret, MySQL, AUTHORIZED_WEB_USERS…)
npm start
```

La base `DB_NAME` est créée si l'utilisateur MySQL en a le droit, puis les tables sont créées par les migrations.
Le dashboard est ensuite disponible sur `http://localhost:3000`.

`npm run check` vérifie la syntaxe de tous les fichiers JavaScript ; `npm test` lance les tests automatiques
(`test/*.test.js`, lanceur intégré de Node, sans dépendance : durées, plages horaires, automod, verrou par clé,
cohérence du changelog et de `package.json`, catalogue des droits du panel, validité de toutes les slash commands).

Mise à jour depuis une version précédente : remplacer les fichiers (sans écraser `.env`), `npm install`, redémarrer —
les nouvelles tables et colonnes sont créées automatiquement par les migrations. Depuis la 1.3.0, l'invitation du bot
demande aussi **Gérer le serveur** (suivi des invitations du module Statistiques) : l'ajouter au rôle du bot si besoin.

### Hébergement sur un panel Docker (Pterodactyl, Pelican…)

- Fichier à lancer : `src/index.js` (ou commande `npm start`).
- Le dashboard écoute automatiquement sur le port attribué au serveur (variable `SERVER_PORT` du conteneur) ; `WEB_PORT` est alors ignoré.
- `WEB_CALLBACK_URL` doit reprendre l'IP publique et ce même port : `http://IP_DU_SERVEUR:PORT/auth/discord/callback`
  (laissée vide, elle est construite à partir de `SERVER_IP`). Un avertissement s'affiche au démarrage si les ports ne correspondent pas.

## Architecture

```
src/
  index.js               point d'entrée : base, modules, client Discord, web
  config.js              lecture et validation du .env
  core/
    database.js          pool MySQL (UTC) + exécuteur de migrations
    moduleManager.js     découverte, cycle de vie et interface web des modules
    commandHandler.js    slash commands : chargement / déchargement / rechargement + publication
    eventHandler.js      redistribution des événements Discord aux modules
    migrations/          tables du cœur (sessions web)
    changelog.js         lecture de changelog.json (onglet Changelog et /changelog)
    keyedMutex.js        verrou par clé (anti-doublons : tickets, modmail, whitelist)
    duration.js          durées « 30m, 2h, 7j, 2sem » (ban temporaire, /lock, accès temporaires, rollback…)
    schedule.js          plages horaires (tickets, whitelist vocale)
  bot/commands/          commandes du cœur (/help, /modules, /panel, /changelog)
  bot/ui.js              charte des réponses du bot (embeds sombres, pagination)
  bot/text.js            utilitaires de texte (noms de salons)
  web/                   serveur Express, OAuth2, pages communes (connexion, 403, accueil, changelog)
  web/helpers.js         utilitaires des routes web des modules (erreurs, validation, avatars)
  web/url.js             adresse publique du dashboard (liens envoyés sur Discord)
  web/activity.js        journal d'activité du panel (connexions et actions)
changelog.json           journal des versions — une entrée par mise à jour
test/                    tests automatiques (npm test)
modules/
  permissions/           module Permissions (toujours actif)
  stats/                 module Statistiques
  laisse/                module Laisse (désactivé par défaut)
  whitelist/             module Whitelist Vocal (désactivé par défaut)
  moderation/            module Modération (désactivé par défaut)
  tickets/               module Tickets (désactivé par défaut)
  support/               module Support Automatique (désactivé par défaut)
  servermanager/         module Server Manager : journal, /rollback, sauvegardes, panel web (désactivé par défaut)
  rolemenu/              module RôleMenu : menus de rôles + conditions d'accès (désactivé par défaut)
  candidature/           module Candidatures : panels, statuts, recruteurs, transcriptions (désactivé par défaut)
```

Un module peut consulter en lecture les services d'un autre via `ctx.modules.services('nom-du-module')` (renvoie
`null` si ce module est inconnu, désactivé ou pas encore initialisé — à toujours traiter comme « aucune information
disponible », jamais comme une erreur). Le module Whitelist Vocal l'utilise pour lire l'état du module Laisse ; le
module Support Automatique l'utilise pour lire les types de tickets et ouvrir un ticket (module Tickets). Pour une
fonction utilitaire **sans état** (ex. `modules/tickets/lib/embed.js#buildEmbed`, qui ne dépend que de ses
arguments) ou une fonction qui n'a besoin que de `ctx.services` d'un autre module (ex.
`modules/tickets/lib/lifecycle.js#openTicket`, appelée avec `{ services: ctx.modules.services('tickets') }` en guise
de `ctx`), un `require()` direct du fichier `lib/` cible reste acceptable — voir `modules/support/` pour un exemple
complet des deux approches.

### Ajouter un module

Créez `modules/<nom>/index.js` :

```js
module.exports = {
  name: 'moderation',
  label: 'Modération',
  emoji: '🔨',
  description: '…',
  defaultEnabled: true,              // actif par défaut sur les serveurs (sinon à activer via /modules)
  required: false,                   // true = impossible à désactiver sur un serveur
  intents: [],                       // intents Discord nécessaires (fusionnés avec ceux des autres modules)
  async init(ctx) {},                // avant la connexion à Discord (ctx.db, ctx.client, ctx.logger, ctx.services…)
  async ready(ctx) {},               // une fois le bot connecté
  async shutdown(ctx) {},            // arrêt propre
  web: { label: 'Modération', register(router, ctx) {} }, // optionnel : pages sous /m/moderation/
};
```

puis, au besoin, les dossiers `commands/` (un fichier par slash command : `{ data, execute(ctx, interaction) }`),
`events/` (`{ event, execute(ctx, ...args) }`) et `migrations/` (fichiers `.sql` appliqués dans l'ordre alphabétique).

Conventions communes à respecter :

- **Accès aux commandes** : uniquement via `permission: { default: 'admin' | 'everyone' }` et le module Permissions —
  pas de `setDefaultMemberPermissions` (Discord masquerait la commande même à un rôle autorisé par `/permission grant`).
- **Routes web** : `guildAccess(ctx, { module, category, label })` de `modules/permissions/lib/webAccess.js` fournit
  `guild(req, droit)` (serveur visé, module activé, compte membre du serveur, droit `/permission grant-panel`),
  `check(req, guild, droit)` et `guilds(req)` ; déclarer la catégorie et ses droits dans
  `modules/permissions/lib/webRights.js`. Utilitaires : `src/web/helpers.js` (`HttpError`, `wrap`, validation des salons,
  couleurs et images). Côté navigateur : `Core.request`, `Core.confirm` et `Core.prompt` (`src/web/public/core.js`) et les
  composants communs de `core.css` (onglets `.tabs`/`.tab-btn`, `.toolbar`, `.filters`, `.btn-danger`…).
- **Salon recréé** : si le module mémorise des salons (journal, panels publiés), exposer
  `ctx.services.onChannelReplaced(guild, ancienId, nouveauSalon, auteur)` → libellés de ce qui a été rattaché ;
  `/purge` l'appelle pour chaque module (`ctx.modules.callHook`).
- **Notifications du panel** : exposer `ctx.services.webNotifications(userId)` → `[{ emoji, text, guildName, href, at }]`
  (en vérifiant les droits du compte avec `hasWebRight`) ; la cloche de la barre du haut les agrège (`/api/notifications`).

### Panel web : activité, notifications, connexion

- **Activité** (`/activity`) : connexions et actions (requêtes qui modifient quelque chose) du panel, avec module,
  serveur et résultat, conservées 90 jours, sans adresse IP. Les propriétaires du bot voient tous les comptes, les
  autres comptes uniquement leurs propres actions.
- **Notifications** (🔔) : tickets en attente d'une réponse du staff, conversations modmail ouvertes, messages bloqués
  par l'automod (24 h), nouveaux rapports hebdomadaires — seulement pour les serveurs et modules accessibles au compte.
  Le compteur repart de zéro à l'ouverture de la liste (mémorisé dans le navigateur).
- **Retour à l'origine** : après une connexion (lien direct, session expirée), le panel rouvre la page demandée.
- **Téléphone** : sous 820 px de large, les modules de la barre du haut passent dans un menu ☰ (liste verticale).

Les slash commands sont publiées **globalement** à chaque démarrage. Les éventuelles copies enregistrées sur un serveur
(ancien mode « serveur de test ») sont supprimées automatiquement pour éviter les doublons. Si une nouvelle commande
n'apparaît pas tout de suite, relancez Discord (Ctrl+R).

### Commandes du cœur

- `/help` — sélecteur par module : la liste des commandes **publiques** que vous pouvez utiliser (modules actifs et
  permissions pris en compte), avec un menu pour voir le détail des sous-commandes. Si vous avez accès à des commandes
  **administratives** (`/modules`, `/laisse-admin`…), un bouton « 🛡️ Commandes admin » ouvre une page séparée qui les
  liste ; ce bouton n'apparaît pas sinon.
- `/modules` — panneau avec sélecteur pour activer ou désactiver les modules **sur ce serveur** (administrateurs par défaut).
  Un module désactivé ne reçoit plus les événements du serveur et ses commandes y sont refusées. Les propriétaires du bot
  (`BOT_OWNERS`, ou à défaut `AUTHORIZED_WEB_USERS`) disposent en plus d'un menu pour recharger à chaud les commandes et
  événements d'un module. `DISABLED_MODULES` désactive un module pour tout le bot au démarrage.
- `/panel` — lien du dashboard (réponse visible uniquement par l'auteur, avec l'indication de son autorisation d'accès).
  L'adresse est déduite de `WEB_CALLBACK_URL`.
- `/changelog [version] [apercu]` — publie dans le salon la liste des modifications d'une version (la dernière par
  défaut, autocomplétion des versions) en composants v2 sombres, regroupées par catégorie, avec un bouton vers le
  changelog complet du dashboard ; découpée en plusieurs messages si elle dépasse la limite de Discord. `apercu` : réponse
  visible seulement par l'auteur. Administrateurs par défaut.

## Changelog

[changelog.json](changelog.json) est la source unique de l'onglet **Changelog** du dashboard et de `/changelog`.
La page `/changelog` du dashboard est **publique** (aucune connexion requise, seule page dans ce cas avec sa route
`/api/changelog`) : n'y écrire que des textes destinés à tout le monde. Elle se filtre par **version**, par module
(sélecteur, ou clic sur une étiquette) et par catégorie ; lien partageable `/changelog?version=1.3.4&module=tickets`.
Le sélecteur de versions va de la plus ancienne à la plus récente, chaque version (v1.0) suivie de ses correctifs en
retrait (v1.0.1, v1.0.2…).
Sous le titre de chaque version, les étiquettes des modules concernés (aussi dans `/changelog` sur Discord).
**À chaque mise à jour du bot**, ajouter une entrée **en tête** du tableau et passer la même version dans
`package.json` (un avertissement s'affiche au démarrage si les deux ne correspondent pas) :

```json
{
  "version": "1.2.0",
  "date": "2026-10-10",
  "title": "Titre court de la mise à jour",
  "changes": [{ "type": "fix", "module": "tickets", "text": "Ce qui change, en une phrase." }]
}
```

`type` : `feature` (nouveautés), `security`, `fix`, `perf`, `style` (interface), `change`. `module` : nom d'un module
(`tickets`, `moderation`…), `core` (Général) ou `web` (Panel web). Le fichier est relu à chaud : pas besoin de redémarrer.

## Charte graphique ([style.md](style.md))

- **Dashboard** : thème sombre par défaut (fond `#09090B`, cartes en verre dépoli, bordures `rgba(255,255,255,0.1)`, coins de 12 px),
  accent indigo `#6366F1` / violet `#8B5CF6`, polices Inter et JetBrains Mono (auto-hébergées via `@fontsource-variable`),
  KPI en gras et en grand, micro-animations (désactivées si le système demande de réduire les animations).
  Le thème clair reste disponible via le bouton ☀/☾ de la barre supérieure.
- **Graphiques** : courbes lissées, dégradé sous la courbe, quadrillage horizontal très discret ; émeraude `#10B981` pour les
  hausses (arrivées, croissance), rose `#F43F5E` pour les baisses et suppressions (départs, messages supprimés, sanctions).
- **Bot** : embeds sombres centralisés dans [src/bot/ui.js](src/bot/ui.js) — barre invisible `#2B2D31`, titre « ・ … (n) »,
  blocs de code aux valeurs bleues (`Total: 2`), éléments « **⚙️ Élément n°1** » avec lignes à émojis (⌚ 👤 🔊) et dates
  Discord, bloc de détails en bleu, notifications d'une ligne (« ✅ … », « ⚠️ … », « ❌ … »), boutons sous l'embed et
  pagination « ❮ ❯ » avec indicateur « 1/3 ».

## Module Permissions ([permissions.md](permissions.md))

Un middleware du gestionnaire de commandes vérifie l'accès avant chaque slash command, dans cet ordre :

1. règle individuelle (`user-grant` / `user-revoke`) ;
2. rôles du membre : un rôle autorisé suffit, sinon un rôle révoqué bloque ;
3. commande rendue publique sur le serveur ;
4. accès par défaut de la commande : `everyone` (ex. `/panel`) ou, pour les commandes sensibles (`/stats`, `/permission`…),
   administrateurs du serveur uniquement.

Le propriétaire du serveur garde toujours l'accès à `/permission` (pour ne jamais se bloquer). Le module ne peut pas être
désactivé par serveur ; s'il est déchargé par un propriétaire du bot, aucun contrôle n'est appliqué.

| Commande | Effet |
|---|---|
| `/permission list <rank\|user> [id]` | vue globale des rôles/utilisateurs ayant des règles, ou détail pour un rôle/utilisateur |
| `/permission grant <role> <command>` / `revoke` | autorise / interdit une ou plusieurs commandes (ou `module.*`) pour un rôle |
| `/permission user-grant <user> <command>` / `user-revoke` | autorise / interdit pour un utilisateur (prioritaire sur les rôles) |
| `/permission public <command>` | rend une commande publique (ou annule) |
| `/permission purge` | efface toutes les règles du serveur, après confirmation par bouton |
| `/permission check <user> <command>` | explique pourquoi ce membre peut (ou non) utiliser la commande : règle qui a tranché, rôle concerné, échéance, module désactivé |
| `/permission clone <source> <cible> [remplacer]` | copie les règles (commandes et panel web) d'un rôle vers un autre |
| `/permission template-save <nom> <role> [description]` | enregistre les règles d'un rôle comme **modèle** réutilisable |
| `/permission template-apply <nom> <role> [remplacer]` · `template-list` · `template-delete <nom>` | applique / liste / supprime les modèles |

**Accords temporaires** : `grant`, `user-grant` et `grant-panel` acceptent une option `duree` (`2h`, `3j`, `2sem`…, 1 an
max) ; la règle est retirée automatiquement à l'échéance (elle cesse de s'appliquer à l'instant même, la ligne est
effacée par un balayage minute). Une autorisation **permanente** déjà en place n'est jamais remplacée par une temporaire.
Modèles : table `permissions_templates` (instantané sans échéance) ; sans `remplacer`, un modèle ou une copie complète
les règles existantes du rôle cible au lieu de les effacer.

**Ajout en masse** : `command` accepte plusieurs commandes séparées par une virgule (l'autocomplétion complète la
dernière). `grant`/`revoke` visent **un seul rôle** à la fois ; `user-grant`/`user-revoke` acceptent jusqu'à 5
utilisateurs (`user` + `user2`…`user5`).

**Joker `module.*`** (ex. `moderation.*`, proposé par l'autocomplétion et sur le panel) : une seule règle pour
**toutes les commandes d'un module**, y compris celles ajoutées plus tard — inutile de rendre la personne admin du
module. Une règle sur une commande précise l'emporte sur le joker (ex. `moderation.*` autorisé mais `/ban` interdit).
Les commandes dont l'accès dépend d'un statut d'admin propre au module (`/laisse-admin`, `/whitelist`, parties admin
de `/ticket`) gardent ce contrôle en plus. `/permission public` avec un joker rend publique chaque commande actuelle
du module.

`grant-panel`/`revoke-panel` fonctionnent différemment : **un seul rôle à la fois**, car l'usage typique est
d'enchaîner plusieurs droits sur ce même rôle (`categorie` et `droit` acceptent chacun plusieurs valeurs séparées par
une virgule, avec autocomplétion qui complète la dernière) plutôt que de viser plusieurs rôles d'un coup — pas de
`role2`…`role5` ici.

Tables : `permissions_users`, `permissions_roles`, `permissions_public`. Pour qu'une commande déclare son accès par défaut,
ajoutez `permission: { default: 'everyone' }` (ou `'admin'`, valeur par défaut) dans son fichier.

### Accès au panel web (`/permission grant-panel`)

Système **distinct** de ce qui précède : celui-ci ne contrôle pas les commandes Discord mais ce qu'un rôle peut voir ou
faire **sur le panel web**, par catégorie (généralement un module) et par droit précis (ex. pour Tickets : voir la
liste des tickets, voir les transcriptions, répondre en live, gérer les tickets, gérer les panels, gérer les
réglages — les autres modules ont un simple `view`/`manage`). `AUTHORIZED_WEB_USERS` reste la porte d'entrée du
dashboard ; un compte autorisé n'y voit que les serveurs **dont il est membre** (les propriétaires du bot voient tout).
Tant qu'aucun accès n'est configuré pour une catégorie, tout membre autorisé y garde un accès complet. Une fois un rôle
configuré sur une catégorie, seuls les membres de ce rôle (+ administrateurs et propriétaires du serveur/bot, toujours
autorisés) y ont accès.

| Commande | Effet |
|---|---|
| `/permission grant-panel <role> [categorie] [droit]` | autorise un rôle sur le panel web (catégorie/droit vides = tout) |
| `/permission revoke-panel <role> [categorie] [droit]` | retire un accès panel web |
| `/permission list-panel` | affiche les accès panel web configurés sur le serveur |

Table : `web_permission_grants`. Catalogue des catégories/droits : `modules/permissions/lib/webRights.js` ; vérification
d'accès : `modules/permissions/lib/webAccess.js#hasWebRight` (via `guildAccess`), appliquée par les routes web de
tous les modules : Tickets, Support automatique, RôleMenu, Modération, Whitelist Vocal, Laisse et Statistiques.
`/permission purge` efface aussi ces accès.

### Édition depuis le panel web (`/m/permissions/`)

Toutes ces règles se modifient aussi depuis le panel web, **réservé aux administrateurs du serveur, à son propriétaire et aux
propriétaires du bot** (un droit délégué sur le panel ne permet jamais de changer les droits) : 6 onglets — commandes par rôle,
commandes par utilisateur (ID Discord), commandes publiques, accès au panel web, **modèles et copie** de rôle, et
**vérifier un accès** (équivalent de `/permission check`). Les accords temporaires y sont signalés par leur échéance (⏳). On y choisit un rôle (ou @everyone) ou un
utilisateur, **une ou plusieurs commandes** (regroupées par module) et l'action (autoriser, interdire, retirer la règle) ; chaque
règle existante se retire d'un clic sur le ×. Mêmes règles, même priorité et même cache que les commandes Discord.

**Affichage des listes** (`/permission list`, `list-panel` et le panel) : regroupées **par rôle** ; les commandes y sont
regroupées par module et les droits du panel par catégorie, séparés par une virgule (ex. `📂 **Tickets** : Voir la liste des
tickets, Voir les transcriptions`).

## Module Laisse

Quand un membre est « en laisse » d'un autre, les deux sont toujours dans le même salon vocal lorsqu'ils sont en vocal :
si le maître rejoint ou change de salon, ses membres en laisse (déjà en vocal) le suivent ; si un membre en laisse
rejoint un autre salon, il est ramené auprès de son maître. Les chaînes (A tient B qui tient C) fonctionnent ; les boucles
sont refusées. **Désactivé par défaut** : à activer par serveur avec `/modules`. Le bot doit avoir la permission
**Déplacer des membres**.

Les commandes publiques (`/laisse`) et les commandes d'administration (`/laisse-admin`) sont deux commandes séparées,
pour qu'elles soient faciles à distinguer dans le client Discord (autocomplétion, `/help`, journaux…) — `/laisse-admin`
n'est même pas listée pour un membre qui n'est pas admin du module.

| Commande | Qui | Effet |
|---|---|---|
| `/laisse add` / `remove <user>` | autorisés | ajoute / retire un membre de sa laisse (un membre n'est que dans une seule liste) |
| `/laisse list` · `/laisse clear` | autorisés | sa laisse avec le salon de chacun (`#Vocal (n)`) · vide sa laisse |
| `/laisse-admin allow` / `deny <user>` | admins | autorise / interdit le mode laisse (`deny` vide aussi sa laisse) |
| `/laisse-admin limit <user> <nombre>` · `global-limit <nombre>` | admins | limite personnelle · limite par défaut (3) |
| `/laisse-admin add <user> <user2>` · `remove <user>` | admins | met `user` dans la laisse de `user2` (sans limite) · libère `user` |
| `/laisse-admin immune <etat> [user]` | admins | reste en laisse mais n'est plus déplacé |
| `/laisse-admin godmode <etat> [user]` | admins | ne peut plus être mis en laisse (retiré de sa liste actuelle) |
| `/laisse-admin log <salon>` | admins | journal des déplacements et des commandes (hors affichages) |
| `/laisse-admin set <user>` | admins | ajoute / retire un admin du module |
| `/laisse-admin clear <user>` · `list <user>` · `clear-all` | admins | vide / affiche la laisse d'un membre · vide tout (confirmation) |
| `/laisse-admin view-allowed` · `view-immune` · `view-godmode` | admins | listes avec qui a ajouté chaque membre et quand |
| `/laisse-admin isdog <user>` · `/imdog` | admins · tous | ce membre / moi : en laisse de qui ? |
| `/laisse-admin leash-leasher <etat>` | admins | autoriser à mettre en laisse ceux qui peuvent mettre en laisse (défaut : oui ; `false` les libère) |

Admins du module : membres ajoutés via `/laisse-admin set`, administrateurs du serveur, propriétaire du serveur et
propriétaires du bot. Quand un membre quitte le serveur, il sort de sa laisse et sa propre laisse est vidée.

### Panel web (`/m/laisse/`)

Interface équivalente à `/laisse-admin`, pour gérer le module sans passer par Discord : qui est en laisse de qui (avec le
salon vocal de chacun), réglages (limite par défaut, leash-leasher, salon de journal), et les quatre listes de statuts
(autorisés, immunisés, god mode, admins du module) — chacune avec un ajout par ID et un retrait en un clic. Toute
modification faite depuis le panel est journalisée sur Discord comme depuis une commande, attribuée au nom du membre
connecté au dashboard. Seuls les serveurs où le module est activé, dont le compte est membre et pour lesquels il a le
droit `laisse` de `/permission grant-panel` apparaissent dans le sélecteur. Un lien maître ↔ membre ajouté depuis le
panel exige que les deux soient membres du serveur.

## Module Whitelist Vocal

Restreint l'accès de certains salons vocaux à une liste de membres et/ou de rôles, et/ou limite leur nombre de places —
les personnes non autorisées ou en trop sont **déconnectées automatiquement** (pas de blocage préventif à la connexion :
la personne rejoint puis est aussitôt expulsée). Configuration **propre à chaque salon**. **Désactivé par défaut** : à
activer par serveur avec `/modules`. Le bot doit avoir la permission **Déplacer des membres**.

- **Whitelist** : si activée sur un salon, seuls les membres ajoutés individuellement ou possédant un rôle whitelisté
  peuvent y rester.
- **Limite de places** : indépendante de la whitelist (un salon peut avoir l'une, l'autre, ou les deux). Vérifiée à
  chaque arrivée : si le nombre de membres comptés dépasse la limite, le dernier arrivé est expulsé. Une limite
  abaissée ne réexpulse pas les membres déjà présents ; elle ne s'applique qu'aux arrivées suivantes.
- **Exemptions** (whitelist et limite, jamais comptés, jamais expulsés) : les bots, les admins du module, et les
  membres actuellement déplacés par le module Laisse (un membre en laisse dont le maître est dans le même salon) —
  lu en direct via `ctx.modules.services('laisse')`, sans dépendance obligatoire à ce module.
- **Admins du module** : membres ajoutés via `/whitelist admin set`, administrateurs du serveur, propriétaire du
  serveur et propriétaires du bot. Seuls eux peuvent utiliser `/whitelist`.

### Configuration (`/whitelist channel <salon>`)

Ouvre un embed interactif propre au salon choisi : bouton pour activer/désactiver la whitelist, bouton qui ouvre une
fenêtre (modal) pour définir la limite de places, un **sélecteur de membres** et un **sélecteur de rôles** natifs
Discord (pré-remplis avec la liste actuelle, 25 maximum chacun — au-delà, utiliser le panel web). **Rien n'est
appliqué immédiatement** : chaque contrôle ne modifie qu'un brouillon affiché dans le panel (un bandeau signale les
modifications non enregistrées) ; seul le bouton **💾 Sauvegarder** écrit en base et publie **un seul log groupé**
résumant tous les changements (whitelist, limite, membres, rôles) — pour des journaux clairs et faciles à lire au
lieu d'une ligne par clic. Un bouton **↩️ Annuler les modifications** revient à l'état enregistré, et un bouton de
réinitialisation (avec confirmation) reste immédiat, avec son propre log.

| Commande | Effet |
|---|---|
| `/whitelist channel <salon>` | ouvre la configuration interactive du salon |
| `/whitelist list` | liste paginée des salons configurés (whitelist, limite, effectifs) |
| `/whitelist log <salon>` | salon de journal des expulsions et des commandes |
| `/whitelist admin set <user>` | ajoute / retire un admin du module |
| `/whitelist admin list` | liste les admins du module |
| `/whitelist admin salon <salon> <user>` | ajoute / retire un **admin limité à ce salon** (y entre librement, peut y inviter) |
| `/whitelist invite <salon> <user> <duree>` | **accès temporaire** (30 j max), aussi ouvert aux admins du salon ; le membre est revérifié à l'échéance |
| `/whitelist uninvite <salon> <user>` | retire un accès temporaire avant son échéance |
| `/whitelist horaire <salon> [debut] [fin] [fuseau]` | restrictions (whitelist et limite) actives **seulement sur cette plage** (ex. 20:00 → 02:00) ; sans heures : en permanence |

Au début de la plage horaire d'un salon, tous les membres présents sont revérifiés (balayage minute) ; en dehors, le salon
est ouvert. Les accès temporaires sont conservés quand la liste permanente est modifiée (Discord ou panel). Le panel web
propose les mêmes réglages (plage, accès temporaires, admins du salon) sous l'éditeur de chaque salon, appliqués aussitôt.

### Panel web (`/m/whitelist/`)

Accès : membres du serveur ayant le droit `whitelist` de `/permission grant-panel` (`view` / `manage`).
Un sélecteur de salon vocal (tous les salons du serveur, configurés ou non) ouvre son éditeur : case whitelist,
limite de places, membres whitelistés (ajout par ID, retrait en un clic) et rôles whitelistés (cases à cocher). Comme
sur Discord, ces contrôles ne modifient qu'un brouillon local ; un bouton **💾 Enregistrer les modifications** écrit
tout en base en un seul appel et publie **un seul log groupé** sur Discord, et **↩️ Annuler les modifications** revient
à l'état enregistré. Changer de salon ou de serveur avec des modifications en attente demande une confirmation. Le
bouton de réinitialisation reste immédiat (son propre log). Un tableau récapitule tous les salons vocaux ; les
réglages (salon de journal) et les admins du module — actions ponctuelles, hors de ce brouillon — se gèrent en
dessous et restent immédiats.

## Module Modération

Sanctions, verrouillages de salons et historique de modération. **Désactivé par défaut** : à activer par serveur avec
`/modules`. **Aucun concept d'admin propre au module** côté Discord : contrairement à Laisse ou Whitelist Vocal,
l'accès à chacune des 19 commandes se règle **exclusivement via `/permission`** (chaque commande vaut `admin` par
défaut, à ajuster avec `/permission grant`/`refuse`) — c'est aussi pour ça qu'aucune de ces commandes n'apparaît sous
« 🛡️ Commandes admin » dans `/help` : cette section est réservée aux commandes qui dépendent d'un statut d'admin
*du module* (comme `/laisse-admin`), pas d'un simple défaut `/permission`. Aucune commande ne porte de permission Discord
par défaut : `/permission grant` suffit à ouvrir une commande à un rôle. Le panel web (voir plus bas) est réservé aux
membres du serveur ayant le droit `moderation` (`view` pour consulter, `manage` pour agir) de `/permission grant-panel`.

Toutes les commandes vérifient une hiérarchie de sécurité de base (impossible de sanctionner le bot, soi-même, le
propriétaire du serveur, ou un membre au rôle égal ou supérieur au sien — sauf le propriétaire) et publient un log
détaillé dans le salon défini par `/modlogs`. Un message privé n'est envoyé à la cible **que si l'option `dm` est
cochée** (faux par défaut ; best-effort, silencieux si les DM sont fermés) sur ban, kick, tempmute, tempvocmute, warn,
shadow-ban et blacklist. Chaque sanction porte un **identifiant** (`#id`, affiché dans la confirmation, le log,
`/history` et `/modlogs`) et peut recevoir des **preuves** : option `preuve` (lien d'un message Discord, contenu copié à
l'ajout) sur les mêmes commandes, ou après coup avec `/sanction preuve-ajouter <id> <lien>` ; `/sanction voir <id>`
affiche le détail et les preuves, `/sanction preuve-retirer <id> <n°>` en retire une.

`/blacklist <user> [raison] [preuve] [dm]` — **réservée aux propriétaires du bot** (`BOT_OWNERS`), puisqu'elle agit sur
tous les serveurs — bannit l'utilisateur **sur tous les serveurs où le bot est présent** (et Modération activée),
l'inscrit sur une liste **globale** (un seul utilisateur = une seule entrée, tous serveurs confondus, pas par serveur),
et le re-bannit **automatiquement** s'il rejoint de nouveau, si son ban est levé à la main, ou s'il rejoint un serveur
que le bot rejoint plus tard. Chaque bannissement (sur chaque serveur concerné) est journalisé et visible dans `/history`
comme n'importe quelle sanction. `/unban` **échoue** sur un utilisateur blacklisté (message renvoyant vers
`/unblacklist`) : seul `/unblacklist <user>` (propriétaires du bot) retire l'entrée et lève les bannissements **posés par
la blacklist** (raison commençant par « Blacklist ») — un ban posé sur un serveur pour une autre raison reste en place.

| Commande | Effet |
|---|---|
| `/ban <user> [raison] [jours_messages]` | bannissement définitif |
| `/tempban <user> <duree> [raison] [jours_messages]` | bannissement temporaire (1 an max), levé automatiquement à l'échéance (jamais si l'utilisateur a été blacklisté entre-temps) |
| `/unban <id>` | débannissement à partir de l'identifiant (la personne n'est plus sur le serveur) |
| `/kick <user> [raison]` | expulsion |
| `/tempmute <user> <minutes> [raison]` | exclusion textuelle temporaire (`timeout` natif, max 28 jours) |
| `/unmute <user> [raison]` | lève l'exclusion textuelle **et/ou** le mute vocal temporaire en cours, selon ce qui est actif |
| `/tempvocmute <user> <minutes> [raison]` | coupe uniquement la parole en vocal (mute serveur), max 7 jours, levée automatique à l'échéance (balayage toutes les 60 s) |
| `/warn <user> <raison>` | avertissement (raison obligatoire), conservé dans l'historique |
| `/removewarn <user>` | menu déroulant des avertissements actifs du membre, retire celui choisi |
| `/lock [salon] [raison] [duree]` | bloque l'écriture pour @everyone dans le salon (par défaut : le salon courant) ; avec `duree`, déverrouillage automatique |
| `/unlock [salon] [raison]` | restaure précisément l'état d'avant verrouillage (et non un simple déblocage) |
| `/lockall [raison]` | verrouille tous les salons textuels du serveur |
| `/unlockall [raison]` | déverrouille tous les salons verrouillés par `/lock`/`/lockall` |
| `/clear <nombre> [user]` | supprime en masse (1-100, optionnellement filtré par auteur, respecte la limite de 14 jours de Discord) |
| `/purge [salon] [raison]` | recrée le salon à l'identique (vide tous les messages), **après confirmation** ; les journaux de tous les modules qui utilisaient ce salon, ainsi que les panels de tickets, panels de support et menus de rôles qui y étaient publiés, sont rattachés au nouveau salon (republiés) |
| `/shadow-ban <user> [raison]` | retire l'accès à tous les salons sauf un salon `prison-de-<pseudo>` créé dans une catégorie **Prison** (créée automatiquement au premier usage) |
| `/unshadow-ban <user> [raison]` | restaure l'accès à tous les salons et supprime le salon prison |
| `/slowmod <secondes> [salon]` | mode lent (0-21600 s, limite native Discord) |
| `/history [user]` | sans `user` : historique du salon courant (suppressions groupées, verrouillages…) ; avec `user` : actions qu'il a effectuées en tant que modérateur **et** subies en tant que sanctionné, paginé |
| `/modlogs <salon>` | définit le salon de journal du module |
| `/sanction modifier <id> [raison] [duree]` | modifie une sanction publiée (raison ; durée totale d'un ban temporaire, d'une exclusion ou d'un mute vocal encore actif) — trace « modifiée par » |
| `/sanction annuler <id> [raison]` | annule une sanction (avertissement, exclusion, mute vocal, ban, ban temporaire) : levée sur Discord + action inverse dans l'historique |
| `/note ajouter <user> <texte>` · `liste <user>` · `retirer <id>` | notes internes du staff sur un membre (jamais visibles par lui) |
| `/contester <sanction> <motif>` | (tout le monde) conteste une de ses sanctions des 30 derniers jours : ouvre un ticket du type choisi, une fois par sanction |

**Sanctions automatiques au cumul** (panel, onglet Général) : paliers « à N avertissements actifs → exclusion /
expulsion / ban / ban temporaire » ; un palier ne se déclenche qu'au moment où il est atteint (avertissement donné par
commande, depuis le panel ou par l'automod), au nom du bot.

**Contestation** : désactivée par défaut ; à activer sur le panel en choisissant le **type de ticket** qui reçoit les
contestations (module Tickets requis). Contestables : avertissement, exclusion, mute vocal, shadow-ban, automod.

**Automod « mots interdits »** (désactivé par défaut, onglet 🤖 Automod du panel) : liste de mots, seuil de similarité
(100 % = mot exact ; 80 % ≈ une faute sur cinq lettres), action (suppression seule, + avertissement, + exclusion
temporaire), rôles et salons exemptés (administrateurs et membres pouvant gérer les messages toujours exemptés). La
comparaison ignore accents et majuscules, convertit le leet speak (`c0nn@rd`), réduit les lettres répétées et recolle
les lettres espacées ou séparées par des signes ; un mot interdit contenu dans un mot plus long (5 lettres et plus) est
aussi détecté. Chaque message bloqué est listé sur le panel avec le mot détecté et le score ; **« Faux positif »**
ajoute le mot aux mots autorisés (plus jamais bloqué). Les messages modifiés sont aussi analysés. Un outil de test
simule la décision sans rien bloquer.

### Panel web (`/m/moderation/`)

Tableau de bord qui reprend les sanctions actives et leurs actions : **bannis** (**tous** les bannis du serveur, sans limite de date : la liste est lue en entier sur Discord par paquets de
1000 ; raison, qui a banni et quand viennent de la base du bot, sinon du module Statistiques, sinon du journal d'audit — 45 jours
au plus —, et restent vides pour un ancien ban fait hors du bot ; liste mise en cache une minute, « 🔄 Actualiser » la
relit sur Discord) avec recherche (nom, ID, raison), formulaire de bannissement et bouton débannir, **avertissements**
actifs avec formulaire et retrait, **salons verrouillés** avec sélecteur pour en verrouiller un nouveau, **shadow-bans**
avec formulaire et levée (même logique que les commandes : l'état de chaque salon est mémorisé puis restauré), et
**mutes vocaux temporaires actifs** avec échéance affichée et levée manuelle. Accès : membres du serveur ayant le droit
`moderation` de `/permission grant-panel` (`view` / `manage`) ; la hiérarchie des rôles est vérifiée comme sur Discord.
Chaque action publie un log dans le salon défini par `/modlogs`, identique aux logs Discord mais annoté « 🌐 depuis le
panel web ». Le formulaire de bannissement accepte une **durée** (ban temporaire, échéance affichée dans la liste) et celui
de verrouillage aussi ; chaque ligne de l'historique propose **Modifier** et **Annuler** ; l'onglet Joueur affiche les
**notes internes** du membre (ajout, suppression) au-dessus de son historique.

## Module Server Manager ([servermanager.md](servermanager.md))

Journal des modifications du serveur (salons, rôles, rôles des membres — avec leur auteur, lu dans le journal d'audit)
et **`/rollback <type> <duree> [utilisateur] [simulation]`** pour les annuler. **Désactivé par défaut** (`/modules`).

- `type` : `all`, `rank` (rôles : création, suppression — recréé et rendu à ses porteurs —, modification, ajout/retrait
  aux membres), `channel` (salons : création, suppression, modification dont permissions) ou `moderation` (bans,
  exclusions, avertissements, shadow-bans, verrouillages).
- `duree` : `30m`, `2h`, `1d`… (7 j maximum) ; `utilisateur` : n'annule que les actions de cette personne.
- Toujours un **aperçu** d'abord (ce qui sera fait / ignoré et pourquoi), puis bouton, puis — pour `all`, une
  suppression ou plus de 10 actions — saisie d'un code `ROLLBACK <n>`. L'exécution est re-simulée juste avant : si
  l'état a changé depuis l'aperçu, rien n'est exécuté. Bouton 🛑 pour arrêter en cours de route.
- **Garde-fous** : droits Discord de l'auteur par type et par ligne, hiérarchie des rôles (actions d'un auteur de rang
  supérieur ou égal intouchables), pas d'escalade de permissions, jamais d'écrasement d'une modification plus récente,
  suppressions limitées aux salons vides, actions du bot exclues, 60 actions max, un seul rollback à la fois avec délai
  de 120 s, coupe-circuit après 5 échecs, blacklist jamais levée, journal + rapport de chaque rollback.
- **Tickets et modmail exclus** : leurs salons (création, déplacement, permissions, suppression) ne sont ni journalisés,
  ni proposés par un rollback, ni sauvegardés ou recréés par une restauration — le module Tickets les gère seul.
- `/rollbackconfig [salon]` (salon de journal, état du journal), `/rollbackhistory` (rollbacks passés).
- Variables facultatives : `SERVERMANAGER_MAX_WINDOW_HOURS` (168), `SERVERMANAGER_MAX_ACTIONS` (60),
  `SERVERMANAGER_RETENTION_DAYS` (30), `SERVERMANAGER_COOLDOWN_SECONDS` (120).
- Le bot doit avoir *Gérer les rôles*, *Gérer les salons*, *Bannir*, *Exclure temporairement*, *Rendre muet*,
  *Voir les logs du serveur*, et un rôle au-dessus de ceux à restaurer. Le journal ne couvre que les modifications
  survenues **depuis l'activation du module**.
- **Sauvegardes** (`/backup create [nom]`, `list`, `restore <id>`, `delete <id>`, `auto <actif> [intervalle] [garder]`) :
  instantané des rôles, des permissions de @everyone, des catégories et salons avec leurs permissions (ni messages, ni
  membres). Sauvegardes **automatiques** désactivées par défaut (toutes les N heures, les N plus récentes gardées ; les
  manuelles ne sont jamais purgées). La **restauration est non destructive** : elle recrée ce qui manque et rétablit les
  réglages de ce qui a changé, sans rien supprimer de ce qui a été créé depuis ; aperçu obligatoire, code
  `RESTAURER <id>`, permission *Administrateur* exigée, re-vérification juste avant l'exécution, jamais en même temps
  qu'un rollback. Les positions ne sont pas restaurées.
- **Panel web** (`/m/servermanager/`, droits `view`, `rollback`, `backup`, `manage` de `/permission grant-panel`) :
  rollback (aperçu, code de confirmation, suivi en direct avec arrêt), journal des modifications filtrable, historique
  et rapport de chaque rollback, sauvegardes (création, aperçu de restauration, suppression) et réglages. Le compte
  connecté doit être membre du serveur : ce sont **ses** droits Discord que le moteur vérifie, comme sur Discord.

## Module RôleMenu ([rolemenu.md](rolemenu.md))

Menus de rôles que les membres utilisent eux-mêmes (anciennement « Autorôle »). **Désactivé par défaut** (`/modules`).
Configurable **depuis Discord avec le panneau interactif de `/rolemenu`** (une seule commande, sans option : boutons,
sélecteurs de rôles et de salons, fenêtres de saisie) **ou depuis le panel web** (`/m/rolemenu/`) — mêmes validations
et même journal.

- **3 types** : réactions (emojis), boutons, menu déroulant.
- **2 modes** : plusieurs rôles (maximum facultatif) ou **un seul rôle parmi la liste** ; retrait possible ou non.
- **Conditions cumulables** (autant que voulu, **toutes requises**, sur un menu entier et/ou un seul rôle ; le membre
  refusé voit toutes celles qui lui manquent) : avoir tous / l'un de ces rôles, ne pas avoir tel rôle, ancienneté sur
  le serveur, ancienneté du compte, booster. Le **registre de conditions est extensible** :
  un futur système de niveaux ou d'invitations enregistre sa condition via
  `ctx.modules.services('rolemenu')?.conditions.register(…)` (voir rolemenu.md) et elle apparaît d'elle-même.
- **Garde-fous** : jamais `@everyone`, rôles d'intégration, rôles au-dessus du bot, rôles *Administrateur* ni rôles à
  permissions de gestion (sauf `ROLEMENU_ALLOW_SENSITIVE_ROLES=true`) — vérifié à la configuration **et** à chaque
  attribution ; impossible de rendre attribuable un rôle au-dessus du sien ; une ancienne copie de menu n'attribue plus rien.
- Le bot a besoin de *Gérer les rôles* (avec un rôle au-dessus des rôles distribués) ; pour les réactions, *Ajouter des
  réactions* et *Gérer les messages* (retrait des réactions refusées).
- **Renommage** : l'ancien module Autorôle est repris automatiquement (menus, conditions, activation, règles `/permission`,
  droits du panel, messages déjà publiés) ; supprimer l'ancien dossier `modules/autorole/` du serveur.

## Module Tickets

Panels de tickets **multi-types** : un panel (`/ticket createpanel` ouvre le panel web pour en créer/gérer) est un
message avec un ou plusieurs boutons **ou** un sélecteur, publié dans un salon. **Chaque bouton/option est un type de
ticket totalement indépendant** — sa propre catégorie, ses rôles modérateur/notifié/helper, sa limite de tickets
ouverts simultanés, son embed d'ouverture de ticket et ses réglages de transcript — un peu comme plusieurs panels en
un seul message (ex. bouton « Support » et bouton « Signalement » avec des équipes différentes). Un serveur peut avoir
plusieurs panels indépendants. **Désactivé par défaut**, à activer avec `/modules`.

- **Rôle modérateur** : accès complet au ticket — voir, écrire, fermer, **claim** (bouton « Prendre en charge » dans
  le ticket, sans commande dédiée), ajouter/retirer des membres (`/ticket add`/`remove`).
- **Rôle notifié** : mentionné une fois à l'ouverture du ticket, aucun accès particulier au-delà de ça.
- **Rôle helper** : voit et écrit dans le ticket, mais ne peut ni le fermer ni le claim ni ajouter/retirer des membres.
- **Admins du module** (`/ticket admin <user>`, toggle) : peuvent créer/gérer des panels, ont accès à **tous** les
  tickets par défaut (accès propagé aux tickets déjà ouverts à l'ajout/retrait, comme les administrateurs et
  propriétaires du serveur/bot, toujours admins implicitement).
- **Fermeture** : les modérateurs et admins peuvent toujours fermer ; l'ouvreur du ticket seulement si
  `user_can_close` est activé pour ce type (réglable sur le panel web). Un ticket fermé peut être **réouvert**
  (bouton « ↩️ Réouvrir » à côté de « Supprimer le salon », réservé mods/admins) : redéverrouille le salon et le
  repasse « ouvert », sans perdre l'historique.
- **Réglages par type** (panel web) : nom du salon **une fois pris en charge** et **une fois fermé** (mêmes
  placeholders que le nom d'ouverture + `{claimer}` ; vide = nom inchangé ; renommage non bloquant, Discord le limite
  à 2 fois / 10 min), **message de rappel** du reping personnalisable (`{staff}` `{user}` `{ticket}` `{number}`
  `{type}` `{channel}` ; les rôles sont mentionnés devant si `{staff}` est absent), et option **fermer
  automatiquement le ticket si le membre quitte le serveur**.
- **Obliger à prendre en charge pour répondre** (`claim_required`, réglable par type, désactivé par défaut) : le staff
  doit **prendre en charge** le ticket (🙋) avant de pouvoir y répondre — dans le salon Discord, avec `/ticket reponse`
  comme depuis le panel web —, sinon le message est supprimé et un avertissement s'affiche quelques secondes. (Jusqu'à
  la 1.3.0, cette règle découlait de la notation ; les types qui avaient la notation l'ont gardée activée.)
- **Notation de fin de ticket** (`rating_enabled`, réglable par type, désactivée par défaut) : une fois activée,
  l'ouvreur reçoit une **invitation en message privé** à noter le support reçu (1 à 5 étoiles,
  ou bouton **« Ne pas répondre »**, facultatif, jamais relancée, une seule fois) **une fois le ticket définitivement supprimé** (salon supprimé, pas
  simplement fermé — un ticket fermé peut encore être réouvert, ce qui rendrait une notation prématurée). La note
  (si donnée) apparaît dans l'historique du panel web, une tuile affiche la moyenne du serveur (tous types
  confondus), et l'onglet **⭐ Notations** détaille les moyennes par membre du staff (celui qui avait pris en charge
  le ticket), par type de ticket et tous les avis, le nombre d'avis étant indiqué entre parenthèses. **La notation n'est
  jamais demandée si le ticket n'a pas été pris en charge** (personne à noter), ni s'il a été fermé automatiquement.
- **Modmail** : le membre écrit en **message privé au bot** ; un salon est créé pour le staff dans la catégorie
  choisie. **Multi-catégories** (ex. « Support », « Signalement »), chacune avec sa propre catégorie Discord et ses
  propres rôles staff : si le serveur en a plusieurs, le membre choisit celle qui l'intéresse (menu déroulant en MP) ;
  une seule = automatique. **Choix du serveur** : si le membre partage plusieurs serveurs avec le modmail activé, un
  premier menu propose de choisir lequel contacter avant celui de la catégorie. Tout message écrit dans le salon
  staff est transmis au membre (✅ = remis, ❌ = DM fermés) ; `//` en début de message = note interne (jamais
  transmise). **Configuration uniquement sur le panel web** (activation générale + catégories — onglet dédié 📨
  Modmail) ; `/modmail ouvrir <user> <message> [categorie]` (le bot écrit en premier ; `categorie` requise seulement
  si plusieurs existent) et `/modmail fermer [raison]` ou bouton « Fermer le fil » restent sur Discord : le
  transcript (.txt) est publié dans le salon de journal des tickets puis le salon supprimé. Un fil est aussi fermé si
  le membre quitte le serveur.
- **Transcript modmail** : comme les tickets, chaque message (membre, staff, note interne, info système) est capturé
  et reste consultable sur le panel web après suppression du salon (`/m/tickets/transcript?modmail=<id>`, lien
  « 📄 Transcript » à côté du bouton « Fermer le fil » dans le salon staff, et listé dans l'onglet 📨 Modmail —
  fils ouverts/fermés). Le staff peut **répondre depuis le panel** (droit « répondre depuis le panel »), avec les
  réponses prédéfinies et l'option **anonyme**.
- **Modmail — compléments** : `/modmail anonyme <message>` (le membre voit « Staff » au lieu du nom), **message
  d'accueil** et **fermeture automatique sur inactivité** réglables par catégorie, et **préfixes de grade** : un
  préfixe par rôle (ex. `[Modo]`) ; le membre voit celui du **plus haut rôle** du staff qui en a un.
- **Modmail « panel uniquement »** (option par catégorie) : aucun salon Discord n'est créé ; les messages du membre
  s'affichent sur le panel (onglet 📨 Modmail → « Traiter »), où le staff répond (ou anonymement) et ferme le fil. Le
  journal reçoit un lien vers le transcript à l'ouverture et à la fermeture. Tout fil se ferme aussi depuis sa page
  transcript (droit « gérer les tickets »).
- **Formulaire d'ouverture** (par type, désactivé par défaut) : jusqu'à 5 questions posées dans une fenêtre avant la
  création du ticket ; les réponses sont affichées dans le ticket et son transcript.
- **Réponses prédéfinies** : `/ticket reponse <nom>` publie la réponse dans un simple embed du bot (placeholders
  `{user}` `{staff}` `{ticket}` `{number}` `{type}`) ; aussi dans la zone de réponse des transcripts.
- **Étiquettes** (`/ticket tag`, panel) pour classer les tickets. Leur **ordre est la priorité** (▲▼ sur le panel :
  la première est la plus prioritaire). Chaque étiquette peut, quand elle est posée : **déplacer** le ticket dans une
  autre catégorie Discord (retirée, le ticket revient dans la catégorie de son type — la plus prioritaire l'emporte),
  **mentionner des rôles**, et **ajouter un préfixe** au nom du salon (`urgent-ticket-0042-bob`).
- **Listes de tickets** : `/ticket list` (staff, éphémère) et `/ticket autolist [categorie]` (admins) qui publie dans
  le salon une liste **visible de tous** — « En attente de prise en charge » (seulement pour les types où la prise en
  charge est obligatoire), puis « Tickets ouverts » — triée par priorité des étiquettes puis par ancienneté. Chaque
  ticket indique **qui doit répondre** (💬 le staff : le membre a écrit en dernier ; 🕓 le membre : le staff a répondu).
  La liste est **mise à jour automatiquement** à chaque ouverture, prise en charge, fermeture, transfert ou étiquette,
  et recalculée toutes les `TICKETS_AUTOLIST_REFRESH_MINUTES` (5 par défaut, 0 = jamais) pour l'indicateur de réponse
  (supprimer le message arrête la liste). Le panel affiche la même information (colonne « À répondre »), actualisée
  chaque minute.
- **Liste noire** (`/ticket blacklist`, admins) qui empêche un membre d'ouvrir des tickets ou un modmail, **transfert**
  vers un autre type (bouton réservé aux modérateurs du ticket ; au choix, avec ou sans republier l'embed d'accueil du
  nouveau type) et **suppression automatique** des tickets fermés après N heures (réglable par type).
- **Historique** : recherche (texte, ouvreur, staff, type, étiquette, dates), pagination et colonne « pris en charge par ».

| Commande | Effet |
|---|---|
| `/ticket add <user>` / `remove <user>` | ajoute / retire un membre du ticket courant (mods du type + admins) |
| `/ticket close <raison>` | ferme le ticket courant (aussi disponible via le bouton 🔒 dans le ticket, avec une fenêtre pour la raison) |
| `/ticket delay` | affiche le temps restant avant le prochain reping et/ou la clôture automatique (ne compte jamais comme une réponse : n'affecte aucun délai) |
| `/ticket live` | lien vers la transcription en direct du ticket courant (consultable/répondable tant qu'il reste ouvert) |
| `/ticket list` | tickets ouverts que tu peux voir, triés par priorité des étiquettes (staff) |
| `/ticket autolist [categorie]` | publie une liste des tickets ouverts (d'un type, ou de tous) tenue à jour automatiquement (admins) |
| `/ticket createpanel` | lien vers le panel web pour créer/configurer un panel |
| `/ticket logs <salon>` | définit le salon de journal du module (commun à tous les panels/types) |
| `/ticket admin <user>` | ajoute / retire un admin du module |

Comme pour Modération, `/ticket add`/`remove`/`close` n'apparaissent pas sous « 🛡️ Commandes admin » dans `/help` :
leur accès dépend du ticket dans lequel elles sont lancées (rôles du type, admin du module), pas d'un statut fixe.

### Transcript

Si activé pour le type (`auto_transcript`), les messages du ticket sont capturés en direct (auteur, pseudo et couleur
de rôle **au moment de l'envoi**, contenu, embeds, pièces jointes téléchargées et servies par le panel — les liens
CDN Discord expirent) et restent consultables sur le panel web après suppression du salon — page dédiée qui simule
l'interface Discord (avatars, messages groupés, embeds, pièces jointes, images/gifs/vidéos), avec en en-tête le temps
restant avant le prochain reping et/ou la clôture automatique (mis à jour en direct). À la fermeture, un lien
« Voir le transcript » est proposé dans le salon si `transcript_prompt` est aussi activé (sinon le transcript est
généré silencieusement). **Rien n'est journalisé à la fermeture elle-même** : la clôture (et une éventuelle
réouverture) n'est qu'enregistrée en historique, et un seul log complet — récapitulant toutes les fermetures et
réouvertures — est publié **à la suppression du salon** (bouton « 🗑️ Supprimer le salon », qui ne supprime que le
salon Discord : la fiche et le transcript restent consultables tant que le ticket n'est pas supprimé). Un ticket
fermé mais jamais supprimé ne publie donc aucun log.

**Transcript live** (`live_transcript`) : tant que le ticket est ouvert, la page transcript se met à jour toutes les
4 secondes et affiche un champ pour **répondre depuis le panel web** — le message est envoyé dans le salon Discord du
ticket via un webhook du salon (créé à la volée), sous le **pseudo et la photo de profil Discord réels** de la
personne connectée au panel (repli sur un message classique du bot, préfixé `🌐 nom (panel web)`, si le bot n'a pas
la permission **Gérer les webhooks**), et journalisé comme n'importe quel autre message du transcript.

### Clôture automatique et reping

Deux délais optionnels, réglables **par type** (vide = désactivé) :
- **Clôture automatique** : compte dès l'ouverture du ticket (un ticket resté muet, ouvreur comme staff, est considéré
  abandonné) ou dès que le staff a répondu (en attente de l'ouvreur). **Le bot ne ferme plus d'office : il demande
  confirmation au staff** dans le salon (message avec boutons « 🔒 Confirmer la fermeture » / « ↩️ Garder ouvert »,
  mentionnant celui qui a pris le ticket en charge, sinon les modérateurs du type ; une seule demande tant que
  personne ne répond ni ne parle dans le ticket). « Confirmer » ferme exactement comme `/ticket close` (message de
  fermeture avec transcript / réouverture / suppression) ; « Garder ouvert » relance le délai. Un ticket fermé
  ainsi (ou parce que le membre a quitté le serveur) **ne déclenche aucune demande de notation** à la suppression.
  La notation n'est de toute façon **jamais demandée pour un ticket qui n'a pas été pris en charge**.
- **Reping** : ne compte qu'une fois que l'ouvreur a envoyé **au moins un message** et que le staff n'y a répondu
  depuis (jamais avant son premier message) ; se répète tant que ça reste sans réponse, au rythme du même délai.
  **Si le ticket est pris en charge, seul celui qui l'a pris est repingué** (pas les rôles) ; sinon, rôles repingués : réglables **par type**, indépendamment des rôles notifiés (case « mêmes rôles que les rôles
  notifiés », cochée par défaut) ; à défaut de rôle réglé, repli sur le(s) rôle(s) modérateur du type.

Les deux sont soumis à une **plage horaire d'activation propre à chaque panel** (réglable dans le panel concerné :
heure de début/fin + fuseau IANA) pour pouvoir désactiver tout le système la nuit, panel par panel ; sans plage
activée, le système tourne en permanence. Un balayage toutes les 60 s (même mécanisme que le `ModerationScheduler` du
module Modération) détecte les tickets concernés. `/ticket delay` (éphémère, ou l'en-tête de la page transcript)
affiche le temps restant sans jamais compter comme une réponse (les commandes slash ne déclenchent jamais le suivi
d'activité).

### Panel web (`/m/tickets/`)

Organisé en **6 onglets** (⚙️ Réglages, 🎫 Panels, 📨 Modmail, 📬 Tickets ouverts, 🗂️ Historique, ⭐ Notations) plutôt
qu'une seule page à rallonge — plus lisible, et plus confortable sur téléphone. Toute modification finale de la
configuration (panel, type, catégorie de modmail, admin du module) poste une carte dans le salon de journal — une
seule par sauvegarde, pas par champ modifié.

- **⚙️ Réglages** : salon de journal, admins du module.
- **🎫 Panels** : gestion complète des panels (embed d'ouverture avec aperçu formaté façon Discord, style
  boutons/sélecteur, bouton **Publier**/**Republier ici** pour l'envoyer dans un salon choisi) et de leurs types
  (sélecteur de rôles avec recherche, triés dans l'ordre d'affichage Discord, catégorie, limite, **format du nom des
  salons** (`{number}` `{username}`/`{user}` `{type}`, ex. `ticket-{number}-{username}`), embed d'ouverture de ticket
  avec aperçu formaté et placeholders `{user}` `{username}` `{type}` `{ticket}` `{number}` `{server}` `{category}`
  `{mods}` — les mentions (`{user}`, `{mods}`) ne s'affichent que dans la description, jamais dans le titre ni le
  pied de page, limitation Discord —, les réglages de transcript). Chaque panel se réduit d'un clic sur son en-tête.
  Chaque type se sauvegarde en un clic (pas de brouillon groupé comme sur Whitelist, pour limiter la complexité d'un
  module déjà volumineux).
- **📨 Modmail** : activation générale, **liste de catégories** (chacune : nom affiché au membre, catégorie Discord
  des salons, rôles staff — sélecteur de rôles avec recherche, ajout/suppression libres), fils ouverts et 100
  derniers fils fermés (lien direct vers leur transcript).
- **📬 Tickets ouverts** / **🗂️ Historique** : liste des tickets ouverts (**🙋 prendre en charge / relâcher** et **🔒 fermer** à distance — mêmes
  effets que sur Discord : nom du salon, journal, bouton du message d'accueil) et historique récent des tickets fermés (accès
  direct au transcript, réouverture, suppression du salon ; **ces deux boutons disparaissent une fois le salon supprimé**,
  remplacés par « Salon supprimé »). Les tickets ouverts sont présentés en **un bloc par catégorie** (type de ticket),
  même vide, avec le nombre de tickets à répondre et à prendre en charge.
- **Ce que chacun voit** : le droit du panel ouvre l'onglet, mais un membre du staff ne voit que les tickets **qu'il
  verrait sur Discord** — types dont il a un rôle mod/helper, tickets qu'il a ouverts, pris en charge ou auxquels il a
  été ajouté — et les fils modmail des catégories dont il est staff. Vaut pour la liste, l'historique, les
  transcripts (live compris), les pièces jointes, les actions et les notifications. Les admins (propriétaire, administrateur
  Discord, admin du module) voient tout. Les moyennes de notation restent globales ; la liste des avis est filtrée.
- **⭐ Notations** (3 sous-onglets) : **moyennes par membre du staff** (`4.3/5 ⭐⭐⭐⭐ (12)` : la moyenne puis, entre parenthèses, le
  nombre d'avis), **par type de ticket**, et **tous les avis** (ticket, staff, ouvreur, note, date) — voir « Notation de fin de
  ticket » plus haut.

**Republier un panel** (Tickets comme Support automatique) **supprime l'ancien message** : un panel n'a jamais qu'un seul
message actif, même si le nouveau est publié dans un autre salon.

Les pages transcript (`/m/tickets/transcript?ticket=<id>` pour un ticket, `?modmail=<id>` pour un fil modmail) sont
accessibles sans sélectionner de serveur au préalable (liens directs depuis Discord via `/ticket live`, le bouton
« 📄 Transcript » d'un fil modmail, ou les listes du panel) et rendent aussi la mise en forme Discord des messages.

## Module Support Automatique

FAQ interactive publiée sur Discord : un panel propose des **catégories** (menu déroulant), qui mènent soit à
**d'autres catégories** (sous-menu imbriqué, profondeur libre), soit à une **réponse** (embed avec la solution). Une
réponse peut proposer un bouton **« Créer un ticket »** si elle ne suffit pas (par exemple pour tout ce qui n'est pas
une simple information), ouvrant un type de ticket précis du module Tickets, avec un message automatique optionnel
pour prévenir le staff que la demande vient du support automatique. **Configuration entièrement sur le panel web**
(`/m/support/`) — aucune commande Discord de configuration, `/support` ne fait que renvoyer le lien du panel.

- **Navigation** : le premier clic sur le panel public ouvre un message éphémère (visible seulement par le membre) ;
  chaque clic suivant (sous-catégorie, retour) **met à jour ce même message** plutôt que d'en ouvrir un nouveau, pour
  une navigation fluide en un seul fil.
- **Réponse** : embed configurable (titre, description, couleur, pied de page, image, vignette — mêmes champs que les
  embeds de Tickets), avec bouton optionnel « 🎫 Créer un ticket » si `allow_ticket` est activé et qu'un type de
  ticket est choisi. Le ticket est ouvert exactement comme depuis un panel Tickets classique (même code), avec en
  plus le message automatique configuré (si renseigné) posté dans le salon pour le staff.
- **Panel web** : un ou plusieurs panels par serveur (comme Tickets), chacun avec son propre embed d'introduction, son
  placeholder de menu, et un **arbre de catégories/réponses** (ajout de catégorie/réponse à n'importe quel niveau,
  suppression en cascade, aperçu d'embed formaté). La liste des types de ticket disponibles est lue directement dans
  le module Tickets (désactivé ou sans aucun type configuré = case à cocher « Créer un ticket » indisponible, avec
  avertissement explicite sur le panel).
- Module **désactivé par défaut** (`/modules` pour l'activer) ; accès panel web réglable via
  `/permission grant-panel` (catégorie `support`, droits `view`/`manage`).
- **Réglages** : salon de journal (carte en haut du panel web) — une carte y est postée après chaque modification
  finale de la configuration (panel créé/modifié/supprimé/publié, catégorie/réponse créée/modifiée/supprimée),
  comme pour les modules Tickets/Modération/Whitelist/Laisse.
- **Ordre des nœuds** (boutons ▲▼ sur le panel), **restriction par rôles** (une catégorie ou réponse limitée à
  certains rôles est invisible pour les autres, sous-arbre compris) et **efficacité** : vues, avis « Utile / Pas
  utile » (boutons sous chaque réponse) et tickets ouverts depuis chaque réponse, avec un tableau des taux.

## Module Candidatures

Dépôt de candidatures, sur le modèle des tickets : un ou plusieurs **panels**, chacun publié dans **son salon** avec
ses **catégories** de candidature (Modérateur, Animateur…) en boutons ou en menu déroulant. Un clic ouvre un **salon
privé** où le candidat rédige sa candidature (texte, captures, fichiers), visible des seuls **recruteurs** de la
catégorie. Chaque candidature suit un **statut** :

`📝 En rédaction` › `⏳ En attente` › `👀 Prise en compte` › `⚙️ En traitement` › `🎤 Attente entretien` › `✅ Acceptée` / `❌ Refusée`
(+ `↩️ Retirée` si le candidat se retire ou si le salon est supprimé à la main).

- **Candidat** : clique sur **✅ Terminer ma candidature** (ou `/candidature terminer`) quand il a fini ; la
  candidature passe « En attente » et les recruteurs sont notifiés. `/candidature status` affiche toutes ses
  candidatures, leur statut sur une frise, le motif d'une décision et, après un refus, la date à partir de laquelle
  il peut se représenter. Chaque changement de statut lui est aussi envoyé en message privé.
- **Recruteurs** : menu de statut dans le salon (ou `/candidature statut`, ou le panel web) ; un refus demande un
  **motif** (obligatoire si l'admin l'exige), une acceptation une précision facultative. **🔀 Changer de catégorie**
  (ou `/candidature categorie`, ou le panel web) corrige une erreur du candidat : le salon change de catégorie Discord
  et de recruteurs, le modèle de la nouvelle catégorie est republié. `/candidature historique membre:` liste **toutes
  les candidatures d'un membre**, leur issue, le motif et qui a décidé. Une fois clôturée, le salon est verrouillé et
  peut être supprimé (bouton).
- **Acceptation** (par catégorie) : **plusieurs rôles** donnés au candidat, **message privé** libre (lien d'un
  Discord, consignes…) et, en option, une **invitation à usage unique** vers un autre serveur où se trouve le bot,
  générée pour ce candidat (validité 24 h par défaut, 7 jours max) et envoyée uniquement à lui — placeholder
  `{invite}`, sinon ajoutée à la fin du message. Discord ne permet pas de réserver une invitation à un compte précis :
  l'usage unique, la courte validité et l'envoi en privé en limitent l'usage. Messages privés fermés : le message est
  posté dans le salon privé de la candidature. Seuls les serveurs où l'admin a « Gérer le serveur » sont proposés.
- **Transcription** : tous les messages de chaque candidature (candidat, recruteurs, bot, modifications, copies des
  pièces jointes) sont enregistrés dès l'ouverture ; la page `/m/candidature/transcript?candidature=<id>` les affiche
  façon Discord avec le motif et l'historique complet (ouverture, envoi, statuts, changements de catégorie,
  invitation). Le lien est ajouté dans le salon à la clôture.

### Panel web (`/m/candidature/`)

Même organisation que la page Tickets :

- **⚙️ Réglages** : salon de journal, refus motivé obligatoire ou non, **réponses automatiques** par statut (postées
  dans le salon, et en privé si coché).
- **📨 Panels** : un bloc par panel (salon de publication, embed, boutons ou menu déroulant), avec ses catégories :
  libellé, émoji, catégorie Discord des salons, limite de candidatures en cours, nom des salons, rôles recruteurs et
  notifiés, délai de représentation après un refus, acceptation (rôles, message, invitation) et **modèle** (embed
  d'ouverture, placeholders `{user} {username} {category} {number} {retry} {recruiters}`…).
- **📬 Candidatures en cours** : un bloc par catégorie, changement de statut et de catégorie, liens salon et
  transcription.
- **🗂️ Historique** : filtres par candidat (ID, ou clic sur un nom), statut, catégorie ; synthèse des issues d'un
  candidat.

`/candidature panel [panel] [salon]` publie un panel depuis Discord ; `/candidature config` renvoie le lien du panel
web.

### Accès

Module **désactivé par défaut** (`/modules`). Sur le panel web, un recruteur ne voit que les candidatures des
catégories dont il a un rôle de recruteur (les admins voient tout) ; droits réglables avec `/permission grant-panel`
(catégorie `candidature` : `view-candidatures`, `view-transcripts`, `manage-candidatures`, `manage-settings`).

## Module Statistiques

| Donnée | Source |
|---|---|
| Messages (date, salon, auteur, longueur, pièces jointes, `@everyone`/`@here`, rôles mentionnés) | `messageCreate` — insertion groupée |
| Messages supprimés | `messageDelete`, `messageDeleteBulk` |
| Temps vocal | sessions ouvertes/fermées sur `voiceStateUpdate` (salon AFK exclu par défaut) |
| Arrivées / départs | `guildMemberAdd`, `guildMemberRemove` |
| Rôles, surnoms, boosts | `guildMemberUpdate` (auteur du changement de rôle complété par le journal d'audit) |
| Pseudos globaux | `userUpdate` |
| Bannissements, expulsions, exclusions temporaires | journal d'audit (`guildAuditLogEntryCreate`) |
| Nombre de membres, boosts, Nitro | instantané toutes les `STATS_SNAPSHOT_INTERVAL_MINUTES` |

Les bots, webhooks et messages système sont ignorés. Le contenu des messages n'est enregistré que si
`STATS_STORE_MESSAGE_CONTENT=true` (à n'activer que si c'est légalement justifié). `STATS_CONTENT_RETENTION_DAYS`
(recommandé : 90) efface ce contenu au-delà de ce nombre de jours — définitivement ; longueur, salon et date restent,
les statistiques ne changent pas. Absent ou `0` : rien n'est effacé. Le dashboard est réservé aux membres du serveur ayant le droit `stats` de `/permission grant-panel` ; la
fiche d'un membre n'affiche que les serveurs que le compte connecté peut lui-même consulter.

### Rétroactivité

À l'arrivée sur un serveur, et au premier démarrage pour les serveurs déjà rejoints, le bot récupère les
`STATS_BACKFILL_DAYS` derniers jours (7 par défaut) : messages de tous les salons lisibles et des fils actifs,
membres et arrivées, journal d'audit (sanctions, rôles, surnoms), et reconstitue la courbe du nombre de membres.
L'état est suivi par serveur (`stats_guilds.backfill_status`) : un traitement interrompu reprend au démarrage suivant.

À chaque redémarrage, le bot rattrape aussi ce qui s'est passé pendant son absence (arrivées, départs, changements de pseudo)
et referme les sessions vocales interrompues à la dernière heure où il était en ligne.

### Dashboard (`/m/stats/`)

- Filtres communs : serveur, période (dernière heure, 24 h, 7 / 30 / 90 jours, 12 mois, **jour précis**, **heure précise**
  ou plage libre) et fréquence (minute, heure, jour, semaine, mois). La vue est conservée dans l'URL pour être partagée.
- Chaque graphique peut aussi avoir **sa propre période** (bouton ⏱ dans son en-tête) ; « Revenir à la période globale »
  le rattache de nouveau aux filtres de la page.
- Chaque graphique propose les cases **Moyenne** et **Médiane** (lignes de référence superposées, calculées côté navigateur)
  et une vue **Tableau**.
- Graphiques : volume de messages, messages par membre actif, longueur moyenne, nombre total de membres, arrivées, départs,
  `@everyone`, `@here`, mentions d'un rôle (menu déroulant), messages supprimés, temps vocal, membres actifs, sanctions.
- Classements : palmarès textuel, salons les plus actifs, présence vocale, membres les plus anciens, plus anciens boosters.
- **Recherche par ID Discord** : fiche complète d'un membre (activité, pseudos globaux et surnoms par serveur, arrivées/départs,
  rôles, sanctions, boosts, derniers messages).
- **Comparaison** (case cochée par défaut) : chaque indicateur affiche son évolution par rapport à la période précédente de
  même durée (▲ / ▼ en %). **Export CSV** : bouton « CSV » sur chaque graphique et chaque classement (séparateur `;`,
  s'ouvre directement dans Excel).
- **Invitations** (si le suivi est activé) : origine des arrivées (invitation, URL personnalisée, inconnue), meilleurs
  parrains (arrivées, restés, partis) et invitations les plus utilisées. Nécessite la permission *Gérer le serveur*.

### Rapports (`/m/stats/rapports`)

Sous-onglet du module : réglages par serveur (droit `manage` de la catégorie `stats`) et historique des rapports.
- **Rapport hebdomadaire** (désactivé par défaut) : résumé des 7 derniers jours comparé aux 7 précédents (messages,
  membres actifs, vocal, arrivées/départs, suppressions, sanctions, podiums, parrains), publié dans le salon choisi le
  jour et à l'heure choisis (fuseau réglable). Chaque rapport est conservé, consultable, exportable en CSV et peut être
  généré à la demande.
- **Suivi des invitations** (désactivé par défaut) : activable ici ; l'état de référence des invitations est lu à
  l'activation puis à chaque démarrage.

### Slash commands

- `/stats serveur [periode]` — résumé de l'activité du serveur ;
- `/stats membre [membre] [periode]` — statistiques d'un membre ;
- `/stats top [type] [periode]` — classements paginés (top 50 : messages, vocal, salons).

Par défaut, `/stats` est réservée aux administrateurs (données de membres) : `/permission public stats` l'ouvre à tous,
`/permission grant <role> stats` à un rôle.

### Limites connues

- **Nitro** : Discord n'expose pas l'abonnement aux bots. Le chiffre est une estimation minimale fondée sur des signes réservés
  aux abonnés (boost, avatar animé, profil propre au serveur, bannière).
- **Courbe des membres rétroactive** : les départs antérieurs à l'arrivée du bot étant inconnus, les points reconstitués sont approximatifs.
- **Départs pendant une absence du bot** : ils sont datés du redémarrage (source « rattrapage »).
- **Fuseau horaire** : les regroupements utilisent le décalage horaire actuel du navigateur ; un changement d'heure (été/hiver)
  dans la période décale d'une heure les intervalles situés de l'autre côté.
