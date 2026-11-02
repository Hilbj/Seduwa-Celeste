Atlas Céleste Seduwa— version 496

## v496
De 15 minutes avant le lever du Soleil jusqu’à 15 minutes après son coucher, la carte s’ouvre centrée sur l’azimut du Soleil ; le reste du temps elle reste pointée au Nord

Correction d'un bug : il touchait en fait deux comètes, C/2020 F3 NEOWISE et C/1995 O1 Hale-Bopp. Le correctif est dans js/minor-planets.js.

La cause : pour retrouver la position d’une comète sur son orbite, le code résolvait l’équation de Kepler avec quelques itérations de Newton. Pour les orbites très allongées (excentricité proche de 1), cette méthode diverge. 

Sur plusieurs dates entre fin 2025 et 2033 :
La position de NEOWISE (excentricité 0,9992) était fausse dans 47 % des cas ;
La position de Hale-Bopp (0,9951) l’était dans 15 % des cas, avec des erreurs de plusieurs ordres de grandeur.

Correction : un solveur qui converge toujours (Newton protégé par une bissection). 

Résultats :
NEOWISE est maintenant stable, de 18,84 UA le 1ᵉʳ novembre 2026 à 19,23 UA en janvier 2027. Au périhélie, le calcul donne 0,295 UA, qui est la valeur du catalogue.
Hale-Bopp est stable lui aussi, autour de 51,3 à 51,5 UA. Son périhélie sort à 0,914 UA, comme dans le catalogue.

Ces deux comètes sont de toute façon invisibles (magnitude de 26 à 27, très au-delà des télescopes amateurs). La correction évite surtout de fausses positions et de fausses magnitudes dans leurs fiches, la recherche et les listes.

Limites : le modèle reste képlérien simplifié, sans perturbations planétaires. Les planètes de solar-system-orbits.js ont aussi une boucle de Newton, mais leurs excentricités sont faibles et elle converge bien.

## v495
- Textes externalisés dans js/ui-texts.js (5 blocs migrés depuis ui.js)
- Doublons supprimés dans COMMON_STAR_NAMES (app.js)
- JSDoc AppState ajouté (app.js)

## v494
- Icônes Unicode remplacées par des SVG monochromes harmonisés (index.html)
- Format "HIP xxx" corrigé (displayStarName)
- Alignement des bandeaux Expert / Découverte en desktop
- Bug du parcours « Ma soirée en 3 étapes » sur mobile corrigé (scrollTop)

## v493
- Visée par défaut mobile à 25° (app.js, ligne 256)
- Optimisation PWA pour iPhone/iPad (manifest, icônes Apple touch, meta tags).
- Correction du bug du « Parcours du soir » sur mobile (le menu ne bloquait plus).
- Visée par défaut ajustée à 25° sur mobile pour un meilleur confort.
- Nouvelle icône réaliste et dynamique pour les comètes sur le canvas.

## v492
- Trois actions prioritaires : pointer le ciel, trouver un objet, balade guidée.
- Les autres outils sont regroupés sous « Explorer davantage ».
- Styles de boutons, focus clavier, états actifs, pictogrammes et contrastes harmonisés.

## v491 
- « Visible maintenant » remplace « Balade guidée » parmi les trois actions prioritaires du menu Découverte.
- « Balade guidée » reste disponible dans « Explorer davantage ».
- Le bloc titre et « Direction observée » sont remontés en mode Découverte, avec un ajustement spécifique au mobile pour libérer davantage de surface de carte.
