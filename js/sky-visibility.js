"use strict";

/** Altitude maximale théorique d'un objet à la latitude d'observation. */
export function theoreticalMaximumAltitude(declination, latitude) {
  if (declination == null || declination === "" || latitude == null || latitude === "") return null;
  const dec = Number(declination);
  const lat = Number(latitude);
  if (!Number.isFinite(dec) || !Number.isFinite(lat) || dec < -90 || dec > 90 || lat < -90 || lat > 90) return null;
  return 90 - Math.abs(lat - dec);
}


/** Type d'objet fiable pour les parcours Découverte, même si le catalogue
 * Hipparcos ne fournit pas de propriété `type`. */
export function getDiscoveryObjectType(object) {
  const explicitType = String(object?.type || "").toLowerCase();
  if (explicitType) return explicitType;
  const catalogue = String(object?.catalogue || "").toLowerCase();
  if (catalogue === "hipparcos") return "star";
  return "";
}

/** Vrai si l'objet peut dépasser l'horizon astronomique depuis cette latitude. */
export function isEverVisibleFromLatitude(object, latitude) {
  const maximum = theoreticalMaximumAltitude(object?.dec, latitude);
  return maximum == null ? true : maximum > 0.1;
}

function normalizedIdentity(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Déduplique les objets nommés et les alias d'un même identifiant physique. */
export function deduplicateNamedObjects(objects, getCommonName = object => object?.discoveryCommonName || object?.common_name || object?.name) {
  const seen = new Set();
  const result = [];
  for (const object of Array.isArray(objects) ? objects : []) {
    const keys = getObjectIdentityKeys(object, getCommonName(object));
    if (keys.some(key => seen.has(key))) continue;
    keys.forEach(key => seen.add(key));
    result.push(object);
  }
  return result;
}

/** Identifiants stables d'un objet, y compris lorsque plusieurs catalogues
 * décrivent le même astre sous des noms ou des identifiants différents. */
export function getObjectIdentityKeys(object, commonName = object?.discoveryCommonName || object?.common_name || object?.name) {
  const keys = new Set();
  const name = normalizedIdentity(commonName);
  if (name) keys.add(`name:${name}`);
  const numericHip = Number(object?.hip);
  if (object?.hip != null && object.hip !== "" && Number.isFinite(numericHip)) keys.add(`hip:${numericHip}`);
  const hipValues = [object?.id, object?.name, object?.designation, object?.proper_name, object?.properName];
  for (const value of hipValues) {
    if (value == null) continue;
    const match = String(value).match(/(?:^|\D)HIP[_\s-]*(\d+)(?:$|\D)/i);
    if (match) keys.add(`hip:${Number(match[1])}`);
  }
  const catalogue = normalizedIdentity(object?.catalogue);
  const id = normalizedIdentity(object?.id);
  if (id) keys.add(`id:${catalogue}:${id}`);
  return [...keys];
}

/** Sélectionne les étapes dans l'ordre, en réservant chaque astre dès son choix.
 * Si le seul candidat d'une étape est déjà utilisé, son objectif pédagogique
 * est fusionné avec l'étape qui présente déjà cet astre. */
export function selectDistinctDiscoverySteps(candidates, steps, getCommonName = object => object?.discoveryCommonName || object?.common_name || object?.name) {
  const pool = Array.isArray(candidates) ? candidates : [];
  const selected = [];
  const used = new Set();
  for (const step of Array.isArray(steps) ? steps : []) {
    const matches = pool.filter(object => step.predicate(object));
    const distinct = matches.find(object => !getObjectIdentityKeys(object, getCommonName(object)).some(key => used.has(key)));
    if (distinct) {
      const keys = getObjectIdentityKeys(distinct, getCommonName(distinct));
      keys.forEach(key => used.add(key));
      selected.push({ ...step, object: distinct, mergedSteps: [step] });
      continue;
    }
    // Si cette catégorie ne dispose que d'un astre déjà proposé, on regroupe
    // l'objectif au lieu de répéter le même objet dans une nouvelle carte.
    const repeated = matches.find(object => {
      const keys = getObjectIdentityKeys(object, getCommonName(object));
      return keys.some(key => used.has(key));
    });
    if (repeated) {
      const repeatedKeys = getObjectIdentityKeys(repeated, getCommonName(repeated));
      const existing = selected.find(entry => getObjectIdentityKeys(entry.object, getCommonName(entry.object)).some(key => repeatedKeys.includes(key)));
      if (existing) existing.mergedSteps.push(step);
    }
  }
  return selected;
}

/** Centre sphérique et champ de vision adapté à un groupe de directions.
 * Un minimum de 70° garde du contexte et limite le zoom automatique à 0,64×. */
export function calculateContextFrame(points, minimumFov = 70, margin = 1.4) {
  const valid = (Array.isArray(points) ? points : []).filter(point =>
    Number.isFinite(Number(point?.az)) && Number.isFinite(Number(point?.alt))
  );
  if (!valid.length) return null;
  const vectors = valid.map(point => {
    const az = Number(point.az) * Math.PI / 180;
    const alt = Number(point.alt) * Math.PI / 180;
    return [Math.cos(alt) * Math.sin(az), Math.cos(alt) * Math.cos(az), Math.sin(alt)];
  });
  const mean = [0, 1, 2].map(axis => vectors.reduce((sum, vector) => sum + vector[axis], 0));
  const norm = Math.hypot(...mean);
  if (!Number.isFinite(norm) || norm < 1e-9) return null;
  const center = mean.map(value => value / norm);
  const heading = (Math.atan2(center[0], center[1]) * 180 / Math.PI + 360) % 360;
  const pitch = Math.asin(Math.max(-1, Math.min(1, center[2]))) * 180 / Math.PI;
  const radius = Math.max(...vectors.map(vector => {
    const dot = Math.max(-1, Math.min(1, vector.reduce((sum, value, index) => sum + value * center[index], 0)));
    return Math.acos(dot) * 180 / Math.PI;
  }));
  const requiredFov = Math.max(minimumFov, radius * 2 * margin);
  return { heading, pitch, fov: Math.min(120, requiredFov), radius };
}

