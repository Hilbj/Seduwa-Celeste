"use strict";

/** Filtre et trie les cibles déjà calculées comme étant au-dessus de l’horizon. */
export function filterVisibleTargets(targets, options = {}) {
  const type = options.type || "all";
  const minAltitude = Number.isFinite(Number(options.minAltitude)) ? Number(options.minAltitude) : 0;
  const sort = options.sort || "recommended";
  const maxMagnitude = options.maxMagnitude == null || options.maxMagnitude === "all"
    ? null : Number(options.maxMagnitude);
  const filtered = (Array.isArray(targets) ? targets : []).filter(object => {
    const altitude = Number(object?.alt);
    if (!Number.isFinite(altitude) || altitude < minAltitude) return false;
    if (type !== "all" && object?.type !== type) return false;
    if (Number.isFinite(maxMagnitude)) {
      const magnitude = Number(object?.mag);
      if (!Number.isFinite(magnitude) || magnitude > maxMagnitude) return false;
    }
    return true;
  });
  const compareText = (a, b) => String(a || "").localeCompare(String(b || ""), "fr", { sensitivity: "base" });
  if (sort === "altitude") filtered.sort((a, b) => Number(b.alt) - Number(a.alt));
  else if (sort === "magnitude") filtered.sort((a, b) => {
    const am = Number(a.mag), bm = Number(b.mag);
    const av = Number.isFinite(am) ? am : Infinity;
    const bv = Number.isFinite(bm) ? bm : Infinity;
    return av - bv || Number(b.alt) - Number(a.alt);
  });
  else if (sort === "name") filtered.sort((a, b) => compareText(a.name || a.proper_name || a.id, b.name || b.proper_name || b.id));
  return filtered;
}
