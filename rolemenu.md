# Module RôleMenu — menus de rôles et conditions d'accès

Module **désactivé par défaut** (à activer par serveur avec `/modules`). Il publie des **menus de rôles** que les
membres utilisent pour s'attribuer eux-mêmes des rôles, avec des **conditions d'accès** extensibles. Configuration au choix depuis Discord (**panneau interactif** de `/rolemenu`)
ou depuis le **panel web** (`/m/rolemenu/`) : les deux passent par les mêmes validations et le même journal.

## Types de menus

| Type | Fonctionnement |
|---|---|
| **Réactions** (emojis) | un émoji par rôle sous le message ; ajouter la réaction donne le rôle, la retirer le reprend (20 options max) |
| **Boutons** | un bouton par rôle (couleur et émoji au choix) ; un clic ajoute ou retire le rôle, réponse visible uniquement par le membre (25 max) |
| **Menu déroulant** | une liste de rôles ; la sélection devient l'état voulu (cochés ajoutés, décochés retirés) (25 max) |

## Modes

- **Plusieurs rôles** : le membre cumule les rôles du menu, avec un **maximum** facultatif (`max`, 0 = illimité).
- **Un seul rôle parmi la liste** : prendre un rôle retire les autres rôles du menu (réactions comprises : les anciennes
  réactions du membre sont retirées si le bot a *Gérer les messages*).
- **Retrait possible** (par menu) : si désactivé, un rôle pris ne peut plus être retiré depuis le menu (on peut seulement en changer en mode « un seul »).

## Conditions d'accès

Chaque menu, et chaque option, peut porter **autant de conditions que nécessaire, de types identiques ou différents**.
Elles **se cumulent** : **toutes** celles qui s'appliquent doivent être remplies (les conditions du menu s'appliquent à
toutes ses options, celles d'une option s'y ajoutent). Le membre refusé voit **toutes** les conditions qui lui manquent,
pas seulement la première. Pour un « ou » entre rôles, utiliser `has_any_role`. Disponibles d'origine :

| Type | Condition |
|---|---|
| `has_roles` | avoir **tous** les rôles listés |
| `has_any_role` | avoir **au moins un** des rôles listés |
| `lacks_roles` | n'avoir **aucun** des rôles listés |
| `member_days` | être sur le serveur depuis N jours |
| `account_days` | compte Discord créé depuis N jours |
| `booster` | booster le serveur |

Un membre qui ne remplit pas une condition reçoit la raison (réponse éphémère pour les boutons et menus ; pour les
réactions, la réaction est retirée et un court message disparaît au bout de 10 s).

### Brancher un futur système (niveaux, invitations…)

Le registre de conditions est exposé aux autres modules : un module de niveaux ou d'invitations n'a qu'à enregistrer
sa condition, **depuis son `ready(ctx)`** (RôleMenu est alors initialisé) — elle apparaît aussitôt dans le panneau Discord
et dans le panel web (saisie générée depuis `params`), sans toucher à RôleMenu :

```js
ctx.modules.services('rolemenu')?.conditions.register('level', {
  label: 'Niveau minimum',
  description: 'Avoir atteint ce niveau.',
  params: [{ key: 'level', kind: 'number', label: 'Niveau', min: 1, max: 1000 }],   // kinds : 'roles' | 'number'
  summary: (p) => `Niveau ${p.level} minimum`,
  check: async (member, p) => ((await levelOf(member)) >= p.level ? { ok: true } : { ok: false, reason: `Il faut être niveau ${p.level}.` }),
});
```

Une condition enregistrée en base dont le type a disparu (module retiré) **bloque** l'accès au rôle (« sécurité par
défaut ») et est signalée dans le panel.

## Configuration sur Discord : `/rolemenu`

Une seule commande, **sans option** : elle ouvre un **panneau interactif** (message visible uniquement par vous) qui
change d'écran à chaque clic, avec des boutons, des sélecteurs de rôles et de salons et des fenêtres de saisie.
Il se ferme tout seul après 10 minutes d'inactivité (ou avec « ✖ Fermer »).

