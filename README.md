Atlas Céleste — version 470

La v467 conserve la synchronisation de la grille écliptique de la v464 et ajoute la mémorisation du dernier lieu d’observation choisi. Les coordonnées et le nom du lieu sont enregistrés localement sur l’appareil lorsque l’utilisateur choisit un lieu prédéfini ou récupère sa position GPS. Au lancement suivant, ce lieu est restauré. Si aucune position valide n’est enregistrée ou si le stockage local est indisponible, Paris reste le lieu par défaut.

La grille écliptique reste désactivée par défaut sur une nouvelle installation ; son activation volontaire est mémorisée séparément. Le fichier js/sensors.js n’est pas modifié.


La v467 améliore la lisibilité immédiate de la carte : étiquettes plus nettes, fond arrondi discret pour maintenir le contraste et hiérarchie renforcée des noms en mode Découverte.

La v468 améliore le confort d’interaction : retours visuels plus nets au toucher, zones de fermeture plus faciles à viser, hiérarchie affinée dans la fiche d’objet et bouton de guidage mieux identifié. Les modifications sont limitées au CSS ; la projection, les capteurs et la logique applicative ne sont pas modifiés.


La v469 rend les interactions plus explicites : bouton de fermeture de la fiche toujours visible, action principale plus contrastée et contours de focus clavier. La palette rouge de la vision nocturne est préservée. Aucun JavaScript ni code capteur n’est modifié.


## v470 — Parcours de découverte et cohérence visuelle
- Trois actions prioritaires : pointer le ciel, trouver un objet, balade guidée.
- Les autres outils sont regroupés sous « Explorer davantage ».
- Styles de boutons, focus clavier, états actifs, pictogrammes et contrastes harmonisés.
- Fonctionnement astronomique, actions existantes et capteurs conservés.


## v472 — Action principale et espace de carte
- « Visible maintenant » remplace « Balade guidée » parmi les trois actions prioritaires du menu Découverte.
- « Balade guidée » reste disponible dans « Explorer davantage ».
- Le bloc titre et « Direction observée » sont remontés en mode Découverte, avec un ajustement spécifique au mobile pour libérer davantage de surface de carte.
- Version du cache du service worker incrémentée pour éviter de conserver les anciens fichiers.
- Aucune modification de la logique astronomique ou des capteurs.
