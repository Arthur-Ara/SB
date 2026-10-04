# Module Server Manager — Journal des modifications et `/rollback`

Module **désactivé par défaut** (à activer par serveur avec `/modules`). Il enregistre en continu les modifications
du serveur (salons, rôles, rôles des membres) et permet de les **annuler sur une période**, par type, et
éventuellement **pour un seul auteur**. Les sanctions du module Modération sont annulables de la même façon.

## Commandes

| Commande | Effet |
|---|---|
| `/rollback <type> <duree> [utilisateur] [simulation]` | aperçu puis annulation des modifications de la période |
| `/rollbackconfig [salon] [retirer_salon]` | salon de journal des rollbacks, état du journal et des garde-fous |
| `/rollbackhistory` | historique paginé des rollbacks exécutés |

Accès : `admin` par défaut, réglable avec `/permission` (comme toutes les commandes). Les droits Discord de
l'auteur restent **toujours** vérifiés en plus (voir « Garde-fous »).

### `/rollback`

- **`type`** : `all` (tout), `rank` (rôles), `channel` (salons), `moderation` (sanctions).
- **`duree`** : `30m`, `2h`, `1d`, `1d12h` (un nombre seul = minutes). Minimum 1 min, maximum 7 j par défaut.
- **`utilisateur`** (facultatif) : n'annule que les actions **effectuées par** cet utilisateur.
- **`simulation`** (facultatif) : affiche l'aperçu, sans proposer d'exécution.

| Type | Ce qui est annulé |
|---|---|
| `rank` | rôle créé (→ supprimé), supprimé (→ recréé **et rendu à ses porteurs**), modifié (nom, couleur, affichage séparé, mentionnable, permissions) ; rôle ajouté/retiré à un membre |
| `channel` | salon créé (→ supprimé), supprimé (→ recréé), modifié (nom, sujet, NSFW, mode lent, débit, limite, catégorie, **permissions du salon**) |
| `moderation` | ban → débannissement, exclusion → levée, mute vocal → levée, avertissement → retiré, shadow-ban → levé, verrouillage → déverrouillé |
| `all` | tout ce qui précède |

Non annulables : expulsions, purges, suppressions de messages, positions des salons et des rôles (Discord les
recalcule en cascade), messages d'un salon recréé (nouvel identifiant, historique perdu), et tout ce qui s'est passé
avant l'activation du module (le journal indique son début de couverture).

## Fonctionnement

1. **Journal** : les événements Discord (`channelCreate/Update/Delete`, `roleCreate/Update/Delete`) fournissent l'état
   avant/après (instantané JSON dans `sm_changes`) ; l'**auteur** vient du journal d'audit reçu en temps réel
   (`guildAuditLogEntryCreate`). Les ajouts/retraits de rôles à un membre sont lus directement dans le journal d'audit.
   Conservation : 30 jours (`SERVERMANAGER_RETENTION_DAYS`).