| Écran | Ce qu'on y fait |
|---|---|
| **Accueil** | liste des menus ; choisir un menu ; ➕ nouveau menu ; 📝 journal ; lien du panel web |
| **Nouveau menu** | choisir le type et le mode dans deux sélecteurs, puis « Nommer et créer » (nom, maximum) |
| **Menu** | rôles du menu (avec nombre de conditions), ➕ ajouter des rôles, ⚙️ réglages, 🎨 message, 🔒 conditions du menu, 📤 publier / 🔄 mettre à jour, 🗑️ supprimer |
| **Ajouter des rôles** | sélecteur de rôles (jusqu'à 10 d'un coup ; un seul + son émoji pour les réactions) |
| **Rôle** | ✏️ texte / émoji / description, couleur du bouton, ⬆ ⬇ ordre, 🔒 conditions du rôle, 🗑️ retirer |
| **Conditions** | liste cumulée, retirer une condition, ajouter une condition (sélecteur de type, puis ses paramètres : rôles ou nombre) |
| **Réglages** | type, mode, nom, maximum, retrait autorisé ou non, texte du menu déroulant |
| **Message** | titre, texte, couleur, pied de page, image, vignette — ou ♻️ message automatique |
| **Publier** | sélecteur de salon |

Accès : `admin` par défaut, réglable avec `/permission`. Les mêmes opérations existent sur le panel web ; les deux
passent par les mêmes validations et le même journal. Un type de condition ajouté plus tard par un autre module
apparaît tout seul dans le sélecteur de types.

## Panel web

`/m/rolemenu/` : réglages (salon de journal), et pour chaque menu : type, mode, maximum, retrait,
message personnalisé avec aperçu, publication, options (texte, émoji, description, couleur, ordre ▲▼) et conditions
(menu ou option, formulaire adapté au type). Droits du panel : catégorie `rolemenu` (`view` / `manage`) avec
`/permission grant-panel`.

## Garde-fous

- **Rôles interdits** : `@everyone`, rôles d'intégration (bots, boosts), rôles **au-dessus du rôle du bot**, rôles
  *Administrateur* (toujours), et rôles portant une permission de gestion (gérer serveur/rôles/salons/webhooks/messages/
  pseudos, exclure, expulser, bannir, logs, @everyone) — sauf `ROLEMENU_ALLOW_SENSITIVE_ROLES=true`. Contrôlé à la
  configuration **et à chaque attribution** (un rôle devenu sensible plus tard n'est plus attribué).
- **Hiérarchie** : celui qui configure ne peut pas rendre attribuable un rôle au-dessus de son propre rôle le plus haut
  (hors propriétaire ; contrôlé pour le panel quand l'utilisateur est membre du serveur).
- **Menus actifs uniquement** : une ancienne copie d'un message de menu n'attribue plus rien ; un message supprimé à la
  main repasse le menu en « non publié ».
- **Conditions** : toutes requises, refus en cas d'erreur de vérification.
- **Anti-rafale** : les actions d'un même membre sont traitées l'une après l'autre.
- **Limites Discord** vérifiées avant publication (20 réactions, 25 boutons/options), émojis uniques sur un menu à réactions.
- **Journal** : chaque modification de configuration (commande ou panel) est publiée dans le salon défini dans « 📝 Journal ».

## Prérequis Discord

Le bot : *Gérer les rôles* (et un rôle **au-dessus** des rôles distribués), *Voir le salon*, *Envoyer des messages*,
*Intégrer des liens* ; pour les réactions : *Ajouter des réactions*, *Lire l'historique* et, pour retirer les réactions
refusées ou périmées, *Gérer les messages*. Intent utilisé : `GuildMessageReactions` (réactions).

## Variable d'environnement (facultative)

| Variable | Défaut | Rôle |
|---|---|---|
| `ROLEMENU_ALLOW_SENSITIVE_ROLES` | `false` | autorise les rôles à permissions sensibles (jamais *Administrateur*) |

## Tables

`rolemenu_settings`, `rolemenu_menus`, `rolemenu_options`, `rolemenu_conditions`.

## Anciennement « Autorôle »

Ce module s'appelait **Autorôle** (commande `/autorole`, panel `/m/autorole/`, tables `autorole_*`). Au premier
démarrage, la migration reprend automatiquement la configuration existante : menus, options, conditions, salon de
journal, activation par serveur (`/modules`), règles `/permission` sur la commande et droits du panel web. Les messages
déjà publiés restent fonctionnels (les anciens identifiants de boutons et de menus sont toujours reconnus). L'ancien
dossier `modules/autorole/` doit être **supprimé** du serveur (sinon l'ancien module se charge en double), et les anciennes
tables `autorole_*` peuvent être supprimées une fois la reprise vérifiée. La variable `AUTOROLE_ALLOW_SENSITIVE_ROLES`
reste lue si `ROLEMENU_ALLOW_SENSITIVE_ROLES` n'est pas définie.

Le système de **rôles donnés à l'arrivée** n'existe plus dans ce module (les rôles d'arrivée enregistrés ne sont pas repris).