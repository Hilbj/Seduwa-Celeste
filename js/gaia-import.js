import { propagateProperMotionJ2000 } from './astronomy.js';

const REQUIRED = ['source_id', 'ra', 'dec', 'pmra', 'pmdec', 'ref_epoch'];

function parseCsvLine(line) {
  const fields = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      fields.push(value); value = '';
    } else value += ch;
  }
  fields.push(value);
  return fields;
}

export function parseGaiaCsv(csv) {
  if (typeof csv !== 'string' || !csv.trim()) throw new Error('CSV Gaia vide.');
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  const headers = parseCsvLine(lines.shift()).map(h => h.trim());
  const missing = REQUIRED.filter(name => !headers.includes(name));
  if (missing.length) throw new Error(`Colonnes Gaia manquantes : ${missing.join(', ')}`);
  return lines.map((line, index) => {
    const values = parseCsvLine(line);
    const row = Object.fromEntries(headers.map((header, i) => [header, values[i]?.trim() ?? '']));
    const parsed = { source_id: row.source_id, ra: Number(row.ra), dec: Number(row.dec), pmra: Number(row.pmra), pmdec: Number(row.pmdec), ref_epoch: Number(row.ref_epoch), line: index + 2 };
    if (!/^\d+$/.test(parsed.source_id) || !Number.isFinite(parsed.ra) || parsed.ra < 0 || parsed.ra >= 360 || !Number.isFinite(parsed.dec) || parsed.dec < -90 || parsed.dec > 90 || !Number.isFinite(parsed.pmra) || !Number.isFinite(parsed.pmdec) || !Number.isFinite(parsed.ref_epoch) || parsed.ref_epoch < 1900 || parsed.ref_epoch > 2200) {
      throw new Error(`Ligne CSV ${parsed.line} : données astrométriques invalides.`);
    }
    return parsed;
  });
}

/**
 * Applique les solutions astrométriques Gaia DR3 aux étoiles appariées par source_id.
 * Les positions Gaia (époque ref_epoch, généralement 2016.0) sont propagées vers J2000
 * afin de conserver la convention de coordonnées du catalogue Atlas. Le modèle est
 * linéaire tangent et n'utilise pas la parallaxe ni la vitesse radiale.
 */
export function applyGaiaDr3Rows(stars, rows) {
  if (!Array.isArray(stars) || !Array.isArray(rows)) throw new TypeError('Les étoiles et lignes Gaia doivent être des tableaux.');
  const bySource = new Map();
  for (const row of rows) {
    if (bySource.has(String(row.source_id))) throw new Error(`source_id Gaia dupliqué : ${row.source_id}`);
    bySource.set(String(row.source_id), row);
  }
  const matched = [];
  const updated = stars.map(star => {
    const row = bySource.get(String(star.gaia_source_id ?? ''));
    if (!row) return star;
    const dateJ2000 = new Date('2000-01-01T12:00:00Z');
    const j2000 = propagateProperMotionJ2000(row.ra / 15, row.dec, row.pmra, row.pmdec, dateJ2000, row.ref_epoch);
    if (!j2000) throw new Error(`Propagation impossible pour source_id ${row.source_id}`);
    matched.push(star.id);
    return {
      ...star,
      ra: j2000.ra,
      dec: j2000.dec,
      pm_ra_cosdec_mas_yr: row.pmra,
      pm_dec_mas_yr: row.pmdec,
      astrometry_epoch: 2000,
      gaia_reference_epoch: row.ref_epoch,
      astrometry_source: 'Gaia DR3 (ICRS); position propagated to J2000 with linear proper motion'
    };
  });
  return { stars: updated, matchedIds: matched, unmatchedRows: rows.filter(row => !stars.some(star => String(star.gaia_source_id ?? '') === String(row.source_id))).map(row => row.source_id) };
}
