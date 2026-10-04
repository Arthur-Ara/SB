(function () {
  'use strict';
  var messages = {
    annule: 'Connexion annulée depuis Discord.',
    etat: 'La demande de connexion a expiré ou est invalide. Réessayez.',
    oauth: 'Discord a refusé la connexion. Vérifiez la configuration OAuth2 (Client ID, secret, URL de redirection).',
  };
  var params = new URLSearchParams(window.location.search);
  var code = params.get('erreur');
  var box = document.getElementById('login-error');
  if (code && box) {
    box.textContent = messages[code] || 'La connexion a échoué.';
    box.hidden = false;
  }
  // Page d'origine (ex. lien direct vers un transcript) : transmise à Discord pour y revenir après connexion.
  var next = params.get('next');
  var link = document.getElementById('login-link');
  if (link && next && next.charAt(0) === '/' && next.charAt(1) !== '/') link.href = '/auth/login?next=' + encodeURIComponent(next);
})();
