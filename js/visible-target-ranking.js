"use strict";

/**
 * Classe les cibles au-dessus de l'horizon selon leur intérêt pratique
 * d'observation : hauteur d'abord, puis catégorie/catalogue et luminosité.
 * La magnitude intégrée des objets diffus n'est pas équivalente à leur
 * visibilité à l'œil nu ; elle ne sert donc qu'à départager des cibles proches.
 */
export function visibleTargetScore(object) {
  const altitude = Number(object?.alt);
  if (!Number.isFinite(altitude)) return -Infinity;

  // La hauteur domine le score : une cible très basse est moins intéressante.
  const safeAltitude = Math.max(0, Math.min(90, altitude));
  let altitudeScore;
  if (safeAltitude < 10) altitudeScore = safeAltitude * 0.7;
  else if (safeAltitude < 25) altitudeScore = 7 + (safeAltitude - 10) * 1.2;
  else if (safeAltitude <= 65) altitudeScore = 25 + (safeAltitude - 25) * 0.8;
  else altitudeScore = 57 - (safeAltitude - 65) * 0.35;

  const type = String(object.type || "").toLowerCase();
  const id = String(object.id || "").toUpperCase();
  const catalogue = String(object.catalogue || "").toLowerCase();
  let interest = 0;
  if (type === "planet") interest += 12;
  else if (type === "cluster") interest += 8;
  else if (type === "nebula") interest += 7;
  else if (type === "galaxy") interest += 6;
  else if (type === "deep-sky") interest += 5;
  if (catalogue === "messier" || /^M\d+\b/.test(id)) interest += 4;
  else if (catalogue === "ngc" || /^NGC\s*\d+\b/.test(id)) interest += 2;

  // Magnitude : bonus limité, uniquement pour départager, sans seuil d'exclusion.
  const magnitude = Number(object.mag);
  const magnitudeBonus = Number.isFinite(magnitude)
    ? Math.max(0, Math.min(3, (10 - magnitude) * 0.3))
    : 0;

  return altitudeScore + interest + magnitudeBonus;
}

export function rankVisibleTargets(objects) {
  return [...(Array.isArray(objects) ? objects : [])].sort((a, b) => {
    const scoreDifference = visibleTargetScore(b) - visibleTargetScore(a);
    if (Number.isFinite(scoreDifference) && Math.abs(scoreDifference) > 1e-9) return scoreDifference;
    const altitudeDifference = Number(b.alt) - Number(a.alt);
    if (Number.isFinite(altitudeDifference) && altitudeDifference !== 0) return altitudeDifference;
    const magnitudeDifference = Number(a.mag ?? Infinity) - Number(b.mag ?? Infinity);
    if (Number.isFinite(magnitudeDifference) && magnitudeDifference !== 0) return magnitudeDifference;
    return String(a.name || a.id || "").localeCompare(String(b.name || b.id || ""), "fr");
  });
}
