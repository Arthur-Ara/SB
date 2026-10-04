# Spécifications du Module : Système de Permissions

Ce document définit les exigences techniques pour le module de gestion des permissions du bot Discord. Ce système permet d'attribuer ou de restreindre l'accès aux différentes commandes (Slash Commands) de manière granulaire : par serveur, par rôle, ou par utilisateur spécifique.

## 1. Logique de Fonctionnement (Middleware)

Puisque Discord propose un système de permissions natif limité pour une gestion aussi poussée en base de données, l'accès aux commandes sera géré par un **Middleware interne au Command Handler** (lors de l'événement `interactionCreate`).

Avant l'exécution d'une commande par un membre, le bot vérifie l'autorisation selon l'ordre de priorité suivant (du plus fort au plus faible) :
1. **Permission Utilisateur (`user-grant` / `user-revoke`) :** Si le membre a une permission explicite (positive ou négative) pour cette commande, elle s'applique immédiatement.
2. **Permission Rôle (`grant` / `revoke`) :** Si le membre n'a pas de permission individuelle, le bot vérifie les permissions liées à ses rôles. S'il possède au moins un rôle autorisé, l'accès est accordé. S'il ne possède que des rôles révoqués, l'accès est refusé.
3. **Statut Public (`public`) :** Si aucune règle utilisateur ou rôle ne s'applique, le bot vérifie si la commande a été définie comme publique sur le serveur.
4. **Défaut :** Par défaut, seules les personnes disposant de la permission `Administrator` sur Discord ont accès aux commandes sensibles (sauf celles définies explicitement comme publiques).

## 2. Modélisation de la Base de Données (MySQL)

Le module nécessitera au minimum trois tables pour gérer les exceptions :
*   `permissions_users` : `(guild_id, user_id, command_name, has_permission)`
*   `permissions_roles` : `(guild_id, role_id, command_name, has_permission)`
*   `permissions_public` : `(guild_id, command_name, is_public)`

## 3. Liste des Commandes (Slash Commands)

Toutes les commandes liées à ce module doivent être regroupées sous une commande principale `/permission` (avec des sous-commandes) ou des commandes indépendantes. Par défaut, **seuls les Administrateurs du serveur** peuvent utiliser ces commandes de configuration.

*Note : `<>` = paramètre obligatoire, `[]` = paramètre facultatif.*

### 3.1. Consultation
*   **`/permissions list <rank|user> [id]`**
    *   **Description :** Affiche les permissions configurées sur le serveur.
    *   **Comportement :**
        *   Si le paramètre est `rank` (rôle) ou `user` (utilisateur) *sans* ID mentionné : Affiche une liste globale de tous les rôles/utilisateurs ayant des permissions spécifiques sur le serveur.
        *   Si un `[id]` (mention d'un rôle ou d'un utilisateur) est renseigné : Affiche la liste détaillée des commandes autorisées ou bloquées spécifiquement pour cet ID.

### 3.2. Gestion par Rôle
*   **`/permission grant <role> <command>`**
    *   **Description :** Autorise l'exécution d'une commande spécifique pour un rôle donné.
    *   **Action :** Insère/Met à jour dans `permissions_roles` la valeur `has_permission = true`.
*   **`/permission revoke <role> <command>`**
    *   **Description :** Interdit l'exécution d'une commande spécifique pour un rôle donné.
    *   **Action :** Insère/Met à jour dans `permissions_roles` la valeur `has_permission = false`.

### 3.3. Gestion Individuelle (Utilisateur)
*   **`/permission user-grant <user> <command>`**
    *   **Description :** Autorise l'exécution d'une commande pour un utilisateur précis (outrepasse les permissions de rôle).
    *   **Action :** Insère/Met à jour dans `permissions_users` la valeur `has_permission = true`.
*   **`/permission user-revoke <user> <command>`**
    *   **Description :** Retire ou interdit l'exécution d'une commande pour un utilisateur précis (outrepasse les permissions de rôle).
    *   **Action :** Insère/Met à jour dans `permissions_users` la valeur `has_permission = false`.

### 3.4. Gestion Globale (Serveur)
*   **`/permission public <command>`**
    *   **Description :** Définit une commande comme étant publique sur le serveur (accessible à tous les membres sans exception de rôle, sauf s'ils ont un `user-revoke`).
    *   **Action :** Insère ou bascule la valeur dans `permissions_public`.
*   **`/permission purge`**
    *   **Description :** Supprime **absolument toutes** les permissions personnalisées définies sur le serveur.
    *   **Action :** Efface toutes les entrées liées au `guild_id` actuel dans les trois tables de permissions. Demande une confirmation (bouton ou argument de sécurité) avant exécution pour éviter les erreurs de manipulation.
```eof