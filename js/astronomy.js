
"use strict";

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const ARCSEC_TO_RAD = DEG / 3600;

/* ==========================================================
   OUTILS ANGULAIRES
   ========================================================== */

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function norm360(value) {
  return ((value % 360) + 360) % 360;
}

export function norm180(value) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

export function rad(value) {
  return value * DEG;
}

export function deg(value) {
  return value * RAD;
}

/* ==========================================================
   DATE JULIENNE
   ========================================================== */

export function julianDate(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

/* ==========================================================
   TEMPS SIDÉRAL MOYEN DE GREENWICH
   Longitudes positives vers l'est.
   ========================================================== */

export function localSiderealTime(date, longitude) {
  const jd = julianDate(date);
  const T = (jd - 2451545.0) / 36525.0;

  const gmst =
    280.46061837 +
    360.98564736629 * (jd - 2451545.0) +
    0.000387933 * T * T -
    T * T * T / 38710000.0;

  return norm360(gmst + longitude);
}

/* ==========================================================
   PRÉCESSION : COORDONNÉES J2000 VERS L'ÉQUINOXE MOYEN
   DE LA DATE (MODÈLE IAU 1976 APPROXIMATIF).

   Entrée :
     raHours     ascension droite en heures
     decDegrees déclinaison en degrés
     date       date d'observation

   Sortie :
     ra          ascension droite en heures
     dec         déclinaison en degrés

   Ce modèle convient à une carte du ciel générale.
   Il ne remplace pas les modèles IAU modernes de haute précision.
   ========================================================== */

/**
 * Propagation astrométrique simplifiée d’une étoile depuis J2000.
 * pmRaCosDecMasYr = μα·cos(δ), en mas/an ; pmDecMasYr = μδ, en mas/an.
 * Le mouvement est appliqué dans le plan tangent de la sphère céleste.
 * La parallaxe, la vitesse radiale et les accélérations ne sont pas modélisées.
 */
export function propagateProperMotionJ2000(
  raHours,
  decDegrees,
  pmRaCosDecMasYr,
  pmDecMasYr,
  date,
  referenceEpoch = 2000
) {
  if (
    !Number.isFinite(raHours) || raHours < 0 || raHours >= 24 ||
    !Number.isFinite(decDegrees) || decDegrees < -90 || decDegrees > 90 ||
    !Number.isFinite(pmRaCosDecMasYr) || !Number.isFinite(pmDecMasYr) ||
    !Number.isFinite(referenceEpoch) ||
    !(date instanceof Date) || !Number.isFinite(date.getTime())
  ) return null;

  const referenceJd = 2451545.0 + (referenceEpoch - 2000) * 365.25;
  const years = (julianDate(date) - referenceJd) / 365.25;
  const alpha = rad(raHours * 15);
  const delta = rad(decDegrees);
  const masToRad = DEG / 3600000;

  const r = {
    x: Math.cos(delta) * Math.cos(alpha),
    y: Math.cos(delta) * Math.sin(alpha),
    z: Math.sin(delta)
  };
  const east = { x: -Math.sin(alpha), y: Math.cos(alpha), z: 0 };
  const north = {
    x: -Math.sin(delta) * Math.cos(alpha),
    y: -Math.sin(delta) * Math.sin(alpha),
    z: Math.cos(delta)
  };

  const x = r.x + years * masToRad * (pmRaCosDecMasYr * east.x + pmDecMasYr * north.x);
  const y = r.y + years * masToRad * (pmRaCosDecMasYr * east.y + pmDecMasYr * north.y);
  const z = r.z + years * masToRad * (pmRaCosDecMasYr * east.z + pmDecMasYr * north.z);
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length === 0) return null;

  return {
    ra: norm360(deg(Math.atan2(y / length, x / length))) / 15,
    dec: deg(Math.asin(clamp(z / length, -1, 1)))
  };
}

