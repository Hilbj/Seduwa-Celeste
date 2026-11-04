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
const BUILTIN_LOCALE_CONFIG = {
  defaultLocale: "fr",
  locales: [
    { code: "fr", label: "Français", dataLocale: "fr" },
    { code: "en", label: "English", dataLocale: "en" }
  ]
};
let localeConfig = BUILTIN_LOCALE_CONFIG;
let SUPPORTED_LOCALES = localeConfig.locales.map(item => item.code);
let DEFAULT_LOCALE = localeConfig.defaultLocale;

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

async function loadLocaleConfig() {
  try {
    const response = await fetch("./i18n/locales.json");
    if (!response.ok) throw new Error(`i18n/locales.json : ${response.status}`);
    const config = await response.json();
    const locales = Array.isArray(config.locales) ? config.locales : [];
    const valid = locales.filter(item =>
      item && typeof item.code === "string" && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(item.code) &&
      typeof item.label === "string" && item.label.trim() &&
      ["fr", "en"].includes(item.dataLocale)
    );
    const codes = valid.map(item => item.code);
    if (!codes.length || !codes.includes(config.defaultLocale) || new Set(codes).size !== codes.length) {
      throw new Error("Configuration des langues invalide.");
    }
    localeConfig = { defaultLocale: config.defaultLocale, locales: valid };
    SUPPORTED_LOCALES = codes;
    DEFAULT_LOCALE = config.defaultLocale;
  } catch (error) {
    console.warn("i18n : configuration des langues indisponible, configuration intégrée utilisée.", error);
    localeConfig = BUILTIN_LOCALE_CONFIG;
    SUPPORTED_LOCALES = localeConfig.locales.map(item => item.code);
    DEFAULT_LOCALE = localeConfig.defaultLocale;
  }
}

function getBrowserLocale() {
  const preferred = (typeof navigator !== "undefined" && navigator.language) || DEFAULT_LOCALE;
  const exact = SUPPORTED_LOCALES.find(code => code.toLowerCase() === preferred.toLowerCase());
  if (exact) return exact;
  const base = preferred.split("-")[0].toLowerCase();
  return SUPPORTED_LOCALES.find(code => code.toLowerCase() === base) || DEFAULT_LOCALE;
}

function detectLocale() {
  try {
    const saved = localStorage.getItem(I18N_STORAGE_KEY);
    if (saved && SUPPORTED_LOCALES.includes(saved)) return saved;
  } catch { /* stockage indisponible */ }
  return getBrowserLocale();
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
  root.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    el.setAttribute("placeholder", t(el.dataset.i18nPlaceholder));
  });
  root.querySelectorAll("[data-i18n-content]").forEach(el => {
    el.setAttribute("content", t(el.dataset.i18nContent));
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
    await loadLocaleConfig();
    await loadLocaleInto(detectLocale());
    applyTranslations();
    if (typeof MutationObserver !== "undefined" && document.documentElement) {
      const observer = new MutationObserver(records => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            if (node.matches?.("[data-i18n], [data-i18n-title], [data-i18n-aria], [data-i18n-placeholder], [data-i18n-content]")) {
              applyTranslations(node.parentElement || document);
            } else if (node.querySelector?.("[data-i18n], [data-i18n-title], [data-i18n-aria], [data-i18n-placeholder], [data-i18n-content]")) {
              applyTranslations(node);
            }
          }
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
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
function getDataLocale() {
  return localeConfig.locales.find(item => item.code === currentLocale)?.dataLocale || DEFAULT_LOCALE;
}
function getSupportedLocales() { return [...SUPPORTED_LOCALES]; }
function getLocaleOptions() { return localeConfig.locales.map(({ code, label }) => ({ code, label })); }

export { initI18n, t, setLocale, getLocale, getDataLocale, getSupportedLocales, getLocaleOptions, applyTranslations };
