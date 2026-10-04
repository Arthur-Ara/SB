# Architecture Globale : Bot Discord Modulaire & Dashboard Web

## 1. Présentation du Projet
Ce projet consiste à développer un bot Discord hautement modulaire accompagné d'une interface web centralisée. L'objectif est de fournir un écosystème robuste où le bot récolte des données et interagit avec les utilisateurs, tandis que le site web sert de panneau de contrôle et d'outil d'analyse (Dashboard).

Ce document est le **fichier principal (Master)**. Le développement des fonctionnalités spécifiques est divisé en plusieurs sous-modules indépendants, chacun étant détaillé dans son propre fichier Markdown (ex: `Module_Statistiques_Dashboard.md`).

## 2. Stack Technique Globale
*   **Langage :** JavaScript (Node.js) pour le bot et le backend web.
*   **Librairie Discord :** Discord.js (dernière version stable).
*   **Base de Données :** MySQL.
*   **Interface Web :** Framework JS au choix (ex: Express.js pour le backend, React/Vue ou moteur de template HTML pour le frontend).

## 3. Architecture du Bot Discord
Le bot sert de collecteur de données et d'interface d'interaction avec les membres sur les serveurs Discord.

### 3.1. Système de Commandes (Slash Commands)
*   **Exclusivité Slash Commands :** Le bot doit être développé **uniquement** avec des Slash Commands (Application Commands). Les anciennes commandes basées sur des préfixes (ex: `!help`) ne doivent pas être implémentées.
*   **Gestionnaire (Command Handler) :** Le code doit inclure un gestionnaire de commandes dynamique permettant de charger, décharger ou recharger facilement les commandes liées à chaque module.

### 3.2. Système d'Événements (Event Handler)
*   Un gestionnaire d'événements dynamique doit écouter l'activité des serveurs (messages, connexions vocales, arrivées/départs) et rediriger ces données vers les modules correspondants (notamment pour l'insertion en base de données MySQL).

### 3.3. Structure Modulaire
*   Le code doit être organisé en dossiers distincts pour chaque module (ex: `/modules/stats`, `/modules/moderation`, etc.).
*   Chaque module fonctionnera selon les spécifications définies dans son fichier `.md` dédié.

## 4. Site Web Centralisé (Dashboard)
Le site web a pour but de centraliser, traiter et afficher les données récoltées par le bot (statistiques, graphiques, logs, etc.).

### 4.1. Authentification et Sécurité
L'accès au Dashboard n'est pas public. Il est strictement réservé à une liste de membres de confiance.
*   **Connexion :** L'authentification doit se faire via Discord OAuth2.
*   **Autorisation :** Une fois l'utilisateur connecté via Discord, le système vérifie son ID Discord (Snowflake).
*   **Contrôle d'accès (`.env`) :** La liste des identifiants Discord autorisés à accéder au site web doit être définie dans le fichier `.env` du projet. Si l'ID de l'utilisateur n'est pas dans cette liste, l'accès lui est refusé (Erreur 403).

## 5. Configuration et Variables d'Environnement (`.env`)
Le fichier `.env` à la racine du projet doit au minimum contenir les variables suivantes :

```env
# Configuration Discord
DISCORD_BOT_TOKEN="ton_token_ici"
DISCORD_CLIENT_ID="id_de_l_application"
DISCORD_CLIENT_SECRET="secret_oauth2_discord"

# Configuration Base de données MySQL
DB_HOST="localhost"
DB_USER="root"
DB_PASSWORD="password"
DB_NAME="discord_bot_db"

# Configuration Web & Sécurité
WEB_PORT=3000
WEB_CALLBACK_URL="http://localhost:3000/auth/discord/callback"

# Liste des IDs Discord autorisés à accéder au Dashboard web (séparés par des virgules)
AUTHORIZED_WEB_USERS="ID_UTILISATEUR_1,ID_UTILISATEUR_2,ID_UTILISATEUR_3"