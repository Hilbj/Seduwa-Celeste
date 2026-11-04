"use strict";

import { t } from "./i18n.js";

// Éléments orbitaux moyens autour de J2000. Modèle pédagogique : orbites
// képlériennes simplifiées, suffisamment cohérentes pour explorer les mouvements.
export const SOLAR_PLANETS = [
  { id: "mercury", a: 0.3871, e: 0.2056, i: 7.005, node: 48.331, peri: 77.457, meanLongitude: 252.251, period: 87.969, diameter: 4879, color: "#b7aaa0" },
  { id: "venus", a: 0.7233, e: 0.0068, i: 3.3947, node: 76.680, peri: 131.602, meanLongitude: 181.979, period: 224.701, diameter: 12104, color: "#f1d09a" },
  { id: "earth", a: 1, e: 0.0167, i: 0, node: 0, peri: 102.937, meanLongitude: 100.464, period: 365.256, diameter: 12742, color: "#5da9ef" },
  { id: "mars", a: 1.5237, e: 0.0934, i: 1.850, node: 49.558, peri: 336.041, meanLongitude: 355.453, period: 686.980, diameter: 6779, color: "#e77d60" },
  { id: "jupiter", a: 5.2026, e: 0.0485, i: 1.303, node: 100.464, peri: 14.753, meanLongitude: 34.404, period: 4332.59, diameter: 139820, color: "#d8b28b" },
  { id: "saturn", a: 9.5549, e: 0.0555, i: 2.489, node: 113.665, peri: 92.431, meanLongitude: 49.944, period: 10759.2, diameter: 116460, color: "#e6d49c" },
  { id: "uranus", a: 19.2184, e: 0.0463, i: 0.773, node: 74.006, peri: 170.964, meanLongitude: 313.232, period: 30688.5, diameter: 50724, color: "#8ed9dc" },
  { id: "neptune", a: 30.11, e: 0.009, i: 1.770, node: 131.784, peri: 44.971, meanLongitude: 304.880, period: 60182, diameter: 49244, color: "#6388f2" }
];

const DEG = Math.PI / 180;
const J2000 = Date.UTC(2000, 0, 1, 12, 0, 0);
const norm360 = angle => ((angle % 360) + 360) % 360;

export function getLocalizedSolarPlanet(planet) {
  if (!planet) return planet;
  const key = `solarSystem.planetDetails.${planet.id}`;
  return {
    ...planet,
    name: t(`names.planet.${planet.id}`),
    rotation: t(`${key}.rotation`),
    temperature: t(`${key}.temperature`),
    composition: t(`${key}.composition`),
    moons: t(`${key}.moons`),
    fact: t(`${key}.fact`)
  };
}

function calculateOneSolarOrbitPosition(planet, date) {
  const timestamp = date instanceof Date ? date.getTime() : new Date(date).getTime();
  if (!Number.isFinite(timestamp)) return null;
  const days = (timestamp - J2000) / 86400000;
  const meanAnomaly = norm360(planet.meanLongitude - planet.peri + days * 360 / planet.period) * DEG;
  let eccentricAnomaly = meanAnomaly;
  for (let iteration = 0; iteration < 8; iteration++) {
    const delta = (eccentricAnomaly - planet.e * Math.sin(eccentricAnomaly) - meanAnomaly) / (1 - planet.e * Math.cos(eccentricAnomaly));
    eccentricAnomaly -= delta;
    if (Math.abs(delta) < 1e-8) break;
  }
  const trueAnomaly = 2 * Math.atan2(Math.sqrt(1 + planet.e) * Math.sin(eccentricAnomaly / 2), Math.sqrt(1 - planet.e) * Math.cos(eccentricAnomaly / 2));
  const argumentPerihelion = (planet.peri - planet.node) * DEG;
  const orbitalAngle = trueAnomaly + argumentPerihelion;
  const radiusAU = planet.a * (1 - planet.e * Math.cos(eccentricAnomaly));
  const node = planet.node * DEG;
  const inclination = planet.i * DEG;
  const x = radiusAU * (Math.cos(node) * Math.cos(orbitalAngle) - Math.sin(node) * Math.sin(orbitalAngle) * Math.cos(inclination));
  const y = radiusAU * (Math.sin(node) * Math.cos(orbitalAngle) + Math.cos(node) * Math.sin(orbitalAngle) * Math.cos(inclination));
  return { ...planet, x, y, radiusAU, longitude: norm360(Math.atan2(y, x) / DEG), meanAnomaly: norm360(meanAnomaly / DEG) };
}

export function calculateSolarOrbitPosition(planetId, date) {
  const planet = SOLAR_PLANETS.find(item => item.id === planetId);
  return planet ? calculateOneSolarOrbitPosition(getLocalizedSolarPlanet(planet), date) : null;
}

export function calculateSolarOrbitPositions(date) {
  const timestamp = date instanceof Date ? date.getTime() : new Date(date).getTime();
  if (!Number.isFinite(timestamp)) return [];
  return SOLAR_PLANETS.map(planet => calculateOneSolarOrbitPosition(getLocalizedSolarPlanet(planet), new Date(timestamp)));
}
