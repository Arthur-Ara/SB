# Charte Graphique & UI/UX : Design Moderne et Stylé

Ce document définit les standards visuels et l'expérience utilisateur (UI/UX) pour l'ensemble de l'écosystème (Bot Discord et Dashboard Web). L'objectif est de proposer une interface "Dark Mode" premium, minimaliste et fluide, inspirée des dashboards analytiques modernes (type Vercel, Shadcn/UI, ou un Grafana très épuré).

## 1. Philosophie Générale
*   **Dark Mode First :** L'interface web et les embeds du bot sont pensés nativement pour les environnements sombres afin de réduire la fatigue visuelle et correspondre à l'esthétique gaming/tech de Discord.
*   **Minimalisme & Clarté :** Suppression des bordures superflues, utilisation de l'espace blanc (ou sombre) pour structurer le contenu. L'information prime.
*   **Feedback Visuel :** Toute interaction (clic, survol, exécution de commande) doit fournir un retour visuel clair (micro-animations web, emojis d'état sur le bot).

## 2. Palette de Couleurs (Thème Sombre) — v1.4 « bleu & blanc, doux »
Fonds bleu nuit, accents bleus, textes blancs ; contrastes adoucis (halos et ombres légères plutôt que bordures
marquées). Source unique : jetons CSS de `src/web/public/core.css` (`:root`, thème clair sous `[data-theme="light"]`).

*   **Fonds (Backgrounds) :**
    *   Fond principal : `#060A14` (bleu nuit) avec deux halos bleus diffus en haut de page.
    *   Cartes/Panneaux : `rgba(15, 23, 42, 0.66)` (slate 900 translucide, *Glassmorphism* léger) ; champs `rgba(2, 6, 23, 0.55)`.
*   **Couleurs d'Accentuation :**
    *   Primaire (marque, liens, onglet actif, bouton principal) : `#3B82F6` → `#60A5FA` (dégradé bleu), halo `rgba(59, 130, 246, 0.35)`.
    *   Graphiques : bleu `#3B82F6`, émeraude `#34D399` (hausses), rose `#FB7185` (baisses/suppressions), ambre et cyan
        pour moyenne/médiane. États : fonds doux (`--good-soft`, `--warn-soft`, `--critical-soft`) plutôt que bordures pleines.
*   **Textes :**
    *   Titres et données clés : `#F8FAFC` (blanc).
    *   Texte secondaire : `#94A3B8` (gris bleuté).
*   **Formes :** cartes `border-radius: 16px`, boutons/champs/onglets `10px` ; onglet actif plein (dégradé bleu, texte blanc).

## 3. Typographie Web
*   **Police Principale :** `Inter` ou `Geist Sans` (sans-serif géométrique et très lisible, excellente pour les chiffres et les tableaux).
*   **Police Monospace (Codes, ID, Logs) :** `JetBrains Mono` ou `Fira Code`.
*   **Hiérarchie :** Les chiffres clés (KPIs) des statistiques doivent utiliser une police en gras (Font-weight: 700) et de très grande taille pour un impact visuel immédiat au chargement du Dashboard.

## 4. Composants Web (Dashboard)
*   **Cartes (Cards) :** Coins arrondis (`border-radius: 16px`), bordure très subtile (`1px solid rgba(255, 255, 255, 0.1)`), pas d'ombres portées lourdes, mais une légère lueur interne.
*   **Boutons & Badges :** Remplissage semi-transparent pour les états secondaires, couleurs pleines pour les actions principales (Call to Action).
*   **Graphiques (Charts - Chart.js / Recharts) :**
    *   Courbes adoucies (Spline/Smooth) plutôt que des angles cassés.
    *   Remplissage avec un gradient linéaire sous la courbe (fade out vers le bas) pour un effet de volume.
    *   Quadrillage (Grid) réduit au minimum : uniquement des lignes horizontales très discrètes (`rgba(255, 255, 255, 0.05)`).
    *   Infobulles (Tooltips) épurées au survol, affichant la date exacte et la valeur avec la couleur de la courbe.

## 5. Esthétique du Bot Discord (Embeds & Messages)

Les réponses du bot doivent être aussi soignées que le site web, en évitant les murs de texte illisibles.

*   **Couleurs des Embeds :** toujours `#2B2D31` (gris invisible qui se fond dans le fond Discord), succès comme erreur ;
    l'état se lit à l'émoji de tête (« ✅ … », « ⚠️ … », « ❌ … »). Les panels configurés par les admins (tickets, support,
    menus de rôles) gardent la couleur qu'ils ont choisie. Implémentation : `src/bot/ui.js`.
*   **Messages en composants v2** (ex. `/changelog`) : conteneur à barre `#2B2D31`, titre `## ・ …`, sous-titre `-# …`,
    séparateurs fins entre l'en-tête, les sections (`### émoji Catégorie`) et le pied de message.
*   **Structure d'un Embed :**
    *   **Auteur/Titre :** Toujours accompagné d'un émoji standardisé définissant le type d'action (ex: 📊 pour les stats, 🛡️ pour les permissions).
    *   **Description :** Concise. Utilisation du gras `**` pour mettre en valeur les variables dynamiques (ex: "Le rôle **@Mod** a maintenant accès à...").
    *   **Champs (Fields) :** Utilisation des champs en ligne (Inline = true) pour aligner les petites données (ex: Ancienne valeur vs Nouvelle valeur).
*   **Images & Graphiques générés :** Si le bot renvoie une image d'un graphique directement sur Discord, celle-ci doit reprendre exactement le même thème sombre et la même palette que le Dashboard web pour une cohérence parfaite de la marque.
*   **Boutons Discord (Components) :** Préférer les boutons aux réactions pour la navigation dans les classements (Pagination : `❮` | `❯` et indicateur `1/3`).

## 6. Composants du Dashboard (implémentation)
*   Jetons de couleur et composants communs dans `src/web/public/core.css` : onglets (`.tabs` / `.tab-btn`, un seul style
    pour tous les modules), barre d'outils (`.toolbar`), formulaires (`.filters`, `.field`, `textarea`), boutons
    (`.btn`, `.btn-primary`, `.btn-ghost`, `.btn-danger`), badges, aperçu d'embed, fenêtre de dialogue. Les feuilles des
    modules ne contiennent que ce qui leur est propre.
*   Confirmations et saisies via `Core.confirm` / `Core.prompt` (fenêtre au style du dashboard), jamais `confirm()` /
    `prompt()` du navigateur.
