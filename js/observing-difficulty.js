"use strict";

import { t } from "./i18n.js";

/**
 * Indication pédagogique de repérage, et non garantie de visibilité.
 * Les magnitudes intégrées des objets diffus ne permettent pas, à elles seules,
 * de prédire leur contraste sur le fond du ciel.
 */
function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function normalizedId(object) {
  return String(object?.id || "").toUpperCase().replace(/\s+/g, "").replace(/\//g, "/");
}


function localizeDifficultyResult(result) {
  if (!result) return result;
  const { labelKey, explanationKey, ...metadata } = result;
  return {
    ...metadata,
    label: labelKey ? t(labelKey) : result.label,
    explanation: explanationKey ? t(explanationKey) : result.explanation
  };
}

function assessObservingDifficultyRaw(object, instrument = "all") {
  const altitude = finiteNumber(object?.alt);
  const magnitude = finiteNumber(object?.mag);
  const hasMagnitude = Number.isFinite(magnitude);
  const type = String(object?.type || (object?.catalogue === "Hipparcos" ? "star" : "deep-sky")).toLowerCase();
  const id = normalizedId(object);
  const equipment = ["eye", "binoculars", "telescope", "all"].includes(instrument) ? instrument : "all";

  if (type === "sun") {
    return {
      level: "challenging",
      labelKey: "ui.difficultyText.label.01",
      explanationKey: "ui.difficultyText.explanation.01"
    };
  }

  if (Number.isFinite(altitude) && altitude < 0) {
    return {
      level: "low",
      labelKey: "ui.difficultyText.label.02",
      explanationKey: "ui.difficultyText.explanation.02"
    };
  }
  if (Number.isFinite(altitude) && altitude < 10) {
    return {
      level: "low",
      labelKey: "ui.veryLowOnHorizon",
      explanationKey: "ui.difficultyText.explanation.03"
    };
  }
  if (Number.isFinite(altitude) && altitude < 15) {
    return {
      level: "low",
      labelKey: "ui.difficultyText.label.03",
      explanationKey: "ui.horizonContrastNote"
    };
  }

  if (type === "moon") {
    return {
      level: "easy",
      labelKey: "ui.difficultyText.label.04",
      explanationKey: "ui.difficultyText.explanation.04"
    };
  }

  if (type === "planet") {
    if (hasMagnitude && magnitude <= 4.5) {
      return {
        level: "easy",
        labelKey: "ui.difficultyText.label.05",
        explanationKey: "ui.difficultyText.explanation.05"
      };
    }
    return {
      level: "medium",
      labelKey: "ui.uncertainVisibility",
      explanationKey: "ui.difficultyText.explanation.06"
    };
  }

  if (type === "dwarf-planet") {
    if (!hasMagnitude) return { level: "variable", labelKey: "ui.difficultyText.label.06", explanationKey: "ui.difficultyText.explanation.07" };
    if (equipment === "eye") return magnitude <= 6.0
      ? { level: "challenging", labelKey: "ui.difficultyText.label.07", explanationKey: "ui.difficultyText.explanation.08" }
      : { level: "challenging", labelKey: "ui.difficultyText.label.08", explanationKey: "ui.difficultyText.explanation.09" };
    if (equipment === "binoculars") return magnitude <= 9.5
      ? { level: "medium", labelKey: "ui.difficultyText.label.09", explanationKey: "ui.difficultyText.explanation.10" }
      : { level: "challenging", labelKey: "ui.difficultyText.label.10", explanationKey: "ui.difficultyText.explanation.11" };
    if (equipment === "telescope") return magnitude <= 12.5
      ? { level: "medium", labelKey: "ui.difficultyText.label.11", explanationKey: "ui.difficultyText.explanation.12" }
      : { level: "challenging", labelKey: "ui.difficultyText.label.12", explanationKey: "ui.difficultyText.explanation.13" };
    return { level: magnitude <= 9.5 ? "medium" : "challenging", labelKey: magnitude <= 9.5 ? "ui.difficultyText.label.42" : "ui.difficultyText.label.43", explanationKey: "ui.difficultyText.explanation.14" };
  }

  if (type === "minor-planet") {
    if (!hasMagnitude) {
      return { level: "variable", labelKey: "ui.difficultyText.label.06", explanationKey: "ui.difficultyText.explanation.15" };
    }
    if (equipment === "eye") {
      return magnitude <= 6.0
        ? { level: "challenging", labelKey: "ui.difficultyText.label.13", explanationKey: "ui.difficultyText.explanation.16" }
        : { level: "challenging", labelKey: "ui.difficultyText.label.08", explanationKey: "ui.difficultyText.explanation.17" };
    }
    if (equipment === "binoculars") {
      return magnitude <= 9.5
        ? { level: "medium", labelKey: "ui.difficultyText.label.14", explanationKey: "ui.difficultyText.explanation.18" }
        : { level: "challenging", labelKey: "ui.difficultyText.label.10", explanationKey: "ui.difficultyText.explanation.19" };
    }
    if (equipment === "telescope") {
      return magnitude <= 12.5
        ? { level: "medium", labelKey: "ui.difficultyText.label.11", explanationKey: "ui.difficultyText.explanation.20" }
        : { level: "challenging", labelKey: "ui.difficultyText.label.12", explanationKey: "ui.difficultyText.explanation.21" };
    }
    return { level: magnitude <= 9.5 ? "medium" : "challenging", labelKey: magnitude <= 9.5 ? "ui.difficultyText.label.42" : "ui.difficultyText.label.43", explanationKey: "ui.difficultyText.explanation.22" };
  }

  if (type === "star") {
    if (!hasMagnitude) {
      return { level: "variable", labelKey: "ui.difficultyText.label.15", explanationKey: "ui.difficultyText.explanation.23" };
    }

    if (equipment === "eye") {
      if (magnitude <= 2.5) return { level: "easy", labelKey: "ui.difficultyText.label.16", explanationKey: "ui.difficultyText.explanation.24" };
      if (magnitude <= 4.5) return { level: "medium", labelKey: "ui.difficultyText.label.17", explanationKey: "ui.difficultyText.explanation.25" };
      return { level: "challenging", labelKey: "ui.difficultyText.label.18", explanationKey: "ui.difficultyText.explanation.26" };
    }

    if (equipment === "binoculars") {
      if (magnitude <= 5.5) return { level: "easy", labelKey: "ui.difficultyText.label.19", explanationKey: "ui.difficultyText.explanation.27" };
      if (magnitude <= 7) return { level: "medium", labelKey: "ui.difficultyText.label.20", explanationKey: "ui.difficultyText.explanation.28" };
      return { level: "challenging", labelKey: "ui.difficultyText.label.21", explanationKey: "ui.difficultyText.explanation.29" };
    }

    if (equipment === "telescope") {
      if (magnitude <= 8) return { level: "easy", labelKey: "ui.difficultyText.label.22", explanationKey: "ui.difficultyText.explanation.30" };
      if (magnitude <= 12) return { level: "medium", labelKey: "ui.difficultyText.label.23", explanationKey: "ui.difficultyText.explanation.31" };
      return { level: "challenging", labelKey: "ui.difficultyText.label.24", explanationKey: "ui.difficultyText.explanation.32" };
    }

    if (magnitude <= 2.5) return { level: "easy", labelKey: "ui.difficultyText.label.25", explanationKey: "ui.difficultyText.explanation.33" };
    if (magnitude <= 5) return { level: "medium", labelKey: "ui.difficultyText.label.26", explanationKey: "ui.difficultyText.explanation.34" };
    return { level: "challenging", labelKey: "ui.difficultyText.label.27", explanationKey: "ui.difficultyText.explanation.35" };
  }

  if (type === "cluster") {
    if (!hasMagnitude) {
      return { level: "variable", labelKey: "ui.difficultyText.label.28", explanationKey: "ui.difficultyText.explanation.36" };
    }
    if (equipment === "eye") {
      if (magnitude <= 4) return { level: "medium", labelKey: "ui.difficultyText.label.29", explanationKey: "ui.difficultyText.explanation.37" };
      return { level: "challenging", labelKey: "ui.difficultyText.label.18", explanationKey: "ui.difficultyText.explanation.38" };
    }
    if (equipment === "binoculars") {
      if (magnitude <= 7.5) return { level: magnitude <= 5.5 ? "easy" : "medium", labelKey: magnitude <= 5.5 ? "ui.difficultyText.label.44" : "ui.difficultyText.label.45", explanationKey: "ui.difficultyText.explanation.39" };
      return { level: "challenging", labelKey: "ui.difficultyText.label.30", explanationKey: "ui.difficultyText.explanation.40" };
    }
    if (equipment === "telescope") {
      if (magnitude <= 8.5) return { level: "easy", labelKey: "ui.difficultyText.label.31", explanationKey: "ui.difficultyText.explanation.41" };
      if (magnitude <= 10.5) return { level: "medium", labelKey: "ui.difficultyText.label.32", explanationKey: "ui.difficultyText.explanation.42" };
      return { level: "challenging", labelKey: "ui.difficultyText.label.33", explanationKey: "ui.difficultyText.explanation.43" };
    }
    if (magnitude <= 4) return { level: "medium", labelKey: "ui.difficultyText.label.34", explanationKey: "ui.difficultyText.explanation.44" };
    if (magnitude <= 6.5) return { level: "variable", labelKey: "ui.difficultyText.label.35", explanationKey: "ui.difficultyText.explanation.45" };
    return { level: "challenging", labelKey: "ui.difficultyText.label.36", explanationKey: "ui.difficultyText.explanation.46" };
  }

  if (["galaxy", "nebula", "deep-sky"].includes(type)) {
    const knownId = id;
    if (equipment === "eye" && ["M31", "M42"].includes(knownId)) {
      return {
        level: "challenging",
        labelKey: knownId === "M31" ? "ui.difficultyText.label.46" : "ui.difficultyText.label.47",
        explanationKey: knownId === "M31"
          ? "La galaxie d’Andromède peut apparaître comme une faible tache floue si le ciel est très sombre et transparent ; en zone éclairée, elle peut être invisible."
          : "La nébuleuse d’Orion peut se percevoir comme une lueur diffuse, mais pas comme les détails colorés des photographies. La transparence et la pollution lumineuse comptent beaucoup."
      };
    }
    if (equipment === "eye") {
      return {
        level: "challenging",
        labelKey: "ui.difficultyText.label.37",
        explanationKey: "ui.difficultyText.explanation.47"
      };
    }
    if (equipment === "binoculars") {
      return {
        level: "variable",
        labelKey: "ui.difficultyText.label.38",
        explanationKey: "ui.difficultyText.explanation.48"
      };
    }
    if (equipment === "telescope") {
      return {
        level: "variable",
        labelKey: "ui.difficultyText.label.39",
        explanationKey: "ui.difficultyText.explanation.49"
      };
    }
    return {
      level: "variable",
      labelKey: "ui.difficultyText.label.40",
      explanationKey: "ui.difficultyText.explanation.50"
    };
  }

  return {
    level: "variable",
    labelKey: "ui.difficultyText.label.41",
    explanationKey: "ui.difficultyText.explanation.51"
  };
}

export function assessObservingDifficulty(object, instrument = "all") {
  return localizeDifficultyResult(assessObservingDifficultyRaw(object, instrument));
}
