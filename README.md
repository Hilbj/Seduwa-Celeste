Seduwa Céleste — version 524

## v522 — Niveau 4 « Instrument requis »

- En mode Découverte, les objets dont la magnitude apparente est supérieure ou égale à 6 reçoivent un quatrième niveau rouge : « Niveau 4 · Instrument requis ».
- Les objets sous l’horizon et le Soleil conservent leurs indications prioritaires.
- Le texte précise que la visibilité des objets étendus dépend aussi de leur luminosité surfacique et des conditions du ciel.
- Les niveaux 1 à 3 restent inchangés ; les calculs astronomiques ne sont pas modifiés.

Base : v521.


## v521 — Fiche Découverte enrichie et navigation au clavier

- Le libellé de position GPS reste dans la langue active, y compris après rechargement ou changement de langue.
- Les anciennes positions GPS mémorisées sont automatiquement reconnues et migrées vers une clé de traduction stable.
- Les lieux prédéfinis conservent leur nom propre et ne sont pas traduits comme des positions GPS.

## v519 — Ajustement de l’en-tête Découverte sur ordinateur

Le menu général et l’horloge d’observation sont automatiquement positionnés sous le bloc titre complet en mode Découverte sur ordinateur. Le calcul tient compte du lieu, des coordonnées et de l’heure locale affichés dans l’en-tête. Les dispositions mobiles et le mode Expert ne sont pas modifiés.

Base : v518 validée.

- Ajout de la hauteur au-dessus de l’horizon et de la magnitude apparente dans les fiches du mode Découverte, lorsque les données sont disponibles.
- Navigation de la carte avec les flèches directionnelles ; Maj + flèche accélère le déplacement.
- Les flèches restent disponibles pour les champs et contrôles de formulaire.


## Version 524 — Cache hors ligne et internationalisation allemande

- L’enregistrement du service worker fonctionne aussi lorsque le chargement asynchrone des dictionnaires i18n se termine après l’événement `load`.
- Le précache traite les ressources individuellement : l’échec d’un fichier ne bloque plus toute l’installation. La page `offline.html` reste la ressource indispensable à l’activation.
- Le cache porte un nouvel identifiant afin de forcer le renouvellement des ressources lors du déploiement.
- `i18n.js` accepte les codes `dataLocale` extensibles et associe correctement l’allemand à `de`, dans la configuration intégrée comme dans `i18n/locales.json`.
- Le numéro de version affiché et les trois libellés accessibles FR/EN/DE passent à v525.
- Les tests automatisés du projet passent (50/50). Le fonctionnement hors ligne réel reste à confirmer sur le site déployé et dans l’application Android.

Base : v523.

## Version 523

- Ajout d’une page de secours autonome affichée lorsqu’une navigation ne peut pas être chargée hors connexion et qu’aucune page équivalente n’est disponible dans le cache.
- La page de secours reprend l’identité visuelle de Seduwa Céleste et est disponible en français, anglais et allemand.
- Activation de l’allemand comme troisième langue de l’interface ; les noms de catalogues restent sur la base de données anglaise lorsque la traduction allemande des données astronomiques n’est pas disponible.
- Ajout des dernières clés manquantes au dictionnaire allemand.
