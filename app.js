
"use strict";

import {
  clamp,
  norm360,
  norm180,
  rad,
  deg,
  equatorialToHorizontal,
  propagateProperMotionJ2000
} from "./js/astronomy.js";

import {
  nameKey,
  fetchJson,
  extractRows,
  normalizeStar,
  normalizeMessier,
  normalizeConstellation
} from "./js/catalogues.js";

import { createSensors } from "./js/sensors.js";
import { t, getLocale } from "./js/i18n.js";
import { createSolarSystem } from "./js/solar-system.js";
import { calculateMinorPlanetPosition, calculateMinorPlanetPositions } from "./js/minor-planets.js";
import { createUI } from "./js/ui.js";

(() => {
  const $ = id => document.getElementById(id);

  // Mesure la barre mobile réelle (une ou plusieurs rangées) afin que le
  // panneau date/heure reste juste au-dessus, sans réserver une hauteur fixe.
  const syncMobileToolbarHeight = () => {
    const toolbar = document.querySelector("#app > .toolbar");
    if (!toolbar) return;
    const height = Math.ceil(toolbar.getBoundingClientRect().height);
    document.documentElement.style.setProperty("--mobile-toolbar-height", `${height}px`);
  };
  syncMobileToolbarHeight();
  if (typeof ResizeObserver !== "undefined") {
    const toolbar = document.querySelector("#app > .toolbar");
    if (toolbar) new ResizeObserver(syncMobileToolbarHeight).observe(toolbar);
  }
  window.addEventListener("resize", syncMobileToolbarHeight, { passive: true });
  const canvas = $("sky");
  // Ces éléments restent les mêmes pendant toute la vie de l’application :
  // conserver leurs références évite des recherches DOM répétées à chaque image.
  const appElement = $("app");
  const discoveryStartPanelElement = $("discovery-start-tonight");
  const discoverySearchPanelElement = $("discovery-search-panel");
  const visibleCountElement = $("visible-count");

  if (!canvas) {
    console.error("Atlas Céleste : canvas #sky introuvable.");
    return;
  }

  const ctx = canvas.getContext("2d");

  if (!ctx) {
    console.error("Atlas Céleste : Canvas 2D indisponible.");
    return;
  }

  const TAU = Math.PI * 2;

  /*
   * Époque des coordonnées des catalogues fixes.
   *
   * "J2000" : coordonnées équatoriales J2000.
   * "date"  : coordonnées déjà exprimées pour l'équinoxe
   *            moyen de la date d'observation.
   *
   * Ce réglage concerne les catalogues d'étoiles et Messier,
   * pas les positions du Soleil, de la Lune et des planètes.
   */
  const CATALOGUE_EPOCH = "J2000";

    // Noms usuels des étoiles les plus brillantes, indexés par numéro HIP.
  // (Doublons supprimés pour éviter les écrasements silencieux)
  const COMMON_STAR_NAMES = {
    677: "Alphératz", 746: "Caph", 1067: "Algenib", 3179: "Schedar",
    4427: "Navi", 5447: "Mirach", 6686: "Ruchbah", 7588: "Achernar",
    8886: "Segin", 9884: "Hamal", 14135: "Menkar", 14576: "Algol",
    15863: "Mirfak", 21421: "Aldébaran", 24436: "Rigel", 24608: "Capella",
    25336: "Bellatrix", 25428: "Elnath", 25930: "Mintaka", 26311: "Alnilam",
    26727: "Alnitak", 27989: "Bételgeuse", 30438: "Canopus", 32349: "Sirius",
    33579: "Wezen", 36850: "Castor", 37279: "Procyon", 37826: "Pollux",
    49669: "Régulus", 53910: "Mérak", 54061: "Dubhé", 57632: "Dénébola",
    60718: "Acrux", 62434: "Gacrux", 63090: "Zosma", 65378: "Mizar",
    65474: "Spica", 67301: "Alkaïd", 68702: "Hadar", 69673: "Arcturus",
    71683: "Alpha Centauri", 80763: "Antarès", 91262: "Véga", 97649: "Altaïr",
    102098: "Deneb", 102488: "Gienah", 113368: "Fomalhaut", 11767: "Étoile Polaire",
    31592: "Alhena", 39953: "Avior", 41037: "Menkalinan", 46390: "Adhara",
    59774: "Alphard", 62956: "Gienah Corvi", 65477: "Syrma", 76267: "Kaus Australis",
    77070: "Shaula", 82273: "Kaus Media", 85927: "Nunki", 86742: "Rasalhague",
    88635: "Eltanin", 90185: "Peacock", 92855: "Rasalgethi", 94376: "Rastaban",
    100453: "Sadr", 104732: "Enif", 107315: "Sadalsuud", 109268: "Sadalmelik",
    110960: "Scheat", 113881: "Markab", 116727: "Mimosa"
  };

  function displayStarName(star) {
    const hip = Number(star?.hip ?? String(star?.id ?? "").match(/^HIP[_\s-]*(\d+)$/i)?.[1]);
    if (COMMON_STAR_NAMES[hip]) return COMMON_STAR_NAMES[hip];
    const properName = star?.proper_name || star?.properName;
    if (properName && !/^HIP[_\s-]*\d+$/i.test(String(properName))) return properName;
    const catalogName = star?.name;
    if (!catalogName || /^HIP[_\s-]*\d+$/i.test(String(catalogName))) {
      return hip ? `HIP ${hip}` : "";
    }
    return catalogName.replace(/^HIP[_\s-]*(\d+)$/i, "HIP $1");
  }

  const LOCATION_STORAGE_KEY = "atlas-celeste-last-observation-location";
  const DEFAULT_LOCATION = Object.freeze({
    latitude: 48.8566,
    longitude: 2.3522,
    locationName: "Paris"
  });
  function loadLastObservationLocation() {
    try {
      const saved = JSON.parse(localStorage.getItem(LOCATION_STORAGE_KEY) || "null");
      if (saved && Number.isFinite(saved.latitude) && Number.isFinite(saved.longitude) &&
          saved.latitude >= -90 && saved.latitude <= 90 &&
          saved.longitude >= -180 && saved.longitude <= 180) {
        return {
          latitude: saved.latitude,
          longitude: saved.longitude,
          locationName: typeof saved.locationName === "string" && saved.locationName.trim()
            ? saved.locationName.trim() : t("ui.savedPosition")
        };
      }
    } catch { /* Stockage indisponible : Paris reste le lieu de repli. */ }
    return { ...DEFAULT_LOCATION };
  }
  function persistLastObservationLocation() {
    try {
      localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify({
        latitude: state.latitude,
        longitude: state.longitude,
        locationName: state.locationName || t("ui.savedPosition")
      }));
    } catch { /* La position reste utilisable même sans stockage local. */ }
  }
  const initialLocation = loadLastObservationLocation();

  const DISPLAY_CATEGORY_STORAGE_KEY = "atlas-celeste-display-categories";
  const DISPLAY_CATEGORY_DEFAULTS = Object.freeze({
    stars: true, planets: true, sun: true, moon: true,
    messier: true, ngc: true, minorPlanets: true, dwarfPlanets: true
  });
  function loadDisplayCategoryPreferences() {
    const preferences = { ...DISPLAY_CATEGORY_DEFAULTS };
    try {
      const saved = JSON.parse(localStorage.getItem(DISPLAY_CATEGORY_STORAGE_KEY) || "null");
      if (saved && typeof saved === "object") {
        for (const key of Object.keys(preferences)) {
          if (typeof saved[key] === "boolean") preferences[key] = saved[key];
        }
      }
    } catch { /* Le stockage peut être indisponible en navigation privée. */ }
    return preferences;
  }
  function persistDisplayCategoryPreferences(preferences) {
    try { localStorage.setItem(DISPLAY_CATEGORY_STORAGE_KEY, JSON.stringify(preferences)); }
    catch { /* L'affichage reste utilisable sans stockage local. */ }
  }

  /**
   * @typedef {Object} AppState
   * @property {number} latitude
   * @property {number} longitude
   * @property {string} locationName
   * @property {boolean} locationReady
   * @property {Date|null} observationDate
   * @property {number} heading
   * @property {number} pitch
   * @property {number|null} rawHeading
   * @property {string} headingSource
   * @property {number} rawHeadingDelta
   * @property {number} filteredHeadingDelta
   * @property {boolean} gyroDataSeen
   * @property {number|null} gyroRateAlpha
   * @property {number|null} gyroRateBeta
   * @property {number|null} gyroRateGamma
   * @property {number|null} gyroRateMagnitude
   * @property {number} gyroLastUpdate
   * @property {boolean} gyroMotionActive
   * @property {string} headingDecision
   * @property {number} headingMotionSamples
   * @property {number} headingMotionTravel
   * @property {boolean} headingMotionConfirmed
   * @property {number} roll
   * @property {boolean} sensorActive
   * @property {boolean} orientationListening
   * @property {number} lastOrientationTime
   * @property {number} lastPitchTime
   * @property {number} orientationSamples
   * @property {number} fov
   * @property {number} verticalFov
   * @property {number} horizonRatio
   * @property {number} width
   * @property {number} height
   * @property {number} dpr
   * @property {Array<any>} stars
   * @property {Array<any>} messier
   * @property {Array<any>} ngc
   * @property {Array<any>} minorPlanets
   * @property {number} minorPlanetsEpochJD
   * @property {Object} displayCategories
   * @property {Array<any>} constellations
   * @property {Array<any>} visibleObjects
   * @property {boolean} showConstellations
   * @property {boolean} showEclipticGrid
   * @property {string} discoveryConstellationId
   * @property {any} discoveryWalkOverlay
   * @property {Set<string>} discoveryConstellationStarIds
   * @property {string} discoveryConstellationTargetStarId
   * @property {boolean} showConstellationBoundaries
   * @property {boolean} showStarLabels
   * @property {boolean} reviewStarsOnly
   * @property {any} constellationBoundaryLines
   * @property {boolean} constellationBoundariesLoading
   * @property {any} selected
   * @property {boolean} finderActive
   * @property {boolean} finderLocked
   * @property {number} finderLockSince
   * @property {string} skyGuideMode
   * @property {string} skyGuideFreeTargetId
   * @property {any} skyGuideSavedSelection
   * @property {any} skyGuideSavedConstellations
   * @property {number} skyGuideProgress
   * @property {boolean} dragging
   * @property {boolean} moved
   * @property {number} lastX
   * @property {number} lastY
   * @property {number} starCount
   * @property {number} starsAboveHorizon
   * @property {number} objectsInField
   * @property {boolean} immersive
  */

  /** @type {AppState} */

  const state = {
    latitude: initialLocation.latitude,
    longitude: initialLocation.longitude,
    locationName: initialLocation.locationName,
    locationReady: true,
    observationDate: null,

    heading: 0,
    // Bureau (grand écran, souris) : sans capteur d'orientation, une visée à 0° place
    // l'horizon au milieu de l'écran et réserve la moitié de la carte au sol vide.
    // On démarre plus haut ; les capteurs et les gestes reprennent ensuite la main.
    pitch: (typeof window.matchMedia === "function" && window.matchMedia("(min-width: 901px) and (pointer: fine)").matches) ? 20 : 0,
    // Diagnostics capteur facultatifs : ne modifient pas le rendu.
    rawHeading: null,
    headingSource: "indisponible",
    rawHeadingDelta: 0,
    filteredHeadingDelta: 0,
    gyroDataSeen: false,
    gyroRateAlpha: null,
    gyroRateBeta: null,
    gyroRateGamma: null,
    gyroRateMagnitude: null,
    gyroLastUpdate: 0,
    gyroMotionActive: false,
    headingDecision: "inactif",
    headingMotionSamples: 0,
    headingMotionTravel: 0,
    headingMotionConfirmed: false,
    roll: 0,

    sensorActive: false,
    orientationListening: false,
    lastOrientationTime: 0,
    lastPitchTime: 0,
    orientationSamples: 0,

    fov: 75,
    verticalFov: 83.3333333333,
    horizonRatio: 0.76,

    width: 0,
    height: 0,
    dpr: 1,

    stars: [],
    messier: [],
    ngc: [],
    minorPlanets: [],
    minorPlanetsEpochJD: 2461200.5,
    displayCategories: loadDisplayCategoryPreferences(),
    constellations: [],
    visibleObjects: [],

    showConstellations: false,
    showEclipticGrid: (() => {
      try { return localStorage.getItem("atlas-celeste-ecliptic-grid") === "true"; }
      catch { return false; }
    })(),
    discoveryConstellationId: "",
    discoveryWalkOverlay: null,
    discoveryConstellationStarIds: new Set(),
    discoveryConstellationTargetStarId: "",
    showConstellationBoundaries: false,
    showStarLabels: true,
    reviewStarsOnly: false,
    constellationBoundaryLines: null,
    constellationBoundariesLoading: false,
    selected: null,
    finderActive: false,
    finderLocked: false,
    finderLockSince: 0,
    skyGuideMode: "targeted",
    skyGuideFreeTargetId: "",
    skyGuideSavedSelection: null,
    skyGuideSavedConstellations: null,
    skyGuideProgress: 0,

    dragging: false,
    moved: false,
    lastX: 0,
    lastY: 0,

    starCount: 0,
    starsAboveHorizon: 0,
    objectsInField: 0,

    immersive: false
  };

  function isMapObjectCategoryEnabled(object) {
    if (!object || typeof object !== "object") return true;
    const filters = state.displayCategories || DISPLAY_CATEGORY_DEFAULTS;
    const type = String(object.type || "").toLowerCase();
    const catalogue = String(object.catalogue || "").toLowerCase();
    const id = String(object.id || object.designation || "").trim();
    if (type === "star" || catalogue === "hipparcos" || object.hip != null) return filters.stars !== false;
    if (type === "planet") return filters.planets !== false;
    if (type === "sun") return filters.sun !== false;
    if (type === "moon") return filters.moon !== false;
    if (object.dwarfPlanet === true || type === "dwarf-planet" || catalogue.includes("planètes naines")) return filters.dwarfPlanets !== false;
    if (type === "comet" || catalogue.includes("comètes")) return filters.minorPlanets !== false;
    if (type === "minor-planet" || catalogue.includes("planètes mineures")) return filters.minorPlanets !== false;
    if (catalogue === "ngc" || /^ngc\s*\d+/i.test(id)) return filters.ngc !== false;
    if (catalogue === "messier" || /^m\s*\d+/i.test(id)) return filters.messier !== false;
    return true;
  }

  // La couleur de l'heure et de la date indique le mode d'observation.
  function syncObservationModeVisuals() {
    const appRoot = document.getElementById("app");
    if (!appRoot) return;
    const manual = Boolean(state.observationDate);
    appRoot.classList.toggle("observation-manual", manual);
    appRoot.classList.toggle("observation-realtime", !manual);
  }
  syncObservationModeVisuals();

  let ui;

    // Seuils du verrouillage visuel, en degrés.
    const FINDER_LOCK_ENTER = 0.8;
    const FINDER_LOCK_EXIT = 1.5;
    const FINDER_LOCK_DELAY = 800;

  /* ==========================================================
     OUTILS
     ========================================================== */

  function isValidDate(date) {
    return date instanceof Date &&
      Number.isFinite(date.getTime());
  }

  function horizontalPosition(ra, dec, date) {
    if (
      !Number.isFinite(ra) ||
      !Number.isFinite(dec) ||
      !isValidDate(date)
    ) {
      return { az: NaN, alt: NaN };
    }

    return equatorialToHorizontal(
      ra,
      dec,
      date,
      state.latitude,
      state.longitude,
      { epoch: CATALOGUE_EPOCH }
    );
  }

  function starHorizontalPosition(star, date) {
    let ra = star.ra;
    let dec = star.dec;
    if (
      star?.astrometry_epoch === 2000 &&
      Number.isFinite(star.pm_ra_cosdec_mas_yr) &&
      Number.isFinite(star.pm_dec_mas_yr)
    ) {
      const propagated = propagateProperMotionJ2000(
        ra, dec, star.pm_ra_cosdec_mas_yr, star.pm_dec_mas_yr, date
      );
      if (propagated) ({ ra, dec } = propagated);
    }
    return horizontalPosition(ra, dec, date);
  }

  /* ==========================================================
     CAPTEURS ET SYSTÈME SOLAIRE
     ========================================================== */

  const sensors = createSensors({
    state,
    $,
    showToast: message => ui.showToast(message),
    drawSky,
    clamp,
    norm360,
    norm180,
    rad,
    deg
  });

  const solarSystem = createSolarSystem({
    state,
    norm360
  });

  // Une même image de la carte et son guidage doivent utiliser exactement
  // les mêmes coordonnées des corps du Système solaire. Le cache est indexé
  // sur l’instant exact et le lieu : il ne fige donc pas l’éphéméride entre
  // deux images, mais évite des calculs distincts au sein d’une même image.
  let solarFrameCacheKey = "";
  let solarFrameCacheObjects = [];
  function solarObjectsAt(date) {
    const timestamp = date instanceof Date ? date.getTime() : new Date(date).getTime();
    const key = `${timestamp}|${state.latitude}|${state.longitude}`;
    if (key !== solarFrameCacheKey) {
      solarFrameCacheObjects = solarSystem.makeSolarSystem(new Date(timestamp));
      solarFrameCacheKey = key;
    }
    return solarFrameCacheObjects;
  }

  // Le panneau « Visible maintenant » possède sa propre date.
  // L'ouvrir ne doit pas figer l'horloge de la carte au prochain coucher du Soleil.
  // En revanche, ses listes doivent calculer les positions pour la date affichée
  // dans ce panneau, même si la carte principale reste en temps réel.
  function getCatalogueQueryDate() {
    const dialog = $("visible-now-dialog");
    const input = $("visible-now-datetime");
    if (dialog && !dialog.hidden && input?.value) {
      const panelDate = new Date(input.value);
      if (isValidDate(panelDate)) return panelDate;
    }
    return state.observationDate || new Date();
  }

  /* ==========================================================
     INTERFACE
     ========================================================== */

  ui = createUI({
    state,
    $,
    canvas,
    ctx,
    drawSky,
    handleCanvasTap,
    locateUser,
    sensors,
    setImmersive,
    enterFinder,
    exitFinder,
    onLocationChange: () => refreshAutoHeading(),
    onObservationDateChange: date => {
      state.observationDate = date;
      refreshAutoHeading();
      syncObservationModeVisuals();
      const label = $("observation-mode");
      if (label) label.textContent = date ? t("ui.dateChosen") : t("ui.realtime");
      horizontalPositionCache.key = null;
      drawSky();
      ui?.updateClock();
      ui?.refreshVisibleNow(true);
      if (state.selected) ui?.updateObjectCard(selectedPosition(date || new Date()));
    },
    getStarPosition: star => starHorizontalPosition(star, state.observationDate || new Date()),
    getCatalogObjects: () => {
      const date = getCatalogueQueryDate();
      const deepSky = [...state.messier, ...state.ngc].map(object => {
        const pos = horizontalPosition(Number(object.ra), Number(object.dec), date);
        return {
          ...object,
          ...pos,
          catalogue: String(object.id || '').toUpperCase().startsWith('NGC') ? 'NGC' : 'Messier'
        };
      });
      const stars = (state.stars || []).map(star => ({
        ...star,
        ...horizontalPosition(Number(star.ra), Number(star.dec), date),
        catalogue: 'Hipparcos'
      }));
      // Le catalogue de recherche inclut aussi les corps du Système solaire,
      // y compris la Lune et les planètes sous l’horizon, pour les fiches calendrier.
      const solar = solarObjectsAt(date).map(object => ({ ...object, catalogue: 'Système solaire' }));
      const minorPlanets = calculateMinorPlanetPositions(
        state.minorPlanets, date, state.latitude, state.longitude, state.minorPlanetsEpochJD
      );
      return [...stars, ...deepSky, ...solar, ...minorPlanets];
    },
    getVisibleNowObjects: () => {
      const date = getCatalogueQueryDate();
      const targets = [];
      for (const object of [...state.messier, ...state.ngc]) {
        const pos = horizontalPosition(Number(object.ra), Number(object.dec), date);
        if (Number.isFinite(pos.az) && Number.isFinite(pos.alt) && pos.alt > 0) {
          targets.push({ ...object, ...pos, catalogue: String(object.id || '').toUpperCase().startsWith('NGC') ? 'NGC' : 'Messier' });
        }
      }
      const solar = solarObjectsAt(date);
      if (Array.isArray(solar)) {
        for (const object of solar) {
          if (object && Number.isFinite(object.alt) && object.alt > 0 && object.type !== 'sun') targets.push({ ...object, catalogue: 'Système solaire' });
        }
      }
      for (const object of calculateMinorPlanetPositions(
        state.minorPlanets, date, state.latitude, state.longitude, state.minorPlanetsEpochJD
      )) {
        if (Number.isFinite(object.alt) && object.alt > 0) targets.push(object);
      }
      return targets;
    },
    selectTarget: object => {
      state.selected = { ...object };
      ui.updateObjectCard(state.selected);
      drawSky();
      enterFinder();
    },
    resizeCanvas,

    updateClock: () => {
      const clock = $("clock");

      if (clock) {
        const displayedDate = state.observationDate || new Date();
        const dateInput = $("observation-datetime");
        if (dateInput && document.activeElement !== dateInput &&
            $("observation-dialog")?.hidden !== false) {
          dateInput.value = formatLocalDateTime(displayedDate);
        }
        const visibleNowDateInput = $("visible-now-datetime");
        const visibleNowDialogOpen = $("visible-now-dialog")?.hidden === false;
        // Le champ du panneau « visible » est indépendant : l'horloge générale
        // ne doit pas l'écraser à chaque seconde lorsqu'on consulte une autre heure.
        if (visibleNowDateInput && !visibleNowDialogOpen && document.activeElement !== visibleNowDateInput) {
          visibleNowDateInput.value = formatLocalDateTime(displayedDate);
        }
        clock.textContent =
          displayedDate.toLocaleTimeString(getLocale(), { hourCycle: "h23" });
        const dateLabel = $("date-label");
        const discoveryClock = $("discovery-clock");
        const discoveryDateLabel = $("discovery-date-label");
        if (discoveryClock) {
          discoveryClock.textContent = displayedDate.toLocaleTimeString(getLocale(), { hourCycle: "h23" });
        }
        const formattedDate = displayedDate.toLocaleDateString(getLocale(), {
          weekday: "short", day: "2-digit", month: "short", year: "numeric"
        });
        if (dateLabel) dateLabel.textContent = formattedDate;
        if (discoveryDateLabel) discoveryDateLabel.textContent = formattedDate;
      }
    },

    updateLocationLabel: () => {
      const label = $("location-label");

      if (label) {
        label.textContent =
          `${state.latitude.toFixed(4)}°, ` +
          `${state.longitude.toFixed(4)}°`;
      }
    },

    updateReadout: () => {
      const heading = $("heading");

      if (heading) {
        heading.textContent =
          `${Math.round(norm360(state.heading))}°`;
      }

      const pitch = $("pitch");

      if (pitch) {
        pitch.textContent =
          `${state.pitch.toFixed(1)}°`;
      }
    }
  });

  /* ==========================================================
     DATE D'OBSERVATION : dialogue centré, validation explicite
     ========================================================== */

  function formatLocalDateTime(date) {
    const pad = value => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
      `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  const observationInput = $("observation-datetime");
  const observationDialog = $("observation-dialog");
  const observationOpen = $("observation-open");
  const dateLabel = $("date-label");

  function openObservationDialog() {
    if (!observationInput || !observationDialog) return;
    observationInput.value = formatLocalDateTime(state.observationDate || new Date());
    observationDialog.hidden = false;
    requestAnimationFrame(() => observationInput.focus());
  }

  function closeObservationDialog() {
    if (observationDialog) observationDialog.hidden = true;
  }

  function applyObservationDate() {
    const value = observationInput?.value;
    const parsed = value ? new Date(value) : null;
    if (!parsed || !Number.isFinite(parsed.getTime())) {
      ui.showToast("Choisissez une date et une heure valides.");
      return;
    }
    state.observationDate = parsed;
    refreshAutoHeading();
    syncObservationModeVisuals();
    const label = $("observation-mode");
    if (label) label.textContent = t("ui.dateChosen");
    horizontalPositionCache.key = null;
    closeObservationDialog();
    drawSky();
    ui.updateClock();
    if (state.selected) ui.updateObjectCard(selectedPosition(parsed));
  }

  if (observationInput) {
    observationInput.value = formatLocalDateTime(new Date());
  }
  observationOpen?.addEventListener("click", openObservationDialog);
  dateLabel?.addEventListener("click", openObservationDialog);
  $("discovery-local-time")?.addEventListener("click", openObservationDialog);
  dateLabel?.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openObservationDialog();
    }
  });
  $("observation-apply")?.addEventListener("click", applyObservationDate);
  $("observation-close")?.addEventListener("click", closeObservationDialog);
  $("observation-cancel")?.addEventListener("click", closeObservationDialog);
  observationDialog?.querySelector("[data-close-observation]")?.addEventListener(
    "click", closeObservationDialog
  );
  observationInput?.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyObservationDate();
    } else if (event.key === "Escape") {
      closeObservationDialog();
    }
  });

  const liveTimeButton = $("observation-now");
  if (liveTimeButton) {
    liveTimeButton.addEventListener("click", () => {
      state.observationDate = null;
      refreshAutoHeading();
      syncObservationModeVisuals();
      if (observationInput) observationInput.value = formatLocalDateTime(new Date());
      const label = $("observation-mode");
      if (label) label.textContent = t("ui.realtime");
      closeObservationDialog();
      horizontalPositionCache.key = null;
      drawSky();
      ui.updateClock();
      if (state.selected) ui.updateObjectCard(selectedPosition(new Date()));
    });
  }

  /* ==========================================================
     PROJECTION DU CIEL
     ========================================================== */

  function cameraCoordinates(az, alt) {
    const a = rad(az);
    const h = rad(alt);
    const heading = rad(state.heading);
    const pitch = rad(state.pitch);

    /*
     * Repère local :
     * X = est
     * Y = nord
     * Z = zénith
     */
    const east = Math.cos(h) * Math.sin(a);
    const north = Math.cos(h) * Math.cos(a);
    const up = Math.sin(h);

    const forwardX =
      Math.cos(pitch) * Math.sin(heading);

    const forwardY =
      Math.cos(pitch) * Math.cos(heading);

    const forwardZ = Math.sin(pitch);

    const rightX = Math.cos(heading);
    const rightY = -Math.sin(heading);

    const upX = -Math.sin(pitch) * Math.sin(heading);
    const upY = -Math.sin(pitch) * Math.cos(heading);
    const upZ = Math.cos(pitch);

    return {
      x: east * rightX + north * rightY,

      y:
        east * upX +
        north * upY +
        up * upZ,

      z:
        east * forwardX +
        north * forwardY +
        up * forwardZ
    };
  }

  function horizonY() {
    return state.height * state.horizonRatio;
  }

  // Projection caméra : l'axe optique du téléphone correspond au centre de
  // l'écran. L'horizon est projeté à partir de cette même origine et se déplace
  // avec l'inclinaison ; horizonY() reste une référence de mise en page, pas
  // l'origine optique. Cette convention doit être identique à celle du guidage.
  function projectDirectionToScreen(az, alt) {
    if (!Number.isFinite(az) || !Number.isFinite(alt)) return null;
    const p = cameraCoordinates(az, alt);
    if (!Number.isFinite(p.z) || p.z <= 0.0001) return null;

    const roll = rad(state.roll);
    const xRot = p.x * Math.cos(roll) - p.y * Math.sin(roll);
    const yRot = p.x * Math.sin(roll) + p.y * Math.cos(roll);
    const fx = state.width / (2 * Math.tan(rad(state.fov) / 2));
    const fy = state.height / (2 * Math.tan(rad(state.verticalFov) / 2));
    const x = state.width / 2 + fx * xRot / p.z;
    const y = state.height / 2 - fy * yRot / p.z;
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }

  function project(az, alt, allowOffscreen = false) {
    if (
      !Number.isFinite(az) ||
      !Number.isFinite(alt) ||
      alt <= 0
    ) {
      return null;
    }

    const point = projectDirectionToScreen(az, alt);
    if (!point) return null;

    if (
      !allowOffscreen && (
        point.x < 0 ||
        point.x >= state.width ||
        point.y < 0 ||
        point.y >= state.height
      )
    ) {
      return null;
    }

    return point;
  }

  /* ==========================================================
     FOND ÉTOILÉ
     ========================================================== */

  let backgroundStars = [];
let landscapeProfile = [];           // premier plan : sol, villages et bosquets
let landscapeNearProfile = [];       // collines proches derrière les villages
let landscapeMidProfile = [];        // relief intermédiaire
let landscapeDistantProfile = [];    // collines lointaines
let landscapeFarProfile = [];        // crêtes montagneuses les plus éloignées
let labelBoxes = [];
  function initializeLandscape() {
    // Paysage vectoriel plus organique : le sol proche conserve le profil
    // local utilisé pour ancrer les villages, tandis que quatre chaînes de
    // reliefs présentent des silhouettes nettement différentes. Les crêtes
    // sont irrégulières, avec des vallées larges, des sommets secondaires et
    // des échelles spatiales différentes selon la distance.
    const points = 360;
    const foregroundRidges = [
      [28, 0.020, 15], [67, 0.034, 11], [112, 0.016, 18],
      [158, 0.028, 14], [207, 0.018, 20], [249, 0.038, 12],
      [296, 0.022, 17], [337, 0.030, 13]
    ];

    const wrappedDistance = (az, center) => {
      const delta = Math.abs(az - center);
      return Math.min(delta, 360 - delta);
    };

    landscapeProfile = Array.from({ length: points + 1 }, (_, i) => {
      const az = i;
      let relief =
        0.006 * Math.sin(rad(az * 2.0 + 18)) +
        0.008 * Math.sin(rad(az * 3.0 - 47)) +
        0.004 * Math.sin(rad(az * 7.0 + 12));
      for (const [center, height, width] of foregroundRidges) {
        const delta = wrappedDistance(az, center);
        relief += height * Math.exp(-0.5 * (delta / width) ** 2);
      }
      return clamp(relief - 0.004, -0.012, 0.055);
    });

    // Construit une chaîne de montagnes à partir d'ondulations cycliques
    // et de sommets asymétriques. Les fréquences restent entières pour que
    // le panorama raccorde parfaitement à 0°/360°.
    const makeRidge = (base, waves, peaks, valleys, min, max) =>
      Array.from({ length: points + 1 }, (_, i) => {
        const az = i;
        let relief = base;
        for (const [frequency, amplitude, phase] of waves) {
          relief += amplitude * Math.sin(rad(az * frequency + phase));
        }
        const signedDistance = center => ((az - center + 540) % 360) - 180;
        const addLandform = ([center, height, width, jaggedness = 0.12, skew = 0.22]) => {
          const delta = signedDistance(center);
          // Les deux versants n'ont pas la même pente : cela évite les
          // répétitions en dômes symétriques et suggère des crêtes naturelles.
          const sideWidth = width * (delta < 0 ? 1 + skew : 1 - skew);
          const ratio = Math.abs(delta) / Math.max(1, sideWidth);
          const envelope = Math.exp(-0.5 * Math.pow(ratio, 1.55));
          // Petites irrégularités de crête : elles restent douces, mais les
          // sommets ne forment plus une suite de vagues régulières.
          const detail = 0.62 * Math.sin(rad(delta * 7 + center * 1.31)) +
                         0.38 * Math.sin(rad(delta * 13 - center * 0.73));
          relief += height * 0.72 * envelope * (1 + jaggedness * detail);
        };
        for (const landform of peaks) addLandform(landform);
        for (const landform of valleys) addLandform(landform);
        return clamp(relief, min, max);
      });

    // Collines proches : relief brisé, crêtes courtes et vallons visibles.
    landscapeNearProfile = makeRidge(0.025,
      [[1, 0.009, 17], [2, 0.008, -34], [4, 0.005, 12], [8, 0.0028, 42],
       [17, 0.0012, -21], [29, 0.0010, 58], [43, 0.0005, -13]],
      [[28, 0.023, 9, 0.20, 0.31], [72, 0.014, 13, 0.15, -0.18], [114, 0.030, 8, 0.22, 0.27],
       [157, 0.018, 11, 0.16, -0.25], [211, 0.026, 10, 0.20, 0.24], [259, 0.033, 8, 0.23, -0.28],
       [308, 0.019, 13, 0.16, 0.18], [348, 0.027, 9, 0.22, -0.24]],
      [[48, -0.008, 8, 0.06, 0.1], [91, -0.006, 9, 0.05, -0.1], [187, -0.007, 8, 0.06, 0.1], [285, -0.007, 10, 0.05, -0.1]],
      0.002, 0.080);

    // Relief intermédiaire : vallées larges séparant de vraies masses de collines.
    landscapeMidProfile = makeRidge(0.052,
      [[1, 0.012, -12], [2, 0.011, 33], [4, 0.006, -47], [7, 0.0035, 21],
       [15, 0.0020, 70], [27, 0.0015, -8], [41, 0.0008, 37]],
      [[18, 0.038, 10, 0.22, 0.28], [65, 0.021, 15, 0.14, -0.2], [129, 0.034, 12, 0.19, 0.25],
       [185, 0.046, 9, 0.24, -0.30], [243, 0.027, 13, 0.15, 0.18], [301, 0.042, 11, 0.22, -0.25],
       [345, 0.024, 14, 0.15, 0.20]],
      [[40, -0.013, 8, 0.08, -0.1], [97, -0.009, 10, 0.07, 0.2], [157, -0.011, 8, 0.08, -0.2],
       [218, -0.013, 9, 0.08, 0.1], [281, -0.009, 8, 0.07, -0.2], [331, -0.011, 8, 0.08, 0.2]],
      0.017, 0.135);

    // Chaîne lointaine : silhouette plus large, mais composée de sommets
    // décalés et de cols, pour qu'elle ne forme pas un simple ruban uniforme.
    landscapeDistantProfile = makeRidge(0.082,
      [[1, 0.016, 40], [2, 0.012, -18], [4, 0.007, 63], [9, 0.004, -29],
       [18, 0.0020, 15], [31, 0.0015, 53], [47, 0.0008, -33]],
      [[7, 0.046, 15, 0.15, 0.24], [59, 0.028, 13, 0.12, -0.20], [142, 0.039, 18, 0.16, 0.29],
       [207, 0.033, 14, 0.12, -0.18], [270, 0.049, 16, 0.17, 0.22], [331, 0.036, 15, 0.14, -0.25]],
      [[31, -0.018, 10, 0.10, 0.20], [93, -0.013, 11, 0.08, -0.2], [177, -0.015, 10, 0.09, 0.2],
       [239, -0.016, 11, 0.09, -0.2], [306, -0.013, 9, 0.08, 0.2]],
      0.040, 0.180);

    // Crêtes montagneuses : sommets plus hauts et anguleux, pentes longues,
    // avec une palette de perspective atmosphérique qui les sépare des plans devant.
    landscapeFarProfile = makeRidge(0.105,
      [[1, 0.022, -21], [2, 0.013, 16], [4, 0.007, -40], [8, 0.004, 62],
       [17, 0.0024, 22], [29, 0.0016, -41], [43, 0.0008, 27]],
      [[3, 0.057, 11, 0.24, 0.31], [58, 0.066, 13, 0.22, -0.26], [120, 0.073, 15, 0.25, 0.24],
       [188, 0.052, 17, 0.17, -0.31], [249, 0.074, 12, 0.26, 0.28], [315, 0.060, 14, 0.21, -0.24]],
      [[31, -0.023, 10, 0.12, -0.2], [90, -0.020, 12, 0.11, 0.2], [157, -0.022, 11, 0.12, -0.1],
       [224, -0.019, 10, 0.10, 0.2], [285, -0.021, 11, 0.11, -0.2], [345, -0.018, 12, 0.10, 0.2]],
      0.045, 0.225);
  }

  function initializeBackground() {
  // Aucune étoile décorative fixe :
  // les étoiles visibles proviennent du catalogue réel.
  backgroundStars = [];
}

let skySunCacheKey = "";
let skySunCache = null;
let skyMoonCache = null;

function drawBackground() {
  const w = state.width;
  const h = state.height;
  const nominalHorizon = horizonY();
  const date = state.observationDate || new Date();

  // L'horizon doit rester à la même hauteur colorimétrique dans le dégradé,
  // même lorsque l'utilisateur incline la carte. On projette l'horizon
  // astronomique réel, puis on oriente le dégradé perpendiculairement à cette
  // ligne (prise en compte du roulis). À pitch=0 et roll=0, le rendu reste
  // exactement celui de la v406.
  const horizonPoint = projectDirectionToScreen(state.heading, 0) || {
    x: w / 2,
    y: nominalHorizon
  };
  const fx = w / (2 * Math.tan(rad(state.fov) / 2));
  const fy = h / (2 * Math.tan(rad(state.verticalFov) / 2));
  const horizonSlope = -(fy / fx) * Math.tan(rad(state.roll));
  const normalLength = Math.hypot(horizonSlope, 1);
  const normalX = -horizonSlope / normalLength;
  const normalY = 1 / normalLength;
  const skyGradientStartX = horizonPoint.x - normalX * nominalHorizon;
  const skyGradientStartY = horizonPoint.y - normalY * nominalHorizon;
  const skyGradientEndX = skyGradientStartX + normalX * h;
  const skyGradientEndY = skyGradientStartY + normalY * h;

  // Calcul solaire mis en cache par minute : le fond évolue avec l'heure
  // sans recalculer l'éphéméride à chaque image de la carte.
  const sunKey = `${Math.floor(date.getTime() / 60000)}|${state.latitude}|${state.longitude}`;
  if (sunKey !== skySunCacheKey) {
    const solarObjects = solarObjectsAt(date);
    const sun = solarObjects.find(object => object.type === "sun");
    const moon = solarObjects.find(object => object.type === "moon");
    skySunCache = sun && Number.isFinite(sun.alt) && Number.isFinite(sun.az)
      ? { alt: sun.alt, az: sun.az }
      : null;

    let phaseAngle = null;
    try {
      const phase = window.Astronomy?.MoonPhase?.(date);
      if (Number.isFinite(phase)) phaseAngle = ((phase % 360) + 360) % 360;
    } catch (_) {
      phaseAngle = null;
    }
    skyMoonCache = moon && Number.isFinite(moon.alt) && Number.isFinite(moon.az)
      ? {
          alt: moon.alt,
          az: moon.az,
          phaseAngle,
          illumination: phaseAngle === null ? 0 : (1 - Math.cos(rad(phaseAngle))) / 2
        }
      : null;
    skySunCacheKey = sunKey;
  }

  const sunAlt = skySunCache ? skySunCache.alt : -30;
  const sunAz = skySunCache ? skySunCache.az : 0;
  const mix = (a, b, t) => {
    const aa = a.match(/[0-9a-f]{2}/gi).map(v => parseInt(v, 16));
    const bb = b.match(/[0-9a-f]{2}/gi).map(v => parseInt(v, 16));
    return `#${aa.map((v, i) => Math.round(v + (bb[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
  };
  const smooth = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };

  // Nuit bleue profonde -> crépuscule chaud -> bleu diurne. La transition
  // suit l'altitude réelle du Soleil et reste progressive aux changements d'heure.
  const night = ["#02040a", "#050914", "#0a1120", "#111827"];
  // Le fond général reste bleu-gris au crépuscule : les teintes chaudes sont
  // réservées à une lueur localisée autour de la position réelle du Soleil.
  const twilight = ["#162744", "#263a59", "#46536e", "#78869a"];
  const day = ["#78b9e8", "#91c9f0", "#b5def6", "#d8effb"];
  // Les teintes de crépuscule restent visibles sous l'horizon sans éclaircir la nuit.
  const duskAmount = smooth(-18, -5.5, sunAlt) * (1 - smooth(3, 12, sunAlt));
  const dayAmount = smooth(-1, 14, sunAlt);
  const palette = night.map((color, i) => {
    const warm = mix(color, twilight[i], duskAmount);
    return mix(warm, day[i], dayAmount);
  });

  // La Lune éclaircit le fond nocturne selon sa phase ET son altitude réelle.
  // Une Lune sous l'horizon n'éclaircit pas la carte ; l'effet s'efface aussi
  // progressivement à l'approche de l'aube, pour préserver les couleurs diurnes.
  const lunarDarkness = 1 - smooth(-18, -8, sunAlt);
  const lunarAltitude = skyMoonCache ? smooth(-4, 24, skyMoonCache.alt) : 0;
  const lunarIllumination = skyMoonCache?.illumination || 0;
  const moonlightAmount = clamp(
    0.32 * lunarIllumination * lunarAltitude * lunarDarkness,
    0,
    0.32
  );
  const moonlitPalette = ["#15223a", "#1c2c46", "#263750", "#31415a"];
  if (moonlightAmount > 0.001) {
    for (let i = 0; i < palette.length; i++) {
      palette[i] = mix(palette[i], moonlitPalette[i], moonlightAmount);
    }
  }

  const sky = ctx.createLinearGradient(
    skyGradientStartX,
    skyGradientStartY,
    skyGradientEndX,
    skyGradientEndY
  );
  sky.addColorStop(0, palette[0]);
  sky.addColorStop(0.45, palette[1]);
  sky.addColorStop(0.75, palette[2]);
  sky.addColorStop(1, palette[3]);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // Lueur orientée vers le Soleil dans le champ de vision. Au lever/coucher,
  // elle reste près de l'horizon; en journée, elle monte avec l'astre.
  if (skySunCache && sunAlt > -18) {
    const projectedSun = projectDirectionToScreen(sunAz, sunAlt);
    const relativeAz = norm180(sunAz - state.heading);
    const halfFov = Math.max(1, state.fov * 0.5);
    const sunX = projectedSun?.x ?? (w * 0.5 + clamp(relativeAz / halfFov, -1.5, 1.5) * w * 0.5);
    const sunY = projectedSun?.y ?? nominalHorizon;
    const warm = sunAlt < 8;
    // À l'aube et au coucher, limiter nettement la diffusion aux environs du Soleil.
    // En journée, conserver une lueur plus large et très discrète.
    const radius = warm ? Math.max(w * 0.32, h * 0.20) : Math.max(w * 0.36, h * 0.46);
    // Au lever/coucher, élargir la diffusion surtout en azimut (horizontalement)
    // sans augmenter dans les mêmes proportions la hauteur des couleurs.
    ctx.save();
    if (warm) {
      ctx.translate(sunX, sunY);
      ctx.scale(1.65, 1);
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
      glow.addColorStop(0, `rgba(255,165,82,${0.30 + duskAmount * 0.34})`);
      glow.addColorStop(0.42, "rgba(255,105,55,0.19)");
      glow.addColorStop(0.76, "rgba(244,132,75,0.07)");
      glow.addColorStop(1, "rgba(255,190,120,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(-w, -h, w * 2, h * 2);
    } else {
      const glow = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, radius);
      glow.addColorStop(0, "rgba(255,239,199,0.18)");
      glow.addColorStop(0.32, "rgba(255,235,190,0.08)");
      glow.addColorStop(1, "rgba(255,210,150,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();
  }

  // Halo atmosphérique discret, conservé même lorsque le Soleil est sous l'horizon.
  const glow = ctx.createRadialGradient(
    horizonPoint.x, horizonPoint.y, 0,
    horizonPoint.x, horizonPoint.y,
    Math.max(w * 0.65, h * 0.5)
  );
  glow.addColorStop(0, sunAlt > 0 ? "rgba(160,205,235,0.08)" : "rgba(105,130,166,0.055)");
  glow.addColorStop(0.4, "rgba(63,84,119,0.025)");
  glow.addColorStop(1, "rgba(10,15,28,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  // Assombrissement progressif des bords, moins marqué en plein jour.
  const vignette = ctx.createRadialGradient(
    w * 0.5, h * 0.42, Math.min(w, h) * 0.12,
    w * 0.5, h * 0.42, Math.max(w, h) * 0.78
  );
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, `rgba(0,0,0,${0.24 * (1 - dayAmount * 0.72)})`);
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);
}


