"use strict";

import { t } from "./i18n.js";

// Éléments orbitaux moyens autour de J2000. Modèle pédagogique : orbites
// képlériennes simplifiées, suffisamment cohérentes pour explorer les mouvements.
export const SOLAR_PLANETS = [
  { id: "mercury", name: t("names.planet.mercury"), a: 0.3871, e: 0.2056, i: 7.005, node: 48.331, peri: 77.457, meanLongitude: 252.251, period: 87.969, diameter: 4879, rotation: "58,6 jours", temperature: "≈ 167 °C", composition: "Planète rocheuse, riche en métaux", moons: "Aucune", color: "#b7aaa0", fact: "Mercure est la planète la plus proche du Soleil. Malgré sa proximité, ses nuits sont glaciales : elle ne possède presque pas d’atmosphère pour retenir la chaleur. Son orbite dure 88 jours terrestres." },
  { id: "venus", name: t("names.planet.venus"), a: 0.7233, e: 0.0068, i: 3.3947, node: 76.680, peri: 131.602, meanLongitude: 181.979, period: 224.701, diameter: 12104, rotation: "243 jours (rétrograde)", temperature: "≈ 464 °C", composition: "Planète rocheuse, atmosphère très dense de CO₂", moons: "Aucune", color: "#f1d09a", fact: "Vénus est recouverte de nuages épais qui réfléchissent très bien la lumière. Son effet de serre extrême en fait la planète la plus chaude, et elle tourne dans le sens opposé à la plupart des planètes." },
  { id: "earth", name: t("names.planet.earth"), a: 1, e: 0.0167, i: 0, node: 0, peri: 102.937, meanLongitude: 100.464, period: 365.256, diameter: 12742, rotation: "23 h 56 min", temperature: "≈ 15 °C", composition: "Planète rocheuse avec océans et atmosphère azotée et oxygénée", moons: "1 : la Lune", color: "#5da9ef", fact: "La Terre est la seule planète connue qui abrite la vie. L’eau liquide couvre environ 71 % de sa surface, et son atmosphère protège les êtres vivants tout en régulant la température." },
  { id: "mars", name: t("names.planet.mars"), a: 1.5237, e: 0.0934, i: 1.850, node: 49.558, peri: 336.041, meanLongitude: 355.453, period: 686.980, diameter: 6779, rotation: "24 h 37 min", temperature: "≈ −65 °C", composition: "Planète rocheuse ; poussières riches en oxydes de fer", moons: "2 : Phobos et Déimos", color: "#e77d60", fact: "Mars possède le volcan Olympus Mons, le plus grand connu du Système solaire. Des vallées et minéraux témoignent d’un passé où l’eau liquide a joué un rôle important." },
  { id: "jupiter", name: t("names.planet.jupiter"), a: 5.2026, e: 0.0485, i: 1.303, node: 100.464, peri: 14.753, meanLongitude: 34.404, period: 4332.59, diameter: 139820, rotation: "9 h 56 min", temperature: "≈ −110 °C au sommet des nuages", composition: "Géante gazeuse, surtout hydrogène et hélium", moons: "Plus de 100 connues", color: "#d8b28b", fact: "Jupiter est la plus grande planète du Système solaire. Sa Grande Tache rouge est une immense tempête, observée depuis des siècles. Ses quatre grandes lunes galiléennes peuvent être repérées avec de simples jumelles." },
  { id: "saturn", name: t("names.planet.saturn"), a: 9.5549, e: 0.0555, i: 2.489, node: 113.665, peri: 92.431, meanLongitude: 49.944, period: 10759.2, diameter: 116460, rotation: "≈ 10 h 33 min", temperature: "≈ −140 °C au sommet des nuages", composition: "Géante gazeuse, surtout hydrogène et hélium", moons: "Plus de 270 connues", color: "#e6d49c", fact: "Les anneaux de Saturne sont très étendus mais étonnamment minces. Ils sont composés de morceaux de glace et de roche, et la planète a une densité moyenne inférieure à celle de l’eau." },
  { id: "uranus", name: t("names.planet.uranus"), a: 19.2184, e: 0.0463, i: 0.773, node: 74.006, peri: 170.964, meanLongitude: 313.232, period: 30688.5, diameter: 50724, rotation: "≈ 17 h 14 min", temperature: "≈ −195 °C", composition: t("solarSystem.natureIceGiant"), moons: "28 connues", color: "#8ed9dc", fact: t("solarSystem.descUranus") },
  { id: "neptune", name: t("names.planet.neptune"), a: 30.11, e: 0.009, i: 1.770, node: 131.784, peri: 44.971, meanLongitude: 304.880, period: 60182, diameter: 49244, rotation: "≈ 16 h 6 min", temperature: "≈ −200 °C", composition: "Géante glacée, atmosphère riche en hydrogène, hélium et méthane", moons: "16 connues", color: "#6388f2", fact: "Neptune est si éloignée du Soleil qu’elle met près de 165 ans terrestres à en faire le tour. Des vents extrêmement rapides parcourent son atmosphère, malgré le faible apport d’énergie solaire." }
];

const DEG = Math.PI / 180;
const J2000 = Date.UTC(2000, 0, 1, 12, 0, 0);
const norm360 = angle => ((angle % 360) + 360) % 360;

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
  return planet ? calculateOneSolarOrbitPosition(planet, date) : null;
}

export function calculateSolarOrbitPositions(date) {
  const timestamp = date instanceof Date ? date.getTime() : new Date(date).getTime();
  if (!Number.isFinite(timestamp)) return [];
  return SOLAR_PLANETS.map(planet => calculateOneSolarOrbitPosition(planet, new Date(timestamp)));
}
