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
            name: t("names.planet.sun"),
            body: A.Body.Sun,
            type: "sun",
            mag: -26.74
          },
          {
            name: t("names.planet.moon"),
            body: A.Body.Moon,
            type: "moon",
            mag: -12
          },
          {
            name: t("names.planet.mercury"),
            body: A.Body.Mercury,
            type: "planet",
            mag: 0
          },
          {
            name: t("names.planet.venus"),
            body: A.Body.Venus,
            type: "planet",
            mag: -4
          },
          {
            name: t("names.planet.mars"),
            body: A.Body.Mars,
            type: "planet",
            mag: 1
          },
          {
            name: t("names.planet.jupiter"),
            body: A.Body.Jupiter,
            type: "planet",
            mag: -2
          },
          {
            name: t("names.planet.saturn"),
            body: A.Body.Saturn,
            type: "planet",
            mag: 1
          },
          {
            name: t("names.planet.uranus"),
            body: A.Body.Uranus,
            type: "planet",
            mag: 5.7
          },
          {
            name: t("names.planet.neptune"),
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
            `[Atlas] Corps absent dans Astronomy Engine : ${item.name}`
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
            `[Atlas] Coordonnées équatoriales invalides : ${item.name}`,
            equ
          );
          continue;
        }

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
            `[Atlas] Coordonnées horizontales invalides : ${item.name}`,
            hor
          );
          continue;
        }

        result.push({
          ...item,
          ra: equ.ra,
          dec: equ.dec,
          az: norm360(hor.azimuth),
          alt: hor.altitude
        });
      } catch (error) {
        console.error(
          `[Atlas] Erreur de calcul pour ${item.name} :`,
          error
        );
      }
    }

    return result;
  }

  return { makeSolarSystem };
}