// Sprites pré-rendus : évite les save/restore, arcs et halos répétés
// pour chaque étoile à chaque image. La magnitude est quantifiée pour
// limiter le nombre de sprites tout en conservant les différences visuelles.
const starSpriteCache = new Map();
const STAR_SPRITE_SCALE = 2;

function getStarSprite(mag, bpRp = null) {
  const magnitude = Number.isFinite(mag) ? mag : 5;
  const bucket = Math.round(magnitude * 4) / 4;
  // BP-RP varie continûment : on quantifie seulement par pas de 0,25
  // pour garder un cache compact sans imposer de grandes classes de couleur.
  const colorBin = Number.isFinite(bpRp)
    ? Math.round(clamp(bpRp, -0.5, 3.0) * 4) / 4
    : null;
  const colorKey = colorBin === null ? "default" : `bp${colorBin.toFixed(2)}`;
  const cacheKey = `${bucket}|${colorKey}`;
  const cached = starSpriteCache.get(cacheKey);
  if (cached) return cached;

  // Le diamètre et l'intensité diminuent avec la magnitude. Les halos
  // sont dessinés par dégradé radial (plutôt que shadowBlur) pour obtenir
  // une lueur douce et reproductible sur les navigateurs mobiles.
  // Les étoiles sont légèrement agrandies et éclaircies, surtout dans les
  // magnitudes intermédiaires, sans supprimer la hiérarchie d'éclat.
  const radius = clamp(
    0.62 + 2.15 * Math.pow(10, -0.12 * bucket),
    0.62,
    3.1
  );
  const alpha = clamp(
    0.98 * Math.pow(10, -0.115 * (bucket - 1)),
    0.22,
    1
  );
  // Halo visible sur les étoiles les plus brillantes, sans toucher au Soleil
  // ni au rendu dynamique : seuil élargi et rayon légèrement augmenté.
  const bright = bucket <= 2.0;
  const halo = bright ? (bucket <= 0 ? 10 : bucket <= 1.0 ? 8 : 6) : 0;
  const padding = Math.ceil(radius + halo + 1.5);
  const logicalSize = padding * 2;
  const spriteCanvas = document.createElement("canvas");
  spriteCanvas.width = logicalSize * STAR_SPRITE_SCALE;
  spriteCanvas.height = logicalSize * STAR_SPRITE_SCALE;
  const spriteCtx = spriteCanvas.getContext("2d");

  if (!spriteCtx) return null;
  spriteCtx.scale(STAR_SPRITE_SCALE, STAR_SPRITE_SCALE);

  const palette = (() => {
    if (colorBin === null) {
      return ["210,226,255", "155,190,255", "125,165,255"];
    }
    // Palette approximative fondée sur l'indice photométrique BP-RP.
    // Les points intermédiaires sont interpolés pour éviter les ruptures
    // visuelles entre étoiles de couleurs proches.
    const anchors = [
      [-0.5, [115, 165, 255]],
      [0.0, [160, 195, 255]],
      [0.5, [225, 233, 255]],
      [0.8, [255, 245, 218]],
      [1.2, [255, 211, 155]],
      [1.8, [255, 165, 135]],
      [3.0, [255, 125, 115]]
    ];
    let lower = anchors[0], upper = anchors[anchors.length - 1];
    for (let i = 0; i < anchors.length - 1; i++) {
      if (colorBin >= anchors[i][0] && colorBin <= anchors[i + 1][0]) {
        lower = anchors[i]; upper = anchors[i + 1]; break;
      }
    }
    const t = upper[0] === lower[0] ? 0 : (colorBin - lower[0]) / (upper[0] - lower[0]);
    const rgb = lower[1].map((channel, i) => Math.round(channel + (upper[1][i] - channel) * t));
    const core = rgb.join(",");
    const mid = rgb.map(c => Math.round(c * 0.88 + 255 * 0.12)).join(",");
    const edge = rgb.map(c => Math.round(c * 0.72 + 255 * 0.28)).join(",");
    return [core, mid, edge];
  })();
  if (bright) {
    const glowRadius = Math.max(radius + 0.5, halo);
    const glow = spriteCtx.createRadialGradient(
      padding, padding, radius * 0.15,
      padding, padding, glowRadius
    );
    glow.addColorStop(0, `rgba(${palette[0]},${Math.min(0.58, alpha * 0.58)})`);
    glow.addColorStop(0.38, `rgba(${palette[1]},${Math.min(0.32, alpha * 0.32)})`);
    glow.addColorStop(1, `rgba(${palette[2]},0)`);
    spriteCtx.fillStyle = glow;
    spriteCtx.fillRect(0, 0, logicalSize, logicalSize);
  }

  // Petit cœur lumineux et bord légèrement bleuté : l'étoile reste
  // ponctuelle, sans effet de croix artificiel.
  const core = spriteCtx.createRadialGradient(
    padding - radius * 0.12, padding - radius * 0.12, 0,
    padding, padding, radius
  );
  core.addColorStop(0, `rgba(255,255,255,${Math.min(1, alpha * 1.12)})`);
  core.addColorStop(0.55, `rgba(${colorKey === "default" ? "239,244,255" : palette[0]},${alpha})`);
  core.addColorStop(1, `rgba(${colorKey === "default" ? "195,215,255" : palette[2]},${alpha * 0.78})`);
  spriteCtx.fillStyle = core;
  spriteCtx.beginPath();
  spriteCtx.arc(padding, padding, radius, 0, TAU);
  spriteCtx.fill();

  if (bucket <= 0.5) {
    spriteCtx.fillStyle = "rgba(255,255,255,0.98)";
    spriteCtx.beginPath();
    spriteCtx.arc(padding, padding, Math.max(0.35, radius * 0.28), 0, TAU);
    spriteCtx.fill();
  }

  const sprite = { canvas: spriteCanvas, size: logicalSize, padding };
  starSpriteCache.set(cacheKey, sprite);
  return sprite;
}

function drawStar(point, mag, bpRp = null) {
  const sprite = getStarSprite(mag, bpRp);
  if (!sprite) return;

  // Scintillement discret mais perceptible sur les étoiles les plus brillantes.
  // Il modifie uniquement l'opacité du sprite, sans déplacer les étoiles.
  const magnitude = Number.isFinite(mag) ? mag : 5;
  let twinkle = 1;
  if (magnitude <= 3.5) {
    const phase = point.x * 12.9898 + point.y * 78.233;
    const slowTime = Date.now() / 850;
    twinkle = 0.88 + 0.12 * (0.5 + 0.5 * Math.sin(slowTime + phase));
  }

  const previousAlpha = ctx.globalAlpha;
  ctx.globalAlpha = previousAlpha * twinkle;
  ctx.drawImage(
    sprite.canvas,
    point.x - sprite.padding,
    point.y - sprite.padding,
    sprite.size,
    sprite.size
  );
  ctx.globalAlpha = previousAlpha;
}


// Champ vertical du zoom ×1 (voir state.verticalFov initial et le bouton de réinitialisation du zoom).
const REFERENCE_VERTICAL_FOV = 83.3333333333;

