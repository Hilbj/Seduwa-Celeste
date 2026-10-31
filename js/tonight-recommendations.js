"use strict";

import { rankVisibleTargets } from "./visible-target-ranking.js";

/**
 * Heuristique pédagogique de sélection du soir. Elle ne prétend pas garantir
 * la visibilité : magnitude intégrée, brillance surfacique, ciel et expérience
 * de l'observateur peuvent changer fortement le résultat.
 */
export function isPrioritySolarTarget(object) {
  const type = String(object?.type || "").toLowerCase();
  const altitude = Number(object?.alt);
  const magnitude = Number(object?.mag);
  if (!Number.isFinite(altitude) || altitude <= 0 || !Number.isFinite(magnitude)) return false;
  return type === "moon" || (type === "planet" && magnitude <= 4.5);
}

export function instrumentFit(object, instrument = "all") {
  const type = String(object?.type || (object?.catalogue === "Hipparcos" ? "star" : "")).toLowerCase();
  const magnitude = Number(object?.mag);
  const magKnown = Number.isFinite(magnitude);
  if (type === "sun") return false;
  if (instrument === "all") return true;
  if (!magKnown) return false;

  if (instrument === "eye") {
    if (type === "moon") return true;
    if (type === "planet") return magnitude <= 4.5;
    if (type === "star") return magnitude <= 4.5;
    // L'éclat intégré d'un amas ne garantit pas qu'il soit visible à l'œil nu.
    if (type === "cluster") return magnitude <= 4.0;
    return false;
  }
  if (instrument === "binoculars") {
    if (["planet", "moon", "star"].includes(type)) return magnitude <= 7;
    if (type === "cluster") return magnitude <= 8.5;
    if (["nebula", "galaxy", "deep-sky"].includes(type)) return magnitude <= 7.5;
    return magnitude <= 8;
  }
  if (instrument === "telescope") return magnitude <= 12;
  return true;
}

/** Cibles suffisamment hautes et raisonnablement accessibles pour une première sélection. */
export function buildTonightSelection(objects, options = {}) {
  const instrument = options.instrument || "all";
  const limit = Number.isFinite(Number(options.limit)) && options.limit !== undefined && options.limit !== null ? Math.max(1, Number(options.limit)) : Infinity;
  const source = Array.isArray(objects) ? objects : [];
  const hasUsableData = object => Number.isFinite(Number(object?.alt)) && Number.isFinite(Number(object?.mag));

  // La Lune et les planètes brillantes visibles sont prioritaires : elles ne
  // doivent pas disparaître parce qu'une étoile obtient un meilleur score.
  // On les garde dès qu'elles sont strictement au-dessus de l'horizon (> 0°).
  const priorityTargets = source.filter(object =>
    hasUsableData(object) && isPrioritySolarTarget(object) && instrumentFit(object, instrument)
  );
  const priorityIds = new Set(priorityTargets.map(object => String(object.id || object.name || "").toLowerCase()));

  // Les autres cibles restent soumises au seuil indicatif de 10°.
  const candidates = source.filter(object => {
    if (!hasUsableData(object)) return false;
    const altitude = Number(object.alt);
    const magnitude = Number(object.mag);
    const type = String(object?.type || (object?.catalogue === "Hipparcos" ? "star" : "")).toLowerCase();
    if (altitude < 10 || type === "sun" || !instrumentFit(object, instrument)) return false;
    if (priorityIds.has(String(object.id || object.name || "").toLowerCase())) return false;
    if (type === "star") return magnitude <= 2.5;
    if (type === "planet" || type === "moon") return true;
    return magnitude <= 8.5;
  });
  const normalizedPriority = priorityTargets.map(object =>
    !object?.type && object?.catalogue === "Hipparcos" ? { ...object, type: "star" } : object
  );
  const normalizedCandidates = candidates.map(object =>
    !object?.type && object?.catalogue === "Hipparcos" ? { ...object, type: "star" } : object
  );
  const rankedRest = rankVisibleTargets(normalizedCandidates);
  const remainingSlots = Number.isFinite(limit) ? Math.max(0, limit - normalizedPriority.length) : Infinity;
  return [...rankVisibleTargets(normalizedPriority), ...rankedRest.slice(0, remainingSlots)];
}
