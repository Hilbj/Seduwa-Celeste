"use strict";

/* ==========================================================
   i18n.js — Internationalisation de SEDUWA Céleste (Phase 1)
   ----------------------------------------------------------
   Module autonome, sans dépendance :
   - charge i18n/<locale>.json avec repli systématique sur fr.json
   - détecte la locale : localStorage > navigator.language > "fr"
   - t(clé, params) avec interpolation {nom}
   - applique les attributs data-i18n / data-i18n-title / data-i18n-aria
   - setLocale() change la langue à la volée et émet "localechange"
   ========================================================== */

const I18N_STORAGE_KEY = "atlas-celeste-locale";
const SUPPORTED_LOCALES = ["fr", "en"];
const DEFAULT_LOCALE = "fr";

let currentLocale = DEFAULT_LOCALE;
let translations = {};
let fallbackTranslations = {};
let ready = false;

/* Résout une clé en notation pointée : "app.title" -> obj.app.title */
function resolve(obj, path) {
  return path.split(".").reduce(
    (acc, part) => (acc && acc[part] !== undefined ? acc[part] : undefined),
    obj
  );
}

function detectLocale() {
  try {
    const saved = localStorage.getItem(I18N_STORAGE_KEY);
    if (saved && SUPPORTED_LOCALES.includes(saved)) return saved;
  } catch { /* stockage indisponible */ }
  const nav = (navigator.language || DEFAULT_LOCALE).slice(0, 2).toLowerCase();
  return SUPPORTED_LOCALES.includes(nav) ? nav : DEFAULT_LOCALE;
}

async function fetchLocale(locale) {
  const response = await fetch(`./i18n/${locale}.json`);
  if (!response.ok) throw new Error(`i18n/${locale}.json : ${response.status}`);
  return response.json();
}

/* Traduction avec interpolation : t("summary.count", { n: 42 }) */
function t(key, params = {}) {
  if (!ready) return key;
  let str = resolve(translations, key);
  if (str === undefined) str = resolve(fallbackTranslations, key);
  if (str === undefined) return key;
  if (params && typeof str === "string") {
    str = str.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? `{${name}}`);
  }
  return str;
}

function applyTranslations(root = document) {
  root.querySelectorAll("[data-i18n]").forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll("[data-i18n-title]").forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
  root.querySelectorAll("[data-i18n-aria]").forEach(el => {
    el.setAttribute("aria-label", t(el.dataset.i18nAria));
  });
}

async function loadLocaleInto(locale) {
  const target = await fetchLocale(locale);
  translations = target;
  fallbackTranslations = locale === DEFAULT_LOCALE
    ? target
    : await fetchLocale(DEFAULT_LOCALE);
  currentLocale = locale;
  ready = true;
  document.documentElement.lang = locale;
}

/* À appeler une seule fois au démarrage de l'application. */
async function initI18n() {
  try {
    await loadLocaleInto(detectLocale());
    applyTranslations();
  } catch (error) {
    console.warn("i18n : repli sur les textes du HTML.", error);
  }
}

/* Changement de langue à la volée (persisté, puis re-appliqué). */
async function setLocale(locale) {
  if (!SUPPORTED_LOCALES.includes(locale) || locale === currentLocale) return;
  try {
    await loadLocaleInto(locale);
    try { localStorage.setItem(I18N_STORAGE_KEY, locale); } catch { /* non bloquant */ }
    applyTranslations();
    document.dispatchEvent(new CustomEvent("localechange", { detail: { locale } }));
  } catch (error) {
    console.warn("i18n : changement de langue impossible.", error);
  }
}

function getLocale() { return currentLocale; }
function getSupportedLocales() { return [...SUPPORTED_LOCALES]; }

export { initI18n, t, setLocale, getLocale, getSupportedLocales, applyTranslations };
