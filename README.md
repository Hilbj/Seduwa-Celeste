Seduwa Ciel — version 1.4

## v2.0 — ajout de "pilotage de télescope", mobile et ordinateur

- Ajout d'une nouvelle fonction : Pilotage de télescope.
- Ajout du bouton « Pointer le télescope vers cet objet » dans la fiche descriptive ; il n'apparaît que lorsque le serveur INDI et la monture sont confirmés disponibles et que les coordonnées équatoriales de l'objet sont valides.
- Chaque GOTO depuis une fiche exige une confirmation explicite, il utilise le jeton saisi dans le panneau de pilotage.
- Un marqueur cyan en forme de télescope indique la position actuelle sur la carte céleste. Les coordonnées de monture INDIGO (`MOUNT_EQUATORIAL_COORDINATES`) sont traitées en J2000 ; les corps du système solaire fournissent donc aussi leurs coordonnées J2000 dédiées pour le GOTO, sans modifier les coordonnées de date utilisées par l'affichage. Le marqueur est masqué lorsque la monture n'est plus disponible, lorsque les coordonnées ne sont pas lisibles ou lorsque la carte est réglée sur une date passée.
- Une paire de coordonnées J2000 supplémentaire est calculée pour les corps du système solaire afin de fournir au GOTO l'époque attendue par INDIGO.

**Réseau local et navigateur :** sur un mobile, renseigner l'adresse LAN de l'appareil qui héberge la passerelle (par exemple `http://192.168.x.x:8768`). La passerelle doit écouter sur l'interface LAN et autoriser CORS pour l'origine de l'application, les méthodes `GET` et `POST`, ainsi que les en-têtes `Content-Type` et `X-Seduwa-Token`. Aucun jeton n'est enregistré dans le navigateur. Si l'application est chargée depuis une adresse HTTPS publique, le navigateur peut bloquer l'appel vers une passerelle HTTP locale (contenu mixte / accès au réseau local) : il faut alors une passerelle HTTPS avec certificat approuvé par le mobile, ou servir également l'application depuis le réseau local en HTTP. CORS seul ne contourne pas cette restriction.

## v1.4 — Calendrier céleste dynamique sur 12 mois glissants

- Le calendrier utilise maintenant la date réelle du lieu d’observation sélectionné, indépendamment de la date de session choisie pour l'observation.
- La fenêtre couvre les 12 prochains mois civils et avance automatiquement à mesure que le temps passe ; les événements passés sont retirés.
- Les 4 phases lunaires sont calculées avec "Astronomy Engine". Les fenêtres favorables au ciel profond sont générées autour des nouvelles Lunes.
- Les essaims météoritiques sont récurrents : Quadrantides, Lyrides, Êta-Aquarides, δ-Aquarides du Sud, α-Capricornides, Perséides, Draconides, Orionides, Taurides du Sud et du Nord, Léonides, Géminides et Ursides.
- Les éclipses lunaires sont calculées et les éclipses solaires ne sont proposées que si une phase est au-dessus de l’horizon du lieu sélectionné.
- Les oppositions des planètes extérieures et les élongations maximales de Mercure et Vénus sont calculées dynamiquement.

## v1.3 — Balades guidées selon l’hémisphère

- Les balades de l’hémisphère nord ne sont plus proposées aux observateurs situés dans l’hémisphère sud, et inversement.
- Ajout des balades australes : la Croix du Sud, 3 grands repères stellaires (Canopus, Achernar, Fomalhaut), Oméga du Centaure, les trésors de la Carène, et les amas de la Voile et de la Poupe.
- Les balades sont filtrées selon la saison de l’année d’observation et la visibilité depuis le lieu sélectionné.

## v1.2 — Niveau 4 « Instrument requis »

- En mode Découverte, les objets dont la magnitude apparente est supérieure ou égale à 6 reçoivent un quatrième niveau rouge : « Niveau 4 · Instrument requis ».
- Les objets sous l’horizon et le Soleil conservent leurs indications prioritaires.
- Le texte précise que la visibilité des objets étendus dépend aussi de leur luminosité surfacique et des conditions du ciel.

## v1.1 — Fiche Découverte enrichie et navigation au clavier

- Le libellé de position GPS reste dans la langue active, y compris après rechargement ou changement de langue.
- Les anciennes positions GPS mémorisées sont automatiquement reconnues et migrées vers une clé de traduction stable.
- Les lieux prédéfinis conservent leur nom propre et ne sont pas traduits comme des positions GPS.

## v1.0 — Ajustement de l’en-tête Découverte sur ordinateur

Le menu général et l’horloge d’observation sont automatiquement positionnés sous le bloc titre complet en mode Découverte sur ordinateur. Le calcul tient compte du lieu, des coordonnées et de l’heure locale affichés dans l’en-tête.

- Ajout de la hauteur au-dessus de l’horizon et de la magnitude apparente dans les fiches du mode Découverte, lorsque les données sont disponibles.
- Navigation de la carte avec les flèches directionnelles ; Maj + flèche accélère le déplacement.
- Les flèches restent disponibles pour les champs et contrôles de formulaire.

## Version 0.9 — Cache hors ligne et internationalisation allemande

- L’enregistrement du service worker fonctionne aussi lorsque le chargement asynchrone des dictionnaires i18n se termine après l’événement `load`.
- Le précache traite les ressources individuellement : l’échec d’un fichier ne bloque plus toute l’installation. La page `offline.html` reste la ressource indispensable à l’activation.

## Version 0.8

- Ajout d’une page de secours autonome affichée lorsqu’une navigation ne peut pas être chargée hors connexion et qu’aucune page équivalente n’est disponible dans le cache.
- La page de secours reprend l’identité visuelle de Seduwa Ciel et est disponible en français, anglais et allemand.
