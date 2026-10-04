// Thème sombre par défaut (style.md) ; le thème clair est un choix mémorisé de l'utilisateur.
// Chargé avant le premier rendu pour éviter un flash de couleurs.
(function () {
  try {
    if (localStorage.getItem('mtb-theme') === 'light') document.documentElement.setAttribute('data-theme', 'light');
  } catch (e) {
    /* stockage indisponible : thème sombre */
  }
})();
