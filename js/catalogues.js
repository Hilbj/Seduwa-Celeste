import { t } from "./i18n.js";
"use strict";

/* ============================================================
   ATLAS CÉLESTE — catalogues.js
   Chargement et normalisation des catalogues JSON.
   ============================================================ */

function number(value, fallback = NaN) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return fallback;
  }

  const n = Number(value);

  return Number.isFinite(n) ? n : fallback;
}

function cleanName(value) {
  return String(value ?? "").trim();
}

export function nameKey(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(
      /^(alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|omicron|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega)\s+/i,
      ""
    )
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchJson(path, optional = false) {
  const response = await fetch(path, {
    cache: "no-cache"
  });

  if (!response.ok) {
    if (optional && response.status === 404) {
      return null;
    }

    throw new Error(`${path} : HTTP ${response.status}`);
  }

  return response.json();
}

export function extractRows(data, keys) {
  if (Array.isArray(data)) {
    return data;
  }

  for (const key of keys) {
    if (Array.isArray(data?.[key])) {
      return data[key];
    }
  }

  return [];
}

export function normalizeStar(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const ra = number(
    raw.raHours ??
    raw.ra_hours ??
    raw.ra ??
    raw.RA
  );

  const dec = number(
    raw.decDegrees ??
    raw.dec ??
    raw.Dec ??
    raw.DEC ??
    raw.declination
  );

  const mag = number(
    raw.mag ??
    raw.vmag ??
    raw.V ??
    raw.magnitude,
    5
  );

  if (
    !Number.isFinite(ra) ||
    !Number.isFinite(dec) ||
    ra < 0 ||
    ra >= 24 ||
    dec < -90 ||
    dec > 90
  ) {
    return null;
  }

  const name = cleanName(
    raw.name ??
    raw.proper_name ??
    raw.properName ??
    raw.designation ??
    raw.id
  );

  return {
    ...raw,
    name: name || `${t("ui.starLabel")} ${ra.toFixed(3)}`,
    ra,
    dec,
    mag,
    type: "star"
  };
}

export function normalizeMessier(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const rawId =
    raw.id ??
    raw.messier ??
    raw.M ??
    raw.number ??
    raw.designation;

  const match = String(rawId ?? "")
    .match(/(?:M\s*)?(\d+)/i);

  if (!match) {
    return null;
  }

  const ra = number(
    raw.raHours ??
    raw.ra_hours ??
    raw.ra ??
    raw.RA
  );

  const dec = number(
    raw.dec ??
    raw.Dec ??
    raw.DEC ??
    raw.declination
  );

  if (
    !Number.isFinite(ra) ||
    !Number.isFinite(dec) ||
    ra < 0 ||
    ra >= 24 ||
    dec < -90 ||
    dec > 90
  ) {
    return null;
  }

  const id = `M${Number(match[1])}`;
  const rawType = String(raw.type ?? "").toLowerCase();

  let type = "cluster";

  if (rawType.includes("gal")) {
    type = "galaxy";
  } else if (rawType.includes("neb")) {
    type = "nebula";
  }

  return {
    ...raw,
    id,
    name: cleanName(raw.name) || id,
    ra,
    dec,
    mag: number(raw.mag ?? raw.magnitude, 8),
    type
  };
}

export function normalizeConstellation(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const name = cleanName(
    raw.name ??
    raw.nom ??
    raw.iau ??
    raw.id
  );

  if (!name) {
    return null;
  }

  let rawLines =
    raw.lines ??
    raw.line ??
    raw.segments ??
    [];

  if (
    !rawLines.length &&
    Array.isArray(raw.stars)
  ) {
    rawLines = [];

    for (
      let i = 0;
      i < raw.stars.length - 1;
      i++
    ) {
      rawLines.push([
        raw.stars[i],
        raw.stars[i + 1]
      ]);
    }
  }

  const lines = [];

  for (const line of rawLines) {
    let a;
    let b;

    if (Array.isArray(line) && line.length >= 2) {
      [a, b] = line;
    } else if (
      line &&
      typeof line === "object"
    ) {
      a = line.from ?? line.start ?? line.a ?? line[0];
      b = line.to ?? line.end ?? line.b ?? line[1];
    }

    if (a == null || b == null) {
      continue;
    }

    lines.push([
      String(a),
      String(b)
    ]);
  }

  return {
    // L'identifiant IAU (And, Cas, UMa...) est indispensable au sélecteur
    // pédagogique et à la mise en évidence de la figure sur la carte.
    id: cleanName(raw.id ?? raw.iau ?? ""),
    name,
    name_fr: cleanName(raw.name_fr ?? raw.nom_fr ?? raw.name ?? raw.nom ?? name),
    englishName: cleanName(raw.englishName ?? raw.english_name ?? raw.name_en ?? ""),
    color: cleanName(raw.color) || "#91bfff",
    lines
  };
}