2. **Aperçu** : `/rollback` simule tout (état « tel qu'il serait » après chaque annulation, pour que les modifications
   empilées sur un même objet s'annulent dans le bon ordre) et affiche ce qui sera fait, ce qui sera ignoré et pourquoi.
3. **Confirmation** : bouton, puis — pour les plans sensibles — saisie du code `ROLLBACK <n>` dans une fenêtre.
4. **Exécution** : re-simulation juste avant de démarrer ; si le résultat diffère de l'aperçu confirmé, **rien n'est
   exécuté**. Suivi en direct avec un bouton **🛑 Arrêter**.
5. **Traçabilité** : un enregistrement par rollback (`sm_batches`, rapport détaillé), chaque ligne annulée est marquée
   (jamais annulée deux fois), message de lancement et de fin dans le salon `/rollbackconfig salon:`, et chaque
   annulation de sanction est aussi inscrite dans l'historique de modération (`/history`).

## Garde-fous

- **Aperçu obligatoire** : aucune annulation sans avoir vu le plan complet.
- **Confirmation renforcée** (saisie de `ROLLBACK <n>`) si le type est `all`, si une **suppression** est prévue ou si
  plus de 10 actions sont prévues.
- **Droits de l'auteur** : `all` exige *Administrateur*, `rank` *Gérer les rôles*, `channel` *Gérer les salons*,
  `moderation` *Exclure temporairement des membres* — et chaque ligne exige en plus le droit Discord correspondant.
  Le propriétaire du serveur est exempté des contrôles de hiérarchie, jamais des limites de volume.
- **Hiérarchie** : impossible de toucher un rôle au-dessus (ou au niveau) de son propre rôle le plus haut, ni un membre
  de rang supérieur ou égal ; les actions d'un auteur de rang supérieur/égal (ou du propriétaire) sont **intouchables** ;
  on ne peut pas lever une sanction **qui nous vise**.
- **Pas d'escalade de privilèges** : on ne peut pas redonner à un rôle (ou à une dérogation de salon) des permissions
  que l'on ne détient pas soi-même ; un rôle *Administrateur* n'est manipulable que par un administrateur ; les rôles
  d'intégration (bots, boosts) ne sont jamais touchés.
- **Non-écrasement** : une modification n'est annulée que si l'objet est **encore dans l'état laissé par cette
  modification** (sinon : « modifié depuis », ignoré). Chaque modification n'est annulée qu'une fois.
- **Suppressions prudentes** : un salon créé n'est supprimé que s'il est **vide** (aucun message, aucun fil, aucun
  salon enfant) ; la suppression d'un rôle créé annonce le nombre de membres qui le perdront.
- **Actions du bot exclues** (rollbacks, shadow-ban, blacklist automatique…), et la journalisation est suspendue
  pendant un rollback : un rollback ne s'annule jamais lui-même par erreur.
- **Plafonds** : 60 actions par rollback (`SERVERMANAGER_MAX_ACTIONS`), 300 événements lus au maximum, période de
  7 j maximum (`SERVERMANAGER_MAX_WINDOW_HOURS`).
- **Un seul rollback à la fois** par serveur, **délai de 120 s** entre deux exécutions
  (`SERVERMANAGER_COOLDOWN_SECONDS`).
- **Coupe-circuit** : 5 échecs consécutifs interrompent le rollback ; le bouton Arrêter aussi.
- **Blacklist** : un ban lié à la blacklist n'est jamais levé par un rollback (`/unblacklist` uniquement).
- **Auteurs inconnus** : si le journal d'audit n'est pas lisible, les lignes sans auteur sont signalées dans
  l'aperçu et **exclues dès qu'un `utilisateur` est ciblé**.

## Prérequis Discord

Permissions du bot : *Gérer les rôles*, *Gérer les salons*, *Bannir des membres*, *Exclure temporairement des membres*,
*Rendre muet des membres*, *Voir les logs du serveur*, et un rôle **placé au-dessus** des rôles à restaurer.
Intents : `Server Members` (déjà requis par d'autres modules) ; l'événement d'audit utilise `GuildModeration`.

## Variables d'environnement (facultatives)

| Variable | Défaut | Rôle |
|---|---|---|
| `SERVERMANAGER_MAX_WINDOW_HOURS` | 168 | période maximale d'un rollback |
| `SERVERMANAGER_MAX_ACTIONS` | 60 | actions maximum par rollback |
| `SERVERMANAGER_RETENTION_DAYS` | 30 | conservation du journal |
| `SERVERMANAGER_COOLDOWN_SECONDS` | 120 | délai entre deux rollbacks d'un même serveur |

## Sauvegardes (`/backup`, v1.3.0)

| Commande | Effet |
|---|---|
| `/backup create [nom]` | instantané de la structure : rôles (hors intégrations), permissions de @everyone, catégories et salons avec leurs dérogations |
| `/backup list` | sauvegardes du serveur (taille, contenu, dernière restauration) |
| `/backup restore <id>` | aperçu, bouton, puis code `RESTAURER <id>` ; exige *Administrateur* |
| `/backup delete <id>` | supprime une sauvegarde |
| `/backup auto <actif> [intervalle] [garder]` | sauvegardes automatiques (désactivées par défaut ; 24 h et 7 gardées par défaut) |

- **Restauration non destructive** (`lib/backup.js`) : un rôle/salon est retrouvé par son ID, sinon par un nom unique (et
  type + catégorie pour un salon). Ce qui manque est recréé (rôles d'abord, puis catégories, puis salons, dérogations
  rattachées aux rôles recréés) ; ce qui existe est remis dans l'état sauvegardé (nom, couleur, affichage, mention,
  permissions ; nom, sujet, NSFW, mode lent, débit, limite, catégorie, dérogations). Rien n'est supprimé, les positions
  ne sont pas restaurées. Rôles au-dessus du bot ou de l'auteur et salons non gérables : ignorés (affichés dans l'aperçu).
- **Garde-fous** : aperçu obligatoire, empreinte du plan re-vérifiée juste avant l'exécution (« le serveur a changé » →
  rien n'est fait), une restauration à la fois par serveur et jamais pendant un rollback (et inversement), journal
  suspendu pendant la restauration, 250 opérations maximum, carte dans le salon de journal au début et à la fin.

## Panel web (`/m/servermanager/`, v1.3.0)

Onglets Rollback (aperçu identique à la commande, code de confirmation pour les plans sensibles, exécution suivie en
direct avec arrêt), Journal (modifications filtrables par type et auteur), Historique (rapport de chaque rollback),
Sauvegardes et Réglages (salon de journal, sauvegardes automatiques). Droits `/permission grant-panel` : `view`,
`rollback`, `backup`, `manage`. Le compte connecté doit être membre du serveur : le moteur vérifie **ses** droits
Discord exactement comme pour la commande. Les tâches longues tournent côté serveur (suivi par sondage toutes les
1,2 s) ; un aperçu expire au bout de 10 minutes.

## Tables

`sm_changes` (journal), `sm_id_map` (ancien → nouvel ID d'un salon/rôle recréé), `sm_settings` (+ réglages des
sauvegardes automatiques), `sm_batches`, `sm_mod_reverted` (sanctions déjà annulées), `sm_backups` (sauvegardes, JSON).
