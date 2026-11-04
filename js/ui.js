
"use strict";

import { clamp, norm360 } from "./astronomy.js";
import { calculateRiseTransitSet as calculateRiseTransitSetAt } from "./rise-transit-set.js";
import { rankVisibleTargets } from "./visible-target-ranking.js";
import { filterVisibleTargets } from "./visible-target-filters.js";
import { buildTonightSelection, isPrioritySolarTarget } from "./tonight-recommendations.js";
import { assessObservingDifficulty } from "./observing-difficulty.js";
import { angularSeparationDeg, buildStarHopRoute, formatStarHopTargetLabel, recommendedStarHopMaxDeg, selectTargetGuideStar } from "./star-hop-route.js";
import { SOLAR_PLANETS, getLocalizedSolarPlanet, calculateSolarOrbitPosition, calculateSolarOrbitPositions } from "./solar-system-orbits.js";
import { t, getLocale, getDataLocale } from "./i18n.js";

export function createUI({
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
  getVisibleNowObjects,
  getCatalogObjects,
  getStarPosition,
  onObservationDateChange,
  selectTarget,
  resizeCanvas,
  updateClock,
  updateLocationLabel,
  updateReadout
}) {
  let toastTimer = null;
  let controlsBound = false;
  let canvasBound = false;
  let sensorActivationPending = false;
  // Mémorise l’interface qui a lancé le guidage pour y revenir à la fermeture.
  let finderReturnTo = "object-card";
  // openStarHop est défini dans bindControls() ; closeFinder() est à la portée de createUI().
  // Ce relais évite un ReferenceError au retour du chercheur vers le guide de cheminement.
  let openStarHopHandler = null;
  // Vrai lorsque « Maintenant » désigne le temps réel. La date du panneau ne
  // commande alors pas une date figée sur la carte quand on choisit une cible.
  let visibleNowPanelFollowsRealtime = false;
  // Actualisé par les balades ; ne touche jamais au rendu de la carte.
  let refreshSkyWalkAvailability = () => {};
  // Renseigné par bindControls : replie le menu Découverte quand le guidage démarre.
  let collapseDiscoveryPanelAfterGuideStart = () => {};
  let refreshLocalePanels = () => {};

  /* ==========================================================
     OUTILS
     ========================================================== */

  function showToast(message) {
    const element = $("toast");

    if (!element) {
      console.info("[Atlas]", message);
      return;
    }

    element.textContent = message;
    element.classList.add("show");

    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {
      element.classList.remove("show");
    }, 3500);
  }

  function on(ids, eventName, handler) {
    const list = Array.isArray(ids) ? ids : [ids];

    const elements = list
      .map(id => $(id))
      .filter(Boolean);

    elements.forEach(element => {
      element.addEventListener(eventName, handler);
    });

    return elements[0] || null;
  }

  function setText(id, value) {
    const element = $(id);

    if (element) {
      element.textContent = String(value);
    }
  }

  function setHidden(id, hidden) {
    const element = $(id);

    if (element) {
      element.hidden = Boolean(hidden);
    }
  }

  // Affichage mobile déterministe des champs datetime-local : date française et heure 24 h.
  function updateLocalizedDateTimeDisplay(inputId, outputId) {
    const input = document.getElementById(inputId);
    const output = document.getElementById(outputId);
    if (!input || !output) return;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(input.value || "");
    const datePart = match ? new Intl.DateTimeFormat(getLocale(), { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)) : t("ui.datePlaceholder");
    output.textContent = match ? `${datePart}, ${match[4]}:${match[5]}:${(match[6] || "00").padEnd(2, "0").slice(0, 2)}` : `${datePart}, --:--:--`;
  }
  function setupLocalizedDateTimeDisplays() {
    document.addEventListener("localechange", () => {
      for (const [inputId, outputId] of [["observation-datetime", "observation-datetime-display"], ["visible-now-datetime", "visible-now-datetime-display"], ["moon-datetime", "moon-datetime-display"], ["jupiter-moons-datetime", "jupiter-moons-datetime-display"]]) updateLocalizedDateTimeDisplay(inputId, outputId);
    });
    for (const [inputId, outputId] of [["observation-datetime", "observation-datetime-display"], ["visible-now-datetime", "visible-now-datetime-display"], ["moon-datetime", "moon-datetime-display"], ["jupiter-moons-datetime", "jupiter-moons-datetime-display"]]) {
      const input = document.getElementById(inputId);
      if (!input) continue;
      const refresh = () => updateLocalizedDateTimeDisplay(inputId, outputId);
      input.addEventListener("input", refresh);
      input.addEventListener("change", refresh);
      refresh();
    }
  }
  setupLocalizedDateTimeDisplays();

  function safely(name, callback) {
    try {
      const result = callback();

      if (result && typeof result.catch === "function") {
        result.catch(error => {
          console.error(`[Atlas] ${name} :`, error);
          showToast(`${name} : ${t("ui.operationImpossible")}.`);
        });
      }

      return result;
    } catch (error) {
      console.error(`[Atlas] ${name} :`, error);
      showToast(`${name} : ${t("ui.operationImpossible")}.`);
      return undefined;
    }
  }

  /* ==========================================================
     HORLOGE
     ========================================================== */

  function refreshClock() {
    if (typeof updateClock === "function") {
      updateClock();
    }

    const now = state.observationDate || new Date();

    setText(
      "clock",
      now.toLocaleTimeString(getLocale(), { hourCycle: "h23" })
    );

    setText(
      "date-label",
      now.toLocaleDateString(getLocale(), {
        weekday: "short",
        day: "2-digit",
        month: "short",
        year: "numeric"
      })
    );
    refreshVisibleNow();
    refreshSkyWalkAvailability();
  }

  /* ==========================================================
     LOCALISATION
     ========================================================== */

  function refreshLocationLabel() {
    if (typeof updateLocationLabel === "function") {
      updateLocationLabel();
    }

    const lat = Number(state.latitude);
    const lon = Number(state.longitude);

    if (
      Number.isFinite(lat) &&
      Number.isFinite(lon)
    ) {
      const coordinates =
        `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;

      // Les coordonnées initiales sont une valeur de secours,
      // pas une position GPS confirmée.
      const label = state.locationName || (state.locationReady
        ? coordinates
        : t("ui.defaultPosition"));

      setText("location", label);
      setText("location-coordinates", coordinates);
      setText("location-label", coordinates);
    }
  }

  function locate() {
    if (typeof locateUser !== "function") {
      showToast(t("ui.geolocationModuleUnavailable"));
      return;
    }

    safely(t("ui.geolocation"), () => locateUser());
  }

  /* ==========================================================
     BOUSSOLE ET CAPTEURS
     ========================================================== */

  function syncSensorButton() {
    const active = Boolean(state.orientationListening);
    const buttons = [$("orientation-btn"), $("discovery-compass-toggle")].filter(Boolean);
    for (const button of buttons) {
      button.setAttribute("aria-pressed", String(active));
      button.classList.toggle("active", active);
      const label = sensorActivationPending
        ? t("ui.compassPermissionPending")
        : active ? t("ui.disableCompass") : t("ui.activateCompass");
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
      const spans = button.querySelectorAll("span");
      if (button.id === "orientation-btn" && spans.length > 1) {
        spans[1].textContent = sensorActivationPending ? t("ui.permissionPending") : active ? t("ui.stopCompass") : t("ui.compass");
      }
      button.disabled = sensorActivationPending;
    }
  }

  function enableSensors() {
    if (state.orientationListening) {
      stopSensors();
      return;
    }

    if (sensorActivationPending) return;

    if (
      typeof sensors?.enableOrientation !== "function"
    ) {
      showToast(t("ui.compassModuleUnavailable"));
      return;
    }

    sensorActivationPending = true;
    syncSensorButton();

    safely(t("ui.compassActivation"), () => {
      return Promise.resolve(sensors.enableOrientation()).finally(() => {
        sensorActivationPending = false;
        syncSensorButton();
      });
    });
  }

  function recenter() {
    if (typeof sensors?.recenter !== "function") {
      showToast(t("ui.sensorRecenterUnavailable"));
      return;
    }

    safely(t("ui.sensorRecentering"), () => {
      sensors.recenter();
    });
  }

  function stopSensors() {
    if (typeof sensors?.stopListening === "function") {
      safely(t("ui.stopSensors"), () => {
        sensors.stopListening();
      });
    }

    state.sensorActive = false;
    state.orientationListening = false;
    syncSensorButton();
    setText("status", t("ui.sensorsDisabled"));
    setText("status", t("ui.sensorsDisabled"));
  }

  /* ==========================================================
     AFFICHAGE DES VALEURS
     ========================================================== */

  function refreshReadout() {
    if (typeof updateReadout === "function") {
      updateReadout();
    }

    const heading = Number(state.heading) || 0;
    const pitch = Number(state.pitch) || 0;

    setText(
      "heading",
      `${Math.round(norm360(heading))}°`
    );

    // Points cardinaux : SO et O deviennent SW et W en anglais
    const cardinals = ["north", "northEast", "east", "southEast", "south", "southWest", "west", "northWest"]
      .map(direction => t(`ui.cardinalDirections.${direction}`));
    setText(
      "cardinal",
      cardinals[Math.round(norm360(heading) / 45) % 8]
    );

    setText(
      "altitude-info",
      `${t("readout.pitch")} ${pitch.toFixed(1)}°`
    );

  }

  /* ==========================================================
     FICHE OBJET
     ========================================================== */

  function displayObjectName(value, fallback = t("ui.celestialObject")) {
    // Les catalogues peuvent fournir un nom imbriqué dans un objet. Chercher
    // récursivement une vraie chaîne et refuser explicitement la conversion
    // générique « [object Object] ».
    const localeKeys = getDataLocale() === "en"
      ? ["en", "englishName", "english_name", "name_en", "common_name_en", "proper_name_en", "name", "label", "designation", "id", "fr", "name_fr"]
      : ["fr", "name_fr", "common_name_fr", "commonNameFr", "name", "common_name", "commonName", "proper_name", "properName", "label", "designation", "id", "en", "englishName", "english_name"]; 
    const preferredKeys = localeKeys;
    const read = (candidate, depth = 0, seen = new Set()) => {
      if (typeof candidate === "string" || typeof candidate === "number") {
        const text = String(candidate).trim();
        return text && text.toLocaleLowerCase("en-US") !== "[object object]" ? text : "";
      }
      if (!candidate || typeof candidate !== "object" || depth >= 4 || seen.has(candidate)) return "";
      seen.add(candidate);
      if (Array.isArray(candidate)) {
        for (const item of candidate) { const found = read(item, depth + 1, seen); if (found) return found; }
        return "";
      }
      for (const key of preferredKeys) {
        if (Object.prototype.hasOwnProperty.call(candidate, key)) {
          const found = read(candidate[key], depth + 1, seen);
          if (found) return found;
        }
      }
      for (const nested of Object.values(candidate)) {
        const found = read(nested, depth + 1, seen);
        if (found) return found;
      }
      return "";
    };
    return read(value) || read(fallback) || t("ui.celestialObject");
  }

  function localizedObjectName(object, fallback = "") {
    if (!object || typeof object !== "object") return displayObjectName(object, fallback);
    const id = String(object.id || object.designation || "").trim();
    const compactId = id.toUpperCase().replace(/\s+/g, "");
    const catalogueKey = `catalogueNames.${compactId}`;
    const catalogueName = t(catalogueKey);
    if (catalogueName !== catalogueKey) return catalogueName;
    const minorPlanetId = ({
      "(1)": "ceres", "(2)": "pallas", "(3)": "juno", "(4)": "vesta", "(6)": "hebe",
      "(7)": "iris", "(8)": "flora", "(9)": "metis", "(10)": "hygiea", "(15)": "eunomia",
      "(16)": "psyche", "(29)": "amphitrite", "(433)": "eros", "(134340)": "pluto",
      "(136199)": "eris", "(136108)": "haumea", "(136472)": "makemake",
      "2P/ENCKE": "encke", "1P/HALLEY": "halley", "67P/CHURYUMOV-GERASIMENKO": "churyumovGerasimenko",
      "C/1995O1HALE-BOPP": "haleBopp", "C/2020F3NEOWISE": "neowise", "161P/HARTLEY-IRAS": "hartleyIras"
    })[compactId.replace(/\s+/g, "")];
    if (minorPlanetId) {
      const key = `names.minorPlanet.${minorPlanetId}`;
      const translated = t(key);
      if (translated !== key) return translated;
    }
    if (getDataLocale() === "en") {
      const english = object.englishName || object.english_name || object.name_en || object.common_name_en || object.proper_name_en;
      if (english) return displayObjectName(english, fallback);
    }
    const type = String(object.type || "").toLowerCase();
    const planetId = String(object.planetId || object.id || "").toLowerCase();
    if (["sun", "moon", "planet"].includes(type) || object.catalogue === "Système solaire") {
      const key = `names.planet.${type === "sun" ? "sun" : type === "moon" ? "moon" : planetId}`;
      const translated = t(key);
      if (translated !== key) return translated;
    }
    return displayObjectName(getDataLocale() === "en"
      ? (object.englishName || object.english_name || object.name_en || object.name || object.proper_name || object.id)
      : (object.name_fr || object.name || object.proper_name || object.id), fallback);
  }

  function localizedCatalogueName(value) {
    const raw = String(value || "").trim();
    const normalized = raw.toLocaleLowerCase(getLocale());
    const keys = {
      "messier": "catalogue.messier", "ngc": "catalogue.ngc", "hipparcos": "catalogue.hipparcos",
      "système solaire": "catalogue.solarSystem", "solar system": "catalogue.solarSystem",
      "planètes mineures": "catalogue.minorPlanets", "minor planets": "catalogue.minorPlanets",
      "planètes naines": "catalogue.dwarfPlanets", "dwarf planets": "catalogue.dwarfPlanets",
      "comètes": "catalogue.comets", "comets": "catalogue.comets"
    };
    const key = keys[normalized];
    return key ? t(key) : raw;
  }

  function updateObjectCard(object) {
    if (!object) {
      setHidden("object-card", true);
      return;
    }

    const name = localizedObjectName(object, displayObjectName(object.proper_name, displayObjectName(object.id, displayObjectName(object.designation))));
    const typeNames = {
      star: t("ui.star"), planet: t("ui.planet"), sun: t("ui.sun"), moon: t("ui.moon"),
      galaxy: t("ui.galaxy"), nebula: t("ui.nebula"), cluster: t("ui.starCluster"),
      "deep-sky": t("ui.deepSkyObject"), "minor-planet": t("ui.minorPlanet"), "dwarf-planet": t("ui.dwarfPlanet"), comet: t("ui.comet")
    };
    setText("object-name", name);
    $("object-name")?.setAttribute("aria-label", `${t("ui.objectName")}: ${name}`);
    const objectTypeLabel = typeNames[object.type] || object.type || t("ui.celestialObject");
    setText("object-type", objectTypeLabel);
    const discoveryMode = Boolean($("app")?.classList.contains("discovery-mode"));

    // Le guidage n'est proposé que lorsque la cible est au-dessus de l'horizon.
    // Si l'altitude n'est pas disponible, on conserve le comportement existant.
    const selectedGuideButton = $("guide-selected");
    if (selectedGuideButton && Number.isFinite(Number(object.alt))) {
      setHidden("guide-selected", Number(object.alt) <= 0);
    } else {
      setHidden("guide-selected", false);
    }

    const detail = [];
    const constellationLabel = localizedConstellationValue(object.constellation) || findConstellationName(object);
    if (discoveryMode) {
      detail.push(objectTypeLabel);
      if (constellationLabel) detail.push(`${t("ui.inConstellation")} ${constellationLabel}`);
      setText("object-detail", detail.join(" · ") || t("ui.newStepToExploreSky"));
    } else {
      if (Number.isFinite(object.mag)) detail.push(`${t("ui.apparentMagnitude")} ${object.mag.toLocaleString(getLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
      if (object.catalogue) detail.push(`${t("ui.catalogue")} ${localizedCatalogueName(object.catalogue)}`);
      else if (object.id && /^(M\d+|NGC\s?\d+)/i.test(object.id)) detail.push(object.id);
      if (Number.isFinite(object.ra)) detail.push(`${t("ui.rightAscensionShort")} ${formatHours(object.ra)}`);
      if (Number.isFinite(object.dec)) detail.push(`${t("ui.decLabel")} ${formatDegrees(object.dec)}`);
      setText("object-detail", detail.join(" · ") || t("ui.informationAvailableBelow"));
    }
    $("object-card")?.classList.toggle("is-discovery-card", discoveryMode);
    setText("object-az", Number.isFinite(object.az) ? `${object.az.toFixed(1)}°` : "—");
    setText("object-alt", Number.isFinite(object.alt) ? `${object.alt.toFixed(1)}°` : "—");

    const extra = $("object-extra");
    if (extra) {
      // updateObjectCard est rappelée périodiquement avec l’actualisation du ciel.
      // Préserver l’état du panneau <details> évite qu’une aide ouverte se referme.
      const termsWereOpen = Boolean(extra.querySelector(".object-terms-help")?.open);
      const modesWereOpen = Boolean(extra.querySelector(".object-viewing-modes")?.open);
      const rows = [];
      const add = (label, value) => {
        if (value === undefined || value === null) return;
        // Conserver les tableaux structurés : les convertir en chaîne ici
        // produit « [object Object] » et empêche le rendu de la liste cliquable.
        if (Array.isArray(value)) { if (value.length) rows.push([label, value]); return; }
        if (String(value).trim() !== "") rows.push([label, String(value)]);
      };
      const id = String(object.id || object.catalogue || "").toUpperCase().replace(/\s+/g, "");
      const lowerName = name.toLocaleLowerCase(getLocale());
      // Textes historiques conservés pour le Mode Expert : ne pas les modifier.
      const objectText = (section, key) => {
        const value = t(`objectText.${section}.${key}`);
        return value.startsWith("objectText.") ? "" : value;
      };
      const descriptions = { LUNE: objectText("descriptions", "LUNE"), SOLEIL: objectText("descriptions", "SOLEIL") };
      const normalizedName = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleUpperCase(getLocale());
            // Descriptions courtes (Mode Expert)
      const expertFallback = object.type === "star" ? t("ui.expertStar") :
        object.type === "planet" ? t("ui.expertPlanet") :
        object.type === "dwarf-planet" ? t("ui.expertDwarfPlanet") :
        object.type === "comet" ? t("ui.expertComet") :
        object.type === "minor-planet" ? t("ui.expertMinorPlanet") :
        object.type === "galaxy" ? t("ui.expertGalaxy") :
        object.type === "nebula" ? t("ui.expertNebula") :
        object.type === "cluster" ? t("ui.expertCluster") :
        object.type === "moon" ? descriptions.LUNE : object.type === "sun" ? descriptions.SOLEIL : t("ui.expertGeneric");

      // Descriptions longues (Mode Découverte)
      const inConst = constellationLabel ? ` ${t("ui.inConstellation")} ${constellationLabel}` : "";
      const discoveryFallback = object.type === "star" ? `${name}${t("ui.discoveryStar1")}${inConst}${t("ui.discoveryStar2")}` :
        object.type === "planet" ? `${name}${t("ui.discoveryPlanet")}` :
        object.type === "dwarf-planet" ? `${name}${t("ui.discoveryDwarfPlanet")}` :
        object.type === "comet" ? `${name}${t("ui.discoveryComet")}` :
        object.type === "minor-planet" ? `${name}${t("ui.discoveryMinorPlanet")}` :
        object.type === "galaxy" ? `${name}${t("ui.discoveryGalaxy")}` :
        object.type === "nebula" ? `${name}${t("ui.discoveryNebula")}` :
        object.type === "cluster" ? `${name}${t("ui.discoveryCluster")}` :
        object.type === "moon" ? descriptions.LUNE : object.type === "sun" ? descriptions.SOLEIL : `${name}${t("ui.discoveryGeneric")}`;
      const description = discoveryMode
        ? (objectText("discoveryDescriptions", id) || objectText("discoveryDescriptions", normalizedName) || objectText("descriptions", id) || objectText("descriptions", id.replace(/^NGC/, "NGC")) || discoveryFallback)
        : (objectText("descriptions", id) || objectText("descriptions", id.replace(/^NGC/, "NGC")) || expertFallback);
      // Placer le conseil en premier pour qu'il soit visible plus tôt sur les petits écrans.
      add(t("ui.observingAdvice"), objectText("observingAdvice", object.type) || objectText("observingAdvice", "deep-sky"));
      add(t("ui.description"), description);
      extra?.setAttribute("aria-label", t("ui.objectDescription"));

      const fact = objectText("discoveryFacts", id) || objectText("discoveryFacts", normalizedName);
      add(t("ui.smallChallenge"), objectText("discoveryChallenges", object.type) || objectText("discoveryChallenges", "deep-sky"));

      const viewingModes = {
        star: [t("ui.eyeStars"), t("ui.binocularsStars"), t("ui.telescopeStars"), t("ui.photoStars")],
        planet: [t("ui.eyePlanet"), t("ui.binocularsPlanet"), t("ui.telescopePlanet"), t("ui.photoPlanet")],
        moon: [t("ui.eyeMoon"), t("ui.binocularsMoon"), t("ui.telescopeMoon"), t("ui.photoMoon")],
        sun: [t("ui.eyeSun"), t("ui.binocularsSun"), t("ui.telescopeSun"), t("ui.photoSun")],
        galaxy: [t("ui.eyeGalaxy"), t("ui.binocularsGalaxy"), t("ui.telescopeGalaxy"), t("ui.photoGalaxy")],
        nebula: [t("ui.eyeNebula"), t("ui.binocularsNebula"), t("ui.telescopeNebula"), t("ui.photoNebula")],
        cluster: [t("ui.eyeCluster"), t("ui.binocularsCluster"), t("ui.telescopeCluster"), t("ui.photoCluster")],
        "deep-sky": [t("ui.eyeDeepSky"), t("ui.binocularsDeepSky"), t("ui.telescopeDeepSky"), t("ui.photoDeepSky")]
      };
      const modes = viewingModes[object.type] || viewingModes["deep-sky"];
      const modeCard = document.createElement("details"); modeCard.className = "object-viewing-modes";
      const modeTitle = document.createElement("summary"); modeTitle.textContent = t("ui.whatToExpectByInstrument");
      const modeList = document.createElement("ul");
      for (const text of modes) { const li = document.createElement("li"); li.textContent = text; modeList.append(li); }
      modeCard.append(modeTitle, modeList);
      modeCard.open = modesWereOpen;
      const terms = document.createElement("details"); terms.className = "object-terms-help";
      const summary = document.createElement("summary"); summary.textContent = t("ui.understandSheetData");
      const termText = document.createElement("p"); termText.textContent = t("ui.glossaryTerms");
      terms.append(summary, termText);

      if (object.hip !== undefined && Number.isFinite(Number(object.hip))) add(t("ui.identifier"), `HIP ${object.hip}`);
      else if (object.id && object.id !== name) add(t("ui.catalogue"), object.id);

      // Notes éditoriales des petits corps : leur contenu est centralisé dans i18n.
      const minorPlanetSlugs = {
        "(1)": "ceres", "(2)": "pallas", "(3)": "juno", "(4)": "vesta", "(6)": "hebe",
        "(7)": "iris", "(8)": "flora", "(9)": "metis", "(10)": "hygiea", "(15)": "eunomia",
        "(16)": "psyche", "(29)": "amphitrite", "(433)": "eros", "(134340)": "pluto",
        "(136199)": "eris", "(136108)": "haumea", "(136472)": "makemake",
        "2P/ENCKE": "encke", "1P/HALLEY": "halley", "67P/CHURYUMOV-GERASIMENKO": "churyumovGerasimenko",
        "C/1995O1HALE-BOPP": "haleBopp", "C/2020F3NEOWISE": "neowise", "161P/HARTLEY-IRAS": "hartleyIras"
      };
      const minorPlanetSlug = minorPlanetSlugs[String(object.id || "").toUpperCase().replace(/\s+/g, "")];
      if (minorPlanetSlug) {
        const detailPrefix = object.type === "comet"
          ? `minorPlanetDetails.comets.${minorPlanetSlug}`
          : `minorPlanetDetails.objects.${minorPlanetSlug}`;
        const cometType = t(`${detailPrefix}.type`);
        if (cometType !== `${detailPrefix}.type`) add(t("ui.cometOrbitType"), cometType);
        const noteKey = object.type === "comet" ? `${detailPrefix}.discoveryNote`
          : minorPlanetSlug === "ceres" ? `${detailPrefix}.classificationNote`
          : `${detailPrefix}.orbitNote`;
        const note = t(noteKey);
        if (note !== noteKey) add(t("ui.additionalInformation"), note);
      }

      // Distances indicatives pour quelques objets du ciel profond fréquemment observés.
      // Elles ne remplacent pas une mesure propre à chaque objet et restent volontairement arrondies.
      const approximateDistancesLy = {
        M1: 6500, M13: 22000, M27: 1360, M31: 2537000, M42: 1344,
        M44: 577, M45: 444, M51: 31000000, M57: 2300, M81: 12000000,
        M82: 12000000, M104: 29000000, NGC253: 11400000, NGC5139: 17000,
        NGC4565: 30000000, NGC7000: 2600, NGC7293: 650, NGC6888: 5000
      };
      const distance = Number.isFinite(object.distanceLightYears) ? object.distanceLightYears :
        Number.isFinite(object.distance_ly) ? object.distance_ly :
        (Number.isFinite(approximateDistancesLy[id]) ? approximateDistancesLy[id] : NaN);
      if (Number.isFinite(distance) && distance > 0) {
        const approx = !Number.isFinite(object.distanceLightYears) && !Number.isFinite(object.distance_ly);
        add(t("ui.distance"), `${approx ? t("ui.approximately") : ""}${Math.round(distance).toLocaleString(getLocale())} ${t("ui.lightYears")}`);
        if (!approx && Number.isFinite(object.mag)) {
          const distanceParsecs = distance / 3.26156;
          const absoluteMag = object.mag - 5 * (Math.log10(distanceParsecs) - 1);
          add(t("ui.absoluteMagnitude"), absoluteMag.toFixed(2));
        }
      } else if (object.type === "planet" || object.type === "moon" || object.type === "sun") {
        const distKm = getSolarDistanceKm(object);
        if (Number.isFinite(distKm)) add(t("ui.distance"), `${Math.round(distKm).toLocaleString(getLocale())} km`);
      }

      const angularSizeKeys = {
        M1: "M1", M13: "M13", M27: "M27", M31: "M31", M42: "M42", M44: "M44", M45: "M45", M51: "M51", M57: "M57",
        M81: "M81", M82: "M82", M104: "M104", NGC253: "NGC253", NGC457: "NGC457", "NGC869/884": "NGC869/884",
        NGC1499: "NGC1499", NGC3372: "NGC3372", NGC4755: "NGC4755", NGC5139: "NGC5139", NGC4565: "NGC4565",
        NGC7000: "NGC7000", NGC7293: "NGC7293", NGC6888: "NGC6888"
      };
      const angularSizeKey = angularSizeKeys[id] || angularSizeKeys[id.replace(/\s+/g, "")];
      let apparentSize = angularSizeKey ? t(`ui.angularSizes.${angularSizeKey}`) : "";
      if (!apparentSize && (object.type === "planet" || object.type === "moon" || object.type === "sun")) {
        const diameterKm = ({ sun: 1392700, moon: 3475, mercury: 4879, venus: 12104, mars: 6779, jupiter: 139820, saturn: 116460, uranus: 50724, neptune: 49244 })[String(object.planetId || object.id || "").toLowerCase()];
        const distanceKm = getSolarDistanceKm(object);
        if (diameterKm && Number.isFinite(distanceKm) && distanceKm > diameterKm / 2) {
          const arcsec = 2 * Math.atan(diameterKm / (2 * distanceKm)) * 206264.806;
          apparentSize = arcsec >= 60
            ? `${(arcsec / 60).toLocaleString(getLocale(), { maximumFractionDigits: 1 })} ${t("ui.arcminutes")}`
            : `${arcsec.toLocaleString(getLocale(), { maximumFractionDigits: 1 })} ${t("ui.arcseconds")}`;
        }
      }
      add(t("ui.apparentSize"), apparentSize);

      if (object.type === "star") {
        const spectral = object.spectralType || object.spectral_type || inferSpectralType(object.teff_gspphot);
        add(t("ui.spectralType"), localizeSpectralType(spectral));
        if (Number.isFinite(object.teff_gspphot)) add(t("ui.surfaceTemperature"), `${Math.round(object.teff_gspphot).toLocaleString(getLocale())} K`);
        else if (Number.isFinite(object.temperatureK)) add(t("ui.surfaceTemperature"), `${Math.round(object.temperatureK).toLocaleString(getLocale())} K`);
        if (object.gaia_astrometry_status === "needs_review") {
          add(t("ui.astrometricCheck"), t("ui.toVerifyGaiaAssociation"));
          const reasonKey = object.gaia_astrometry_review_reason_key;
          const localizedReason = reasonKey ? t(`gaiaReviewReasons.${reasonKey}`) : "";
          add(t("ui.checkReason"), localizedReason && localizedReason !== `gaiaReviewReasons.${reasonKey}`
            ? localizedReason
            : (getDataLocale() === "en" ? object.gaia_astrometry_review_reason_en : object.gaia_astrometry_review_reason) || object.gaia_astrometry_review_reason || t("ui.astrometricResidualToExamine"));
          if (Number.isFinite(object.gaia_astrometry_review_residual_arcsec)) {
            add(t("ui.positionResidual"), `${object.gaia_astrometry_review_residual_arcsec.toFixed(3).replace(".", ",")}″`);
          }
        }
        if (object.gaia_source_id) add(t("ui.gaiaDr3Identifier"), object.gaia_source_id);
        if (Number.isFinite(object.gaia_reference_epoch)) add(t("ui.gaiaReferenceEpoch"), object.gaia_reference_epoch.toFixed(1));
        if (Number.isFinite(object.astrometry_epoch)) add(t("ui.catalogueCoordinatesEpoch"), object.astrometry_epoch.toFixed(1));
        const hasPmRa = Number.isFinite(object.pm_ra_cosdec_mas_yr);
        const hasPmDec = Number.isFinite(object.pm_dec_mas_yr);
        if (hasPmRa && hasPmDec) {
          add(t("ui.properMotionRightAscension"), `${object.pm_ra_cosdec_mas_yr.toLocaleString(getLocale(), { maximumFractionDigits: 2 })} mas/${t("ui.yearAbbreviation")}`);
          add(t("ui.properMotionDeclination"), `${object.pm_dec_mas_yr.toLocaleString(getLocale(), { maximumFractionDigits: 2 })} mas/${t("ui.yearAbbreviation")}`);
        } else if (object.gaia_source_id) {
          add(t("ui.gaiaProperMotion"), t("ui.notAvailableInImportedData"));
        }
      }

      if (constellationLabel) add(t("ui.constellationLabel"), constellationLabel);

      const physical = {
        "MERCURE": t("ui.factMercury"),
        "VÉNUS": t("ui.factVenus"),
        "VENUS": t("ui.factVenus"),
        "TERRE": t("ui.factEarth"),
        "MARS": t("ui.factMars"),
        "JUPITER": t("ui.factJupiter"),
        "SATURNE": t("ui.factSaturn"),
        "URANUS": t("ui.factUranus"),
        "NEPTUNE": t("ui.factNeptune"),
        "SOLEIL": t("ui.factSun"),
        "LUNE": t("ui.factMoon")
      };
      const physicalKey = String(object.planetId || object.id || "").toLowerCase();
      const physicalById = { mercury: t("ui.factMercury"), venus: t("ui.factVenus"), earth: t("ui.factEarth"), mars: t("ui.factMars"), jupiter: t("ui.factJupiter"), saturn: t("ui.factSaturn"), uranus: t("ui.factUranus"), neptune: t("ui.factNeptune"), sun: t("ui.factSun"), moon: t("ui.factMoon") };
      const physicalFact = physicalById[physicalKey] || physical[name.toLocaleUpperCase(getLocale())];
      if (physicalFact) add(t("ui.physicalInfo"), physicalFact);
      else if (object.type === "galaxy" || object.type === "nebula" || object.type === "cluster") {
        add(t("ui.nature"), object.type === "galaxy" ? t("ui.starsGasDustGravitationallyBound") : object.type === "nebula" ? t("ui.interstellarGasDust") : t("ui.starClusterOpenOrGlobular"));
      }

      const events = calculateRiseTransitSet(object);
      if (events) {
        add(t("riseTransit.rise"), events.rise);
        add(t("riseTransit.transit"), events.transit);
        add(t("riseTransit.set"), events.set);
      }
      const maximumAltitude = theoreticalMaximumAltitude(object);
      if (Number.isFinite(maximumAltitude)) add(t("ui.maximumTheoreticalAltitude"), `${maximumAltitude.toFixed(1).replace(".", ",")}° ${t("ui.atMeridian")}`);
      if (Number.isFinite(object.alt)) {
        const altitudeLabel = object.alt > 0 ? t("ui.aboveHorizonState") : t("ui.belowHorizonState");
        add(t("ui.skyState"), `${altitudeLabel} (${object.alt.toLocaleString(getLocale(), { maximumFractionDigits: 1 })}°)`);
      }

      const nearby = findNearbyObjects(object);
      if (nearby.length) add(t("ui.nearbyObjects"), nearby);

      if (object.type === "planet") add(t("ui.ephemeris"), t("ui.positionCalculatedForSelectedDate"));
      if (object.type === "sun" || object.type === "moon") add(t("ui.position"), t("ui.calculatedForSelectedDate"));

      const discoveryLabels = new Set(["Constellation", t("ui.nearbyObjects")]);
      const visibleRows = discoveryMode ? rows.filter(([label]) => discoveryLabels.has(label)) : rows;
      const recognitionWasOpen = Boolean(extra.querySelector(".discovery-recognition-help")?.open);
      extra.replaceChildren();
      if (discoveryMode) {
        const photoById = {
          "NGC7000": "NGC-7000.jpg", "NGC2244": "NGC-2244.jpg", "NGC1499": "NGC-1499.jpg",
          "M45": "M45.jpg", "M42": "M42.jpg", "M31": "M31.jpg", "M8": "M8.jpg",
          "IC1805": "IC-1805.jpg", "B33": "B33.jpg"
        };
        const photo = photoById[id.replace(/[^A-Z0-9]/g, "")];
        if (photo) {
          const figure = document.createElement("figure"); figure.className = "discovery-object-photo";
          const img = document.createElement("img"); img.src = `https://seduwa.ch/mysky/photos/${photo}`;
          img.alt = localizedObjectName(object); img.loading = "lazy"; img.decoding = "async";
          img.addEventListener("error", () => figure.remove(), { once: true });
          // Le nom commun est déjà indiqué dans la fiche : pas de légende redondante sous la photo.
          figure.append(img); extra.append(figure);
        }
      }
      if (discoveryMode) {
        // Indicateur pédagogique : combine la hauteur réelle et l'estimation
        // déjà utilisée ailleurs, sans présenter la visibilité comme garantie.
        const altitude = Number(object.alt);
        const difficulty = assessObservingDifficulty(object, "all");
        let visibilityLabel = t("ui.uncertainVisibility");
        let visibilityLevel = "medium";
        let visibilityExplanation = t("ui.maybeVisibleDependsOnConditions");
        if (object.type === "sun") {
          visibilityLabel = t("ui.sunProtectionRequired");
          visibilityLevel = "warning";
          visibilityExplanation = t("ui.neverLookAtSunWithoutFilter");
        } else if (Number.isFinite(altitude) && altitude < 0) {
          visibilityLabel = t("ui.notVisibleYet");
          visibilityLevel = "low";
          visibilityExplanation = t("ui.objectBelowHorizonForSelectedTime");
        } else if (Number.isFinite(altitude) && altitude < 10) {
          visibilityLabel = t("ui.veryLowOnHorizon");
          visibilityLevel = "low";
          visibilityExplanation = t("ui.atmosphereInterferesNearHorizon");
        } else if (Number.isFinite(altitude) && altitude < 20) {
          visibilityLabel = t("ui.lowOnHorizon");
          visibilityLevel = "low";
          visibilityExplanation = t("ui.targetEasierToObserveWhenHigher");
        } else if (difficulty.level === "easy") {
          visibilityLabel = t("ui.easyToSpot");
          visibilityLevel = "easy";
          visibilityExplanation = t("ui.favorableVisibilityExplanation");
        } else if (difficulty.level === "challenging" || difficulty.level === "low") {
          visibilityLabel = t("ui.hardToSpot");
          visibilityLevel = "low";
          visibilityExplanation = t("ui.targetMayRequireDarkSkyOrInstrument");
        } else if (!Number.isFinite(altitude)) {
          visibilityLabel = t("ui.visibilityNotEstimated");
          visibilityLevel = "medium";
          visibilityExplanation = t("ui.altitudeUnavailableExplanation");
        }
        const visibility = document.createElement("div");
        visibility.className = `discovery-visibility is-${visibilityLevel}`;
        const visibilityTitle = document.createElement("strong");
        visibilityTitle.textContent = visibilityLabel;
        const visibilityText = document.createElement("p");
        visibilityText.textContent = visibilityExplanation;
        visibility.append(visibilityTitle, visibilityText);
        extra.append(visibility);

        // v484 — niveau pédagogique distinct du statut de visibilité.
        const level = document.createElement("div");
        const levelTitle = document.createElement("strong");
        const levelText = document.createElement("p");
        const rawLevel = String(difficulty.level || "variable");
        let beginnerLevel = "intermediate";
        let beginnerLabel = t("ui.level2Intermediate");
        let beginnerExplanation = t("ui.planForDarkSkyAndCompareLandmarks");
        if (Number.isFinite(altitude) && altitude < 0) {
          beginnerLevel = "unavailable";
          beginnerLabel = t("ui.reviewLater");
          beginnerExplanation = t("ui.objectBelowHorizonNotATargetNow");
        } else if (object.type === "sun") {
          beginnerLevel = "warning";
          beginnerLabel = t("ui.specializedObservation");
          beginnerExplanation = t("ui.sunOnlyWithCertifiedProtection");
        } else if (rawLevel === "easy") {
          beginnerLevel = "easy";
          beginnerLabel = t("ui.level1Easy");
          beginnerExplanation = t("ui.goodFirstTargetTryNakedEye");
        } else if (rawLevel === "challenging" || rawLevel === "low") {
          beginnerLevel = "challenge";
          beginnerLabel = t("ui.level3Challenge");
          beginnerExplanation = t("ui.targetMayRequireDarkSkyBinocularsOrTelescope");
        }
        level.className = `discovery-object-level is-${beginnerLevel}`;
        levelTitle.textContent = beginnerLabel;
        levelText.textContent = beginnerExplanation;
        level.append(levelTitle, levelText);
        extra.append(level);

        const recognition = document.createElement("details");
        recognition.className = "discovery-recognition-help";
        recognition.open = recognitionWasOpen;
        const summary = document.createElement("summary");
        summary.textContent = t("ui.whatAmILookingAt");
        const explanation = document.createElement("p");
        explanation.textContent = description;
        recognition.append(summary, explanation);
        // Les faits propres à certains objets complètent l'explication au lieu
        // d'être répétés dans une seconde rubrique « Le savais-tu ? ».
        if (fact) {
          const detail = document.createElement("p");
          detail.className = "discovery-recognition-detail";
          detail.textContent = fact;
          recognition.append(detail);
        }
        extra.append(recognition);
      }
      for (const [label, value] of visibleRows) {
        const row = document.createElement("div");
        row.className = "object-extra-row";
        if ([t("ui.description"), t("ui.physicalInfo"), t("ui.nature"), t("ui.nearbyObjects"), t("ui.observingAdvice"), t("ui.didYouKnow"), t("ui.smallChallenge")].includes(label)) row.classList.add("is-long");
        if (label === t("ui.didYouKnow")) row.classList.add("is-discovery-fact");
        if (label === t("ui.smallChallenge")) row.classList.add("is-discovery-challenge");
        if (label === t("ui.observingAdvice")) {
          row.classList.add("is-observing-advice");
          if (object.type === "sun") row.classList.add("is-solar-safety");
        }
        const key = document.createElement("span");
        key.textContent = label;
        if (label === t("ui.nearbyObjects") && Array.isArray(value)) {
          const list = document.createElement("div");
          list.className = "nearby-object-list";
          for (const nearbyObject of value) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "nearby-object-button";
            const nearbyName = localizedObjectName(nearbyObject);
            const separation = Number(nearbyObject.separation);
            const separationLabel = Number.isFinite(separation) ? `${separation.toFixed(1).replace(".", ",")}°` : "";
            button.textContent = separationLabel ? `${nearbyName} · ${separationLabel}` : nearbyName;
            button.setAttribute("aria-label", separationLabel ? `${t("ui.openSheetOf")} ${nearbyName}, ${t("ui.at")} ${separationLabel.replace("°", t("ui.degrees"))}` : `${t("ui.openSheetOf")} ${nearbyName}`);
            button.addEventListener("click", () => {
              // Sélectionner l’objet sans lancer le mode chercheur : l’utilisateur
              // reste dans la fiche et peut poursuivre sa navigation de proche en proche.
              state.selected = { ...nearbyObject };
              updateObjectCard(state.selected);
              setHidden("object-card", false);
              drawSky();
            });
            list.append(button);
          }
          row.append(key, list);
        } else {
          const val = document.createElement("strong");
          val.textContent = value;
          row.append(key, val);
        }
        extra.append(row);
      }
      terms.open = termsWereOpen;
      if (!discoveryMode) extra.append(modeCard, terms);
    }
    setHidden("object-card", false);
  }

  function localizeSpectralType(value) {
    const translations = {
      "bleue-blanche": "blueWhite", "bleue blanche": "blueWhite", "blue-white": "blueWhite", "blue white": "blueWhite",
      "blanche-jaune": "yellowWhite", "blanche jaune": "yellowWhite", "yellow-white": "yellowWhite", "yellow white": "yellowWhite",
      "bleue": "blue", "blue": "blue", "blanche": "white", "white": "white",
      "jaune": "yellow", "yellow": "yellow", "rouge": "red", "red": "red", "orange": "orange"
    };
    return String(value || "").replace(/bleue[- ]blanche|blue[- ]white|blanche[- ]jaune|yellow[- ]white|bleue|blanche|jaune|rouge|blue|white|yellow|red|orange/gi,
      token => t(`ui.spectralColors.${translations[token.toLowerCase()] || "orange"}`));
  }

  function inferSpectralType(temp) {
    if (!Number.isFinite(temp)) return t("ui.notSpecified");
    if (temp >= 30000) return t("ui.spectralO");
    if (temp >= 10000) return t("ui.spectralB");
    if (temp >= 7500) return t("ui.spectralA");
    if (temp >= 6000) return t("ui.spectralF");
    if (temp >= 5200) return t("ui.spectralG");
    if (temp >= 3700) return t("ui.spectralK");
    return t("ui.spectralM");
  }

  function getSolarDistanceKm(object) {
    try {
      const A = window.Astronomy;
      const date = state.observationDate || new Date();
      if (!A || !A.GeoVector || !A.Body) return NaN;
      const key = String(object.planetId || object.id || object.type || "").toLowerCase();
      const bodyName = ({ sun: "Sun", moon: "Moon", mercury: "Mercury", venus: "Venus", mars: "Mars", jupiter: "Jupiter", saturn: "Saturn", uranus: "Uranus", neptune: "Neptune" })[key];
      if (!bodyName || A.Body[bodyName] === undefined) return NaN;
      const v = A.GeoVector(A.Body[bodyName], date, true);
      const au = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      return au * 149597870.7;
    } catch { return NaN; }
  }

  function localizedConstellationName(item) {
    if (!item) return "";
    const id = String(item.id || item.iau || "").trim();
    const key = id ? `catalogueNames.constellations.${id}` : "";
    const translated = key ? t(key) : key;
    if (translated && translated !== key) return translated;
    // Les champs bilingues restent des alias de recherche et un repli sûr.
    return getDataLocale() === "en"
      ? String(item.englishName || item.english_name || item.name || id)
      : String(item.name_fr || item.name || id);
  }

  function localizedConstellationValue(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const normalized = normalizeCatalogSearchText(raw);
    const item = (state.constellations || []).find(candidate =>
      [candidate.id, candidate.name, candidate.name_fr, candidate.englishName, candidate.english_name]
        .some(name => normalizeCatalogSearchText(name) === normalized)
    );
    return item ? localizedConstellationName(item) : raw;
  }

  function findConstellationName(object) {
    const names = {
      11767: t("names.constellation.ursa-minor"), 32349: t("names.constellation.canis-major"), 91262: t("names.constellation.lyra"), 27989: t("names.constellation.orion"),
      24436: t("names.constellation.orion"), 21421: t("names.constellation.taurus"), 69673: t("names.constellation.bootes"), 97649: t("names.constellation.aquila"),
      102098: t("names.constellation.cygnus"), 80763: t("names.constellation.scorpius"), 24608: t("names.constellation.auriga"), 7588: t("names.constellation.eridanus"),
      71683: t("names.constellation.centaurus"), 113368: t("names.constellation.southern-fish")
    };
    return names[Number(object.hip)] || "";
  }

  function findNearbyObjects(target) {
    if (!Number.isFinite(target.ra) || !Number.isFinite(target.dec)) return [];
    const pool = [
      ...(state.stars || []).map(star => ({ ...star, type: star.type || "star" })),
      ...(state.messier || []),
      ...(state.ngc || [])
    ];
    const separation = (a, b) => {
      const r = Math.PI / 180;
      const d1 = a.dec * r, d2 = b.dec * r;
      const cos = Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos((a.ra - b.ra) * 15 * r);
      return Math.acos(Math.max(-1, Math.min(1, cos))) / r;
    };
    const seen = new Set([target.id, target.name]);
    const hasCommonName = o => {
      const candidate = String(o.proper_name || o.common_name || o.name || "").trim();
      if (!candidate) return false;
      const catalogId = String(o.id || o.designation || o.catalogue || "").trim();
      if (/^(?:M\s*\d+|NGC\s*\d+|IC\s*\d+|HIP\s*\d+|HD\s*\d+|SAO\s*\d+|TYC\s*.+|Gaia\s*.+)$/i.test(candidate)) return false;
      if (catalogId && candidate.replace(/\s+/g, "").toUpperCase() === catalogId.replace(/\s+/g, "").toUpperCase()) return false;
      return true;
    };
    return pool.map(o => ({ ...o, separation: separation(target, o) }))
      .filter(o => o.separation > 0.02 && o.separation <= 5 && !seen.has(o.id) && !seen.has(o.name) && hasCommonName(o))
      .sort((a, b) => a.separation - b.separation).slice(0, 3);
  }

  function calculateRiseTransitSet(object) {
    if (!Number.isFinite(object.ra) || !Number.isFinite(object.dec)) return null;
    const date = state.observationDate || new Date();
    const lat = Number(state.latitude);
    const lon = Number(state.longitude);
    return calculateRiseTransitSetAt(object, date, lat, lon, getLocale());
  }

  function theoreticalMaximumAltitude(object) {
    const latitude = Number(state.latitude);
    const declination = Number(object?.dec);
    if (!Number.isFinite(latitude) || !Number.isFinite(declination)) return null;
    return Math.max(-90, Math.min(90, 90 - Math.abs(latitude - declination)));
  }

  function observingWindowSummary(object) {
    const events = calculateRiseTransitSet(object);
    const maxAltitude = theoreticalMaximumAltitude(object);
    const parts = [];
    if (events?.transit && !events.belowHorizon) parts.push(`${t("riseTransit.transit")} ${events.transit}`);
    if (Number.isFinite(maxAltitude)) parts.push(`${t("ui.maxTheoreticalAltitude")} ${Math.round(maxAltitude)}°`);
    return parts.join(" · ");
  }

  function formatHours(hours) {
    const h = ((hours % 24) + 24) % 24;
    const totalSeconds = Math.round(h * 3600) % 86400;
    const hh = Math.floor(totalSeconds / 3600);
    const mm = Math.floor((totalSeconds % 3600) / 60);
    const ss = totalSeconds % 60;
    return `${String(hh).padStart(2, "0")}h ${String(mm).padStart(2, "0")}m ${String(ss).padStart(2, "0")}s`;
  }

  function formatDegrees(degrees) {
    const sign = degrees < 0 ? "−" : "+";
    const abs = Math.abs(degrees);
    const d = Math.floor(abs);
    const minutes = Math.floor((abs - d) * 60);
    const seconds = Math.round((((abs - d) * 60) - minutes) * 60);
    return `${sign}${String(d).padStart(2, "0")}° ${String(minutes).padStart(2, "0")}′ ${String(seconds).padStart(2, "0")}″`;
  }

  function closeObjectCard() {
    // Masquer la fiche sans effacer la sélection : le repère de la cible
    // reste visible sur la carte jusqu’à une nouvelle sélection explicite.
    setHidden("object-card", true);
    safely(t("ui.skyRefresh"), () => drawSky());
  }

  /* ==========================================================
     MODE CHERCHEUR
     ========================================================== */

  function openFinder() {
    if (!state.selected) {
      showToast(t("ui.selectObjectOnMapFirst"));
      return;
    }

    if (typeof enterFinder === "function") {
      safely(t("ui.finderMode"), () => enterFinder());
    } else {
      showToast(t("ui.finderUnavailable"));
    }
  }

  function closeFinder() {
    if (typeof exitFinder === "function") {
      safely(t("ui.finderClose"), () => exitFinder());
    }
    if (finderReturnTo === "visible-now") {
      // Le chercheur réaffiche par défaut la fiche : pour un appel depuis
      // la liste, masquer cette fiche et restaurer la liste des objets.
      setHidden("object-card", true);
      openVisibleNow();
    } else if (finderReturnTo === "star-hop") {
      setHidden("object-card", true);
      if (typeof openStarHopHandler === "function") openStarHopHandler();
    }
    finderReturnTo = "object-card";
  }

  // Noms usuels des étoiles partagés entre la recherche Expert et Découverte.
  const SEARCH_COMMON_STAR_NAMES = {
      677: "Alpheratz", 746: "names.star.caph", 1067: "names.star.algenib", 3179: "names.star.schedar",
      4427: "names.star.navi", 5447: "names.star.mirach", 6686: "names.star.ruchbah", 7588: "names.star.achernar",
      8886: "names.star.segin", 9884: "names.star.hamal", 14135: "names.star.menkar", 14576: "names.star.algol",
      15863: "names.star.mirfak", 21421: "names.star.aldebaran", 24436: "names.star.rigel", 24608: "names.star.capella",
      25336: "names.star.bellatrix", 25428: "names.star.elnath", 25930: "names.star.mintaka", 26311: "names.star.alnilam",
      26727: "names.star.alnitak", 27989: "names.star.betelgeuse", 30438: "names.star.canopus", 32349: "names.star.sirius",
      36850: "names.star.castor", 37279: "names.star.procyon", 37826: "names.star.pollux", 49669: "names.star.regulus",
      53910: "names.star.merak", 54061: "names.star.dubhe", 60718: "names.star.acrux", 63090: "names.star.zosma",
      65474: "names.star.spica", 68702: "names.star.hadar", 69673: "names.star.arcturus", 80763: "names.star.antares",
      91262: "names.star.vega", 97649: "names.star.altair", 102098: "names.star.deneb", 113368: "names.star.fomalhaut",
      11767: "names.star.polaris-full", 57632: "Denebola", 67301: "Alkaid",
      65378: "names.star.mizar", 102488: "names.star.gienah",
      // Autres étoiles brillantes dont les noms sont utiles pour apprendre le ciel.
      8903: "names.star.sheratan", 9640: "names.star.almach", 11767: "names.star.polaris-full",
      17702: "names.star.alcyone", 17531: "Taygeta", 17573: "Maia", 17847: "Atlas",
      17851: "names.star.pleione", 27366: "names.star.saiph", 26207: "names.star.meissa", 28380: "names.star.menkalinan",
      30324: "Mirzam", 31681: "names.star.alhena", 33579: "names.star.adhara", 34444: "names.star.wezen",
      35904: "Aludra", 50583: "Algieba", 61941: "Porrima", 63608: "Vindemiatrix",
      67927: "Muphrid", 72105: "Izar", 76267: "Alphecca", 77070: "Unukalhai",
      84012: "Sabik", 85927: "names.star.shaula", 86032: "names.star.rasalhague", 90185: "names.star.kaus-australis",
      92855: "names.star.nunki", 95947: "names.star.albireo", 97278: "Tarazed", 98036: "Alshain",
      106278: "names.star.sadalsuud", 107315: "names.star.enif", 113881: "names.star.scheat", 113963: "names.star.markab"
    };

  function getSearchCommonStarName(object) {
    const match = String(object?.id ?? object?.name ?? "").match(/^HIP[_\s-]*(\d+)$/i);
    const hip = Number(object?.hip ?? (match ? match[1] : NaN));
    const storedName = SEARCH_COMMON_STAR_NAMES[hip];
    const candidate = (typeof storedName === "string" && storedName.startsWith("names.star.") ? t(storedName) : storedName) || object?.proper_name || object?.properName ||
      (object?.name && !/^HIP[_\s-]*\d+$/i.test(object.name) ? object.name : "");
    return String(candidate || "").trim();
  }

  function normalizeCatalogSearchText(value) {
    return String(value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase(getLocale())
      .trim();
  }

  function getDiscoveryCommonName(object) {
    if (!object || typeof object !== "object") return "";
    const catalogue = String(object.catalogue || "");
    const type = String(object.type || "").toLowerCase();
    if (catalogue === "Hipparcos" || type === "star") {
      const starName = getSearchCommonStarName(object);
      return starName && !/^(?:HIP|HD|HR|SAO|TYC|Gaia)\s*[-#]?\s*\d/i.test(starName) ? starName : "";
    }
    // Le Soleil, la Lune et les planètes ont des noms communs à part entière.
    if (["sun", "moon", "planet", "dwarf-planet"].includes(type) || catalogue === "Système solaire" || type === "minor-planet" || type === "comet" || catalogue === "Planètes mineures" || catalogue === "Planètes naines" || catalogue === "Comètes") {
      const solarName = localizedObjectName(object, object.proper_name || object.common_name || "").trim();
      return solarName && !/^(?:HIP|HD|HR|SAO|TYC|Gaia)\s*[-#]?\s*\d/i.test(solarName) ? solarName : "";
    }
    const ids = [object.id, object.designation].map(value => String(value || "").trim()).filter(Boolean);
    // Le nom déjà résolu selon la langue active doit primer sur les alias
    // français conservés dans les données pour la recherche.
    const candidates = [localizedObjectName(object), object.common_name_en, object.common_name, object.commonName, object.proper_name_en, object.proper_name, object.properName];
    for (const rawCandidate of candidates) {
      const candidate = String(rawCandidate || "").trim();
      if (!candidate) continue;
      if (/^(?:M|NGC|IC|HIP|HD|HR|SAO|TYC|Gaia)\s*[-#]?\s*\d/i.test(candidate)) continue;
      let isCatalogLabel = false;
      for (const id of ids) {
        if (normalizeCatalogSearchText(candidate).replace(/\s+/g, "") === normalizeCatalogSearchText(id).replace(/\s+/g, "")) {
          isCatalogLabel = true;
          break;
        }
        const designation = id.match(/^(M|NGC|IC)\s*(\d+)/i);
        if (designation) {
          const expression = new RegExp(`\\b${designation[1]}\\s*${designation[2]}\\b`, "i");
          if (expression.test(candidate)) { isCatalogLabel = true; break; }
        }
      }
      if (!isCatalogLabel) return candidate;
    }
    return "";
  }

  function findDiscoveryNearbyReferences(target, allObjects) {
    if (!target || !Array.isArray(allObjects)) return [];
    const toRad = Math.PI / 180;
    const separationDeg = (a, b) => {
      const altA = Number(a.alt) * toRad, altB = Number(b.alt) * toRad;
      const deltaAz = (Number(a.az) - Number(b.az)) * toRad;
      const cosine = Math.sin(altA) * Math.sin(altB) + Math.cos(altA) * Math.cos(altB) * Math.cos(deltaAz);
      return Math.acos(Math.max(-1, Math.min(1, cosine))) / toRad;
    };
    return allObjects.map(candidate => {
      const commonName = getDiscoveryCommonName(candidate);
      return commonName ? { object: { ...candidate, discoveryLabel: commonName }, separation: separationDeg(target, candidate) } : null;
    }).filter(item => {
      if (!item) return false;
      const candidate = item.object;
      const candidateType = String(candidate.type || (candidate.catalogue === "Hipparcos" ? "star" : "")).toLowerCase();
      return candidate !== target
        && Number.isFinite(Number(candidate.az)) && Number.isFinite(Number(candidate.alt)) && Number(candidate.alt) > 0
        && String(candidate.id || candidate.name || "") !== String(target.id || target.name || "")
        && (candidateType === "star" || candidateType === "planet")
        && Number.isFinite(Number(candidate.mag)) && Number(candidate.mag) <= 3.5
        && item.separation >= 2 && item.separation <= 30;
    }).sort((a, b) => Number(a.object.mag) - Number(b.object.mag) || a.separation - b.separation).slice(0, 2);
  }

  /* ==========================================================
     OBJETS VISIBLES MAINTENANT
     ========================================================== */

  function closeVisibleNow() {
    setHidden("visible-now-dialog", true);
  }

  function renderVisibleNowSearch() {
    const input = $("visible-now-search");
    const results = $("visible-now-search-results");
    if (!input || !results) return;
    // Recherche insensible aux accents : « Vega » et « Véga » doivent
    // retrouver la même étoile, comme les noms français et internationaux.
    const normalizeSearchText = value => String(value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase(getLocale())
      .trim();
    const searchStarName = getSearchCommonStarName;
    const query = normalizeSearchText(input.value);
    results.replaceChildren();
    if (!query) return;
    const catalog = typeof getCatalogObjects === "function" ? getCatalogObjects() : [];
    const matches = catalog.filter(object => {
      const commonName = object.catalogue === "Hipparcos" ? searchStarName(object) : "";
      const fields = [object.id, object.name, object.englishName, object.name_en, object.proper_name, object.properName, object.catalogue,
        object.hip ? `HIP ${object.hip}` : "", commonName]
        .filter(Boolean).map(normalizeSearchText).join(" ");
      return fields.includes(query);
    }).slice(0, 12);
    if (!matches.length) {
      const empty = document.createElement("p");
      empty.className = "visible-now-search-empty muted";
      empty.textContent = t("ui.noObjectFound");
      results.append(empty);
      return;
    }
    for (const object of matches) {
      const card = document.createElement("article");
      card.className = "visible-now-card visible-now-search-card";
      const content = document.createElement("div");
      content.className = "visible-now-card-content";
      const title = document.createElement("h3");
      const commonName = object.catalogue === "Hipparcos" ? searchStarName(object) : "";
      const displayName = commonName && commonName !== object.name ? commonName : localizedObjectName(object);
      title.textContent = `${object.id ? `${object.id} · ` : ""}${displayName}`;
      const meta = document.createElement("p");
      const altitude = Number(object.alt);
      const above = Number.isFinite(altitude) && altitude > 0;
      const status = Number.isFinite(altitude)
        ? (above ? `Au-dessus de l’horizon · altitude ${altitude.toFixed(1)}°` : `Sous l’horizon · altitude ${altitude.toFixed(1)}°`)
        : t("ui.horizontalPositionUnavailable");
      meta.textContent = `${localizedCatalogueName(object.catalogue) || t("ui.catalogue")} · ${status}`;
      content.append(title, meta);
      const actions = document.createElement("div");
      actions.className = "visible-now-card-actions";
      const ficheButton = document.createElement("button");
      ficheButton.type = "button";
      ficheButton.className = "action-button visible-now-fiche";
      ficheButton.textContent = t("ui.fiche");
      ficheButton.setAttribute("aria-label", `${t("ui.openSheetOf")} ${title.textContent}`);
      ficheButton.addEventListener("click", () => {
        applyVisibleNowPanelDateToSky();
        if (Number.isFinite(object.az) && Number.isFinite(object.alt)) {
          state.heading = norm360(object.az);
          state.pitch = Math.max(-5, Math.min(85, object.alt));
        }
        state.selected = { ...object };
        updateObjectCard(state.selected);
        const objectCard = $("object-card");
        if (objectCard) objectCard.hidden = false;
        drawSky();
        closeVisibleNow();
      });
      actions.append(ficheButton);
      if (above) {
        const guideButton = document.createElement("button");
        guideButton.type = "button";
        guideButton.className = "action-button visible-now-guide";
        guideButton.textContent = t("ui.guide");
        guideButton.setAttribute("aria-label", `${t("ui.guide")} ${title.textContent}`);
        guideButton.addEventListener("click", () => {
          applyVisibleNowPanelDateToSky();
          if (Number.isFinite(object.az) && Number.isFinite(object.alt)) {
            state.heading = norm360(object.az);
            state.pitch = Math.max(-5, Math.min(85, object.alt));
          }
          if (typeof selectTarget === "function") selectTarget(object);
          closeVisibleNow();
          showToast(`${t("ui.mapCenteredOn")} ${title.textContent} ; ${t("ui.guidanceLaunched")}.`);
        });
        actions.append(guideButton);
      }
      card.append(content, actions);
      results.append(card);
    }
  }

  $("visible-now-search")?.addEventListener("input", renderVisibleNowSearch);

  let visibleNowTargets = [];
  let tonightSelectionTargets = [];
  let lastVisibleNowRefreshKey = "";

  function getVisibleNowPanelDate() {
    const input = $("visible-now-datetime");
    if (input?.value) {
      const selected = new Date(input.value);
      if (Number.isFinite(selected.getTime())) return selected;
    }
    return state.observationDate || new Date();
  }

  function visibleNowDateDescription() {
    return getVisibleNowPanelDate().toLocaleString(getLocale(), { dateStyle: "short", timeStyle: "short" });
  }

  function applyVisibleNowPanelDateToSky() {
    if (typeof onObservationDateChange !== "function") return;
    if (visibleNowPanelFollowsRealtime) {
      if (state.observationDate) onObservationDateChange(null);
      return;
    }
    const selectedDate = getVisibleNowPanelDate();
    if (!state.observationDate || state.observationDate.getTime() !== selectedDate.getTime()) {
      onObservationDateChange(selectedDate);
    }
  }

  function rebuildVisibleNowTargets() {
    const allTargets = typeof getVisibleNowObjects === "function" ? getVisibleNowObjects() : [];
    // La magnitude est un critère de disponibilité des données, pas un seuil de visibilité à l’œil nu.
    visibleNowTargets = rankVisibleTargets(allTargets.filter(object => object.mag != null && Number.isFinite(Number(object.mag))));
    const catalogObjects = typeof getCatalogObjects === "function" ? getCatalogObjects() : allTargets;
    tonightSelectionTargets = buildTonightSelection(catalogObjects, {
      instrument: $("visible-now-instrument")?.value || "all"
    });
    const summary = $("visible-now-summary");
    if (summary) { const count = Math.min(8, tonightSelectionTargets.length);
const piste = count > 1 ? t("ui.pistes") : t("ui.piste");
summary.textContent = `${t("ui.tonightSummaryPrefix")} ${visibleNowDateDescription()} ${t("ui.tonightSummaryUpTo")} ${count} ${piste} ${t("ui.tonightSummarySuffix")}`; }
    renderVisibleNowList();
    renderVisibleNowSearch();
    const date = getVisibleNowPanelDate();
    lastVisibleNowRefreshKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`;
  }

  function refreshVisibleNow(force = false) {
    const dialog = $("visible-now-dialog");
    if (!dialog || dialog.hidden) return;
    if (visibleNowPanelFollowsRealtime) {
      const input = $("visible-now-datetime");
      if (input && document.activeElement !== input) {
        const liveValue = formatVisibleNowDateTime(new Date());
        if (input.value !== liveValue) {
          input.value = liveValue;
          updateLocalizedDateTimeDisplay("visible-now-datetime", "visible-now-datetime-display");
        }
      }
    }
    const date = getVisibleNowPanelDate();
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`;
    // Une liste en temps réel se rafraîchit à la minute. Une date choisie
    // reste stable jusqu'à un nouveau changement explicite.
    if (!force && key === lastVisibleNowRefreshKey) return;
    rebuildVisibleNowTargets();
  }

  function renderVisibleNowList() {
    const list = $("visible-now-list");
    if (!list) return;
    const typeFilter = $("visible-now-filter-type")?.value || "all";
    const minAltitude = Number($("visible-now-filter-altitude")?.value || 0);
    const maxMagnitude = $("visible-now-filter-magnitude")?.value || "all";
    const sort = $("visible-now-sort")?.value || "recommended";
    const mode = $("visible-now-mode")?.value || "tonight";
    const sourceTargets = mode === "tonight" ? tonightSelectionTargets : visibleNowTargets;
    const filteredTargets = filterVisibleTargets(sourceTargets, { type: typeFilter, minAltitude, maxMagnitude, sort });
    let targets = filteredTargets;
    if (mode === "tonight") {
      // Les cibles prioritaires du Système solaire restent visibles même si
      // le tri alternatif les placerait après les huit premières cibles.
      const solarPriorities = filteredTargets.filter(isPrioritySolarTarget);
      const priorityKeys = new Set(solarPriorities.map(object => String(object.id || object.name || "").toLowerCase()));
      const otherTargets = filteredTargets.filter(object => !priorityKeys.has(String(object.id || object.name || "").toLowerCase()));
      targets = [...solarPriorities, ...otherTargets.slice(0, Math.max(0, 8 - solarPriorities.length))];
    }
    list.replaceChildren();
    const filterSummary = $("visible-now-filter-summary");
    if (filterSummary) {
      if (mode === "tonight") {
        const rec = targets.length > 1 ? t("ui.recommendations") : t("ui.recommendation");
        const aff = targets.length > 1 ? t("ui.affichees") : t("ui.affichee");
        const suffix = filteredTargets.length > targets.length ? ` ${t("ui.filterSummaryOn")} ${filteredTargets.length} ${t("ui.filterSummaryMatchingTargets")}` : "";
        filterSummary.textContent = `${targets.length} ${rec} ${aff}${suffix}.`;
      } else {
        const cible = targets.length > 1 ? t("ui.cibles") : t("ui.cible");
        const aff = targets.length > 1 ? t("ui.affichees") : t("ui.affichee");
        filterSummary.textContent = filteredTargets.length === sourceTargets.length
          ? `${targets.length} ${cible} ${aff}.`
          : `${targets.length} ${cible} ${t("ui.filterSummaryOn")} ${sourceTargets.length} ${t("ui.filterSummaryAfterFiltering")}.`;
      }
    }
    if (!targets.length) {
      const empty = document.createElement("p");
      empty.className = "visible-now-empty";
      empty.textContent = sourceTargets.length
        ? t("ui.noTargetMatchesFilters")
        : (mode === "tonight"
          ? t("ui.noRecommendationMatches")
          : t("ui.noMagnitudeTargetAboveHorizon"));
      list.append(empty);
      return;
    }
    for (const [targetIndex, object] of targets.entries()) {
      const card = document.createElement("article");
      card.className = "visible-now-card";
      const content = document.createElement("div");
      content.className = "visible-now-card-content";
      const title = document.createElement("h3");
      const commonStarName = object.catalogue === "Hipparcos" ? getSearchCommonStarName(object) : "";
      title.textContent = commonStarName || localizedObjectName(object);
      const rank = document.createElement("span");
      rank.className = "visible-now-rank";
      rank.textContent = sort === "recommended" ? `${t("ui.priority")} ${targetIndex + 1}` : `${t("ui.position")} ${targetIndex + 1}`;
      const meta = document.createElement("p");
      const typeNames = { planet: t("ui.planet"), sun: t("ui.sun"), moon: t("ui.moon"), "minor-planet": t("ui.minorPlanet"), "dwarf-planet": t("ui.dwarfPlanet"), comet: t("ui.comet"), galaxy: t("ui.galaxy"), nebula: t("ui.nebula"), cluster: t("ui.clusterTypeLabel"), star: t("ui.star"), "deep-sky": t("ui.deepSky") };
      const type = typeNames[object.type] || (object.catalogue === "NGC" ? t("ui.ngcObject") : object.catalogue === "Messier" ? t("ui.messierObject") : object.type || t("ui.celestialObject"));
      const parts = [type];
      if (object.id) parts.push(object.id);
      if (Number.isFinite(Number(object.mag))) parts.push(`mag. ${Number(object.mag).toFixed(1)}`);
      meta.textContent = parts.join(" · ");
      const position = document.createElement("p");
      position.className = "visible-now-position";
      position.textContent = `${t("ui.azimuth")} ${Number(object.az).toFixed(1)}° · ${t("ui.altitude")} ${Number(object.alt).toFixed(1)}°`;
      content.append(rank, title, meta, position);
      const difficulty = assessObservingDifficulty(object, $("visible-now-instrument")?.value || "all");
      const difficultyLine = document.createElement("p");
      difficultyLine.className = `visible-now-difficulty is-${difficulty.level}`;
      const repText = `${t("ui.estimatedSpotting")}: ${difficulty.label}`;
      difficultyLine.textContent = repText;
      difficultyLine.title = difficulty.explanation;
      difficultyLine.setAttribute("aria-label", repText);
      const difficultyExplanation = document.createElement("p");
      difficultyExplanation.className = "visible-now-difficulty-explanation";
      difficultyExplanation.textContent = difficulty.explanation;
      content.append(difficultyLine, difficultyExplanation);
      const windowSummary = observingWindowSummary(object);
      if (windowSummary) {
        const windowLine = document.createElement("p");
        windowLine.className = "visible-now-window";
        windowLine.textContent = windowSummary;
        content.append(windowLine);
      }
      const actions = document.createElement("div");
      actions.className = "visible-now-card-actions";
      const ficheButton = document.createElement("button");
      ficheButton.type = "button";
      ficheButton.className = "action-button visible-now-fiche";
      ficheButton.textContent = t("ui.fiche");
      ficheButton.setAttribute("aria-label", `${t("ui.openSheetOf")} ${title.textContent}`);
      ficheButton.addEventListener("click", () => {
        applyVisibleNowPanelDateToSky();
        state.selected = { ...object };
        updateObjectCard(state.selected);
        const objectCard = $("object-card");
        if (objectCard) objectCard.hidden = false;
        drawSky();
        closeVisibleNow();
      });
      const guideButton = document.createElement("button");
      guideButton.type = "button";
      guideButton.className = "action-button visible-now-guide";
      guideButton.textContent = t("ui.guide");
      guideButton.setAttribute("aria-label", `${t("ui.guide")} ${title.textContent}`);
      guideButton.addEventListener("click", () => {
        applyVisibleNowPanelDateToSky();
        finderReturnTo = "visible-now";
        if (typeof selectTarget === "function") selectTarget(object);
        closeVisibleNow();
        showToast(`${t("ui.guidanceLaunchedTo")} ${title.textContent}.`);
      });
      actions.append(ficheButton, guideButton);
      card.append(content, actions);
      list.append(card);
    }
  }

  $("visible-now-filter-type")?.addEventListener("change", renderVisibleNowList);
  $("visible-now-filter-altitude")?.addEventListener("change", renderVisibleNowList);
  $("visible-now-filter-magnitude")?.addEventListener("change", renderVisibleNowList);
  $("visible-now-sort")?.addEventListener("change", renderVisibleNowList);
  $("visible-now-mode")?.addEventListener("change", renderVisibleNowList);
  $("visible-now-reset-filters")?.addEventListener("click", () => {
    const defaults = {
      "visible-now-filter-type": "all",
      "visible-now-filter-altitude": "0",
      "visible-now-filter-magnitude": "all",
      "visible-now-sort": "recommended"
    };
    for (const [id, value] of Object.entries(defaults)) {
      const control = $(id);
      if (control) control.value = value;
    }
    renderVisibleNowList();
  });
  $("visible-now-instrument")?.addEventListener("change", () => {
    const allTargets = typeof getCatalogObjects === "function" ? getCatalogObjects() : [];
    tonightSelectionTargets = buildTonightSelection(allTargets, {
      instrument: $("visible-now-instrument")?.value || "all"
    });
    renderVisibleNowList();
    const summary = $("visible-now-summary");
    if (summary) { const count = Math.min(8, tonightSelectionTargets.length); summary.textContent = `${t("ui.tonightSummaryPrefix")} ${visibleNowDateDescription()} ${t("ui.tonightSummaryUpTo")} ${count} ${count > 1 ? t("ui.pistes") : t("ui.piste")} ${t("ui.tonightSummarySuffix")}`; }
  });

  function calculateSunsetForDate(date) {
    const A = window.Astronomy;
    const latitude = Number(state.latitude);
    const longitude = Number(state.longitude);
    if (!A?.Observer || !A?.SearchRiseSet || !A?.MakeTime || !A?.Body?.Sun ||
        !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
        !(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
    try {
      // Le midi local évite de récupérer le coucher de la veille ; les
      // coordonnées sont celles du lieu d’observation déjà choisi dans l’app.
      const localNoon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);
      const observer = new A.Observer(latitude, longitude, 0);
      const event = A.SearchRiseSet(A.Body.Sun, observer, -1, A.MakeTime(localNoon), 1);
      const sunset = event?.date instanceof Date ? event.date : null;
      return sunset && Number.isFinite(sunset.getTime()) ? sunset : null;
    } catch (error) {
      console.warn("[Atlas] Calcul du coucher du Soleil indisponible.", error);
      return null;
    }
  }

  function eveningStartDate(date) {
    const sunset = calculateSunsetForDate(date);
    if (!sunset) return { date, sunset: null, clamped: false };
    if (date.getTime() < sunset.getTime()) return { date: sunset, sunset, clamped: true };
    return { date, sunset, clamped: false };
  }

  function updateSunsetNote(date, sunset, clamped = false) {
    const note = $("visible-now-sunset-note");
    if (!note) return;
    if (!sunset) {
      note.textContent = t("ui.sunsetUnavailable");
      return;
    }
    const time = sunset.toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const place = state.locationName || "lieu d’observation initial";
    note.textContent = clamped
      ? `${t("ui.sunsetDeparture")} ${time} · ${place}`
      : `${t("ui.sunsetLabel")} ${time} · ${place}`;
  }

  function formatVisibleNowDateTime(date) {
    const pad = value => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function openVisibleNow() {
    const dialog = $("visible-now-dialog");
    const list = $("visible-now-list");
    if (!dialog || !list) return;
    const timeInput = $("visible-now-datetime");
    const currentDate = state.observationDate || new Date();
    const evening = eveningStartDate(currentDate);
    const effectiveDate = evening.date;
    // Le panneau prépare sa liste pour le coucher, mais ne change pas la date
    // de la carte. Ainsi, ouvrir « visible » ne fige plus le ciel en pleine journée.
    visibleNowPanelFollowsRealtime = !state.observationDate && !evening.clamped;
    updateSunsetNote(effectiveDate, evening.sunset, evening.clamped);
    if (timeInput && document.activeElement !== timeInput) timeInput.value = formatVisibleNowDateTime(effectiveDate);
    updateLocalizedDateTimeDisplay("visible-now-datetime", "visible-now-datetime-display");
    dialog.hidden = false;
    rebuildVisibleNowTargets();
  }

  const visibleNowDateInput = $("visible-now-datetime");
  function applyVisibleNowDate(date) {
    const useRealtime = !(date instanceof Date);
    const requested = useRealtime ? new Date() : date;
    const evening = eveningStartDate(requested);
    const selectedDate = evening.date;
    // Le bouton « Maintenant » repasse en temps réel après le coucher ; avant
    // celui-ci, la liste reste préparée pour le coucher du Soleil.
    visibleNowPanelFollowsRealtime = useRealtime && !evening.clamped;
    updateSunsetNote(selectedDate, evening.sunset, evening.clamped);
    if (visibleNowDateInput) visibleNowDateInput.value = formatVisibleNowDateTime(selectedDate);
    updateLocalizedDateTimeDisplay("visible-now-datetime", "visible-now-datetime-display");
    rebuildVisibleNowTargets();
  }
  visibleNowDateInput?.addEventListener("change", () => {
    const parsed = visibleNowDateInput.value ? new Date(visibleNowDateInput.value) : null;
    if (!parsed || !Number.isFinite(parsed.getTime())) {
      showToast(t("ui.dateTimeInvalid"));
      return;
    }
    visibleNowPanelFollowsRealtime = false;
    applyVisibleNowDate(parsed);
  });
  visibleNowDateInput?.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      visibleNowDateInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  $("visible-now-time-now")?.addEventListener("click", () => applyVisibleNowDate(null));
  // Navigation du carnet : la date ne peut jamais précéder aujourd’hui.
  function sessionTodayString() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }
  function updateSessionDateMinimum() {
    const input = $("session-date");
    if (!input) return;
    const today = sessionTodayString();
    input.min = today;
    if (!input.value || input.value < today) input.value = today;
  }

  /* ==========================================================
     CONSTELLATIONS
     ========================================================== */

  function toggleConstellations() {
    state.showConstellations = !state.showConstellations;

    const button = $("constellations-btn");

    if (button) {
      button.setAttribute(
        "aria-pressed",
        String(state.showConstellations)
      );

      button.classList.toggle(
        "active",
        state.showConstellations
      );
    }

    setText(
      "constellations-status",
      state.showConstellations
        ? t("constellations.linesEnabled")
        : t("constellations.linesDisabled")
    );

    safely(t("ui.constellationDisplay"), () => drawSky());
  }

  function toggleConstellationBoundaries() {
    state.showConstellationBoundaries = !state.showConstellationBoundaries;
    setText(
      "constellations-boundaries-status",
      state.showConstellationBoundaries
        ? t("constellations.boundariesEnabled")
        : t("constellations.boundariesDisabled")
    );
    const button = $("constellation-boundaries-btn");
    if (button) {
      button.setAttribute("aria-pressed", String(state.showConstellationBoundaries));
      button.classList.toggle("active", state.showConstellationBoundaries);
    }
    const status = $("constellations-status");
    if (status) {
      const parts = [];
      if (state.showConstellations) parts.push(t("ui.constellationFiguresActivated"));
      if (state.showConstellationBoundaries) parts.push(t("ui.iauBoundariesActivated"));
      status.textContent = parts.length ? parts.join(" · ") + "." : t("ui.constellationLinesAndBoundariesDeactivated");
    }
    safely(t("ui.constellationLimitsDisplay"), () => drawSky());
  }

  /* ==========================================================
     RÉGLAGES MANUELS
     ========================================================== */

  /* ==========================================================
     MODE IMMERSIF
     ========================================================== */

  function bindImmersiveExit() {
    on("exit-immersive", "click", () => {
      if (typeof setImmersive === "function") {
        safely(t("ui.immersiveExit"), () => {
          return setImmersive(false);
        });
      }
    });
  }

  /* ==========================================================
     SÉLECTION ET NAVIGATION SUR LE CANVAS
     ========================================================== */

  function syncZoomControls() {
    const indicator = $("zoom-level");
    if (indicator) indicator.textContent = `${(45 / state.fov).toLocaleString(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}×`;
  }

  function applyZoomFactor(factor) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const oldFov = state.fov;
    const nextFov = clamp(oldFov * factor, 15, 120);
    const ratio = nextFov / oldFov;
    state.fov = nextFov;
    state.verticalFov = clamp(state.verticalFov * ratio, 15, 110);
    syncZoomControls();
    refreshReadout();
    drawSky();
  }

  function resetZoom() {
    state.fov = 75;
    state.verticalFov = 83.3333333333;
    syncZoomControls();
    refreshReadout();
    drawSky();
  }

  function bindCanvas() {
    if (!canvas || canvasBound) {
      return;
    }

    if (typeof handleCanvasTap !== "function") {
      console.warn(t("ui.canvasSelectionUnavailable"));
      return;
    }

    canvasBound = true;

    const activePointers = new Map();
    let primaryPointerId = null;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastY = 0;
    let moved = false;
    let eclipticTapCandidate = false;
    let pinchStart = null;

    const DRAG_THRESHOLD = 5;
    const ECLIPTIC_TAP_TOLERANCE = 18;
    const SENSITIVITY = 0.25;

    function distanceBetweenPointers() {
      const points = [...activePointers.values()];
      if (points.length < 2) return 0;
      return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    }

    canvas.addEventListener("pointerdown", event => {
      if (event.button !== undefined && event.button !== 0) return;

      activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      try { canvas.setPointerCapture(event.pointerId); } catch (_) {}

      if (activePointers.size === 1) {
        primaryPointerId = event.pointerId;
        startX = lastX = event.clientX;
        startY = lastY = event.clientY;
        moved = false;
        eclipticTapCandidate = false;
        const bounds = state.eclipticLabelBounds;
        if (bounds) {
          const rect = canvas.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const y = event.clientY - rect.top;
          eclipticTapCandidate = x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
        }
        if (event.pointerType === "mouse") canvas.style.cursor = "grabbing";
      } else if (activePointers.size === 2) {
        moved = true;
        pinchStart = {
          distance: distanceBetweenPointers(),
          fov: state.fov,
          verticalFov: state.verticalFov
        };
      }
    });

    canvas.addEventListener("pointermove", event => {
      if (!activePointers.has(event.pointerId)) return;
      activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (activePointers.size >= 2 && pinchStart) {
        const distance = distanceBetweenPointers();
        if (distance > 0 && pinchStart.distance > 0) {
          const nextFov = clamp(pinchStart.fov * pinchStart.distance / distance, 15, 120);
          const ratio = nextFov / pinchStart.fov;
          state.fov = nextFov;
          state.verticalFov = clamp(pinchStart.verticalFov * ratio, 15, 110);
          syncZoomControls();
          refreshReadout();
          drawSky();
        }
        return;
      }

      if (event.pointerId !== primaryPointerId) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;

      const pointerTravel = Math.hypot(event.clientX - startX, event.clientY - startY);
      if (eclipticTapCandidate && pointerTravel > ECLIPTIC_TAP_TOLERANCE) eclipticTapCandidate = false;
      if (pointerTravel > DRAG_THRESHOLD && !eclipticTapCandidate) moved = true;
      if (moved) {
        state.heading = norm360(state.heading - dx * SENSITIVITY);
        state.pitch = clamp(state.pitch + dy * SENSITIVITY, -90, 90);
        refreshReadout();
        drawSky();
      }
      lastX = event.clientX;
      lastY = event.clientY;
    });

    function finishPointer(event, cancelled = false) {
      if (!activePointers.has(event.pointerId)) return;
      const wasOnlyPointer = activePointers.size === 1;
      const wasMoved = moved || !wasOnlyPointer;
      activePointers.delete(event.pointerId);
      pinchStart = null;

      if (activePointers.size === 1) {
        const [id, point] = activePointers.entries().next().value;
        primaryPointerId = id;
        lastX = startX = point.x;
        lastY = startY = point.y;
        moved = true;
      } else if (activePointers.size === 0) {
        primaryPointerId = null;
        moved = false;
        if (canvas.style.cursor === "grabbing") canvas.style.cursor = "grab";
      }

      if (!cancelled && wasOnlyPointer && eclipticTapCandidate && !wasMoved) {
        showToast(t("ui.eclipticExplanation"));
        eclipticTapCandidate = false;
        return;
      }
      eclipticTapCandidate = false;
      if (!cancelled && wasOnlyPointer && !wasMoved) {
        safely(t("ui.objectSelection"), () => handleCanvasTap(event));
      }
    }

    canvas.addEventListener("pointerup", event => finishPointer(event, false));
    canvas.addEventListener("pointercancel", event => finishPointer(event, true));
    canvas.addEventListener("lostpointercapture", event => finishPointer(event, true));

    canvas.addEventListener("wheel", event => {
      event.preventDefault();
      const factor = Math.exp(Math.max(-250, Math.min(250, event.deltaY)) * 0.0015);
      applyZoomFactor(factor);
    }, { passive: false });

    canvas.style.cursor = "grab";
    canvas.style.touchAction = "none";
  }

  /* ==========================================================
     BRANCHEMENT DES BOUTONS
     ========================================================== */

  const getCelestialEvents = () => [
    { date: "2026-10-21", title: t("events.orionidsMax"), type: t("events.typeMeteorShower"), detail: t("events.detailOrionids"), category: "meteor" },
    { date: "2026-10-28", title: t("events.moonNearPleiades"), type: t("events.typeCelestialApproach"), detail: t("events.detailMoonNearPleiades"), category: "moon", targets: ["moon"] },
    { date: "2026-11-05", title: t("events.southernTauridsMax"), type: t("events.typeMeteorShower"), detail: t("events.detailSouthernTaurids"), category: "meteor" },
    { date: "2026-11-11", title: t("events.northernTauridsMax"), type: t("events.typeMeteorShower"), detail: t("events.detailNorthernTaurids"), category: "meteor" },
    { date: "2026-11-16", title: t("events.marsJupiterApproach"), type: t("events.typePlanets"), detail: t("events.detailMarsJupiter"), category: "planet", targets: ["mars", "jupiter"] },
    { date: "2026-11-17", title: t("events.leonidsMax"), type: t("events.typeMeteorShower"), detail: t("events.detailLeonids"), category: "meteor" },
    { date: "2026-12-14", title: t("events.geminidsMax"), type: t("events.typeMeteorShower"), detail: t("events.detailGeminids"), category: "meteor" },
    { date: "2026-12-22", title: t("events.ursidsMax"), type: t("events.typeMeteorShower"), detail: t("events.detailUrsids"), category: "meteor" },
    { date: "2027-01-04", title: t("events.quadrantidsMax"), type: t("events.typeMeteorShower"), detail: t("events.detailQuadrantids"), category: "meteor" },
    { date: "2027-02-06", title: t("events.annularSolarEclipse"), type: t("events.typeSolarEclipse"), detail: t("events.detailAnnularSolar"), category: "other" },
    { date: "2027-02-21", title: t("events.penumbralLunarEclipse"), type: t("events.typeLunarEclipse"), detail: t("events.detailPenumbralLunar"), category: "moon", targets: ["moon"] },
    { date: "2027-04-23", title: t("events.lyridsMax"), type: t("events.typeMeteorShower"), detail: t("events.detailLyrids"), category: "meteor" },
    { date: "2027-05-06", title: t("events.etaAquariidsMax"), type: t("events.typeMeteorShower"), detail: t("events.detailEtaAquariids"), category: "meteor" },
    { date: "2027-08-02", title: t("events.totalSolarEclipse"), type: t("events.typeSolarEclipse"), detail: t("events.detailTotalSolar"), category: "other" },
    { date: "2027-08-12", title: t("events.perseidsMax"), type: t("events.typeMeteorShower"), detail: t("events.detailPerseids"), category: "meteor" }
  ];

  // Phases lunaires calculées à partir d’une nouvelle Lune de référence et
  // de la durée moyenne du mois synodique. Les dates sont indicatives (± quelques heures).
  function generatedLunarEvents(fromDate = new Date(), days = 120) {
    const synodicMonth = 29.530588853;
    const referenceNewMoon = Date.UTC(2000, 0, 6, 18, 14);
    const phaseNames = [t("moon.newMoon"), t("moon.firstQuarter"), t("moon.fullMoon"), t("moon.lastQuarter")];
    const phaseDetails = [
      t("events.detailMinimalMoonlight"),
      t("events.detailFirstQuarter"),
      t("events.detailWaxingGibbous"),
      t("events.detailWaningCrescent")
    ];
    const start = new Date(fromDate); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + days);
    const startAge = ((start.getTime() - referenceNewMoon) / 86400000 / synodicMonth % 1 + 1) % 1;
    const firstCycle = Math.floor((start.getTime() - referenceNewMoon) / 86400000 / synodicMonth) - 1;
    const events = [];
    for (let cycle = firstCycle; ; cycle++) {
      let addedFuture = false;
      for (let phase = 0; phase < 4; phase++) {
        const timestamp = referenceNewMoon + (cycle + phase / 4) * synodicMonth * 86400000;
        const date = new Date(timestamp);
        if (date < start || date >= end) continue;
        addedFuture = true;
        const localDate = new Date(date.getTime());
        const iso = `${localDate.getFullYear()}-${String(localDate.getMonth()+1).padStart(2,'0')}-${String(localDate.getDate()).padStart(2,'0')}`;
        events.push({ date: iso, title: phaseNames[phase], type: t("events.typeMoonPhase"), detail: phaseDetails[phase], category: "moon" });
        if (phase === 0) {
          for (const offset of [-1, 1]) {
            const dark = new Date(date); dark.setDate(dark.getDate() + offset);
            if (dark >= start && dark < end) {
              const darkIso = `${dark.getFullYear()}-${String(dark.getMonth()+1).padStart(2,'0')}-${String(dark.getDate()).padStart(2,'0')}`;
              events.push({ date: darkIso, title: t("events.deepSkyWindow"), type: t("events.typeObservationSuggestion"), detail: t("events.detailDeepSkyWindow"), category: "dark-sky" });
            }
          }
        }
      }
      if (cycle * synodicMonth * 86400000 + referenceNewMoon > end.getTime()) break;
      if (cycle > firstCycle + 10) break;
    }
    return events;
  }

  let celestialEventFilter = "all";

  function eventCategory(item) {
    return item?.category || "other";
  }

  function findEventTarget(query) {
    const objects = [
      ...(typeof getCatalogObjects === "function" ? getCatalogObjects() || [] : []),
      ...(typeof getVisibleNowObjects === "function" ? getVisibleNowObjects() || [] : [])
    ];
    const key = String(query || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase(getLocale());
    return objects.find(object => [localizedObjectName(object), object.name, object.englishName, object.proper_name, object.id, object.designation]
      .some(value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase(getLocale()) === key));
  }

  function prepareEventObservationDate(item) {
    if (!item?.date || typeof onObservationDateChange !== "function") return;
    // Les événements n'ayant pas tous une heure précise sont préparés à 21 h locale.
    const date = new Date(`${item.date}T21:00:00`);
    if (Number.isFinite(date.getTime())) onObservationDateChange(date);
  }

  function openEventTarget(target) {
    if (!target) return false;
    state.selected = { ...target };
    updateObjectCard(state.selected);
    const card = $("object-card");
    if (card) card.hidden = false;
    if (Number.isFinite(target.az) && Number.isFinite(target.alt)) {
      state.heading = norm360(target.az);
      state.pitch = Math.max(-5, Math.min(85, target.alt));
    }
    drawSky();
    const dialog = $("events-dialog");
    if (dialog) dialog.hidden = true;
    return true;
  }

  function renderCelestialEvents() {
    const list = $("events-list");
    if (!list) return;
    list.replaceChildren();
    const referenceDate = new Date(state.observationDate || new Date());
    referenceDate.setHours(0, 0, 0, 0);
    const end = new Date(referenceDate); end.setDate(end.getDate() + 120);
    const generated = generatedLunarEvents(referenceDate, 120);
    const upcoming = [...getCelestialEvents(), ...generated]
      .filter(item => { const date = new Date(`${item.date}T12:00:00`); return date >= referenceDate && date < end; })
      .filter(item => celestialEventFilter === "all" || eventCategory(item) === celestialEventFilter)
      .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
    if (!upcoming.length) {
      const p = document.createElement("p"); p.className = "muted"; p.textContent = t("events.noEvents"); list.append(p); return;
    }
    for (const item of upcoming) {
      const card = document.createElement("article"); card.className = "event-card";
      const date = document.createElement("time"); date.dateTime = item.date; date.textContent = new Intl.DateTimeFormat(getLocale(), { day: "numeric", month: "long", year: "numeric" }).format(new Date(`${item.date}T12:00:00`));
      const title = document.createElement("h3"); title.textContent = item.title;
      const type = document.createElement("span"); type.className = "event-type"; type.textContent = item.type;
      const detail = document.createElement("p"); detail.textContent = item.detail;
      const actions = document.createElement("div"); actions.className = "event-card-actions";
      const linkedTargets = [];
      if (item.targets?.includes("moon")) {
        const moon = findEventTarget(t("names.planet.moon")) || findEventTarget("Moon");
        if (moon) linkedTargets.push({ target: moon, label: t("events.viewMoon") });
      }
      if (item.targets?.includes("mars")) {
        const mars = findEventTarget(t("names.planet.mars"));
        if (mars) linkedTargets.push({ target: mars, label: t("events.sheetMars") });
      }
      if (item.targets?.includes("jupiter")) {
        const jupiter = findEventTarget(t("names.planet.jupiter"));
        if (jupiter) linkedTargets.push({ target: jupiter, label: t("events.sheetJupiter") });
      }
      for (const linked of linkedTargets) {
        const button = document.createElement("button"); button.type = "button"; button.className = "action-button"; button.textContent = linked.label;
        button.addEventListener("click", () => {
          prepareEventObservationDate(item);
          const freshTarget = findEventTarget(linked.target.name || linked.target.id) || linked.target;
          openEventTarget(freshTarget);
        }); actions.append(button);
      }
      const visibleButton = document.createElement("button"); visibleButton.type = "button"; visibleButton.className = "action-button"; visibleButton.textContent = t("events.seeTargets");
      visibleButton.addEventListener("click", () => {
        prepareEventObservationDate(item);
        const dialog = $("events-dialog"); if (dialog) dialog.hidden = true;
        openVisibleNow();
      });
      actions.append(visibleButton);
      card.append(date, title, type, detail, actions); list.append(card);
    }
  }

  document.querySelectorAll("[data-event-filter]").forEach(button => {
    button.addEventListener("click", () => {
      celestialEventFilter = button.dataset.eventFilter || "all";
      document.querySelectorAll("[data-event-filter]").forEach(other => {
        const active = other === button;
        other.classList.toggle("is-active", active);
        other.setAttribute("aria-pressed", String(active));
      });
      renderCelestialEvents();
    });
  });
  document.addEventListener("localechange", () => {
    if ($("events-dialog") && !$("events-dialog").hidden) renderCelestialEvents();
  });
  // Indice météo indicatif (0–100), distinct de la transparence réelle du ciel et de la pollution lumineuse.
  function calculateSkyQuality(weather) {
    const precipitationMeasure = Number.isFinite(weather.precipitation_probability)
      ? [weather.precipitation_probability, value => 100 - Math.max(0, Math.min(100, value)), 0.20]
      : [weather.precipitation, value => 100 - Math.max(0, Math.min(100, value * 25)), 0.20];
    const measures = [
      [weather.cloud_cover, value => 100 - Math.max(0, Math.min(100, value)), 0.50],
      precipitationMeasure,
      [weather.relative_humidity_2m, value => 100 - Math.max(0, Math.min(100, (value - 50) * 1.5)), 0.10],
      [weather.wind_speed_10m, value => 100 - Math.max(0, Math.min(100, value * 2)), 0.10],
      [weather.visibility, value => Math.max(0, Math.min(100, value / 150)), 0.10]
    ].filter(([value]) => Number.isFinite(value));
    if (!measures.length) return null;
    const totalWeight = measures.reduce((sum, item) => sum + item[2], 0);
    return Math.round(measures.reduce((sum, [value, score, weight]) => sum + score(value) * weight, 0) / totalWeight);
  }

  let latestSkyQualityScore = null;
  function updateSessionWeatherStatus(score) {
    latestSkyQualityScore = Number.isFinite(score) ? score : null;
    const summary = $("session-weather-summary");
    const panel = $("session-weather-status");
    if (!summary || !panel) return;
    if (score === null || !Number.isFinite(score)) {
      summary.textContent = "—/100";
      panel.dataset.level = "unknown";
      return;
    }
    summary.textContent = `${score}/100`;
    panel.dataset.level = score >= 80 ? "good" : score >= 60 ? "favorable" : score >= 40 ? "moderate" : "high";
  }

  function createLightPollutionMapCard() {
    const card = document.createElement("article");
    card.className = "condition-card light-pollution-card";
    const label = document.createElement("span");
    label.textContent = t("conditions.localLightPollution");
    const detail = document.createElement("small");
    detail.textContent = t("conditions.lightPollutionDetail");
    const frame = document.createElement("iframe");
    frame.className = "light-pollution-map-frame";
    frame.title = t("ui.interactiveLightPollutionMap");
    frame.loading = "lazy";
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.allowFullscreen = true;
    frame.src = `https://lightpollutionmap.app/embed?lat=${encodeURIComponent(state.latitude)}&lng=${encodeURIComponent(state.longitude)}&zoom=8&opacity=50`;
    card.append(label, detail, frame);
    return card;
  }

  function renderConditionsLayout(content, cards) {
    const mapCard = cards.find(card => card?.classList?.contains("light-pollution-card"));
    const detailCards = cards.filter(card => card !== mapCard);
    const detailsColumn = document.createElement("div");
    detailsColumn.className = "conditions-details-column";
    detailsColumn.append(...detailCards);
    const mapColumn = document.createElement("div");
    mapColumn.className = "conditions-map-column";
    if (mapCard) mapColumn.append(mapCard);
    content.replaceChildren(detailsColumn, mapColumn);
  }

  async function refreshConditions() {
    const content = $("conditions-content");
    if (!content) return;
    if (!state.locationReady) {
      updateSessionWeatherStatus(null);
      content.replaceChildren(); const p = document.createElement("p"); p.className = "muted"; p.textContent = t("conditions.unknownPosition"); content.append(p); return;
    }
    content.replaceChildren(); const loading = document.createElement("p"); loading.className = "muted"; loading.textContent = t("conditions.loading"); content.append(loading);
    setText("conditions-location", state.locationName || `${state.latitude.toFixed(3)}°, ${state.longitude.toFixed(3)}°`);
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(state.latitude)}&longitude=${encodeURIComponent(state.longitude)}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,cloud_cover,wind_speed_10m,visibility&hourly=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,precipitation_probability,cloud_cover,wind_speed_10m,visibility&forecast_days=7&timezone=auto`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(t("ui.forecastsUnavailable"));
      const data = await response.json();
      const sessionDate = $("session-date")?.value || "";
      const sessionTime = $("session-start")?.value || "21:00";
      let target = "";
      if (sessionDate && sessionTime) {
        const [year, month, day] = sessionDate.split("-").map(Number);
        const [hour, minute] = sessionTime.split(":").map(Number);
        // Les prévisions sont horaires : choisir l’heure pleine la plus proche,
        // avec arithmétique UTC pour ne pas décaler la date selon le fuseau du navigateur.
        const rounded = new Date(Date.UTC(year, month - 1, day, hour, 0, 0));
        if (minute >= 30) rounded.setUTCHours(rounded.getUTCHours() + 1);
        target = `${rounded.getUTCFullYear()}-${String(rounded.getUTCMonth() + 1).padStart(2, "0")}-${String(rounded.getUTCDate()).padStart(2, "0")}T${String(rounded.getUTCHours()).padStart(2, "0")}:00`;
      }
      const hourly = data.hourly || {};
      const hourIndex = Array.isArray(hourly.time) ? hourly.time.indexOf(target) : -1;
      const hasTargetForecast = hourIndex >= 0;
      const c = hasTargetForecast
        ? Object.fromEntries(["temperature_2m", "relative_humidity_2m", "apparent_temperature", "precipitation", "precipitation_probability", "cloud_cover", "wind_speed_10m", "visibility"].map(key => [key, hourly[key]?.[hourIndex]]))
        : (data.current || {});
      const score = calculateSkyQuality(c);
      updateSessionWeatherStatus(score);
      const contentCards = [];
      const context = document.createElement("p"); context.className = "conditions-context muted";
      if (hasTargetForecast) {
        const [year, month, day] = sessionDate.split("-");
        context.textContent = `${t("conditions.hourlyForecastIntro")} ${day}/${month}/${year} ${t("conditions.hourlyForecastAt")} ${target.slice(11)} ${t("conditions.hourlyForecastLocalTime")} (${sessionTime.slice(0, 5)}).`;
      } else {
        context.textContent = t("conditions.hourlyUnavailable");
      }
      contentCards.push(context);
      const quality = document.createElement("article"); quality.className = "condition-card sky-quality-card";
      const qualityLabel = document.createElement("span"); qualityLabel.textContent = t("conditions.weatherIndexLabel");
      const qualityValue = document.createElement("strong");
      const qualityDetail = document.createElement("small");
      if (score === null) { qualityValue.textContent = t("conditions.unavailable"); qualityDetail.textContent = t("conditions.noIndexData"); }
      else {
        qualityValue.textContent = `${score}/100`;
        const rating = score >= 80 ? t("ui.veryFavorable") : score >= 60 ? t("ui.ratherFavorable") : score >= 40 ? t("ui.mixed") : t("ui.unfavorable");
        qualityDetail.textContent = `${rating} · ${t("conditions.indexBasis")}`;
        quality.dataset.quality = score >= 60 ? "good" : score >= 40 ? "mixed" : "poor";
      }
      quality.append(qualityLabel, qualityValue, qualityDetail); contentCards.push(quality);
      const precipitationText = Number.isFinite(c.precipitation_probability)
        ? `${Math.round(c.precipitation_probability)} %`
        : Number.isFinite(c.precipitation) ? `${c.precipitation} mm` : t("ui.unavailable");
      const rows = [
        ["clouds", t("conditions.cardClouds"), Number.isFinite(c.cloud_cover) ? `${Math.round(c.cloud_cover)} %` : t("conditions.unavailable"), t("conditions.cardCloudsDesc"), t("conditions.cardCloudsAria")],
        ["temp", t("conditions.cardTemp"), Number.isFinite(c.temperature_2m) ? `${Math.round(c.temperature_2m)} °C` : t("conditions.unavailable"), Number.isFinite(c.apparent_temperature) ? `${t("conditions.cardTempFeelsLike")} ${Math.round(c.apparent_temperature)} °C` : "", t("conditions.cardTempAria")],
        ["rain", t("conditions.cardRain"), precipitationText, Number.isFinite(c.precipitation_probability) ? `${t("conditions.probability")} · ${hasTargetForecast ? t("conditions.hourlyForecast") : t("conditions.currentValue")}` : (hasTargetForecast ? t("conditions.forecastedQuantity") : t("conditions.currentQuantity")), t("conditions.cardRainAria")],
        ["humidity", t("conditions.cardHumidity"), Number.isFinite(c.relative_humidity_2m) ? `${Math.round(c.relative_humidity_2m)} %` : t("conditions.unavailable"), t("conditions.cardHumidityDesc"), t("conditions.cardHumidityAria")],
        ["wind", t("conditions.cardWind"), Number.isFinite(c.wind_speed_10m) ? `${Math.round(c.wind_speed_10m)} km/h` : t("conditions.unavailable"), t("conditions.cardWindDesc"), t("conditions.cardWindAria")],
        ["visibility", t("conditions.cardVisibility"), Number.isFinite(c.visibility) ? `${(c.visibility / 1000).toLocaleString(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km` : t("conditions.unavailable"), t("conditions.cardVisibilityDesc"), t("conditions.cardVisibilityAria")]
      ];
      const explanations = {
        "clouds": t("conditions.helpClouds"),
        "temp": t("conditions.helpTemp"),
        "rain": t("conditions.helpRain"),
        "humidity": t("conditions.helpHumidity"),
        "wind": t("conditions.helpWind"),
        "visibility": t("conditions.helpVisibility")
      };
      for (const [id, label, value, detail, fullLabel] of rows) {
        const card = document.createElement("article");
        card.className = "condition-card condition-weather-card";
        card.setAttribute("aria-label", fullLabel);
        card.title = explanations[id] || fullLabel;
        const l = document.createElement("span"); l.textContent = label;
        const v = document.createElement("strong"); v.textContent = value;
        const d = document.createElement("small"); d.textContent = detail;
        card.append(l, v, d); contentCards.push(card);
      }
      const help = document.createElement("details"); help.className = "conditions-help";
      const helpSummary = document.createElement("summary"); helpSummary.textContent = t("conditions.howToRead");
      const helpText = document.createElement("p"); helpText.textContent = t("conditions.howToReadText");
      help.append(helpSummary, helpText); contentCards.push(help);
      const lightPollution = createLightPollutionMapCard();
      contentCards.push(lightPollution);
      const source = document.createElement("p"); source.className = "conditions-source muted"; source.textContent = t("conditions.sourceFull"); contentCards.push(source);
      renderConditionsLayout(content, contentCards);
    } catch (error) {
      updateSessionWeatherStatus(null);
      content.replaceChildren();
      const p = document.createElement("p"); p.className = "muted"; p.textContent = t("conditions.weatherUnavailable"); content.append(p);
      const lightPollution = createLightPollutionMapCard();
      const source = document.createElement("p"); source.className = "conditions-source muted"; source.textContent = t("conditions.sourceMapOnly");
      renderConditionsLayout(content, [p, source, lightPollution]);
    }
  }

  function bindControls() {
    if (controlsBound) {
      return;
    }

    controlsBound = true;

    // L’interface complète est affichée au démarrage pour activer la position et la boussole.
    // Une fois masquée, un bouton flottant permet de la réafficher.
    const toggleInterface = () => {
      const app = $("app");
      const button = $("interface-toggle");
      if (!app || !button) return;
      const hidden = !app.classList.contains("interface-hidden");
      app.classList.toggle("interface-hidden", hidden);
      button.setAttribute("aria-pressed", String(hidden));
      button.setAttribute("aria-label", t("ui.showInterface"));
      button.setAttribute("title", t("ui.showInterfaceTitle"));
      button.innerHTML = '<span aria-hidden="true">☰</span>';
    };
    on("interface-toggle", "click", toggleInterface);
    on("hide-interface-btn", "click", toggleInterface);

    // Mode Découverte : présentation pédagogique utilisant les mêmes données et calculs.
    const modeSwitch = $("mode-switch");
    const discoveryPanel = $("discovery-panel");
    // v472 : petites aides contextuelles de première utilisation, sans tutoriel permanent.
    // Elles utilisent le toast existant, disparaissent seules et sont mémorisées pour l’onglet.
    let activeDiscoveryHint = "";
    const discoveryHintMessages = {
      free: t("ui.pointPhoneToSkyPortion"),
      search: t("ui.enterCommonName"),
      start: t("ui.chooseTargetToHighlight"),
      orient: t("ui.activateCompassThenTurnPhone"),
      constellations: t("ui.discoveryConstellationsHint"),
      walks: t("ui.chooseWalkThenAdvanceStepByStep")
    };
    const dismissDiscoveryHint = key => {
      if (key && activeDiscoveryHint !== key) return;
      if (!activeDiscoveryHint) return;
      activeDiscoveryHint = "";
      clearTimeout(toastTimer);
      $("toast")?.classList.remove("show");
    };
    const showDiscoveryHint = key => {
      const message = discoveryHintMessages[key];
      if (!message) return;
      dismissDiscoveryHint();
      let seen = false;
      try { seen = sessionStorage.getItem(`atlas-celeste-v472-hint-${key}`) === "1"; } catch (_) {}
      if (seen) return;
      try { sessionStorage.setItem(`atlas-celeste-v472-hint-${key}`, "1"); } catch (_) {}
      activeDiscoveryHint = key;
      showToast(message);
    };
    const discoveryMapGuide = $("discovery-map-guide");
    const discoveryMapGuideToggle = $("discovery-map-guide-toggle");
    let discoveryPreviousSettings = null;
    const setDiscoveryMapGuideVisible = visible => {
      if (discoveryMapGuide) discoveryMapGuide.hidden = !visible;
      $("app")?.classList.toggle("discovery-map-guide-open", Boolean(visible));
      if (discoveryMapGuideToggle) {
        discoveryMapGuideToggle.hidden = !$("app")?.classList.contains("discovery-mode");
        discoveryMapGuideToggle.setAttribute("aria-expanded", String(Boolean(visible)));
        const label = visible ? t("ui.hideLegend") : t("ui.readMap");
        discoveryMapGuideToggle.setAttribute("aria-label", label);
        discoveryMapGuideToggle.setAttribute("title", label);
        discoveryMapGuideToggle.innerHTML = '<span aria-hidden="true">ⓘ</span>';
      }
    };
    discoveryMapGuideToggle?.addEventListener("click", () => {
      setDiscoveryMapGuideVisible(Boolean(discoveryMapGuide?.hidden));
    });
    const setDiscoveryMode = (active, persist = true) => {
      const app = $("app");
      if (!app) return;
      app.classList.toggle("discovery-mode", active);
      // Un repère épinglé par la recherche appartient au mode Découverte :
      // l'effacer en changeant de mode évite qu'il réapparaisse plus tard.
      app.classList.remove("discovery-search-target-active");
      // v375 : effacer les repères pédagogiques de constellation en quittant Découverte.
      // Le rendu est aussi conditionné par discoveryMode dans app.js, pour éviter
      // qu’un cercle, une flèche ou « À repérer » subsiste en mode Expert.
      if (!active) {
        state.discoveryConstellationId = "";
        state.discoveryConstellationStarIds = new Set();
        state.discoveryConstellationTargetStarId = "";
        state.discoveryConstellationSequence = [];
        state.discoveryConstellationStepIndex = 0;
        const picker = $("discovery-constellation-picker");
        if (picker) picker.hidden = true;
        const select = $("discovery-constellation-select");
        if (select) select.value = "";
        const details = $("discovery-constellation-details");
        if (details) details.hidden = true;
        const diagram = $("discovery-constellation-diagram");
        if (diagram) diagram.hidden = true;
        $("discovery-constellation-diagram-lines")?.replaceChildren();
        $("discovery-constellation-diagram-stars")?.replaceChildren();
        $("discovery-constellation-diagram-labels")?.replaceChildren();
      }
      if (!active && $("solar-system-dialog") && !$("solar-system-dialog").hidden) {
        $("solar-system-close")?.click();
      }
      if (!active && $("jupiter-moons-dialog") && !$("jupiter-moons-dialog").hidden) {
        $("jupiter-moons-close")?.click();
      }
      if (!active && $("universe-journey-dialog") && !$("universe-journey-dialog").hidden) {
        $("universe-journey-close")?.click();
      }
      state.discoveryWalkOverlay = null;
      if (typeof drawSky === "function") drawSky();
      if (state.selected && !$("object-card")?.hidden) updateObjectCard(state.selected);
      if (discoveryPanel) discoveryPanel.hidden = !active;
      setDiscoveryMapGuideVisible(false);
      if (discoveryMapGuideToggle) discoveryMapGuideToggle.hidden = !active;
      const discoveryCompassToggle = $("discovery-compass-toggle");
      if (discoveryCompassToggle) syncSensorButton();
      if (modeSwitch) {
        const label = active ? t("ui.switchToExpertMode") : t("ui.switchToDiscoveryMode");
        modeSwitch.setAttribute("aria-pressed", String(active));
        modeSwitch.setAttribute("aria-label", label);
        modeSwitch.title = label;
        modeSwitch.innerHTML = active
          ? '<span class="mode-switch-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="m4 7 10-4 3 6-10 4z"/><path d="m6.5 6 10 3M9 12l4 4M13 16l-3 5M13 16l6 5M13 16l1.2-5"/><path d="m14 3 2.5-1M17 9l2.2-.9"/></svg></span>'
          : '<span class="mode-switch-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="m12 2 2.2 6.2L21 10l-6.8 2.1L12 19l-2.2-6.9L3 10l6.8-1.8z"/><path d="m18.5 16 .9 2.1 2.1.9-2.1.8-.9 2.2-.8-2.2-2.2-.8 2.2-.9z"/><circle cx="5" cy="18" r="1"/></svg></span>';
      }
      // Les silhouettes et noms sont activés en Découverte, puis les réglages Expert sont restaurés.
      const constellations = $("setting-constellations");
      const labels = $("setting-star-labels");
      if (active) {
        discoveryPreviousSettings = {
          constellations: Boolean(constellations?.checked),
          labels: labels ? Boolean(labels.checked) : true
        };
        if (persist) {
          // Lorsqu'on revient à Découverte après une session Expert, ne pas
          // réactiver automatiquement les tracés de constellations : l'utilisateur
          // retrouve une carte dégagée. Les réglages Expert seront restaurés à la sortie.
          if (constellations && (constellations.checked || state.showConstellations)) {
            constellations.checked = false;
            constellations.dispatchEvent(new Event("change", { bubbles: true }));
          } else {
            state.showConstellations = false;
          }
        } else if (constellations && (!constellations.checked || !state.showConstellations)) {
          // Au démarrage, on conserve le comportement initial validé de Découverte.
          constellations.checked = true;
          constellations.dispatchEvent(new Event("change", { bubbles: true }));
        }
        if (labels && !labels.checked) {
          labels.checked = true;
          labels.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } else if (discoveryPreviousSettings) {
        if (constellations && constellations.checked !== discoveryPreviousSettings.constellations) {
          constellations.checked = discoveryPreviousSettings.constellations;
          constellations.dispatchEvent(new Event("change", { bubbles: true }));
        }
        if (labels && labels.checked !== discoveryPreviousSettings.labels) {
          labels.checked = discoveryPreviousSettings.labels;
          labels.dispatchEvent(new Event("change", { bubbles: true }));
        }
        discoveryPreviousSettings = null;
      }
      if (persist) {
        try { localStorage.setItem("atlas-celeste-interface-mode", active ? "discovery" : "expert"); } catch (_) {}
      }
    };
    on("mode-switch", "click", () => setDiscoveryMode(!$("app")?.classList.contains("discovery-mode")));
    // Sur mobile, le panneau se replie après le choix d'une constellation.
    // Une poignée reste visible et peut être remontée par glissement vertical.
    const discoveryHandle = $("discovery-panel-handle");
    const DISCOVERY_MENU_COLLAPSED_KEY = "atlas-celeste-discovery-menu-collapsed";
    const setDiscoveryPanelCollapsed = (collapsed, remember = false) => {
      if (!discoveryPanel) return;
      const mobile = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 600px)").matches;
      // Seul un geste de l'utilisateur sur la poignée est mémorisé : le repli
      // automatique après le lancement d'un guidage ne change pas le démarrage suivant.
      if (remember && mobile) {
        try { localStorage.setItem(DISCOVERY_MENU_COLLAPSED_KEY, collapsed ? "1" : "0"); } catch { /* stockage indisponible */ }
      }
      discoveryPanel.classList.toggle("is-collapsed", Boolean(collapsed && mobile));
      discoveryHandle?.setAttribute("aria-expanded", String(!discoveryPanel.classList.contains("is-collapsed")));
      if (discoveryHandle) discoveryHandle.innerHTML = discoveryPanel.classList.contains("is-collapsed")
        ? t("ui.discoveryMenuBtn") : t("ui.collapseMenuBtn");
    };
    collapseDiscoveryPanelAfterGuideStart = () => {
      // Ne toucher au panneau que si le mode Découverte est actuellement actif.
      if ($("app")?.classList.contains("discovery-mode")) setDiscoveryPanelCollapsed(true);
    };
    discoveryHandle?.addEventListener("click", () => setDiscoveryPanelCollapsed(!discoveryPanel?.classList.contains("is-collapsed"), true));
    if (discoveryHandle && discoveryPanel) {
      let panelTouchStartY = null;
      let panelWasDragged = false;
      discoveryHandle.addEventListener("click", event => {
        if (panelWasDragged) { event.preventDefault(); event.stopImmediatePropagation(); panelWasDragged = false; }
      }, true);
      discoveryHandle.addEventListener("pointerdown", event => { panelTouchStartY = event.clientY; panelWasDragged = false; }, { passive: true });
      discoveryHandle.addEventListener("pointerup", event => {
        if (panelTouchStartY === null) return;
        const delta = event.clientY - panelTouchStartY;
        panelTouchStartY = null;
        if (Math.abs(delta) < 18) return;
        panelWasDragged = true;
        // Glisser vers le bas replie le panneau ; vers le haut le réaffiche.
        setDiscoveryPanelCollapsed(delta > 0, true);
      }, { passive: true });
      discoveryHandle.addEventListener("pointercancel", () => { panelTouchStartY = null; }, { passive: true });
    }

    // Au lancement de chaque session, toujours ouvrir en mode Découverte.
    // Le passage en mode Expert reste possible pendant la session, mais ne
    // remplace pas le mode de démarrage au prochain chargement.
    setDiscoveryMode(true, false);
    // Mobile : restaurer le dernier choix de l'utilisateur (menu replié ou ouvert)
    // et synchroniser le libellé de la poignée avec l'état réel du panneau.
    {
      let savedCollapsed = false;
      try { savedCollapsed = localStorage.getItem(DISCOVERY_MENU_COLLAPSED_KEY) === "1"; } catch { /* stockage indisponible */ }
      setDiscoveryPanelCollapsed(savedCollapsed);
    }
    const getSkyWalks = () => ({
      polaris: { title: t("ui.findPolaris"), constellation: "ursa major", overlay: { color: "#ff514d", segments: [{ from: "Merak", to: "Dubhe" }, { from: "Dubhe", to: "Polaris", dashed: true }], target: "Polaris" }, stepOverlays: [
        { color: "#ff514d", segments: [{ from: "Dubhe", to: "Merak" }, { from: "Merak", to: "Phecda" }, { from: "Phecda", to: "Megrez" }, { from: "Megrez", to: "Dubhe" }], target: "Dubhe" },
        { color: "#ff514d", segments: [{ from: "Merak", to: "Dubhe" }, { from: "Dubhe", to: "Polaris", dashed: true }], target: "Dubhe" },
        { color: "#ff514d", segments: [{ from: "Merak", to: "Dubhe" }, { from: "Dubhe", to: "Polaris", dashed: true }], target: "Polaris" }
      ], intro: t("walk.polarisIntro"), steps: [
        t("walk.polarisStep1"),
        t("walk.polarisStep2"),
        t("walk.polarisStep3")
      ], tip: t("walk.polarisTip"), search: ["grande ourse", "ursa major"] },
      summer: { title: t("ui.summerTriangle"), constellation: "lyra", overlay: { color: "#ff514d", segments: [{ from: "Vega", to: "Deneb" }, { from: "Deneb", to: "Altair" }, { from: "Altair", to: "Vega" }], target: "Vega" }, stepOverlays: [
        { color: "#ff514d", segments: [], target: "Vega" },
        { color: "#ff514d", segments: [{ from: "Vega", to: t("names.star.deneb"), dashed: true }], target: "Deneb" },
        { color: "#ff514d", segments: [{ from: "Vega", to: "Deneb" }, { from: "Deneb", to: "Altair" }, { from: "Altair", to: "Vega" }], target: "Altair" }
      ], intro: t("walk.summerIntro"), steps: [
        t("walk.summerStep1"),
        t("walk.summerStep2"),
        t("walk.summerStep3")
      ], tip: t("walk.summerTip"), search: ["lyre", "lyra"] },
      orion: { title: t("ui.recognizeOrion"), constellation: "orion", overlay: { color: "#ff514d", segments: [{ from: "Mintaka", to: "Alnilam" }, { from: "Alnilam", to: "Alnitak" }], target: "Betelgeuse" }, stepOverlays: [
        { color: "#ff514d", segments: [{ from: t("names.star.mintaka"), to: "Alnilam" }, { from: "Alnilam", to: "Alnitak" }], target: "Mintaka" },
        { color: "#ff514d", segments: [{ from: "Mintaka", to: "Alnilam" }, { from: "Alnilam", to: "Alnitak" }], target: "Betelgeuse" },
        { color: "#ff514d", segments: [{ from: "Mintaka", to: "Alnilam" }, { from: "Alnilam", to: "Alnitak" }], target: t("names.star.rigel") }
      ], intro: t("walk.orionIntro"), steps: [
        t("walk.orionStep1"),
        t("walk.orionStep2"),
        t("walk.orionStep3")
      ], tip: t("walk.orionTip"), search: ["orion"] },
      pleiades: { title: t("ui.spotPleiades"), constellation: "taurus", overlay: { color: "#ff514d", segments: [{ from: "Aldebaran", to: "Alcyone", dashed: true }], targetObject: "M45" }, stepOverlays: [
        { color: "#ff514d", segments: [], target: "Aldebaran" },
        { color: "#ff514d", segments: [{ from: "Aldebaran", to: "Alcyone", dashed: true }], targetObject: "M45" },
        { color: "#ff514d", segments: [{ from: "Aldebaran", to: "Alcyone", dashed: true }], targetObject: "M45" }
      ], intro: t("walk.pleiadesIntro"), steps: [
        t("walk.pleiadesStep1"),
        t("walk.pleiadesStep2"),
        t("walk.pleiadesStep3")
      ], tip: t("walk.pleiadesTip"), search: ["taureau", "taurus"] },
      winterhex: { title: t("walk.winterHexTitle"), constellation: "orion", overlay: { color: "#ff514d", segments: [{ from: t("names.star.sirius"), to: "Rigel" }, { from: "Rigel", to: "Aldebaran" }, { from: "Aldebaran", to: "Capella" }, { from: "Capella", to: "Pollux" }, { from: "Pollux", to: "Procyon" }, { from: "Procyon", to: "Sirius" }], target: "Sirius" }, stepOverlays: [
        { color: "#ff514d", segments: [], target: t("names.star.sirius") },
        { color: "#ff514d", segments: [{ from: "Sirius", to: "Rigel" }, { from: "Rigel", to: "Aldebaran" }], target: "Aldebaran" },
        { color: "#ff514d", segments: [{ from: "Sirius", to: "Rigel" }, { from: "Rigel", to: "Aldebaran" }, { from: "Aldebaran", to: t("names.star.capella") }, { from: "Capella", to: "Pollux" }, { from: "Pollux", to: "Procyon" }, { from: "Procyon", to: "Sirius" }], target: "Capella" }
      ], intro: t("walk.winterHexIntro"), steps: [
        t("walk.winterHexStep1"),
        t("walk.winterHexStep2"),
        t("walk.winterHexStep3")
      ], tip: t("walk.winterHexTip"), search: ["orion", "taureau", "cocher", "gémeaux", "grand chien", "petit chien"] },
      springtriangle: { title: t("walk.springTriTitle"), constellation: "bootes", overlay: { color: "#ff514d", segments: [{ from: t("names.star.arcturus"), to: "Spica" }, { from: "Spica", to: "Regulus" }, { from: "Regulus", to: "Arcturus" }], target: "Arcturus" }, stepOverlays: [
        { color: "#ff514d", segments: [], target: t("names.star.arcturus") },
        { color: "#ff514d", segments: [{ from: "Arcturus", to: t("names.star.spica"), dashed: true }], target: "Spica" },
        { color: "#ff514d", segments: [{ from: "Arcturus", to: "Spica" }, { from: "Spica", to: "Regulus" }, { from: "Regulus", to: "Arcturus" }], target: "Regulus" }
      ], intro: t("walk.springTriIntro"), steps: [
        t("walk.springTriStep1"),
        t("walk.springTriStepMiddle"),
        t("walk.springTriStep2")
      ], tip: t("walk.springTriTip"), search: ["bouvier", "vierge", "lion"] },
      dippertoarcturus: { title: t("walk.dipperToArcturusTitle"), constellation: "bootes", overlay: { color: "#ff514d", segments: [{ from: "Merak", to: "Dubhe" }, { from: "Dubhe", to: "Alkaid", dashed: true }, { from: "Alkaid", to: "Arcturus", dashed: true }, { from: "Arcturus", to: t("names.star.spica"), dashed: true }], target: "Spica" }, stepOverlays: [
        { color: "#ff514d", segments: [{ from: "Merak", to: "Dubhe" }], target: "Dubhe" },
        { color: "#ff514d", segments: [{ from: "Merak", to: "Dubhe" }, { from: "Dubhe", to: "Alkaid", dashed: true }, { from: "Alkaid", to: t("names.star.arcturus"), dashed: true }], target: "Arcturus" },
        { color: "#ff514d", segments: [{ from: "Merak", to: "Dubhe" }, { from: "Dubhe", to: "Alkaid", dashed: true }, { from: "Alkaid", to: "Arcturus", dashed: true }, { from: "Arcturus", to: t("names.star.spica"), dashed: true }], target: "Spica" }
      ], intro: t("walk.dipperToArcturusIntro"), steps: [
        t("walk.dipperToArcturusStep1"),
        t("walk.dipperToArcturusStep2"),
        t("walk.dipperToArcturusStep3")
      ], tip: t("walk.dipperToArcturusTip"), search: ["grande ourse", "bouvier", "vierge"] },
      andromeda: { title: t("ui.findAndromedaGalaxy"), constellation: "andromeda", overlay: { color: "#ff514d", segments: [{ from: "Alpheratz", to: "Mirach" }, { from: "Mirach", to: "Mu Andromedae", dashed: true }], targetObject: "M31" }, stepOverlays: [
        { color: "#ff514d", segments: [], target: "Alpheratz" },
        { color: "#ff514d", segments: [{ from: "Alpheratz", to: t("names.star.mirach") }], target: "Mirach" },
        { color: "#ff514d", segments: [{ from: "Alpheratz", to: "Mirach" }, { from: "Mirach", to: "Mu Andromedae", dashed: true }], targetObject: "M31" }
      ], intro: t("walk.andromedaIntro"), steps: [
        t("walk.andromedaStep1"),
        t("walk.andromedaStep2"),
        t("walk.andromedaStep3")
      ], tip: t("walk.andromedaTip"), search: [t("walk.andromedaConstellation"), "andromeda"] }
   });
    // Filtrage limité à la liste des balades. On réutilise les positions
    // calculées par le moteur de l'atlas ; aucune modification de drawSky.
    refreshSkyWalkAvailability = () => {
      const catalog = typeof getCatalogObjects === "function" ? getCatalogObjects() : null;
      if (!Array.isArray(catalog) || !catalog.length) return;
      const normalize = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const m45 = catalog.find(object => normalize(object.id) === "m45" || normalize(object.name) === "pleiades" || normalize(object.name) === "pleiadesamas");
      // M45 doit être suffisamment haute, et son étoile repère Aldébaran
      // doit elle aussi être au-dessus de l'horizon pour proposer cette balade.
      // Si l'une des deux positions est absente ou invalide, masquer la balade.
      const aldebaran = (state.stars || []).find(star => {
        const hip = Number(star.hip ?? String(star.id || "").match(/(?:HIP[_\s-]*)?(\d+)/i)?.[1]);
        return hip === 21421;
      });
      const aldebaranPosition = aldebaran && typeof getStarPosition === "function"
        ? getStarPosition(aldebaran)
        : null;
      const aldebaranVisible = Number.isFinite(aldebaranPosition?.alt) && aldebaranPosition.alt > 0;
      const pleiadesVisible = Boolean(
        m45 && Number.isFinite(m45.alt) && m45.alt > 3 && aldebaranVisible
      );
      const orionHips = new Set([24436, 25336, 25930, 26311, 26727, 27366, 27989]);
      const orionStars = (state.stars || []).filter(star => {
        const match = Number(star.hip ?? String(star.id || "").match(/(?:HIP[_\s-]*)?(\d+)/i)?.[1]);
        return orionHips.has(match);
      });
      // Si les repères d'Orion ne sont pas chargés, conserver la balade visible.
      const orionVisible = orionStars.length === 0 || orionStars.some(star => {
        const position = typeof getStarPosition === "function" ? getStarPosition(star) : null;
        return Number.isFinite(position?.alt) && position.alt > 0;
      });
      document.querySelectorAll("[data-sky-walk]").forEach(button => {
        if (button.dataset.skyWalk === "orion") button.hidden = !orionVisible;
        else if (button.dataset.skyWalk === "pleiades") button.hidden = !pleiadesVisible;
      });
    };

    let activeSkyWalk = "";
    let activeSkyWalkStep = 0;
    let skyWalkMapShown = false;
    const renderSkyWalk = () => {
      const walk = getSkyWalks()[activeSkyWalk];
      const detail = $("discovery-walk-detail");
      if (!walk || !detail) return;
      detail.hidden = false;
      $("discovery-walk-title").textContent = walk.title;
      $("discovery-walk-intro").textContent = walk.intro;
      const mobileWalk = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 600px)").matches;
      $("discovery-walk-step-count").textContent = mobileWalk ? "" : `${t("ui.step")} ${activeSkyWalkStep + 1} ${t("ui.of")} ${walk.steps.length}`;
      $("discovery-walk-step-text").textContent = walk.steps[activeSkyWalkStep];
      const mobileText = $("discovery-walk-mobile-text");
      if (mobileText) {
        mobileText.textContent = walk.steps.join(" ");
        mobileText.hidden = !mobileWalk || skyWalkMapShown;
      }
      $("discovery-walk-tip").textContent = walk.tip;
      $("discovery-walk-prev").disabled = activeSkyWalkStep === 0;
      $("discovery-walk-next").textContent = activeSkyWalkStep === walk.steps.length - 1 ? t("walk.restart") : t("ui.stepNext");
      const showButton = $("discovery-walk-show-constellation");
      if (showButton) showButton.textContent = mobileWalk && skyWalkMapShown ? t("walk.backToText") : t("walk.showOnMap");
      const walksPanel = $("discovery-walks");
      if (walksPanel) walksPanel.classList.toggle("is-map-shown", mobileWalk && skyWalkMapShown);
      $("discovery-panel")?.classList.toggle("has-walk-map", mobileWalk && skyWalkMapShown);
      document.querySelectorAll("[data-sky-walk]").forEach(button => button.classList.toggle("is-active", button.dataset.skyWalk === activeSkyWalk));
      if (skyWalkMapShown) {
        state.discoveryWalkOverlay = walk.stepOverlays?.[activeSkyWalkStep] || walk.overlay || null;
        if (typeof drawSky === "function") drawSky();
      }
    };
    const populateDiscoveryConstellations = select => {
      if (!select) return;
      const previousValue = String(select.value || "");
      select.replaceChildren(new Option(t("discovery.constellationPicker.placeholder"), ""));
      const starsById = new Map((state.stars || []).map(star => [String(star.id), star]));
      const list = [...(state.constellations || [])].filter(item => {
        if (!item || !item.id || !(item.name || item.name_fr)) return false;
        const memberIds = new Set((item.lines || []).flatMap(segment => Array.isArray(segment) ? segment.map(String) : []));
        for (const id of memberIds) {
          const star = starsById.get(id);
          if (!star) continue;
          const position = typeof getStarPosition === "function" ? getStarPosition(star) : null;
          if (Number.isFinite(position?.alt) && position.alt > 0) return true;
        }
        return false;
      }).sort((a, b) => localizedConstellationName(a).localeCompare(localizedConstellationName(b), getLocale()));
      for (const item of list) {
        const option = document.createElement("option");
        option.value = String(item.id);
        option.textContent = localizedConstellationName(item);
        select.appendChild(option);
      }
      if (list.length === 0) {
        const option = document.createElement("option");
        option.value = ""; option.textContent = t("constellation.noneVisible");
        option.disabled = true; select.appendChild(option);
      }
      if (previousValue && [...select.options].some(option => option.value === previousValue)) select.value = previousValue;
    };
    const selectSkyWalkConstellation = walk => {
      const picker = $("discovery-constellation-picker");
      const select = $("discovery-constellation-select");
      // Construire la liste sans simuler un clic sur « Constellations » :
      // ce clic changerait de rubrique et fermerait la balade en cours.
      if (select) {
        // La liste peut avoir été remplie plus tôt, à un autre instant ou
        // avant le chargement complet des catalogues. La reconstruire évite
        // de conserver une liste périmée qui exclut Orion ou le Taureau.
        populateDiscoveryConstellations(select);
        const normalize = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").replace(/[^a-z0-9]/g, "");
        const wanted = normalize(walk.constellation);
        const constellation = (state.constellations || []).find(item =>
          [item.id, item.name, item.name_fr, item.englishName, item.english_name]
            .some(value => normalize(value) === wanted)
        );
        let option = constellation
          ? [...select.options].find(item => String(item.value) === String(constellation.id))
          : null;
        // Une balade peut rester disponible lorsqu'un de ses repères est
        // visible même si le filtre du sélecteur a temporairement exclu la
        // constellation officielle. Ajouter alors son option explicitement.
        if (!option && constellation) {
          option = document.createElement("option");
          option.value = String(constellation.id);
          option.textContent = localizedConstellationName(constellation) || walk.title;
          select.appendChild(option);
        }
        if (!option) {
          option = [...select.options].find(item => walk.search.some(term => normalize(item.textContent).includes(normalize(term))));
        }
        if (option) {
          select.value = option.value;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      if (picker) picker.hidden = true;
      document.querySelector('[data-discovery-action="constellations"]')?.classList.remove("is-active");
    };
    const frameSkyWalkOnMap = walk => {
      // Une balade peut relier plusieurs constellations : le zoom automatique
      // de « Découvrir une constellation » ne suffit donc pas. Cadre l'ensemble
      // des étoiles utilisées par toutes les étapes du parcours.
      if (!walk || !Array.isArray(state.stars) || typeof getStarPosition !== "function") return;
      const normalize = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").replace(/[^a-z0-9]/g, "");
      const aliases = {
        polaris: 11767, "etoilepolaire": 11767, merak: 53910, merak2: 53910,
        dubhe: 54061, dubhe2: 54061, phecda: 58001, megrez: 59774, alioth: 62956, mizar: 65378,
        vega: 91262, deneb: 102098, altair: 97649,
        aldebaran: 21421, alcyone: 17702, alpheratz: 677, mirach: 5447,
        betelgeuse: 27989, mintaka: 25930, alnilam: 26311, alnitak: 26727,
        rigel: 24436, sirius: 32349, capella: 24608, pollux: 37826,
        procyon: 37279, arcturus: 69673, spica: 65474, regulus: 49669,
        alkaid: 67301, muandromedae: 116631
      };
      const names = new Set();
      const targetObjects = new Set();
      const overlays = [...(walk.stepOverlays || []), walk.overlay].filter(Boolean);
      for (const overlay of overlays) {
        for (const segment of overlay.segments || []) {
          if (segment.from) names.add(segment.from);
          if (segment.to) names.add(segment.to);
        }
        if (overlay.target) names.add(overlay.target);
        if (overlay.targetObject) targetObjects.add(overlay.targetObject);
      }
      const starsByHip = new Map(state.stars.map(star => [Number(star.hip ?? String(star.id || "").match(/(?:HIP[_\s-]*)?(\d+)/i)?.[1]), star]));
      const starsById = new Map(state.stars.map(star => [String(star.id), star]));
      const indexed = new Map();
      for (const star of state.stars) {
        const values = [star.name, star.designation, star.proper_name, star.properName, star.id, star.bayer, star.flamsteed, star.hd, star.hip];
        if (typeof displayStarName === "function") values.push(displayStarName(star));
        for (const value of values) if (value) indexed.set(normalize(value), star);
      }
      const positions = [];
      const includedStarIds = new Set();
      const addStarPosition = star => {
        if (!star || includedStarIds.has(String(star.id))) return;
        const horizontal = getStarPosition(star);
        if (Number.isFinite(horizontal?.az) && Number.isFinite(horizontal?.alt) && horizontal.alt > 0) {
          positions.push({ horizontal });
          includedStarIds.add(String(star.id));
        }
      };
      for (const name of names) {
        const key = normalize(name);
        addStarPosition(indexed.get(key) || (aliases[key] ? starsByHip.get(aliases[key]) : null));
      }
      // Cadre aussi la constellation officielle associée à la balade. Sinon,
      // deux seuls repères (ceinture d'Orion ou Aldébaran–Alcyone) peuvent
      // cadrer trop serré et laisser toute la figure hors champ.
      const walkConstellationKey = normalize(walk.constellation);
      const constellation = (state.constellations || []).find(item =>
        [item.id, item.name, item.name_fr, item.englishName, item.english_name]
          .some(value => normalize(value) === walkConstellationKey)
      );
      if (constellation) {
        const memberIds = new Set((constellation.lines || []).flatMap(segment => Array.isArray(segment) ? segment.map(String) : []));
        for (const id of memberIds) addStarPosition(starsById.get(id));
      }
      // Les objets étendus (notamment M45) doivent participer au cadrage :
      // targetObject ne doit pas être traité comme un nom d'étoile.
      const catalogObjects = typeof getCatalogObjects === "function" ? getCatalogObjects() || [] : [];
      for (const targetName of targetObjects) {
        const targetKey = normalize(targetName);
        const object = catalogObjects.find(candidate =>
          [candidate.id, candidate.name, candidate.designation, candidate.common_name, candidate.commonName]
            .some(value => normalize(value) === targetKey)
        );
        if (object && Number.isFinite(object.az) && Number.isFinite(object.alt) && object.alt > 0) {
          positions.push({ horizontal: { az: object.az, alt: object.alt } });
        }
      }
      if (!positions.length) return;
      const sx = positions.reduce((sum, entry) => sum + Math.sin(entry.horizontal.az * Math.PI / 180), 0);
      const cx = positions.reduce((sum, entry) => sum + Math.cos(entry.horizontal.az * Math.PI / 180), 0);
      state.heading = norm360(Math.atan2(sx, cx) * 180 / Math.PI);
      // La caméra doit réellement viser l'altitude moyenne des étoiles ciblées.
      // Limiter le pitch à 12° laissait les étoiles hautes hors champ : le tracé
      // était bien calculé, mais entièrement projeté au-dessus de la carte.
      state.pitch = clamp(positions.reduce((sum, entry) => sum + entry.horizontal.alt, 0) / positions.length, 0, 80);
      const offsets = positions.map(entry => {
        let delta = entry.horizontal.az - state.heading;
        while (delta > 180) delta -= 360;
        while (delta < -180) delta += 360;
        return Math.abs(delta);
      });
      const maxOffset = Math.max(0, ...offsets);
      const maxAltitude = Math.max(...positions.map(entry => entry.horizontal.alt));
      const horizontalFov = maxOffset * 2 * 1.3;
      const verticalFov = 2 * (maxAltitude - state.pitch + 10) / (83.3333333333 / 75);
      state.fov = clamp(Math.max(32, horizontalFov, verticalFov), 15, 120);
      state.verticalFov = clamp(state.fov * (83.3333333333 / 75), 15, 110);
      const zoomIndicator = $("zoom-level");
      if (zoomIndicator) zoomIndicator.textContent = `${(45 / state.fov).toLocaleString(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}×`;
      if (state.sensorActive && typeof sensors?.stopListening === "function") {
        sensors.stopListening();
        showToast(t("ui.mapFramedOnWalkLandmarks"));
      }
    };
    const activateSkyWalkMap = walk => {
      // La sélection de constellation et l'ouverture du sélecteur peuvent effacer
      // l'ancien tracé. On applique donc le cadrage et le tracé de la balade en dernier.
      selectSkyWalkConstellation(walk);
      frameSkyWalkOnMap(walk);
      skyWalkMapShown = true;
      state.discoveryWalkOverlay = walk.stepOverlays?.[activeSkyWalkStep] || walk.overlay || null;
      const walkList = $("discovery-walks-list");
      if (walkList) walkList.hidden = true;
      setDiscoveryPanelCollapsed(false);
      renderSkyWalk();
      if (typeof drawSky === "function") drawSky();
    };
    document.querySelectorAll("[data-sky-walk]").forEach(button => button.addEventListener("click", () => {
      activeSkyWalk = button.dataset.skyWalk || "";
      const walk = getSkyWalks()[activeSkyWalk];
      const mobileWalk = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 600px)").matches;
      activeSkyWalkStep = 0;
      skyWalkMapShown = false;
      state.discoveryWalkOverlay = null;
      if (typeof drawSky === "function") drawSky();
      const list = $("discovery-walks-list");
      // Sur mobile comme sur ordinateur, remplacer immédiatement la liste par
      // la fiche choisie : sinon, sur petit écran, la fiche peut rester sous la
      // liste et donner l'impression que le toucher n'a rien déclenché.
      const walksPanel = $("discovery-walks");
      if (walksPanel) {
        walksPanel.hidden = false;
        walksPanel.classList.remove("is-map-shown");
        walksPanel.classList.add("has-selected-walk");
      }
      if (list) list.hidden = true;
      const detail = $("discovery-walk-detail");
      if (detail) detail.hidden = false;
      $("discovery-panel")?.classList.remove("has-walk-map");
      renderSkyWalk();
      if (mobileWalk && detail) {
        // Faire défiler le conteneur lui-même : sur certains navigateurs mobiles,
        // scrollIntoView() sur l’article ne le rendait pas visible dans le dock.
        if (walksPanel) walksPanel.scrollTop = 0;
        const title = $("discovery-walk-title");
        if (title) {
          title.setAttribute("tabindex", "-1");
          title.focus({ preventScroll: true });
        }
        detail.scrollIntoView({ block: "nearest", behavior: "auto" });
      }
      // Sur ordinateur, la carte se met à jour dès le choix de la balade.
      // Sur mobile, la fiche s'affiche d'abord ; le bouton dédié montre ensuite la carte.
      if (!mobileWalk && walk) activateSkyWalkMap(walk);
    }));
    on("discovery-walk-detail-close", "click", () => {
      // Fermer uniquement la visite guidée : le catalogue reste ouvert pour
      // permettre de choisir immédiatement une autre balade.
      const list = $("discovery-walks-list");
      const detail = $("discovery-walk-detail");
      if (list) list.hidden = false;
      if (detail) detail.hidden = true;
      $("discovery-walks")?.classList.remove("has-selected-walk");
      activeSkyWalk = "";
      activeSkyWalkStep = 0;
      skyWalkMapShown = false;
      $("discovery-walks")?.classList.remove("is-map-shown");
      $("discovery-panel")?.classList.remove("has-walk-map");
      document.querySelectorAll("[data-sky-walk]").forEach(button => button.classList.remove("is-active"));
      state.discoveryWalkOverlay = null;
      if (typeof drawSky === "function") drawSky();
    });
    on("discovery-walks-close", "click", () => {
      // Le bouton × ferme tout le panneau et efface la balade ainsi que ses tracés.
      const panel = $("discovery-walks");
      if (panel) { panel.hidden = true; panel.classList.remove("is-map-shown"); }
      const list = $("discovery-walks-list");
      const detail = $("discovery-walk-detail");
      if (list) list.hidden = false;
      if (detail) detail.hidden = true;
      $("discovery-walks")?.classList.remove("has-selected-walk");
      activeSkyWalk = "";
      activeSkyWalkStep = 0;
      skyWalkMapShown = false;
      $("discovery-panel")?.classList.remove("has-walk-map");
      document.querySelectorAll('[data-discovery-action="walks"]').forEach(button => button.classList.remove("is-active"));
      document.querySelectorAll("[data-sky-walk]").forEach(button => button.classList.remove("is-active"));
      state.discoveryWalkOverlay = null;
      if (typeof drawSky === "function") drawSky();
    });
    const changeSkyWalkStep = direction => {
      const walk = getSkyWalks()[activeSkyWalk];
      if (!walk) return;
      const lastStep = walk.steps.length - 1;
      activeSkyWalkStep = direction > 0
        ? (activeSkyWalkStep >= lastStep ? 0 : activeSkyWalkStep + 1)
        : Math.max(0, activeSkyWalkStep - 1);
      // Le texte et le tracé cartographique doivent évoluer ensemble.
      // Sans cette synchronisation, la fiche change d'étape mais la carte
      // conserve l'overlay précédent (ou aucun overlay).
      if (skyWalkMapShown) {
        state.discoveryWalkOverlay = walk.stepOverlays?.[activeSkyWalkStep] || walk.overlay || null;
      }
      renderSkyWalk();
      if (skyWalkMapShown && typeof drawSky === "function") drawSky();
    };
    on("discovery-walk-prev", "click", () => changeSkyWalkStep(-1));
    on("discovery-walk-next", "click", () => changeSkyWalkStep(1));
    on("discovery-walk-show-constellation", "click", () => {
      const walk = getSkyWalks()[activeSkyWalk];
      if (!walk) return;
      const mobileWalk = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 600px)").matches;
      if (mobileWalk && skyWalkMapShown) {
        skyWalkMapShown = false;
        state.discoveryWalkOverlay = null;
        $("discovery-walks")?.classList.remove("is-map-shown");
        $("discovery-panel")?.classList.remove("has-walk-map");
        renderSkyWalk();
        if (typeof drawSky === "function") drawSky();
        return;
      }
      // Sur mobile, afficher directement le schéma final de la balade ; sur
      // ordinateur, conserver l’étape graphique actuellement sélectionnée.
      if (mobileWalk) activeSkyWalkStep = walk.steps.length - 1;
      activateSkyWalkMap(walk);
    });
    let discoverySearchCatalog = [];
    let discoverySearchFilter = "all";

    const matchesDiscoverySearchFilter = item => {
      if (discoverySearchFilter === "all") return true;
      const type = String(item?.type || "").toLowerCase();
      const catalogue = String(item?.catalogue || "").toLowerCase();
      if (discoverySearchFilter === "comet") return type === "comet" || catalogue.includes("comète");
      if (discoverySearchFilter === "planet") return ["planet", "sun", "moon"].includes(type) || catalogue === "système solaire";
      if (discoverySearchFilter === "galaxy") return type === "galaxy" || /galax/i.test(String(item?.name || ""));
      if (discoverySearchFilter === "cluster") return ["cluster", "open-cluster", "globular-cluster", "star-cluster"].includes(type) || /\bamas?\b/i.test(String(item?.name || ""));
      return true;
    };

    // Sur les WebView qui superposent le clavier au viewport, relever le panneau
    // de recherche au-dessus du clavier. Si le viewport est déjà redimensionné,
    // la valeur reste nulle et le positionnement CSS normal s'applique.
    const syncDiscoverySearchKeyboardInset = () => {
      const viewport = window.visualViewport;
      const inset = viewport
        ? Math.max(0, window.innerHeight - viewport.height - Math.max(0, viewport.offsetTop || 0))
        : 0;
      document.documentElement.style.setProperty("--discovery-keyboard-inset", `${Math.round(inset)}px`);
    };
    window.addEventListener("resize", syncDiscoverySearchKeyboardInset, { passive: true });
    window.visualViewport?.addEventListener("resize", syncDiscoverySearchKeyboardInset, { passive: true });
    window.visualViewport?.addEventListener("scroll", syncDiscoverySearchKeyboardInset, { passive: true });
    syncDiscoverySearchKeyboardInset();

    const refreshDiscoverySearchCatalog = () => {
      const objects = typeof getCatalogObjects === "function" ? getCatalogObjects() : [];
      const seen = new Set();
      discoverySearchCatalog = objects.map(object => {
        const commonName = getDiscoveryCommonName(object);
        return commonName ? { ...object, discoveryLabel: commonName } : null;
      }).filter(item => {
        if (!item) return false;
        const key = normalizeCatalogSearchText(item.discoveryLabel);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      }).sort((a, b) => a.discoveryLabel.localeCompare(b.discoveryLabel, "fr", { sensitivity: "base" }));

      // Le filtrage se fait uniquement dans la liste située sous le champ.
      // Pas de <datalist> natif : son menu flottant recouvre le champ sur mobile.
      renderDiscoverySearchResults();
    };

    const findCurrentDiscoverySearchObject = (item, catalog) => {
      const currentCatalog = Array.isArray(catalog) ? catalog : [];
      if (item.id != null) {
        const byId = currentCatalog.find(candidate => candidate.id != null
          && String(candidate.id) === String(item.id)
          && String(candidate.catalogue || "") === String(item.catalogue || ""));
        if (byId) return byId;
      }
      const itemName = normalizeCatalogSearchText(item.name || item.proper_name || "");
      return currentCatalog.find(candidate =>
        String(candidate.catalogue || "") === String(item.catalogue || "")
        && itemName
        && normalizeCatalogSearchText(candidate.name || candidate.proper_name || "") === itemName
      ) || item;
    };

    const renderDiscoverySearchResults = () => {
      const input = $("discovery-search-input");
      const results = $("discovery-search-results");
      const summary = $("discovery-search-summary");
      if (!input || !results) return;
      const query = normalizeCatalogSearchText(input.value);
      results.replaceChildren();
      const matches = discoverySearchCatalog.filter(item =>
        matchesDiscoverySearchFilter(item)
        && (!query || normalizeCatalogSearchText(item.discoveryLabel).includes(query))
      );
      const limit = 24;
      const filterLabels = { all: t("ui.namedObjects"), comet: t("ui.comets"), planet: t("ui.planets"), galaxy: t("ui.galaxies"), cluster: t("ui.clusters") };
      if (summary) {
        if (!query) {
          const limitText = matches.length > limit ? ` · ${limit} ${t("ui.firstDisplayed")}` : "";
          const suffix = discoverySearchFilter === "all" ? `. ${t("ui.typeLettersOrChoose")}` : ` ${t("ui.inCatalogue")}`;
          summary.textContent = `${matches.length} ${filterLabels[discoverySearchFilter] || t("ui.namedObjects")}${limitText}${suffix}`;
        } else if (matches.length) {
          const res = matches.length > 1 ? t("ui.results") : t("ui.result");
          const limitText = matches.length > limit ? ` · ${limit} ${t("ui.firstDisplayed")}` : "";
          summary.textContent = `${matches.length} ${res}${limitText}.`;
        } else {
          summary.textContent = t("ui.noObjectMatchesSearch");
        }
      }
      if (!matches.length) {
        const empty = document.createElement("p");
        empty.className = "discovery-search-empty";
        empty.textContent = t("ui.tryAnotherName");
        results.append(empty);
        return;
      }
      // Les altitudes sont relues à chaque rendu de la liste : l’état de visibilité
      // doit correspondre au lieu et à l’heure courants, pas à l’ouverture initiale.
      const currentCatalog = typeof getCatalogObjects === "function" ? getCatalogObjects() : discoverySearchCatalog;
      for (const item of matches.slice(0, limit)) {
        const row = document.createElement("article");
        row.className = "discovery-search-result";
        const name = document.createElement("strong");
        name.className = "discovery-search-result-name";
        name.textContent = item.discoveryLabel;
        const currentObject = findCurrentDiscoverySearchObject(item, currentCatalog);
        const rawAltitude = currentObject?.alt;
        const altitude = rawAltitude == null || rawAltitude === "" ? NaN : Number(rawAltitude);
        if (!Number.isFinite(altitude) || altitude <= 0) {
          const status = document.createElement("span");
          status.className = `discovery-search-status${Number.isFinite(altitude) ? " is-below-horizon" : " is-unknown"}`;
          status.textContent = Number.isFinite(altitude)
            ? t("ui.belowHorizonForNow")
            : t("ui.positionUnavailableForNow");
          status.setAttribute("aria-label", `${item.discoveryLabel} : ${status.textContent.toLowerCase()}`);
          row.append(name, status);
          results.append(row);
          continue;
        }

        const show = document.createElement("button");
        show.type = "button";
        show.className = "action-button discovery-search-show";
        show.textContent = t("ui.show");
        show.setAttribute("aria-label", `${t("ui.show")} ${item.discoveryLabel} ${t("ui.onMap")}`);
        show.addEventListener("click", () => {
          // Recalculer une fois la liste du ciel pour que le pointage et les repères
          // proches utilisent les positions les plus récentes.
          const latestCatalog = typeof getCatalogObjects === "function" ? getCatalogObjects() : discoverySearchCatalog;
          const freshObject = findCurrentDiscoverySearchObject(item, latestCatalog);
          const target = { ...freshObject, discoveryLabel: item.discoveryLabel };
          const rawLatestAltitude = target.alt;
          const latestAltitude = rawLatestAltitude == null || rawLatestAltitude === "" ? NaN : Number(rawLatestAltitude);
          // Une cible qui vient de passer sous l’horizon ne doit pas être pointée.
          if (!Number.isFinite(latestAltitude) || latestAltitude <= 0) {
            renderDiscoverySearchResults();
            return;
          }
          $("discovery-search-input")?.blur();
          if (Number.isFinite(Number(target.az))) {
            state.heading = norm360(Number(target.az));
            // Garder l’horizon et le paysage visibles, comme dans « Visible maintenant ».
            state.pitch = Math.max(-5, Math.min(22, latestAltitude));
          }
          state.selected = target;
          // Conserver la flèche jaune et le nom après fermeture du panneau de recherche,
          // comme lorsque « Montrer » est utilisé depuis « Explorez le ciel ».
          document.getElementById("app")?.classList.add("discovery-search-target-active");
          const aboveHorizon = latestCatalog.filter(candidate => Number(candidate.alt) > 0);
          state.discoveryStartReferences = findDiscoveryNearbyReferences(target, aboveHorizon).map(entry => entry.object);
          state.discoveryWalkOverlay = null;
          const objectCard = $("object-card");
          if (objectCard) objectCard.hidden = true;
          const searchPanel = $("discovery-search-panel");
          if (searchPanel) searchPanel.hidden = true;
          discoveryPanel?.classList.remove("is-search-active");
          const searchButton = document.querySelector('[data-discovery-action="search"]');
          searchButton?.classList.add("is-active");
          searchButton?.setAttribute("aria-expanded", "false");
          document.querySelector('[data-discovery-action="start"]')?.classList.remove("is-active");
          // Comme pour le guidage, réduire le menu sur mobile afin de dégager la carte.
          // Le helper ne replie rien sur ordinateur.
          collapseDiscoveryPanelAfterGuideStart();
          if (typeof drawSky === "function") drawSky();
        });
        row.append(name, show);
        results.append(row);
      }
    };

    document.querySelectorAll("[data-search-filter]").forEach(button => {
      button.addEventListener("click", () => {
        discoverySearchFilter = button.dataset.searchFilter || "all";
        document.querySelectorAll("[data-search-filter]").forEach(option => {
          const active = option === button;
          option.classList.toggle("is-active", active);
          option.setAttribute("aria-pressed", String(active));
        });
        renderDiscoverySearchResults();
      });
    });
    on("discovery-search-input", "input", renderDiscoverySearchResults);
    on("discovery-search-close", "click", () => {
      const panel = $("discovery-search-panel");
      if (panel) panel.hidden = true;
      $("discovery-search-input")?.blur();
      discoveryPanel?.classList.remove("is-search-active");
      const searchButton = document.querySelector('[data-discovery-action="search"]');
      searchButton?.classList.remove("is-active");
      searchButton?.setAttribute("aria-expanded", "false");
      state.discoveryStartReferences = [];
      document.getElementById("app")?.classList.remove("discovery-search-target-active");
      if (typeof drawSky === "function") drawSky();
    });

    const renderDiscoveryStartTonight = () => {
      const list = $("discovery-start-list");
      const summary = $("discovery-start-summary");
      if (!list) return;
      list.replaceChildren();
      const date = state.observationDate || new Date();
      const candidates = buildTonightSelection(
        typeof getVisibleNowObjects === "function" ? getVisibleNowObjects() : [],
        { instrument: "eye", limit: 5 }
      ).filter(object => Number.isFinite(Number(object.alt)) && Number(object.alt) > 0);
      const ciblePlural = candidates.length === 1 ? t("ui.target") : t("ui.targets");
if (summary) summary.textContent = `${t("ui.forThe")} ${date.toLocaleString(getLocale(), { dateStyle: "short", timeStyle: "short" })} · ${candidates.length} ${ciblePlural} ${t("ui.toTryNakedEye")}.`;
      if (!candidates.length) {
        const empty = document.createElement("p");
        empty.className = "discovery-start-empty";
        empty.textContent = t("ui.noEasyTarget");
        list.append(empty);
        return;
      }
      const typeLabels = { moon: t("ui.moon"), planet: t("ui.planet"), star: t("ui.star"), cluster: t("ui.clusterTypeLabel") };
      const allVisible = typeof getCatalogObjects === "function" ? getCatalogObjects().filter(candidate => Number(candidate.alt) > 0) : [...(Array.isArray(state.visibleObjects) ? state.visibleObjects : []), ...(typeof getVisibleNowObjects === "function" ? getVisibleNowObjects() : [])];
      for (const [index, object] of candidates.entries()) {
        const card = document.createElement("article");
        card.className = "discovery-start-card";
        const copy = document.createElement("div");
        copy.className = "discovery-start-copy";
        const title = document.createElement("h4");
        title.textContent = localizedObjectName(object);
        const meta = document.createElement("p");
        const altitude = Number(object.alt);
        const type = typeLabels[String(object.type || (object.catalogue === "Hipparcos" ? "star" : "")).toLowerCase()] || t("ui.celestialObject");
        meta.textContent = `${type} · ${altitude.toFixed(0)}° ${t("ui.aboveHorizon")}${Number.isFinite(Number(object.mag)) ? ` · mag. ${Number(object.mag).toFixed(1)}` : ""}`;
        // Même sélection de repères nommés que la recherche Découverte : étoiles/planètes
        // brillantes, au-dessus de l’horizon, entre 2° et 30° de la cible.
        const references = findDiscoveryNearbyReferences(object, allVisible);
        const referenceLine = document.createElement("p");
        referenceLine.className = "discovery-start-references";
        referenceLine.textContent = references.length
          ? `${t("ui.nearbyLandmarks")}: ${references.map(item => item.object.discoveryLabel || localizedObjectName(item.object) || t("ui.anchorStar")).join(" · ")}`
          : t("ui.noNearbyBrightStar");
        const advice = document.createElement("p");
        advice.className = "discovery-start-advice";
        advice.textContent = altitude < 15
          ? t("ui.lowTargetAtmosphere")
          : object.type === "moon"
            ? t("ui.moonNakedEyeCraters")
            : object.type === "planet"
              ? t("ui.planetNakedEyePoint")
              : object.type === "cluster"
                ? t("ui.clusterSmallPatch")
                : t("ui.brightStarNakedEye");
        copy.append(title, meta, referenceLine, advice);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "action-button discovery-start-show";
        button.textContent = t("ui.show");
        button.setAttribute("aria-label", `${t("ui.show")} ${title.textContent} ${t("ui.onMap")}`);
        button.addEventListener("click", () => {
          if (Number.isFinite(Number(object.az)) && Number.isFinite(Number(object.alt))) {
            state.heading = norm360(Number(object.az));
            // En mode Découverte, éviter de pointer trop haut : l'objet reste
            // dans le champ et l'horizon demeure plus souvent visible pour
            // aider à comprendre sa hauteur réelle dans le ciel.
            state.pitch = Math.max(-5, Math.min(22, Number(object.alt)));
          }
          state.selected = { ...object };
          state.discoveryStartReferences = references.map(item => ({ ...item.object }));
          // Le choix d’une cible guide la carte sans ouvrir automatiquement
          // sa fiche descriptive : celle-ci reste accessible par sélection
          // explicite de l’objet.
          const objectCard = $("object-card");
          if (objectCard) objectCard.hidden = true;
          document.querySelector('[data-discovery-action="start"]')?.classList.add("is-active");
          // Comme les autres actions de Découverte, replier le menu sur mobile
          // après le choix de « Montrer » afin de dégager la carte. Sur ordinateur,
          // le helper ne modifie pas le panneau.
          collapseDiscoveryPanelAfterGuideStart();
          if (typeof drawSky === "function") drawSky();
        });
        card.append(copy, button);
        list.append(card);
      }
    };
    refreshLocalePanels = () => {
      if (!$("discovery-search-panel")?.hidden) refreshDiscoverySearchCatalog();
      if (!$("discovery-start-tonight")?.hidden) renderDiscoveryStartTonight();
      if (!$("discovery-constellation-picker")?.hidden) populateDiscoveryConstellations($("discovery-constellation-select"));
      if (activeSkyWalk && !$("discovery-walk-detail")?.hidden) renderSkyWalk();
    };
    on("discovery-start-close", "click", () => {
      // La liste ne se ferme qu’en choisissant une autre rubrique Découverte.
      const panel = $("discovery-start-tonight");
      if (panel) panel.hidden = false;
    });
    $("discovery-search-input")?.addEventListener("input", () => dismissDiscoveryHint("search"));
    $("discovery-start-list")?.addEventListener("click", () => dismissDiscoveryHint("start"));
    $("discovery-walks-list")?.addEventListener("click", () => dismissDiscoveryHint("walks"));
    $("discovery-constellation-select")?.addEventListener("change", () => dismissDiscoveryHint("constellations"));
    $("locate-btn")?.addEventListener("click", () => dismissDiscoveryHint("orient"));
    const buildDiscoveryEveningRoute = () => {
      const panel = $("discovery-evening-route");
      const list = $("discovery-evening-route-list");
      if (!panel || !list) return;
      const catalog = typeof getCatalogObjects === "function" ? getCatalogObjects() || [] : [];
      const candidates = catalog.map(object => {
        // Le parcours Découverte n'affiche que des cibles ayant un vrai nom
        // commun, en réutilisant la même résolution que le reste de l'interface.
        const commonName = typeof getDiscoveryCommonName === "function" ? getDiscoveryCommonName(object) : "";
        return commonName ? { ...object, discoveryCommonName: commonName } : null;
      }).filter(object => {
        const alt = Number(object?.alt);
        return object && Number.isFinite(alt) && Number.isFinite(Number(object.az)) && alt >= 15 && object.type !== "sun" && object.type !== "comet";
      });
      const choose = (predicate, used) => candidates.filter(o => !used.has(String(o.id)) && predicate(o))
        .sort((a,b) => Number(a.mag ?? 99) - Number(b.mag ?? 99))[0];
      const used = new Set();
      const route = [
        { label: t("ui.suggestBrightLandmark"), predicate: o => ["planet","moon"].includes(String(o.type).toLowerCase()) || (String(o.type).toLowerCase()==="star" && Number(o.mag)<=2.5), advice: t("ui.suggestBrightLandmarkAdvice") },
        { label: t("ui.suggestRecognizeStar"), predicate: o => String(o.type).toLowerCase()==="star" && Number(o.mag)<=4.5, advice: t("ui.suggestUseStarAsLandmark") },
        { label: t("ui.suggestHarderTarget"), predicate: o => ["cluster","open-cluster","globular-cluster","star-cluster","galaxy","nebula","deep-sky"].includes(String(o.type).toLowerCase()) || /^(M|NGC|IC)\s?\d/i.test(String(o.id || "")) && !["star","planet","moon"].includes(String(o.type).toLowerCase()), advice: t("ui.suggestHarderTargetAdvice") }
      ];
      const selected = route.map(step => ({ ...step, object: choose(step.predicate, used) })).filter(step => {
        if (!step.object) return false;
        used.add(String(step.object.id));
        return true;
      });
      list.replaceChildren();
      if (!selected.length) {
        const empty = document.createElement("li");
        empty.textContent = t("ui.noFullRoute");
        list.append(empty);
      } else {
        selected.forEach((step, index) => {
          const item = document.createElement("li");
          const title = document.createElement("strong");
          title.textContent = `${step.label} : ${step.object.discoveryCommonName}`;
          const note = document.createElement("p");
          note.textContent = `${step.advice} ${t("ui.currentAltitude", { altitude: Number(step.object.alt).toFixed(0) })}°.`;
          const show = document.createElement("button");
          show.type = "button"; show.textContent = t("ui.showOnMap");
          show.addEventListener("click", () => {
            state.selected = { ...step.object };
            state.heading = norm360(Number(step.object.az));
            state.pitch = Math.max(-5, Math.min(22, Number(step.object.alt)));
            const card = $("object-card"); if (card) card.hidden = true;
            panel.hidden = true;
            if (typeof drawSky === "function") drawSky();
          });
          item.append(title, note, show); list.append(item);
        });
      }
      panel.hidden = false;
    };
    on("discovery-evening-route-close", "click", () => { const panel = $("discovery-evening-route"); if (panel) panel.hidden = true; });

    document.querySelectorAll("[data-discovery-action]").forEach(button => {
      button.addEventListener("click", () => {
        const actions = {
          orient: "locate-btn",
          tonight: "visible-now-open",
          moon: "moon-open",
          path: "star-hop-open"
        };
        const action = button.dataset.discoveryAction;
        if (action !== "free" && state.finderActive && state.skyGuideMode === "free" && typeof exitFinder === "function") {
          exitFinder();
        }
        dismissDiscoveryHint();
        showDiscoveryHint(action);
        if (action !== "search") document.getElementById("app")?.classList.remove("discovery-search-target-active");
        const startPanel = $("discovery-start-tonight");
        const searchPanel = $("discovery-search-panel");
        const eveningRoutePanel = $("discovery-evening-route");
        if (action !== "evening-route" && eveningRoutePanel) eveningRoutePanel.hidden = true;
        if (action !== "start" && startPanel) startPanel.hidden = true;
        if (action === "evening-route") {
          buildDiscoveryEveningRoute();
          document.querySelectorAll("[data-discovery-action]").forEach(item => item.classList.toggle("is-active", item === button));
          // « Ma soirée » se trouve plus bas que « Visible maintenant ».
          // Revenir en haut pour conserver visibles l'en-tête et la poignée.
          if (window.matchMedia("(max-width: 600px)").matches) {
            window.requestAnimationFrame(() => {
              discoveryPanel?.scrollTo({ top: 0, behavior: "auto" });
              eveningRoutePanel?.scrollTo({ top: 0, behavior: "auto" });
            });
          }
        }
        if (action !== "search" && searchPanel) searchPanel.hidden = true;
        if (action !== "search") {
          discoveryPanel?.classList.remove("is-search-active");
          $("discovery-search-input")?.blur();
          const searchButton = document.querySelector('[data-discovery-action="search"]');
          searchButton?.classList.remove("is-active");
          searchButton?.setAttribute("aria-expanded", "false");
        }
        // Chaque rubrique Découverte est exclusive : fermer les panneaux et
        // effacer les tracés spécifiques de la rubrique précédente.
        if (action !== "walks") {
          const walksPanel = $("discovery-walks");
          if (walksPanel) {
            walksPanel.hidden = true;
            walksPanel.classList.remove("is-map-shown");
          }
          activeSkyWalk = "";
          activeSkyWalkStep = 0;
          skyWalkMapShown = false;
          const walkList = $("discovery-walks-list");
          const walkDetail = $("discovery-walk-detail");
          if (walkList) walkList.hidden = false;
          if (walkDetail) walkDetail.hidden = true;
          document.querySelectorAll("[data-sky-walk]").forEach(item => item.classList.remove("is-active"));
          $("discovery-panel")?.classList.remove("has-walk-map");
          state.discoveryWalkOverlay = null;
        }
        if (action !== "constellations") {
          const picker = $("discovery-constellation-picker");
          if (picker) picker.hidden = true;
          state.discoveryConstellationId = "";
          state.discoveryConstellationStarIds = new Set();
          state.discoveryConstellationTargetStarId = "";
          state.discoveryConstellationSequence = [];
          state.discoveryConstellationStepIndex = 0;
          const select = $("discovery-constellation-select");
          if (select) select.value = "";
          const details = $("discovery-constellation-details");
          if (details) details.hidden = true;
          const constellationToggle = $("setting-constellations");
          if (constellationToggle?.checked) {
            constellationToggle.checked = false;
            constellationToggle.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
        if (action !== "start") {
          document.querySelector('[data-discovery-action="start"]')?.classList.remove("is-active");
          state.discoveryStartReferences = [];
        }
        if (action === "free") {
          // L’exploration libre démarre directement depuis le menu Découverte,
          // sans exiger de sélection préalable d’un objet.
          const app = $("app");
          if (!app?.classList.contains("discovery-mode")) return;
          if (typeof enterFinder === "function") enterFinder({ free: true });
          else showToast(t("ui.freeSkyUnavailable"));
          return;
        }
        if (action === "search") {
          const panel = $("discovery-search-panel");
          const opening = Boolean(panel?.hidden);
          if (panel) panel.hidden = !opening;
          const mobileSearch = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 600px)").matches;
          discoveryPanel?.classList.toggle("is-search-active", opening && mobileSearch);
          button.classList.toggle("is-active", opening);
          button.setAttribute("aria-expanded", String(opening));
          if (opening) {
            refreshDiscoverySearchCatalog();
            syncDiscoverySearchKeyboardInset();
            const input = $("discovery-search-input");
            input?.focus();
            if (mobileSearch) {
              // Le panneau est converti en vue de recherche avant l'ouverture du clavier :
              // champ et résultats restent dans la zone visible.
              window.requestAnimationFrame(() => {
                syncDiscoverySearchKeyboardInset();
                discoveryPanel?.scrollTo({ top: 0, behavior: "auto" });
              });
            }
          } else {
            $("discovery-search-input")?.blur();
            discoveryPanel?.classList.remove("is-search-active");
            state.discoveryStartReferences = [];
            document.getElementById("app")?.classList.remove("discovery-search-target-active");
          }
          if (typeof drawSky === "function") drawSky();
          return;
        }
        if (action === "start") {
          if (state.discoveryWalkOverlay) {
            state.discoveryWalkOverlay = null;
            if (typeof drawSky === "function") drawSky();
          }
          activeSkyWalk = "";
          activeSkyWalkStep = 0;
          skyWalkMapShown = false;
          const walksPanel = $("discovery-walks");
          if (walksPanel) {
            walksPanel.hidden = true;
            walksPanel.classList.remove("is-map-shown");
          }
          $("discovery-panel")?.classList.remove("has-walk-map");
          const walkList = $("discovery-walks-list");
          const walkDetail = $("discovery-walk-detail");
          if (walkList) walkList.hidden = false;
          if (walkDetail) walkDetail.hidden = true;
          document.querySelectorAll("[data-sky-walk]").forEach(item => item.classList.remove("is-active"));
          const picker = $("discovery-constellation-picker");
          if (picker) picker.hidden = true;
          const panel = $("discovery-start-tonight");
          const opening = Boolean(panel?.hidden);
          // Une fois ouverte, la liste reste présente : cliquer à nouveau sur
          // la même rubrique ne la masque pas pendant la navigation.
          if (panel) panel.hidden = false;
          if (opening) renderDiscoveryStartTonight();
          button.classList.add("is-active");
          document.querySelectorAll('[data-discovery-action="walks"], [data-discovery-action="constellations"]').forEach(item => item.classList.remove("is-active"));
          return;
        }
        document.querySelector('[data-discovery-action="start"]')?.classList.remove("is-active");
        if (state.discoveryWalkOverlay) {
          state.discoveryWalkOverlay = null;
          if (typeof drawSky === "function") drawSky();
        }
        skyWalkMapShown = false;
        $("discovery-walks")?.classList.remove("is-map-shown");
        $("discovery-panel")?.classList.remove("has-walk-map");
        if (action === "walks") {
          const panel = $("discovery-walks");
          const opening = Boolean(panel?.hidden);
          if (panel) panel.hidden = !opening;
          const picker = $("discovery-constellation-picker");
          if (opening && picker) picker.hidden = true;
          if (!opening) {
            // Fermer le catalogue efface aussi la balade en cours : aucune trace
            // ni étape ne doit réapparaître lors de la prochaine ouverture.
            activeSkyWalk = "";
            activeSkyWalkStep = 0;
            skyWalkMapShown = false;
            const list = $("discovery-walks-list");
            const detail = $("discovery-walk-detail");
            if (list) list.hidden = false;
            if (detail) detail.hidden = true;
            panel?.classList.remove("is-map-shown");
            $("discovery-panel")?.classList.remove("has-walk-map");
            document.querySelectorAll("[data-sky-walk]").forEach(item => item.classList.remove("is-active"));
            state.discoveryWalkOverlay = null;
            if (typeof drawSky === "function") drawSky();
          }
          button.classList.toggle("is-active", opening);
          return;
        }
        if (action === "constellations") {
          const input = $("setting-constellations");
          const picker = $("discovery-constellation-picker");
          const select = $("discovery-constellation-select");
          const opening = Boolean(picker?.hidden);
          if (picker) picker.hidden = !opening;
          if (input && !input.checked) { input.checked = true; input.dispatchEvent(new Event("change", { bubbles: true })); }
          button.classList.toggle("is-active", Boolean(input?.checked));
          if (opening && select) populateDiscoveryConstellations(select);
          return;
        }
        if (action === "solar-system") {
          openSolarSystemDialog();
          return;
        }
        if (action === "jupiter-moons") {
          openJupiterMoonsDialog();
          return;
        }
        if (action === "universe") {
          openUniverseJourneyDialog();
          return;
        }
        const target = $(actions[action]);
        if (target) target.click();
      });
    });

    on("discovery-constellation-select", "change", event => {
      const nextConstellationId = String(event.target?.value || "");
      if (nextConstellationId !== String(state.discoveryConstellationId || "")) state.discoveryConstellationStepIndex = 0;
      state.discoveryConstellationId = nextConstellationId;
      const hint = $("discovery-constellation-hint");
      const details = $("discovery-constellation-details");
      const starsText = $("discovery-constellation-stars");
      const howTo = $("discovery-constellation-howto");
      const selected = (state.constellations || []).find(item => String(item.id) === state.discoveryConstellationId);
      const diagram = $("discovery-constellation-diagram");
      const diagramLines = $("discovery-constellation-diagram-lines");
      const diagramStars = $("discovery-constellation-diagram-stars");
      const diagramLabels = $("discovery-constellation-diagram-labels");
      if (diagram) diagram.hidden = !selected;
      if (diagramLines) diagramLines.replaceChildren();
      if (diagramStars) diagramStars.replaceChildren();
      if (diagramLabels) diagramLabels.replaceChildren();
      if (selected) {
        const constellationToggle = $("setting-constellations");
        if (constellationToggle && (!constellationToggle.checked || !state.showConstellations)) {
          constellationToggle.checked = true;
          constellationToggle.dispatchEvent(new Event("change", { bubbles: true }));
        }
        setDiscoveryPanelCollapsed(true);
        const starsById = new Map((state.stars || []).map(star => [String(star.id), star]));
        const memberIds = [...new Set((selected.lines || []).flatMap(segment => Array.isArray(segment) ? segment.map(String) : []))];
        const members = memberIds.map(id => starsById.get(id)).filter(Boolean);
        state.discoveryConstellationStarIds = new Set(memberIds);
        const positions = members.map(star => ({ star, horizontal: typeof getStarPosition === "function" ? getStarPosition(star) : null }))
          .filter(entry => Number.isFinite(entry.horizontal?.az) && Number.isFinite(entry.horizontal?.alt) && entry.horizontal.alt > 0);
        // Parcours pédagogique : étoiles visibles triées de la plus brillante à la moins brillante.
        const learningSequence = [...positions]
          .sort((a, b) => Number(a.star.mag ?? 99) - Number(b.star.mag ?? 99))
          .map(entry => String(entry.star.id));
        state.discoveryConstellationSequence = learningSequence;
        if (!Number.isInteger(state.discoveryConstellationStepIndex) || state.discoveryConstellationStepIndex < 0) state.discoveryConstellationStepIndex = 0;
        if (learningSequence.length) state.discoveryConstellationStepIndex %= learningSequence.length;
        const targetId = learningSequence[state.discoveryConstellationStepIndex] || "";
        const targetStar = positions.find(entry => String(entry.star.id) === targetId)?.star;
        state.discoveryConstellationTargetStarId = targetStar ? String(targetStar.id) : "";
        if (positions.length) {
          const sx = positions.reduce((sum, entry) => sum + Math.sin(entry.horizontal.az * Math.PI / 180), 0);
          const cx = positions.reduce((sum, entry) => sum + Math.cos(entry.horizontal.az * Math.PI / 180), 0);
          state.heading = norm360(Math.atan2(sx, cx) * 180 / Math.PI);
          // Centrer horizontalement sur la constellation tout en gardant l’horizon
          // dans le champ dès que possible. Au-delà d’environ 12° d’inclinaison,
          // l’horizon descend souvent sous le bord inférieur de la carte.
          // Pour les constellations hautes, on privilégie donc l’horizon visible
          // plutôt qu’un centrage vertical parfait.
          const averageAltitude = positions.reduce((sum, entry) => sum + entry.horizontal.alt, 0) / positions.length;
          const horizonFriendlyPitch = 12;
          state.pitch = clamp(averageAltitude, 0, horizonFriendlyPitch);

          // Ajuster automatiquement le champ de vision pour éviter de couper
          // les extrémités des constellations. Le calcul tient compte de leur
          // largeur en azimut et de la hauteur de leurs étoiles au-dessus de
          // l’horizon, tout en gardant une marge autour de la figure.
          const azimuthOffsets = positions.map(entry => {
            let delta = entry.horizontal.az - state.heading;
            while (delta > 180) delta -= 360;
            while (delta < -180) delta += 360;
            return Math.abs(delta);
          });
          const maxAzimuthOffset = Math.max(0, ...azimuthOffsets);
          const maxAltitude = Math.max(...positions.map(entry => entry.horizontal.alt));
          const requiredHorizontalFov = maxAzimuthOffset * 2 * 1.28;
          const requiredVerticalFov = Math.max(15, 2 * (maxAltitude - state.pitch + 9));
          const requiredFov = clamp(Math.max(25, requiredHorizontalFov, requiredVerticalFov / (83.3333333333 / 75)), 15, 120);
          state.fov = requiredFov;
          state.verticalFov = clamp(requiredFov * (83.3333333333 / 75), 15, 110);
          const zoomIndicator = $("zoom-level");
          if (zoomIndicator) zoomIndicator.textContent = `${(45 / state.fov).toLocaleString(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}×`;
          if (state.sensorActive && typeof sensors?.stopListening === "function") {
            sensors.stopListening();
            showToast(t("ui.mapCenteredOnConstellation"));
          }
        }
        // Schéma didactique local : coordonnées équatoriales simplifiées, sans prétendre être une projection de la voûte céleste.
        const raValues = members.map(star => Number(star.ra)).filter(Number.isFinite);
        const decValues = members.map(star => Number(star.dec)).filter(Number.isFinite);
        if (members.length && diagramLines && diagramStars) {
          const raCenter = raValues.length ? raValues.reduce((a,b)=>a+b,0)/raValues.length : 0;
          const decCenter = decValues.length ? decValues.reduce((a,b)=>a+b,0)/decValues.length : 0;
          const coords = new Map();
          for (const star of members) {
            let dra = Number(star.ra) - raCenter;
            while (dra > 12) dra -= 24; while (dra < -12) dra += 24;
            coords.set(String(star.id), { x: 160 + dra * 13 * Math.cos(decCenter * Math.PI / 180), y: 75 - (Number(star.dec) - decCenter) * 2.5 });
          }
          const points = [...coords.values()];
          const minX = Math.min(...points.map(p=>p.x)), maxX = Math.max(...points.map(p=>p.x));
          const minY = Math.min(...points.map(p=>p.y)), maxY = Math.max(...points.map(p=>p.y));
          const scale = Math.min(270 / Math.max(1,maxX-minX), 112 / Math.max(1,maxY-minY), 1.8);
          const centerX=(minX+maxX)/2, centerY=(minY+maxY)/2;
          for (const [id, point] of coords) coords.set(id, { x:160+(point.x-centerX)*scale, y:75+(point.y-centerY)*scale });
          for (const segment of selected.lines || []) {
            if (!Array.isArray(segment) || segment.length < 2) continue;
            const a=coords.get(String(segment[0])), b=coords.get(String(segment[1])); if (!a||!b) continue;
            const line=document.createElementNS("http://www.w3.org/2000/svg","line");
            line.setAttribute("x1",a.x); line.setAttribute("y1",a.y); line.setAttribute("x2",b.x); line.setAttribute("y2",b.y);
            line.setAttribute("stroke-dasharray", "3 4"); line.setAttribute("opacity", ".72");
            diagramLines.appendChild(line);
          }
          const nameByHip = {677:t("names.star.alpheratz"),746:t("names.star.caph"),3179:t("names.star.schedar"),4427:t("names.star.navi"),5447:t("names.star.mirach"),21421:t("names.star.aldebaran"),24436:t("names.star.rigel"),24608:t("names.star.capella"),25336:t("names.star.bellatrix"),25930:t("names.star.mintaka"),26311:t("names.star.alnilam"),26727:t("names.star.alnitak"),27989:t("names.star.betelgeuse"),32349:t("names.star.sirius"),36850:t("names.star.castor"),37279:t("names.star.procyon"),37826:t("names.star.pollux"),49669:t("names.star.regulus"),53910:t("names.star.merak"),54061:t("names.star.dubhe"),65378:t("names.star.mizar"),65474:t("names.star.spica"),67301:t("names.star.alkaid"),69673:t("names.star.arcturus"),80763:t("names.star.antares"),91262:t("names.star.vega"),97649:t("names.star.altair"),102098:t("names.star.deneb"),113368:t("names.star.fomalhaut"),11767:t("names.star.polaris")};
          for (const star of members) {
            const point=coords.get(String(star.id)); if(!point) continue;
            const isCurrentTarget = String(star.id) === String(state.discoveryConstellationTargetStarId);
            if (isCurrentTarget) {
              const halo=document.createElementNS("http://www.w3.org/2000/svg","circle");
              halo.setAttribute("cx",point.x); halo.setAttribute("cy",point.y); halo.setAttribute("r","10");
              halo.setAttribute("fill","rgba(255,220,140,.12)"); halo.setAttribute("stroke","#ffe1a0"); halo.setAttribute("stroke-width","1.5");
              diagramStars.appendChild(halo);
            }
            const circle=document.createElementNS("http://www.w3.org/2000/svg","circle");
            circle.setAttribute("cx",point.x); circle.setAttribute("cy",point.y); circle.setAttribute("r",String(Math.max(2.2,Math.min(5,5-Number(star.mag||3)*.65)) + (isCurrentTarget ? 1.5 : 0))); circle.setAttribute("fill",isCurrentTarget?"#ffe1a0":(Number(star.mag)<=2.5?"#fff0bb":"#9fcaff")); diagramStars.appendChild(circle);
            const hip=Number(star.hip ?? String(star.id).match(/(\d+)/)?.[1]); const starName=nameByHip[hip] || star.proper_name || star.properName;
            if(starName && Number(star.mag)<=3.5) { const label=document.createElementNS("http://www.w3.org/2000/svg","text"); label.setAttribute("x",point.x+5); label.setAttribute("y",point.y-5); label.textContent=starName; diagramLabels?.appendChild(label); }
          }
          const diagramTarget = members.find(star => String(star.id) === String(state.discoveryConstellationTargetStarId)) ||
            [...members].filter(star => Number.isFinite(Number(star.mag)))
              .sort((a, b) => Number(a.mag) - Number(b.mag))[0];
          const targetPoint = diagramTarget ? coords.get(String(diagramTarget.id)) : null;
          if (targetPoint && diagramLabels) {
            const ns = "http://www.w3.org/2000/svg";
            const arrow = document.createElementNS(ns, "path");
            const x1 = Math.max(14, targetPoint.x - 36), y1 = Math.max(16, targetPoint.y - 30);
            const x2 = targetPoint.x - 5, y2 = targetPoint.y - 6;
            const angle = Math.atan2(y2-y1, x2-x1), head = 6;
            const hx1 = x2 - head*Math.cos(angle-Math.PI/6), hy1 = y2 - head*Math.sin(angle-Math.PI/6);
            const hx2 = x2 - head*Math.cos(angle+Math.PI/6), hy2 = y2 - head*Math.sin(angle+Math.PI/6);
            arrow.setAttribute("d", `M ${x1} ${y1} L ${x2} ${y2} M ${hx1} ${hy1} L ${x2} ${y2} L ${hx2} ${hy2}`);
            arrow.setAttribute("fill", "none"); arrow.setAttribute("stroke", "#ffe1a0"); arrow.setAttribute("stroke-width", "1.5"); arrow.setAttribute("stroke-linecap", "round");
            diagramLabels.appendChild(arrow);
            const targetLabel = document.createElementNS(ns, "text");
            targetLabel.setAttribute("x", x1 + 2); targetLabel.setAttribute("y", y1 - 3); targetLabel.setAttribute("text-anchor", "start");
            targetLabel.setAttribute("fill", "#ffe1a0"); targetLabel.textContent = t("ui.toSpot"); diagramLabels.appendChild(targetLabel);
          }
        }
      } else {
        state.discoveryConstellationStarIds = new Set();
        state.discoveryConstellationTargetStarId = "";
      }
      if (hint) hint.textContent = selected
        ? `${localizedConstellationName(selected)} : ${t("ui.constellationWalkIntro")}`
        : t("ui.constellationPickerHint");

      if (details) details.hidden = !selected;
      if (selected) {
        const commonNames = {
          677: t("names.star.alpheratz"), 746: t("names.star.caph"), 3179: t("names.star.schedar"), 4427: t("names.star.navi"), 5447: t("names.star.mirach"),
          9884: t("names.star.hamal"), 14576: t("names.star.algol"), 15863: t("names.star.mirfak"), 21421: t("names.star.aldebaran"), 24436: t("names.star.rigel"),
          24608: t("names.star.capella"), 25336: t("names.star.bellatrix"), 25930: t("names.star.mintaka"), 26311: t("names.star.alnilam"), 26727: t("names.star.alnitak"),
          27989: t("names.star.betelgeuse"), 32349: t("names.star.sirius"), 36850: t("names.star.castor"), 37279: t("names.star.procyon"), 37826: t("names.star.pollux"),
          49669: t("names.star.regulus"), 53910: t("names.star.merak"), 54061: t("names.star.dubhe"), 65378: t("names.star.mizar"), 65474: t("names.star.spica"),
          67301: t("names.star.alkaid"), 69673: t("names.star.arcturus"), 80763: t("names.star.antares"), 91262: t("names.star.vega"), 97649: t("names.star.altair"),
          102098: t("names.star.deneb"), 113368: t("names.star.fomalhaut"), 11767: t("names.star.polaris")
        };
        const starById = new Map((state.stars || []).map(star => [String(star.id), star]));
        const members = new Map();
        for (const segment of (selected.lines || [])) {
          for (const id of (Array.isArray(segment) ? segment : [])) {
            const star = starById.get(String(id));
            if (star) members.set(String(star.id), star);
          }
        }
        const namedStars = [...members.values()]
          .filter(star => Number.isFinite(Number(star.mag)))
          .sort((a, b) => Number(a.mag) - Number(b.mag))
          .map(star => {
            const match = String(star.id || star.name || "").match(/^HIP[_\s-]*(\d+)$/i);
            const hip = Number(star.hip ?? (match ? match[1] : NaN));
            const name = commonNames[hip] || star.proper_name || star.properName ||
              (star.name && !/^HIP[_\s-]*\d+$/i.test(String(star.name)) ? star.name : "");
            return name ? { name: String(name), mag: Number(star.mag) } : null;
          })
          .filter(Boolean)
          .filter((star, index, all) => all.findIndex(item => item.name === star.name) === index)
          .slice(0, 4);
        if (starsText) starsText.textContent = namedStars.length
          ? `${t("ui.starsToSpot")} ${namedStars.map(star => star.name).join(" · ")}.`
          : t("constellation.tip");

        const shapeTips = {
          Cas: t("constellation.Cas"),
          UMa: t("constellation.UMa"),
          UMi: t("constellation.UMi"),
          Ori: t("constellation.Ori"),
          Lyr: t("constellation.Lyr"),
          Cyg: t("constellation.Cyg"),
          Sco: t("constellation.Sco")
        };
        const genericTip = t("constellation.walkTip");
        if (howTo) howTo.textContent = shapeTips[selected.id] || genericTip;
        const stepControls = $("discovery-constellation-step-controls");
        const stepLabel = $("discovery-constellation-step");
        const prevButton = $("discovery-constellation-prev");
        const nextButton = $("discovery-constellation-next");
        const sequence = Array.isArray(state.discoveryConstellationSequence) ? state.discoveryConstellationSequence : [];
        const currentIndex = Math.max(0, Math.min(sequence.length - 1, Number(state.discoveryConstellationStepIndex) || 0));
        const currentStar = starById.get(String(sequence[currentIndex] || ""));
        const currentHip = Number(currentStar?.hip ?? String(currentStar?.id || "").match(/^(?:HIP[_\s-]*)?(\d+)$/i)?.[1]);
        const currentName = commonNames[currentHip] || currentStar?.proper_name || currentStar?.properName ||
          (currentStar?.name && !/^HIP[_\s-]*\d+$/i.test(String(currentStar.name)) ? currentStar.name : "");
        if (stepControls) stepControls.hidden = sequence.length === 0;
        if (stepLabel) stepLabel.textContent = sequence.length
          ? `${t("ui.landmark")} ${currentIndex + 1} ${t("ui.of")} ${sequence.length}${currentName ? ` · ${currentName}` : t("constellation.followArrow")}`
          : t("constellation.noStarToGuide");
        if (prevButton) prevButton.disabled = sequence.length < 2 || currentIndex <= 0;
        if (nextButton) nextButton.disabled = sequence.length < 2 || currentIndex >= sequence.length - 1;
      } else {
        if (starsText) starsText.textContent = "";
        if (howTo) howTo.textContent = "";
        const stepControls = $("discovery-constellation-step-controls");
        if (stepControls) stepControls.hidden = true;
        state.discoveryConstellationSequence = [];
        state.discoveryConstellationStepIndex = 0;
      }
      if (typeof drawSky === "function") drawSky();
    });

    // Les textes pédagogiques de la constellation sélectionnée sont construits
    // dynamiquement : les reconstruire après chaque changement de langue.
    document.addEventListener("localechange", () => {
      const select = $("discovery-constellation-select");
      if (select?.value) {
        select.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        const hint = $("discovery-constellation-hint");
        if (hint) hint.textContent = t("ui.constellationPickerHint");
      }
    });

    const moveConstellationStep = direction => {
      const sequence = Array.isArray(state.discoveryConstellationSequence) ? state.discoveryConstellationSequence : [];
      if (sequence.length < 2) return;
      const nextIndex = Math.max(0, Math.min(sequence.length - 1, (Number(state.discoveryConstellationStepIndex) || 0) + direction));
      if (nextIndex === state.discoveryConstellationStepIndex) return;
      state.discoveryConstellationStepIndex = nextIndex;
      const select = $("discovery-constellation-select");
      if (select) select.dispatchEvent(new Event("change", { bubbles: true }));
    };
    on("discovery-constellation-prev", "click", () => moveConstellationStep(-1));
    on("discovery-constellation-next", "click", () => moveConstellationStep(1));

    // Localisation : identifiant correspondant au HTML fourni.
    const locationDialog = $("location-dialog");
    const closeLocationDialog = () => { if (locationDialog) locationDialog.hidden = true; };
    on("locate-btn", "click", () => {
      const select = $("preset-location-select");
      if (select) select.value = "";
      if (locationDialog) locationDialog.hidden = false;
    });
    on(["locate", "locate-button", "location-gps-btn"], "click", () => {
      closeLocationDialog();
      locate();
    });
    on("location-close", "click", closeLocationDialog);
    on("location-dialog", "click", event => { if (event.target?.matches?.("[data-close-location]")) closeLocationDialog(); });
    on("location-apply", "click", () => {
      const select = $("preset-location-select");
      const places = {
        "banyuls-sur-mer": { name: "Banyuls-sur-Mer", latitude: 42.4828, longitude: 3.1283 },
        "chalon-sur-saone": { name: "Chalon-sur-Saône", latitude: 46.7806, longitude: 4.8538 },
        "villers-sur-mer": { name: "Villers-sur-Mer", latitude: 49.320556, longitude: -0.006389 },
        "eperviere": { name: "L’Épervière · Gigny-sur-Saône", latitude: 46.65299, longitude: 4.94363 },
        "villarivon": { name: "Villarivon · Les Chapelles", latitude: 45.58053, longitude: 6.72339 },
        "macon": { name: "Mâcon", latitude: 46.3067, longitude: 4.8283 },
        "paris": { name: "Paris", latitude: 48.8566, longitude: 2.3522 },
        "la-hacquiniere": { name: "La Hacquinière · Bures-sur-Yvette", latitude: 48.694712, longitude: 2.153166 }
      };
      const place = places[select?.value];
      if (!place) { showToast(t("ui.choosePlaceFromList")); return; }
      state.latitude = place.latitude;
      state.longitude = place.longitude;
      state.locationName = place.name;
      state.locationReady = true;
      try {
        localStorage.setItem("atlas-celeste-last-observation-location", JSON.stringify({
          latitude: state.latitude,
          longitude: state.longitude,
          locationName: state.locationName
        }));
      } catch { /* Le lieu choisi reste utilisable sans stockage local. */ }
      closeLocationDialog();
      refreshLocationLabel();
      drawSky();
      showToast(`${t("ui.locationSelected")}: ${place.name}`);
    });

    // Boussole : activation des capteurs.
    on(
      ["orientation-btn", "discovery-compass-toggle", "enable-sensors", "sensor-button"],
      "click",
      enableSensors
    );

    // Recentrage.
    on(
      ["center-btn", "recenter", "recenter-button", "finder-recenter"],
      "click",
      recenter
    );

    // Arrêt éventuel des capteurs.
    on("stop-sensors", "click", stopSensors);

    // Mode chercheur.
    on(
      ["finder-btn", "finder-button"],
      "click",
      openFinder
    );

    on(
      ["finder-exit", "finder-close", "exit-finder"],
      "click",
      closeFinder
    );

    const starHopDialog = $("star-hop-dialog");
    const starHopAnchor = $("star-hop-anchor");
    const starHopTarget = $("star-hop-target");
    const starHopResult = $("star-hop-result");
    const starHopGuide = $("star-hop-guide");
    const starHopDiagramAnchor = $("star-hop-diagram-anchor");
    const starHopFieldStars = $("star-hop-field-stars");
    const starHopRouteLines = $("star-hop-route-lines");
    const starHopRouteList = $("star-hop-route-list");
    const starHopFieldLabels = $("star-hop-field-labels");
    const starHopConstellationLines = $("star-hop-constellation-lines");
    const starHopConstellationLabels = $("star-hop-constellation-labels");
    const starHopAnchorHalo = $("star-hop-anchor-halo");
    const starHopAnchorDot = $("star-hop-anchor-dot");
    const starHopAnchorCore = $("star-hop-anchor-core");
    const starHopDiagramTarget = $("star-hop-diagram-target");
    const starHopDiagramDirection = $("star-hop-diagram-direction");
    const starHopTargetHalo = $("star-hop-target-halo");
    const starHopTargetDot = $("star-hop-target-dot");
    const starHopTargetCore = $("star-hop-target-core");
    const starHopSeparation = $("star-hop-separation");
    const starHopCompass = $("star-hop-compass");
    const starHopSphereReset = $("star-hop-sphere-reset");
    const starHopZoomIn = $("star-hop-zoom-in");
    const starHopZoomOut = $("star-hop-zoom-out");
    const starHopSphereSvg = $("star-hop-diagram");
    let starHopSphereYaw = 0;
    let starHopSpherePitch = 0;
    let starHopSphereZoom = 1;
    let starHopSphereZoomTouched = false;
    let starHopSphereCurrentScale = 1;
    let starHopSphereDrag = null;
    // Noms communs des étoiles repères (identifiées par leur numéro HIP).
    // Le catalogue de base contient surtout des identifiants HIP : cette table
    // permet de proposer des repères immédiatement reconnaissables à l’œil nu.
    const starHopCommonNames = new Map(Object.entries({
      677: "Alpheratz", 746: t("names.star.caph"), 1067: t("names.star.algenib"), 3179: t("names.star.schedar"),
      4427: t("names.star.navi"), 5447: t("names.star.mirach"), 6686: t("names.star.ruchbah"), 7588: t("names.star.achernar"),
      8886: t("names.star.segin"), 9884: t("names.star.hamal"), 14135: t("names.star.menkar"), 14576: t("names.star.algol"),
      15863: t("names.star.mirfak"), 21421: t("names.star.aldebaran"), 24436: t("names.star.rigel"), 24608: t("names.star.capella"),
      25336: t("names.star.bellatrix"), 25428: t("names.star.elnath"), 25930: t("names.star.mintaka"), 26311: t("names.star.alnilam"),
      26727: t("names.star.alnitak"), 27989: t("names.star.betelgeuse"), 30438: t("names.star.canopus"), 32349: t("names.star.sirius"),
      36850: t("names.star.castor"), 37279: t("names.star.procyon"), 37826: t("names.star.pollux"), 49669: t("names.star.regulus"),
      53910: t("names.star.merak"), 54061: t("names.star.dubhe"), 60718: t("names.star.acrux"), 63090: t("names.star.zosma"),
      65474: t("names.star.spica"), 68702: t("names.star.hadar"), 69673: t("names.star.arcturus"), 80763: t("names.star.antares"),
      91262: t("names.star.vega"), 97649: t("names.star.altair"), 102098: t("names.star.deneb"), 113368: t("names.star.fomalhaut"),
      11767: t("names.star.polaris-full"), 57632: "Denebola", 67301: "Alkaid",
      65378: t("names.star.mizar"), 102488: t("names.star.gienah"),
      // Autres étoiles brillantes dont les noms sont utiles pour apprendre le ciel.
      8903: t("names.star.sheratan"), 9640: t("names.star.almach"), 11767: t("names.star.polaris-full"),
      17702: t("names.star.alcyone"), 17531: "Taygeta", 17573: "Maia", 17847: "Atlas",
      17851: t("names.star.pleione"), 27366: t("names.star.saiph"), 26207: t("names.star.meissa"), 28380: t("names.star.menkalinan"),
      30324: "Mirzam", 31681: t("names.star.alhena"), 33579: t("names.star.adhara"), 34444: t("names.star.wezen"),
      35904: "Aludra", 50583: "Algieba", 61941: "Porrima", 63608: "Vindemiatrix",
      67927: "Muphrid", 72105: "Izar", 76267: "Alphecca", 77070: "Unukalhai",
      84012: "Sabik", 85927: t("names.star.shaula"), 86032: t("names.star.rasalhague"), 90185: t("names.star.kaus-australis"),
      92855: t("names.star.nunki"), 95947: t("names.star.albireo"), 97278: "Tarazed", 98036: "Alshain",
      106278: t("names.star.sadalsuud"), 107315: t("names.star.enif"), 113881: t("names.star.scheat"), 113963: t("names.star.markab")
    }).map(([hip, name]) => [Number(hip), name]));
    const starHopHip = star => {
      const direct = Number(star?.hip);
      if (Number.isFinite(direct) && direct > 0) return direct;
      const match = String(star?.id ?? star?.name ?? "").match(/^HIP[_\s-]*(\d+)$/i);
      return match ? Number(match[1]) : NaN;
    };
    const starHopName = star => starHopCommonNames.get(starHopHip(star)) || star?.proper_name || star?.properName || (star?.name && !/^HIP\s*\d+$/i.test(star.name) ? star.name : (star?.hip ? `${t("ui.unnamedStar")} (HIP ${star.hip})` : t("starHop.anchorStar")));
    const starHopHasCommonName = star => Boolean(starHopCommonNames.has(starHopHip(star)) || star?.proper_name || star?.properName || (star?.name && !/^HIP\s*\d+$/i.test(star.name)));
    const starHopAboveHorizon = object => {
      if (!object) return false;
      const horizontal = typeof getStarPosition === "function" ? getStarPosition(object) : null;
      const altitude = Number.isFinite(horizontal?.alt) ? horizontal.alt : Number(object.alt);
      return Number.isFinite(altitude) && altitude > 0;
    };
    const starHopConstellation = star => {
      const ids = new Set([String(star?.id ?? ""), String(star?.hip ?? ""), `HIP_${starHopHip(star)}`]);
      const match = (state.constellations || []).find(item =>
        (item.lines || []).some(segment => Array.isArray(segment) && segment.some(id => ids.has(String(id)))));
      return match ? localizedConstellationName(match) : "";
    };
    const starHopBrightness = star => {
      const mag = Number(star?.mag);
      if (!Number.isFinite(mag)) return t("starHop.brightnessUnknown");
      if (mag <= 0) return t("starHop.brightnessExceptional");
      if (mag <= 1) return t("starHop.brightnessAmongBrightest");
      if (mag <= 2) return t("starHop.brightnessVeryBright");
      if (mag <= 3) return t("starHop.brightnessWellVisible");
      return t("starHop.brightnessDiscreet");
    };
    const starHopNearbyNamed = star => (state.stars || [])
      .filter(other => other !== star && starHopHasCommonName(other)
        && Number.isFinite(Number(other.ra)) && Number.isFinite(Number(other.dec)))
      .map(other => ({ star: other, distance: angularSeparationDeg(star, other) }))
      .filter(item => Number.isFinite(item.distance) && item.distance >= 0.2 && item.distance <= 18)
      .sort((a, b) => a.distance - b.distance)[0];
    const radHop = value => Number(value) * Math.PI / 180;
    const wrapStarHopRa = value => ((value + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    function updateStarHopResult() {
      if (!starHopAnchor || !starHopTarget || !starHopResult) return;
      const anchor = (state.stars || []).find(star => String(star.hip ?? star.id ?? starHopName(star)) === starHopAnchor.value);
      const target = (typeof getVisibleNowObjects === "function" ? getVisibleNowObjects() : []).find(object => String(object.id ?? object.name) === starHopTarget.value);
      if (!anchor || !target || !Number.isFinite(Number(anchor.ra)) || !Number.isFinite(Number(anchor.dec)) || !Number.isFinite(Number(target.ra)) || !Number.isFinite(Number(target.dec))) {
        starHopResult.textContent = t("starHop.insufficientCoords");
        return;
      }
      const anchorHorizontal = typeof getStarPosition === "function" ? getStarPosition(anchor) : null;
      if (!Number.isFinite(anchorHorizontal?.alt) || anchorHorizontal.alt <= 0) {
        starHopResult.textContent = `${t("starHop.anchorBelowHorizonStart")} ${starHopName(anchor)} ${t("starHop.anchorBelowHorizonEnd")}`;
        if (starHopRouteList) {
          starHopRouteList.replaceChildren();
          const item = document.createElement("li");
          item.textContent = t("starHop.anchorNotVisible");
          starHopRouteList.append(item);
        }
        if (starHopRouteLines) starHopRouteLines.replaceChildren();
        return;
      }
      const ra1 = radHop(Number(anchor.ra) * 15), dec1 = radHop(Number(anchor.dec));
      const ra2 = radHop(Number(target.ra) * 15), dec2 = radHop(Number(target.dec));
      const deltaRa = ra2 - ra1;
      const cosSep = Math.max(-1, Math.min(1, Math.sin(dec1) * Math.sin(dec2) + Math.cos(dec1) * Math.cos(dec2) * Math.cos(deltaRa)));
      const separation = Math.acos(cosSep) * 180 / Math.PI;
      const y = Math.sin(deltaRa) * Math.cos(dec2);
      const x = Math.cos(dec1) * Math.sin(dec2) - Math.sin(dec1) * Math.cos(dec2) * Math.cos(deltaRa);
      const angle = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
      const compass = angle < 22.5 || angle >= 337.5 ? "Nord" : angle < 67.5 ? "Nord-est" : angle < 112.5 ? "Est" : angle < 157.5 ? "Sud-est" : angle < 202.5 ? "Sud" : angle < 247.5 ? "Sud-ouest" : angle < 292.5 ? "Ouest" : "Nord-ouest";
      const distance = separation < 1 ? `${(separation * 60).toFixed(1)}′ d’arc` : `${separation.toFixed(2)}°`;
      // Pour les cibles proches, agrandir d’emblée la sphère entière. Le zoom
      // agit sur le globe et tous ses repères, pas sur les seules coordonnées.
      const baseSphereScale = separation < 30 ? 1.08 : 1;
      if (!starHopSphereZoomTouched) starHopSphereZoom = baseSphereScale;
      starHopSphereCurrentScale = Math.min(10, Math.max(0.72, starHopSphereZoom));
      const scalableSphere = $("star-hop-sphere-scalable");
      if (scalableSphere) scalableSphere.setAttribute("transform", `translate(300 160) scale(${starHopSphereCurrentScale}) translate(-300 -160)`);
      const anchorName = starHopName(anchor);
      const targetName = target.name || target.proper_name || target.id || "la cible";
      const recognition = $("star-hop-anchor-recognition");
      if (recognition) {
        const constellationName = starHopConstellation(anchor);
        const neighbor = starHopNearbyNamed(anchor);
        const clues = [];
        clues.push(constellationName ? `Constellation : ${constellationName}.` : t("starHop.constellationNotIdentified"));
        clues.push(`${t("starHop.brightnessLabel")} ${starHopBrightness(anchor)} (${t("starHop.magnitude")} ${Number.isFinite(Number(anchor.mag)) ? Number(anchor.mag).toFixed(1) : t("starHop.unknown")}).`);
        if (neighbor) {
          const neighborDistance = neighbor.distance < 1 ? `${(neighbor.distance * 60).toFixed(0)} minutes d’arc` : `${neighbor.distance.toFixed(1)}°`;
          clues.push(`${t("starHop.neighborLandmark")} ${starHopName(neighbor.star)}, ${t("starHop.atAbout")} ${neighborDistance} ${t("starHop.onCelestialSphere")}`);
        } else {
          clues.push(t("starHop.useSchema"));
        }
        recognition.textContent = clues.join(" ");
      }
      // Le repère final doit avoir un nom commun connu. Pour relier deux régions
      // du ciel, les étoiles intermédiaires peuvent aussi être des étoiles de
      // catalogue brillantes (mag. ≤ 4,0) : elles sont dessinées comme points de
      // passage et leur identifiant HIP est explicité dans la liste si nécessaire.
      const routeStars = (state.stars || []).map(star => ({
        ...star,
        common_name: starHopCommonNames.get(starHopHip(star))
          || star?.proper_name || star?.properName
          || (star?.name && !/^HIP\s*\d+$/i.test(star.name) ? star.name : "")
      })).filter(star => {
        if (!Number.isFinite(Number(star.mag)) || Number(star.mag) > 4.0
          || !Number.isFinite(Number(star.ra)) || !Number.isFinite(Number(star.dec))) return false;
        // Le cheminement doit rester praticable depuis le lieu et l'heure
        // choisis : une étoile sous l'horizon ne peut pas servir de repère.
        const horizontal = typeof getStarPosition === "function" ? getStarPosition(star) : null;
        return Number.isFinite(horizontal?.alt) && horizontal.alt > 0;
      });
      // La même limite s’applique à chaque saut, y compris au dernier saut
      // entre l’étoile repère finale et l’objet recherché.
      const maxRouteHopDeg = Math.min(12, recommendedStarHopMaxDeg(separation));
      // Le repère final doit être nommé, lumineux, visible et à portée d’un
      // seul saut final ; un repère à 15–18° ne suffit pas à valider le trajet.
      const guideCandidate = selectTargetGuideStar(target, routeStars, { maxMagnitude: 4.0, maxDistanceDeg: maxRouteHopDeg });
      const anchorIsFinalGuide = Boolean(guideCandidate)
        && String(guideCandidate.hip ?? guideCandidate.id ?? starHopName(guideCandidate))
          === String(anchor.hip ?? anchor.id ?? starHopName(anchor));
      const finalGuide = anchorIsFinalGuide ? null : guideCandidate;
      // Le parcours n'est validé que si une chaîne continue existe réellement.
      // Aucun trajet compact à grands sauts ne doit masquer un échec de calcul.
      const route = buildStarHopRoute(anchor, finalGuide || target, routeStars, {
        maxHopDeg: maxRouteHopDeg,
        maxMagnitude: 4.0,
        // Les étoiles intermédiaires peuvent être anonymes dans le catalogue :
        // elles restent de vrais repères sur le schéma, même si leur nom commun
        // n'est pas renseigné. Le départ et le repère final, eux, restent nommés.
        requireCommonName: false
      });
      route.finalGuide = finalGuide;
      if (starHopResult) {
        const guideName = finalGuide ? starHopName(finalGuide) : null;
        const guideDistance = finalGuide ? angularSeparationDeg(finalGuide, target) : null;
        const guideDistanceText = Number.isFinite(guideDistance) ? (guideDistance < 1 ? `${(guideDistance * 60).toFixed(1)}′ d’arc` : `${guideDistance.toFixed(2)}°`) : '';
        let guideCompass = '';
        if (finalGuide) {
          const dra = radHop((Number(target.ra) - Number(finalGuide.ra)) * 15);
          const d1 = radHop(Number(finalGuide.dec));
          const d2 = radHop(Number(target.dec));
          const bearing = (Math.atan2(Math.sin(dra) * Math.cos(d2), Math.cos(d1) * Math.sin(d2) - Math.sin(d1) * Math.cos(d2) * Math.cos(dra)) * 180 / Math.PI + 360) % 360;
          guideCompass = bearing < 22.5 || bearing >= 337.5 ? 'Nord' : bearing < 67.5 ? 'Nord-est' : bearing < 112.5 ? 'Est' : bearing < 157.5 ? 'Sud-est' : bearing < 202.5 ? 'Sud' : bearing < 247.5 ? 'Sud-ouest' : bearing < 292.5 ? 'Ouest' : 'Nord-ouest';
        }
        starHopResult.textContent = route.complete
          ? finalGuide
            ? `${t("starHop.routeComputedFrom")} ${anchorName} ${t("starHop.routeTo")} ${guideName}, ${t("starHop.nearestNamedLandmarkOf")} ${targetName} ${t("starHop.amongStarsWithinHop")} ${maxRouteHopDeg.toFixed(1)}°. ${route.legs.length} ${t("starHop.hopsLimit")} ${route.maxHopDeg.toFixed(1)}${t("starHop.perHopSince")} ${guideName}, ${t("starHop.lookFor")} ${targetName} ${t("ui.at")} ${guideDistanceText} ${t("starHop.towardThe")} ${guideCompass}. ${t("starHop.faintTargetNote")}`
            : anchorIsFinalGuide
              ? `${t("starHop.startLandmark")} ${anchorName} ${t("starHop.alreadyNearestNamed")} ${targetName}. ${t("starHop.seekTargetAt")} ${distance} ${t("starHop.towardThe")} ${compass}. ${t("starHop.faintTargetNote")}`
              : `${t("starHop.routeComputedFrom")} ${anchorName} ${t("starHop.routeToward")} ${targetName} : ${route.legs.length} ${t("starHop.stepsCount")} ${t("starHop.noNamedLandmarkFound")}`
          : `${t("starHop.noContinuousRouteFound")} ${route.maxHopDeg.toFixed(1)}${t("starHop.maxHopsDirectFrom")} ${anchorName} ${t("starHop.remainsIndicative")} (${distance}, ${compass}).`;
      }
      if (starHopRouteList) {
        starHopRouteList.replaceChildren();
        if (!route.complete) {
          const item = document.createElement("li");
          item.textContent = `${t("starHop.noReliableRouteFound")} ${maxRouteHopDeg.toFixed(1)}${t("starHop.maxHopsDottedLine")}`;
          starHopRouteList.append(item);
        }
        (route.complete ? route.legs : []).forEach((leg, index) => {
          const item = document.createElement("li");
          const routeStarName = star => star?.common_name
            ? starHopName(star)
            : star?.hip ? `${t("starHop.intermediateStarLabel")} (HIP ${star.hip})` : t("starHop.intermediateStar");
          const fromName = leg.from.kind === "anchor" ? anchorName : routeStarName(leg.from.object);
          const toName = leg.to.kind === "target" && !finalGuide ? targetName : routeStarName(leg.to.object);
          const mag = Number(leg.to.object?.mag);
          const magnitudeNote = leg.to.kind === "star" && Number.isFinite(mag) ? ` (mag. ${mag.toFixed(1)})` : "";
          const separationText = leg.separationDeg < 1 ? `${(leg.separationDeg * 60).toFixed(1)}′` : `${leg.separationDeg.toFixed(2)}°`;
          const strong = document.createElement("strong");
          strong.textContent = `${index + 1}. ${fromName} → ${toName}`;
          const detail = document.createElement("span");
          const stepStar = leg.to.kind === "star" ? leg.to.object : null;
          const stepConstellation = stepStar ? starHopConstellation(stepStar) : "";
          const stepNeighbor = stepStar ? starHopNearbyNamed(stepStar) : null;
          const stepClues = [];
          if (stepStar) {
            if (stepConstellation) stepClues.push(stepConstellation);
            if (Number.isFinite(mag)) stepClues.push(starHopBrightness(stepStar));
            if (stepNeighbor) stepClues.push(`${t("starHop.near")} ${starHopName(stepNeighbor.star)}`);
          }
          detail.textContent = `${separationText}${magnitudeNote}${leg.to.kind === "target" && !finalGuide ? t("starHop.targetZone") : leg.to.kind === "star" && !leg.to.object.common_name ? t("starHop.intermediateStar") : t("starHop.anchorStarLabel")}${stepClues.length ? `${t("ui.dotSeparator")} ${stepClues.join(t("ui.listSeparator"))}` : ""}`;
          item.append(strong, detail);
          starHopRouteList.append(item);
        });
        if (route.complete && finalGuide) {
          const guideToTarget = angularSeparationDeg(finalGuide, target);
          const guideItem = document.createElement("li");
          const guideStrong = document.createElement("strong");
          guideStrong.textContent = `${route.legs.length + 1}. ${starHopName(finalGuide)} → ${targetName}`;
          const guideDetail = document.createElement("span");
          const guideDistanceLabel = guideToTarget < 1 ? `${(guideToTarget * 60).toFixed(1)}′` : `${guideToTarget.toFixed(2)}°`;
          guideDetail.textContent = `${guideDistanceLabel} · direction finale vers la cible`;
          guideItem.append(guideStrong, guideDetail);
          starHopRouteList.append(guideItem);
        }
        if (!route.legs.length && !finalGuide) {
          const item = document.createElement("li"); item.textContent = t("starHop.noStepCalculated"); starHopRouteList.append(item);
        }
      }
      const setFullDiagramLabel = (node, name, pos) => {
        if (!node || !pos) return;
        // Affiche le nom complet sur plusieurs lignes plutôt que de le tronquer.
        const words = String(name || t("ui.celestialObject")).trim().split(/\s+/);
        const lines = [];
        let line = "";
        for (const word of words) {
          if (word.length > 20) {
            if (line) { lines.push(line); line = ""; }
            for (let i = 0; i < word.length; i += 20) lines.push(word.slice(i, i + 20));
          } else if (!line) line = word;
          else if (`${line} ${word}`.length <= 20) line += ` ${word}`;
          else { lines.push(line); line = word; }
        }
        if (line) lines.push(line);
        const safeLines = lines.length ? lines : [t("ui.celestialObject")];
        const widest = Math.max(...safeLines.map(item => item.length));
        const estimatedWidth = Math.min(190, widest * 7.2);
        const x = Math.max(estimatedWidth / 2 + 8, Math.min(600 - estimatedWidth / 2 - 8, pos.x));
        const belowY = pos.y + 27;
        const y = belowY + (safeLines.length - 1) * 13 <= 306
          ? belowY
          : Math.max(24, pos.y - 20 - (safeLines.length - 1) * 13);
        node.replaceChildren();
        node.setAttribute("x", x.toFixed(1));
        node.setAttribute("y", y.toFixed(1));
        node.setAttribute("font-size", safeLines.length > 2 ? "10" : "12");
        safeLines.forEach((part, index) => {
          const tspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
          tspan.setAttribute("x", x.toFixed(1));
          tspan.setAttribute("dy", index === 0 ? "0" : "13");
          tspan.textContent = part;
          node.append(tspan);
        });
        node.setAttribute("aria-label", String(name || t("ui.celestialObject")));
      };
      if (starHopDiagramDirection) starHopDiagramDirection.textContent = compass;
      if (starHopSeparation) starHopSeparation.textContent = distance;
      if (starHopCompass) starHopCompass.textContent = compass;
      // Sphère orthographique : les coordonnées équatoriales sont converties en
      // vecteurs 3D puis projetées sur l’hémisphère tourné vers l’observateur.
      // Le centre initial se place au milieu angulaire du départ et de la cible.
      const midpointVector = [
        Math.cos(dec1) * Math.cos(ra1) + Math.cos(dec2) * Math.cos(ra2),
        Math.cos(dec1) * Math.sin(ra1) + Math.cos(dec2) * Math.sin(ra2),
        Math.sin(dec1) + Math.sin(dec2)
      ];
      let centreNorm = Math.hypot(...midpointVector);
      // Pour deux directions presque opposées, le milieu du grand cercle est
      // indéterminé : on choisit alors la cible comme centre initial.
      if (centreNorm < 1e-8) {
        midpointVector[0] = Math.cos(dec2) * Math.cos(ra2);
        midpointVector[1] = Math.cos(dec2) * Math.sin(ra2);
        midpointVector[2] = Math.sin(dec2);
        centreNorm = 1;
      }
      const cX = midpointVector[0] / centreNorm;
      const cY = midpointVector[1] / centreNorm;
      const cZ = midpointVector[2] / centreNorm;
      const midRa = Math.atan2(cY, cX);
      const midDec = Math.asin(Math.max(-1, Math.min(1, cZ)));
      const project = (ra, dec) => {
        const sx = Math.cos(dec) * Math.cos(ra);
        const sy = Math.cos(dec) * Math.sin(ra);
        const sz = Math.sin(dec);
        // Base locale centrée sur le milieu du parcours : est, nord, profondeur.
        const east = -Math.sin(midRa) * sx + Math.cos(midRa) * sy;
        const north = -Math.sin(midDec) * Math.cos(midRa) * sx - Math.sin(midDec) * Math.sin(midRa) * sy + Math.cos(midDec) * sz;
        const depth = cX * sx + cY * sy + cZ * sz;
        const yaw = starHopSphereYaw;
        const pitch = starHopSpherePitch;
        const rotatedEast = east * Math.cos(yaw) - depth * Math.sin(yaw);
        const rotatedDepth = east * Math.sin(yaw) + depth * Math.cos(yaw);
        const rotatedNorth = north * Math.cos(pitch) - rotatedDepth * Math.sin(pitch);
        const finalDepth = north * Math.sin(pitch) + rotatedDepth * Math.cos(pitch);
        const radius = 132;
        return { x: 300 + rotatedEast * radius, y: 160 - rotatedNorth * radius, visible: finalDepth >= -0.015, depth: finalDepth };
      };
      // Graticule dynamique : les méridiens et parallèles tournent avec la sphère.
      const sphereGrid = $("star-hop-sphere-grid");
      if (sphereGrid) {
        sphereGrid.replaceChildren();
        const ns = "http://www.w3.org/2000/svg";
        const drawCurve = points => {
          let segment = [];
          const flush = () => {
            if (segment.length > 1) {
              const line = document.createElementNS(ns, "polyline");
              line.setAttribute("points", segment.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" "));
              line.setAttribute("stroke-linecap", "round");
              line.setAttribute("stroke-linejoin", "round");
              sphereGrid.append(line);
            }
            segment = [];
          };
          for (const point of points) {
            if (point.visible && point.x >= 168 && point.x <= 432 && point.y >= 28 && point.y <= 292) segment.push(point);
            else flush();
          }
          flush();
        };
        for (let raDeg = 0; raDeg < 360; raDeg += 30) {
          const points = [];
          for (let decDeg = -90; decDeg <= 90; decDeg += 3) points.push(project(radHop(raDeg), radHop(decDeg)));
          drawCurve(points);
        }
        for (let decDeg = -60; decDeg <= 60; decDeg += 30) {
          const points = [];
          for (let raDeg = 0; raDeg <= 360; raDeg += 3) points.push(project(radHop(raDeg), radHop(decDeg)));
          drawCurve(points);
        }
      }
      const anchorPos = project(ra1, dec1);
      const targetPos = project(ra2, dec2);
      const setPosition = (node, pos) => {
        if (!node) return;
        node.setAttribute("cx", pos.x.toFixed(1)); node.setAttribute("cy", pos.y.toFixed(1));
        node.style.display = pos.visible ? "" : "none";
      };
      for (const node of [starHopAnchorHalo, starHopAnchorDot, starHopAnchorCore]) setPosition(node, anchorPos);
      for (const node of [starHopTargetHalo, starHopTargetDot, starHopTargetCore]) setPosition(node, targetPos);
      if (starHopDiagramAnchor) starHopDiagramAnchor.style.display = anchorPos.visible ? "" : "none";
      if (starHopDiagramTarget) starHopDiagramTarget.style.display = targetPos.visible ? "" : "none";
      setFullDiagramLabel(starHopDiagramAnchor, anchorName, anchorPos);
      setFullDiagramLabel(starHopDiagramTarget, targetName, targetPos);
      if (starHopDiagramDirection) {
        starHopDiagramDirection.hidden = Boolean(route?.finalGuide) || !anchorPos.visible || !targetPos.visible;
        starHopDiagramDirection.setAttribute("x", ((anchorPos.x + targetPos.x) / 2).toFixed(1));
        starHopDiagramDirection.setAttribute("y", ((anchorPos.y + targetPos.y) / 2 - 10).toFixed(1));
      }
      renderStarHopField(midRa, midDec, anchor, target, project, separation, route);
    }
    function renderStarHopField(midRa, midDec, anchor, target, project, separation = 0, route = null) {
      if (!starHopFieldStars || !starHopConstellationLines) return;
      starHopFieldStars.replaceChildren();
      if (starHopRouteLines) starHopRouteLines.replaceChildren();
      if (starHopFieldLabels) starHopFieldLabels.replaceChildren();
      starHopConstellationLines.replaceChildren();
      if (starHopConstellationLabels) starHopConstellationLabels.replaceChildren();
      const ns = "http://www.w3.org/2000/svg";
      const byId = new Map((state.stars || []).map(star => [String(star.id || (star.hip ? `HIP_${star.hip}` : "")), star]));
      const visibleStars = (state.stars || []).filter(star => {
        if (!Number.isFinite(Number(star.ra)) || !Number.isFinite(Number(star.dec))) return false;
        const pos = project(radHop(Number(star.ra) * 15), radHop(Number(star.dec)));
        return pos.visible && pos.x > 168 && pos.x < 432 && pos.y > 28 && pos.y < 292 && Number.isFinite(Number(star.mag)) && Number(star.mag) <= 4.0;
      });
      const positions = new Map();
      for (const star of visibleStars) {
        const pos = project(radHop(Number(star.ra) * 15), radHop(Number(star.dec)));
        positions.set(String(star.id || (star.hip ? `HIP_${star.hip}` : "")), pos);
      }
      // Chaque saut est dessiné comme un arc de grand cercle sur la surface
      // de la sphère, jamais comme une corde traversant son intérieur.
      // Les portions situées derrière l'hémisphère visible sont interrompues.
      if (starHopRouteLines) {
        const routeLegs = route?.complete ? [...(route?.legs || [])] : [];
        if (route?.complete && route?.finalGuide) {
          routeLegs.push({ from: { object: route.finalGuide }, to: { object: target }, finalApproach: true });
        } else if (route && !route.complete) {
          // Conserver le lien visuel départ-arrivée même si aucun itinéraire
          // par étapes n'est validé : cet arc est explicitement indicatif.
          routeLegs.push({ from: { object: anchor }, to: { object: target }, indicativeOnly: true });
        }
        const unitVector = object => {
          const ra = radHop(Number(object?.ra) * 15);
          const dec = radHop(Number(object?.dec));
          return [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
        };
        for (const leg of routeLegs) {
          const from = leg.from?.object || leg.from;
          const to = leg.to?.object || leg.to;
          if (![from?.ra, from?.dec, to?.ra, to?.dec].every(value => Number.isFinite(Number(value)))) continue;
          const a = unitVector(from), b = unitVector(to);
          const dot = Math.max(-1, Math.min(1, a[0]*b[0] + a[1]*b[1] + a[2]*b[2]));
          const omega = Math.acos(dot);
          if (!Number.isFinite(omega) || omega < 1e-7) continue;
          const steps = Math.max(12, Math.ceil(omega * 180 / Math.PI / 2));
          const segments = [];
          let current = [];
          const flush = () => { if (current.length > 1) segments.push(current); current = []; };
          for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            let v;
            if (Math.abs(Math.sin(omega)) < 1e-7) {
              v = a.map((value, index) => value * (1-t) + b[index] * t);
            } else {
              const wa = Math.sin((1-t)*omega) / Math.sin(omega);
              const wb = Math.sin(t*omega) / Math.sin(omega);
              v = a.map((value, index) => value*wa + b[index]*wb);
            }
            const norm = Math.hypot(...v) || 1;
            const point = project(Math.atan2(v[1]/norm, v[0]/norm), Math.asin(Math.max(-1, Math.min(1, v[2]/norm))));
            if (point.visible && point.x >= 168 && point.x <= 432 && point.y >= 28 && point.y <= 292) current.push(point);
            else flush();
          }
          flush();
          for (const segment of segments) {
            const path = document.createElementNS(ns, "path");
            path.setAttribute("d", segment.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" "));
            path.setAttribute("fill", "none");
            path.setAttribute("stroke", leg.indicativeOnly || leg.finalApproach ? "#b7d5ff" : "#8dbfff");
            path.setAttribute("stroke-width", leg.indicativeOnly || leg.finalApproach ? "1.8" : "2.4");
            path.setAttribute("stroke-dasharray", leg.indicativeOnly ? "5 5" : "none");
            path.setAttribute("stroke-linecap", "round");
            path.setAttribute("stroke-linejoin", "round");
            path.setAttribute("opacity", leg.indicativeOnly || leg.finalApproach ? ".72" : ".88");
            path.setAttribute("vector-effect", "non-scaling-stroke");
            starHopRouteLines.append(path);
          }
        }
      }
      const nearbyConstellations = [];
      for (const constellation of (state.constellations || [])) {
        const constellationPoints = [];
        let visibleSegments = 0;
        for (const segment of (constellation.lines || [])) {
          const a = positions.get(String(segment[0]));
          const b = positions.get(String(segment[1]));
          if (!a || !b) continue;
          // Écarte les segments aberrants : certains tracés de catalogue peuvent
          // relier des points très éloignés ou traverser le champ lors d'une
          // projection sur une grande séparation angulaire.
          const starA = byId.get(String(segment[0]));
          const starB = byId.get(String(segment[1]));
          if (!starA || !starB) continue;
          const raA = radHop(Number(starA.ra) * 15), decA = radHop(Number(starA.dec));
          const raB = radHop(Number(starB.ra) * 15), decB = radHop(Number(starB.dec));
          const angularDot = Math.max(-1, Math.min(1,
            Math.sin(decA) * Math.sin(decB) + Math.cos(decA) * Math.cos(decB) * Math.cos(wrapStarHopRa(raB - raA))));
          const segmentSeparation = Math.acos(angularDot) * 180 / Math.PI;
          if (segmentSeparation > 35 || Math.hypot(a.x - b.x, a.y - b.y) > 145) continue;
          const line = document.createElementNS(ns, "line");
          line.setAttribute("x1", a.x.toFixed(1)); line.setAttribute("y1", a.y.toFixed(1));
          line.setAttribute("x2", b.x.toFixed(1)); line.setAttribute("y2", b.y.toFixed(1));
          line.setAttribute("opacity", ".48");
          starHopConstellationLines.append(line);
          constellationPoints.push(a, b);
          visibleSegments += 1;
        }
        if (visibleSegments >= 2 && constellation.name) {
          const center = constellationPoints.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
          center.x /= constellationPoints.length; center.y /= constellationPoints.length;
          if (center.x > 175 && center.x < 425 && center.y > 35 && center.y < 285) {
            nearbyConstellations.push({ constellation, center, visibleSegments, distance: Math.hypot(center.x - 300, center.y - 170) });
          }
        }
      }
      // Une seule étiquette de constellation : le nom le plus proche du centre du champ.
      if (starHopConstellationLabels && nearbyConstellations.length) {
        nearbyConstellations.sort((a, b) => a.distance - b.distance);
        const nearest = nearbyConstellations[0];
        const label = document.createElementNS(ns, "text");
        label.setAttribute("x", nearest.center.x.toFixed(1)); label.setAttribute("y", (nearest.center.y - 9).toFixed(1));
        label.setAttribute("fill", "#829cbd"); label.setAttribute("font-size", "11"); label.setAttribute("text-anchor", "middle"); label.setAttribute("opacity", ".9");
        label.textContent = localizedConstellationName(nearest.constellation);
        starHopConstellationLabels.append(label);
      }
      const wideSeparation = Number(separation) > 85;
      // Hiérarchie visuelle : les étoiles majeures nommées dominent ; les autres
      // restent en arrière-plan pour conserver le contexte sans brouiller le trajet.
      const routeStarKeys = new Set((route?.nodes || []).map(node => {
        const object = node?.object || node;
        return String(object?.id || (object?.hip ? `HIP_${object.hip}` : ""));
      }));
      for (const star of visibleStars) {
        const key = String(star.id || (star.hip ? `HIP_${star.hip}` : ""));
        const pos = positions.get(key);
        const circle = document.createElementNS(ns, "circle");
        const isMajor = starHopCommonNames.has(starHopHip(star)) && Number(star.mag) <= 2.5;
        const isRouteStar = routeStarKeys.has(key);
        const baseRadius = Math.max(1.1, Math.min(3.2, 3.8 - (Number(star.mag) || 0) * .48));
        circle.setAttribute("cx", pos.x.toFixed(1)); circle.setAttribute("cy", pos.y.toFixed(1));
        circle.setAttribute("r", String(isMajor ? baseRadius : Math.max(.75, baseRadius * (isRouteStar ? .72 : .58))));
        circle.setAttribute("fill", isMajor ? "#e4edff" : (isRouteStar ? "#9ebbe0" : "#91a4c0"));
        circle.setAttribute("opacity", isMajor ? ".98" : (isRouteStar ? ".48" : (wideSeparation ? ".10" : ".14")));
        const title = document.createElementNS(ns, "title"); title.textContent = starHopName(star); circle.append(title);
        starHopFieldStars.append(circle);
      }
      // Quelques étoiles majeures sont nommées clairement, sans transformer
      // la carte en catalogue : priorité aux étoiles communes les plus brillantes.
      if (starHopFieldLabels) {
        const anchorHip = starHopHip(anchor);
        const targetId = String(target.id || target.name || "");
        const labelCandidates = visibleStars
          .filter(star => starHopCommonNames.has(starHopHip(star)) && starHopHip(star) !== anchorHip && String(star.id || star.name || "") !== targetId && Number(star.mag) <= 2.5)
          .sort((a, b) => Number(a.mag) - Number(b.mag));
        const usedLabelPositions = [];
        let labelsAdded = 0;
        for (const star of labelCandidates) {
          if (labelsAdded >= 5) break;
          const pos = positions.get(String(star.id || (star.hip ? `HIP_${star.hip}` : "")));
          if (!pos || !pos.visible) continue;
          const labelX = Math.max(34, Math.min(566, pos.x + (pos.x > 470 ? -7 : 7)));
          const labelY = Math.max(18, Math.min(294, pos.y - 7));
          if (usedLabelPositions.some(other => Math.hypot(other.x - labelX, other.y - labelY) < 38)) continue;
          const label = document.createElementNS(ns, "text");
          label.setAttribute("x", labelX.toFixed(1)); label.setAttribute("y", labelY.toFixed(1));
          label.setAttribute("fill", "#f2d995"); label.setAttribute("font-size", "12");
          label.setAttribute("font-weight", "650"); label.setAttribute("text-anchor", pos.x > 470 ? "end" : "start");
          label.setAttribute("paint-order", "stroke"); label.setAttribute("stroke", "#081326");
          label.setAttribute("stroke-width", "3.5"); label.setAttribute("stroke-linejoin", "round");
          label.textContent = starHopName(star);
          starHopFieldLabels.append(label);
          usedLabelPositions.push({ x: labelX, y: labelY });
          labelsAdded += 1;
        }
      }
      // Les deux objets choisis restent visibles au premier plan même si leur
      // magnitude est faible ou si le champ contient peu d’étoiles cataloguées.
      for (const object of [anchor, target]) {
        const pos = project(radHop(Number(object.ra) * 15), radHop(Number(object.dec)));
        const ring = document.createElementNS(ns, "circle");
        ring.setAttribute("cx", pos.x.toFixed(1)); ring.setAttribute("cy", pos.y.toFixed(1));
        ring.setAttribute("r", "10"); ring.setAttribute("fill", "none"); ring.setAttribute("stroke", "#dbeaff"); ring.setAttribute("stroke-dasharray", "2 3"); ring.setAttribute("opacity", ".55");
        starHopFieldStars.append(ring);
      }
    }
    // La sphère se manipule à la souris ou au doigt. Le déplacement fait tourner
    // le modèle, sans modifier l’heure ni prétendre simuler la rotation du ciel.
    const redrawStarHopSphere = () => { if (starHopDialog && !starHopDialog.hidden) updateStarHopResult(); };
    on("star-hop-sphere-reset", "click", () => { starHopSphereYaw = 0; starHopSpherePitch = 0; starHopSphereZoom = 1; starHopSphereZoomTouched = false; redrawStarHopSphere(); });
    on("star-hop-zoom-in", "click", () => { starHopSphereZoomTouched = true; starHopSphereZoom = Math.min(10, starHopSphereCurrentScale + 0.1); redrawStarHopSphere(); });
    on("star-hop-zoom-out", "click", () => { starHopSphereZoomTouched = true; starHopSphereZoom = Math.max(0.72, starHopSphereCurrentScale - 0.1); redrawStarHopSphere(); });
    if (starHopSphereSvg) {
      starHopSphereSvg.style.touchAction = "none";
      starHopSphereSvg.addEventListener("pointerdown", event => {
        if (event.button !== undefined && event.button !== 0) return;
        starHopSphereDrag = { x: event.clientX, y: event.clientY, yaw: starHopSphereYaw, pitch: starHopSpherePitch, pointerId: event.pointerId };
        try { starHopSphereSvg.setPointerCapture(event.pointerId); } catch {}
      });
      starHopSphereSvg.addEventListener("pointermove", event => {
        if (!starHopSphereDrag || starHopSphereDrag.pointerId !== event.pointerId) return;
        starHopSphereYaw = starHopSphereDrag.yaw + (event.clientX - starHopSphereDrag.x) / 132;
        starHopSpherePitch = Math.max(-1.35, Math.min(1.35, starHopSphereDrag.pitch - (event.clientY - starHopSphereDrag.y) / 132));
        redrawStarHopSphere();
      });
      const endSphereDrag = event => { if (starHopSphereDrag && starHopSphereDrag.pointerId === event.pointerId) starHopSphereDrag = null; };
      starHopSphereSvg.addEventListener("pointerup", endSphereDrag);
      starHopSphereSvg.addEventListener("pointercancel", endSphereDrag);
      starHopSphereSvg.addEventListener("wheel", event => {
        event.preventDefault();
        starHopSphereZoomTouched = true;
        starHopSphereZoom = Math.min(10, Math.max(0.72, starHopSphereCurrentScale + (event.deltaY < 0 ? 0.1 : -0.1)));
        redrawStarHopSphere();
      }, { passive: false });
    }
    function openStarHop() {
      if (!starHopDialog || !starHopAnchor || !starHopTarget) return;
      // Ne proposer que des étoiles repères actuellement au-dessus de l’horizon.
      // Les noms communs sont privilégiés pour rendre les listes accessibles aux débutants.
      const stars = (state.stars || []).filter(star => starHopHasCommonName(star)
        && Number.isFinite(Number(star.ra)) && Number.isFinite(Number(star.dec))
        && (!Number.isFinite(Number(star.mag)) || Number(star.mag) <= 3.5)
        && starHopAboveHorizon(star));
      stars.sort((a, b) => starHopName(a).localeCompare(starHopName(b), "fr"));
      starHopAnchor.replaceChildren();
      for (const star of stars) {
        const option = document.createElement("option");
        option.value = String(star.hip ?? starHopHip(star) ?? star.id ?? starHopName(star));
        option.textContent = `${starHopName(star)}${Number.isFinite(Number(star.mag)) ? ` · mag. ${Number(star.mag).toFixed(1)}` : ""}`;
        starHopAnchor.append(option);
      }
      const targets = (typeof getVisibleNowObjects === "function" ? getVisibleNowObjects() : []).filter(object =>
        Number.isFinite(Number(object.ra)) && Number.isFinite(Number(object.dec))
        && object.type !== "sun" && object.type !== "moon"
        && starHopAboveHorizon(object));
      targets.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), "fr"));
      starHopTarget.replaceChildren();
      for (const target of targets) {
        const option = document.createElement("option");
        option.value = String(target.id ?? target.name);
        option.textContent = formatStarHopTargetLabel(target);
        starHopTarget.append(option);
      }
      if (!stars.length || !targets.length) {
        starHopResult.textContent = !stars.length && !targets.length
          ? t("starHop.noAnchorOrTargetAboveHorizon")
          : !stars.length
            ? t("starHop.noNamedAnchorAboveHorizon")
            : t("ui.noStarHopTargetAboveHorizon");
      } else updateStarHopResult();
      starHopDialog.hidden = false;
    }
    openStarHopHandler = openStarHop;
    const closeStarHop = () => { if (starHopDialog) starHopDialog.hidden = true; };
    on("star-hop-open", "click", openStarHop);
    on("star-hop-close", "click", closeStarHop);
    on("star-hop-dialog", "click", event => { if (event.target?.matches?.("[data-close-star-hop]")) closeStarHop(); });
    on("star-hop-anchor", "change", updateStarHopResult);
    on("star-hop-target", "change", updateStarHopResult);
    on("star-hop-guide", "click", () => {
      const target = (typeof getVisibleNowObjects === "function" ? getVisibleNowObjects() : []).find(object => String(object.id ?? object.name) === starHopTarget?.value);
      if (!target) { if (starHopResult) starHopResult.textContent = t("starHop.targetNotAvailable"); return; }
      finderReturnTo = "star-hop";
      if (typeof selectTarget === "function") selectTarget(target);
      closeStarHop();
      showToast(`${t("ui.guidanceLaunchedTo")} ${target.name || target.id || t("ui.theTarget")}.`);
    });

    const conditionsDialog = $("conditions-dialog");
    const closeConditions = () => { if (conditionsDialog) conditionsDialog.hidden = true; };
    on("conditions-open", "click", () => { if (conditionsDialog) conditionsDialog.hidden = false; refreshConditions(); });
    on("conditions-close", "click", closeConditions);
    on("conditions-refresh", "click", refreshConditions);
    on("conditions-dialog", "click", event => { if (event.target?.matches?.("[data-close-conditions]")) closeConditions(); });
    // Carnet de soirée : les préférences et cases cochées restent sur cet appareil.
    const sessionDialog = $("session-dialog");
    const sessionStorageKey = "atlas-celeste-session-v1";
    const sessionFields = ["session-date", "session-start", "session-end", "session-goal", "session-notes"];
    const sessionChecks = [...document.querySelectorAll("[data-session-check]")];
    const updateSessionLocalizedDisplays = () => {
      const dateValue = $("session-date")?.value || "";
      const dateDisplay = $("session-date-display");
      if (dateDisplay) {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
        dateDisplay.textContent = match ? new Intl.DateTimeFormat(getLocale(), { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)) : t("ui.datePlaceholder");
      }
      for (const [id, outputId, fallback] of [["session-start", "session-start-display", "--:--"], ["session-end", "session-end-display", "--:--"]]) {
        const output = $(outputId);
        if (output) output.textContent = $(id)?.value || fallback;
      }
    };
    let sessionSuggestions = {
      [t("session.goalDiscovery")]: t("session.goalDiscoveryAdvice"),
      [t("session.goalStars")]: t("session.goalStarsAdvice"),
      [t("session.goalMoon")]: t("session.goalMoonPlanetsAdvice"),
      [t("session.goalGalaxies")]: t("session.goalGalaxiesAdvice"),
      [t("session.goalAstro")]: t("session.goalAstroAdvice")
    };
    const updateSessionSuggestion = () => {
      const goal = $("session-goal")?.value || t("session.goalDiscovery");
      setText("session-suggestion-text", sessionSuggestions[goal] || sessionSuggestions[t("session.goalDiscovery")]);
    };
    document.addEventListener("localechange", () => {
      sessionSuggestions = {
        [t("session.goalDiscovery")]: t("session.goalDiscoveryAdvice"),
        [t("session.goalStars")]: t("session.goalStarsAdvice"),
        [t("session.goalMoon")]: t("session.goalMoonPlanetsAdvice"),
        [t("session.goalGalaxies")]: t("session.goalGalaxiesAdvice"),
        [t("session.goalAstro")]: t("session.goalAstroAdvice")
      };
      updateSessionLocalizedDisplays();
      updateSessionSuggestion();
    });
    const updateSessionMoonStatus = () => {
      const summary = $("session-moon-summary");
      const panel = $("session-moon-status");
      if (!summary || !panel) return;
      const dateValue = $("session-date")?.value;
      const startValue = $("session-start")?.value || "21:00";
      const endValue = $("session-end")?.value || "23:30";
      if (!dateValue) {
        summary.textContent = "—/100";
        panel.dataset.level = "unknown";
        return;
      }
      const [year, month, day] = dateValue.split("-").map(Number);
      const [startHour, startMinute] = startValue.split(":").map(Number);
      const [endHour, endMinute] = endValue.split(":").map(Number);
      const start = new Date(year, month - 1, day, startHour || 0, startMinute || 0);
      const end = new Date(year, month - 1, day, endHour || 0, endMinute || 0);
      if (end <= start) end.setDate(end.getDate() + 1);
      const A = window.Astronomy;
      if (!A || typeof A.MoonPhase !== "function" || !A.Observer || !A.Equator || !A.Horizon || !A.Body) {
        summary.textContent = "—/100";
        panel.dataset.level = "unknown";
        return;
      }
      try {
        const midpoint = new Date((start.getTime() + end.getTime()) / 2);
        const angle = ((A.MoonPhase(midpoint) % 360) + 360) % 360;
        const illumination = Math.round((1 - Math.cos(angle * Math.PI / 180)) * 50);
        const phases = [t("moon.newMoon"), t("moon.firstCrescent"), t("moon.firstQuarter"), t("moon.waxingGibbous"), t("moon.fullMoon"), t("moon.waningGibbous"), t("moon.lastQuarter"), t("moon.lastCrescent")];
        const phase = phases[Math.round(angle / 45) % 8];
        const observer = new A.Observer(Number(state.latitude), Number(state.longitude), 0);
        let moonAboveHorizon = false;
        let validAltitude = false;
        // Échantillonnage de la session pour déterminer si la Lune passe au-dessus de l’horizon.
        for (let time = start.getTime(); time <= end.getTime(); time += 15 * 60 * 1000) {
          const date = new Date(time);
          const equ = A.Equator(A.Body.Moon, date, observer, true, true);
          if (!equ || !Number.isFinite(equ.ra) || !Number.isFinite(equ.dec)) continue;
          const horizon = A.Horizon(date, observer, equ.ra, equ.dec, "normal");
          if (!horizon || !Number.isFinite(horizon.altitude)) continue;
          validAltitude = true;
          if (horizon.altitude > 0) { moonAboveHorizon = true; break; }
        }
        const presence = !validAltitude ? t("session.moonPresenceUnknown") : moonAboveHorizon ? t("session.moonAboveHorizon") : t("session.moonBelowDuringSession");
        let impact = t("session.moonLimitedImpact");
        let level = "low";
        if (moonAboveHorizon && illumination >= 70) {
          impact = t("session.moonStrongImpact");
          level = "high";
        } else if (moonAboveHorizon && illumination >= 35) {
          impact = t("session.moonModerateImpact");
          level = "moderate";
        } else if (moonAboveHorizon && illumination >= 15) {
          impact = t("session.moonModerateImpact2");
          level = "moderate";
        } else if (!moonAboveHorizon) {
          impact = t("session.moonBelowNoImpact");
        } else if (illumination < 15) {
          impact = t("session.moonFavorable");
        }
        // Indice de favorabilité lunaire : 100 si la Lune est sous l’horizon,
        // sinon il diminue avec l’illumination, sur la même échelle que la météo.
        const lunarScore = moonAboveHorizon ? 100 - illumination : 100;
        summary.textContent = `${lunarScore}/100`;
        panel.dataset.level = lunarScore >= 80 ? "good" : lunarScore >= 60 ? "favorable" : lunarScore >= 40 ? "moderate" : "high";
        panel.title = `${phase} · ${illumination} % ${t("session.illuminated")} · ${t("session.moonWord")} ${presence}. ${impact}.`;
      } catch (error) {
        summary.textContent = "—/100";
        panel.dataset.level = "unknown";
        panel.removeAttribute("title");
      }
    };
    const localDateString = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
    const readSession = () => {
      try { const raw = localStorage.getItem(sessionStorageKey); return raw ? JSON.parse(raw) : null; } catch { return null; }
    };
    const saveSession = (notify = false) => {
      const data = {};
      sessionFields.forEach(id => { const el = $(id); if (el) data[id] = el.value; });
      data.checks = Object.fromEntries(sessionChecks.map(el => [el.dataset.sessionCheck, el.checked]));
      try { localStorage.setItem(sessionStorageKey, JSON.stringify(data)); } catch { /* stockage indisponible : la session reste utilisable en mémoire */ }
      if (notify) showToast(t("session.saved"));
    };
    const storedSession = readSession();
    if (storedSession) {
      sessionFields.forEach(id => { if (storedSession[id] != null && $(id)) $(id).value = storedSession[id]; });
      sessionChecks.forEach(el => { el.checked = Boolean(storedSession.checks?.[el.dataset.sessionCheck]); });
    } else if ($("session-date")) {
      $("session-date").value = localDateString(state.observationDate || new Date());
    }
    updateSessionLocalizedDisplays();
    const closeSession = () => { if (sessionDialog) sessionDialog.hidden = true; };
    on("session-open", "click", () => {
      if (sessionDialog) sessionDialog.hidden = false;
      if ($("session-date") && !$("session-date").value) $("session-date").value = localDateString(state.observationDate || new Date());
      updateSessionDateMinimum();
      updateSessionMoonStatus();
      updateSessionWeatherStatus(latestSkyQualityScore);
      // Actualiser l’indice pour la date et l’heure de la soirée sélectionnée.
      if (state.locationReady) refreshConditions();
    });
    on("session-close", "click", closeSession);
    on("session-dialog", "click", event => { if (event.target?.matches?.("[data-close-session]")) closeSession(); });
    updateSessionDateMinimum();
    sessionFields.forEach(id => $(id)?.addEventListener("change", () => {
      if (id === "session-date") updateSessionDateMinimum();
      updateSessionLocalizedDisplays();
      saveSession(false);
      updateSessionMoonStatus();
      if ((id === "session-date" || id === "session-start") && conditionsDialog && !conditionsDialog.hidden && state.locationReady) refreshConditions();
    }));
    $("session-goal")?.addEventListener("change", updateSessionSuggestion);
    updateSessionSuggestion();
    updateSessionMoonStatus();
    $("session-suggestion-add")?.addEventListener("click", () => {
      const notes = $("session-notes");
      if (!notes) return;
      const suggestion = sessionSuggestions[$("session-goal")?.value] || sessionSuggestions[t("session.goalDiscovery")];
      notes.value = notes.value.trim() ? `${notes.value.trim()}\n\nSuggestion : ${suggestion}` : `Suggestion : ${suggestion}`;
      saveSession(false);
      showToast(t("session.suggestionAdded"));
    });
    $("session-notes")?.addEventListener("input", () => saveSession(false));
    sessionChecks.forEach(el => el.addEventListener("change", () => saveSession(false)));
    on("session-save", "click", () => saveSession(true));
    on("session-reset", "click", () => {
      sessionChecks.forEach(el => { el.checked = false; });
      if ($("session-notes")) $("session-notes").value = "";
      saveSession(false);
      showToast(t("session.reset"));
    });

    // Fiche lunaire : réutilise les éphémérides de la bibliothèque Astronomy Engine.
    const moonDialog = $("moon-dialog");
    const moonDateInput = $("moon-datetime");
    const moonNowButton = $("moon-now");
    let moonLiveMode = false;
    const setMoonLiveMode = active => {
      moonLiveMode = Boolean(active);
      if (moonNowButton) {
        moonNowButton.textContent = moonLiveMode ? `${t("ui.live")} ●` : t("solarSystem.nowButton");
        moonNowButton.setAttribute("aria-pressed", String(moonLiveMode));
        moonNowButton.title = moonLiveMode ? t("moon.liveTracking") : t("moon.showCurrentTimeAndTrackPhase");
      }
    };
    document.addEventListener("localechange", () => {
      setMoonLiveMode(moonLiveMode);
      if (moonDialog && !moonDialog.hidden) updateMoonSheet();
    });
    const toLocalDateTimeValue = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}T${String(date.getHours()).padStart(2,"0")}:${String(date.getMinutes()).padStart(2,"0")}:${String(date.getSeconds()).padStart(2,"0")}`;
    const getMoonPhaseNames = () => [t("moon.newMoon"), t("moon.firstCrescent"), t("moon.firstQuarter"), t("moon.waxingGibbous"), t("moon.fullMoon"), t("moon.waningGibbous"), t("moon.lastQuarter"), t("moon.lastCrescent")];
    const moonSvgElement = (id) => document.getElementById(id);
    const updateMoonSheet = () => {
      if (!moonDateInput || !moonDateInput.value) return;
      const date = new Date(moonDateInput.value);
      if (!Number.isFinite(date.getTime())) return;
      const moonPhaseNames = getMoonPhaseNames();
      const A = window.Astronomy;
      const put = (id, value) => { const el = $(id); if (el) el.textContent = value; };
      if (!A || typeof A.MoonPhase !== "function" || typeof A.Equator !== "function" || typeof A.Observer !== "function" || typeof A.Horizon !== "function" || !A.Body) {
        put("moon-phase-name", t("moon.ephemerisUnavailable")); put("moon-observation-note", t("moon.libraryNotAvailable")); return;
      }
      try {
        const angle = ((A.MoonPhase(date) % 360) + 360) % 360;
        const illumination = Math.max(0, Math.min(100, (1 - Math.cos(angle * Math.PI / 180)) * 50));
        const phaseIndex = Math.round(angle / 45) % 8;
        const observer = new A.Observer(Number(state.latitude) || 0, Number(state.longitude) || 0, 0);
        const equ = A.Equator(A.Body.Moon, date, observer, true, true);
        const horizontal = equ && Number.isFinite(equ.ra) && Number.isFinite(equ.dec) ? A.Horizon(date, observer, equ.ra, equ.dec, "normal") : null;
        const illuminationRounded = Math.round(illumination);
        put("moon-phase-name", moonPhaseNames[phaseIndex]);
        put("moon-phase-trend", angle < 180 ? t("moon.waxingPhase") : angle > 180 ? t("moon.waningPhase") : t("moon.fullMoon"));
        put("moon-illumination-value", `${illuminationRounded} %`);
        const bar = $("moon-illumination-bar"); if (bar) bar.style.width = `${illumination}%`;
        const age = (angle / 360) * 29.530588853; put("moon-age", `${age.toLocaleString(getLocale(), { maximumFractionDigits: 1 })} ${t("ui.dayUnit")}`);
        const distanceKm = equ && Number.isFinite(equ.dist) ? equ.dist * 149597870.7 : NaN;
        put("moon-distance", Number.isFinite(distanceKm) ? `${Math.round(distanceKm).toLocaleString(getLocale())} km` : "—");
        const diameterArcmin = Number.isFinite(distanceKm) && distanceKm > 0 ? 2 * Math.atan(1737.4 / distanceKm) * 180 / Math.PI * 60 : NaN;
        put("moon-diameter", Number.isFinite(diameterArcmin) ? `${diameterArcmin.toFixed(2).replace(".", ",")}′` : "—");
        put("moon-altitude", horizontal && Number.isFinite(horizontal.altitude) ? `${horizontal.altitude.toLocaleString(getLocale(), { maximumFractionDigits: 1 })}° · ${horizontal.altitude > 0 ? t("ui.aboveHorizonState") : t("ui.belowHorizonState")}` : "—");
        put("moon-azimuth", horizontal && Number.isFinite(horizontal.azimuth) ? `${horizontal.azimuth.toFixed(1).replace(".", ",")}°` : "—");
        // Disque SVG : la branche éclairée est orientée selon la phase (croissante à droite).
        const r = 68, cx = 90, cy = 90, rad = angle * Math.PI / 180;
        const waxing = angle <= 180; const rx = Math.abs(Math.cos(rad) * r);
        let phasePath;
        if (illumination < 0.8) phasePath = "";
        else if (illumination > 99.2) phasePath = `M ${cx} ${cy-r} A ${r} ${r} 0 1 1 ${cx-0.01} ${cy-r} Z`;
        else if (Math.abs(Math.cos(rad)) < 0.015) phasePath = waxing ? `M ${cx} ${cy-r} A ${r} ${r} 0 0 1 ${cx} ${cy+r} L ${cx} ${cy-r} Z` : `M ${cx} ${cy-r} A ${r} ${r} 0 0 0 ${cx} ${cy+r} L ${cx} ${cy-r} Z`;
        else if (waxing) phasePath = `M ${cx} ${cy-r} A ${r} ${r} 0 0 1 ${cx} ${cy+r} A ${rx} ${r} 0 0 ${angle < 90 ? 0 : 1} ${cx} ${cy-r} Z`;
        else phasePath = `M ${cx} ${cy-r} A ${r} ${r} 0 0 0 ${cx} ${cy+r} A ${rx} ${r} 0 0 ${angle < 270 ? 0 : 1} ${cx} ${cy-r} Z`;
        const phaseShape = $("moon-illuminated-shape"); if (phaseShape) phaseShape.setAttribute("d", phasePath);
        // Le schéma orbital est interactif : la position est déduite de la phase calculée.
        const orbitAngle = (180 - angle) * Math.PI / 180; const orbitX = 180 + 68 * Math.cos(orbitAngle); const orbitY = 115 - 68 * Math.sin(orbitAngle);
        const moonPosition = $("moon-orbit-position"); if (moonPosition) {
          moonPosition.setAttribute("transform", `translate(${orbitX} ${orbitY})`);
          moonPosition.setAttribute("aria-valuenow", String(Math.round(angle) % 360));
          moonPosition.setAttribute("aria-valuetext", `${moonPhaseNames[phaseIndex]}, ${illuminationRounded} % ${t("session.illuminated")}`);
        }
        // Même géométrie de phase pour le petit disque placé sur l'orbite.
        const miniR = 8, miniCx = 0, miniCy = 0, miniRx = Math.abs(Math.cos(rad) * miniR);
        let miniPath;
        if (illumination < 0.8) miniPath = "";
        else if (illumination > 99.2) miniPath = `M ${miniCx} ${miniCy-miniR} A ${miniR} ${miniR} 0 1 1 ${miniCx-0.01} ${miniCy-miniR} Z`;
        else if (Math.abs(Math.cos(rad)) < 0.015) miniPath = waxing ? `M ${miniCx} ${miniCy-miniR} A ${miniR} ${miniR} 0 0 1 ${miniCx} ${miniCy+miniR} L ${miniCx} ${miniCy-miniR} Z` : `M ${miniCx} ${miniCy-miniR} A ${miniR} ${miniR} 0 0 0 ${miniCx} ${miniCy+miniR} L ${miniCx} ${miniCy-miniR} Z`;
        else if (waxing) miniPath = `M ${miniCx} ${miniCy-miniR} A ${miniR} ${miniR} 0 0 1 ${miniCx} ${miniCy+miniR} A ${miniRx} ${miniR} 0 0 ${angle < 90 ? 0 : 1} ${miniCx} ${miniCy-miniR} Z`;
        else miniPath = `M ${miniCx} ${miniCy-miniR} A ${miniR} ${miniR} 0 0 0 ${miniCx} ${miniCy+miniR} A ${miniRx} ${miniR} 0 0 ${angle < 270 ? 0 : 1} ${miniCx} ${miniCy-miniR} Z`;
        const miniShape = $("moon-orbit-lit-shape"); if (miniShape) miniShape.setAttribute("d", miniPath);
        put("moon-phase-angle-note", `${angle.toFixed(2).replace(".", ",")}°`);
        put("moon-orbit-explanation", t("moon.orbitExplanation"));
        put("moon-observation-note", horizontal && Number.isFinite(horizontal.altitude) ? (horizontal.altitude > 0 ? `${t("moon.aboveHorizonPrefix")} ${horizontal.altitude.toFixed(1).replace(".", ",")}°. ${t("moon.aboveHorizonSuffix")}` : t("moon.belowHorizon")) : t("moon.positionNotCalculated"));
      } catch (error) {
        put("moon-phase-name", t("moon.calculationUnavailable")); put("moon-observation-note", t("moon.cannotCalculatePhase"));
      }
    };
    const closeMoonSheet = () => { if (moonDialog) moonDialog.hidden = true; };
    on("moon-open", "click", () => { if (!moonDialog) return; moonDialog.hidden = false; if (moonDateInput && !moonDateInput.value) moonDateInput.value = toLocalDateTimeValue(new Date()); updateLocalizedDateTimeDisplay("moon-datetime", "moon-datetime-display"); updateMoonSheet(); });
    on("moon-close", "click", closeMoonSheet);
    on("moon-dialog", "click", event => { if (event.target?.matches?.("[data-close-moon]")) closeMoonSheet(); });
    on("moon-datetime", "input", () => {
      setMoonLiveMode(false);
      updateMoonSheet();
    });
    on("moon-now", "click", () => {
      if (moonDateInput) moonDateInput.value = toLocalDateTimeValue(new Date());
      setMoonLiveMode(true);
      updateLocalizedDateTimeDisplay("moon-datetime", "moon-datetime-display");
      updateMoonSheet();
    });
    // En mode « Maintenant », avance l’heure sélectionnée et recalcule les
    // éphémérides chaque seconde. Une date manuelle ou un déplacement orbital
    // suspend le direct pour ne jamais écraser l’exploration de l’utilisateur.
    window.setInterval(() => {
      if (!moonLiveMode || !moonDialog || moonDialog.hidden || !moonDateInput) return;
      moonDateInput.value = toLocalDateTimeValue(new Date());
      updateLocalizedDateTimeDisplay("moon-datetime", "moon-datetime-display");
      updateMoonSheet();
    }, 1000);

    // Déplacement de la Lune sur l'orbite : il sélectionne la date la plus proche
    // correspondant à la phase visée, puis recalcule toutes les données depuis les éphémérides.
    const moonOrbitSvg = $("moon-orbit-svg");
    const moonOrbitPosition = $("moon-orbit-position");
    const synodicMonthMs = 29.530588853 * 86400000;
    let moonOrbitDragging = false;
    const normalizePhaseAngle = value => ((value % 360) + 360) % 360;
    const setMoonPhaseByAngle = targetAngle => {
      setMoonLiveMode(false);
      if (!moonDateInput || !moonDateInput.value) return;
      const A = window.Astronomy;
      if (!A || typeof A.MoonPhase !== "function") return;
      const date = new Date(moonDateInput.value);
      if (!Number.isFinite(date.getTime())) return;
      const currentAngle = normalizePhaseAngle(A.MoonPhase(date));
      const difference = ((normalizePhaseAngle(targetAngle) - currentAngle + 540) % 360) - 180;
      date.setTime(date.getTime() + difference / 360 * synodicMonthMs);
      moonDateInput.value = toLocalDateTimeValue(date);
      updateLocalizedDateTimeDisplay("moon-datetime", "moon-datetime-display");
      updateMoonSheet();
    };
    const moonOrbitAngleFromPointer = event => {
      if (!moonOrbitSvg) return null;
      const matrix = moonOrbitSvg.getScreenCTM();
      if (!matrix) return null;
      const point = moonOrbitSvg.createSVGPoint();
      point.x = event.clientX; point.y = event.clientY;
      const local = point.matrixTransform(matrix.inverse());
      const angle = Math.atan2(-(local.y - 115), local.x - 180) * 180 / Math.PI;
      return normalizePhaseAngle(180 - angle);
    };
    moonOrbitPosition?.addEventListener("pointerdown", event => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      moonOrbitDragging = true;
      moonOrbitPosition.classList.add("is-dragging");
      try { moonOrbitSvg?.setPointerCapture(event.pointerId); } catch { /* capture non disponible dans certains navigateurs */ }
      const target = moonOrbitAngleFromPointer(event);
      if (target !== null) setMoonPhaseByAngle(target);
    });
    moonOrbitSvg?.addEventListener("pointermove", event => {
      if (!moonOrbitDragging) return;
      const target = moonOrbitAngleFromPointer(event);
      if (target !== null) setMoonPhaseByAngle(target);
    });
    const endMoonOrbitDrag = () => {
      moonOrbitDragging = false;
      moonOrbitPosition?.classList.remove("is-dragging");
    };
    moonOrbitSvg?.addEventListener("pointerup", endMoonOrbitDrag);
    moonOrbitSvg?.addEventListener("pointercancel", endMoonOrbitDrag);
    moonOrbitPosition?.addEventListener("keydown", event => {
      const current = Number(moonOrbitPosition.getAttribute("aria-valuenow")) || 0;
      let next = current;
      if (event.key === "ArrowRight" || event.key === "ArrowUp") next = current + 5;
      else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = current - 5;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = 359;
      else return;
      event.preventDefault();
      setMoonPhaseByAngle(normalizePhaseAngle(next));
    });

    // Vue depuis la Terre des quatre lunes galiléennes : on projette leurs vecteurs
    // jovicentriques sur le plan du ciel, puis on aligne l'axe horizontal sur le
    // plan orbital de Jupiter. La légère inclinaison verticale est amplifiée dans le dessin.
    const jupiterMoonsDialog = $("jupiter-moons-dialog");
    const jupiterMoonsDateInput = $("jupiter-moons-datetime");
    const jupiterMoonsNowButton = $("jupiter-moons-now");
    const jupiterMoonsPlayButton = $("jupiter-moons-play");
    const jupiterMoonsSpeed = $("jupiter-moons-speed");
    let jupiterMoonsLiveMode = false;
    let jupiterMoonsPlaying = false;
    let jupiterMoonsLastTick = 0;
    const getJupiterMoonInfo = () => [
      { key: "io", name: t("names.moon.io"), color: "#f2c879" },
      { key: "europa", name: t("names.moon.europa"), color: "#d9e8f6" },
      { key: "ganymede", name: t("names.moon.ganymede"), color: "#c8a7f4" },
      { key: "callisto", name: t("names.moon.callisto"), color: "#8bdde0" }
    ];
    const svgElement = (tag, attrs = {}) => {
      const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
      return element;
    };
    const setJupiterMoonsLiveMode = active => {
      jupiterMoonsLiveMode = Boolean(active);
      if (jupiterMoonsNowButton) {
        jupiterMoonsNowButton.textContent = jupiterMoonsLiveMode ? `${t("ui.live")} ●` : t("solarSystem.nowButton");
        jupiterMoonsNowButton.setAttribute("aria-pressed", String(jupiterMoonsLiveMode));
        jupiterMoonsNowButton.title = jupiterMoonsLiveMode ? t("jupiterMoons.livePositions") : t("jupiterMoons.showCurrentPositions");
      }
    };
    const setJupiterMoonsPlaying = active => {
      jupiterMoonsPlaying = Boolean(active);
      if (jupiterMoonsPlayButton) {
        jupiterMoonsPlayButton.textContent = jupiterMoonsPlaying ? `Ⅱ ${t("ui.pause")}` : `▶ ${t("solarSystem.animate")}`;
        jupiterMoonsPlayButton.setAttribute("aria-pressed", String(jupiterMoonsPlaying));
        jupiterMoonsPlayButton.title = jupiterMoonsPlaying ? t("jupiterMoons.pauseAnimation") : t("jupiterMoons.speedUpTime");
      }
      if (jupiterMoonsPlaying) jupiterMoonsLastTick = Date.now();
    };
    document.addEventListener("localechange", () => {
      setJupiterMoonsLiveMode(jupiterMoonsLiveMode);
      setJupiterMoonsPlaying(jupiterMoonsPlaying);
      if (jupiterMoonsDialog && !jupiterMoonsDialog.hidden) updateJupiterMoonsSheet();
    });
    const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
    const norm3 = a => Math.hypot(a.x, a.y, a.z);
    const unit3 = a => {
      const length = norm3(a);
      return Number.isFinite(length) && length > 1e-12 ? { x: a.x / length, y: a.y / length, z: a.z / length } : null;
    };
    const subtract3 = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
    const multiply3 = (a, factor) => ({ x: a.x * factor, y: a.y * factor, z: a.z * factor });
    const cross3 = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
    const updateJupiterMoonsSheet = () => {
      if (!jupiterMoonsDateInput?.value) return;
      const date = new Date(jupiterMoonsDateInput.value);
      if (!Number.isFinite(date.getTime())) return;
      const A = window.Astronomy;
      const jupiterMoonInfo = getJupiterMoonInfo();
      const status = $("jupiter-moons-status");
      const details = $("jupiter-moons-details");
      const behindLayer = $("jupiter-moons-behind");
      const frontLayer = $("jupiter-moons-front");
      const labelsLayer = $("jupiter-moons-labels");
      if (!A || !A.Body || typeof A.JupiterMoons !== "function" || typeof A.GeoVector !== "function" || typeof A.RotationAxis !== "function") {
        if (status) status.textContent = t("jupiterMoons.unavailable");
        if (details) details.replaceChildren();
        [behindLayer, frontLayer, labelsLayer].forEach(layer => layer?.replaceChildren());
        return;
      }
      try {
        const time = A.MakeTime(date);
        const jupiterGeo = A.GeoVector(A.Body.Jupiter, time, true);
        const lineOfSight = unit3(jupiterGeo);
        const pole = A.RotationAxis(A.Body.Jupiter, time)?.north;
        const poleUnit = pole && unit3(pole);
        if (!lineOfSight || !poleUnit) throw new Error("Orientation apparente de Jupiter indisponible");
        const projectedPole = unit3(subtract3(poleUnit, multiply3(lineOfSight, dot3(poleUnit, lineOfSight))));
        if (!projectedPole) throw new Error("Projection du plan orbital de Jupiter impossible");
        const horizontalAxis = unit3(cross3(projectedPole, lineOfSight));
        if (!horizontalAxis) throw new Error(t("jupiterMoons.axisUnavailable"));
        const moons = A.JupiterMoons(time);
        const radiusAu = (Number(A.JUPITER_MEAN_RADIUS_KM) || 69911) / (Number(A.KM_PER_AU) || 149597870.7);
        const centerX = 320, centerY = 155, xScale = 7.2, verticalScale = xScale * 6;
        const moonPositions = jupiterMoonInfo.map((info, index) => {
          const vector = moons?.[info.key];
          if (!vector || ![vector.x, vector.y, vector.z].every(Number.isFinite)) throw new Error(`Position de ${info.name} indisponible`);
          const horizontalAu = dot3(vector, horizontalAxis);
          const verticalAu = dot3(vector, projectedPole);
          const depthAu = dot3(vector, lineOfSight);
          const xRj = horizontalAu / radiusAu;
          const yRj = verticalAu / radiusAu;
          const depthRj = depthAu / radiusAu;
          return { ...info, index, xRj, yRj, depthRj, px: centerX + xRj * xScale, py: centerY - yRj * verticalScale,
            projectedRadius: Math.hypot(xRj, yRj), side: xRj < 0 ? t("jupiterMoons.leftOfJupiter") : t("jupiterMoons.rightOfJupiter") };
        });
        [behindLayer, frontLayer, labelsLayer].forEach(layer => layer?.replaceChildren());
        if (details) details.replaceChildren();
        const drawMoon = (layer, moon, behind) => {
          if (!layer) return;
          const isInsideDisc = moon.projectedRadius <= 1;
          const isOcculted = isInsideDisc && moon.depthRj > 0;
          const group = svgElement("g", { "aria-label": `${moon.name}${isOcculted ? t("jupiterMoons.behindJupiter") : isInsideDisc ? t("jupiterMoons.inFrontOfJupiter") : ""}` });
          if (isOcculted) {
            group.append(svgElement("circle", { cx: moon.px, cy: moon.py, r: 5.3, fill: "none", stroke: moon.color, "stroke-width": 1.6, "stroke-dasharray": "2.5 2", opacity: 0.9 }));
          } else {
            group.append(svgElement("circle", { cx: moon.px, cy: moon.py, r: 5.5, fill: moon.color, stroke: "#07101f", "stroke-width": 1.3 }));
            group.append(svgElement("circle", { cx: moon.px, cy: moon.py, r: 2, fill: "#ffffff", opacity: 0.65 }));
          }
          layer.append(group);
        };
        // Les satellites situés derrière Jupiter sont dessinés avant son disque,
        // ceux qui sont devant sont dessinés ensuite : les transits/occultations se lisent visuellement.
        moonPositions.filter(moon => moon.depthRj > 0).forEach(moon => drawMoon(behindLayer, moon, true));
        moonPositions.filter(moon => moon.depthRj <= 0).forEach(moon => drawMoon(frontLayer, moon, false));
        // Répartir les étiquettes en alternance selon l’ordre horizontal apparent,
        // afin que deux lunes proches ne se retrouvent pas avec leurs noms superposés.
        const labelLaneByMoon = new Map([...moonPositions].sort((a, b) => a.px - b.px).map((moon, index) => [moon.key, index % 2 === 0]));
        moonPositions.forEach((moon) => {
          if (!labelsLayer) return;
          const labelAbove = labelLaneByMoon.get(moon.key) ?? (moon.index % 2 === 0);
          const labelY = Math.max(21, Math.min(286, moon.py + (labelAbove ? -24 : 31)));
          const connectorY = labelY + (labelAbove ? 5 : -13);
          labelsLayer.append(svgElement("line", { x1: moon.px, y1: moon.py, x2: moon.px, y2: connectorY, stroke: moon.color, "stroke-width": 1, opacity: .7 }));
          const label = svgElement("text", { x: moon.px, y: labelY, "text-anchor": "middle", class: "jupiter-moons-moon-label", fill: moon.color, "font-size": 14, "font-weight": 700, "paint-order": "stroke", stroke: "#07101d", "stroke-width": 3.5, "stroke-linejoin": "round" });
          label.textContent = moon.name;
          labelsLayer.append(label);
          if (details) {
            const card = document.createElement("article");
            card.className = "jupiter-moon-detail";
            const heading = document.createElement("h4");
            const swatch = document.createElement("span");
            swatch.style.background = moon.color;
            heading.append(swatch, document.createTextNode(moon.name));
            const position = document.createElement("p");
            let positionText;
            if (moon.projectedRadius <= 1 && moon.depthRj > 0) positionText = t("jupiterMoons.occultation");
            else if (moon.projectedRadius <= 1 && moon.depthRj <= 0) positionText = t("jupiterMoons.transit");
            else positionText = `${moon.side}, ${t("jupiterMoons.at")} ${Math.abs(moon.xRj).toFixed(1).replace(".", ",")} ${t("jupiterMoons.rjFromCenter")}`;
            position.textContent = positionText;
            const depth = document.createElement("p");
            if (moon.projectedRadius > 1) depth.textContent = moon.depthRj > 0 ? t("jupiterMoons.beyondJupiter") : t("jupiterMoons.betweenEarthAndJupiter");
            else depth.textContent = moon.depthRj > 0 ? t("jupiterMoons.hiddenByDisc") : t("jupiterMoons.inForeground");
            card.append(heading, position, depth);
            details.append(card);
          }
        });
        if (status) status.textContent = `${t("jupiterMoons.positionsCalculated")} ${date.toLocaleString(getLocale(), { dateStyle: "long", timeStyle: "medium" })}.`;
        updateLocalizedDateTimeDisplay("jupiter-moons-datetime", "jupiter-moons-datetime-display");
      } catch (error) {
        console.error("Atlas Céleste : calcul des lunes de Jupiter impossible", error);
        if (status) status.textContent = t("jupiterMoons.calcError");
        [behindLayer, frontLayer, labelsLayer].forEach(layer => layer?.replaceChildren());
        if (details) details.replaceChildren();
      }
    };
    const openJupiterMoonsDialog = () => {
      if (!jupiterMoonsDialog) return;
      jupiterMoonsDialog.hidden = false;
      if (jupiterMoonsDateInput) jupiterMoonsDateInput.value = toLocalDateTimeValue(state.observationDate || new Date());
      setJupiterMoonsLiveMode(!state.observationDate);
      setJupiterMoonsPlaying(false);
      updateLocalizedDateTimeDisplay("jupiter-moons-datetime", "jupiter-moons-datetime-display");
      updateJupiterMoonsSheet();
    };
    const closeJupiterMoonsDialog = () => {
      if (jupiterMoonsDialog) jupiterMoonsDialog.hidden = true;
      setJupiterMoonsPlaying(false);
      setJupiterMoonsLiveMode(false);
    };
    on("jupiter-moons-close", "click", closeJupiterMoonsDialog);
    on("jupiter-moons-dialog", "click", event => { if (event.target?.matches?.("[data-close-jupiter-moons]")) closeJupiterMoonsDialog(); });
    on("jupiter-moons-datetime", "input", () => {
      setJupiterMoonsLiveMode(false);
      setJupiterMoonsPlaying(false);
      updateJupiterMoonsSheet();
    });
    on("jupiter-moons-now", "click", () => {
      if (jupiterMoonsDateInput) jupiterMoonsDateInput.value = toLocalDateTimeValue(new Date());
      setJupiterMoonsPlaying(false);
      setJupiterMoonsLiveMode(true);
      updateLocalizedDateTimeDisplay("jupiter-moons-datetime", "jupiter-moons-datetime-display");
      updateJupiterMoonsSheet();
    });
    on("jupiter-moons-play", "click", () => {
      setJupiterMoonsLiveMode(false);
      setJupiterMoonsPlaying(!jupiterMoonsPlaying);
    });
    on("jupiter-moons-speed", "change", () => { if (jupiterMoonsPlaying) jupiterMoonsLastTick = Date.now(); });
    window.setInterval(() => {
      if (!jupiterMoonsDialog || jupiterMoonsDialog.hidden || !jupiterMoonsDateInput) return;
      if (jupiterMoonsLiveMode) {
        jupiterMoonsDateInput.value = toLocalDateTimeValue(new Date());
      } else if (jupiterMoonsPlaying) {
        const now = Date.now();
        const elapsed = Math.max(0, Math.min(5000, now - (jupiterMoonsLastTick || now)));
        const current = new Date(jupiterMoonsDateInput.value);
        if (Number.isFinite(current.getTime())) jupiterMoonsDateInput.value = toLocalDateTimeValue(new Date(current.getTime() + elapsed * (Number(jupiterMoonsSpeed?.value) || 3600)));
        jupiterMoonsLastTick = now;
      } else return;
      updateLocalizedDateTimeDisplay("jupiter-moons-datetime", "jupiter-moons-datetime-display");
      updateJupiterMoonsSheet();
    }, 1000);

    // Vue orbitale pédagogique du Système solaire : positions recalculées à la date
    // choisie, sélection des planètes et déplacement manuel sur leur orbite.
    const solarDialog = $("solar-system-dialog");
    const solarDateInput = $("solar-system-datetime");
    const solarSvg = $("solar-system-orbit-svg");
    const solarOrbits = $("solar-system-orbits");
    const solarPlanetsLayer = $("solar-system-planets");
    let solarReferenceDate = null;
    let solarHasManualDate = false;
    let solarLiveClock = true;
    const solarOrbitRadii = { mercury: 34, venus: 56, earth: 79, mars: 106, jupiter: 145, saturn: 184, uranus: 222, neptune: 260 };
    let solarSelectedId = "mercury";
    let solarDraggingId = null;
    let solarPlaying = false;
    let solarLastTick = 0;
    const solarNS = "http://www.w3.org/2000/svg";
    const solarMakeSvg = (tag, attrs = {}) => {
      const node = document.createElementNS(solarNS, tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
      return node;
    };
    const solarSetText = (id, value) => { const node = $(id); if (node) node.textContent = value; };
    const solarDateValue = () => solarDateInput?.value ? new Date(solarDateInput.value) : new Date();
    const solarFormatDate = date => {
      if (typeof updateLocalizedDateTimeDisplay === "function") updateLocalizedDateTimeDisplay("solar-system-datetime", "solar-system-datetime-display");
      else solarSetText("solar-system-datetime-display", date.toLocaleString(getLocale()));
    };
    const solarOrbitPoint = (planet, longitude) => {
      const radius = solarOrbitRadii[planet.id] || 80;
      const angle = longitude * Math.PI / 180;
      return { x: 360 + radius * Math.cos(angle), y: 260 - radius * Math.sin(angle) };
    };
    const solarPointerLongitude = event => {
      const matrix = solarSvg?.getScreenCTM();
      if (!matrix || !solarSvg) return null;
      const point = solarSvg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
      const local = point.matrixTransform(matrix.inverse());
      return ((Math.atan2(-(local.y - 260), local.x - 360) * 180 / Math.PI) % 360 + 360) % 360;
    };
    const solarAngleDifference = (a, b) => ((a - b + 540) % 360 + 360) % 360 - 180;
    // Convertir un déplacement manuel en une date simulée proche de la date de référence.
    // Ainsi, les huit planètes restent cohérentes entre elles au lieu de déplacer un seul point.
    const solarDateForLongitude = (planetId, targetLongitude) => {
      const planet = SOLAR_PLANETS.find(item => item.id === planetId);
      if (!planet) return solarDateValue();
      const reference = solarReferenceDate instanceof Date && Number.isFinite(solarReferenceDate.getTime()) ? solarReferenceDate : solarDateValue();
      const halfPeriodMs = planet.period * 86400000 / 2;
      const steps = 360;
      const stepMs = (halfPeriodMs * 2) / steps;
      let bestTime = reference.getTime();
      let bestError = Infinity;
      for (let i = 0; i <= steps; i++) {
        const time = reference.getTime() - halfPeriodMs + i * stepMs;
        const position = calculateSolarOrbitPosition(planetId, new Date(time));
        if (!position) continue;
        const error = Math.abs(solarAngleDifference(position.longitude, targetLongitude));
        if (error < bestError) { bestError = error; bestTime = time; }
      }
      let left = bestTime - stepMs;
      let right = bestTime + stepMs;
      const errorAt = time => {
        const position = calculateSolarOrbitPosition(planetId, new Date(time));
        return position ? Math.abs(solarAngleDifference(position.longitude, targetLongitude)) : 180;
      };
      for (let i = 0; i < 28; i++) {
        const m1 = left + (right - left) / 3;
        const m2 = right - (right - left) / 3;
        if (errorAt(m1) <= errorAt(m2)) right = m2; else left = m1;
      }
      return new Date((left + right) / 2);
    };
    const solarApplyManualLongitude = (planetId, longitude) => {
      const nextDate = solarDateForLongitude(planetId, longitude);
      if (!Number.isFinite(nextDate.getTime())) return;
      solarDateInput.value = toLocalDateTimeValue(nextDate);
      solarHasManualDate = true;
      solarLiveClock = false;
      renderSolarOrbits();
    };
    const renderSolarOrbits = () => {
      if (!solarOrbits || !solarPlanetsLayer || !solarDateInput) return;
      const date = solarDateValue();
      if (!Number.isFinite(date.getTime())) return;
      const positions = calculateSolarOrbitPositions(date);
      solarOrbits.replaceChildren(); solarPlanetsLayer.replaceChildren();
      for (const planet of positions) {
        const radius = solarOrbitRadii[planet.id];
        solarOrbits.append(solarMakeSvg("circle", { cx: 360, cy: 260, r: radius, fill: "none", stroke: planet.id === solarSelectedId ? "#7189a8" : "#3c506b", "stroke-width": planet.id === solarSelectedId ? 1.5 : 1, "stroke-dasharray": planet.id === "earth" ? "none" : "2 4", opacity: planet.id === solarSelectedId ? .95 : .72 }));
        const longitude = planet.longitude;
        const point = solarOrbitPoint(planet, longitude);
        const group = solarMakeSvg("g", { class: `solar-system-planet${planet.id === solarSelectedId ? " is-selected" : ""}`, tabindex: 0, role: "button", "aria-label": `${planet.name}${t("solarSystem.selectOrMove")}`, "data-planet-id": planet.id, transform: `translate(${point.x} ${point.y})` });
        group.append(solarMakeSvg("circle", { class: "solar-system-planet-hit", r: 15, fill: "transparent" }));
        if (planet.id === "saturn") group.append(solarMakeSvg("ellipse", { cx: 0, cy: 0, rx: 11, ry: 4.5, fill: "none", stroke: planet.color, "stroke-width": 2, transform: "rotate(-25)" }));
        group.append(solarMakeSvg("circle", { class: "solar-system-planet-disc", r: planet.id === "jupiter" ? 8 : planet.id === "saturn" ? 7 : planet.id === "earth" ? 6.5 : 5.5, fill: planet.color, stroke: planet.id === solarSelectedId ? "#ffffff" : "#152238", "stroke-width": planet.id === solarSelectedId ? 2 : 1 }));
        const labelAngle = ((longitude % 360) + 360) % 360;
        const labelY = Math.sin(labelAngle * Math.PI / 180) > .45 ? 20 : -12;
        const label = solarMakeSvg("text", { class: "solar-system-planet-label", x: 0, y: labelY, "text-anchor": "middle", "pointer-events": "none" }); label.textContent = planet.name;
        group.append(label);
        const selectPlanet = () => { solarSelectedId = planet.id; renderSolarOrbits(); updateSolarPlanetInfo(planet.id, calculateSolarOrbitPositions(solarDateValue())); };
        group.addEventListener("click", () => { if (!solarDraggingId) selectPlanet(); });
        group.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectPlanet(); } });
        group.addEventListener("pointerdown", event => {
          if (event.button !== undefined && event.button !== 0) return;
          event.preventDefault(); event.stopPropagation(); solarDraggingId = planet.id; solarSelectedId = planet.id;
          try { solarSvg.setPointerCapture(event.pointerId); } catch { /* capture facultative */ }
          const longitudeAtPointer = solarPointerLongitude(event); if (longitudeAtPointer !== null) solarApplyManualLongitude(planet.id, longitudeAtPointer);
        });
        solarPlanetsLayer.append(group);
      }
      updateSolarPlanetInfo(solarSelectedId, positions);
      solarFormatDate(date);
      solarSetText("solar-system-position-mode", solarHasManualDate ? t("solarSystem.manualSimulation") : t("solarSystem.calculatedPositions"));
    };
    const updateSolarPlanetInfo = (planetId, positions = calculateSolarOrbitPositions(solarDateValue())) => {
      const planet = positions.find(item => item.id === planetId) || getLocalizedSolarPlanet(SOLAR_PLANETS.find(item => item.id === planetId));
      if (!planet) return;
      solarSetText("solar-system-planet-name", planet.name);
      solarSetText("solar-system-planet-fact", planet.fact);
      const currentDistanceAU = Number.isFinite(planet.radiusAU) ? planet.radiusAU : planet.a;
      solarSetText("solar-system-distance", `${currentDistanceAU.toLocaleString(getLocale(), { maximumFractionDigits: 3 })} ${t("solarSystem.unitAU")} · ${(currentDistanceAU * 149.5978707).toLocaleString(getLocale(), { maximumFractionDigits: 1 })} ${t("solarSystem.unitMillionKm")}`);
      solarSetText("solar-system-period", planet.period >= 365 ? `${(planet.period / 365.256).toLocaleString(getLocale(), { maximumFractionDigits: 2 })} ${t("solarSystem.unitYears")}` : `${planet.period.toLocaleString(getLocale(), { maximumFractionDigits: 1 })} ${t("solarSystem.unitDays")}`);
      solarSetText("solar-system-diameter", `${planet.diameter.toLocaleString(getLocale())} km`);
      solarSetText("solar-system-longitude", `${planet.longitude.toLocaleString(getLocale(), { maximumFractionDigits: 1 })}°`);
      solarSetText("solar-system-rotation", planet.rotation || "—");
      solarSetText("solar-system-temperature", planet.temperature || "—");
      solarSetText("solar-system-composition", planet.composition || "—");
      solarSetText("solar-system-moons", planet.moons || "—");
    };
    const setSolarPlaying = playing => {
      solarPlaying = Boolean(playing); solarLastTick = 0;
      const button = $("solar-system-play");
      if (button) { button.textContent = solarPlaying ? `Ⅱ ${t("ui.pause")}` : `▶ ${t("solarSystem.animate")}`; button.setAttribute("aria-pressed", String(solarPlaying)); }
      if (solarPlaying) { solarHasManualDate = false; solarLiveClock = false; }
      renderSolarOrbits();
    };
    const solarPlayButton = $("solar-system-play");
    document.addEventListener("localechange", () => {
      if (solarPlayButton) solarPlayButton.textContent = solarPlaying ? `Ⅱ ${t("ui.pause")}` : `▶ ${t("solarSystem.animate")}`;
      if (solarDialog && !solarDialog.hidden) renderSolarOrbits();
    });
    const closeSolarDialog = () => { if (solarDialog) solarDialog.hidden = true; setSolarPlaying(false); };
    const openSolarSystemDialog = () => {
      if (!solarDialog) return;
      solarDialog.hidden = false;
      if (solarDateInput && !solarDateInput.value) solarDateInput.value = toLocalDateTimeValue(new Date());
      solarReferenceDate = solarDateValue();
      solarHasManualDate = false;
      solarLiveClock = true;
      renderSolarOrbits();
    };
    on("solar-system-close", "click", closeSolarDialog);
    on("solar-system-dialog", "click", event => { if (event.target?.matches?.("[data-close-solar-system]")) closeSolarDialog(); });
    on("solar-system-datetime", "input", () => { solarReferenceDate = solarDateValue(); solarHasManualDate = false; solarLiveClock = false; renderSolarOrbits(); });
    on("solar-system-now", "click", () => { if (solarDateInput) solarDateInput.value = toLocalDateTimeValue(new Date()); solarReferenceDate = solarDateValue(); solarHasManualDate = false; solarLiveClock = true; setSolarPlaying(false); renderSolarOrbits(); });
    on("solar-system-reset", "click", () => { setSolarPlaying(false); if (solarReferenceDate && solarDateInput) solarDateInput.value = toLocalDateTimeValue(solarReferenceDate); solarHasManualDate = false; solarLiveClock = false; renderSolarOrbits(); });
    on("solar-system-play", "click", () => setSolarPlaying(!solarPlaying));
    solarSvg?.addEventListener("pointermove", event => {
      if (!solarDraggingId) return;
      const longitude = solarPointerLongitude(event); if (longitude === null) return;
      solarApplyManualLongitude(solarDraggingId, longitude);
    });
    const endSolarDrag = () => { solarDraggingId = null; };
    solarSvg?.addEventListener("pointerup", endSolarDrag);
    solarSvg?.addEventListener("pointercancel", endSolarDrag);
    window.setInterval(() => {
      if (!solarDialog || solarDialog.hidden || !solarDateInput) return;
      const now = Date.now();
      if (solarLastTick && now - solarLastTick < 950) return;
      solarLastTick = now;
      if (solarPlaying) {
        const date = solarDateValue(); if (!Number.isFinite(date.getTime())) return;
        const daysPerSecond = Math.max(1, Number($("solar-system-speed")?.value) || 1);
        date.setTime(date.getTime() + daysPerSecond * 86400000);
        solarDateInput.value = toLocalDateTimeValue(date); solarReferenceDate = date; solarHasManualDate = false; renderSolarOrbits();
      } else if (solarLiveClock) {
        // En mode « Maintenant », la date suit l'horloge réelle et les positions sont recalculées chaque seconde.
        const date = new Date();
        solarDateInput.value = toLocalDateTimeValue(date); solarReferenceDate = date; solarHasManualDate = false; renderSolarOrbits();
      }
    }, 200);

    // Voyage dans l’Univers : cinq niveaux de zoom schématiques, du Système solaire
    // aux grandes structures cosmiques. Le marqueur doré indique toujours notre emplacement.
    const universeDialog = $("universe-journey-dialog");
    const universeStage = $("universe-journey-stage");
    const universeRange = $("universe-zoom-range");
    const getUniverseLevels = () => [
      { title: t("universe.titleSolar"), pointer: t("universe.solarSystemPointer"), description: t("universe.descSolar"), note: t("universe.noteSolar") },
      { title: t("universe.titleNearbyStars"), pointer: t("universe.sunPointer"), description: t("universe.descNearby"), note: t("universe.noteNearby") },
      { title: t("universe.titleMilkyWay"), pointer: t("universe.milkyWayPointer"), description: t("universe.descMilkyWay"), note: t("universe.noteMilkyWay") },
      { title: t("universe.titleLocalGroup"), pointer: t("universe.localGroupPointer"), description: t("universe.descLocalGroup"), note: t("universe.noteLocalGroup") },
      { title: t("universe.titleCosmicWeb"), pointer: t("universe.cosmicWebPointer"), description: t("universe.descCosmicWeb"), note: t("universe.noteCosmicWeb") }
    ];
    let currentUniverseZoom = 0;
    const universeNS = "http://www.w3.org/2000/svg";
    const universeEl = (tag, attrs = {}, content = "") => `<${tag} ${Object.entries(attrs).map(([k,v]) => `${k}="${String(v).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;')}"`).join(' ')}>${content}</${tag}>`;
    const universeText = (x, y, label, cls = "") => universeEl("text", { x, y, class: cls }, label);
    const universeCircle = (x,y,r,fill,attrs={}) => universeEl("circle", {cx:x,cy:y,r,fill,...attrs});
    const universeMarker = (x,y,labelX,labelY,label) => `${universeEl("path",{d:`M ${x} ${y} L ${labelX-8} ${labelY-5}`,class:"leader"})}${universeCircle(x,y,6,"#ffd75b",{class:"sun-marker"})}${universeCircle(x,y,13,"none",{stroke:"#ffd75b","stroke-width":1.5,opacity:.8})}${universeText(labelX,labelY,label)}`;
    const universeScene = (level, includeBackground = true) => {
      let out = "";
      // Fond étoilé discret commun.
      if (includeBackground) for (let i=0;i<65;i++) { const x=(i*137+31)%880+10, y=(i*83+19)%470+15, r=[.7,1,1.3][i%3]; out += universeCircle(x,y,r,i%5===0?"#b8d6ff":"#7e9fc9",{opacity:.25+(i%4)*.12}); }
      if (level === 0) {
        const cx=450, cy=250;
        [40,72,106,145,185,225].forEach((r,i)=>out+=universeEl("circle",{cx,cy,r,fill:"none",stroke:"#415777","stroke-width":1,"stroke-dasharray":i%2?"3 4":"none",opacity:.8}));
        out+=universeCircle(cx,cy,14,"#ffca55",{stroke:"#fff0ad","stroke-width":2});
        [[490,242,t("names.planet.mercury")],[515,218,t("names.planet.venus")],[548,272,t("names.planet.earth")],[591,227,t("names.planet.mars")],[635,303,t("names.planet.jupiter")],[390,65,t("names.planet.saturn")],[270,360,t("names.planet.uranus")],[234,143,t("names.planet.neptune")]].forEach((p,i)=>{out+=universeCircle(p[0],p[1],i===4?6:4,["#aaa9a5","#d5b18a","#64b7e7","#c76e50","#d5b68c","#d9c6a0","#83d7dc","#5e8be0"][i]); out+=universeText(p[0]+8,p[1]-7,p[2],"minor-label");});
        out+=universeMarker(450,250,474,390,t("ui.sun"));
      } else if (level === 1) {
        const ly = value => `${value.toLocaleString(getLocale(), { maximumFractionDigits: 2 })} ${t("universe.unitLyShort")}`;
        const stars=[[180,155,t("names.object.proxima-centauri"),ly(4.24)],[270,310,t("names.object.alpha-centauri-ab"),ly(4.37)],[620,120,t("names.object.barnards-star"),ly(5.96)],[690,340,t("names.star.sirius"),ly(8.6)],[435,75,t("names.object.wolf-359"),ly(7.9)],[510,385,t("names.object.lalande-21185"),ly(8.3)],[350,220,t("ui.sun"),""]];
        for(const [x,y,n,d] of stars){out+=universeCircle(x,y,n===t("ui.sun")?8:4,n===t("ui.sun")?"#ffd75b":"#b8d6ff",n===t("ui.sun")?{stroke:"#fff0ad","stroke-width":2}:{});out+=universeText(x+10,y-8,n,"minor-label");}
        out+=universeMarker(350,220,375,275,t("universe.titleSolar"));
      } else if (level === 2) {
        // Voie lactée plus lisible : halo diffus, noyau lumineux, bras spiraux texturés et poussières.
        const cx=455,cy=255;
        out+=universeEl("ellipse",{cx,cy,rx:390,ry:235,fill:"url(#galaxy-halo)",opacity:.8});
        out+=universeEl("defs",{},universeEl("radialGradient",{id:"galaxy-halo",cx:"50%",cy:"50%",r:"50%"},universeEl("stop",{offset:"0%","stop-color":"#f7d6a0","stop-opacity":".32"})+universeEl("stop",{offset:"42%","stop-color":"#9d8bdb","stop-opacity":".16"})+universeEl("stop",{offset:"100%","stop-color":"#15233f","stop-opacity":"0"}))+universeEl("radialGradient",{id:"galaxy-core",cx:"50%",cy:"50%",r:"50%"},universeEl("stop",{offset:"0%","stop-color":"#fff4ce","stop-opacity":"1"})+universeEl("stop",{offset:"38%","stop-color":"#f8c77c","stop-opacity":".75"})+universeEl("stop",{offset:"100%","stop-color":"#dc9b65","stop-opacity":"0"})))
        for(let arm=0;arm<4;arm++){
          let pts=[];for(let t=.18;t<5.65;t+=.055){const a=t+arm*Math.PI/2,r=12+t*31;pts.push(`${(cx+Math.cos(a)*r).toFixed(1)},${(cy+Math.sin(a)*r*.61).toFixed(1)}`);}
          out+=universeEl("polyline",{points:pts.join(" "),fill:"none",stroke:["#719ee8","#c49be9","#6cc7d1","#b4b9ff"][arm],"stroke-width":25,"stroke-linecap":"round",opacity:.14});
          out+=universeEl("polyline",{points:pts.join(" "),fill:"none",stroke:["#7bb6f6","#d4b0f3","#81d9df","#c4c9ff"][arm],"stroke-width":11,"stroke-linecap":"round",opacity:.24});
          out+=universeEl("polyline",{points:pts.join(" "),fill:"none",stroke:["#c6e1ff","#f0d5ff","#c3f6f3","#e3e5ff"][arm],"stroke-width":2.2,"stroke-linecap":"round",opacity:.7});
          for(let j=0;j<38;j++){const t=.35+j*.135,a=t+arm*Math.PI/2,r=12+t*31+(j%3-1)*8,x=cx+Math.cos(a)*r,y=cy+Math.sin(a)*r*.61;if(x>20&&x<880&&y>20&&y<480)out+=universeCircle(x,y,j%7===0?2.1:1.15,j%4===0?"#fff0d0":"#c9e2ff",{opacity:.35+(j%4)*.13});}
        }
        // Bande sombre de poussières qui traverse le disque et rend la galaxie moins abstraite.
        out+=universeEl("path",{d:"M 100 365 Q 270 290 430 260 T 810 125",fill:"none",stroke:"#080d1b","stroke-width":13,opacity:.38,"stroke-linecap":"round"});
        out+=universeEl("ellipse",{cx,cy,rx:70,ry:48,fill:"url(#galaxy-core)",opacity:.95});
        out+=universeCircle(cx,cy,13,"#ffe6a4",{opacity:.95});out+=universeText(cx-105,cy-30,t("universe.galacticCenter"));
        // Le Soleil est placé dans le bras local, à distance du noyau.
        out+=universeCircle(572,224,5,"#ffd75b",{class:"sun-marker",stroke:"#fff2b8","stroke-width":2});out+=universeMarker(572,224,610,198,t("ui.sun"));
      } else if (level === 3) {
        out+=universeEl("ellipse",{cx:350,cy:260,rx:150,ry:95,fill:"#5c8fc2",opacity:.08,stroke:"#6c9fda","stroke-width":1.5,"stroke-dasharray":"5 5"});
        out+=universeEl("ellipse",{cx:350,cy:260,rx:100,ry:57,fill:"none",stroke:"#426a98","stroke-width":1,opacity:.7});
        const drawMiniSpiral = (gx,gy,rx,ry,tilt,accent,name) => {
          let g = universeEl("ellipse",{cx:gx,cy:gy,rx:rx*1.5,ry:ry*1.5,fill:accent,opacity:.08,transform:`rotate(${tilt} ${gx} ${gy})`});
          g += universeEl("ellipse",{cx:gx,cy:gy,rx,ry,fill:"none",stroke:accent,"stroke-width":2.4,opacity:.75,transform:`rotate(${tilt} ${gx} ${gy})`});
          for(let arm=0;arm<3;arm++){let pts=[];for(let t=.3;t<5.8;t+=.12){const a=t+arm*Math.PI*2/3,r=2+t*rx/5.8;pts.push(`${(gx+Math.cos(a)*r).toFixed(1)},${(gy+Math.sin(a)*r*.62).toFixed(1)}`);}g+=universeEl("polyline",{points:pts.join(" "),fill:"none",stroke:accent,"stroke-width":Math.max(1.2,rx*.055),"stroke-linecap":"round",opacity:.7});}
          g+=universeCircle(gx,gy,Math.max(4,rx*.16),"#fff0cf",{opacity:.9});g+=universeText(gx,gy+ry+18,name,"minor-label");return g;
        };
        out+=drawMiniSpiral(300,260,38,24,-18,"#82c8ff",t("universeJourney.level2"));
        out+=drawMiniSpiral(590,235,47,28,32,"#d1a7ff",t("names.constellation.andromeda"));
        out+=drawMiniSpiral(530,360,15,10,-10,"#9acde8",t("universe.triangleGalaxy"));
        for(let i=0;i<24;i++){let x=210+(i*71)%430,y=140+(i*47)%230;out+=universeCircle(x,y,1.8,"#b5cce8",{opacity:.5});}
        out+=universeMarker(315,247,350,200,t("universe.titleSolar"));
      } else {
        // Toile cosmique didactique : réseau aéré, grands vides, nombreux amas distincts.
        // Les courbes représentent les filaments ; les amas sont des nœuds lumineux plus larges.
        const nodes = [
          [90,105,1.0],[235,72,1.15],[390,112,1.0],[565,65,1.2],[785,115,1.05],[850,245,.8],
          [125,285,1.2],[285,225,.85],[435,285,1.25],[610,225,1.0],[760,355,1.2],
          [75,425,.8],[250,405,1.0],[430,440,.9],[590,405,1.15],[840,445,.9],
          [330,155,.65],[685,145,.7],[185,175,.65],[510,355,.75],[705,285,.7]
        ];
        const edges = [[0,1],[1,2],[2,3],[3,4],[4,5],[0,6],[6,7],[7,2],[7,8],[8,9],[9,4],[9,10],[6,11],[11,12],[12,13],[13,14],[14,10],[10,15],[1,18],[18,7],[2,16],[16,7],[3,17],[17,9],[8,19],[19,14],[9,20],[20,10],[12,8],[8,13],[3,9]];
        // Vides clairement identifiés entre les filaments, sans grille géométrique uniforme.
        [[350,220,88,62],[675,300,63,48],[170,340,46,38]].forEach(([cx,cy,rx,ry])=>{
          out+=universeEl("ellipse",{cx,cy,rx,ry,fill:"#020713",stroke:"#263c59","stroke-width":1.4,"stroke-dasharray":"4 7",opacity:.98});
        });
        for(const [a,b] of edges){
          const A=nodes[a],B=nodes[b], mx=(A[0]+B[0])/2, my=(A[1]+B[1])/2;
          const bend=((a+b)%2?1:-1)*Math.min(34,Math.hypot(B[0]-A[0],B[1]-A[1])*.12);
          const d=`M ${A[0]} ${A[1]} Q ${mx+bend} ${my-bend} ${B[0]} ${B[1]}`;
          out+=universeEl("path",{d,fill:"none",stroke:"#3e7fba","stroke-width":13,opacity:.10,"stroke-linecap":"round"});
          out+=universeEl("path",{d,fill:"none",stroke:"#77c5ff","stroke-width":2.1,opacity:.62,"stroke-linecap":"round"});
          out+=universeEl("path",{d,fill:"none",stroke:"#d1eaff","stroke-width":.7,opacity:.36,"stroke-linecap":"round"});
        }
        nodes.forEach(([x,y,scale],i)=>{
          const r=(i%3===0?11:7)*scale;
          out+=universeCircle(x,y,r*2.2,"#6c8fdb",{opacity:.10});
          out+=universeCircle(x,y,r,"#9c8ce9",{opacity:.36});
          out+=universeCircle(x,y,r*.56,i%4===0?"#f2c8ff":"#c9e7ff",{opacity:.96});
          out+=universeCircle(x,y,r*.23,"#fff4d6",{opacity:1});
          for(let j=0;j<9;j++){
            const a=j*Math.PI*2/9+i*.31, rr=r*(1.25+(j%3)*.25);
            out+=universeCircle(x+Math.cos(a)*rr,y+Math.sin(a)*rr*.75,.8+(j%2)*.35,"#d5e7ff",{opacity:.6});
          }
        });
        // Notre région est indiquée dans un petit amas distinct, sans suggérer que le Soleil est visible à cette échelle.
        out+=universeCircle(435,285,5,"#ffd75b",{class:"sun-marker",stroke:"#fff2b8","stroke-width":1.5});
        out+=universeEl("path",{d:"M 435 285 L 465 260 L 535 260",class:"leader"});
        out+=universeText(470,250,t("universe.localGroup"),"our-place-label");
      }
      return out;
    };
    const renderUniverseJourney = level => {
      const zoom = Math.max(0,Math.min(4,Number(level)||0));
      currentUniverseZoom = zoom;
      const index = Math.round(zoom);
      if (universeRange) universeRange.value = zoom.toFixed(2);
      // Une seule scène SVG persistante : le curseur déplace uniquement la caméra.
      // Les éléments sont imbriqués dans le même espace ; aucun fondu entre des images.
      if (universeStage) {
        const solarLayer = universeEl("g", { id: "universe-layer-solar", transform: "translate(513.5 191.5) scale(.13)" }, universeScene(0, false));
        const nearbyLayer = universeEl("g", { id: "universe-layer-nearby", transform: "translate(467 158) scale(.30)" }, universeScene(1, false));
        const galaxyLayer = universeEl("g", { id: "universe-layer-galaxy" }, universeScene(2, false));
        const groupLayer = universeEl("g", { id: "universe-layer-group", transform: "translate(-1125 -625) scale(3.5)" }, universeScene(3, false));
        const webLayer = universeEl("g", { id: "universe-layer-web", transform: "translate(-4050 -2250) scale(10)" }, universeScene(4, false));
        const masterScene = solarLayer + nearbyLayer + galaxyLayer + groupLayer + webLayer;
        // zoom 0 : système solaire ; 1 : voisinage stellaire ; 2 : galaxie ;
        // 3 : Groupe local ; 4 : toile cosmique. Interpolation logarithmique fluide.
        const cameraZoom = Math.exp(Math.log(8) + (Math.log(.1) - Math.log(8)) * (zoom / 4));
        if (!universeStage.querySelector("#universe-camera")) {
          universeStage.innerHTML = `${universeEl("defs", {}, universeEl("clipPath", { id: "universe-viewport-clip" }, universeEl("rect", { x:0,y:0,width:900,height:500 })))}` +
            universeEl("g", { "clip-path": "url(#universe-viewport-clip)" },
              universeEl("g", { id: "universe-camera", transform: `translate(450 250) scale(${cameraZoom.toFixed(4)}) translate(-572 -224)` },
                universeEl("rect", {x:-6000,y:-6000,width:13000,height:13000,fill:"#050b17"}) +
                (() => { let stars=""; for(let i=0;i<320;i++){const x=(i*137+31)%12000-5500,y=(i*83+19)%12000-5500;stars+=universeCircle(x,y,[.7,1,1.3][i%3],i%5===0?"#b8d6ff":"#7e9fc9",{opacity:.25+(i%4)*.12});} return stars; })() + masterScene
              )
            );
        } else {
          universeStage.querySelector("#universe-camera").setAttribute("transform", `translate(450 250) scale(${cameraZoom.toFixed(4)}) translate(-572 -224)`);
        }
      }
      // Les objets apparaissent uniquement lorsque l’échelle les rend pertinents.
      // Ils partagent une scène et une caméra uniques : on ne fond jamais entre des images.
      // Les courtes transitions d’opacité évitent une apparition brutale au seuil du zoom.
      const ramp = (value, start, end) => {
        const t = Math.max(0, Math.min(1, (value - start) / (end - start)));
        return t * t * (3 - 2 * t);
      };
      const visibility = {
        "universe-layer-solar": 1 - ramp(zoom, 0.58, 1.02),
        "universe-layer-nearby": ramp(zoom, 0.48, 0.88) * (1 - ramp(zoom, 1.38, 1.78)),
        "universe-layer-galaxy": ramp(zoom, 1.30, 1.72) * (1 - ramp(zoom, 2.42, 2.82)),
        "universe-layer-group": ramp(zoom, 2.32, 2.72) * (1 - ramp(zoom, 3.40, 3.78)),
        "universe-layer-web": ramp(zoom, 3.28, 3.72)
      };
      for (const [id, opacity] of Object.entries(visibility)) {
        const layer = universeStage?.querySelector(`#${id}`);
        if (layer) {
          layer.setAttribute("opacity", opacity.toFixed(3));
          layer.setAttribute("visibility", opacity < 0.015 ? "hidden" : "visible");
          layer.setAttribute("pointer-events", "none");
        }
      }
      const info = getUniverseLevels()[index];
      const fmt = value => new Intl.NumberFormat(getLocale(), { maximumSignificantDigits: 3 }).format(value);
      const approx = (value, unit) => `≈ ${fmt(value)} ${unit}`;
      const distanceReferences = [
        { scale: t("universe.scaleSolar"), km: approx(1.496e10, t("universe.unitKm")), million: approx(14960, t("universe.unitMillionKm")), billion: approx(14.96, t("universe.unitBillionKm")), ly: approx(0.00158, t("universe.unitLightYears")) },
        { scale: `${t("universe.titleNearbyStars")} · ${t("names.object.proxima-centauri")}`, km: approx(4.01e13, t("universe.unitKm")), million: approx(4.01e7, t("universe.unitMillionKm")), billion: approx(40100, t("universe.unitBillionKm")), ly: approx(4.24, t("universe.unitLightYears")) },
        { scale: t("universe.scaleMilkyWay"), km: approx(9.46e17, t("universe.unitKm")), million: approx(9.46e11, t("universe.unitMillionKm")), billion: approx(9.46e8, t("universe.unitBillionKm")), ly: approx(100000, t("universe.unitLightYears")) },
        { scale: t("universe.scaleLocalGroup"), km: approx(2.37e19, t("universe.unitKm")), million: approx(2.37e13, t("universe.unitMillionKm")), billion: approx(2.37e10, t("universe.unitBillionKm")), ly: approx(2.5e6, t("universe.unitLightYears")) },
        { scale: t("universe.scaleObservable"), km: approx(8.8e23, t("universe.unitKm")), million: approx(8.8e17, t("universe.unitMillionKm")), billion: approx(8.8e14, t("universe.unitBillionKm")), ly: approx(93e9, t("universe.unitLightYears")) }
      ];
      const distance = distanceReferences[index];
      const setText = (id, value) => { const node = $(id); if (node) node.textContent = value; };
      setText("universe-distance-scale", distance.scale); setText("universe-distance-km", distance.km); setText("universe-distance-million", distance.million); setText("universe-distance-billion", distance.billion); setText("universe-distance-ly", distance.ly);
      const title = $("universe-journey-level-title"), desc = $("universe-journey-level-description"), note = $("universe-journey-distance-note"), pointer = $("universe-journey-pointer");
      if(title)title.textContent=info.title;if(desc)desc.textContent=info.description;if(note)note.textContent=info.note;if(pointer){pointer.textContent="";pointer.hidden=true;}
      document.querySelectorAll("[data-universe-level]").forEach(button=>{const active=Number(button.dataset.universeLevel)===index;button.classList.toggle("is-active",active);button.setAttribute("aria-pressed",String(active));});
      $("universe-zoom-out")?.toggleAttribute("disabled",zoom>=4);$("universe-zoom-in")?.toggleAttribute("disabled",zoom<=0);
    };
    const openUniverseJourneyDialog = () => { if(!universeDialog)return; universeDialog.hidden=false; renderUniverseJourney(0); };
    const closeUniverseJourneyDialog = () => { if(universeDialog)universeDialog.hidden=true; };
    on("universe-journey-close","click",closeUniverseJourneyDialog);
    on("universe-journey-dialog","click",event=>{if(event.target?.matches?.("[data-close-universe-journey]"))closeUniverseJourneyDialog();});
    on("universe-zoom-in","click",()=>renderUniverseJourney((Number(universeRange?.value)||0)-0.25));
    on("universe-zoom-out","click",()=>renderUniverseJourney((Number(universeRange?.value)||0)+0.25));
    on("universe-journey-home","click",()=>renderUniverseJourney(0));
    on("universe-zoom-range","input",event=>renderUniverseJourney(event.target.value));
    document.querySelectorAll("[data-universe-level]").forEach(button=>button.addEventListener("click",()=>renderUniverseJourney(button.dataset.universeLevel)));
    document.addEventListener("localechange", () => {
      if (universeDialog && !universeDialog.hidden) {
        universeStage?.replaceChildren();
        renderUniverseJourney(currentUniverseZoom);
      }
    });

    on("events-open", "click", () => { const dialog = $("events-dialog"); if (dialog) dialog.hidden = false; renderCelestialEvents(); });
    const closeEvents = () => { const dialog = $("events-dialog"); if (dialog) dialog.hidden = true; };
    on("events-close", "click", closeEvents);
    on("events-dialog", "click", event => { if (event.target?.matches?.("[data-close-events]")) closeEvents(); });
    document.addEventListener("keydown", event => { if (event.key === "Escape") { closeConditions(); closeEvents(); closeMoonSheet(); closeSolarDialog(); closeStarHop(); closeSession(); closeLocationDialog(); } });

    on("visible-now-open", "click", openVisibleNow);
    on("visible-now-close", "click", closeVisibleNow);
    on("visible-now-dialog", "click", event => {
      if (event.target?.matches?.("[data-close-visible-now]")) closeVisibleNow();
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && $("visible-now-dialog") && !$("visible-now-dialog").hidden) closeVisibleNow();
    });

    // Carte et fiche de l'objet.
    on(
      ["close-card", "object-close", "close-object-card"],
      "click",
      closeObjectCard
    );

    on(
      ["guide-selected", "object-find"],
      "click",
      () => {
        finderReturnTo = "object-card";
        openFinder();
      }
    );

    // Constallations.
    on(
      ["constellations-btn", "constellations-toggle", "show-constellations"],
      "click",
      toggleConstellations
    );

    on(["constellation-boundaries-btn"], "click", toggleConstellationBoundaries);

    const displaySettings = $("display-settings");
    const displaySettingsOpen = $("display-settings-open");
    const mapSettingsOpen = $("map-settings-open");
    const settingsOpenButtons = [displaySettingsOpen, mapSettingsOpen].filter(Boolean);
    const mapCategoryInputs = {
      stars: "setting-stars",
      planets: "setting-planets",
      sun: "setting-sun",
      moon: "setting-moon",
      messier: "setting-messier",
      ngc: "setting-ngc",
      minorPlanets: "setting-minor-planets",
      dwarfPlanets: "setting-dwarf-planets"
    };
    const syncSettingsButtons = () => {
      settingsOpenButtons.forEach(button => button.setAttribute("aria-expanded", String(Boolean(displaySettings && !displaySettings.hidden))));
    };
    const closeDisplaySettings = () => {
      if (displaySettings) displaySettings.hidden = true;
      syncSettingsButtons();
    };
    const openOrToggleDisplaySettings = () => {
      if (!displaySettings) return;
      displaySettings.hidden = !displaySettings.hidden;
      syncSettingsButtons();
      const constellations = $("setting-constellations");
      const boundaries = $("setting-constellation-boundaries");
      const labels = $("setting-star-labels");
      const eclipticGrid = $("setting-ecliptic-grid");
      if (constellations) constellations.checked = Boolean(state.showConstellations);
      if (boundaries) boundaries.checked = Boolean(state.showConstellationBoundaries);
      if (labels) labels.checked = state.showStarLabels !== false;
      if (eclipticGrid) eclipticGrid.checked = Boolean(state.showEclipticGrid);
      for (const [key, id] of Object.entries(mapCategoryInputs)) {
        const input = $(id);
        if (input) input.checked = state.displayCategories?.[key] !== false;
      }
    };
    on(["display-settings-open", "map-settings-open"], "click", openOrToggleDisplaySettings);
    on("display-settings-close", "click", closeDisplaySettings);
    on("setting-constellations", "change", () => {
      const input = $("setting-constellations");
      state.showConstellations = Boolean(input && input.checked);
      safely(t("ui.constellationDisplay"), () => drawSky());
    });
    on("setting-constellation-boundaries", "change", () => {
      toggleConstellationBoundaries();
    });
    on("setting-star-labels", "change", () => {
      const input = $("setting-star-labels");
      state.showStarLabels = Boolean(input && input.checked);
      safely(t("ui.displayStarNames"), () => drawSky());
    });
    on("setting-ecliptic-grid", "change", () => {
      const input = $("setting-ecliptic-grid");
      state.showEclipticGrid = Boolean(input && input.checked);
      try { localStorage.setItem("atlas-celeste-ecliptic-grid", String(state.showEclipticGrid)); }
      catch { /* Le réglage reste utilisable sans stockage local. */ }
      safely(t("ui.displayEclipticGrid"), () => drawSky());
    });
    for (const [key, id] of Object.entries(mapCategoryInputs)) {
      on(id, "change", () => {
        const input = $(id);
        if (!state.displayCategories) state.displayCategories = { stars: true, planets: true, sun: true, moon: true, messier: true, ngc: true, minorPlanets: true, dwarfPlanets: true };
        state.displayCategories[key] = Boolean(input && input.checked);
        try { localStorage.setItem("atlas-celeste-display-categories", JSON.stringify(state.displayCategories)); }
        catch { /* Les préférences de rendu restent utilisables sans stockage local. */ }
        safely(t("ui.displayedObjectSettings"), () => drawSky());
      });
    }

    const nightButton = $("night-vision-btn");
    on("night-vision-btn", "click", () => {
      const app = $("app");
      if (!app || !nightButton) return;
      const active = !app.classList.contains("night-vision");
      app.classList.toggle("night-vision", active);
      nightButton.setAttribute("aria-pressed", String(active));
      nightButton.setAttribute("aria-label", active ? t("ui.disableRedNightVision") : t("ui.activateRedNightVision"));
      nightButton.setAttribute("title", active ? t("ui.disableRedNightVision") : t("ui.activateRedNightVision"));
      const theme = document.querySelector('meta[name="theme-color"]');
      if (theme) theme.setAttribute("content", active ? "#180000" : "#050914");
    });

    on("zoom-in", "click", () => applyZoomFactor(0.8));
    on("zoom-out", "click", () => applyZoomFactor(1.25));
    on("zoom-reset", "click", resetZoom);
    const reviewToggle = on("review-stars-toggle", "click", () => {
      state.reviewStarsOnly = !state.reviewStarsOnly;
      reviewToggle?.setAttribute("aria-pressed", String(state.reviewStarsOnly));
      reviewToggle?.classList.toggle("is-active", state.reviewStarsOnly);
      if (typeof drawSky === "function") drawSky();
      showToast(state.reviewStarsOnly
        ? t("ui.activeFilterOnlyStarsToVerify")
        : t("ui.filterDeactivatedAllStarsDisplayed"));
    });
    if (reviewToggle) {
      const count = state.stars.filter(star => star.gaia_astrometry_status === "needs_review").length;
      const countElement = $("review-stars-count");
      if (countElement) countElement.textContent = String(count);
      reviewToggle.setAttribute("aria-pressed", String(Boolean(state.reviewStarsOnly)));
    }
    syncZoomControls();

    bindImmersiveExit();
    bindCanvas();

    // Empêche les contrôles de transmettre leurs gestes au canvas.
    document.querySelectorAll(
      "button, input, select, textarea"
    ).forEach(element => {
      element.addEventListener("pointerdown", event => {
        event.stopPropagation();
      });
    });

    refreshClock();
    refreshLocationLabel();
    refreshReadout();
    syncSensorButton();

    console.info(t("ui.interfaceButtonsInitialized"));
  }

  function refreshLocale() {
    refreshClock();
    refreshLocationLabel();
    refreshReadout();
    syncSensorButton();
    refreshVisibleNow();
    refreshSkyWalkAvailability();
    refreshLocalePanels();
    if ($("object-card") && !$("object-card").hidden && state.selected) updateObjectCard(state.selected);
  }

  document.addEventListener("localechange", refreshLocale);

  function updateUI() {
    refreshClock();
    refreshLocationLabel();
    refreshReadout();
  }

  return {
    showToast,
    bindControls,
    collapseDiscoveryMenuForGuidance: () => collapseDiscoveryPanelAfterGuideStart(),
    updateClock: refreshClock,
    updateLocationLabel: refreshLocationLabel,
    updateReadout: refreshReadout,
    updateObjectCard,
    refreshVisibleNow,
    closeObjectCard,
    toggleConstellations,
    updateUI
  };
}
