
/** Libellé lisible d’une cible sans répéter son identifiant de catalogue. */
export function formatStarHopTargetLabel(target) {
  const name = String(target?.proper_name || target?.properName || target?.common_name || target?.commonName || target?.name || target?.id || "Objet").trim();
  const id = String(target?.id || "").trim();
  if (!id || name.toLocaleLowerCase("fr").includes(id.toLocaleLowerCase("fr"))) return name || id || "Objet";
  return `${name} · ${id}`;
}

/**
 * Calcule un cheminement stellaire par sauts successifs.
 * Les coordonnées RA sont exprimées en heures, DEC en degrés.
 */
export function angularSeparationDeg(a, b) {
  const ra1 = Number(a?.ra) * 15 * Math.PI / 180;
  const ra2 = Number(b?.ra) * 15 * Math.PI / 180;
  const dec1 = Number(a?.dec) * Math.PI / 180;
  const dec2 = Number(b?.dec) * Math.PI / 180;
  if (![ra1, ra2, dec1, dec2].every(Number.isFinite)) return Infinity;
  const cos = Math.sin(dec1) * Math.sin(dec2)
    + Math.cos(dec1) * Math.cos(dec2) * Math.cos(ra2 - ra1);
  return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
}


/** Distance angulaire minimale d’une étoile à l’arc de grand cercle départ→arrivée. */
export function angularCrossTrackDeg(anchor, guide, candidate) {
  const radians = Math.PI / 180;
  const separation = angularSeparationDeg(anchor, candidate) * radians;
  const direct = angularSeparationDeg(anchor, guide) * radians;
  if (![separation, direct].every(Number.isFinite) || direct < 1e-9) return Infinity;
  const bearing = (from, to) => {
    const ra1 = Number(from.ra) * 15 * radians, ra2 = Number(to.ra) * 15 * radians;
    const dec1 = Number(from.dec) * radians, dec2 = Number(to.dec) * radians;
    const dRa = ((ra2 - ra1 + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    return Math.atan2(Math.sin(dRa) * Math.cos(dec2),
      Math.cos(dec1) * Math.sin(dec2) - Math.sin(dec1) * Math.cos(dec2) * Math.cos(dRa));
  };
  const bearingToGuide = bearing(anchor, guide);
  const bearingToCandidate = bearing(anchor, candidate);
  const delta = bearingToCandidate - bearingToGuide;
  const crossTrack = Math.asin(Math.max(-1, Math.min(1, Math.sin(separation) * Math.sin(delta))));
  const alongTrack = Math.atan2(Math.sin(separation) * Math.cos(delta), Math.cos(separation));
  // Return Infinity for candidates outside the minor arc, not merely close to its extension.
  if (alongTrack <= 0 || alongTrack >= direct) return Infinity;
  return Math.abs(crossTrack) / radians;
}

/** Adapte les sauts au repérage visuel à l’œil nu et aux jumelles. */
export function recommendedStarHopMaxDeg(separationDeg) {
  if (!Number.isFinite(separationDeg)) return 10.0;
  if (separationDeg > 135) return 25.0;
  if (separationDeg > 90) return 20.0;
  if (separationDeg > 45) return 15.0;
  return 10.0;
}

/** Sélectionne le repère nommé et lumineux le plus proche de la cible. */
export function selectTargetGuideStar(target, stars, options = {}) {
  const maxMagnitude = Number.isFinite(options.maxMagnitude) ? options.maxMagnitude : 4.0;
  const maxDistanceDeg = Number.isFinite(options.maxDistanceDeg) ? options.maxDistanceDeg : 18;
  const targetId = nodeId(target);
  const candidates = (Array.isArray(stars) ? stars : []).filter(star => {
    const name = String(star?.common_name ?? star?.commonName ?? star?.proper_name ?? star?.properName ?? star?.name ?? '').trim();
    const mag = Number(star?.mag);
    return nodeId(star) !== targetId && name && !/^HIP[_\s-]*\d+$/i.test(name)
      && Number.isFinite(Number(star?.ra)) && Number.isFinite(Number(star?.dec))
      && Number.isFinite(mag) && mag <= maxMagnitude;
  }).map(star => ({ star, separationDeg: angularSeparationDeg(target, star), magnitude: Number(star.mag) }))
    .filter(item => Number.isFinite(item.separationDeg) && item.separationDeg > 0.03 && item.separationDeg <= maxDistanceDeg)
    .sort((a, b) => a.separationDeg - b.separationDeg || a.magnitude - b.magnitude);
  return candidates[0] ? { ...candidates[0].star, guideSeparationDeg: candidates[0].separationDeg } : null;
}


/**
 * Construit un cheminement visuel compact : départ, au plus une étoile
 * intermédiaire nommée et brillante pour les très longues traversées, puis
 * le repère final proche de la cible. Les identifiants de catalogue seuls
 * ne sont jamais retenus comme repères pédagogiques.
 */
export function buildCompactStarHopRoute(anchor, guide, stars, options = {}) {
  const maxMagnitude = Number.isFinite(options.maxMagnitude) ? options.maxMagnitude : 2.5;
  // Une traversée d’environ 15° reste simple à suivre sans étape supplémentaire.
  const thresholdDeg = Number.isFinite(options.thresholdDeg) ? options.thresholdDeg : 30;
  // Si un autre repère nommé et brillant se trouve déjà près d’une extrémité,
  // on évite de surcharger le schéma : le départ et le repère final suffisent.
  const nearbyNamedStarDeg = Number.isFinite(options.nearbyNamedStarDeg) ? options.nearbyNamedStarDeg : 15;
  const maxDetourRatio = Number.isFinite(options.maxDetourRatio) ? options.maxDetourRatio : 1.12;
  const maxCrossTrackDeg = Number.isFinite(options.maxCrossTrackDeg) ? options.maxCrossTrackDeg : 4;
  if (!anchor || !guide || angularSeparationDeg(anchor, guide) === Infinity) {
    return { complete: false, maxHopDeg: 0, nodes: [], legs: [] };
  }
  const direct = angularSeparationDeg(anchor, guide);
  const anchorId = nodeId(anchor);
  const guideId = nodeId(guide);
  let intermediate = null;
  const namedStars = (Array.isArray(stars) ? stars : []).filter(star => {
    const name = String(star?.common_name ?? star?.commonName ?? star?.proper_name ?? star?.properName ?? '').trim();
    const mag = Number(star?.mag);
    return nodeId(star) !== anchorId && nodeId(star) !== guideId
      && name && !/^HIP[_\s-]*\d+$/i.test(name)
      && Number.isFinite(Number(star?.ra)) && Number.isFinite(Number(star?.dec))
      && Number.isFinite(mag) && mag <= 4.0;
  });
  const nearbyNamedStar = namedStars.some(star =>
    angularSeparationDeg(anchor, star) <= nearbyNamedStarDeg
    || angularSeparationDeg(guide, star) <= nearbyNamedStarDeg
  );
  const eligibleStars = namedStars.filter(star => Number(star.mag) <= maxMagnitude);
  if (direct > thresholdDeg && !nearbyNamedStar) {
    const candidates = eligibleStars.map(star => {
      const from = angularSeparationDeg(anchor, star);
      const to = angularSeparationDeg(star, guide);
      const crossTrack = angularCrossTrackDeg(anchor, guide, star);
      return { star, from, to, sum: from + to, longest: Math.max(from, to), crossTrack, magnitude: Number(star.mag) };
    }).filter(item => item.from >= 8 && item.to >= 8
      && item.from < direct && item.to < direct && item.sum <= direct * maxDetourRatio
      && item.crossTrack <= maxCrossTrackDeg)
      .sort((a, b) => a.crossTrack - b.crossTrack || a.longest - b.longest || a.sum - b.sum || a.magnitude - b.magnitude);
    intermediate = candidates[0]?.star || null;
  }
  const nodes = [
    { id: anchorId, kind: 'anchor', object: anchor, mag: Number(anchor.mag) },
    ...(intermediate ? [{ id: nodeId(intermediate), kind: 'star', object: intermediate, mag: Number(intermediate.mag) }] : []),
    { id: guideId, kind: 'star', object: guide, mag: Number(guide.mag) }
  ];
  const legs = nodes.slice(1).map((node, index) => ({
    from: nodes[index], to: node,
    separationDeg: angularSeparationDeg(nodes[index].object, node.object)
  }));
  return { complete: true, maxHopDeg: Math.max(0, ...legs.map(leg => leg.separationDeg)), nodes, legs, intermediateUsed: Boolean(intermediate) };
}

function nodeId(star) {
  return String(star?.id ?? (star?.hip ? `HIP_${star.hip}` : `${star?.ra}:${star?.dec}`));
}

/**
 * Dijkstra sur les étoiles de magnitude visuelle connue et modérée.
 * Si le catalogue ne permet pas une chaîne continue, retourne un trajet
 * direct explicitement marqué incomplet plutôt que d'inventer des repères.
 */
export function buildStarHopRoute(anchor, target, stars, options = {}) {
  const maxHopDeg = Number.isFinite(options.maxHopDeg) ? options.maxHopDeg : 7.0;
  const maxMagnitude = Number.isFinite(options.maxMagnitude) ? options.maxMagnitude : 5.2;
  const requireCommonName = options.requireCommonName === true;
  if (!anchor || !target || angularSeparationDeg(anchor, target) === Infinity) {
    return { complete: false, maxHopDeg, nodes: [], legs: [] };
  }
  const anchorId = nodeId(anchor);
  const targetId = `target:${nodeId(target)}`;
  const usableStars = (Array.isArray(stars) ? stars : []).filter(star => {
    const mag = Number(star?.mag);
    return nodeId(star) !== anchorId
      && (!requireCommonName || Boolean(String(star?.common_name ?? star?.commonName ?? star?.proper_name ?? star?.properName ?? "").trim()))
      && Number.isFinite(Number(star?.ra))
      && Number.isFinite(Number(star?.dec))
      && Number.isFinite(mag) && mag <= maxMagnitude
      && angularSeparationDeg(anchor, star) > 0.08
      && angularSeparationDeg(target, star) > 0.08;
  });
  const nodes = [
    { id: anchorId, kind: "anchor", object: anchor, mag: Number(anchor.mag) },
    ...usableStars.map(star => ({ id: nodeId(star), kind: "star", object: star, mag: Number(star.mag) })),
    { id: targetId, kind: "target", object: target, mag: NaN }
  ];
  const start = 0;
  const end = nodes.length - 1;
  const distances = Array(nodes.length).fill(Infinity);
  const previous = Array(nodes.length).fill(-1);
  const visited = new Set();
  distances[start] = 0;
  while (visited.size < nodes.length) {
    let current = -1;
    let best = Infinity;
    for (let i = 0; i < nodes.length; i += 1) {
      if (!visited.has(i) && distances[i] < best) { best = distances[i]; current = i; }
    }
    if (current < 0 || current === end) break;
    visited.add(current);
    for (let next = 0; next < nodes.length; next += 1) {
      if (next === current || visited.has(next)) continue;
      const separation = angularSeparationDeg(nodes[current].object, nodes[next].object);
      if (separation > maxHopDeg) continue;
      // Le coût favorise les trajets courts et les étoiles brillantes.
      const brightnessPenalty = nodes[next].kind === "star" ? Math.max(0, nodes[next].mag) * 0.035 : 0;
      // Pour une cible éloignée, préférer une vraie étoile repère proche de la
      // cible plutôt qu'un saut géométriquement plus court qui aboutit directement
      // à un objet diffus/invisible à l'œil nu. Si aucun chemin par étoiles n'est
      // possible, le trajet direct reste disponible comme solution de repli.
      const directTargetPenalty = nodes[current].kind === "anchor" && nodes[next].kind === "target"
        && separation > maxHopDeg * 0.5
        && usableStars.some(star => angularSeparationDeg(star, target) <= maxHopDeg)
        ? maxHopDeg * 0.5 : 0;
      const cost = best + separation + brightnessPenalty + directTargetPenalty;
      if (cost < distances[next]) { distances[next] = cost; previous[next] = current; }
    }
  }
  if (!Number.isFinite(distances[end])) {
    const separation = angularSeparationDeg(anchor, target);
    return { complete: false, maxHopDeg, nodes: [nodes[start], nodes[end]], legs: [{ from: nodes[start], to: nodes[end], separationDeg: separation }] };
  }
  const indices = [];
  for (let cursor = end; cursor !== -1; cursor = previous[cursor]) {
    indices.push(cursor);
    if (cursor === start) break;
  }
  indices.reverse();
  const routeNodes = indices.map(index => nodes[index]);
  const legs = routeNodes.slice(1).map((node, index) => ({
    from: routeNodes[index],
    to: node,
    separationDeg: angularSeparationDeg(routeNodes[index].object, node.object)
  }));
  return { complete: true, maxHopDeg, nodes: routeNodes, legs };
}
