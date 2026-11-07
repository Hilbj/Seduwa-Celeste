
"use strict";

const CACHE_NAME = "atlas-celeste-v525-secours-http-i18n";

const MILKY_WAY_MAP_URL = "https://cdn.eso.org/images/screen/ESA_Gaia_DR2_AllSky_Brightness_Colour_black_bg_8k.jpg";

const APP_FILES = [
  "./",
  "./index.html",
  "./offline.html",
  "./style.css",
  "./app.js",
  "./js/locale-init.js",
  "./js/i18n.js",
  "./manifest.json",

  // Modules JavaScript
  "./js/astronomy.js",
  "./js/ui.js",
  "./js/sensors.js",
  "./js/solar-system.js",
  "./js/solar-system-orbits.js",
  "./js/minor-planets.js",
  "./js/catalogues.js",
  "./js/rise-transit-set.js",
  "./js/visible-target-ranking.js",
  "./js/visible-target-filters.js",
  "./js/tonight-recommendations.js",
  "./js/observing-difficulty.js",
  "./js/star-hop-route.js",
  "./i18n/locales.json",
  "./i18n/fr.json",
  "./i18n/en.json",
  "./i18n/de.json",

  // Icônes de l’application
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",

  // Bibliothèque Astronomy Engine locale
  "./js/astronomy.browser.min.js",

  // Catalogues indispensables
  "./data/stars.json",
  "./data/constellations.json",
  "./data/ngc-not-messier.json",
  "./data/minor-planets.json"
];

// Ressources facultatives
const OPTIONAL_FILES = [
  "./data/messier.json"
];

/* ============================================================
   INSTALLATION
   ============================================================ */

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const results = await Promise.allSettled(
      [...APP_FILES, ...OPTIONAL_FILES].map(async url => {
        const request = new Request(url, { cache: "reload" });
        const response = await fetch(request);
        if (!response.ok) {
          throw new Error(`${url} : HTTP ${response.status}`);
        }
        await cache.put(request, response);
      })
    );

    const failures = results
      .map((result, index) => ({ result, url: [...APP_FILES, ...OPTIONAL_FILES][index] }))
      .filter(item => item.result.status === "rejected");

    if (failures.length) {
      console.warn(
        "[SEDUWA] Certaines ressources n'ont pas pu être précachées :",
        failures.map(item => `${item.url} (${item.result.reason})`)
      );
    }

    // La page de secours doit absolument être disponible avant l'activation.
    const offlineUrl = new URL("./offline.html", self.registration.scope).href;
    const offlinePage = await cache.match(offlineUrl, { ignoreSearch: true });
    if (!offlinePage) {
      throw new Error("Installation impossible : offline.html n'a pas pu être mise en cache.");
    }

    await self.skipWaiting();
  })());
});

/* ============================================================
   ACTIVATION ET NETTOYAGE DES ANCIENS CACHES
   ============================================================ */

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();

    await Promise.all(
      cacheNames
        .filter(name =>
          name.startsWith("atlas-celeste-") &&
          name !== CACHE_NAME
        )
        .map(name => caches.delete(name))
    );

    await self.clients.claim();
  })());
});

/* ============================================================
   REQUÊTES : RÉSEAU EN PRIORITÉ, CACHE EN SECOURS
   ============================================================ */

self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  // La carte Gaia est la seule ressource externe gérée par ce service worker.
  if (request.url === MILKY_WAY_MAP_URL) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
        return response;
      } catch (error) {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        throw error;
      }
    })());
    return;
  }

  // Ne gérer que les ressources de cette application et la carte ci-dessus.
  if (url.origin !== self.location.origin) return;

  // Navigation : conserver l’application en cache si elle existe ; sinon afficher
  // la page de secours autonome, elle-même précachée à l’installation.
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const offlineUrl = new URL("./offline.html", self.registration.scope).href;

      try {
        const response = await fetch(request);

        // fetch() ne rejette pas les réponses HTTP 404/500 : elles doivent être
        // traitées explicitement pour afficher la page de secours.
        if (!response.ok) {
          const offlinePage = await caches.match(offlineUrl, { ignoreSearch: true });
          if (offlinePage) return offlinePage;
          return response;
        }

        return response;
      } catch (error) {
        // En cas de vraie coupure réseau, privilégier l'application déjà en cache.
        const cachedPage = await caches.match(request, { ignoreSearch: true });
        if (cachedPage) return cachedPage;

        const offlinePage = await caches.match(offlineUrl, { ignoreSearch: true });
        if (offlinePage) return offlinePage;

        return new Response("Page indisponible hors ligne.", {
          status: 503,
          statusText: "Service Unavailable",
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    try {
      const response = await fetch(request);

      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }

      return response;
    } catch (error) {
      // ignoreSearch : style.css?v=… et app.js?v=… doivent retrouver les fichiers
      // pré-cachés (./style.css, ./app.js) quand l'appareil est hors ligne.
      const cachedResponse = await caches.match(request, { ignoreSearch: true });

      if (cachedResponse) return cachedResponse;

      return new Response("Ressource indisponible hors ligne.", {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }
  })());
});