export function precessJ2000(raHours, decDegrees, date) {
  if (
    !Number.isFinite(raHours) ||
    !Number.isFinite(decDegrees) ||
    !(date instanceof Date) ||
    !Number.isFinite(date.getTime())
  ) {
    return null;
  }

  const T = (julianDate(date) - 2451545.0) / 36525.0;
  const T2 = T * T;
  const T3 = T2 * T;

  const zeta =
    (2306.2181 * T +
      0.30188 * T2 +
      0.017998 * T3) * ARCSEC_TO_RAD;

  const z =
    (2306.2181 * T +
      1.09468 * T2 +
      0.018203 * T3) * ARCSEC_TO_RAD;

  const theta =
    (2004.3109 * T -
      0.42665 * T2 -
      0.041833 * T3) * ARCSEC_TO_RAD;

  const ra = rad(raHours * 15);
  const dec = rad(decDegrees);

  const A =
    Math.cos(dec) * Math.sin(ra + zeta);

  const B =
    Math.cos(theta) *
      Math.cos(dec) *
      Math.cos(ra + zeta) -
    Math.sin(theta) * Math.sin(dec);

  const C =
    Math.sin(theta) *
      Math.cos(dec) *
      Math.cos(ra + zeta) +
    Math.cos(theta) * Math.sin(dec);

  const newRA = Math.atan2(A, B) + z;
  const newDec = Math.asin(clamp(C, -1, 1));

  return {
    ra: norm360(deg(newRA)) / 15,
    dec: deg(newDec)
  };
}

/* ==========================================================
   RÉFRACTION ATMOSPHÉRIQUE APPROXIMATIVE

   Retourne la correction d'altitude en degrés.
   Le modèle est limité aux altitudes supérieures à -1°.
   Il dépend des conditions atmosphériques et reste
   approximatif près de l'horizon.
   ========================================================== */

export function atmosphericRefraction(
  altitudeDegrees,
  pressureHpa = 1010,
  temperatureC = 10
) {
  if (
    !Number.isFinite(altitudeDegrees) ||
    !Number.isFinite(pressureHpa) ||
    !Number.isFinite(temperatureC) ||
    pressureHpa <= 0 ||
    temperatureC <= -273.15 ||
    altitudeDegrees < -1 ||
    altitudeDegrees >= 90
  ) {
    return 0;
  }

  // Formule de Bennett : angle en degrés.
  const h = altitudeDegrees;

  const denominator =
    Math.tan(rad(h + 10.3 / (h + 5.11)));

  if (!Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }

  const arcminutes =
    1.02 / denominator *
    (pressureHpa / 1010) *
    (283 / (273 + temperatureC));

  return clamp(arcminutes / 60, 0, 1);
}

/* ==========================================================
   COORDONNÉES ÉQUATORIALES VERS HORIZONTALES

   Options :
     epoch: "date" (défaut) ou "J2000"
     refraction: false (défaut) ou true
     pressureHpa: pression atmosphérique en hPa
     temperatureC: température en °C

   Avec epoch: "J2000", les coordonnées sont précessées
   vers l'équinoxe moyen de la date avant conversion.
   ========================================================== */

export function equatorialToHorizontal(
  raHours,
  decDegrees,
  date,
  latitude,
  longitude,
  options = {}
) {
  if (
    !Number.isFinite(raHours) ||
    !Number.isFinite(decDegrees) ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    !(date instanceof Date) ||
    !Number.isFinite(date.getTime()) ||
    latitude < -90 ||
    latitude > 90 ||
    decDegrees < -90 ||
    decDegrees > 90
  ) {
    return {
      az: NaN,
      alt: NaN
    };
  }

  let ra = norm360(raHours * 15) / 15;
  let decValue = decDegrees;

  if (options.epoch === "J2000") {
    const corrected = precessJ2000(ra, decValue, date);

    if (!corrected) {
      return {
        az: NaN,
        alt: NaN
      };
    }

    ra = corrected.ra;
    decValue = corrected.dec;
  }

  const lst = localSiderealTime(date, longitude);
  const H = rad(norm180(lst - ra * 15));
  const dec = rad(decValue);
  const lat = rad(latitude);

  const sinAlt =
    Math.sin(lat) * Math.sin(dec) +
    Math.cos(lat) * Math.cos(dec) * Math.cos(H);

  const altitude = Math.asin(clamp(sinAlt, -1, 1));

  const azimuth = Math.atan2(
    -Math.sin(H) * Math.cos(dec),
    Math.sin(dec) * Math.cos(lat) -
      Math.cos(dec) * Math.sin(lat) * Math.cos(H)
  );

  let altDegrees = deg(altitude);

  if (options.refraction === true) {
    altDegrees += atmosphericRefraction(
      altDegrees,
      options.pressureHpa ?? 1010,
      options.temperatureC ?? 10
    );
  }

  return {
    az: norm360(deg(azimuth)),
    alt: altDegrees
  };
}
