"use strict";

import { t } from "./i18n.js";

export function createSolarSystem({
  state,
  norm360
}) {
  // La description des corps est stable : on la construit une seule fois,
  // au premier calcul où Astronomy Engine est disponible.
  let solarSystemBodies = null;

  function makeSolarSystem(date) {
    const A = window.Astronomy;

    if (
      !A ||
      !A.Observer ||
      !A.Equator ||
      !A.Horizon ||
      !A.Body
    ) {
      console.error(
        "[Atlas] Astronomy Engine est absent ou son API est incomplète."
      );
      return [];
    }

    const observer = new A.Observer(
      state.latitude,
      state.longitude,
      0
    );

    if (!solarSystemBodies) {
      solarSystemBodies = [
          {
            planetId: "sun",
            nameKey: "names.planet.sun",
            body: A.Body.Sun,
            type: "sun",
            mag: -26.74
          },
          {
            planetId: "moon",
            nameKey: "names.planet.moon",
            body: A.Body.Moon,
            type: "moon",
            mag: -12
          },
          {
            planetId: "mercury",
            nameKey: "names.planet.mercury",
            body: A.Body.Mercury,
            type: "planet",
            mag: 0
          },
          {
            planetId: "venus",
            nameKey: "names.planet.venus",
            body: A.Body.Venus,
            type: "planet",
            mag: -4
          },
          {
            planetId: "mars",
            nameKey: "names.planet.mars",
            body: A.Body.Mars,
            type: "planet",
            mag: 1
          },
          {
            planetId: "jupiter",
            nameKey: "names.planet.jupiter",
            body: A.Body.Jupiter,
            type: "planet",
            mag: -2
          },
          {
            planetId: "saturn",
            nameKey: "names.planet.saturn",
            body: A.Body.Saturn,
            type: "planet",
            mag: 1
          },
          {
            planetId: "uranus",
            nameKey: "names.planet.uranus",
            body: A.Body.Uranus,
            type: "planet",
            mag: 5.7
          },
          {
            planetId: "neptune",
            nameKey: "names.planet.neptune",
            body: A.Body.Neptune,
            type: "planet",
            mag: 7.8
          }
      ];
    }

    const result = [];

    for (const item of solarSystemBodies) {
      try {
        if (item.body === undefined) {
          console.warn(
            `[Atlas] Corps absent dans Astronomy Engine : ${t(item.nameKey)}`
          );
          continue;
        }

        const equ = A.Equator(
          item.body,
          date,
          observer,
          true,
          true
        );

        if (
          !equ ||
          !Number.isFinite(equ.ra) ||
          !Number.isFinite(equ.dec)
        ) {
          console.warn(
            `[Atlas] Coordonnées équatoriales invalides : ${t(item.nameKey)}`,
            equ
          );
          continue;
        }

        // Le pilote INDIGO reçoit MOUNT_EQUATORIAL_COORDINATES en J2000.
        // Conserver séparément ces coordonnées pour le GOTO sans modifier
        // les coordonnées équinoxe-de-date utilisées par l'affichage du ciel.
        const equJ2000 = A.Equator(
          item.body,
          date,
          observer,
          false,
          true
        );

        const hor = A.Horizon(
          date,
          observer,
          equ.ra,
          equ.dec,
          "normal"
        );

        if (
          !hor ||
          !Number.isFinite(hor.azimuth) ||
          !Number.isFinite(hor.altitude)
        ) {
          console.warn(
            `[Atlas] Coordonnées horizontales invalides : ${t(item.nameKey)}`,
            hor
          );
          continue;
        }

        result.push({
          ...item,
          name: t(item.nameKey),
          ra: equ.ra,
          dec: equ.dec,
          raJ2000: Number.isFinite(equJ2000?.ra) ? equJ2000.ra : NaN,
          decJ2000: Number.isFinite(equJ2000?.dec) ? equJ2000.dec : NaN,
          az: norm360(hor.azimuth),
          alt: hor.altitude
        });
      } catch (error) {
        console.error(
          `[Atlas] Erreur de calcul pour ${t(item.nameKey)} :`,
          error
        );
      }
    }

    return result;
  }

  return { makeSolarSystem };
}
