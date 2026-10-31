"use strict";

import { clamp, norm360, rad, deg, equatorialToHorizontal } from "./astronomy.js";
import { calculateSolarOrbitPosition } from "./solar-system-orbits.js";

const EPOCH_JD_FALLBACK = 2461200.5;
const AU_DAYS_CONSTANT = 0.01720209895;
const OBLIQUITY_J2000 = rad(23.439291111);
const DAY_MS = 86400000;
const J2000_JD = 2451545.0;

function validDate(date) {
  return date instanceof Date && Number.isFinite(date.getTime());
}

function julianDate(date) {
  return date.getTime() / DAY_MS + 2440587.5;
}

function propagateHeliocentricEcliptic(body, jd, epochJD) {
  const a = Number(body.a);
  const e = Number(body.e);
  const inclination = rad(Number(body.i));
  const node = rad(Number(body.node));
  const peri = rad(Number(body.peri));
  const meanAnomaly0 = rad(Number(body.M0));
  if (![a, e, inclination, node, peri, meanAnomaly0].every(Number.isFinite) || a <= 0 || e < 0 || e >= 1) return null;

  // n = k/a^(3/2), avec k exprimé en radians/jour.
  const meanMotion = AU_DAYS_CONSTANT / Math.pow(a, 1.5);
  const meanAnomaly = ((meanAnomaly0 + meanMotion * (jd - (Number(body.epochJD) || epochJD || EPOCH_JD_FALLBACK))) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  let eccentricAnomaly = meanAnomaly;
  for (let iteration = 0; iteration < 12; iteration++) {
    const denominator = 1 - e * Math.cos(eccentricAnomaly);
    if (Math.abs(denominator) < 1e-12) break;
    const delta = (eccentricAnomaly - e * Math.sin(eccentricAnomaly) - meanAnomaly) / denominator;
    eccentricAnomaly -= delta;
    if (Math.abs(delta) < 1e-12) break;
  }

  const trueAnomaly = 2 * Math.atan2(
    Math.sqrt(1 + e) * Math.sin(eccentricAnomaly / 2),
    Math.sqrt(1 - e) * Math.cos(eccentricAnomaly / 2)
  );
  const radius = a * (1 - e * Math.cos(eccentricAnomaly));
  const argument = peri + trueAnomaly;
  const cosNode = Math.cos(node), sinNode = Math.sin(node);
  const cosArgument = Math.cos(argument), sinArgument = Math.sin(argument);
  const cosInclination = Math.cos(inclination), sinInclination = Math.sin(inclination);

  return {
    x: radius * (cosNode * cosArgument - sinNode * sinArgument * cosInclination),
    y: radius * (sinNode * cosArgument + cosNode * sinArgument * cosInclination),
    z: radius * sinArgument * sinInclination,
    radiusAU: radius,
    eccentricAnomaly,
    trueAnomaly
  };
}

/**
 * Position apparente simplifiée d'un astéroïde pour une date et un lieu.
 * Le mouvement héliocentrique est képlérien, sans perturbations planétaires;
 * l'altitude/azimut sont ensuite calculés avec la projection horizontale d'Atlas.
 */
export function calculateMinorPlanetPosition(body, date, latitude, longitude, catalogueEpochJD = EPOCH_JD_FALLBACK) {
  if (!body || !validDate(date) || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const jd = julianDate(date);
  const heliocentric = propagateHeliocentricEcliptic(body, jd, catalogueEpochJD);
  const earth = calculateSolarOrbitPosition("earth", date);
  if (!heliocentric || !earth || !Number.isFinite(earth.x) || !Number.isFinite(earth.y)) return null;

  const gx = heliocentric.x - earth.x;
  const gy = heliocentric.y - earth.y;
  const gz = heliocentric.z - (Number(earth.z) || 0);
  const delta = Math.hypot(gx, gy, gz);
  if (!Number.isFinite(delta) || delta < 1e-9) return null;

  // Écliptique J2000 -> équateur J2000.
  const yEq = gy * Math.cos(OBLIQUITY_J2000) - gz * Math.sin(OBLIQUITY_J2000);
  const zEq = gy * Math.sin(OBLIQUITY_J2000) + gz * Math.cos(OBLIQUITY_J2000);
  const ra = norm360(deg(Math.atan2(yEq, gx))) / 15;
  const dec = deg(Math.atan2(zEq, Math.hypot(gx, yEq)));
  const horizontal = equatorialToHorizontal(ra, dec, date, latitude, longitude, { epoch: "J2000" });

  const earthRadius = Math.hypot(earth.x, earth.y, Number(earth.z) || 0);
  const cosPhase = clamp(
    (heliocentric.radiusAU ** 2 + delta ** 2 - earthRadius ** 2) / (2 * heliocentric.radiusAU * delta),
    -1,
    1
  );
  const phaseAngle = Math.acos(cosPhase);
  const tanHalf = Math.tan(phaseAngle / 2);
  const phi1 = Math.exp(-3.33 * Math.pow(Math.max(0, tanHalf), 0.63));
  const phi2 = Math.exp(-1.87 * Math.pow(Math.max(0, tanHalf), 1.22));
  const G = clamp(Number.isFinite(Number(body.G)) ? Number(body.G) : 0.15, 0, 1);
  const phaseFunction = Math.max(1e-12, (1 - G) * phi1 + G * phi2);
  const H = Number.isFinite(Number(body.H)) ? Number(body.H) : 10;
  const magnitude = body.comet
    ? H + 5 * Math.log10(delta) + 2.5 * (Number.isFinite(Number(body.cometMagnitudeExponent)) ? Number(body.cometMagnitudeExponent) : 4) * Math.log10(Math.max(0.01, heliocentric.radiusAU))
    : H + 5 * Math.log10(heliocentric.radiusAU * delta) - 2.5 * Math.log10(phaseFunction);

  return {
    ...body,
    type: body.comet ? "comet" : (body.dwarfPlanet ? "dwarf-planet" : "minor-planet"),
    catalogue: body.comet ? "Comètes" : (body.dwarfPlanet ? "Planètes naines" : "Planètes mineures"),
    ra,
    dec,
    az: horizontal.az,
    alt: horizontal.alt,
    mag: magnitude,
    heliocentricDistanceAU: heliocentric.radiusAU,
    geocentricDistanceAU: delta,
    phaseAngleDeg: deg(phaseAngle),
    positionModel: "Kepler simplifié"
  };
}

export function calculateMinorPlanetPositions(bodies, date, latitude, longitude, epochJD = EPOCH_JD_FALLBACK) {
  if (!Array.isArray(bodies)) return [];
  return bodies.map(body => calculateMinorPlanetPosition(body, date, latitude, longitude, epochJD)).filter(Boolean);
}
