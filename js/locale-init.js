"use strict";

import { initI18n, getLocale, setLocale } from "./i18n.js";

// Aligne l'attribut lang des sélecteurs de date/heure natifs sur la langue active.
// Sans cela, le widget du navigateur resterait en français malgré la traduction.
function syncNativeDateTimeLang() {
  const locale = getLocale();
  document.querySelectorAll('input[type="datetime-local"]').forEach(input => {
    input.lang = locale;
  });
}

function bindLocaleSelect() {
  const localeSelect = document.getElementById("locale-select");
  if (!localeSelect) return;

  localeSelect.value = getLocale();

  localeSelect.addEventListener("change", () => {
    setLocale(localeSelect.value);
  });

  document.addEventListener("localechange", event => {
    localeSelect.value = event.detail.locale;
    syncNativeDateTimeLang();
  });
}

async function start() {
  await initI18n();
  syncNativeDateTimeLang();
  bindLocaleSelect();

  // Charger l’application seulement lorsque les dictionnaires sont prêts.
  // Ses dépendances (orbites, système solaire, etc.) évaluent certaines
  // traductions dès leur chargement.
  await import("../app.js");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