function drawHorizon() {
  const w = state.width;
  const h = state.height;

  if (!landscapeProfile.length || !w || !h) return;

  const count = landscapeProfile.length - 1;
  const heading = norm360(state.heading);
  const fx = w / (2 * Math.tan(rad(state.fov) / 2));
  const fy = h / (2 * Math.tan(rad(state.verticalFov) / 2));

  // Profil cyclique interpolé sur 360°. Le profil est fourni en paramètre
  // pour que les reliefs lointains utilisent exactement la même projection.
  function landscapeAt(azimuth, profile = landscapeProfile) {
    const angle = norm360(azimuth);
    const profileCount = profile.length - 1;
    const position = (angle / 360) * profileCount;
    const index = Math.floor(position);
    const fraction = position - index;
    const next = (index + 1) % profileCount;
    return profile[index] * (1 - fraction) + profile[next] * fraction;
  }

  // Convertit la hauteur d'un profil (fraction de l'écran) en altitude
  // angulaire, puis applique la caméra et le roulis utilisés pour les étoiles.
  function projectTerrainProfile(azimuth, profile) {
    const rawRelief = landscapeAt(azimuth, profile);
    // Abaisser les silhouettes sans les aplatir : le premier plan local reste
    // discret, les collines proches culminent vers 4–5°, le plan intermédiaire
    // vers 7° et le plan lointain vers 10° environ au-dessus de l'horizon.
    const profileScale = profile === landscapeProfile ? 0.62
      : profile === landscapeNearProfile ? 0.55
      : profile === landscapeMidProfile ? 0.52
      : profile === landscapeDistantProfile ? 0.53
      : 1;
    const relief = rawRelief * profileScale;
    // Altitude angulaire du relief : elle doit rester indépendante du zoom, comme celle des
    // astres. On convertit donc la fraction d'écran en angle avec le champ vertical de
    // RÉFÉRENCE (celui du zoom ×1), et non avec le champ courant `fy` : sinon les collines
    // « montent » en dézoomant (elles masquent des astres levés) et « descendent » en zoomant.
    const altitude = deg(Math.atan(relief * 2 * Math.tan(rad(REFERENCE_VERTICAL_FOV) / 2)));
    const p = cameraCoordinates(azimuth, altitude);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z) || p.z <= 0.0001) return null;

    const roll = rad(state.roll);
    const xRot = p.x * Math.cos(roll) - p.y * Math.sin(roll);
    const yRot = p.x * Math.sin(roll) + p.y * Math.cos(roll);
    const x = w / 2 + fx * xRot / p.z;
    const y = h / 2 - fy * yRot / p.z;
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }
  const projectTerrain = azimuth => projectTerrainProfile(azimuth, landscapeProfile);

  // L'éclairage du paysage suit l'altitude solaire. Le contour du terrain
  // demeure continu, mais le sol et les silhouettes passent progressivement
  // de la nuit au crépuscule puis au jour.
  const sunAltitude = Number.isFinite(skySunCache?.alt) ? skySunCache.alt : -18;
  const smoothLighting = (a, b, value) => {
    const t = clamp((value - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const mixColor = (a, b, amount) => {
    const parse = color => color.match(/[0-9a-f]{2}/gi).map(part => parseInt(part, 16));
    const ca = parse(a), cb = parse(b), t = clamp(amount, 0, 1);
    return `#${ca.map((value, index) => Math.round(value + (cb[index] - value) * t).toString(16).padStart(2, "0")).join("")}`;
  };
  const daylight = smoothLighting(-7, 9, sunAltitude);
  const twilight = smoothLighting(-18, -4, sunAltitude) * (1 - smoothLighting(0, 10, sunAltitude));
  // Après le coucher, la lumière résiduelle perd progressivement sa saturation
  // et le terrain s'assombrit. L'effet est limité au crépuscule : le ciel et sa
  // palette d'aube restent inchangés, et la nuit profonde garde ses tons propres.
  const landscapeColor = (nightColor, twilightColor, dayColor) => {
    const base = mixColor(mixColor(nightColor, twilightColor, twilight), dayColor, daylight);
    if (twilight <= 0.001) return base;
    const channels = base.match(/[0-9a-f]{2}/gi).map(part => parseInt(part, 16));
    const grayLevel = Math.round(channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722);
    const gray = `#${[grayLevel, grayLevel, grayLevel].map(value => value.toString(16).padStart(2, "0")).join("")}`;
    const desaturated = mixColor(base, gray, 0.58 * twilight);
    return mixColor(desaturated, "#07090d", 0.25 * twilight);
  };
  const treeColor = landscapeColor("#050b12", "#271923", "#293a30");
  const houseColor = landscapeColor("#070d17", "#3d2632", "#42483e");
  const churchInsetColor = landscapeColor("#232f42", "#524044", "#697066");
  const windowAlpha = 0.34 * (1 - daylight) + 0.025 * daylight;

  // Éclairage directionnel des éléments proches : la lumière suit l'azimut et
  // l'altitude du Soleil. Elle reste discrète la nuit, se réchauffe au lever et
  // au coucher, et devient plus neutre en journée.
  const surfaceLighting = smoothLighting(-8, 5, sunAltitude);
  const lowSun = 1 - smoothLighting(1, 16, sunAltitude);
  const relativeSunAzimuth = norm180((skySunCache?.az ?? heading) - heading);
  const sunSideSin = Math.sin(rad(relativeSunAzimuth));
  const sunScreenSide = Math.abs(sunSideSin) > 0.12
    ? Math.sign(sunSideSin)
    : (Math.cos(rad(relativeSunAzimuth)) >= 0 ? 1 : -1);
  const lightFromRight = sunScreenSide > 0;
  const treeSunlitColor = mixColor(
    treeColor,
    landscapeColor("#101827", "#594039", "#71875b"),
    0.035 + 0.16 * surfaceLighting + 0.018 * twilight
  );
  const treeShadeColor = mixColor(
    treeColor,
    landscapeColor("#01040a", "#140e16", "#1c261f"),
    0.22 + 0.08 * surfaceLighting
  );
  const treeEdgeColor = landscapeColor("#111a29", "#a66b80", "#b7c39a");
  const houseSunlitColor = mixColor(
    houseColor,
    landscapeColor("#111a29", "#87506b", "#899878"),
    0.035 + 0.17 * surfaceLighting
  );
  const houseShadeColor = mixColor(
    houseColor,
    landscapeColor("#02050d", "#1b141b", "#262e27"),
    0.20 + 0.07 * surfaceLighting
  );
  const roofSunlitColor = mixColor(
    houseColor,
    landscapeColor("#172235", "#9b5d70", "#a9b38b"),
    0.045 + 0.14 * surfaceLighting
  );
  const roofShadeColor = mixColor(
    houseColor,
    landscapeColor("#02050b", "#241820", "#2a332a"),
    0.24
  );
  const buildingEdgeColor = landscapeColor("#172235", "#c17c91", "#d4d7ad");
  const shadowVisibility = smoothLighting(-3, 1.2, sunAltitude);
  const shadowAlpha = 0.105 * shadowVisibility * (0.72 + 0.28 * surfaceLighting);
  const shadowLengthBase = 2.5 + 13.5 * lowSun;
  // La lueur au sol ne doit presque pas être perceptible lorsque le Soleil
  // est encore nettement sous l'horizon : priorité aux silhouettes sombres.
  const horizonGlowAmount = smoothLighting(-9, -1.5, sunAltitude) *
    (1 - smoothLighting(6, 14, sunAltitude));

  // Dégradé gauche/droite des façades et des feuillages. Le côté éclairé
  // change avec l'azimut solaire, sans déplacer les silhouettes du paysage.
  const directionalGradient = (x, y, width, baseColor, litColor, shadeColor) => {
    const halfWidth = Math.max(1, width / 2);
    const gradient = ctx.createLinearGradient(x - halfWidth, y, x + halfWidth, y);
    if (lightFromRight) {
      gradient.addColorStop(0, shadeColor);
      gradient.addColorStop(0.46, baseColor);
      gradient.addColorStop(1, litColor);
    } else {
      gradient.addColorStop(0, litColor);
      gradient.addColorStop(0.54, baseColor);
      gradient.addColorStop(1, shadeColor);
    }
    return gradient;
  };

  // Dégradé du sol perpendiculaire à la ligne d'horizon projetée : sa
  // direction reste cohérente lorsque la carte est inclinée ou roulée.
  const horizonForGround = projectDirectionToScreen(state.heading, 0) || {
    x: w / 2,
    y: horizonY()
  };
  const fxForGround = w / (2 * Math.tan(rad(state.fov) / 2));
  const fyForGround = h / (2 * Math.tan(rad(state.verticalFov) / 2));
  const groundSlope = -(fyForGround / fxForGround) * Math.tan(rad(state.roll));
  const groundNormalLength = Math.hypot(groundSlope, 1);
  const groundNormalX = -groundSlope / groundNormalLength;
  const groundNormalY = 1 / groundNormalLength;

  // Échantillonne une plage plus large que le champ visible : les points hors
  // champ sont ensuite naturellement rognés par le canvas. Une petite marge
  // évite les bords artificiels quand le relief ou le roulis déplace la ligne.
  const halfSpan = Math.min(89, state.fov * 0.5 + Math.abs(state.pitch) + 12);
  const segments = Math.max(240, Math.ceil(w / 2));
  const terrain = [];
  for (let i = 0; i <= segments; i++) {
    const relativeAzimuth = -halfSpan + (2 * halfSpan * i / segments);
    const point = projectTerrain(heading + relativeAzimuth);
    terrain.push(point);
  }

  ctx.save();

  // Plans de profondeur : les collines intermédiaires sont dessinées en premier,
  // puis les collines proches. Le plan montagneux le plus lointain est retiré
  // pour dégager les objets célestes bas sur l’horizon. Le sol proche les recouvre ensuite
  // naturellement dans les zones où sa silhouette est plus haute.
  // Chaque plan est échantillonné sur les mêmes azimuts et projeté avec la
  // même caméra : aucune bande n'est fixée aux pixels de l'écran.
  const drawLandscapeLayer = (profile, fillColor, strokeColor, strokeWidth = 1) => {
    // Les reliefs éloignés sont plus doux que le contour de terrain : un
    // échantillonnage à 4 px suffit et limite le coût sur les téléphones.
    const layerSegments = Math.max(180, Math.ceil(w / 4));
    const sample = [];
    for (let i = 0; i <= layerSegments; i++) {
      const relativeAzimuth = -halfSpan + (2 * halfSpan * i / layerSegments);
      sample.push(projectTerrainProfile(heading + relativeAzimuth, profile));
    }

    const paintRun = run => {
      if (run.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(run[0].x, run[0].y);
      for (let i = 1; i < run.length; i++) ctx.lineTo(run[i].x, run[i].y);
      ctx.lineTo(run[run.length - 1].x, h + 2);
      ctx.lineTo(run[0].x, h + 2);
      ctx.closePath();

      // Chaque versant reçoit un dégradé léger : crête un peu plus éclairée,
      // base plus sombre. Cela évite l'aspect de bandes uniformes tout en
      // restant une silhouette 2D très peu coûteuse à dessiner.
      const ridgeTopY = Math.min(...run.map(point => point.y));
      const highlightColor = daylight > 0.48
        ? mixColor(fillColor, "#f4f2dc", 0.15)
        : twilight > 0.32
          ? mixColor(fillColor, "#b98783", 0.035)
          : mixColor(fillColor, "#8296b7", 0.022);
      const shadowColor = mixColor(fillColor, "#030711", daylight > 0.48 ? 0.22 : 0.16);
      const slopeGradient = ctx.createLinearGradient(0, ridgeTopY, 0, h + 2);
      slopeGradient.addColorStop(0, highlightColor);
      slopeGradient.addColorStop(0.34, fillColor);
      slopeGradient.addColorStop(1, shadowColor);
      ctx.fillStyle = slopeGradient;
      ctx.fill();

      // Filet supérieur très discret : il sépare les plans sans ajouter de
      // détails susceptibles de distraire de la carte du ciel.
      ctx.beginPath();
      ctx.moveTo(run[0].x, run[0].y);
      for (let i = 1; i < run.length; i++) ctx.lineTo(run[i].x, run[i].y);
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = strokeWidth;
      ctx.stroke();
    };

    let run = [];
    for (const point of sample) {
      if (point) run.push(point);
      else {
        paintRun(run);
        run = [];
      }
    }
    paintRun(run);
  };

  // Perspective atmosphérique : le relief le plus lointain est plus clair,
  // bleuté et peu contrasté la nuit ; en journée, il se rapproche d'un gris-vert
  // lumineux. Chaque plan suivant devient plus sombre et plus contrasté.
  const distantRidgeColor = landscapeColor("#182337", "#805a76", "#a8b9b2");
  const midRidgeColor = landscapeColor("#101a2a", "#5c3d50", "#788d7b");
  const nearRidgeColor = landscapeColor("#080f1b", "#3b2635", "#4b624b");
  const distantEdgeColor = daylight > 0.48
    ? "rgba(207, 222, 207, 0.32)"
    : twilight > 0.32
      ? "rgba(202, 121, 153, 0.14)"
      : "rgba(112, 139, 180, 0.085)";
  const midEdgeColor = daylight > 0.48
    ? "rgba(171, 193, 160, 0.30)"
    : twilight > 0.32
      ? "rgba(184, 101, 137, 0.12)"
      : "rgba(91, 121, 162, 0.07)";
  const nearEdgeColor = daylight > 0.48
    ? "rgba(126, 153, 116, 0.27)"
    : twilight > 0.32
      ? "rgba(159, 82, 119, 0.095)"
      : "rgba(75, 102, 143, 0.055)";
  drawLandscapeLayer(landscapeDistantProfile, distantRidgeColor, distantEdgeColor, 0.95);
  drawLandscapeLayer(landscapeMidProfile, midRidgeColor, midEdgeColor, 1.0);
  drawLandscapeLayer(landscapeNearProfile, nearRidgeColor, nearEdgeColor, 1.05);

  // Remplissage du sol proche à partir du contour projeté par la caméra réelle.
  ctx.beginPath();
  let started = false;
  for (const point of terrain) {
    if (!point) {
      if (started) ctx.lineTo(w + 2, h + 2);
      started = false;
      continue;
    }
    if (!started) {
      ctx.moveTo(point.x, point.y);
      started = true;
    } else {
      ctx.lineTo(point.x, point.y);
    }
  }
  ctx.lineTo(w + 2, h + 2);
  ctx.lineTo(-2, h + 2);
  ctx.closePath();

  const ground = ctx.createLinearGradient(
    horizonForGround.x,
    horizonForGround.y,
    horizonForGround.x + groundNormalX * h,
    horizonForGround.y + groundNormalY * h
  );
  ground.addColorStop(0, landscapeColor("#080d16", "#432735", "#748174"));
  ground.addColorStop(0.25, landscapeColor("#050912", "#2b1a28", "#465448"));
  ground.addColorStop(1, landscapeColor("#020409", "#100b13", "#202b22"));
  ctx.fillStyle = ground;
  ctx.fill();

  // À l'aube et au crépuscule, une lueur faible se pose sur le terrain au
  // point où le Soleil rencontre le profil. Elle est découpée par la vraie
  // silhouette du sol : elle ne recouvre ni les étoiles ni les objets du ciel.
  if (horizonGlowAmount > 0.008 && skySunCache) {
    const sunOnTerrain = projectTerrain(skySunCache.az);
    if (sunOnTerrain && sunOnTerrain.x > -w * 0.25 && sunOnTerrain.x < w * 1.25) {
      ctx.save();
      ctx.beginPath();
      let clipRun = [];
      const addGroundClipRun = run => {
        if (run.length < 2) return;
        ctx.moveTo(run[0].x, run[0].y);
        for (let j = 1; j < run.length; j++) ctx.lineTo(run[j].x, run[j].y);
        ctx.lineTo(run[run.length - 1].x, h + 2);
        ctx.lineTo(run[0].x, h + 2);
        ctx.closePath();
      };
      for (const point of terrain) {
        if (point) clipRun.push(point);
        else {
          addGroundClipRun(clipRun);
          clipRun = [];
        }
      }
      addGroundClipRun(clipRun);
      ctx.clip();
      const glowRadius = Math.max(w * 0.28, h * 0.20);
      const horizonGlow = ctx.createRadialGradient(
        sunOnTerrain.x, sunOnTerrain.y, 0,
        sunOnTerrain.x, sunOnTerrain.y, glowRadius
      );
      const glowOpacity = 0.045 * horizonGlowAmount;
      const warmGlow = sunAltitude < 6;
      horizonGlow.addColorStop(0, warmGlow
        ? `rgba(255, 176, 119, ${glowOpacity.toFixed(3)})`
        : `rgba(235, 231, 191, ${glowOpacity.toFixed(3)})`);
      horizonGlow.addColorStop(0.34, warmGlow
        ? `rgba(236, 143, 105, ${(glowOpacity * 0.38).toFixed(3)})`
        : `rgba(207, 218, 181, ${(glowOpacity * 0.32).toFixed(3)})`);
      horizonGlow.addColorStop(1, "rgba(10, 15, 28, 0)");
      ctx.fillStyle = horizonGlow;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }

  // Contour supérieur : réutilise strictement les mêmes points projetés.
  ctx.beginPath();
  let contourStarted = false;
  for (const point of terrain) {
    if (!point) {
      contourStarted = false;
      continue;
    }
    if (!contourStarted) {
      ctx.moveTo(point.x, point.y);
      contourStarted = true;
    } else {
      ctx.lineTo(point.x, point.y);
    }
  }
  ctx.strokeStyle = daylight > 0.48
    ? "rgba(92, 108, 91, 0.46)"
    : twilight > 0.32
      ? "rgba(220, 163, 143, 0.42)"
      : "rgba(147, 171, 206, 0.28)";
  ctx.lineWidth = 1.1;
  ctx.stroke();

  // Silhouettes stylisées ancrées au relief, projetées par la même caméra.
  const skylinePoint = azimuth => {
    const point = projectTerrain(azimuth);
    if (!point || point.x < -70 || point.x > w + 70) return null;
    return point;
  };

  // Résout l'azimut qui tombe à une abscisse d'écran demandée. Les objets
  // d'un village sont ainsi ancrés chacun au relief juste sous leur base,
  // au lieu de déplacer en pixels des maisons partageant la même hauteur.
  const azimuthAtScreenX = (baseAzimuth, targetX) => {
    let delta = 0;
    for (let iteration = 0; iteration < 5; iteration++) {
      const candidate = norm360(baseAzimuth + delta);
      const point = projectTerrain(candidate);
      if (!point) break;
      const error = point.x - targetX;
      if (Math.abs(error) < 0.35) break;
      const epsilon = 0.035;
      const before = projectTerrain(norm360(candidate - epsilon));
      const after = projectTerrain(norm360(candidate + epsilon));
      if (!before || !after) break;
      const derivative = (after.x - before.x) / (2 * epsilon);
      if (!Number.isFinite(derivative) || Math.abs(derivative) < 0.05) break;
      delta = clamp(delta - error / derivative, -20, 20);
    }
    return norm360(baseAzimuth + delta);
  };

  const foregroundObjects = [];

  // Ombres de contact et portées au sol. Elles sont très courtes lorsque le
  // Soleil est haut, plus longues à l'aube et au coucher, et absentes la nuit.
  const drawGroundShadow = object => {
    if (shadowAlpha <= 0.002 || object.baseY < -5 || object.baseY > h + 8) return;
    const length = shadowLengthBase * object.scale * shadowVisibility;
    if (length < 0.7) return;
    const lateral = 0.22 + 0.58 * Math.abs(sunSideSin);
    const shiftX = -sunScreenSide * length * lateral;
    const baseHalf = Math.max(1.2, object.shadowWidth * 0.36);
    const tipHalf = Math.max(0.6, object.shadowWidth * 0.10);
    const endY = object.baseY + length * (0.30 + 0.14 * lowSun);
    ctx.save();
    ctx.fillStyle = `rgba(1, 4, 10, ${shadowAlpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(object.x - baseHalf, object.baseY - 0.2);
    ctx.lineTo(object.x + baseHalf, object.baseY - 0.2);
    ctx.lineTo(object.x + shiftX + tipHalf, endY);
    ctx.lineTo(object.x + shiftX - tipHalf, endY);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };

  const drawTree = (x, baseY, scale = 1, shape = 0) => {
    ctx.save();
    const evergreen = shape % 3 === 0;
    const canopyWidth = (evergreen ? 20 : 7 + shape % 3) * scale;
    const canopyHeight = (evergreen ? 25 : 24) * scale;
    ctx.fillStyle = directionalGradient(
      x, baseY - canopyHeight * 0.52, canopyWidth * 2,
      treeColor, treeSunlitColor, treeShadeColor
    );
    // Silhouettes de feuillus et de conifères, avec une face éclairée subtile.
    if (evergreen) {
      ctx.beginPath();
      ctx.moveTo(x, baseY - 25 * scale);
      ctx.lineTo(x - 7 * scale, baseY - 15 * scale);
      ctx.lineTo(x - 4 * scale, baseY - 15 * scale);
      ctx.lineTo(x - 10 * scale, baseY - 7 * scale);
      ctx.lineTo(x - 5 * scale, baseY - 7 * scale);
      ctx.lineTo(x - 8 * scale, baseY - 1 * scale);
      ctx.lineTo(x + 8 * scale, baseY - 1 * scale);
      ctx.lineTo(x + 4 * scale, baseY - 8 * scale);
      ctx.lineTo(x + 9 * scale, baseY - 8 * scale);
      ctx.lineTo(x + 4 * scale, baseY - 15 * scale);
      ctx.lineTo(x + 7 * scale, baseY - 15 * scale);
      ctx.closePath();
      ctx.fill();
      // Quelques arêtes du côté solaire, non un contour complet artificiel.
      if (surfaceLighting > 0.08) {
        ctx.beginPath();
        if (lightFromRight) {
          ctx.moveTo(x + 7 * scale, baseY - 15 * scale);
          ctx.lineTo(x + 4 * scale, baseY - 15 * scale);
          ctx.lineTo(x + 9 * scale, baseY - 8 * scale);
          ctx.lineTo(x + 4 * scale, baseY - 8 * scale);
        } else {
          ctx.moveTo(x - 7 * scale, baseY - 15 * scale);
          ctx.lineTo(x - 4 * scale, baseY - 15 * scale);
          ctx.lineTo(x - 10 * scale, baseY - 7 * scale);
          ctx.lineTo(x - 5 * scale, baseY - 7 * scale);
        }
        ctx.strokeStyle = treeEdgeColor;
        ctx.globalAlpha = 0.08 + 0.13 * surfaceLighting + 0.05 * twilight;
        ctx.lineWidth = Math.max(0.45, 0.7 * scale);
        ctx.stroke();
      }
    } else {
      const rx = canopyWidth;
      const ry = 12 * scale;
      const cy = baseY - 13 * scale;
      ctx.beginPath();
      ctx.ellipse(x, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      if (surfaceLighting > 0.08) {
        ctx.beginPath();
        if (lightFromRight) ctx.ellipse(x, cy, rx * 0.92, ry * 0.92, 0, -Math.PI / 2, Math.PI / 2);
        else ctx.ellipse(x, cy, rx * 0.92, ry * 0.92, 0, Math.PI / 2, Math.PI * 1.5);
        ctx.strokeStyle = treeEdgeColor;
        ctx.globalAlpha = 0.07 + 0.12 * surfaceLighting + 0.05 * twilight;
        ctx.lineWidth = Math.max(0.45, 0.65 * scale);
        ctx.stroke();
      }
    }
    const trunkBase = landscapeColor("#02050a", "#181318", "#3c4133");
    const trunkLit = landscapeColor("#111b29", "#6e4838", "#68754f");
    const trunkShade = landscapeColor("#010308", "#120e14", "#242a22");
    ctx.globalAlpha = 1;
    ctx.fillStyle = directionalGradient(x, baseY - 2.5 * scale, 2.8 * scale, trunkBase, trunkLit, trunkShade);
    ctx.fillRect(x - 1.4 * scale, baseY - 5 * scale, 2.8 * scale, 5 * scale);
    ctx.restore();
  };

  const drawHouse = (x, baseY, scale = 1, style = 0) => {
    ctx.save();
    const width = (style % 3 === 0 ? 17 : style % 3 === 1 ? 13 : 20) * scale;
    const height = (style % 2 === 0 ? 9 : 12) * scale;
    const left = x - width / 2;
    const roofBaseY = baseY - height;
    const roofLeftX = style % 3 === 1 ? left - 1 * scale : left - 2 * scale;
    const roofRightX = style % 3 === 1 ? x + width * 0.48 : left + width + 2 * scale;
    const roofPeakX = style % 3 === 1 ? x - width * 0.12 : x + (style % 2 ? 1.5 : -1) * scale;
    const roofPeakY = baseY - height - (style % 3 === 2 ? 7 : 5) * scale;

    // Façade avec une face sombre du côté opposé au Soleil.
    ctx.fillStyle = directionalGradient(x, roofBaseY, width, houseColor, houseSunlitColor, houseShadeColor);
    ctx.fillRect(left, roofBaseY, width, height + 2 * scale);
    const sideWidth = Math.max(1.2 * scale, width * 0.15);
    ctx.fillStyle = houseShadeColor;
    ctx.globalAlpha = 0.56;
    ctx.fillRect(lightFromRight ? left : left + width - sideWidth, roofBaseY + 0.4 * scale, sideWidth, height + 1.4 * scale);
    ctx.globalAlpha = 1;

    // Les deux pans du toit sont éclairés différemment selon l'azimut solaire.
    ctx.beginPath();
    ctx.moveTo(roofLeftX, roofBaseY + 1 * scale);
    ctx.lineTo(roofPeakX, roofPeakY);
    ctx.lineTo(roofPeakX, roofBaseY);
    ctx.closePath();
    ctx.fillStyle = lightFromRight ? roofShadeColor : roofSunlitColor;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(roofPeakX, roofPeakY);
    ctx.lineTo(roofRightX, roofBaseY + 1 * scale);
    ctx.lineTo(roofPeakX, roofBaseY);
    ctx.closePath();
    ctx.fillStyle = lightFromRight ? roofSunlitColor : roofShadeColor;
    ctx.fill();

    // Filet chaud très léger sur l'arête exposée à la lumière basse.
    if (surfaceLighting > 0.08) {
      ctx.beginPath();
      if (lightFromRight) {
        ctx.moveTo(roofPeakX, roofPeakY);
        ctx.lineTo(roofRightX, roofBaseY + 1 * scale);
      } else {
        ctx.moveTo(roofLeftX, roofBaseY + 1 * scale);
        ctx.lineTo(roofPeakX, roofPeakY);
      }
      ctx.strokeStyle = buildingEdgeColor;
      ctx.globalAlpha = 0.07 + 0.13 * surfaceLighting + 0.06 * twilight;
      ctx.lineWidth = Math.max(0.4, 0.65 * scale);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Les fenêtres gardent une lueur chaude la nuit, atténuée progressivement le jour.
    ctx.fillStyle = `rgba(218, 174, 99, ${windowAlpha.toFixed(3)})`;
    if (style % 4 !== 1) ctx.fillRect(x - width * 0.24, baseY - height * 0.63, 2 * scale, 2.5 * scale);
    if (style % 3 === 2) ctx.fillRect(x + width * 0.19, baseY - height * 0.56, 2 * scale, 2.5 * scale);
    ctx.restore();
  };

  const drawChurch = (x, baseY, scale = 1) => {
    ctx.save();
    const left = x - 13 * scale;
    const right = x + 12 * scale;
    const roofY = baseY - 13 * scale;
    const peakX = x - 1 * scale;
    const peakY = baseY - 22 * scale;

    // Nef avec un éclairage latéral qui reste discret à l'œil nu.
    ctx.fillStyle = directionalGradient(x, roofY + 6 * scale, 25 * scale, houseColor, houseSunlitColor, houseShadeColor);
    ctx.fillRect(left, roofY, 25 * scale, 13 * scale);
    ctx.fillStyle = houseShadeColor;
    ctx.globalAlpha = 0.5;
    ctx.fillRect(lightFromRight ? left : right - 4 * scale, roofY + 1 * scale, 4 * scale, 12 * scale);
    ctx.globalAlpha = 1;

    // Toiture en deux pans : lumière et ombre suivent le même côté que les maisons.
    ctx.beginPath();
    ctx.moveTo(left - 3 * scale, roofY + 1 * scale);
    ctx.lineTo(peakX, peakY);
    ctx.lineTo(peakX, roofY + 1 * scale);
    ctx.closePath();
    ctx.fillStyle = lightFromRight ? roofShadeColor : roofSunlitColor;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(peakX, peakY);
    ctx.lineTo(right + 3 * scale, roofY + 1 * scale);
    ctx.lineTo(peakX, roofY + 1 * scale);
    ctx.closePath();
    ctx.fillStyle = lightFromRight ? roofSunlitColor : roofShadeColor;
    ctx.fill();

    // Petit transept latéral et ouverture du clocher.
    ctx.fillStyle = directionalGradient(x - 12 * scale, baseY - 5 * scale, 10 * scale, houseColor, houseSunlitColor, houseShadeColor);
    ctx.fillRect(x - 16 * scale, baseY - 10 * scale, 7 * scale, 10 * scale);
    ctx.beginPath();
    ctx.moveTo(x - 18 * scale, baseY - 9 * scale);
    ctx.lineTo(x - 12.5 * scale, baseY - 15 * scale);
    ctx.lineTo(x - 7 * scale, baseY - 9 * scale);
    ctx.closePath();
    ctx.fillStyle = lightFromRight ? roofShadeColor : roofSunlitColor;
    ctx.fill();

    // Clocher et flèche.
    const towerX = x + 5 * scale;
    const towerW = 6 * scale;
    const towerBase = baseY - 17 * scale;
    const spireTip = baseY - 42 * scale;
    ctx.fillStyle = directionalGradient(towerX, towerBase + 6 * scale, towerW, houseColor, houseSunlitColor, houseShadeColor);
    ctx.fillRect(towerX - towerW / 2, towerBase, towerW, 13 * scale);
    ctx.fillRect(towerX - 4 * scale, towerBase + 2 * scale, 8 * scale, 2 * scale);
    ctx.beginPath();
    ctx.moveTo(towerX - 4.5 * scale, towerBase + 1 * scale);
    ctx.lineTo(towerX, spireTip);
    ctx.lineTo(towerX + 4.5 * scale, towerBase + 1 * scale);
    ctx.closePath();
    ctx.fillStyle = lightFromRight ? roofSunlitColor : roofShadeColor;
    ctx.fill();
    ctx.fillStyle = landscapeColor("#03060a", "#181316", "#343c30");
    ctx.fillRect(towerX - 0.65 * scale, spireTip - 5.5 * scale, 1.3 * scale, 8 * scale);
    ctx.fillRect(towerX - 3 * scale, spireTip - 3 * scale, 6 * scale, 1.25 * scale);
    ctx.fillStyle = churchInsetColor;
    ctx.fillRect(towerX - 1.2 * scale, towerBase + 5 * scale, 2.4 * scale, 3 * scale);
    ctx.fillStyle = `rgba(218, 174, 99, ${windowAlpha.toFixed(3)})`;
    ctx.fillRect(x - 7 * scale, baseY - 6 * scale, 2 * scale, 3 * scale);

    if (surfaceLighting > 0.08) {
      ctx.beginPath();
      if (lightFromRight) {
        ctx.moveTo(peakX, peakY);
        ctx.lineTo(right + 3 * scale, roofY + 1 * scale);
      } else {
        ctx.moveTo(left - 3 * scale, roofY + 1 * scale);
        ctx.lineTo(peakX, peakY);
      }
      ctx.strokeStyle = buildingEdgeColor;
      ctx.globalAlpha = 0.08 + 0.13 * surfaceLighting + 0.06 * twilight;
      ctx.lineWidth = Math.max(0.4, 0.65 * scale);
      ctx.stroke();
    }
    ctx.restore();
  };
  const villages = [
    { az: 18, church: true, layout: [[-29, .67, 2], [-16, .88, 1], [3, .72, 0], [20, 1.04, 2], [34, .61, 1], [12, .58, 0]] },
    { az: 43, layout: [[-22, .72, 1], [-4, 1.03, 2], [14, .65, 0], [31, .83, 1]] },
    { az: 77, church: true, layout: [[-31, .62, 0], [-13, .76, 2], [8, .95, 1], [25, .68, 0], [39, .55, 2]] },
    { az: 113, layout: [[-26, .81, 2], [-8, .58, 0], [9, .91, 1], [28, .66, 2]] },
    { az: 151, church: true, layout: [[-34, .59, 1], [-18, .8, 0], [4, .7, 2], [24, .98, 1], [38, .57, 0]] },
    { az: 193, layout: [[-24, .69, 0], [-5, .94, 2], [17, .7, 1], [33, .55, 0]] },
    { az: 229, church: true, layout: [[-32, .64, 2], [-14, .84, 1], [7, .68, 0], [26, .9, 2], [40, .53, 1]] },
    { az: 267, layout: [[-27, .7, 1], [-9, .86, 0], [12, .61, 2], [29, .77, 1]] },
    { az: 306, church: true, layout: [[-33, .58, 0], [-15, .79, 2], [5, .96, 1], [23, .66, 0], [37, .57, 2]] },
    { az: 342, layout: [[-23, .82, 2], [-2, .63, 1], [16, .91, 0], [32, .59, 2]] }
  ];
  for (const village of villages) {
    const center = skylinePoint(village.az);
    if (!center || center.y < -45 || center.y > h + 18) continue;
    const scale = clamp(h / 760, 0.65, 1.15);
    // Chaque maison reçoit son propre azimut et sa propre hauteur de terrain.
    // On garde l'espacement visuel historique, mais plus la base commune qui
    // produisait des bâtiments suspendus au-dessus des courbes de relief.
    for (const [offset, houseScale, style] of village.layout) {
      const objectScale = scale * houseScale;
      const targetX = center.x + offset * scale;
      const houseAzimuth = azimuthAtScreenX(village.az, targetX);
      const housePoint = skylinePoint(houseAzimuth);
      if (!housePoint || housePoint.y < -55 || housePoint.y > h + 18) continue;
      // Le dessin déborde légèrement sous le profil afin que sa base s'y
      // ancre sans liseré. Le tri final dessine les éléments lointains d'abord.
      const houseBaseY = housePoint.y - objectScale;
      const houseWidth = (style % 3 === 0 ? 17 : style % 3 === 1 ? 13 : 20) * objectScale;
      foregroundObjects.push({
        kind: "house",
        x: housePoint.x,
        baseY: housePoint.y,
        drawBaseY: houseBaseY,
        scale: objectScale,
        style,
        shadowWidth: houseWidth
      });
    }
    if (village.church) {
      const churchScale = scale * 0.88;
      const churchAzimuth = azimuthAtScreenX(village.az, center.x - 2 * scale);
      const churchPoint = skylinePoint(churchAzimuth);
      if (churchPoint && churchPoint.y >= -55 && churchPoint.y <= h + 18) {
        foregroundObjects.push({
          kind: "church",
          x: churchPoint.x,
          baseY: churchPoint.y,
          drawBaseY: churchPoint.y + 1.5 * churchScale,
          scale: churchScale,
          shadowWidth: 38 * churchScale
        });
      }
    }
  }
  // Bosquets de feuillus de tailles variées, par groupes irréguliers.
  const groves = [
    [31, [-15, -2, 10, 22]], [58, [-19, -7, 7, 18]], [96, [-12, 2, 16]],
    [132, [-20, -8, 5, 17]], [174, [-14, 0, 12, 24]], [211, [-18, -4, 9]],
    [248, [-22, -10, 3, 15, 26]], [286, [-15, -1, 13, 22]],
    [326, [-18, -5, 8, 20]], [355, [-13, 2, 15]]
  ];
  for (const [az, offsets] of groves) {
    const center = skylinePoint(az);
    if (!center || center.y < -30 || center.y > h + 18) continue;
    const scale = clamp(h / 760, 0.65, 1.1);
    offsets.forEach((offset, i) => {
      const targetX = center.x + offset * scale;
      const treeAzimuth = azimuthAtScreenX(az, targetX);
      const treePoint = skylinePoint(treeAzimuth);
      if (!treePoint || treePoint.y < -45 || treePoint.y > h + 18) return;
      const treeScale = scale * (0.68 + ((i * 7 + Math.round(az)) % 5) * 0.09);
      const treeShape = i + Math.round(az);
      foregroundObjects.push({
        kind: "tree",
        x: treePoint.x,
        baseY: treePoint.y,
        drawBaseY: treePoint.y + 1.2 * treeScale,
        scale: treeScale,
        shape: treeShape,
        shadowWidth: (treeShape % 3 === 0 ? 20 : 2 * (7 + treeShape % 3)) * treeScale
      });
    });
  }

  // Occlusion par profondeur apparente : les bases hautes à l'écran sont
  // dessinées d'abord ; les arbres et bâtiments au premier plan les recouvrent.
  // Les ombres sont peintes avant toutes les silhouettes pour ne jamais voiler
  // une façade ou un feuillage situé devant elles.
  foregroundObjects.sort((a, b) => a.baseY - b.baseY);
  for (const object of foregroundObjects) drawGroundShadow(object);
  for (const object of foregroundObjects) {
    if (object.kind === "house") drawHouse(object.x, object.drawBaseY, object.scale, object.style);
    else if (object.kind === "church") drawChurch(object.x, object.drawBaseY, object.scale);
    else if (object.kind === "tree") drawTree(object.x, object.drawBaseY, object.scale, object.shape);
  }

  // Repères cardinaux ancrés au véritable azimut, projetés sur la silhouette.
  // Ils ne sont dessinés que lorsque leur direction entre dans le champ.
  const cardinals = [
    [0, "N"], [90, "E"], [180, "S"], [270, getLocale() === "en" ? "W" : "O"]
  ];
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.font = "600 11px Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";

  for (const [azimuth, label] of cardinals) {
    // Projeter le point cardinal avec exactement la même caméra que le ciel
    // et le profil du terrain : le repère suit le cap, le tangage et le roulis.
    const point = projectTerrain(azimuth);
    if (!point) continue;
    const { x, y } = point;
    if (x < 14 || x > w - 14 || y < -10 || y > h + 10) continue;

    ctx.strokeStyle = "rgba(230, 197, 140, 0.62)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y - 2);
    ctx.lineTo(x, y - 10);
    ctx.stroke();

    ctx.fillStyle = "rgba(5, 9, 20, 0.78)";
    ctx.beginPath();
    ctx.roundRect(x - 11, y - 29, 22, 17, 5);
    ctx.fill();
    ctx.strokeStyle = "rgba(230, 197, 140, 0.35)";
    ctx.stroke();

    ctx.fillStyle = "rgba(245, 220, 174, 0.96)";
    ctx.fillText(label, x, y - 16);
  }

  ctx.restore();
}





/* ==========================================================
   VOIE LACTÉE — CARTE CÉLESTE GAIA (PROJECTION MOLLWEIDE)
   La texture provient de la carte all-sky ESA/Gaia/DPAC.
   Chaque cellule est reprojetée depuis les coordonnées
   galactiques vers la projection locale de l'application.
   ========================================================== */

const MILKY_WAY_MAP_URL =
  "https://cdn.eso.org/images/screen/ESA_Gaia_DR2_AllSky_Brightness_Colour_black_bg_8k.jpg";
const MILKY_WAY_MAP_CREDIT = "ESA/Gaia/DPAC — carte all-sky Gaia DR2, publiée par l’ESO";
let milkyWayImage = null;
let milkyWayImageReady = false;
let milkyWayImageFailed = false;
let milkyWayGrid = null;
let milkyWayCacheCanvas = null;
let milkyWayCacheKey = "";
// Mesures de cache facultatives, activées uniquement avec ?perf=1.
const milkyWayDiagnosticStats = {
  calls: 0, hits: 0, rebuilds: 0, buildTotalMs: 0, buildMaxMs: 0,
  reasons: { initial: 0, temps: 0, lieu: 0, orientation: 0, champ: 0, dimensions: 0, autre: 0, non_classee: 0 },
  changes: { temps: 0, lieu: 0, orientation: 0, champ: 0, dimensions: 0, aucune: 0 },
  buildCompleted: 0, buildAborted: 0, rebuildEvents: []
};

function initializeMilkyWay() {
  if (milkyWayImage) return;
  milkyWayImage = new Image();
  let corsAttempted = milkyWayWebGLRequested;
  let classicFallbackAttempted = false;
  milkyWayImage.onload = () => {
    milkyWayImageReady = true;
    milkyWayImageFailed = false;
    milkyWayGrid = null;
    milkyWayCacheKey = "";
    milkyWayGLDataKey = "";
    drawSky();
  };
  milkyWayImage.onerror = () => {
    // Essayer d'abord le mode CORS pour autoriser l'utilisation de la texture
    // WebGL. Si le serveur ne l'autorise pas, recharger classiquement l'image
    // pour préserver le rendu Canvas 2D.
    if (corsAttempted && !classicFallbackAttempted) {
      classicFallbackAttempted = true;
      milkyWayImage.crossOrigin = null;
      milkyWayImage.src = MILKY_WAY_MAP_URL + "?atlas_canvas_fallback=1";
      return;
    }
    milkyWayImageFailed = true;
    console.warn("[Atlas] Carte Gaia indisponible ; la Voie lactée ne sera pas affichée.");
  };
  if (corsAttempted) milkyWayImage.crossOrigin = "anonymous";
  milkyWayImage.src = MILKY_WAY_MAP_URL;
}

function galacticToEquatorial(longitude, latitude) {
  const l = rad(longitude);
  const b = rad(latitude);
  const cb = Math.cos(b);
  const gx = cb * Math.cos(l);
  const gy = cb * Math.sin(l);
  const gz = Math.sin(b);

  // Rotation du repère galactique vers ICRS/J2000.
  const x = -0.0548755604 * gx + 0.4941094279 * gy - 0.8676661490 * gz;
  const y = -0.8734370902 * gx - 0.4448296300 * gy - 0.1980763734 * gz;
  const z = -0.4838350155 * gx + 0.7469822445 * gy + 0.4559837762 * gz;
  return {
    ra: norm360(deg(Math.atan2(y, x))) / 15,
    dec: deg(Math.atan2(z, Math.hypot(x, y)))
  };
}

// Projection inverse de Mollweide : longitude/latitude galactiques -> pixels
// de la carte Gaia. Les coordonnées source sont calculées une seule fois par nœud.
function galacticMapPixel(longitude, latitude) {
  let lon = longitude;
  while (lon < -180) lon += 360;
  while (lon > 180) lon -= 360;
  const lambda = rad(lon);
  const beta = rad(clamp(latitude, -89.9, 89.9));
  let theta = beta;
  for (let i = 0; i < 8; i++) {
    const f = 2 * theta + Math.sin(2 * theta) - Math.PI * Math.sin(beta);
    const df = 2 + 2 * Math.cos(2 * theta);
    if (Math.abs(df) < 1e-7) break;
    theta -= f / df;
  }

  const imageWidth = milkyWayImage.naturalWidth || 1024;
  const imageHeight = milkyWayImage.naturalHeight || 644;
  const left = imageWidth * 0.034;
  const right = imageWidth * 0.966;
  const top = imageHeight * 0.128;
  const bottom = imageHeight * 0.855;
  const x = (Math.sin(theta) === 0 && Math.abs(latitude) > 89.8)
    ? imageWidth / 2
    : left + ((-lambda * Math.cos(theta) / Math.PI + 1) / 2) * (right - left);
  const y = top + ((1 - Math.sin(theta)) / 2) * (bottom - top);
  return { x, y };
}

function galacticScreenPoint(eq, date) {
  const horizontal = horizontalPosition(eq.ra, eq.dec, date);
  if (!Number.isFinite(horizontal.az) || !Number.isFinite(horizontal.alt) || horizontal.alt <= 0) {
    return null;
  }
  return project(horizontal.az, horizontal.alt);
}

// Dessine un triangle de texture via une transformation affine.
function drawMapTriangle(source, destination, crop, targetCtx = ctx) {
  const [s0, s1, s2] = source.map(p => ({ x: p.x - crop.x, y: p.y - crop.y }));
  const [p0, p1, p2] = destination;
  const denominator = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
  if (Math.abs(denominator) < 1e-5) return;

  const a = (p0.x * (s1.y - s2.y) + p1.x * (s2.y - s0.y) + p2.x * (s0.y - s1.y)) / denominator;
  const c = (p0.x * (s2.x - s1.x) + p1.x * (s0.x - s2.x) + p2.x * (s1.x - s0.x)) / denominator;
  const e = (p0.x * (s1.x * s2.y - s2.x * s1.y) + p1.x * (s2.x * s0.y - s0.x * s2.y) + p2.x * (s0.x * s1.y - s1.x * s0.y)) / denominator;
  const b = (p0.y * (s1.y - s2.y) + p1.y * (s2.y - s0.y) + p2.y * (s0.y - s1.y)) / denominator;
  const d = (p0.y * (s2.x - s1.x) + p1.y * (s0.x - s2.x) + p2.y * (s1.x - s0.x)) / denominator;
  const f = (p0.y * (s1.x * s2.y - s2.x * s1.y) + p1.y * (s2.x * s0.y - s0.x * s2.y) + p2.y * (s0.x * s1.y - s1.x * s0.y)) / denominator;

  // Très léger chevauchement pour limiter les coutures d'anticrénelage sans
  // créer de surépaisseur visible entre triangles voisins.
  const cx = (p0.x + p1.x + p2.x) / 3;
  const cy = (p0.y + p1.y + p2.y) / 3;
  const expand = 0.2;
  const expanded = destination.map(p => {
    const dx = p.x - cx, dy = p.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return { x: p.x + dx / len * expand, y: p.y + dy / len * expand };
  });
  targetCtx.save();
  targetCtx.beginPath();
  targetCtx.moveTo(expanded[0].x, expanded[0].y);
  targetCtx.lineTo(expanded[1].x, expanded[1].y);
  targetCtx.lineTo(expanded[2].x, expanded[2].y);
  targetCtx.closePath();
  targetCtx.clip();
  targetCtx.transform(a, b, c, d, e, f);
  targetCtx.drawImage(milkyWayImage, crop.x, crop.y, crop.width, crop.height,
    0, 0, crop.width, crop.height);
  targetCtx.restore();
}

function drawMilkyWayTriangle(vertices, date, depth = 0, targetCtx = ctx) {
  const isValid = v => v.dst && Number.isFinite(v.dst.x) && Number.isFinite(v.dst.y);
  const validCount = vertices.reduce((n, v) => n + (isValid(v) ? 1 : 0), 0);
  if (validCount === 0) return;

  const renderTriangle = tri => {
    // Le découpage peut tomber exactement sur une limite de projection ;
    // ne jamais transmettre de sommet nul à drawMapTriangle.
    if (tri.length !== 3 || tri.some(v => !v || !isValid(v) || !v.src ||
        !Number.isFinite(v.src.x) || !Number.isFinite(v.src.y))) return;
    const src = tri.map(v => v.src);
    // La carte Gaia est une projection de Mollweide avec une coupure à ±180°.
    // Écarter les triangles dont une arête traverse la discontinuité en longitude :
    // les coordonnées source sautent alors d'un bord de l'image à l'autre et
    // l'interpolation affine peint une pointe/zone sombre dans le ciel.
    const lonHasCut = tri.some((v, i) => {
      const next = tri[(i + 1) % tri.length];
      return Math.abs(v.lon - next.lon) > 180;
    });
    if (lonHasCut) return;
    const sourceXs = src.map(point => point.x);
    const sourceSpanX = Math.max(...sourceXs) - Math.min(...sourceXs);
    // Garde-fou supplémentaire pour les triangles proches du pôle/coupure,
    // où la longitude seule peut ne pas suffire à repérer un saut de projection.
    if (sourceSpanX > (milkyWayImage.naturalWidth || 1024) * 0.10) return;
    const minX = Math.max(0, Math.floor(Math.min(...src.map(point => point.x))));
    const minY = Math.max(0, Math.floor(Math.min(...src.map(point => point.y))));
    const maxX = Math.min(milkyWayImage.naturalWidth, Math.ceil(Math.max(...src.map(point => point.x))));
    const maxY = Math.min(milkyWayImage.naturalHeight, Math.ceil(Math.max(...src.map(point => point.y))));
    const crop = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    if (crop.width >= 1 && crop.height >= 1) {
      drawMapTriangle(src, tri.map(v => v.dst), crop, targetCtx);
    }
  };

  if (validCount === 3) {
    renderTriangle(vertices);
    return;
  }

  // Découpage exact du triangle au bord de la zone projetable. On recherche
  // par dichotomie le point où chaque arête passe de visible à invisible ; cela
  // évite les pointes triangulaires sans subdivision récursive coûteuse.
  const intersection = (a, b) => {
    let lo = 0, hi = 1;
    const aVisible = isValid(a);
    let visible = aVisible ? a : b;
    for (let i = 0; i < 12; i++) {
      const t = (lo + hi) / 2;
      const lon = a.lon + (b.lon - a.lon) * t;
      const lat = a.lat + (b.lat - a.lat) * t;
      const eq = galacticToEquatorial(lon, lat);
      const point = { lon, lat, eq, src: galacticMapPixel(lon, lat), dst: galacticScreenPoint(eq, date) };
      if (isValid(point)) {
        visible = point;
        if (aVisible) lo = t;
        else hi = t;
      } else {
        if (aVisible) hi = t;
        else lo = t;
      }
    }
    // Retourne toujours le dernier point valide, jamais le point invisible
    // situé de l'autre côté de l'horizon ou du bord du champ.
    return visible;
  };

  const polygon = [];
  for (let i = 0; i < vertices.length; i++) {
    const current = vertices[i];
    const next = vertices[(i + 1) % vertices.length];
    const currentValid = isValid(current);
    const nextValid = isValid(next);
    if (currentValid) polygon.push(current);
    if (currentValid !== nextValid) polygon.push(intersection(current, next));
  }
  if (polygon.length < 3) return;
  for (let i = 1; i < polygon.length - 1; i++) renderTriangle([polygon[0], polygon[i], polygon[i + 1]]);
}

function buildMilkyWayGrid() {
  // Sur les écrans tactiles, un maillage moins dense évite des milliers de
  // découpages/transformations canvas par rafraîchissement, sans masquer la carte.
  const isMobile = window.matchMedia("(max-width: 700px), (pointer: coarse)").matches;
  const lonStep = isMobile ? 12 : 6;
  const latStep = isMobile ? 1 : 0.5;
  const bandLimit = 17;
  const rows = [];
  for (let lat = -bandLimit; lat <= bandLimit + 1e-6; lat += latStep) {
    const row = [];
    for (let lon = -180; lon <= 180 + 1e-6; lon += lonStep) {
      const eq = galacticToEquatorial(lon, lat);
      row.push({
        lon, lat, eq,
        src: galacticMapPixel(lon, lat),
        dst: null
      });
    }
    rows.push(row);
  }
  return { rows, lonStep, latStep, bandLimit };
}

// Prototype WebGL facultatif pour la Voie lactée : activer avec ?milky=webgl.
// Le rendu 2D reste le chemin par défaut et sert de repli si WebGL échoue.
//const milkyWayWebGLRequested = (() => {
//  try { return new URLSearchParams(window.location.search).get("milky") === "webgl"; }
//  catch { return false; }
//})();

// WebGL activé par défaut pour la Voie lactée.
const milkyWayWebGLRequested = true;
let milkyWayGL = null;
let milkyWayGLCanvas = null;
let milkyWayGLTexture = null;
let milkyWayGLProgram = null;
let milkyWayGLBuffer = null;
let milkyWayGLFailed = false;
let milkyWayGLDataKey = "";
let milkyWayGLVertexCount = 0;
let milkyWayGLUniforms = null;
let milkyWayGLAttributes = null;
function initMilkyWayWebGL() {
  if (milkyWayGL || milkyWayGLFailed) return !!milkyWayGL;
  try {
    milkyWayGLCanvas = document.createElement("canvas");
    milkyWayGL = milkyWayGLCanvas.getContext("webgl", {
      alpha: true, antialias: false, preserveDrawingBuffer: true,
      premultipliedAlpha: true
    });
    if (!milkyWayGL) throw new Error("WebGL indisponible");
    const gl = milkyWayGL;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) || "Shader invalide");
      }
      return shader;
    };
    // La géométrie est envoyée au GPU en coordonnées locales est/nord/zénith.
    // La caméra (dont l'azimut) est appliquée dans le vertex shader à chaque image.
    const vertex = compile(gl.VERTEX_SHADER, `
      attribute vec3 a_local;
      attribute vec2 a_uv;
      attribute float a_alpha;
      uniform vec2 u_resolution;
      uniform float u_heading;
      uniform float u_pitch;
      uniform float u_roll;
      uniform float u_fx;
      uniform float u_fy;
      varying vec2 v_uv;
      varying float v_alpha;
      varying float v_altitude;
      void main() {
        float east = a_local.x;
        float north = a_local.y;
        float up = a_local.z;
        float sh = sin(u_heading), ch = cos(u_heading);
        float sp = sin(u_pitch), cp = cos(u_pitch);
        float x = east * ch - north * sh;
        float y = east * (-sp * sh) + north * (-sp * ch) + up * cp;
        float z = east * (cp * sh) + north * (cp * ch) + up * sp;
        float xr = x * cos(u_roll) - y * sin(u_roll);
        float yr = x * sin(u_roll) + y * cos(u_roll);
        if (z <= 0.0001) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        } else {
          float px = u_resolution.x * 0.5 + u_fx * xr / z;
          // Même origine optique que projectDirectionToScreen() : centre écran.
          // Utiliser horizonY() ici décalait la Voie lactée par rapport aux étoiles.
          float py = u_resolution.y * 0.5 - u_fy * yr / z;
          vec2 clip = vec2(px / u_resolution.x * 2.0 - 1.0,
                           1.0 - py / u_resolution.y * 2.0);
          gl_Position = vec4(clip, 0.0, 1.0);
        }
        v_uv = a_uv;
        v_alpha = a_alpha;
        v_altitude = up;
      }
    `);
    const fragment = compile(gl.FRAGMENT_SHADER, `
      precision mediump float;
      uniform sampler2D u_texture;
      varying vec2 v_uv;
      varying float v_alpha;
      varying float v_altitude;
      void main() {
        if (v_altitude <= 0.0) discard;
        vec4 texel = texture2D(u_texture, v_uv);
        float alpha = texel.a * v_alpha;
        gl_FragColor = vec4(texel.rgb * alpha, alpha);
      }
    `);
    milkyWayGLProgram = gl.createProgram();
    gl.attachShader(milkyWayGLProgram, vertex);
    gl.attachShader(milkyWayGLProgram, fragment);
    gl.linkProgram(milkyWayGLProgram);
    if (!gl.getProgramParameter(milkyWayGLProgram, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(milkyWayGLProgram) || "Programme WebGL invalide");
    }
    milkyWayGLBuffer = gl.createBuffer();
    milkyWayGLTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, milkyWayGLTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, milkyWayImage);
    gl.useProgram(milkyWayGLProgram);
    milkyWayGLUniforms = {
      texture: gl.getUniformLocation(milkyWayGLProgram, "u_texture"),
      resolution: gl.getUniformLocation(milkyWayGLProgram, "u_resolution"),
      heading: gl.getUniformLocation(milkyWayGLProgram, "u_heading"),
      pitch: gl.getUniformLocation(milkyWayGLProgram, "u_pitch"),
      roll: gl.getUniformLocation(milkyWayGLProgram, "u_roll"),
      fx: gl.getUniformLocation(milkyWayGLProgram, "u_fx"),
      fy: gl.getUniformLocation(milkyWayGLProgram, "u_fy")
    };
    milkyWayGLAttributes = {
      local: gl.getAttribLocation(milkyWayGLProgram, "a_local"),
      uv: gl.getAttribLocation(milkyWayGLProgram, "a_uv"),
      alpha: gl.getAttribLocation(milkyWayGLProgram, "a_alpha")
    };
    gl.uniform1i(milkyWayGLUniforms.texture, 0);
    return true;
  } catch (error) {
    milkyWayGLFailed = true;
    milkyWayGL = null;
    console.warn("[Atlas] Prototype WebGL de la Voie lactée indisponible ; retour au rendu 2D.", error);
    return false;
  }
}

function renderMilkyWayWebGL(targetWidth, targetHeight, rows, date, latStep, bandLimit, maxOpacity) {
  if (!initMilkyWayWebGL()) return false;
  const gl = milkyWayGL;
  try {
    if (milkyWayGLCanvas.width !== targetWidth || milkyWayGLCanvas.height !== targetHeight) {
      milkyWayGLCanvas.width = targetWidth;
      milkyWayGLCanvas.height = targetHeight;
    }
    const imageWidth = milkyWayImage.naturalWidth || 1;
    const imageHeight = milkyWayImage.naturalHeight || 1;
    // Les coordonnées locales ne dépendent pas de l'azimut/pitch de la caméra.
    // On ne les recalcule que toutes les 5 s (ou si le lieu change) ; la rotation
    // horizontale est ensuite appliquée par le GPU à chaque image.
    const timeBucket = Math.floor(date.getTime() / 5000);
    const dataKey = [timeBucket, state.latitude, state.longitude, rows.length, rows[0]?.length || 0].join("|");
    if (milkyWayGLDataKey !== dataKey || !milkyWayGLVertexCount) {
      const smoothstep = (a, b, x) => {
        const t = clamp((x - a) / (b - a), 0, 1);
        return t * t * (3 - 2 * t);
      };
      for (const row of rows) {
        for (const point of row) {
          const horizontal = horizontalPosition(point.eq.ra, point.eq.dec, date);
          if (Number.isFinite(horizontal.az) && Number.isFinite(horizontal.alt)) {
            const az = rad(horizontal.az), alt = rad(horizontal.alt), cosAlt = Math.cos(alt);
            point.local = { east: cosAlt * Math.sin(az), north: cosAlt * Math.cos(az), up: Math.sin(alt) };
          } else {
            point.local = null;
          }
        }
      }
      const data = [];
      const append = (point, alpha) => {
        const local = point.local;
        if (!local || !point.src) {
          // Un sommet invalide est placé sous l'horizon pour éviter les artefacts.
          data.push(0, 0, -1, 0, 0, 0);
          return;
        }
        data.push(local.east, local.north, local.up,
          point.src.x / imageWidth, point.src.y / imageHeight, alpha);
      };
      for (let ri = 0; ri < rows.length - 1; ri++) {
        const centerLat = -bandLimit + ri * latStep + latStep / 2;
        const fade = 1 - smoothstep(5.5, bandLimit, Math.abs(centerLat));
        if (fade <= 0.004) continue;
        const alpha = maxOpacity * fade;
        const rowA = rows[ri], rowB = rows[ri + 1];
        for (let ci = 0; ci < rowA.length - 1; ci++) {
          const a = rowA[ci], b = rowA[ci + 1], c = rowB[ci + 1], d = rowB[ci];
          // La texture Gaia est une projection de Mollweide : un triangle qui
          // traverse sa coupure ou dont les UV sautent fortement peut être
          // étiré par interpolation GPU et former une grande pointe sombre.
          // Filtrer chaque triangle séparément conserve l'autre moitié du quad.
          const safeTriangle = tri => {
            if (tri.some(point => !point || !point.src || !point.local ||
                !Number.isFinite(point.src.x) || !Number.isFinite(point.src.y))) return false;
            for (let i = 0; i < tri.length; i++) {
              const next = tri[(i + 1) % tri.length];
              if (Math.abs(tri[i].lon - next.lon) > 180) return false;
            }
            const xs = tri.map(point => point.src.x);
            const ys = tri.map(point => point.src.y);
            const sourceSpanX = Math.max(...xs) - Math.min(...xs);
            const sourceSpanY = Math.max(...ys) - Math.min(...ys);
            // Seuils volontairement plus stricts que la largeur d'une cellule
            // normale du maillage : ils ne retirent que les sauts de projection.
            return sourceSpanX <= imageWidth * 0.10 && sourceSpanY <= imageHeight * 0.20;
          };
          for (const tri of [[a, b, c], [a, c, d]]) {
            if (safeTriangle(tri)) for (const point of tri) append(point, alpha);
          }
        }
      }
      const typed = new Float32Array(data);
      gl.bindBuffer(gl.ARRAY_BUFFER, milkyWayGLBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, typed, gl.STATIC_DRAW);
      milkyWayGLVertexCount = typed.length / 6;
      milkyWayGLDataKey = dataKey;
    }
    gl.viewport(0, 0, targetWidth, targetHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(milkyWayGLProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, milkyWayGLTexture);
    gl.uniform2f(milkyWayGLUniforms.resolution, targetWidth, targetHeight);
    gl.uniform1f(milkyWayGLUniforms.heading, rad(state.heading));
    gl.uniform1f(milkyWayGLUniforms.pitch, rad(state.pitch));
    gl.uniform1f(milkyWayGLUniforms.roll, rad(state.roll));
    gl.uniform1f(milkyWayGLUniforms.fx, targetWidth / (2 * Math.tan(rad(state.fov) / 2)));
    gl.uniform1f(milkyWayGLUniforms.fy, targetHeight / (2 * Math.tan(rad(state.verticalFov) / 2)));
    gl.bindBuffer(gl.ARRAY_BUFFER, milkyWayGLBuffer);
    const stride = 6 * 4;
    gl.enableVertexAttribArray(milkyWayGLAttributes.local);
    gl.vertexAttribPointer(milkyWayGLAttributes.local, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(milkyWayGLAttributes.uv);
    gl.vertexAttribPointer(milkyWayGLAttributes.uv, 2, gl.FLOAT, false, stride, 3 * 4);
    gl.enableVertexAttribArray(milkyWayGLAttributes.alpha);
    gl.vertexAttribPointer(milkyWayGLAttributes.alpha, 1, gl.FLOAT, false, stride, 5 * 4);
    gl.drawArrays(gl.TRIANGLES, 0, milkyWayGLVertexCount);
    return true;
  } catch (error) {
    console.warn("[Atlas] Échec du rendu WebGL de la Voie lactée ; retour au rendu 2D.", error);
    milkyWayGLFailed = true;
    milkyWayGL = null;
    return false;
  }
}

function drawMilkyWayWebGLFrame(date) {
  if (!milkyWayImageReady || !milkyWayImage || !state.width || !state.height) return true;
  const targetWidth = Math.max(1, Math.round(state.width));
  const targetHeight = Math.max(1, Math.round(state.height));
  if (!milkyWayGrid) milkyWayGrid = buildMilkyWayGrid();
  if (!milkyWayCacheCanvas) milkyWayCacheCanvas = document.createElement("canvas");
  if (milkyWayCacheCanvas.width !== targetWidth || milkyWayCacheCanvas.height !== targetHeight) {
    milkyWayCacheCanvas.width = targetWidth;
    milkyWayCacheCanvas.height = targetHeight;
  }
  const targetCtx = milkyWayCacheCanvas.getContext("2d");
  if (!targetCtx) return false;
  const { rows, latStep, bandLimit } = milkyWayGrid;
  const started = skyRenderDiagnostics ? performance.now() : 0;
  if (!renderMilkyWayWebGL(targetWidth, targetHeight, rows, date, latStep, bandLimit, 0.12)) return false;
  targetCtx.setTransform(1, 0, 0, 1, 0, 0);
  targetCtx.clearRect(0, 0, targetWidth, targetHeight);
  targetCtx.drawImage(milkyWayGLCanvas, 0, 0, targetWidth, targetHeight);
  if (skyRenderDiagnostics) {
    milkyWayDiagnosticStats.calls++;
    milkyWayDiagnosticStats.hits++;
    milkyWayDiagnosticStats.buildTotalMs += performance.now() - started;
    milkyWayDiagnosticStats.buildCompleted++;
  }
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = 1;
  ctx.drawImage(milkyWayCacheCanvas, 0, 0, state.width, state.height);
  ctx.restore();
  return true;
}

function drawMilkyWay(date) {
  if (!milkyWayImageReady || !milkyWayImage || !state.width || !state.height) return;
  // En mode WebGL, la caméra est appliquée sur le GPU à chaque image : ne pas
  // utiliser le cache d’écran par angle qui rendait l’azimut saccadé.
  if (milkyWayWebGLRequested && !milkyWayGLFailed) {
    if (drawMilkyWayWebGLFrame(date)) return;
  }
  if (skyRenderDiagnostics) milkyWayDiagnosticStats.calls++;

  // La texture projetée est stable tant que l'heure, le lieu, la caméra et
  // les dimensions restent identiques. Réutiliser le canvas évite de refaire
  // tous les clips/transformations lors des redessins déclenchés par l'interface.
  const positionBucket = Math.floor(date.getTime() / 5000);
  // Sur mobile, les capteurs produisent de petites variations fréquentes.
  // Un pas de 1° réduit les reconstructions du cache sans diminuer le maillage
  // ni la résolution du dessin. Sur ordinateur, on conserve le pas de 0,5°.
  const cameraAngleStep = state.width <= 700 ? 1 : 0.5;
  const cameraAngleBucket = value => {
    const angle = Number(value) || 0;
    return Math.round(angle / cameraAngleStep) * cameraAngleStep;
  };
  const cacheKey = [
    positionBucket, state.latitude, state.longitude,
    cameraAngleBucket(state.heading), cameraAngleBucket(state.pitch),
    cameraAngleBucket(state.roll), state.fov, state.verticalFov,
    state.width, state.height
  ].join("|");

  if (milkyWayCacheKey !== cacheKey || !milkyWayCacheCanvas) {
    const diagnosticBuildStart = skyRenderDiagnostics ? performance.now() : 0;
    if (skyRenderDiagnostics) {
      milkyWayDiagnosticStats.rebuilds++;
      const previous = milkyWayCacheKey ? milkyWayCacheKey.split("|") : null;
      const current = cacheKey.split("|");
      let changedNames = previous ? [] : ["initial"];
      let reason = "autre";
      if (!previous || !milkyWayCacheCanvas) {
        reason = "initial";
      } else {
        // Compter séparément chaque dimension qui change : plusieurs valeurs
        // peuvent changer entre deux images, même si une seule est la cause
        // principale retenue ci-dessous.
        const changed = {
          temps: previous[0] !== current[0],
          lieu: previous[1] !== current[1] || previous[2] !== current[2],
          orientation: previous[3] !== current[3] || previous[4] !== current[4] || previous[5] !== current[5],
          champ: previous[6] !== current[6] || previous[7] !== current[7],
          dimensions: previous[8] !== current[8] || previous[9] !== current[9]
        };
        changedNames = Object.keys(changed).filter(name => changed[name]);
        if (!changedNames.length) {
          milkyWayDiagnosticStats.changes.aucune++;
          reason = "autre";
        } else {
          for (const name of changedNames) milkyWayDiagnosticStats.changes[name]++;
          // Priorité de classement conservée pour comparer aux mesures précédentes.
          reason = changed.temps ? "temps" : changed.lieu ? "lieu" : changed.orientation ? "orientation" : changed.champ ? "champ" : changed.dimensions ? "dimensions" : "autre";
        }
      }
      milkyWayDiagnosticStats.reasons[reason]++;
      milkyWayDiagnosticStats.rebuildEvents.push({ reason, changedNames: previous ? changedNames : ["initial"] });
    }
    if (!milkyWayCacheCanvas) milkyWayCacheCanvas = document.createElement("canvas");
    const targetWidth = Math.max(1, Math.round(state.width));
    const targetHeight = Math.max(1, Math.round(state.height));
    if (milkyWayCacheCanvas.width !== targetWidth || milkyWayCacheCanvas.height !== targetHeight) {
      milkyWayCacheCanvas.width = targetWidth;
      milkyWayCacheCanvas.height = targetHeight;
    }
    const targetCtx = milkyWayCacheCanvas.getContext("2d");
    if (!targetCtx) {
      if (skyRenderDiagnostics) milkyWayDiagnosticStats.buildAborted++;
      return;
    }
    targetCtx.setTransform(1, 0, 0, 1, 0, 0);
    targetCtx.clearRect(0, 0, targetWidth, targetHeight);

    if (!milkyWayGrid) milkyWayGrid = buildMilkyWayGrid();
    const { rows, latStep, bandLimit } = milkyWayGrid;
    for (const row of rows) {
      for (const point of row) point.dst = galacticScreenPoint(point.eq, date);
    }

    const maxOpacity = 0.12;
    const smoothstep = (a, b, x) => {
      const t = clamp((x - a) / (b - a), 0, 1);
      return t * t * (3 - 2 * t);
    };

    const usedWebGL = milkyWayWebGLRequested && renderMilkyWayWebGL(targetWidth, targetHeight, rows, date, latStep, bandLimit, maxOpacity);
    if (usedWebGL) {
      targetCtx.drawImage(milkyWayGLCanvas, 0, 0, targetWidth, targetHeight);
    } else {
      targetCtx.save();
      targetCtx.globalCompositeOperation = "screen";
      for (let rowIndex = 0; rowIndex < rows.length - 1; rowIndex++) {
        const lat = -bandLimit + rowIndex * latStep;
        const centerLat = lat + latStep / 2;
        const fade = 1 - smoothstep(5.5, bandLimit, Math.abs(centerLat));
        if (fade <= 0.004) continue;
        targetCtx.globalAlpha = maxOpacity * fade;
        const rowA = rows[rowIndex];
        const rowB = rows[rowIndex + 1];
        for (let col = 0; col < rowA.length - 1; col++) {
          const a = rowA[col], b = rowA[col + 1], c = rowB[col + 1], d = rowB[col];
          drawMilkyWayTriangle([a, b, c], date, 0, targetCtx);
          drawMilkyWayTriangle([a, c, d], date, 0, targetCtx);
        }
      }
      targetCtx.restore();
    }
    milkyWayCacheKey = cacheKey;
    if (skyRenderDiagnostics) {
      const buildMs = performance.now() - diagnosticBuildStart;
      milkyWayDiagnosticStats.buildTotalMs += buildMs;
      milkyWayDiagnosticStats.buildMaxMs = Math.max(milkyWayDiagnosticStats.buildMaxMs, buildMs);
      milkyWayDiagnosticStats.buildCompleted++;
    }
  } else if (skyRenderDiagnostics) {
    milkyWayDiagnosticStats.hits++;
  }

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = 1;
  ctx.drawImage(milkyWayCacheCanvas, 0, 0, state.width, state.height);
  ctx.restore();
}

  /* ==========================================================
     CONSTELLATIONS
     ========================================================== */

  function celestialVector(star) {
    const ra = rad(star.ra * 15);
    const dec = rad(star.dec);

    return {
      x: Math.cos(dec) * Math.cos(ra),
      y: Math.cos(dec) * Math.sin(ra),
      z: Math.sin(dec)
    };
  }

  function vectorToEquatorial(v) {
    const length = Math.hypot(v.x, v.y, v.z);

    if (!length) {
      return null;
    }

    const x = v.x / length;
    const y = v.y / length;
    const z = v.z / length;

    return {
      ra: norm360(deg(Math.atan2(y, x))) / 15,
      dec: deg(Math.asin(clamp(z, -1, 1)))
    };
  }

  function interpolateStar(a, b, t) {
    const va = celestialVector(a);
    const vb = celestialVector(b);

    const dot = clamp(
      va.x * vb.x +
      va.y * vb.y +
      va.z * vb.z,
      -1,
      1
    );

    const angle = Math.acos(dot);

    if (angle < 1e-8) {
      return { ra: a.ra, dec: a.dec };
    }

    const sinAngle = Math.sin(angle);

    /*
     * Cas antipodal : interpolation sphérique indéterminée.
     * On utilise une interpolation de secours.
     */
    if (Math.abs(sinAngle) < 1e-8) {
      return {
        ra: norm360(
          a.ra * 15 +
          norm180((b.ra - a.ra) * 15) * t
        ) / 15,

        dec: a.dec + (b.dec - a.dec) * t
      };
    }

    const wa =
      Math.sin((1 - t) * angle) / sinAngle;

    const wb =
      Math.sin(t * angle) / sinAngle;

    return vectorToEquatorial({
      x: wa * va.x + wb * vb.x,
      y: wa * va.y + wb * vb.y,
      z: wa * va.z + wb * vb.z
    });
  }

  function drawConstellationSegment(a, b, date, color, emphasis = false) {
    const va = celestialVector(a);
    const vb = celestialVector(b);

    const angle = Math.acos(clamp(
      va.x * vb.x +
      va.y * vb.y +
      va.z * vb.z,
      -1,
      1
    ));

    const steps = clamp(
      Math.ceil(angle / rad(1)),
      12,
      120
    );

    // Éviter les liaisons aberrantes entre étoiles trop éloignées.
    // Une limite élevée préserve les segments légitimes des
    // constellations étendues.
    if (!Number.isFinite(angle) || angle > rad(35)) {
    return;
    }

    ctx.save();

    ctx.beginPath();
    // Les étoiles doivent rester au premier plan : les lignes servent de guide,
    // sans concurrencer visuellement les points stellaires. Une figure choisie
    // devient dorée et plus épaisse, les autres sont volontairement atténuées.
    if (emphasis) color = "#ffd98a";
    ctx.strokeStyle = color;
    ctx.lineWidth = emphasis ? 1.45 : (state.discoveryConstellationId ? 0.7 : 0.95);
    ctx.globalAlpha = emphasis ? 0.78 : (state.discoveryConstellationId ? 0.13 : 0.46);
    // En mode Découverte, les liaisons restent discrètes et en pointillés.
    ctx.setLineDash(emphasis ? [3, 4] : []);

    let drawing = false;
    let previous = null;

    for (let i = 0; i <= steps; i++) {
      const eq = interpolateStar(a, b, i / steps);

      if (!eq) {
        drawing = false;
        previous = null;
        continue;
      }

      const horizontal = horizontalPosition(
        eq.ra,
        eq.dec,
        date
      );

      if (
        !Number.isFinite(horizontal.alt) ||
        horizontal.alt <= 0
      ) {
        drawing = false;
        previous = null;
        continue;
      }

      const point = project(
        horizontal.az,
        horizontal.alt
      );

      if (!point) {
        drawing = false;
        previous = null;
        continue;
      }

      if (!drawing || !previous) {
        ctx.moveTo(point.x, point.y);
        drawing = true;
      } else {
        const distance = Math.hypot(
          point.x - previous.x,
          point.y - previous.y
        );

        if (
          distance >
          Math.max(state.width, state.height) * 0.25
        ) {
          ctx.moveTo(point.x, point.y);
        } else {
          ctx.lineTo(point.x, point.y);
        }
      }

      previous = point;
    }

    ctx.stroke();
    ctx.restore();
  }

  const CONSTELLATION_BOUNDARIES_URL =
    "https://raw.githubusercontent.com/dieghernan/celestial_data/main/data/constellations.borders.min.geojson";

  async function loadConstellationBoundaries() {
    if (state.constellationBoundaryLines || state.constellationBoundariesLoading) return;
    state.constellationBoundariesLoading = true;
    try {
      const response = await fetch(CONSTELLATION_BOUNDARIES_URL, { cache: "force-cache" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const geojson = await response.json();
      const lines = [];
      const collect = geometry => {
        if (!geometry) return;
        const addLine = coords => {
          if (Array.isArray(coords) && coords.length >= 2) {
            const sourcePoints = coords.filter(c => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]))
              // GeoJSON : longitude en degrés équatoriaux ; horizontalPosition attend la RA en heures.
              .map(c => ({ ra: (((c[0] + 360) % 360) / 15), dec: c[1] }));
            if (sourcePoints.length < 2) return;
            // Densifier les segments avant projection : sinon, un segment dont les deux
            // extrémités sont hors champ peut traverser l'écran sans jamais être tracé.
            // Pas maximal de 2° pour suivre les bords du champ et l'horizon sans alourdir
            // excessivement le rendu à chaque image.
            const points = [sourcePoints[0]];
            for (let i = 1; i < sourcePoints.length; i++) {
              const a = sourcePoints[i - 1], b = sourcePoints[i];
              let dra = b.ra - a.ra;
              if (dra > 12) dra -= 24;
              else if (dra < -12) dra += 24;
              const ddec = b.dec - a.dec;
              const spanDeg = Math.max(Math.abs(dra * 15), Math.abs(ddec));
              const steps = Math.max(1, Math.ceil(spanDeg / 2));
              for (let step = 1; step <= steps; step++) {
                const t = step / steps;
                points.push({ ra: ((a.ra + dra * t + 24) % 24), dec: a.dec + ddec * t });
              }
            }
            if (points.length >= 2) lines.push(points);
          }
        };
        if (geometry.type === "LineString") addLine(geometry.coordinates);
        else if (geometry.type === "MultiLineString") geometry.coordinates.forEach(addLine);
        else if (geometry.type === "Polygon") geometry.coordinates.forEach(addLine);
        else if (geometry.type === "MultiPolygon") geometry.coordinates.forEach(poly => poly.forEach(addLine));
        else if (geometry.type === "GeometryCollection") geometry.geometries.forEach(collect);
      };
      if (geojson.type === "FeatureCollection") geojson.features.forEach(f => collect(f.geometry));
      else if (geojson.type === "Feature") collect(geojson.geometry);
      else collect(geojson);
      if (!lines.length) throw new Error(t("ui.boundaryGeometryUnrecognized"));
      state.constellationBoundaryLines = lines;
    } catch (error) {
      console.warn("Atlas : limites des constellations indisponibles", error);
      state.constellationBoundaryLines = [];
    } finally {
      state.constellationBoundariesLoading = false;
      drawSky();
    }
  }

  let eclipticGridHorizontalCache = { key: "", curves: [] };

  function drawEclipticGrid(date) {
    state.eclipticLabelBounds = null;
    if (!state.showEclipticGrid) return;
    const app = $("app");
    const discoveryMode = Boolean(app?.classList.contains("discovery-mode"));
    // La grille est volontairement absente du mode Expert sur téléphone.
    if (!discoveryMode && !window.matchMedia("(min-width: 601px)").matches) return;

    // Les étoiles du catalogue sont exprimées à l'époque J2000. La grille doit
    // employer le même repère et la même précession avant la conversion locale ;
    // mélanger l'obliquité de la date avec des coordonnées J2000 créait un décalage.
    const positionBucket = Math.floor(date.getTime() / 5000);
    const cacheKey = `${positionBucket}|${state.latitude}|${state.longitude}`;
    if (eclipticGridHorizontalCache.key !== cacheKey) {
      const epsilonJ2000 = rad(23.439291);
      const makeCurve = (fixedValue, isLatitude) => {
        const points = [];
        // Les parallèles couvrent 360° de longitude ; les méridiens s'étendent
        // du pôle sud au pôle nord écliptique. Un pas fin limite les coupures
        // aux bords de l'écran et suit mieux les courbes dans la projection.
        const start = isLatitude ? 0 : -90;
        const end = isLatitude ? 360 : 90;
        const step = isLatitude ? 1.5 : 1.5;
        for (let value = start; value <= end + 1e-6; value += step) {
          const longitude = isLatitude ? value : fixedValue;
          const latitude = isLatitude ? fixedValue : value;
          const lambda = rad(longitude);
          const beta = rad(latitude);
          const x = Math.cos(beta) * Math.cos(lambda);
          const y = Math.cos(beta) * Math.sin(lambda) * Math.cos(epsilonJ2000) - Math.sin(beta) * Math.sin(epsilonJ2000);
          const z = Math.cos(beta) * Math.sin(lambda) * Math.sin(epsilonJ2000) + Math.sin(beta) * Math.cos(epsilonJ2000);
          const ra = norm360(deg(Math.atan2(y, x))) / 15;
          const dec = deg(Math.asin(clamp(z, -1, 1)));
          const horizontal = equatorialToHorizontal(ra, dec, date, state.latitude, state.longitude, { epoch: CATALOGUE_EPOCH });
          points.push(Number.isFinite(horizontal.az) && Number.isFinite(horizontal.alt)
            ? { az: horizontal.az, alt: horizontal.alt }
            : null);
        }
        return { points, isEcliptic: isLatitude && fixedValue === 0 };
      };
      const curves = [];
      // Parallèles écliptiques : ligne principale et latitudes ±10° à ±80°.
      for (let latitude = -80; latitude <= 80; latitude += 10) curves.push(makeCurve(latitude, true));
      // Méridiens tous les 15° : grille complète jusqu'aux pôles écliptiques.
      for (let longitude = 0; longitude < 360; longitude += 15) curves.push(makeCurve(longitude, false));
      eclipticGridHorizontalCache = { key: cacheKey, curves };
    }

    const maxJump = Math.max(state.width, state.height) * 0.18;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, state.width, state.height);
    ctx.clip();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    let eclipticLabelPoint = null;
    let eclipticLabelDistance = Infinity;
    for (const curve of eclipticGridHorizontalCache.curves) {
      ctx.beginPath();
      let drawing = false;
      let previous = null;
      for (const horizontal of curve.points) {
        // Comme les objets, la grille reste sous l'horizon et utilise exactement
        // la projection de caméra commune à la carte, aux étoiles et à la Voie lactée.
        const point = horizontal && horizontal.alt > 0
          ? projectDirectionToScreen(horizontal.az, horizontal.alt)
          : null;
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
          drawing = false;
          previous = null;
          continue;
        }
        if (curve.isEcliptic && point.x > 48 && point.x < state.width - 48 && point.y > 36 && point.y < state.height - 36) {
          const distanceToCenter = Math.hypot(point.x - state.width * 0.5, point.y - state.height * 0.5);
          if (distanceToCenter < eclipticLabelDistance) {
            eclipticLabelDistance = distanceToCenter;
            eclipticLabelPoint = { x: point.x, y: point.y };
          }
        }
        if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) > maxJump) {
          drawing = false;
          previous = null;
        }
        if (!drawing) {
          ctx.moveTo(point.x, point.y);
          drawing = true;
        } else {
          ctx.lineTo(point.x, point.y);
        }
        previous = point;
      }
      ctx.strokeStyle = curve.isEcliptic ? "rgba(255, 218, 126, 0.72)" : "rgba(130, 184, 222, 0.30)";
      ctx.lineWidth = curve.isEcliptic ? 1.35 : 0.75;
      ctx.setLineDash(curve.isEcliptic ? [] : [3, 5]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    if (eclipticLabelPoint) {
      const label = t("ui.ecliptic");
      ctx.save();
      const fontSize = Math.max(12, Math.min(15, state.width * 0.018));
      ctx.font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      const metrics = ctx.measureText(label);
      const paddingX = 5;
      const paddingY = 3;
      const labelWidth = metrics.width + paddingX * 2;
      const labelHeight = fontSize + paddingY * 2;
      const x = clamp(eclipticLabelPoint.x, labelWidth / 2 + 4, state.width - labelWidth / 2 - 4);
      const y = clamp(eclipticLabelPoint.y - 5, labelHeight + 3, state.height - 4);
      ctx.fillStyle = "rgba(5, 12, 27, 0.78)";
      ctx.fillRect(x - labelWidth / 2, y - labelHeight + 2, labelWidth, labelHeight);
      ctx.fillStyle = "#ffdc82";
      ctx.shadowColor = "rgba(255, 210, 100, 0.35)";
      ctx.shadowBlur = 5;
      ctx.fillText(label, x, y - paddingY);
      ctx.restore();
      state.eclipticLabelBounds = {
        left: x - labelWidth / 2 - 5,
        right: x + labelWidth / 2 + 5,
        top: y - labelHeight - 4,
        bottom: y + 4
      };
    }
    ctx.restore();
  }

  function drawConstellationBoundaries(date) {
    if (!state.showConstellationBoundaries) return;
    if (!state.constellationBoundaryLines) {
      loadConstellationBoundaries();
      return;
    }
    ctx.save();
    ctx.strokeStyle = "rgba(137, 169, 204, 0.52)";
    ctx.lineWidth = 0.85;
    ctx.setLineDash([3, 4]);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const line of state.constellationBoundaryLines) {
      ctx.beginPath();
      let drawing = false;
      let previous = null;
      for (const eq of line) {
        const horizontal = horizontalPosition(eq.ra, eq.dec, date);
        const point = project(horizontal.az, horizontal.alt);
        if (!point) {
          if (drawing) ctx.stroke();
          ctx.beginPath();
          drawing = false;
          previous = null;
          continue;
        }
        if (!drawing || !previous || Math.hypot(point.x - previous.x, point.y - previous.y) > Math.max(state.width, state.height) * 0.18) {
          if (drawing) ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(point.x, point.y);
          drawing = true;
        } else {
          ctx.lineTo(point.x, point.y);
        }
        previous = point;
      }
      if (drawing) ctx.stroke();
    }
    ctx.restore();
  }

  // Index des noms stellaires réutilisé entre les rendus : le catalogue
  // reste stable la plupart du temps et les tracés seuls dépendent de la date.
  let constellationStarNameCache = { stars: null, length: -1, byName: null };

  function drawConstellations(date) {
    // Les tracés pédagogiques des balades restent visibles même si les lignes
    // officielles des constellations sont masquées.
    if (!state.stars.length) {
      return;
    }

    let byName;
    if (
      constellationStarNameCache.stars === state.stars &&
      constellationStarNameCache.length === state.stars.length &&
      constellationStarNameCache.byName
    ) {
      byName = constellationStarNameCache.byName;
    } else {
      byName = new Map();

    function registerName(name, star) {
      if (!name) {
        return;
      }

      const key = nameKey(name);

      if (key && !byName.has(key)) {
        byName.set(key, star);
      }
    }

    for (const star of state.stars) {
      [
        star.name,
        star.designation,
        star.proper_name,
        star.properName,
        star.id,
        star.bayer,
        star.flamsteed,
        star.hd,
        star.hip
      ].forEach(name => registerName(name, star));
      registerName(displayStarName(star), star);
    }

    // Alias anglais et français pour les repères nommés dans les balades.
    const walkStarHipAliases = {
      Polaris: 11767, "Étoile Polaire": 11767, Merak: 53910, "Mérak": 53910,
      Dubhe: 54061, "Dubhé": 54061, Vega: 91262, "Véga": 91262,
      Altair: 97649, "Altaïr": 97649, Deneb: 102098, Aldebaran: 21421,
      "Aldébaran": 21421, Alcyone: 17702, "Alpheratz": 677, "Alphératz": 677,
      Mirach: 5447, Betelgeuse: 27989, "Bételgeuse": 27989, Rigel: 24436,
      Mintaka: 25930, Alnilam: 26311, Alnitak: 26727
    };
    const starsByHip = new Map(state.stars.map(star => [Number(star.hip ?? String(star.id || "").match(/^HIP[_\s-]*(\d+)$/i)?.[1]), star]));
    for (const [alias, hip] of Object.entries(walkStarHipAliases)) {
      const star = starsByHip.get(hip);
      if (star) registerName(alias, star);
    }

    const aliases = {
      Dubhe: ["Alpha Ursae Majoris", "α UMa"],
      Merak: ["Beta Ursae Majoris", "β UMa"],
      Phecda: ["Gamma Ursae Majoris", "γ UMa"],
      Megrez: ["Delta Ursae Majoris", "δ UMa"],
      Alioth: ["Epsilon Ursae Majoris", "ε UMa"],
      Mizar: ["Zeta Ursae Majoris", "ζ UMa"],
      Alkaid: ["Eta Ursae Majoris", "η UMa"],
      Polaris: ["Alpha Ursae Minoris", "α UMi"],
      Kochab: ["Beta Ursae Minoris", "β UMi"],
      Pherkad: ["Gamma Ursae Minoris", "γ UMi"],
      Yildun: ["Delta Ursae Minoris", "δ UMi"],
      Caph: ["Beta Cassiopeiae", "β Cas"],
      Schedar: ["Alpha Cassiopeiae", "α Cas"],
      Navi: ["Gamma Cassiopeiae", "γ Cas"],
      Ruchbah: ["Delta Cassiopeiae", "δ Cas"],
      Segin: ["Epsilon Cassiopeiae", "ε Cas"],
      Betelgeuse: ["Alpha Orionis", "α Ori"],
      Bellatrix: ["Gamma Orionis", "γ Ori"],
      Mintaka: ["Delta Orionis", "δ Ori"],
      Alnilam: ["Epsilon Orionis", "ε Ori"],
      Alnitak: ["Zeta Orionis", "ζ Ori"],
      Rigel: ["Beta Orionis", "β Ori"],
      Saiph: ["Kappa Orionis", "κ Ori"],
      Meissa: ["Lambda Orionis", "λ Ori"],
      Vega: ["Alpha Lyrae", "α Lyr"],
      Deneb: ["Alpha Cygni", "α Cyg"],
      Altair: ["Alpha Aquilae", "α Aql"],
      Aldebaran: ["Alpha Tauri", "α Tau"],
      Alcyone: ["Eta Tauri", "η Tau"],
      Alpheratz: ["Alpha Andromedae", "α And"],
      Mirach: ["Beta Andromedae", "β And"],
      "Mu Andromedae": ["Mu Andromedae", "μ And"]
    };

    for (
      const [traditionalName, alternatives]
      of Object.entries(aliases)
    ) {
      const star = byName.get(nameKey(traditionalName));

      if (star) {
        alternatives.forEach(
          alias => registerName(alias, star)
        );
      } else {
        for (const alias of alternatives) {
          const candidate = byName.get(nameKey(alias));

          if (candidate) {
            registerName(traditionalName, candidate);
            break;
          }
        }
      }
    }

      constellationStarNameCache = {
        stars: state.stars,
        length: state.stars.length,
        byName
      };
    }

    if (state.showConstellations && state.constellations.length) {
      for (const constellation of state.constellations) {
        if (!Array.isArray(constellation.lines)) {
          continue;
        }
        if (state.finderActive && state.skyGuideMode === "free" && state.discoveryConstellationId &&
            String(constellation.id) !== String(state.discoveryConstellationId)) {
          continue;
        }

        for (const [nameA, nameB] of constellation.lines) {
        const a = byName.get(nameKey(nameA));
        const b = byName.get(nameKey(nameB));

        if (!a || !b) {
          continue;
        }

        const isSelected = Boolean(state.discoveryConstellationId) &&
          String(constellation.id) === String(state.discoveryConstellationId);
          drawConstellationSegment(
            a,
            b,
            date,
            constellation.color || "#91bfff",
            isSelected
          );
        }
      }
    }

    // Repères pédagogiques des balades : tracés colorés superposés à la carte
    // céleste, sans modifier les lignes officielles des constellations.
    const guide = state.discoveryWalkOverlay;
    if (guide && Array.isArray(guide.segments)) {
      const drawGuideSegment = (a, b, dashed = false) => {
        if (!a || !b) return;
        const va = celestialVector(a);
        const vb = celestialVector(b);
        const angle = Math.acos(clamp(va.x * vb.x + va.y * vb.y + va.z * vb.z, -1, 1));
        if (!Number.isFinite(angle) || angle > rad(45)) return;
        const steps = clamp(Math.ceil(angle / rad(1)), 12, 120);
        ctx.save();
        // Clipper au canevas, mais conserver les points projetés hors écran :
        // les rejeter individuellement coupait les segments qui traversent le champ.
        ctx.beginPath();
        ctx.rect(0, 0, state.width, state.height);
        ctx.clip();
        ctx.beginPath();
        ctx.strokeStyle = guide.color || "#ff514d";
        ctx.lineWidth = dashed ? 2.2 : 2.8;
        ctx.globalAlpha = 0.96;
        ctx.lineCap = "round";
        ctx.setLineDash(dashed ? [5, 6] : []);
        let drawing = false;
        let previous = null;
        for (let i = 0; i <= steps; i++) {
          const eq = interpolateStar(a, b, i / steps);
          if (!eq) { drawing = false; previous = null; continue; }
          const horizontal = horizontalPosition(eq.ra, eq.dec, date);
          const point = project(horizontal.az, horizontal.alt, true);
          if (!point) { drawing = false; previous = null; continue; }
          if (!drawing || !previous || Math.hypot(point.x - previous.x, point.y - previous.y) > Math.max(state.width, state.height) * 0.22) {
            ctx.moveTo(point.x, point.y); drawing = true;
          } else ctx.lineTo(point.x, point.y);
          previous = point;
        }
        ctx.stroke();
        ctx.restore();
      };
      for (const segment of guide.segments) {
        const a = byName.get(nameKey(segment.from));
        const b = byName.get(nameKey(segment.to));
        drawGuideSegment(a, b, Boolean(segment.dashed));
      }
      let targetStar = guide.target ? byName.get(nameKey(guide.target)) : null;
      let targetPoint = null;
      if (targetStar) {
        const horizontal = horizontalPosition(Number(targetStar.ra), Number(targetStar.dec), date);
        targetPoint = project(horizontal.az, horizontal.alt);
      } else if (guide.targetObject) {
        const targetObject = [...(state.messier || []), ...(state.ngc || [])].find(object => {
          const values = [object.id, object.name, object.designation, object.common_name, object.commonName].map(value => nameKey(String(value || "")));
          return values.includes(nameKey(guide.targetObject)) || values.some(value => value.includes(nameKey(guide.targetObject)));
        });
        if (targetObject && Number.isFinite(Number(targetObject.ra)) && Number.isFinite(Number(targetObject.dec))) {
          const horizontal = horizontalPosition(Number(targetObject.ra), Number(targetObject.dec), date);
          targetPoint = project(horizontal.az, horizontal.alt);
        }
      }
      if (targetPoint) {
        ctx.save();
        ctx.strokeStyle = guide.color || "#ff514d";
        ctx.fillStyle = guide.color || "#ff514d";
        ctx.lineWidth = 2.4;
        ctx.globalAlpha = 0.98;
        // Petite flèche orientée vers la cible, accompagnée d'un anneau discret.
        const ax = targetPoint.x - 25;
        const ay = targetPoint.y - 25;
        const angle = Math.atan2(targetPoint.y - ay, targetPoint.x - ax);
        ctx.beginPath(); ctx.arc(targetPoint.x, targetPoint.y, 11, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(targetPoint.x - Math.cos(angle) * 13, targetPoint.y - Math.sin(angle) * 13); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(targetPoint.x, targetPoint.y);
        ctx.lineTo(targetPoint.x - 8 * Math.cos(angle - Math.PI / 6), targetPoint.y - 8 * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(targetPoint.x - 8 * Math.cos(angle + Math.PI / 6), targetPoint.y - 8 * Math.sin(angle + Math.PI / 6));
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
    }
  }




function shouldHideDiscoveryMapLabels() {
  const app = document.getElementById("app");
  return Boolean(
    app?.classList.contains("discovery-mode") &&
    state.finderActive && state.skyGuideMode === "free" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 600px)").matches
  );
}

function drawConstellationNames(date) {
  if (shouldHideDiscoveryMapLabels()) return;
  if (
    !state.showConstellations ||
    !state.stars.length ||
    !state.constellations.length
  ) {
    return;
  }

  const byName = new Map();
  const starPoints = [];

  function keyOf(name) {
    if (name == null) return "";
    return nameKey(String(name));
  }

  function register(name, star) {
    const key = keyOf(name);
    if (key && star && !byName.has(key)) {
      byName.set(key, star);
    }
  }

  for (let i = 0; i < state.stars.length; i++) {
    const star = state.stars[i];
    for (const name of [
      star.name,
      star.designation,
      star.proper_name,
      star.properName,
      star.id,
      star.bayer,
      star.flamsteed,
      star.hd,
      star.hip,
      Number.isFinite(Number(star.hip))
        ? `HIP_${Number(star.hip)}`
        : null
    ]) {
      register(name, star);
    }

    // Réutilise les positions déjà calculées pour le rendu de cette frame,
    // au lieu de refaire la conversion équatoriale/horizontale pour chaque étoile.
    const horizontal = horizontalPositionCache.stars[i] || starHorizontalPosition(star, date);

    if (
      Number.isFinite(horizontal.az) &&
      Number.isFinite(horizontal.alt) &&
      horizontal.alt > 0
    ) {
      const point = project(horizontal.az, horizontal.alt);
      if (point) starPoints.push(point);
    }
  }

  // Les rectangles déjà occupés par les noms.
  const occupied = [];

  // Distance minimale entre un nom et une étoile.
  const STAR_PADDING = 13;
  const LABEL_PADDING = 8;

  function overlaps(a, b, padding = 0) {
    return !(
      a.right + padding < b.left ||
      a.left - padding > b.right ||
      a.bottom + padding < b.top ||
      a.top - padding > b.bottom
    );
  }

  function rectangle(x, y, width, height) {
    return {
      left: x - width / 2,
      right: x + width / 2,
      top: y - height / 2,
      bottom: y + height / 2
    };
  }

  // Traiter d'abord les constellations les plus étendues.
  const entries = state.constellations
    .filter(c => Array.isArray(c.lines))
    .map(constellation => {
      const unique = new Map();

      for (const line of constellation.lines) {
        if (!Array.isArray(line)) continue;

        for (const name of line) {
          const star = byName.get(keyOf(name));
          if (star) unique.set(keyOf(name), star);
        }
      }

      const stars = [...unique.values()];

      if (!stars.length) {
        return { constellation, stars, size: 0 };
      }

      const vectors = stars.map(celestialVector);

      const center = vectorToEquatorial(
        vectors.reduce(
          (sum, v) => ({
            x: sum.x + v.x,
            y: sum.y + v.y,
            z: sum.z + v.z
          }),
          { x: 0, y: 0, z: 0 }
        )
      );

      return {
        constellation,
        stars,
        center,
        size: stars.length
      };
    })
    .filter(entry => entry.center)
    .sort((a, b) => b.size - a.size);

  // Positions candidates : centre, puis décalages radiaux.
  const offsets = [
    [0, 0],
    [0, -20],
    [0, 20],
    [-24, 0],
    [24, 0],
    [-20, -20],
    [20, -20],
    [-20, 20],
    [20, 20],
    [0, -38],
    [0, 38],
    [-42, 0],
    [42, 0],
    [-36, -28],
    [36, -28],
    [-36, 28],
    [36, 28]
  ];

  ctx.save();
  ctx.font = "600 11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const entry of entries) {
    const { constellation, center } = entry;

    const label =
      constellation.name ||
      constellation.name_fr ||
      constellation.abbreviation ||
      constellation.id;

    if (!label) continue;

    const horizontal = horizontalPosition(
      center.ra,
      center.dec,
      date
    );

    if (
      !Number.isFinite(horizontal.az) ||
      !Number.isFinite(horizontal.alt) ||
      horizontal.alt <= 0
    ) {
      continue;
    }

    const anchor = project(
      horizontal.az,
      horizontal.alt
    );

    if (!anchor) continue;

    const width = ctx.measureText(label).width + 8;
    const height = 18;

    let best = null;
    let bestScore = Infinity;

    for (let i = 0; i < offsets.length; i++) {
      const [dx, dy] = offsets[i];
      const x = anchor.x + dx;
      const y = anchor.y + dy;

      const box = rectangle(x, y, width, height);

      if (
        box.left < 4 ||
        box.right > state.width - 4 ||
        box.top < 4 ||
        box.bottom > horizonY() - 3
      ) {
        continue;
      }

      let score = i * 2;

      for (const other of occupied) {
        if (overlaps(box, other, LABEL_PADDING)) {
          score += 1000;
        }
      }

      for (const point of starPoints) {
        const nearestX = clamp(
          point.x,
          box.left,
          box.right
        );

        const nearestY = clamp(
          point.y,
          box.top,
          box.bottom
        );

        const distance = Math.hypot(
          point.x - nearestX,
          point.y - nearestY
        );

        if (distance < STAR_PADDING) {
          score += (STAR_PADDING - distance) * 3;
        }
      }

      if (score < bestScore) {
        bestScore = score;
        best = { x, y, box };
      }

      // Une position sans chevauchement est préférable.
      if (score === i * 2) break;
    }

    // Si aucun emplacement ne convient, ne pas encombrer la carte.
    if (!best || bestScore >= 1000) continue;

    occupied.push(best.box);

    const selectedName = Boolean(state.discoveryConstellationId) &&
      String(constellation.id) === String(state.discoveryConstellationId);
    ctx.font = selectedName ? "600 12px system-ui, sans-serif" : "500 11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const labelWidth = ctx.measureText(label).width;
    const labelHeight = selectedName ? 17 : 16;
    ctx.fillStyle = selectedName ? "rgba(31, 27, 17, .88)" : "rgba(3, 9, 22, .66)";
    ctx.beginPath();
    ctx.roundRect(best.x - labelWidth / 2 - 5, best.y - labelHeight / 2 - 2, labelWidth + 10, labelHeight + 4, 5);
    ctx.fill();
    ctx.strokeStyle = selectedName ? "rgba(255, 217, 138, .58)" : "rgba(160, 190, 230, .20)";
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.fillStyle = selectedName ? "#ffe1a0" : (state.discoveryConstellationId ? "rgba(190,202,222,.78)" : "rgba(215,228,250,.96)");
    ctx.fillText(label, best.x, best.y);
  }

  ctx.restore();
}


/* ==========================================================
   ANNOTATIONS DISCRÈTES
   ========================================================== */

function drawLabel(text, point, color = "#dce7fa", prominent = false) {
  if (shouldHideDiscoveryMapLabels()) return;
  if (
    !text ||
    !point ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y)
  ) {
    return;
  }

  const label = String(text).trim();

  if (!label) return;

  ctx.save();

  // Contraste constant sur le fond étoilé et la texture de la Voie lactée.
  const fontSize = prominent ? 12 : 11;

  ctx.font = `${prominent ? 600 : 500} ${fontSize}px system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  const paddingX = 5;
  const paddingY = 3;
  const textWidth = ctx.measureText(label).width;
  const boxWidth = textWidth + paddingX * 2;
  const boxHeight = fontSize + paddingY * 2;
  const gap = 9;

  // Plusieurs positions possibles autour de l'objet.
  const candidates = [
    { x: point.x + gap, y: point.y - boxHeight / 2 },
    { x: point.x - gap - boxWidth, y: point.y - boxHeight / 2 },
    { x: point.x - boxWidth / 2, y: point.y - gap - boxHeight },
    { x: point.x - boxWidth / 2, y: point.y + gap }
  ];

  const margin = 3;
  const occupied = labelBoxes;

  function makeBox(x, y) {
    return {
      left: x,
      right: x + boxWidth,
      top: y,
      bottom: y + boxHeight
    };
  }

  function overlaps(a, b, padding = 3) {
    return !(
      a.right + padding <= b.left ||
      a.left >= b.right + padding ||
      a.bottom + padding <= b.top ||
      a.top >= b.bottom + padding
    );
  }

  let chosen = null;

  for (const candidate of candidates) {
    const box = makeBox(candidate.x, candidate.y);

    if (
      box.left < margin ||
      box.right > state.width - margin ||
      box.top < margin ||
      box.bottom > horizonY() - margin
    ) {
      continue;
    }

    if (occupied.some(other => overlaps(box, other))) {
      continue;
    }

    chosen = { ...candidate, box };
    break;
  }

  // Ne pas encombrer l'image si aucun emplacement ne convient.
  if (!chosen) {
    ctx.restore();
    return;
  }

  occupied.push(chosen.box);

  // Fond arrondi très discret pour stabiliser le contraste sur toute la carte.
  ctx.fillStyle = prominent ? "rgba(5, 12, 27, .88)" : "rgba(5, 12, 27, .72)";
  ctx.beginPath();
  ctx.roundRect(chosen.x - 1, chosen.y - 1, boxWidth + 2, boxHeight + 2, 5);
  ctx.fill();
  ctx.strokeStyle = "rgba(168, 195, 232, .20)";
  ctx.lineWidth = 0.8;
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.fillText(label, chosen.x + paddingX, chosen.y + boxHeight / 2);

  ctx.restore();
}

  /* ==========================================================
     DESSIN DES OBJETS
     ========================================================== */

  function drawLabel(name, point, color = "#c8d7f4", prominent = false) {
  if (shouldHideDiscoveryMapLabels() || !name || !point) return;

  const label = String(name).trim();
  if (!label) return;

  ctx.save();

  ctx.font = prominent
    ? "600 12px system-ui, sans-serif"
    : "500 11px system-ui, sans-serif";

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  const padding = 5;
  const width = ctx.measureText(label).width + padding * 2;
  const height = 17;

  // Position privilégiée : à droite et légèrement au-dessus.
  const candidates = [
    [9, -8],
    [9, 10],
    [-width - 5, -8],
    [-width - 5, 10]
  ];

  for (const [dx, dy] of candidates) {
    const x = point.x + dx;
    const y = point.y + dy;

    const left = dx < 0 ? x : x - padding;
    const box = {
      left,
      right: left + width,
      top: y - height / 2,
      bottom: y + height / 2
    };

    if (
      box.left < 3 ||
      box.right > state.width - 3 ||
      box.top < 3 ||
      box.bottom > horizonY() - 2
    ) {
      continue;
    }

    const collision = labelBoxes.some(other =>
      !(
        box.right + 5 < other.left ||
        box.left - 5 > other.right ||
        box.bottom + 3 < other.top ||
        box.top - 3 > other.bottom
      )
    );

    if (collision) continue;

    labelBoxes.push(box);

    // Fond arrondi discret : le texte reste lisible sans masquer le ciel.
    ctx.fillStyle = prominent ? "rgba(5, 12, 27, .88)" : "rgba(5, 12, 27, .72)";
    ctx.beginPath();
    ctx.roundRect(left - 1, y - height / 2, width + 2, height, 5);
    ctx.fill();
    ctx.strokeStyle = prominent ? "rgba(255, 217, 138, .42)" : "rgba(168, 195, 232, .20)";
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(label, x, y);

    ctx.restore();
    return;
  }

  // Si aucun emplacement n'est disponible, omettre le nom.
  ctx.restore();
}

  function drawMoonPhase(point, radius, phaseAngle, illumination) {
    const phase = Number.isFinite(phaseAngle)
      ? ((phaseAngle % 360) + 360) % 360
      : 0;
    const waxing = phase <= 180;
    const phaseCosine = Math.cos(rad(phase));
    // À la phase décroissante, la zone éclairée est à gauche : on inverse
    // le côté du terminateur pour que la gibbeuse décroissante reste majoritairement claire.
    const terminator = waxing ? phaseCosine : -phaseCosine;
    const x = point.x;
    const y = point.y;

    ctx.save();

    // Le disque sombre reste discret à la nouvelle Lune ; la partie éclairée
    // progresse ensuite en croissant, quartier, gibbeuse, pleine Lune, puis décroît.
    ctx.shadowColor = "rgba(190, 215, 255, .35)";
    ctx.shadowBlur = 5 + 5 * illumination;
    ctx.fillStyle = "#17243a";
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;

    if (illumination > 0.012) {
      ctx.beginPath();
      ctx.moveTo(x, y - radius);
      if (waxing) {
        // Bord éclairé à droite pendant la phase croissante.
        ctx.arc(x, y, radius, -Math.PI / 2, Math.PI / 2, false);
      } else {
        // Bord éclairé à gauche pendant la phase décroissante.
        ctx.arc(x, y, radius, -Math.PI / 2, -3 * Math.PI / 2, true);
      }
      // Le terminateur passe du bord éclairé au bord ombré. Une ellipse donne
      // une transition correcte entre le croissant (limbe presque confondu),
      // le quartier (ligne centrale) et la gibbeuse / pleine Lune.
      if (Math.abs(terminator) < 0.001) {
        ctx.lineTo(x, y - radius);
      } else if (terminator > 0) {
        ctx.ellipse(x, y, radius * terminator, radius, 0, Math.PI / 2, -Math.PI / 2, true);
      } else {
        ctx.ellipse(x, y, -radius * terminator, radius, 0, Math.PI / 2, 3 * Math.PI / 2, false);
      }
      ctx.closePath();
      ctx.fillStyle = "#e8efff";
      ctx.shadowColor = "rgba(210, 228, 255, .65)";
      ctx.shadowBlur = 2 + 4 * illumination;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    ctx.strokeStyle = `rgba(218, 231, 255, ${0.22 + illumination * 0.5})`;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  function drawSolarObject(object, point) {
    const colors = {
      Soleil: "#ffdb91",
      Lune: "#e8efff",
      Mercure: "#d2c3ad",
      Vénus: "#ffe3ad",
      Mars: "#f19a81",
      Jupiter: "#efc99e",
      Saturne: "#dfd3aa",
      Uranus: "#9bd9e8",
      Neptune: "#729dff"
    };

    const color = colors[object.name] || "#e9d7b3";

    if (object.type === "moon") {
      const phaseAngle = skyMoonCache?.phaseAngle;
      const illumination = skyMoonCache?.illumination || 0;
      drawMoonPhase(point, 7.4, phaseAngle, illumination);
      drawLabel(object.name, point, color, true);
      return;
    }

    const radius = object.type === "sun" ? 8.2 : 3.5;

    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = object.type === "sun" ? 24 : 10;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, TAU);
    ctx.fill();
    ctx.restore();

    drawLabel(object.name, point, color, true);
  }

  function drawDeepSkyObject(object, point) {
    const color = object.type === "galaxy"
      ? "#a8caff"
      : object.type === "nebula"
        ? "#c0a9ff"
        : "#91d7d9";

    ctx.save();

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.arc(point.x, point.y, 4, 0, TAU);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(point.x - 5, point.y);
    ctx.lineTo(point.x + 5, point.y);
    ctx.moveTo(point.x, point.y - 5);
    ctx.lineTo(point.x, point.y + 5);
    ctx.stroke();

    ctx.restore();

    drawLabel(
      object.catalogue === "NGC"
        ? (object.name || object.id)
        : (object.id || object.name),
      point,
      color
    );
  }

  /* ==========================================================
     SÉLECTION DES OBJETS
     ========================================================== */

  /* ----------------------------------------------------------
     CAP PAR DÉFAUT : vers le Soleil de (lever − 15 min) à (coucher + 15 min),
     plein Nord le reste du temps. Appliqué au démarrage et quand l'utilisateur
     change la date, l'heure ou le lieu ; jamais par-dessus un cap qu'il a lui-même
     réglé (glissement, guidage, capteurs).
     ---------------------------------------------------------- */
  const AUTO_HEADING_MARGIN_MS = 15 * 60 * 1000;
  // Altitude apparente (réfraction incluse, comme dans solarObjectsAt) du centre du Soleil
  // à l'instant exact du lever ou du coucher : ≈ -0,22° (mesuré avec Astronomy Engine).
  const SUN_RISE_SET_ALTITUDE = -0.22;
  let lastAutoHeading = null;
  function defaultSkyHeading(date) {
    const sunAt = at => {
      try { return solarObjectsAt(at).find(item => item && (item.type === "sun" || item.name === t("ui.sun"))) || null; }
      catch { return null; }
    };
    const now = sunAt(date);
    if (!now || !Number.isFinite(now.az) || !Number.isFinite(now.alt)) return 0;
    const before = sunAt(new Date(date.getTime() - AUTO_HEADING_MARGIN_MS));
    const after = sunAt(new Date(date.getTime() + AUTO_HEADING_MARGIN_MS));
    // « 15 min après le coucher » : le Soleil était levé il y a 15 min.
    // « 15 min avant le lever » : il le sera dans 15 min.
    const daylight = [now, before, after].some(sun => sun && Number.isFinite(sun.alt) && sun.alt > SUN_RISE_SET_ALTITUDE);
    return daylight ? norm360(now.az) : 0;
  }
  function refreshAutoHeading() {
    if (state.sensorActive) return;
    const untouched = lastAutoHeading === null || Math.abs(norm180(state.heading - lastAutoHeading)) < 1e-6;
    if (!untouched) return;
    const heading = defaultSkyHeading(state.observationDate || new Date());
    state.heading = heading;
    lastAutoHeading = heading;
  }

  /* ----------------------------------------------------------
     COMÈTES : tête (coma) + queue de gaz + queue de poussière.
     La queue est toujours dirigée à l'opposé du Soleil (vent solaire) ;
     sa longueur à l'écran est symbolique et croît quand la comète
     s'approche du Soleil (distance héliocentrique en UA).
     ---------------------------------------------------------- */
  let cometSunCache = { second: -1, sun: null };
  function currentSunHorizontal() {
    const date = state.observationDate || new Date();
    const second = Math.floor(date.getTime() / 1000);
    if (cometSunCache.second !== second) {
      let sun = null;
      try { sun = solarObjectsAt(date).find(item => item && (item.type === "sun" || item.name === t("ui.sun"))) || null; } catch { sun = null; }
      cometSunCache = { second, sun };
    }
    return cometSunCache.sun;
  }

  // Direction (vecteur unitaire à l'écran) qui s'éloigne du Soleil, mesurée le long
  // du grand cercle Soleil -> comète pour rester juste quelle que soit la projection.
  function cometTailDirection(object, point) {
    const fallback = { x: 0.6, y: -0.8 };
    const sun = currentSunHorizontal();
    if (!sun || !Number.isFinite(sun.az) || !Number.isFinite(sun.alt)) return fallback;
    const D = Math.PI / 180;
    const vec = (az, alt) => [Math.cos(alt * D) * Math.sin(az * D), Math.cos(alt * D) * Math.cos(az * D), Math.sin(alt * D)];
    const c = vec(object.az, object.alt);
    const sv = vec(sun.az, sun.alt);
    const dot = c[0] * sv[0] + c[1] * sv[1] + c[2] * sv[2];
    const t = [dot * c[0] - sv[0], dot * c[1] - sv[1], dot * c[2] - sv[2]];
    const norm = Math.hypot(t[0], t[1], t[2]);
    if (!(norm > 1e-6)) return fallback;
    const eps = 0.8 * D;
    const p = [c[0] + eps * t[0] / norm, c[1] + eps * t[1] / norm, c[2] + eps * t[2] / norm];
    const pn = Math.hypot(p[0], p[1], p[2]);
    const az2 = Math.atan2(p[0], p[1]) / D;
    const alt2 = Math.asin(Math.max(-1, Math.min(1, p[2] / pn))) / D;
    const q = projectDirectionToScreen(az2, alt2);
    if (!q) return fallback;
    const vx = q.x - point.x;
    const vy = q.y - point.y;
    const len = Math.hypot(vx, vy);
    return len > 1e-6 ? { x: vx / len, y: vy / len } : fallback;
  }

  function drawCometObject(object, point) {
    const rHelio = Number(object.heliocentricDistanceAU);
    // Activité : nulle au-delà de ~3,5 UA du Soleil (la glace ne sublime plus), maximale près du Soleil.
    const activity = Number.isFinite(rHelio) ? Math.min(1, Math.max(0, (3.5 - rHelio) / 3.5)) : 0.3;
    const dir = cometTailDirection(object, point);
    const nx = -dir.y;
    const ny = dir.x;
    const maxLength = Math.min(state.width, state.height) * 0.2;
    const length = Math.min(maxLength, 16 + 46 * Math.pow(activity, 0.8));
    const fade = 0.5 + 0.5 * activity;
    const hx = point.x;
    const hy = point.y;
    const at = (along, side) => ({ x: hx + dir.x * along + nx * side, y: hy + dir.y * along + ny * side });
    ctx.save();
    ctx.lineJoin = "round";

    // Queue de poussière : bande courbe, jaune pâle, qui part de la tête et s'effile.
    const dustTip = at(length * 0.95, length * 0.22);
    const dustGradient = ctx.createLinearGradient(hx, hy, dustTip.x, dustTip.y);
    dustGradient.addColorStop(0, `rgba(255, 232, 186, ${0.6 * fade})`);
    dustGradient.addColorStop(0.5, `rgba(255, 216, 152, ${0.26 * fade})`);
    dustGradient.addColorStop(1, "rgba(255, 210, 140, 0)");
    const dustHalfWidth = 3 + 5 * activity;
    const dustMid = at(length * 0.5, length * 0.07);
    const bend = (t, side) => {
      const u = 1 - t;
      const cx = u * u * hx + 2 * u * t * dustMid.x + t * t * dustTip.x;
      const cy = u * u * hy + 2 * u * t * dustMid.y + t * t * dustTip.y;
      const w = dustHalfWidth * Math.pow(u, 0.9) * side;
      return { x: cx + nx * w, y: cy + ny * w };
    };
    ctx.fillStyle = dustGradient;
    ctx.beginPath();
    for (let i = 0; i <= 14; i++) {
      const q = bend(i / 14, 1);
      if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
    }
    for (let i = 14; i >= 0; i--) {
      const q = bend(i / 14, -0.5);
      ctx.lineTo(q.x, q.y);
    }
    ctx.closePath();
    ctx.fill();

    // Queue de gaz (ionique) : fine, rectiligne, bleutée.
    const ionLength = length * 1.1;
    const ionTip = at(ionLength, 0);
    const ionGradient = ctx.createLinearGradient(hx, hy, ionTip.x, ionTip.y);
    ionGradient.addColorStop(0, `rgba(170, 224, 255, ${0.85 * fade})`);
    ionGradient.addColorStop(0.6, `rgba(120, 190, 255, ${0.3 * fade})`);
    ionGradient.addColorStop(1, "rgba(110, 180, 255, 0)");
    const ionWidth = 1.2 + 1.3 * activity;
    const ionA = at(0, ionWidth);
    const ionB = at(0, -ionWidth);
    ctx.fillStyle = ionGradient;
    ctx.beginPath();
    ctx.moveTo(ionA.x, ionA.y);
    ctx.lineTo(ionTip.x, ionTip.y);
    ctx.lineTo(ionB.x, ionB.y);
    ctx.closePath();
    ctx.fill();

    // Tête : halo diffus (coma) puis noyau brillant.
    const comaRadius = 6 + 3 * activity;
    const coma = ctx.createRadialGradient(hx, hy, 0, hx, hy, comaRadius);
    coma.addColorStop(0, "rgba(255, 255, 255, 0.95)");
    coma.addColorStop(0.25, "rgba(214, 240, 255, 0.7)");
    coma.addColorStop(1, "rgba(150, 205, 255, 0)");
    ctx.fillStyle = coma;
    ctx.beginPath();
    ctx.arc(hx, hy, comaRadius, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(hx, hy, 1.5, 0, TAU);
    ctx.fill();
    ctx.restore();

    drawLabel(object.name || object.proper_name || object.designation || t("ui.comet"), point, "#bfe6ff");
  }

  function drawMinorPlanetObject(object, point) {
    if (object.type === "comet") { drawCometObject(object, point); return; }
    const color = "#e8c27f";
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.25;
    ctx.shadowColor = "rgba(232,194,127,.45)";
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 3.6, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(point.x, point.y, 1.05, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(point.x - 5.4, point.y); ctx.lineTo(point.x - 3.8, point.y);
    ctx.moveTo(point.x + 3.8, point.y); ctx.lineTo(point.x + 5.4, point.y);
    ctx.moveTo(point.x, point.y - 5.4); ctx.lineTo(point.x, point.y - 3.8);
    ctx.moveTo(point.x, point.y + 3.8); ctx.lineTo(point.x, point.y + 5.4);
    ctx.stroke();
    ctx.restore();
    const mapLabel = object.dwarfPlanet ? (object.name || object.proper_name || t("ui.dwarfPlanet")) : `${object.id ? `${object.id} ` : ""}${object.name || object.designation || t("ui.minorPlanet")}`;
    drawLabel(mapLabel, point, color);
  }

  function selectedPosition(date = (state.observationDate || new Date())) {
    if (!state.selected) {
      return null;
    }

    const object = state.selected;

    if (["planet", "sun", "moon"].includes(object.type)) {
      const current = solarObjectsAt(date)
        .find(item => item.name === object.name);
      if (current) return { ...object, ...current };
    }
    if (object.type === "minor-planet" || object.type === "dwarf-planet" || object.type === "comet") {
      const current = calculateMinorPlanetPosition(
        object, date, state.latitude, state.longitude, state.minorPlanetsEpochJD
      );
      if (current) return { ...object, ...current };
    }

    // Garder la position de l’étoile sélectionnée cohérente avec le rendu du ciel.
    if (object.type === "star") {
      const horizontal = starHorizontalPosition(object, date);
      return {
        ...object,
        ...horizontal
      };
    }

    if (
      Number.isFinite(object.ra) &&
      Number.isFinite(object.dec)
    ) {
      const horizontal = horizontalPosition(
        object.ra,
        object.dec,
        date
      );

      return {
        ...object,
        ...horizontal
      };
    }

    /*
     * Les objets du système solaire peuvent ne pas posséder
     * de coordonnées équatoriales dans leur objet sélectionné.
     */
    return object;
  }

  function handleCanvasTap(event) {
    const rect = canvas.getBoundingClientRect();

    if (!rect.width || !rect.height) {
      return;
    }

    const scaleX = state.width / rect.width;
    const scaleY = state.height / rect.height;

    const x = (event.clientX - rect.left) * scaleX;
    const y = (event.clientY - rect.top) * scaleY;

    let closest = null;
    let bestDistance =
      24 * Math.max(scaleX, scaleY);

    for (const object of state.visibleObjects) {
      const distance = Math.hypot(
        x - object.screenX,
        y - object.screenY
      );

      if (distance < bestDistance) {
        closest = object;
        bestDistance = distance;
      }
    }

    if (!closest) {
      state.selected = null;

      const card = $("object-card");

      if (card) {
        card.hidden = true;
      }

      drawSky();
      return;
    }

    state.finderLocked = false;
    state.finderLockSince = 0;

    state.selected = {
      ...closest,
      name: closest.type === "star"
        ? displayStarName(closest)
        : closest.name
    };

    ui.updateObjectCard(state.selected);

    const card = $("object-card");

    if (card) {
      card.hidden = false;
    }

    drawSky();
  }

  /* ==========================================================
     MODE CHERCHEUR
     ========================================================== */



function freeModeObjectLabel(object) {
  if (!object) return "";
  if (object.type === "star") return displayStarName(object) || "";
  return object.common_name || object.commonName || object.proper_name || object.properName || object.name || object.designation || "";
}

function findConstellationForGuideObject(object) {
  if (!object || object.type !== "star" || !Array.isArray(state.constellations)) return "";
  const ids = new Set([
    String(object.id || ""),
    object.hip != null ? `HIP_${object.hip}` : "",
    object.hip != null ? `HIP ${object.hip}` : ""
  ].filter(Boolean).map(value => nameKey(value)));
  for (const constellation of state.constellations) {
    if (!Array.isArray(constellation.lines)) continue;
    if (constellation.lines.some(line => Array.isArray(line) && line.some(name => ids.has(nameKey(name))))) {
      return String(constellation.id || "");
    }
  }
  return "";
}

function findFreeModeTarget() {
  const pxPerTangent = (canvas.clientWidth / 2) / Math.tan(rad(Math.max(1, Number(state.fov) || 60) / 2));
  const angularDistance = object => {
    const distance = Math.hypot(object.screenX - state.width / 2, object.screenY - state.height / 2);
    return deg(Math.atan2(distance, pxPerTangent));
  };
  const candidates = (state.visibleObjects || [])
    .filter(object => Number.isFinite(object.screenX) && Number.isFinite(object.screenY))
    .map(object => ({ object, angle: angularDistance(object), label: freeModeObjectLabel(object) }))
    .filter(item => Number.isFinite(item.angle) && item.angle <= 12);

  // Conserver la cible courante tant qu'elle reste dans le champ de découverte :
  // cela évite que le nom et la constellation sautent entre deux étoiles voisines.
  const current = candidates.find(item => String(item.object.id || item.object.name) === state.skyGuideFreeTargetId && item.angle <= 14);
  if (current) return { ...current.object, _freeGuideLabel: current.label, _freeGuideDistance: current.angle };

  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const namedBiasA = a.label ? 0 : 3;
    const namedBiasB = b.label ? 0 : 3;
    return (a.angle + namedBiasA) - (b.angle + namedBiasB);
  });
  const best = candidates[0];
  state.skyGuideFreeTargetId = String(best.object.id || best.object.name || "");
  return { ...best.object, _freeGuideLabel: best.label, _freeGuideDistance: best.angle };
}

function skyGuideCommonName(target) {
  if (!target) return "";
  const explicit = target.common_name || target.commonName || target.common_name_fr ||
    target.commonNameFr || target.proper_name || target.properName;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  if (target.type === "star") return displayStarName(target);
  if (["planet", "sun", "moon"].includes(target.type)) {
    const name = String(target.name || "").trim();
    return name && !/^(M\d+|NGC\s?\d+|HIP[_\s-]*\d+|HD\s?\d+)$/i.test(name) ? name : "";
  }
  return "";
}

function updateSkyGuide(target, camera, distance, nx, ny, message = "") {
  const panel = $("sky-guide");
  if (!panel || panel.hidden) return;
  const name = $("sky-guide-name");
  const commonNameLabel = $("sky-guide-common-name");
  const marker = $("sky-guide-target");
  const status = $("sky-guide-status");
  const progress = $("sky-guide-progress");
  const eyebrow = $("sky-guide-eyebrow");
  const modeToggle = $("sky-guide-mode-toggle");
  const freeMode = state.skyGuideMode === "free";
  if (eyebrow) eyebrow.textContent = freeMode ? t("ui.freeMode") : t("ui.celestialGuidance");
  if (modeToggle) modeToggle.textContent = freeMode ? t("ui.targetedGuidance") : t("ui.freeMode");
  if (name) name.textContent = freeMode
    ? (target?._freeGuideLabel || (target?.type === "star" ? t("ui.starInField") : target?.name || target?.id) || t("ui.scanSkyGentlyShort"))
    : (target?.name || target?.id || "Cible");
  const commonName = skyGuideCommonName(target);
  if (commonNameLabel) {
    commonNameLabel.textContent = commonName;
    // En découverte, ne pas dévoiler immédiatement le nom : il apparaît
    // quand l’objet entre dans le cercle intermédiaire (6°), étape pédagogique.
    commonNameLabel.hidden = !(commonName && freeMode);
    commonNameLabel.setAttribute("aria-label", commonName ? `Nom usuel : ${commonName}` : "");
  }

  // Dimensionner les cercles dès l'ouverture du mode libre, même avant
  // qu'un objet soit détecté. Sinon ils gardent une taille nulle au premier
  // lancement et les marqueurs rouges semblent absents.
  const fov = Math.max(1, Number(state.fov) || 60);
  const pxPerTangent = (canvas.clientWidth / 2) / Math.tan(rad(fov / 2));
  const ringAngles = [12, 6, 2];
  const ringRadii = ringAngles.map(angle =>
    Math.max(12, 2 * Math.tan(rad(angle)) * pxPerTangent) / 2
  );
  ringRadii.forEach((radius, i) => {
    const ring = panel.querySelector(`[data-guide-ring="${i}"]`);
    if (!ring) return;
    ring.style.width = `${radius * 2}px`;
    ring.style.height = `${radius * 2}px`;
  });

  // En mode libre, aucun objet dans le champ de découverte : laisser le réticule
  // visible et rouge, sans conserver le marqueur de la cible précédente.
  if (!target && freeMode) {
    if (marker) { marker.style.left = "0px"; marker.style.top = "0px"; marker.classList.add("outside"); }
    panel.querySelectorAll("[data-guide-ring]").forEach(ring => ring.classList.remove("acquired"));
    state.skyGuideProgress = 0;
    if (progress) progress.textContent = t("ui.circlesAcquired");
    if (status) status.textContent = message || t("ui.scanSkyGently");
    return;
  }

  // Coordonnées CSS du pointeur par rapport au centre du réticule.
  // Le même décalage sert à l'affichage du pointeur et à l'acquisition des cercles.
  let screenOffsetX = NaN;
  let screenOffsetY = NaN;
  if (marker && camera && camera.z > 0 && Number.isFinite(camera.x) && Number.isFinite(camera.y)) {
    // Reprendre exactement la projection caméra utilisée pour dessiner les
    // objets de la carte. Le centre du guidage est l'axe optique : aucun décalage
    // artificiel lié à horizonRatio ne doit être ajouté au marqueur de cible.
    const projectedTarget = projectDirectionToScreen(target.az, target.alt);
    if (projectedTarget) {
      screenOffsetX = projectedTarget.x - state.width / 2;
      screenOffsetY = projectedTarget.y - state.height / 2;
    }
    marker.style.left = `${clamp(screenOffsetX, -state.width * 0.675, state.width * 0.675)}px`;
    marker.style.top = `${clamp(screenOffsetY, -state.height * 0.675, state.height * 0.675)}px`;
    marker.classList.toggle("outside", Math.abs(screenOffsetX) > state.width / 2 || Math.abs(screenOffsetY) > state.height / 2);
  } else if (marker) {
    marker.style.left = "0px";
    marker.style.top = "0px";
    marker.classList.add("outside");
  }
  if (commonNameLabel && marker) {
    commonNameLabel.style.left = marker.style.left || "0px";
    commonNameLabel.style.top = marker.style.top || "0px";
  }

  // L'état des cercles décrit la position actuelle de la cible, pas un record
  // historique : un cercle redevient rouge dès que la cible en ressort.
  let acquiredCount = 0;
  let screenDistance = NaN;
  if (Number.isFinite(screenOffsetX) && Number.isFinite(screenOffsetY)) {
    screenDistance = Math.hypot(screenOffsetX, screenOffsetY);
    distance = deg(Math.atan2(screenDistance, pxPerTangent));
  }

  ringAngles.forEach((angle, i) => {
    const ring = panel.querySelector(`[data-guide-ring="${i}"]`);
    if (!ring) return;
    const diameter = ringRadii[i] * 2;
    ring.style.width = `${diameter}px`;
    ring.style.height = `${diameter}px`;
    const acquired = Number.isFinite(screenDistance) && screenDistance <= ringRadii[i];
    ring.classList.toggle("acquired", acquired);
    if (acquired) acquiredCount++;
  });
  state.skyGuideProgress = acquiredCount;
  if (commonNameLabel) commonNameLabel.hidden = !(commonName && freeMode && acquiredCount >= 2);
  if (progress) progress.textContent = `${state.skyGuideProgress} / 3 cercles acquis`;
  if (status) status.textContent = message || (state.skyGuideProgress >= 3
    ? t("ui.objectSpottedThreeCircles")
    : Number.isFinite(distance) ? `${t("ui.deviationFromCenter")}: ${distance.toFixed(1).replace(".", ",")}° · ${t("ui.gentlyPointPhone")}`
    : t("ui.activateCompassAndCheckPermissions"));
}

function updateFinder(date = new Date()) {
  if (!state.finderActive) {
    return;
  }

  const target = state.skyGuideMode === "free"
    ? findFreeModeTarget()
    : selectedPosition(date);

  const finderName = $("finder-name");
  const horizontal = $("finder-horizontal");
  const vertical = $("finder-vertical");
  const marker = $("finder-marker");
  const instruction = $("finder-instruction");
  const sensor = $("finder-sensor");

  if (finderName) {
    finderName.textContent =
      target?.name || target?.id || "Cible";
  }

  function resetLock() {
    state.finderLocked = false;
    state.finderLockSince = 0;
  }

  function resetMarker() {
    if (!marker) {
      return;
    }

    marker.style.left = "50%";
    marker.style.top = "50%";
    marker.classList.remove("locked", "outside");
  }

  function showUnavailable(message) {
    resetLock();

    if (horizontal) horizontal.textContent = "—";
    if (vertical) vertical.textContent = "—";
    if (instruction) instruction.textContent = message;

    resetMarker();
  }

  // En mode libre, l'absence de cible est normale : on attend qu'un objet
  // entre dans le champ central de découverte.
  if (!target && state.skyGuideMode === "free") {
    updateSkyGuide(null, null, NaN, NaN, NaN, t("ui.scanSkyGently"));
    if (horizontal) horizontal.textContent = "—";
    if (vertical) vertical.textContent = "—";
    if (instruction) instruction.textContent = t("ui.freeModeInstruction");
    if (sensor) sensor.textContent = t("ui.noObjectInField");
    return;
  }

  // 1. Vérifier que la cible possède une position exploitable.
  if (
    !target ||
    !Number.isFinite(target.az) ||
    !Number.isFinite(target.alt)
  ) {
    showUnavailable("Position de la cible indisponible.");

    if (sensor) {
      sensor.textContent =
        t("ui.selectObjectWithKnownPosition");
    }

    return;
  }

  // 2. Une cible sous l'horizon ne peut pas être visée.
  if (target.alt <= 0) {
    showUnavailable("Cette cible est sous l'horizon.");

    if (sensor) {
      sensor.textContent =
        `Altitude de la cible : ${target.alt.toFixed(1)}°.`;
    }

    return;
  }

  // 3. Vérifier que les données des capteurs sont récentes.
  const now = Date.now();
  const headingFresh =
    state.sensorActive &&
    state.orientationListening &&
    Number.isFinite(state.lastOrientationTime) &&
    now - state.lastOrientationTime < 2500;
  const pitchFresh =
    Number.isFinite(state.lastPitchTime) &&
    now - state.lastPitchTime < 2500;
  const fresh = headingFresh && pitchFresh;

  if (!fresh) {
    showUnavailable(
      t("ui.activateCompassAndCheckPermissionsShort")
    );

    if (sensor) {
      sensor.textContent = !headingFresh
        ? t("ui.guidanceSuspendedNoReliableHeading")
        : t("ui.guidanceSuspendedNoReliablePitch");
    }

    return;
  }

  // 4. Calculer la position de la cible par rapport au téléphone.
  const camera = cameraCoordinates(target.az, target.alt);

  // L'écart d'azimut doit rester indépendant de l'inclinaison du téléphone.
  // Le calcul via camera.x / camera.z mélangeait azimut et altitude : en
  // levant ou abaissant le téléphone, l'indication gauche/droite pouvait
  // dériver alors que le cap horizontal n'avait pas changé.
  const horizontalError = norm180(target.az - state.heading);

  const verticalError =
    deg(
      Math.atan2(
        camera.y,
        Math.hypot(camera.x, camera.z)
      )
    );

  const distance =
    deg(Math.acos(clamp(camera.z, -1, 1)));
  const guideNx = camera.z > 0 ? camera.x / camera.z / Math.tan(rad(state.fov) / 2) : NaN;
  const guideNy = camera.z > 0 ? camera.y / camera.z / Math.tan(rad(state.verticalFov) / 2) : NaN;
  if (state.skyGuideMode === "free") {
    const constellationId = findConstellationForGuideObject(target);
    if (constellationId !== state.discoveryConstellationId || !state.showConstellations) {
      state.discoveryConstellationId = constellationId;
      state.showConstellations = Boolean(constellationId) || Boolean(state.skyGuideSavedConstellations?.showConstellations);
    }
  }
  updateSkyGuide(target, camera, distance, guideNx, guideNy);

  // 5. Si la cible est derrière le téléphone, supprimer le verrou.
  if (camera.z <= 0) {
    resetLock();

    if (horizontal) {
      horizontal.textContent =
        `${horizontalError >= 0 ? "Droite" : "Gauche"} · demi-tour`;
    }

    if (vertical) {
      vertical.textContent = t("ui.behind");
    }

    if (instruction) {
      instruction.textContent =
        t("ui.targetIsBehindYou");
    }

    resetMarker();

    if (sensor) {
      sensor.textContent =
        `${t("ui.angularDeviation")}: ${distance.toFixed(1).replace(".", ",")}° · ` +
        `cap ${Math.round(norm360(state.heading))}°`;
    }

    return;
  }

  // 6. Verrouillage avec hystérésis et délai de confirmation.
  // Réutilise `now`, déclaré plus haut dans cette fonction.

  if (state.finderLocked) {
    // Une petite variation des capteurs ne déverrouille pas la cible.
    if (distance > FINDER_LOCK_EXIT) {
      resetLock();
    }
  } else if (distance < FINDER_LOCK_ENTER) {
    // Démarrer le délai lorsque la cible entre dans la zone précise.
    if (state.finderLockSince === 0) {
      state.finderLockSince = now;
    }

    // Confirmer le verrouillage après une stabilité suffisante.
    if (
      now - state.finderLockSince >= FINDER_LOCK_DELAY
    ) {
      state.finderLocked = true;
    }
  } else {
    // Hors de la zone d'entrée : recommencer le délai.
    state.finderLockSince = 0;
  }

  const locked = state.finderLocked;

  // 7. Instructions horizontales.
  if (horizontal) {
    horizontal.textContent =
      Math.abs(horizontalError) < 0.5
        ? t("ui.centered")
        : `${horizontalError > 0 ? "Droite" : "Gauche"} ` +
          `${Math.abs(horizontalError).toFixed(1)}°`;
  }

  // 8. Instructions verticales.
  if (vertical) {
    vertical.textContent =
      Math.abs(verticalError) < 0.5
        ? t("ui.centered")
        : `${verticalError > 0 ? "Monter" : "Descendre"} ` +
          `${Math.abs(verticalError).toFixed(1)}°`;
  }

  // 9. Calculer la position visuelle du marqueur.
  const nx =
    camera.x / camera.z /
    Math.tan(rad(state.fov) / 2);

  const ny =
    camera.y / camera.z /
    Math.tan(rad(state.verticalFov) / 2);

  const insideField =
    Math.abs(nx) <= 1 &&
    Math.abs(ny) <= 1;

  if (marker) {
    // nx = ±1 correspond aux bords du champ horizontal calculé.
    // Utiliser 50 % par unité (au lieu de 40 %) évite de comprimer
    // le déplacement horizontal du pointeur. La marge de 4 % garde
    // le marqueur visible lorsque la cible sort du champ.
    marker.style.left =
      `${50 + clamp(nx, -0.92, 0.92) * 50}%`;

    // Conserver la projection verticale existante, déjà validée sur l'appareil.
    marker.style.top =
      `${50 - clamp(ny, -1.2, 1.2) * 40}%`;

    marker.classList.toggle("locked", locked);
    marker.classList.toggle("outside", !insideField);
  }

  // 10. Message de guidage.
  if (instruction) {
    if (locked) {
      instruction.textContent =
        t("ui.targetLockedKeepPhoneStable");
    } else if (!insideField) {
      instruction.textContent =
        "La cible est hors du champ. Suis les indications pour la retrouver.";
    } else {
      instruction.textContent =
        t("ui.movePhoneGentlyToCenterTarget");
    }
  }

  // 11. Informations de diagnostic.
  if (sensor) {
    sensor.textContent =
      `Cap ${Math.round(norm360(state.heading))}° · ` +
      `${t("ui.pitch")}: ${state.pitch.toFixed(1).replace(".", ",")}° · ` +
      `${t("ui.deviation")} ${distance.toFixed(1).replace(".", ",")}°`;
  }
}


    function enterFinder(options = {}) {
      const startFree = options?.free === true;
      if (!state.selected && !startFree) {
        ui.showToast(t("ui.selectObjectOnMapFirst"));
        return;
      }
      state.finderLocked = false;
      state.finderLockSince = 0;
      state.skyGuideMode = startFree ? "free" : "targeted";
      state.skyGuideFreeTargetId = "";
      state.skyGuideSavedSelection = null;
      state.skyGuideSavedConstellations = startFree ? {
        showConstellations: state.showConstellations,
        discoveryConstellationId: state.discoveryConstellationId
      } : null;
      if (startFree) state.selected = null;
      state.skyGuideProgress = 0;
      state.finderActive = true;
      const panel = $("sky-guide");
      const card = $("object-card");
      if (panel) panel.hidden = false;
      // Sur mobile, replier le menu Découverte pour dégager le message de guidage.
      ui?.collapseDiscoveryMenuForGuidance?.();
      if (card) card.hidden = true;
      updateSkyGuide(startFree ? null : selectedPosition(state.observationDate || new Date()), null, NaN, NaN, NaN,
        startFree ? t("ui.scanSkyGently") : t("ui.activateCompassAndPointToTarget"));
      updateFinder();
    }

function toggleSkyGuideMode() {
  if (!state.finderActive) return;
  if (state.skyGuideMode !== "free") {
    state.skyGuideSavedSelection = state.selected ? { ...state.selected } : null;
    state.skyGuideSavedConstellations = {
      showConstellations: state.showConstellations,
      discoveryConstellationId: state.discoveryConstellationId
    };
    state.selected = null;
    state.skyGuideFreeTargetId = "";
    state.skyGuideMode = "free";
    updateSkyGuide(null, null, NaN, NaN, NaN, t("ui.scanSkyGently"));
  } else {
    state.skyGuideMode = "targeted";
    state.skyGuideFreeTargetId = "";
    state.selected = state.skyGuideSavedSelection ? { ...state.skyGuideSavedSelection } : null;
    if (state.skyGuideSavedConstellations) {
      state.showConstellations = state.skyGuideSavedConstellations.showConstellations;
      state.discoveryConstellationId = state.skyGuideSavedConstellations.discoveryConstellationId;
    }
    state.skyGuideSavedSelection = null;
    state.skyGuideSavedConstellations = null;
    if (state.selected) updateSkyGuide(selectedPosition(state.observationDate || new Date()), null, NaN, NaN, NaN,
      t("ui.targetedGuidanceReactivated"));
  }
  drawSky();
}

function exitFinder() {
  if (state.skyGuideMode === "free") {
    state.selected = state.skyGuideSavedSelection ? { ...state.skyGuideSavedSelection } : null;
    if (state.skyGuideSavedConstellations) {
      state.showConstellations = state.skyGuideSavedConstellations.showConstellations;
      state.discoveryConstellationId = state.skyGuideSavedConstellations.discoveryConstellationId;
    }
  }
  state.skyGuideSavedSelection = null;
  state.skyGuideSavedConstellations = null;
  state.skyGuideMode = "targeted";
  state.skyGuideFreeTargetId = "";
  state.finderActive = false;
  state.finderLocked = false;
  state.finderLockSince = 0;
  const panel = $("sky-guide");
  const card = $("object-card");
  if (panel) panel.hidden = true;
  if (card && state.selected) card.hidden = false;
  drawSky();
}


  $("sky-guide-exit")?.addEventListener("click", exitFinder);
  $("sky-guide-finish")?.addEventListener("click", exitFinder);
  $("sky-guide-mode-toggle")?.addEventListener("click", toggleSkyGuideMode);

  /* ==========================================================
     GÉOLOCALISATION
     ========================================================== */


function locateUser() {
  if (!navigator.geolocation) {
    ui.showToast(
      t("ui.geolocationUnavailableInBrowser")
    );
    console.error("[Atlas] navigator.geolocation indisponible.");
    return;
  }

  ui.showToast("Recherche de votre position GPS…");

  navigator.geolocation.getCurrentPosition(
    position => {
      const latitude = position.coords.latitude;
      const longitude = position.coords.longitude;
      const accuracy = position.coords.accuracy;

      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180
      ) {
        ui.showToast(t("ui.invalidGpsCoordinates"));
        return;
      }

      state.latitude = latitude;
      state.longitude = longitude;
      state.locationName = "Position GPS";
      state.locationReady = true;
      refreshAutoHeading();
      persistLastObservationLocation();

      ui.updateLocationLabel();
      drawSky();

      ui.showToast(
        `${t("ui.positionUpdated")} (±${Math.round(accuracy)} m).`
      );
    },
    error => {
      const messages = {
        1: t("ui.allowLocationInSettings"),
        2: t("ui.positionUnavailableCheckGps"),
        3: t("ui.gpsTimeoutTryAgain")
      };

      console.error("[Atlas] Erreur GPS :", {
        code: error.code,
        message: error.message
      });

      ui.showToast(
        messages[error.code] ||
        t("ui.unableToRetrievePosition")
      );
    },
    {
        enableHighAccuracy: true,
        timeout: 60000,
        maximumAge: 0
    }
  );
}

  /* ==========================================================
     MODE IMMERSIF
     ========================================================== */

  async function setImmersive(enabled) {
    const app = $("app");

    state.immersive = Boolean(enabled);

    if (app) {
      app.classList.toggle(
        "immersive",
        state.immersive
      );

      app.classList.remove("show-exit");
    }

    try {
      if (
        state.immersive &&
        !document.fullscreenElement &&
        document.documentElement.requestFullscreen
      ) {
        await document.documentElement.requestFullscreen();
      } else if (
        !state.immersive &&
        document.fullscreenElement &&
        document.exitFullscreen
      ) {
        await document.exitFullscreen();
      }
    } catch (error) {
      console.warn("Mode immersif :", error);
    }

    resizeCanvas();
  }

  /* ==========================================================
     TAILLE DU CANVAS
     ========================================================== */

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();

    if (!rect.width || !rect.height) {
      return;
    }

    state.width = rect.width;
    state.height = rect.height;
    hudReservedBoxesAt = 0;
    state.dpr = Math.min(
      window.devicePixelRatio || 1,
      2
    );

    const pixelWidth =
      Math.round(state.width * state.dpr);

    const pixelHeight =
      Math.round(state.height * state.dpr);

    if (
      canvas.width !== pixelWidth ||
      canvas.height !== pixelHeight
    ) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }

    /*
     * Les coordonnées de dessin restent exprimées en pixels CSS.
     * setTransform remplace la transformation précédente :
     * il n'y a donc pas de multiplication répétée du DPR.
     */
    ctx.setTransform(
      state.dpr,
      0,
      0,
      state.dpr,
      0,
      0
    );

    drawSky();
  }

  /* ==========================================================
     RENDU PRINCIPAL
     ========================================================== */


let horizontalPositionCache = {
  key: "",
  stars: [],
  messier: [],
  ngc: [],
  minorPlanets: []
};

// Liste des objets de catalogue déjà fusionnés avec leurs coordonnées
// horizontales. Elle est reconstruite uniquement lorsque le cache de
// positions change, plutôt qu'à chaque image.
let visibleCatalogObjectsCache = {
  key: "",
  objects: [],
  starsAboveHorizon: 0
};

// Regroupe les demandes de rendu arrivant pendant une même image.
// Cela évite de redessiner plusieurs fois si plusieurs capteurs/UI changent
// presque simultanément, sans ajouter de temporisation artificielle.
let skyRenderFrame = null;
// Diagnostic facultatif du coût total de rendu : activer avec ?perf=1.
// Aucun calcul astronomique ni comportement visuel n'est modifié.
const skyRenderDiagnostics = (() => {
  try {
    return new URLSearchParams(window.location.search).get("perf") === "1";
  } catch {
    return false;
  }
})();
let skyRenderDiagnosticCount = 0;
let skyRenderDiagnosticTotal = 0;
let skyRenderDiagnosticMin = Infinity;
let skyRenderDiagnosticMax = 0;
let skyRenderDiagnosticStageFrameTotal = 0;
const skyRenderDiagnosticStages = Object.create(null);
// Panneau lisible sur mobile : il n'existe que lorsque ?perf=1 est présent.
let skyRenderDiagnosticPanel = null;
if (skyRenderDiagnostics) {
  // Le détail du diagnostic reste dans la console et les journaux exportables.
  // Ne pas superposer un panneau de texte à la carte : il masquait les menus mobiles.
  skyRenderDiagnosticPanel = null;

  const sensorLogButton = document.createElement("button");
  sensorLogButton.type = "button";
  sensorLogButton.id = "atlas-sensor-log-download";
  sensorLogButton.textContent = t("ui.downloadSensorLogs");
  Object.assign(sensorLogButton.style, {
    position: "fixed", left: "8px",
    bottom: "calc(var(--mobile-toolbar-height, 42px) + 24px + env(safe-area-inset-bottom, 0px))",
    zIndex: "100000", padding: "10px 12px", border: "1px solid #718096", borderRadius: "8px",
    background: "#101827", color: "#ffffff", font: "600 13px/1.2 system-ui, sans-serif",
    boxShadow: "0 2px 10px #0008", maxWidth: "calc(100vw - 16px)"
  });
  sensorLogButton.addEventListener("click", () => {
    const log = window.__atlasSensorLog || { startedAt: null, userAgent: navigator.userAgent, records: [], dropped: 0 };
    const payload = {
      application: "Atlas Céleste",
      version: "v373-test",
      exportedAt: new Date().toISOString(),
      startedAt: log.startedAt || null,
      userAgent: log.userAgent || navigator.userAgent,
      screenOrientationAngle: window.screen?.orientation?.angle ?? window.orientation ?? null,
      records: log.records || [],
      droppedRecords: log.dropped || 0,
      note: t("ui.localOrientationGyroLog")
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "atlas-capteurs-v373-test-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  });
  document.body.appendChild(sensorLogButton);
  const updateLogCount = (event) => {
    const count = event?.detail?.count ?? window.__atlasSensorLog?.records?.length ?? 0;
    // Le compteur est conservé dans le journal ; le bouton reste compact.
    sensorLogButton.textContent = t("ui.downloadSensorLogs");
  };
  window.addEventListener("atlas-sensor-log-updated", updateLogCount);
}
function drawSky() {
  if (skyRenderFrame !== null) return;
  skyRenderFrame = requestAnimationFrame(() => {
    skyRenderFrame = null;
    if (!skyRenderDiagnostics) {
      renderSkyNow();
      return;
    }
    const start = performance.now();
    skyRenderDiagnosticStageFrameTotal = 0;
    try {
      renderSkyNow();
    } finally {
      const elapsed = performance.now() - start;
      skyRenderDiagnosticCount++;
      skyRenderDiagnosticTotal += elapsed;
      skyRenderDiagnosticMin = Math.min(skyRenderDiagnosticMin, elapsed);
      skyRenderDiagnosticMax = Math.max(skyRenderDiagnosticMax, elapsed);
      const unaccounted = Math.max(0, elapsed - skyRenderDiagnosticStageFrameTotal);
      skyRenderDiagnosticStages.temps_non_attribue = (skyRenderDiagnosticStages.temps_non_attribue || 0) + unaccounted;
      if (skyRenderDiagnosticCount >= 60) {
        const stages = Object.fromEntries(Object.entries(skyRenderDiagnosticStages).map(([name, total]) => [
          name, Number((total / skyRenderDiagnosticCount).toFixed(2))
        ]));
        const phaseSum = Object.entries(stages).reduce((sum, [name, ms]) => name === "temps_non_attribue" ? sum : sum + ms, 0);
        const report = {
          moyenne_ms: Number((skyRenderDiagnosticTotal / skyRenderDiagnosticCount).toFixed(2)),
          minimum_ms: Number(skyRenderDiagnosticMin.toFixed(2)),
          maximum_ms: Number(skyRenderDiagnosticMax.toFixed(2)),
          somme_phases_ms: Number(phaseSum.toFixed(2)),
          ecart_non_attribue_ms: stages.temps_non_attribue ?? 0,
          phases_moyennes_ms: stages
        };
        const rebuildEvents = milkyWayDiagnosticStats.rebuildEvents;
        const eventReasons = { initial: 0, temps: 0, lieu: 0, orientation: 0, champ: 0, dimensions: 0, autre: 0, non_classee: 0 };
        const eventChanges = { temps: 0, lieu: 0, orientation: 0, champ: 0, dimensions: 0, aucune: 0 };
        for (const event of rebuildEvents) {
          eventReasons[event.reason] = (eventReasons[event.reason] || 0) + 1;
          for (const name of event.changedNames || []) {
            if (Object.prototype.hasOwnProperty.call(eventChanges, name)) eventChanges[name]++;
          }
        }
        const milkyWayReport = {
          appels: milkyWayDiagnosticStats.calls,
          cache_reutilise: milkyWayDiagnosticStats.hits,
          reconstructions: rebuildEvents.length,
          compteur_reconstructions_brut: milkyWayDiagnosticStats.rebuilds,
          reconstruction_moyenne_ms: milkyWayDiagnosticStats.buildCompleted
            ? Number((milkyWayDiagnosticStats.buildTotalMs / milkyWayDiagnosticStats.buildCompleted).toFixed(2)) : 0,
          reconstruction_max_ms: Number(milkyWayDiagnosticStats.buildMaxMs.toFixed(2)),
          causes_reconstruction: eventReasons,
          changements_detectes: eventChanges,
          reconstructions_terminees: milkyWayDiagnosticStats.buildCompleted,
          reconstructions_interrompues: milkyWayDiagnosticStats.buildAborted
        };
        console.info("[Atlas perf] Rendu carte — 60 images", { ...report, voie_lactee: milkyWayReport });
        if (skyRenderDiagnosticPanel) {
          const phaseLabels = {
            fond_et_voie_lactee: "Fond + Voie lactée",
            positions_catalogues: "Positions catalogues",
            preparation_objets: "Préparation des objets + système solaire",
            traces_constellations: "Tracés constellations",
            projection_dessin_objets: "Projection + dessin des objets",
            dessin_horizon: "Dessin de l’horizon",
            marqueurs_et_noms: "Marqueurs + noms affichés",
            interface_compteurs_fiche_chercheur: "Interface, compteurs, fiche + chercheur",
            temps_non_attribue: "Temps hors phases mesurées"
          };
          const phaseLines = Object.entries(stages).map(([name, ms]) =>
            `${phaseLabels[name] || name} : ${ms.toFixed(2)} ms`
          );
          skyRenderDiagnosticPanel.textContent = [
            "ATLAS CÉLESTE — DIAGNOSTIC v373-test",
            "Moteur Voie lactée : " + (milkyWayGLFailed ? "Canvas 2D (repli après échec WebGL)" : milkyWayWebGLRequested ? "WebGL expérimental" : "Canvas 2D"),
            "Moyenne : " + report.moyenne_ms.toFixed(2) + " ms / image",
            "Minimum : " + report.minimum_ms.toFixed(2) + " ms",
            "Maximum : " + report.maximum_ms.toFixed(2) + " ms",
            "Budget 60 i/s : 16,67 ms",
            "Somme des phases : " + report.somme_phases_ms.toFixed(2) + " ms",
            "Temps hors phases : " + report.ecart_non_attribue_ms.toFixed(2) + " ms",
            "—— Cache Voie lactée (60 images) ——",
            "Appels : " + milkyWayReport.appels + " · cache réutilisé : " + milkyWayReport.cache_reutilise,
            "Reconstructions : " + milkyWayReport.reconstructions + " · compteur brut : " + milkyWayReport.compteur_reconstructions_brut,
            "Reconstruction moyenne : " + milkyWayReport.reconstruction_moyenne_ms.toFixed(2) + " ms",
            "Reconstruction max : " + milkyWayReport.reconstruction_max_ms.toFixed(2) + " ms",
            "Causes principales : " + Object.entries(milkyWayReport.causes_reconstruction).filter(([_, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(" · "),
            "Changements détectés (cumulables) : " + Object.entries(milkyWayReport.changements_detectes).filter(([_, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(" · "),
            "Reconstructions terminées : " + milkyWayReport.reconstructions_terminees + " · interrompues : " + milkyWayReport.reconstructions_interrompues,
            "Contrôle causes / événements : " + Object.values(milkyWayReport.causes_reconstruction).reduce((sum, n) => sum + n, 0) + " / " + milkyWayReport.reconstructions,
            "—— Phases moyennes ——",
            ...phaseLines,
            "—— Capteur / précision ——",
            "Cap brut : " + (Number.isFinite(state.rawHeading) ? state.rawHeading.toFixed(1) + "°" : "indisponible") + " · cap filtré : " + norm360(state.heading).toFixed(1) + "°",
            "Source : " + (state.headingSource || "indisponible") + " · variation brute récente : " + (Number.isFinite(state.rawHeadingDelta) ? state.rawHeadingDelta.toFixed(1) : "—") + "° · variation filtrée : " + (Number.isFinite(state.filteredHeadingDelta) ? state.filteredHeadingDelta.toFixed(1) : "—") + "°",
            "Gyroscope : " + (state.gyroDataSeen ? "données reçues" : "aucune donnée exploitable") + " · rotation détectée : " + (state.gyroMotionActive ? "oui" : "non") + " · dernière mesure : " + (state.gyroLastUpdate > 0 ? Math.max(0, (performance.now() - state.gyroLastUpdate) / 1000).toFixed(1) + " s" : "—"),
            "Vitesse gyro α/β/γ : " + [state.gyroRateAlpha, state.gyroRateBeta, state.gyroRateGamma].map(v => Number.isFinite(v) ? v.toFixed(1) : "—").join(" / ") + " °/s · norme : " + (Number.isFinite(state.gyroRateMagnitude) ? state.gyroRateMagnitude.toFixed(1) + " °/s" : "—"),
            "Décision cap : " + (state.headingDecision || "indisponible") + " · mouvement cohérent : " + (state.headingMotionConfirmed ? "confirmé" : "non confirmé") + " · échantillons : " + (state.headingMotionSamples || 0) + " · déplacement candidat : " + (Number.isFinite(state.headingMotionTravel) ? state.headingMotionTravel.toFixed(2) : "—") + "°",
            "Position : " + state.latitude.toFixed(4) + "°, " + state.longitude.toFixed(4) + "° · lieu : " + (state.locationName || "non nommé"),
            (() => { const d = state.observationDate || new Date(); const sun = solarObjectsAt(d).find(o => o.type === "sun"); return "Soleil calculé : " + (sun ? "azimut " + sun.az.toFixed(1) + "° · altitude " + sun.alt.toFixed(1) + "°" : "indisponible") + " · heure observée : " + d.toLocaleString("fr-FR"); })(),
            "Actualisé toutes les 60 images (?perf=1 pour activer)"
          ].join("\n");
        }
        for (const name of Object.keys(skyRenderDiagnosticStages)) delete skyRenderDiagnosticStages[name];
        milkyWayDiagnosticStats.calls = 0;
        milkyWayDiagnosticStats.hits = 0;
        milkyWayDiagnosticStats.rebuilds = 0;
        milkyWayDiagnosticStats.buildTotalMs = 0;
        milkyWayDiagnosticStats.buildMaxMs = 0;
        milkyWayDiagnosticStats.buildCompleted = 0;
        milkyWayDiagnosticStats.buildAborted = 0;
        for (const reason of Object.keys(milkyWayDiagnosticStats.reasons)) milkyWayDiagnosticStats.reasons[reason] = 0;
        milkyWayDiagnosticStats.rebuildEvents.length = 0;
        for (const name of Object.keys(milkyWayDiagnosticStats.changes)) milkyWayDiagnosticStats.changes[name] = 0;
        skyRenderDiagnosticCount = 0;
        skyRenderDiagnosticTotal = 0;
        skyRenderDiagnosticMin = Infinity;
        skyRenderDiagnosticMax = 0;
      }
    }
  });
}

function visibleScreenPointForObject(target, visibleObjects) {
  if (!target || !Array.isArray(visibleObjects)) return null;
  const targetType = String(target.type || "").toLowerCase();
  const targetId = String(target.id ?? target.hip ?? "").trim();
  const targetName = String(target.name || target.proper_name || target.properName || target.common_name || "").trim().toLowerCase();
  let match = null;
  if (targetId) {
    match = visibleObjects.find(item => String(item.id ?? item.hip ?? "").trim() === targetId &&
      (!targetType || String(item.type || "").toLowerCase() === targetType));
  }
  if (!match && targetName) {
    match = visibleObjects.find(item => String(item.name || item.proper_name || item.properName || item.common_name || "").trim().toLowerCase() === targetName &&
      (!targetType || String(item.type || "").toLowerCase() === targetType));
  }
  return match && Number.isFinite(match.screenX) && Number.isFinite(match.screenY)
    ? { x: match.screenX, y: match.screenY } : null;
}

function drawSelectedStarMarker(point) {
  const armInner = 5;
  const armOuter = 19;
  const radius = 13;
  ctx.save();
  ctx.lineCap = "round";
  // Liseré sombre puis trait cyan : le repère reste visible sur les fonds clairs
  // comme sur le ciel sombre, sans masquer le centre de l’étoile.
  for (const [color, width] of [["rgba(3, 12, 24, 0.92)", 4.5], ["#ffd447", 1.8]]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, TAU);
    ctx.moveTo(point.x - armOuter, point.y);
    ctx.lineTo(point.x - armInner, point.y);
    ctx.moveTo(point.x + armInner, point.y);
    ctx.lineTo(point.x + armOuter, point.y);
    ctx.moveTo(point.x, point.y - armOuter);
    ctx.lineTo(point.x, point.y - armInner);
    ctx.moveTo(point.x, point.y + armInner);
    ctx.lineTo(point.x, point.y + armOuter);
    ctx.stroke();
  }
  ctx.restore();
}

function drawDiscoveryTargetArrow(point) {
  if (!point) return;
  // Flèche jaune plus lisible, séparée du cercle de cible par un espace net.
  // Le contour sombre la détache aussi bien du ciel que des étoiles brillantes.
  const tipY = point.y - 28;
  const baseY = point.y - 75;
  const centerX = point.x;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(2, 7, 18, 0.98)";
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(centerX, baseY);
  ctx.lineTo(centerX, tipY);
  ctx.moveTo(centerX - 9, tipY - 10);
  ctx.lineTo(centerX, tipY);
  ctx.lineTo(centerX + 9, tipY - 10);
  ctx.stroke();
  ctx.strokeStyle = "#ffd447";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(centerX, baseY);
  ctx.lineTo(centerX, tipY);
  ctx.moveTo(centerX - 9, tipY - 10);
  ctx.lineTo(centerX, tipY);
  ctx.lineTo(centerX + 9, tipY - 10);
  ctx.stroke();
  ctx.restore();
}

function drawDiscoveryReferenceMarker(point, index = 0) {
  if (!point) return;
  const radius = 9 + index * 2;
  ctx.save();
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = "rgba(3, 12, 24, 0.92)";
  ctx.beginPath(); ctx.arc(point.x, point.y, radius, 0, TAU); ctx.stroke();
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = "#75e6ff";
  ctx.beginPath(); ctx.arc(point.x, point.y, radius, 0, TAU); ctx.stroke();
  ctx.restore();
}

function drawDiscoveryMarkerLabel(point, text, color = "#75e6ff", placement = "right") {
  if (!point || !text) return;
  ctx.save();
  ctx.font = "600 12px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const label = String(text).slice(0, 34);
  const width = ctx.measureText(label).width + 12;
  // Pour la cible, ancrer le texte au départ de la flèche (au-dessus de l'objet)
  // plutôt qu'à côté du point lumineux. Les repères gardent leur libellé latéral.
  const preferredX = placement === "arrow-start" ? point.x + 12 : point.x + 20;
  const x = Math.max(4, Math.min(state.width - width - 4, preferredX));
  const preferredY = placement === "arrow-start" ? point.y - 75 : point.y - 16;
  const y = Math.max(12, Math.min(state.height - 12, preferredY));
  ctx.fillStyle = "rgba(3, 12, 24, 0.9)";
  ctx.fillRect(x, y - 9, width, 18);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y - 9, width, 18);
  ctx.fillStyle = color;
  ctx.fillText(label, x + 6, y);
  ctx.restore();
}

// Zones couvertes par l'interface (barre du haut, heure, direction, menu Découverte).
// Elles sont ajoutées aux zones « occupées » pour que les étiquettes de la carte
// ne se retrouvent pas cachées sous un panneau. Les rectangles sont mis en cache
// brièvement pour ne pas relire la mise en page à chaque image.
const HUD_LABEL_AVOID_SELECTORS = [".topbar", "#discovery-local-time", ".sky-readout", "#discovery-panel"];
let hudReservedBoxes = [];
let hudReservedBoxesAt = 0;

function getHudReservedBoxes() {
  const now = performance.now();
  if (now - hudReservedBoxesAt > 250) {
    hudReservedBoxesAt = now;
    hudReservedBoxes = [];
    const canvasRect = canvas.getBoundingClientRect();
    for (const selector of HUD_LABEL_AVOID_SELECTORS) {
      const element = document.querySelector(selector);
      if (!element || element.hidden) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      hudReservedBoxes.push({
        left: rect.left - canvasRect.left,
        right: rect.right - canvasRect.left,
        top: rect.top - canvasRect.top,
        bottom: rect.bottom - canvasRect.top
      });
    }
  }
  return hudReservedBoxes.slice();
}

function renderSkyNow() {
  if (!state.width || !state.height) {
    return;
  }

  // Chronométrage détaillé strictement facultatif (?perf=1) : aucune lecture
  // de performance.now() supplémentaire en usage normal.
  let perfStageStart = skyRenderDiagnostics ? performance.now() : 0;
  const markPerfStage = name => {
    if (!skyRenderDiagnostics) return;
    const now = performance.now();
    const duration = now - perfStageStart;
    skyRenderDiagnosticStages[name] = (skyRenderDiagnosticStages[name] || 0) + duration;
    skyRenderDiagnosticStageFrameTotal += duration;
    perfStageStart = now;
  };

  labelBoxes = getHudReservedBoxes();

  const date = state.observationDate || new Date();

  drawBackground();
  drawMilkyWay(date);
  drawEclipticGrid(date);
  markPerfStage("fond_et_voie_lactee");

  /*
   * Les coordonnées horizontales évoluent très lentement à l'échelle
   * de quelques secondes. On les recalcule toutes les 5 s, ou dès que
   * l'heure de référence, le lieu ou les catalogues changent.
   * La projection écran et les capteurs restent recalculés à chaque rendu.
   */
  const positionBucket = Math.floor(date.getTime() / 5000);
  const positionKey = [
    positionBucket,
    state.latitude,
    state.longitude,
    state.stars.length,
    state.messier.length,
    state.ngc.length,
    state.minorPlanets.length
  ].join("|");

  if (horizontalPositionCache.key !== positionKey) {
    horizontalPositionCache = {
      key: positionKey,
      stars: state.stars.map(star => starHorizontalPosition(star, date)),
      messier: state.messier.map(object =>
        equatorialToHorizontal(
          object.ra,
          object.dec,
          date,
          state.latitude,
          state.longitude,
          { epoch: CATALOGUE_EPOCH }
        )
      ),
      ngc: state.ngc.map(object =>
        equatorialToHorizontal(
          object.ra,
          object.dec,
          date,
          state.latitude,
          state.longitude,
          { epoch: CATALOGUE_EPOCH }
        )
      ),
      minorPlanets: calculateMinorPlanetPositions(
        state.minorPlanets, date, state.latitude, state.longitude, state.minorPlanetsEpochJD
      )
    };
  }

  markPerfStage("positions_catalogues");

  // Réutiliser les objets de catalogue déjà fusionnés avec leurs positions.
  // Le cache est synchronisé avec positionKey : les coordonnées restent
  // actualisées à chaque tranche de 5 s, comme avant cette optimisation.
  if (visibleCatalogObjectsCache.key !== positionKey) {
    const catalogObjects = [];
    let cachedStarsAboveHorizon = 0;

    for (let i = 0; i < state.stars.length; i++) {
      const star = state.stars[i];
      const position = horizontalPositionCache.stars[i];
      if (Number.isFinite(position?.az) && Number.isFinite(position?.alt) && position.alt > 0) {
        cachedStarsAboveHorizon++;
        catalogObjects.push({ ...star, ...position, type: "star" });
      }
    }

    for (let i = 0; i < state.messier.length; i++) {
      const object = state.messier[i];
      const position = horizontalPositionCache.messier[i];
      if (Number.isFinite(position?.az) && Number.isFinite(position?.alt) && position.alt > 0) {
        catalogObjects.push({ ...object, ...position, catalogue: "Messier", type: object.type || "deep-sky" });
      }
    }

    for (let i = 0; i < state.ngc.length; i++) {
      const object = state.ngc[i];
      const position = horizontalPositionCache.ngc[i];
      if (Number.isFinite(position?.az) && Number.isFinite(position?.alt) && position.alt > 0) {
        catalogObjects.push({ ...object, ...position, catalogue: "NGC", type: object.type || "deep-sky" });
      }
    }

    for (const object of horizontalPositionCache.minorPlanets) {
      if (Number.isFinite(object?.az) && Number.isFinite(object?.alt) && object.alt > 0) {
        catalogObjects.push({ ...object, catalogue: object.comet ? "Comètes" : (object.dwarfPlanet ? "Planètes naines" : "Planètes mineures"), type: object.comet ? "comet" : (object.dwarfPlanet ? "dwarf-planet" : "minor-planet") });
      }
    }

    visibleCatalogObjectsCache = {
      key: positionKey,
      objects: catalogObjects,
      starsAboveHorizon: cachedStarsAboveHorizon
    };
  }

  const solar = solarObjectsAt(date);
  const solarObjects = Array.isArray(solar)
    ? solar.filter(object => object && Number.isFinite(object.az) && Number.isFinite(object.alt) && object.alt > 0)
    : [];
  // concat crée seulement le tableau de travail ; les objets du catalogue
  // eux-mêmes ne sont plus recréés à chaque image.
  const objects = visibleCatalogObjectsCache.objects.concat(solarObjects).filter(isMapObjectCategoryEnabled);
  const starsAboveHorizon = state.displayCategories?.stars === false ? 0 : visibleCatalogObjectsCache.starsAboveHorizon;

  markPerfStage("preparation_objets");

  drawConstellationBoundaries(date);
  drawConstellations(date);
  markPerfStage("traces_constellations");

  const visible = [];
  let starsInField = 0;
  // Le mode Découverte ne change pas pendant une frame : lire la classe une
  // seule fois évite une recherche DOM répétée pour chaque étoile.
  const discoveryMode = Boolean(appElement?.classList.contains("discovery-mode"));

  for (const object of objects) {
    if (state.reviewStarsOnly && object.type === "star" && object.gaia_astrometry_status !== "needs_review") continue;
    const point = project(object.az, object.alt);

    if (!point) {
      continue;
    }

    visible.push({
      ...object,
      screenX: point.x,
      screenY: point.y
    });

    if (object.type === "star") {
      starsInField++;
      if (discoveryMode && state.discoveryConstellationId && state.discoveryConstellationStarIds?.has(String(object.id))) {
        ctx.save();
        const halo = ctx.createRadialGradient(point.x, point.y, 1, point.x, point.y, 15);
        halo.addColorStop(0, "rgba(255,220,140,.48)");
        halo.addColorStop(1, "rgba(255,220,140,0)");
        ctx.fillStyle = halo;
        ctx.beginPath(); ctx.arc(point.x, point.y, 15, 0, TAU); ctx.fill();
        ctx.strokeStyle = "rgba(255,224,153,.92)"; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(point.x, point.y, Math.max(5, 4 + (3 - Number(object.mag || 3)) * .45), 0, TAU); ctx.stroke();
        ctx.restore();
      }
      drawStar(point, object.mag, object.bp_rp);
      if (discoveryMode && state.discoveryConstellationTargetStarId && String(object.id) === String(state.discoveryConstellationTargetStarId)) {
        // Flèche éloignée du point stellaire et de ses libellés : choisir
        // automatiquement le quadrant qui laisse le plus d'espace dans la carte.
        ctx.save();
        const canvasW = canvas.width / (window.devicePixelRatio || 1);
        const canvasH = canvas.height / (window.devicePixelRatio || 1);
        const candidates = [
          { dx: -64, dy: -48, align: "right" },
          { dx: 64, dy: -48, align: "left" },
          { dx: -64, dy: 48, align: "right" },
          { dx: 64, dy: 48, align: "left" }
        ];
        // Cette liste ne dépend pas du quadrant testé : la filtrer une fois
        // évite de parcourir visible quatre fois à chaque rendu de la cible.
        const brightVisibleStars = visible.filter(other =>
          other.type === "star" &&
          String(other.id) !== String(object.id) &&
          Number(other.mag) <= 3.5
        );
        const candidate = candidates.map(c => ({ ...c,
          x: point.x + c.dx, y: point.y + c.dy,
          score: (point.x + c.dx < 70 || point.x + c.dx > canvasW - 70 ? 100 : 0) +
                 (point.y + c.dy < 28 || point.y + c.dy > canvasH - 28 ? 100 : 0) +
                 brightVisibleStars.reduce((penalty, other) => {
                   const lx = point.x + c.dx, ly = point.y + c.dy;
                   const distance = Math.hypot(lx - other.screenX, ly - other.screenY);
                   return penalty + (distance < 58 ? (58 - distance) * 1.4 : 0);
                 }, 0)
        })).sort((a, b) => a.score - b.score)[0];
        const sx = Math.max(48, Math.min(canvasW - 48, candidate.x));
        const sy = Math.max(22, Math.min(canvasH - 22, candidate.y));
        const vx = point.x - sx, vy = point.y - sy, length = Math.max(1, Math.hypot(vx, vy));
        const ex = point.x - vx / length * 11, ey = point.y - vy / length * 11;
        ctx.strokeStyle = "rgba(255, 224, 153, .96)";
        ctx.fillStyle = "#ffe5a6";
        ctx.lineWidth = 1.7;
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
        const angle = Math.atan2(ey - sy, ex - sx);
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - 7 * Math.cos(angle - Math.PI / 6), ey - 7 * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(ex - 7 * Math.cos(angle + Math.PI / 6), ey - 7 * Math.sin(angle + Math.PI / 6));
        ctx.closePath(); ctx.fill();
        ctx.font = "600 11px system-ui, sans-serif";
        ctx.textAlign = candidate.align; ctx.textBaseline = candidate.dy < 0 ? "bottom" : "top";
        const labelX = sx + (candidate.align === "right" ? -3 : 3);
        const labelY = sy + (candidate.dy < 0 ? -5 : 5);
        const labelWidth = ctx.measureText(t("ui.toSpot")).width + 10;
        ctx.fillStyle = "rgba(5, 13, 29, .88)";
        ctx.beginPath(); ctx.roundRect(labelX + (candidate.align === "right" ? -labelWidth : 0), labelY - 12, labelWidth, 17, 5); ctx.fill();
        ctx.fillStyle = "#ffe5a6";
        ctx.shadowColor = "rgba(3, 10, 24, .95)"; ctx.shadowBlur = 3;
        ctx.fillText(t("ui.toSpot"), labelX, labelY);
        ctx.restore();
      }
      if (object.gaia_astrometry_status === "needs_review") {
        ctx.save();
        ctx.strokeStyle = "#ffb86b";
        ctx.fillStyle = "#ffdf9e";
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 9, 0, TAU);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(point.x - 12, point.y); ctx.lineTo(point.x - 5, point.y);
        ctx.moveTo(point.x + 5, point.y); ctx.lineTo(point.x + 12, point.y);
        ctx.moveTo(point.x, point.y - 12); ctx.lineTo(point.x, point.y - 5);
        ctx.moveTo(point.x, point.y + 5); ctx.lineTo(point.x, point.y + 12);
        ctx.stroke();
        drawLabel(`HIP ${object.hip} · ${t("ui.toVerify")}`, { x: point.x, y: point.y + 17 }, "#ffcf87", true);
        ctx.restore();
      }

      const isPolaris = Number(object.hip) === 11767;
      const brightEnoughForDiscoveryName = discoveryMode &&
        Number.isFinite(object.mag) && object.mag <= 2.0;
      const needsName = (state.showStarLabels &&
        (isPolaris || (Number.isFinite(object.mag) && object.mag <= 1.5))) ||
        brightEnoughForDiscoveryName;
      // Éviter de résoudre le nom de chaque étoile à chaque image lorsque
      // son étiquette ne peut pas être affichée dans le mode courant.
      const commonOrCatalogName = needsName ? displayStarName(object) : "";
      const brighterNamedStarForDiscovery = brightEnoughForDiscoveryName &&
        Boolean(commonOrCatalogName);
      const ordinarilyLabeled = state.showStarLabels && (
        isPolaris ||
        (Number.isFinite(object.mag) && object.mag <= 1.5) ||
        brighterNamedStarForDiscovery
      );
      if (ordinarilyLabeled) {
        drawLabel(commonOrCatalogName, point, "#e5efff", discoveryMode);
      }
      if (state.finderActive && state.skyGuideMode === "free" &&
          String(object.id || "") === state.skyGuideFreeTargetId &&
          commonOrCatalogName && !ordinarilyLabeled) {
        drawLabel(commonOrCatalogName, point, "#65e6a5", true);
      }
    } else if (
      object.type === "planet" ||
      object.type === "sun" ||
      object.type === "moon"
    ) {
      drawSolarObject(object, point);
    } else if (object.type === "minor-planet" || object.type === "dwarf-planet" || object.type === "comet") {
      drawMinorPlanetObject(object, point);
    } else {
      drawDeepSkyObject(object, point);
    }
  }

    markPerfStage("projection_dessin_objets");

    // Le paysage passe devant les objets proches de l'horizon.
    drawHorizon();
    markPerfStage("dessin_horizon");

    // Repère de visée : une croix encadre l’étoile sélectionnée, même si sa
    // magnitude ou l’affichage des étiquettes ne permet pas de la distinguer.
    // Le repère est dessiné après l’horizon pour rester lisible sur la carte.
    const refreshedSelected = state.selected && isMapObjectCategoryEnabled(state.selected)
      ? (selectedPosition(date) || state.selected)
      : null;
    // Réutiliser les coordonnées écran de l'objet réellement dessiné dans la boucle
    // principale : la cible et son marqueur partagent ainsi exactement le même point.
    const selectedPoint = refreshedSelected
      ? (visibleScreenPointForObject(refreshedSelected, visible) ||
        (Number.isFinite(Number(refreshedSelected.az)) && Number.isFinite(Number(refreshedSelected.alt))
          ? project(Number(refreshedSelected.az), Number(refreshedSelected.alt)) : null))
      : null;
    if (selectedPoint) drawSelectedStarMarker(selectedPoint);
    const startPanelOpen = !discoveryStartPanelElement?.hidden;
    const discoverySearchOpen = !discoverySearchPanelElement?.hidden;
    const discoverySearchTargetActive = Boolean(appElement?.classList.contains("discovery-search-target-active"));
    const discoveryTargetPanelOpen = Boolean(appElement?.classList.contains("discovery-mode")) &&
      (startPanelOpen || discoverySearchOpen || discoverySearchTargetActive);
    if (discoveryTargetPanelOpen && refreshedSelected) {
      const point = selectedPoint || (Number.isFinite(Number(refreshedSelected.az)) && Number.isFinite(Number(refreshedSelected.alt))
        ? project(Number(refreshedSelected.az), Number(refreshedSelected.alt)) : null);
      if (point) {
        drawDiscoveryTargetArrow(point);
        // Le libellé commun choisi dans la recherche prime sur le nom de catalogue.
        drawDiscoveryMarkerLabel(point, refreshedSelected.discoveryLabel || refreshedSelected.common_name || refreshedSelected.name || refreshedSelected.proper_name || refreshedSelected.id || "Cible choisie", "#ffd447", "arrow-start");
      }
    }
    // Repères voisins en cyan, y compris leurs libellés.
    if (Array.isArray(state.discoveryStartReferences)) {
      state.discoveryStartReferences.forEach((reference, index) => {
        if (!isMapObjectCategoryEnabled(reference)) return;
        let currentReference = reference;
        if (Number.isFinite(Number(reference.ra)) && Number.isFinite(Number(reference.dec))) {
          const horizontal = horizontalPosition(Number(reference.ra), Number(reference.dec), date);
          currentReference = { ...reference, ...horizontal };
        }
        const point = visibleScreenPointForObject(reference, visible) ||
          (Number.isFinite(Number(currentReference.az)) && Number.isFinite(Number(currentReference.alt))
            ? project(Number(currentReference.az), Number(currentReference.alt)) : null);
        if (point) {
          drawDiscoveryReferenceMarker(point, index);
          if (discoveryTargetPanelOpen) drawDiscoveryMarkerLabel(point, currentReference.discoveryLabel || currentReference.common_name || currentReference.name || currentReference.proper_name || currentReference.id || t("ui.landmark"), "#75e6ff");
        }
      });
    }

    // Les noms des constellations restent au premier plan.
    drawConstellationNames(date);
    markPerfStage("marqueurs_et_noms");

    state.visibleObjects = visible;

    if (visibleCountElement) {
      visibleCountElement.textContent = String(visible.length);
    }

  state.starCount = starsInField;
  state.starsAboveHorizon = starsAboveHorizon;
  state.objectsInField = visible.length;

  // Mise à jour des compteurs si ces éléments existent dans le HTML.
  const starCountElement = $("star-count");

  if (starCountElement) {
    starCountElement.textContent = String(starsInField);
  }

  const objectCountElement = $("object-count");

  if (objectCountElement) {
    objectCountElement.textContent = String(visible.length);
  }

  ui.updateReadout();

  if (state.selected) {
    // Réutiliser la position déjà calculée plus haut pour le repère de sélection.
    // Cela évite un second calcul horizontal, voire un second calcul du système solaire,
    // pendant la même image.
    const updated = refreshedSelected;

    if (updated) {
      state.selected = {
        ...state.selected,
        az: updated.az,
        alt: updated.alt
      };

      const card = $("object-card");

      if (card && !card.hidden) {
        ui.updateObjectCard(state.selected);
      }
    }
  }

  updateFinder(date);
  markPerfStage("interface_compteurs_fiche_chercheur");

}

  /* ==========================================================
     CHARGEMENT DES CATALOGUES
     ========================================================== */

  async function loadCatalogues() {
    const results = await Promise.allSettled([
      fetchJson("./data/stars.json"),
      fetchJson("./data/constellations.json"),
      fetchJson("./data/messier.json", true),
      fetchJson("./data/minor-planets.json")
    ]);

    /* ÉTOILES */

    if (results[0].status === "fulfilled") {
      const rows = extractRows(
        results[0].value,
        ["stars", "data", "objects"]
      );

      const unique = new Map();

      for (const raw of rows) {
        const star = normalizeStar(raw);

        if (!star) {
          continue;
        }

        const key = nameKey(star.name);

        if (!key) {
          continue;
        }

        if (!unique.has(key)) {
          unique.set(key, star);
        }
      }

      state.stars = [...unique.values()];
      const reviewCountElement = $("review-stars-count");
      if (reviewCountElement) {
        reviewCountElement.textContent = String(state.stars.filter(star => star.gaia_astrometry_status === "needs_review").length);
      }
      initializeMilkyWay();

      console.info(
        `Atlas : ${state.stars.length} étoiles chargées.`
      );
    } else {
      console.error(
        "Impossible de charger data/stars.json :",
        results[0].reason
      );

      ui.showToast(
        "Échec de stars.json. Vérifie le chemin du catalogue."
      );
    }

    /* CONSTELLATIONS */

    if (results[1].status === "fulfilled") {
      const rows = extractRows(
        results[1].value,
        ["constellations", "data", "objects"]
      );

      state.constellations = rows
        .map(normalizeConstellation)
        .filter(Boolean);

      console.info(
        `Atlas : ${state.constellations.length} constellations chargées.`
      );
    } else {
      console.error(
        "Impossible de charger data/constellations.json :",
        results[1].reason
      );

      ui.showToast(
        "Échec de constellations.json. Vérifie le chemin du catalogue."
      );
    }

    /* OBJETS MESSIER */

    if (results[2].status === "fulfilled") {
      const rows = extractRows(
        results[2].value,
        ["objects", "messier", "data"]
      );

      const unique = new Map();

      for (const raw of rows) {
        const object = normalizeMessier(raw);

        if (object) {
          unique.set(object.id, object);
        }
      }

      state.messier = [...unique.values()];

      console.info(
        `Atlas : ${state.messier.length} objets Messier chargés.`
      );
    } else {
      console.warn(
        "Catalogue Messier absent ou illisible :",
        results[2].reason
      );

      state.messier = [];
    }
    /* PLANÈTES MINEURES — sélection initiale d’astéroïdes numérotés */
    if (results[3].status === "fulfilled") {
      const minorCatalog = results[3].value;
      state.minorPlanetsEpochJD = Number(minorCatalog?.epochJD) || 2461200.5;
      state.minorPlanets = extractRows(minorCatalog, ["objects", "minorPlanets", "data"])
        .filter(body => body && Number.isFinite(Number(body.a)) && Number.isFinite(Number(body.e)) && Number.isFinite(Number(body.i)) && Number.isFinite(Number(body.M0)));
      console.info(`Atlas : ${state.minorPlanets.length} petits corps chargés (astéroïdes, planètes naines et comètes ; orbites képlériennes simplifiées).`);
    } else {
      state.minorPlanets = [];
      console.warn("Catalogue des planètes mineures indisponible :", results[3].reason);
      ui.showToast(t("ui.minorPlanetsCatalogUnavailable"));
    }
    persistDisplayCategoryPreferences(state.displayCategories);

    try {
      const ngcData = await fetchJson("./data/ngc-not-messier.json", true);
      state.ngc = extractRows(ngcData, ["objects", "ngc", "data"])
        .filter(object => object && Number.isFinite(Number(object.ra)) && Number.isFinite(Number(object.dec)) && object.name && object.id);
      console.info(`Atlas : ${state.ngc.length} objets NGC hors Messier chargés.`);
    } catch (error) {
      state.ngc = [];
      console.warn("Catalogue NGC facultatif indisponible :", error);
    }

    initializeMilkyWay();
    drawSky();

    if (state.stars.length === 0) {
      ui.showToast(
        "Aucune étoile valide dans stars.json."
      );
    } else if (state.constellations.length === 0) {
      ui.showToast(
        "Étoiles chargées, mais aucune constellation."
      );
    } else {
      ui.showToast(
        `${state.stars.length} étoiles et ` +
        `${state.constellations.length} constellations chargées.`
      );
    }
  }

  /* ==========================================================
     INITIALISATION
     ========================================================== */

  ui.bindControls();

  initializeBackground();
  initializeLandscape();
  initializeMilkyWay();

  ui.updateClock();
  ui.updateLocationLabel();

  window.addEventListener("resize", resizeCanvas);

  window.addEventListener(
    "orientationchange",
    () => {
      window.setTimeout(resizeCanvas, 250);
    }
  );

  document.addEventListener(
    "fullscreenchange",
    () => {
      if (
        !document.fullscreenElement &&
        state.immersive
      ) {
        state.immersive = false;

        const app = $("app");

        if (app) {
          app.classList.remove(
            "immersive",
            "show-exit"
          );
        }

        resizeCanvas();
      }
    }
  );

  document.addEventListener(
    "visibilitychange",
    () => {
      if (!document.hidden) {
        ui.updateClock();
        resizeCanvas();
        drawSky();
      }
    }
  );

  const reviewToggle = $("review-stars-toggle");
  const reviewPanel = $("review-stars-panel");
  const reviewList = $("review-stars-list");
  const reviewClose = $("review-stars-close");
  const reviewStarNames = {
    21281: "α Doradus", 57936: "β Hydrae", 58484: "ε Chamaeleontis",
    71795: "ζ Boötis", 73273: "β Lupi", 92041: "φ Sagittarii"
  };
  function renderReviewStarsList() {
    if (!reviewList) return;
    const stars = state.stars.filter(star => star.gaia_astrometry_status === "needs_review")
      .sort((a, b) => Number(a.hip) - Number(b.hip));
    reviewList.replaceChildren();
    for (const star of stars) {
      const hip = Number(star.hip);
      const pos = starHorizontalPosition(star, state.observationDate || new Date());
      const status = !Number.isFinite(pos.alt) ? "Position indisponible" : pos.alt <= 0 ? "Sous l’horizon" : "Au-dessus de l’horizon";
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.innerHTML = `<span><span class="review-star-name">HIP ${hip} · ${reviewStarNames[hip] || star.name || t("ui.star")}</span><br><small>${star.name || t("ui.hipparcosCatalogue")}</small></span><span class="review-star-status">${status}</span>`;
      button.addEventListener("click", () => {
        const currentPos = starHorizontalPosition(star, state.observationDate || new Date());
        state.selected = { ...star, type: "star", name: reviewStarNames[hip] || star.name, az: currentPos.az, alt: currentPos.alt };
        ui.updateObjectCard(state.selected);
        const card = $("object-card");
        if (card) card.hidden = false;
        if (Number.isFinite(currentPos.alt) && currentPos.alt > 0) {
          state.heading = currentPos.az;
          state.pitch = Math.max(-5, Math.min(85, currentPos.alt));
          drawSky();
        } else {
          ui.showToast(t("ui.starBelowHorizonNotDrawn"));
        }
        reviewPanel.hidden = false;
      });
      li.append(button);
      reviewList.append(li);
    }
    const count = $("review-stars-count");
    if (count) count.textContent = String(stars.length);
  }
  reviewToggle?.addEventListener("click", () => {
    const opening = reviewPanel?.hidden ?? true;
    if (reviewPanel) reviewPanel.hidden = !opening;
    reviewToggle.setAttribute("aria-pressed", String(opening));
    reviewToggle.classList.toggle("is-active", opening);
    if (opening) {
      renderReviewStarsList();
    } else {
      state.reviewStarsOnly = false;
      drawSky();
    }
  });
  function closeReviewStarsPanel() {
    if (reviewPanel) reviewPanel.hidden = true;
    reviewToggle?.setAttribute("aria-pressed", "false");
    reviewToggle?.classList.remove("is-active");
    // La liste est aussi un filtre temporaire : à sa fermeture, restaurer toutes les étoiles.
    state.reviewStarsOnly = false;
    drawSky();
  }
  reviewClose?.addEventListener("click", closeReviewStarsPanel);

  resizeCanvas();

  loadCatalogues().then(() => renderReviewStarsList()).catch(error => {
    console.error(
      "Erreur de chargement des catalogues :",
      error
    );

    ui.showToast(
      "Erreur de chargement des catalogues."
    );
  });

  /*
   * Enregistrement du service worker.
   * Le site doit être servi via HTTPS ou localhost.
   */
  // Indique clairement l'état réseau : l'atlas et ses catalogues mis en cache
  // restent disponibles hors ligne, mais les prévisions météo nécessitent Internet.
  const updateConnectionStatus = () => {
    const indicator = document.getElementById("connection-status");
    if (!indicator) return;
    const online = navigator.onLine;
    indicator.textContent = online ? "En ligne" : "Hors ligne";
    indicator.classList.toggle("is-offline", !online);
    indicator.setAttribute("aria-label", online
      ? "Connexion Internet disponible"
      : t("ui.offlineLiveWeatherUnavailable"));
  };
  window.addEventListener("online", updateConnectionStatus);
  window.addEventListener("offline", updateConnectionStatus);
  updateConnectionStatus();

  // v411 — garder l’horloge Découverte séparée du menu mobile, même après son animation.
  // Mobile : placer l’horloge juste au-dessus du menu inférieur, même si celui-ci
  // se replie ou s’agrandit. Bureau : reprendre exactement la largeur et l’alignement
  // du bloc « Direction observée », avec un petit espace entre les deux.
  const discoveryClockElement = $("discovery-local-time");
  const discoveryPanelElement = $("discovery-panel");
  const skyReadoutElement = document.querySelector("#app .sky-readout");
  // appElement est déjà défini en tête de ce module.

  const positionDiscoveryClock = () => {
    if (!discoveryClockElement || !appElement) return;
    if (!appElement.classList.contains("discovery-mode")) {
      // Hors mode Découverte, rendre à « Direction observée » sa position CSS d'origine.
      skyReadoutElement?.style.removeProperty("top");
      return;
    }
    if (getComputedStyle(discoveryClockElement).display === "none") return;

    const clockRect = discoveryClockElement.getBoundingClientRect();
    if (!clockRect.height) return;

    const mobileLayout = window.matchMedia("(max-width: 800px)").matches;
    discoveryClockElement.style.setProperty("position", "fixed");
    discoveryClockElement.style.setProperty("bottom", "auto");

    if (mobileLayout) {
      skyReadoutElement?.style.removeProperty("top");
      // La largeur reste compacte sur téléphone ; on aligne son bord droit sur le menu.
      discoveryClockElement.style.removeProperty("width");
      discoveryClockElement.style.setProperty("min-width", "0");
      discoveryClockElement.style.setProperty("max-width", "44vw");
      discoveryClockElement.style.setProperty("text-align", "right");
      discoveryClockElement.style.setProperty("align-items", "flex-end");

      const menuRect = discoveryPanelElement && !discoveryPanelElement.hidden
        ? discoveryPanelElement.getBoundingClientRect()
        : null;
      if (menuRect && menuRect.width > 0 && menuRect.height > 0) {
        const refreshedClockRect = discoveryClockElement.getBoundingClientRect();
        // Le panneau mobile peut se replier ou se déployer avec une transition.
        // Une marge nette évite que l’ombre de l’horloge empiète visuellement sur le menu.
        const gap = 16;
        const top = Math.max(8, menuRect.top - refreshedClockRect.height - gap);
        const left = Math.max(8, Math.min(window.innerWidth - refreshedClockRect.width - 8,
          menuRect.right - refreshedClockRect.width));
        discoveryClockElement.style.setProperty("left", `${left}px`);
        discoveryClockElement.style.setProperty("right", "auto");
        discoveryClockElement.style.setProperty("top", `${top}px`);
      } else {
        // Repli si le panneau Découverte est temporairement masqué.
        discoveryClockElement.style.setProperty("left", "auto");
        discoveryClockElement.style.setProperty("right", "12px");
        discoveryClockElement.style.setProperty("top", "auto");
        discoveryClockElement.style.setProperty("bottom", "calc(var(--mobile-toolbar-height, 42px) + env(safe-area-inset-bottom, 0px) + 16px)");
      }
      return;
    }

    // Bureau : copie les dimensions et le bord gauche du bloc Direction observée.
    if (!skyReadoutElement) return;
    const readoutRect = skyReadoutElement.getBoundingClientRect();
    if (!readoutRect.width || !readoutRect.height) return;
    // Le haut de l'heure locale est calé sur le haut du menu Découverte (à droite) ;
    // « Direction observée » vient juste dessous. Sans menu visible, on garde la
    // position CSS d'origine du bloc Direction observée.
    const menuRectDesktop = discoveryPanelElement && !discoveryPanelElement.hidden
      ? discoveryPanelElement.getBoundingClientRect()
      : null;
    let top;
    if (menuRectDesktop && menuRectDesktop.width > 0 && menuRectDesktop.height > 0) {
      top = Math.max(8, menuRectDesktop.top);
      skyReadoutElement.style.setProperty("top", `${top + clockRect.height + 8}px`, "important");
    } else {
      skyReadoutElement.style.removeProperty("top");
      top = Math.max(8, skyReadoutElement.getBoundingClientRect().top - clockRect.height - 8);
    }
    discoveryClockElement.style.setProperty("left", `${readoutRect.left}px`);
    discoveryClockElement.style.setProperty("right", "auto");
    discoveryClockElement.style.setProperty("top", `${top}px`);
    discoveryClockElement.style.setProperty("width", `${readoutRect.width}px`);
    discoveryClockElement.style.setProperty("min-width", "0");
    discoveryClockElement.style.setProperty("max-width", "none");
    discoveryClockElement.style.setProperty("text-align", "left");
    discoveryClockElement.style.setProperty("align-items", "flex-start");
  };

  const scheduleDiscoveryClockPosition = () => window.requestAnimationFrame(positionDiscoveryClock);
  window.addEventListener("resize", scheduleDiscoveryClockPosition, { passive: true });
  window.addEventListener("orientationchange", scheduleDiscoveryClockPosition);
  window.addEventListener("load", scheduleDiscoveryClockPosition, { once: true });

  // La géométrie du panneau évolue pendant son animation de repli/déploiement.
  // Recalculer à la fin évite que l’horloge garde la position intermédiaire.
  if (discoveryPanelElement) {
    discoveryPanelElement.addEventListener("transitionend", event => {
      if (event.target === discoveryPanelElement && ["transform", "translate", "bottom", "height"].includes(event.propertyName)) {
        scheduleDiscoveryClockPosition();
      }
    });
    discoveryPanelElement.addEventListener("transitioncancel", event => {
      if (event.target === discoveryPanelElement) scheduleDiscoveryClockPosition();
    });
  }

  if ("ResizeObserver" in window) {
    const discoveryClockResizeObserver = new ResizeObserver(scheduleDiscoveryClockPosition);
    if (discoveryPanelElement) discoveryClockResizeObserver.observe(discoveryPanelElement);
    if (skyReadoutElement) discoveryClockResizeObserver.observe(skyReadoutElement);
    if (discoveryClockElement) discoveryClockResizeObserver.observe(discoveryClockElement);
  }
  if ("MutationObserver" in window && appElement) {
    const discoveryClockModeObserver = new MutationObserver(() => {
      scheduleDiscoveryClockPosition();
      // Fallback pour les navigateurs qui ne signalent pas la fin de la transition.
      window.setTimeout(scheduleDiscoveryClockPosition, 360);
    });
    discoveryClockModeObserver.observe(appElement, { attributes: true, attributeFilter: ["class"] });
    if (discoveryPanelElement) {
      discoveryClockModeObserver.observe(discoveryPanelElement, { attributes: true, attributeFilter: ["class", "hidden", "style"] });
    }
  }
  scheduleDiscoveryClockPosition();

  if (
    "serviceWorker" in navigator &&
    location.protocol !== "file:"
  ) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("./service-worker.js")
        .catch(error => {
          console.warn("Service worker :", error);
        });
    });
  }

  /*
   * Rafraîchissement de l'horloge et des positions.
   */
  refreshAutoHeading();
  drawSky();

  window.setInterval(() => {
    ui.updateClock();
    drawSky();

    if (
      state.sensorActive &&
      Date.now() - state.lastOrientationTime > 2500
    ) {
      state.sensorActive = false;

      const status = $("status");

      if (status) {
        status.textContent = t("ui.signalLost");
      }
    }
  }, 1000);

  console.info(
    t("ui.initializationComplete")
  );
})();
