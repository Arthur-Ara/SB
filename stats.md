# Spécifications du Module : Statistiques et Dashboard Web

Ce document définit les exigences techniques pour le développement du module de statistiques du bot Discord, incluant la collecte de données en arrière-plan et la restitution via une interface web de type Grafana.

## 0. Stack Technique Cible
*   **Langage / Environnement :** JavaScript (Node.js pour le bot Discord et le backend web).
*   **Base de Données :** MySQL (Base de données relationnelle).
*   *Note d'implémentation :* En raison du volume important de données généré (logs de messages, horodatage précis), le schéma MySQL devra être rigoureusement normalisé et indexé (notamment sur les `guild_id`, `user_id` et les dates) pour garantir des performances optimales lors de la génération des graphiques.

---

## 1. Collecte de Données (Par Serveur)

Le bot écoute les événements (Event Listeners JS) et persiste en base de données les éléments suivants (avec un horodatage précis `DATETIME` ou `TIMESTAMP` pour le traitement analytique) :

### Métriques d'Activité Textuelle et Vocale
*   **Messages envoyés :** Volume total avec date/heure.
*   **Messages supprimés :** Volume total par serveur.
*   **Activité par salon :** Nombre de messages par channel textuel (avec date/heure).
*   **Mentions globales :** Nombre de mentions `@everyone` et `@here` envoyées.
*   **Activité vocale :** Temps passé en vocal par membre (cumulable par jour, semaine, mois via le calcul de la durée entre les événements de connexion/déconnexion).
*   **Engagement unique (sur une période donnée) :**
    *   Nombre de membres distincts ayant envoyé au moins un message.
    *   Nombre de membres distincts s'étant connectés en vocal.

### Métriques des Membres et de Modération
*   **Flux de membres :** Nombre d'arrivées (Join) et de départs (Leave).
*   **Ancienneté globale :** Moyenne et médiane de l'ancienneté des membres sur le serveur (calculé via la date de `joinedAt`).
*   **Modération :** Nombre de bannissements, expulsions (kicks) et exclusions temporaires (timeouts) avec dates et heures.
*   **Palmarès d'ancienneté :** Top 10 des membres les plus anciens du serveur.

### Métriques de Boost et Nitro
*   **Statut Nitro :** Nombre total de membres possédant un abonnement Nitro actif.
*   **Boosts du serveur :** Nombre total de boosts actifs.
*   **Rétention des boosts :** Durée moyenne de boost (ancienneté moyenne d'un booster).
*   **Palmarès des boosters :** Top 10 des plus anciens boosters (avec durée du boost continue).

---

## 2. Profilage et Historique Individuel des Membres

Le bot doit construire un profil de données granulaire (tables relationnelles MySQL dédiées) pour chaque utilisateur :
*   **Historique des présences :** Enregistrement de l'ensemble des arrivées/départs (Join/Leave).
*   **Historique des rôles :** Traçabilité des ajouts et retraits de rôles (Audit log).
*   **Historique des messages :** Enregistrement du contenu (si légalement pertinent/autorisé) ou de la métadonnée des messages envoyés par le membre.
*   **Historique des pseudonymes :** Enregistrement de tous les changements de pseudos :
    *   Global (username Discord).
    *   Local (nickname spécifique au serveur).

---

## 3. Initialisation et Rétroactivité des Données

*   **Récupération à l'arrivée :** Lorsque le bot rejoint un nouveau serveur, il exécute un script de rétroactivité pour récupérer les informations des **7 derniers jours** (via l'API Discord) afin d'établir une base de données initiale.
*   **Premier démarrage :** Si le bot démarre pour la première fois mais se trouve déjà sur des serveurs, il doit déclencher ce processus de rétroactivité de 7 jours sur l'ensemble de ces serveurs.

---

## 4. Traitement des Données & Dashboard Web (Style Grafana)

Le module comprend une interface web analytique branchée sur la base MySQL permettant d'explorer les données récoltées (via des requêtes SQL d'agrégation).

### Fonctionnalités Transversales de l'Interface
*   **Filtre temporel global :** Sélecteur de période applicable à chaque graphique (ex: date de début / de fin, ou plages horaires spécifiques).
*   **Filtre de fréquence :** Ajustement du pas de temps sur les graphiques de volume (par heure, par jour, etc.).
*   **Bascules Statistiques (Checkboxes) :** Chaque graphique dispose de cases à cocher permettant de superposer la **Moyenne** et la **Médiane** à la courbe principale.

### Liste des Graphiques à Implémenter
1.  Volume de messages envoyés (fréquence modifiable).
2.  Nombre moyen de messages envoyés.
3.  Longueur moyenne des messages.
4.  Croissance du serveur : Nombre total de membres (fréquence modifiable).
5.  Flux entrant : Nombre de nouveaux membres.
6.  Flux sortant : Nombre de départs (leaves).
7.  Mentions massives : Fréquence d'utilisation du `@everyone`.
8.  Mentions massives : Fréquence d'utilisation du `@here`.
9.  **Mentions de rôle :** Graphique interactif incluant un menu déroulant pour sélectionner le rôle spécifique à analyser.

### Classements et Vues Globales
*   **Palmarès textuel :** Classement des membres envoyant le plus de messages.
*   **Cartographie de l'activité :** Liste des salons (channels) les plus actifs.
*   **Rôles les plus mentionnés :** Graphique multi-courbes (une courbe par rôle, top 5/8/10/15 au choix) suivi d'un tableau de classement (mentions, part) dont les lignes masquent/affichent la courbe. API : `GET /m/stats/api/role-ranking`.

### Outil d'Investigation (Recherche Membre)
*   **Barre de recherche par ID Discord :** Permet d'isoler et d'afficher toutes les données/statistiques liées à un membre précis.
*   **Affichage de l'historique :** Intègre les changements de pseudonymes du membre ciblé (historique global Discord + historique des surnoms par serveur).
```eof

Ce fichier est prêt à être fourni. La précision sur MySQL est importante pour la partie "Médiane", car contrairement aux moyennes, les médianes sont souvent plus complexes à calculer directement en SQL et demanderont peut-être un traitement spécifique côté JavaScript.