/**
 * Estimation analytique des événements de lever, culmination et coucher.
 * Le seuil de franchissement est fixé à -0,566° (convention apparente simplifiée).
 * Les heures sont locales à l'appareil ; le fuseau du lieu d'observation n'est
 * pas déduit automatiquement des coordonnées géographiques.
 */
export function calculateRiseTransitSet(object, date, latitude, longitude, locale = "fr") {
  if (!object || !Number.isFinite(object.ra) || object.ra < 0 || object.ra >= 24 ||
      !Number.isFinite(object.dec) || object.dec < -90 || object.dec > 90 ||
      !(date instanceof Date) || !Number.isFinite(date.getTime()) ||
      !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;

  const localMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const jd = d => d.getTime() / 86400000 + 2440587.5;
  const gmstHours = d => {
    const j = jd(d), t = (j - 2451545.0) / 36525;
    return (((280.46061837 + 360.98564736629 * (j - 2451545) + 0.000387933 * t * t - t * t * t / 38710000) / 15) % 24 + 24) % 24;
  };
  const siderealRate = 1.00273790935; // heures sidérales par heure civile moyenne
  const lst0 = (gmstHours(localMidnight) + longitude / 15 + 24) % 24;
  const ra = ((object.ra % 24) + 24) % 24;
  const dec = object.dec * Math.PI / 180;
  const phi = latitude * Math.PI / 180;
  const thresholdAltitudeDeg = -0.566;
  const threshold = thresholdAltitudeDeg * Math.PI / 180;
  const numerator = Math.sin(threshold) - Math.sin(phi) * Math.sin(dec);
  const denominator = Math.cos(phi) * Math.cos(dec);
  const cosH = Math.abs(denominator) < 1e-12
    ? (numerator > 0 ? Infinity : -Infinity)
    : numerator / denominator;

  // Le transit est choisi dans la journée civile sélectionnée (ou juste après
  // minuit si nécessaire), puis lever/coucher sont calculés autour de celui-ci.
  const transitSiderealHours = ((ra - lst0) % 24 + 24) % 24;
  const transitCivilHours = transitSiderealHours / siderealRate;
  const eventDate = civilHours => new Date(localMidnight.getTime() + civilHours * 3600000);
  const transitDate = eventDate(transitCivilHours);
  const dateKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const dayNumber = d => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000;
  const dayOffset = d => Math.round(dayNumber(d) - dayNumber(localMidnight));
  const daySuffix = offset => offset < 0 ? ` (${locale === "en" ? "previous day" : "veille"})` : offset > 0 ? ` (${locale === "en" ? "next day" : "lendemain"})` : "";
  const formatEvent = d => d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) + daySuffix(dayOffset(d));
  const base = {
    thresholdAltitudeDeg,
    method: "analytique",
    transitDate: dateKey(transitDate),
    transitDayOffset: dayOffset(transitDate),
    transitTime: transitDate.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  };

  if (cosH > 1) {
    return { ...base, belowHorizon: true, rise: locale === "en" ? "Does not rise today" : "Ne se lève pas ce jour", transit: locale === "en" ? "Below the horizon" : "Sous l’horizon", set: locale === "en" ? "Does not set today" : "Ne se couche pas ce jour", riseDate: null, setDate: null, riseDayOffset: null, setDayOffset: null };
  }
  if (cosH < -1) {
    return { ...base, belowHorizon: false, rise: locale === "en" ? "Circumpolar" : "Circumpolaire", transit: formatEvent(transitDate), set: locale === "en" ? "Circumpolar" : "Circumpolaire", riseDate: null, setDate: dateKey(transitDate), riseDayOffset: null, setDayOffset: null };
  }

  const hourAngleHours = Math.acos(Math.max(-1, Math.min(1, cosH))) * 12 / Math.PI;
  const riseDate = eventDate(transitCivilHours - hourAngleHours / siderealRate);
  const setDate = eventDate(transitCivilHours + hourAngleHours / siderealRate);
  return {
    ...base,
    belowHorizon: false,
    rise: formatEvent(riseDate),
    transit: formatEvent(transitDate),
    set: formatEvent(setDate),
    riseDate: dateKey(riseDate),
    riseDayOffset: dayOffset(riseDate),
    riseTime: riseDate.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    setDate: dateKey(setDate),
    setDayOffset: dayOffset(setDate),
    setTime: setDate.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  };
}
