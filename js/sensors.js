
"use strict";

export function createSensors({
  state,
  $,
  showToast,
  drawSky,
  clamp,
  norm360,
  norm180,
  rad,
  deg
}) {
  // Filtrage adaptatif du cap : stabiliser les petites fluctuations à l'arrêt,
  // tout en conservant une réponse rapide dès qu'une rotation franche commence.
  const HEADING_SMOOTHING_STILL_MS = 220;
  const HEADING_SMOOTHING_SMALL_MOVE_MS = 150;
  const HEADING_SMOOTHING_MEDIUM_MOVE_MS = 85;
  const HEADING_SMOOTHING_TIME_MS = 35;
  // Zone morte avec hystérésis : ignorer les petites dérives tant qu'un
  // mouvement cohérent du téléphone n'est pas détecté.
  const HEADING_STILL_DEADBAND_DEG = 1.0;
  const HEADING_MOTION_CONFIRM_SAMPLES = 4;
  const HEADING_MOTION_CONFIRM_DEG = 0.55;
  const HEADING_FAST_MOTION_DEG = 2.5;
  const HEADING_MOTION_TIMEOUT_MS = 350;
  // Le gyroscope sert de confirmation indépendante du mouvement : le cap
  // magnétique seul peut dériver alors que le téléphone est immobile.
  const GYRO_ROTATION_THRESHOLD_DPS = 1.8;
  const GYRO_STILL_RESET_DPS = 0.8;
  const GYRO_MOTION_CONFIRM_SAMPLES = 2;
  const GYRO_MOTION_HOLD_MS = 260;
  // Ne rejeter que les sauts extrêmes du compas ; les grands déplacements horizontaux doivent rester réactifs.
  const HEADING_SPIKE_THRESHOLD_DEG = 60;
  const HEADING_SPIKE_WINDOW_MS = 100;
  const PITCH_SMOOTHING_TIME_MS = 45;
  const SENSOR_TIMEOUT = 2500;

  let renderFrameId = null;
  let lastMotionTime = 0;
  let lastHeadingTime = 0;
  let lastAcceptedHeadingTime = 0;
  let lastGyroMotionTime = 0;
  let gyroMotionSamples = 0;
  let gyroDataSeen = false;

  const activeEvents = new Set();
  let deviceMotionListening = false;
  // Journal de diagnostic local : échantillonnage limité pour garder un fichier léger.
  const sensorLog = window.__atlasSensorLog || (window.__atlasSensorLog = {
    startedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    records: [],
    dropped: 0
  });
  const lastLogTime = { orientation: 0, motion: 0 };
  function recordSensorLog(kind, data) {
    const now = performance.now();
    if (now - (lastLogTime[kind] || 0) < 50) return;
    lastLogTime[kind] = now;
    const row = {
      elapsed_ms: Math.round(now),
      wall_time: new Date().toISOString(),
      kind,
      ...data
    };
    if (sensorLog.records.length < 12000) sensorLog.records.push(row);
    else sensorLog.dropped++;
    window.dispatchEvent(new CustomEvent("atlas-sensor-log-updated", {
      detail: { count: sensorLog.records.length, dropped: sensorLog.dropped }
    }));
  }

  function handleDeviceMotion(event) {
    const rate = event.rotationRate;
    if (!rate) return;
    const values = [rate.alpha, rate.beta, rate.gamma];
    if (!values.some(Number.isFinite)) return;
    gyroDataSeen = true;
    const magnitude = Math.hypot(...values.map(v => Number.isFinite(v) ? v : 0));
    const now = performance.now();
    state.gyroDataSeen = true;
    state.gyroRateAlpha = Number.isFinite(rate.alpha) ? rate.alpha : null;
    state.gyroRateBeta = Number.isFinite(rate.beta) ? rate.beta : null;
    state.gyroRateGamma = Number.isFinite(rate.gamma) ? rate.gamma : null;
    state.gyroRateMagnitude = magnitude;
    state.gyroLastUpdate = now;
    // Une pointe isolée du gyroscope ne suffit pas à déclarer une rotation.
    // Deux mesures consécutives sont requises, et une vitesse basse réinitialise
    // immédiatement la confirmation afin qu'un ancien pic ne prolonge pas l'état.
    if (magnitude >= GYRO_ROTATION_THRESHOLD_DPS) {
      gyroMotionSamples++;
      if (gyroMotionSamples >= GYRO_MOTION_CONFIRM_SAMPLES) {
        lastGyroMotionTime = now;
      }
    } else if (magnitude <= GYRO_STILL_RESET_DPS) {
      gyroMotionSamples = 0;
    }
    state.gyroMotionActive = gyroMotionSamples >= GYRO_MOTION_CONFIRM_SAMPLES &&
      now - lastGyroMotionTime <= GYRO_MOTION_HOLD_MS;
    recordSensorLog("motion", {
      alpha_dps: Number.isFinite(rate.alpha) ? rate.alpha : null,
      beta_dps: Number.isFinite(rate.beta) ? rate.beta : null,
      gamma_dps: Number.isFinite(rate.gamma) ? rate.gamma : null,
      magnitude_dps: magnitude,
      gyro_samples: gyroMotionSamples,
      gyro_motion_active: state.gyroMotionActive,
      heading_raw_deg: Number.isFinite(state.rawHeading) ? state.rawHeading : null,
      heading_filtered_deg: Number.isFinite(state.heading) ? state.heading : null,
      heading_decision: state.headingDecision || "inactif"
    });
  }

  let lastAbsoluteHeadingTime = 0;
  let lastDeviceOrientationAbsoluteTime = 0;
  let lastAbsoluteEventLogTime = 0;
  let headingSamples = 0;
  let pitchSamples = 0;
  let headingMotionDirection = 0;
  let headingMotionSamples = 0;
  let headingMotionStart = null;
  let headingMotionLastTime = 0;
  let activationId = 0;

  function getScreenAngle() {
    const orientation = window.screen?.orientation;

    if (orientation && Number.isFinite(orientation.angle)) {
      return norm360(orientation.angle);
    }

    if (Number.isFinite(window.orientation)) {
      return norm360(window.orientation);
    }

    return 0;
  }

  function setStatus(message) {
    const element = $("status");

    if (element) {
      element.textContent = message;
    }
  }

  function scheduleDraw() {
    // Un seul rendu en attente, même si plusieurs événements
    // capteurs arrivent avant la prochaine image.
    if (renderFrameId !== null) {
        return;
    }

    renderFrameId = window.requestAnimationFrame(() => {
        renderFrameId = null;

        drawSky();
    });
    }

  function circularSmooth(current, target, factor) {
    return norm360(
      current + norm180(target - current) * factor
    );
  }

  /*
   * webkitCompassHeading est spécifique notamment à Safari iOS.
   * event.alpha seul n'est absolu que si le navigateur le garantit.
   */
  function getHeading(event) {
    // Safari peut signaler une boussole invalide avec une précision négative.
    // Ne pas traiter ce cap comme une mesure absolue exploitable.
    if (
      Number.isFinite(event.webkitCompassAccuracy) &&
      event.webkitCompassAccuracy < 0
    ) {
      return null;
    }

    if (Number.isFinite(event.webkitCompassHeading)) {
      return {
        value: norm360(event.webkitCompassHeading),
        absolute: true,
        source: "webkitCompassHeading"
      };
    }

    if (!Number.isFinite(event.alpha)) {
      return null;
    }

    const absolute =
      event.type === "deviceorientationabsolute" ||
      event.absolute === true;

    if (!absolute) {
      return null;
    }

    // alpha seul décrit la rotation d'Euler autour de l'axe vertical, pas
    // nécessairement l'azimut de la normale à l'écran. Quand le téléphone
    // est incliné près de l'horizon, cette approximation fait varier le cap
    // pendant un simple mouvement haut/bas. Projeter la normale de l'écran
    // dans le plan horizontal à partir de la rotation complète alpha/beta/gamma.
    let value = norm360(360 - event.alpha);
    let source = event.type === "deviceorientationabsolute"
      ? "deviceorientationabsolute.alpha"
      : "deviceorientation.alpha";

    if (Number.isFinite(event.beta) && Number.isFinite(event.gamma)) {
      const alphaR = rad(event.alpha);
      const betaR = rad(event.beta);
      const gammaR = rad(event.gamma);
      // Normale à l'écran dans le repère terrestre (convention DeviceOrientation).
      const normalEast =
        Math.cos(alphaR) * Math.sin(gammaR) +
        Math.sin(alphaR) * Math.sin(betaR) * Math.cos(gammaR);
      const normalNorth =
        Math.sin(alphaR) * Math.sin(gammaR) -
        Math.cos(alphaR) * Math.sin(betaR) * Math.cos(gammaR);
      const horizontalNorm = Math.hypot(normalEast, normalNorth);

      // À proximité de la verticale, la projection horizontale de la normale
      // à l'écran devient presque nulle : son azimut n'est plus défini. Basculer
      // alors vers alpha peut provoquer une rotation soudaine de la carte alors
      // que le téléphone bouge à peine. Une fois un cap exploitable acquis,
      // conserver le dernier cap filtré jusqu'à ce que la projection redevienne
      // fiable. Au tout premier échantillon, alpha reste un secours pour permettre
      // l'initialisation même si le téléphone est déjà presque vertical.
      if (horizontalNorm > 0.15) {
        value = norm360(deg(Math.atan2(-normalEast, -normalNorth)));
        source += ".projection_ecran";
      } else if (headingSamples > 0 && Number.isFinite(state.heading)) {
        return null;
      }
    }

    return { value, absolute: true, source };
  }

  function getPitch(event) {
    if (
      !Number.isFinite(event.beta) ||
      !Number.isFinite(event.gamma)
    ) {
      return null;
    }

    const angle = getScreenAngle();
    const betaR = rad(event.beta);
    const gammaR = rad(event.gamma);

    let pitch;

    if (angle === 90 || angle === 270) {
      const sign = angle === 90 ? 1 : -1;
      pitch = -sign * deg(
        Math.asin(
          clamp(
            Math.cos(betaR) * Math.sin(gammaR),
            -1,
            1
          )
        )
      );
    } else {
      pitch = -deg(
        Math.asin(
          clamp(
            Math.cos(betaR) * Math.cos(gammaR),
            -1,
            1
          )
        )
      );
    }

    // Le cap est calculé à partir de l'opposé de la normale à l'écran ;
    // l'inclinaison doit donc employer elle aussi la composante verticale opposée.
    // Ainsi heading et pitch décrivent une seule direction caméra cohérente.
    return clamp(pitch, -90, 90);
  }


function handleOrientation(event) {
  const now = performance.now();
  let heading = getHeading(event);
  const candidateHeading = heading;
  const pitch = getPitch(event);
  let headingIgnoredReason = heading ? "" : (
    Number.isFinite(event.webkitCompassAccuracy) && event.webkitCompassAccuracy < 0
      ? "precision_boussole_invalide"
      : !Number.isFinite(event.alpha) && !Number.isFinite(event.webkitCompassHeading)
        ? "aucun_alpha_ni_cap_webkit"
        : event.type !== "deviceorientationabsolute" && event.absolute !== true && !Number.isFinite(event.webkitCompassHeading)
          ? "alpha_non_absolu"
          : "cap_non_exploitable"
  );
  let absoluteLockAgeMs = lastDeviceOrientationAbsoluteTime > 0
    ? Math.round(now - lastDeviceOrientationAbsoluteTime)
    : null;

  // Certains navigateurs Android émettent les deux événements avec
  // des caps légèrement différents. Verrouiller la source absolue tant
  // qu'elle reçoit des données, sinon la carte peut faire des sauts
  // quand les deux flux alternent. L'inclinaison reste lue des deux flux.
  if (event.type === "deviceorientationabsolute") {
    lastDeviceOrientationAbsoluteTime = now;
    absoluteLockAgeMs = 0;
  } else if (
    event.type === "deviceorientation" &&
    lastDeviceOrientationAbsoluteTime > 0 &&
    now - lastDeviceOrientationAbsoluteTime < 2500
  ) {
    heading = null;
    headingIgnoredReason = "flux_standard_bloque_apres_absolu";
  }

  const orientationDiagnostic = {
    event_type: event.type || "inconnu",
    event_absolute_flag: event.absolute === true,
    alpha_deg: Number.isFinite(event.alpha) ? event.alpha : null,
    candidate_heading_deg: Number.isFinite(candidateHeading?.value) ? candidateHeading.value : null,
    candidate_heading_source: candidateHeading?.source || null,
    candidate_heading_absolute: candidateHeading?.absolute === true,
    heading_used_for_filter: !!heading,
    heading_ignored_reason: heading ? null : headingIgnoredReason,
    absolute_lock_age_ms: absoluteLockAgeMs,
    absolute_lock_active: lastDeviceOrientationAbsoluteTime > 0 && now - lastDeviceOrientationAbsoluteTime < 2500,
    time_since_previous_absolute_ms: event.type === "deviceorientationabsolute" && lastAbsoluteEventLogTime > 0
      ? Math.round(now - lastAbsoluteEventLogTime)
      : null,
    last_accepted_heading_source: state.headingSource || null
  };
  if (event.type === "deviceorientationabsolute") lastAbsoluteEventLogTime = now;

  if (!heading && pitch === null) {
    recordSensorLog("orientation", {
      ...orientationDiagnostic,
      beta_deg: Number.isFinite(event.beta) ? event.beta : null,
      gamma_deg: Number.isFinite(event.gamma) ? event.gamma : null,
      pitch_deg: null,
      heading_raw_deg: Number.isFinite(state.rawHeading) ? state.rawHeading : null,
      heading_filtered_deg: Number.isFinite(state.heading) ? state.heading : null,
      heading_decision: state.headingDecision || "aucun cap exploitable"
    });
    return;
  }

  // Le temps écoulé rend le lissage indépendant
  // de la fréquence des événements du téléphone.
  const dt = lastMotionTime > 0
    ? Math.min(now - lastMotionTime, 100)
    : 16.67;

  lastMotionTime = now;

  const pitchSmoothing = 1 - Math.exp(
    -dt / PITCH_SMOOTHING_TIME_MS
  );

  const wasSensorActive = state.sensorActive;

  if (heading) {
    // Calculer le lissage du cap avec le temps entre mesures de cap,
    // indépendamment des événements d'inclinaison (beta/gamma).
    const headingDt = lastHeadingTime > 0
      ? Math.min(now - lastHeadingTime, 100)
      : 16.67;
    lastHeadingTime = now;
    const previousRawHeading = state.rawHeading;
    const rawHeadingDelta = Number.isFinite(previousRawHeading)
      ? Math.abs(norm180(heading.value - previousRawHeading))
      : 0;
    state.rawHeadingDelta = rawHeadingDelta;
    state.rawHeading = heading.value;
    state.headingSource = heading.source || "cap absolu";

    // Les petites variations d'une mesure à l'autre sont généralement du bruit
    // magnétique. Leur appliquer un lissage plus long stabilise le cap immobile.
    // Dès que l'écart augmente, le temps de lissage diminue par paliers afin de
    // garder la réactivité validée en v361 lors des rotations du téléphone.
    const headingSmoothingTime = rawHeadingDelta < 0.25
      ? HEADING_SMOOTHING_STILL_MS
      : rawHeadingDelta < 0.65
        ? HEADING_SMOOTHING_SMALL_MOVE_MS
        : rawHeadingDelta < 1.4
          ? HEADING_SMOOTHING_MEDIUM_MOVE_MS
          : HEADING_SMOOTHING_TIME_MS;
    const adaptiveHeadingSmoothing = 1 - Math.exp(
      -headingDt / headingSmoothingTime
    );

    const previousFilteredHeading = state.heading;
    const headingDelta = headingSamples > 0
      ? Math.abs(norm180(heading.value - state.heading))
      : 0;
    const signedRawStep = Number.isFinite(previousRawHeading)
      ? norm180(heading.value - previousRawHeading)
      : 0;
    const sinceAccepted = lastAcceptedHeadingTime > 0
      ? now - lastAcceptedHeadingTime
      : Infinity;

    // Confirmer un mouvement par plusieurs petits pas cohérents : une
    // fluctuation isolée ou une lente dérive du capteur ne déplace pas la carte.
    if (Math.abs(signedRawStep) >= 0.08) {
      const direction = Math.sign(signedRawStep);
      if (direction === headingMotionDirection && now - headingMotionLastTime <= HEADING_MOTION_TIMEOUT_MS) {
        headingMotionSamples++;
      } else {
        headingMotionDirection = direction;
        headingMotionSamples = 1;
        headingMotionStart = previousRawHeading;
      }
      headingMotionLastTime = now;
    } else if (now - headingMotionLastTime > HEADING_MOTION_TIMEOUT_MS) {
      headingMotionDirection = 0;
      headingMotionSamples = 0;
      headingMotionStart = null;
    }

    const candidateTravel = Number.isFinite(headingMotionStart)
      ? Math.abs(norm180(heading.value - headingMotionStart))
      : 0;
    const confirmedMotion = headingMotionSamples >= HEADING_MOTION_CONFIRM_SAMPLES &&
      candidateTravel >= HEADING_MOTION_CONFIRM_DEG;
    const gyroConfirmsMotion = !gyroDataSeen || (
      gyroMotionSamples >= GYRO_MOTION_CONFIRM_SAMPLES &&
      now - lastGyroMotionTime <= GYRO_MOTION_HOLD_MS
    );
    // Si le navigateur fournit un gyroscope, les grands écarts du compas ne
    // peuvent pas à eux seuls forcer l'acceptation : c'est précisément ce qui
    // permet d'empêcher la dérive magnétique à l'arrêt. Sans gyroscope, on
    // conserve le comportement de repli basé sur la cohérence du cap.
    const fastMotion = gyroDataSeen
      ? gyroConfirmsMotion
      : headingDelta >= HEADING_FAST_MOTION_DEG || Math.abs(signedRawStep) >= 1.4;

    // Ne rejeter que les sauts extrêmes et très rapprochés.
    const isHeadingSpike = headingSamples > 0 &&
      sinceAccepted < HEADING_SPIKE_WINDOW_MS &&
      headingDelta > HEADING_SPIKE_THRESHOLD_DEG;
    const holdForStability = headingSamples > 0 && (
      (gyroDataSeen && !gyroConfirmsMotion) ||
      (!gyroDataSeen && headingDelta < HEADING_STILL_DEADBAND_DEG &&
        !confirmedMotion && !fastMotion)
    );

    // Diagnostic seulement : mémoriser la décision sans modifier le filtrage.
    state.headingDecision = isHeadingSpike
      ? "rejeté : saut extrême"
      : holdForStability
        ? (gyroDataSeen && !gyroConfirmsMotion
          ? "maintenu : gyroscope sans rotation"
          : "maintenu : zone de stabilité")
        : "accepté";
    state.headingMotionSamples = headingMotionSamples;
    state.headingMotionTravel = candidateTravel;
    state.headingMotionConfirmed = confirmedMotion;
    state.gyroMotionActive = gyroDataSeen &&
      gyroMotionSamples >= GYRO_MOTION_CONFIRM_SAMPLES &&
      now - lastGyroMotionTime <= GYRO_MOTION_HOLD_MS;

    if (!isHeadingSpike && !holdForStability) {
      if (headingSamples === 0) {
        state.heading = heading.value;
      } else {
        state.heading = circularSmooth(
          state.heading,
          heading.value,
          fastMotion ? adaptiveHeadingSmoothing : Math.min(adaptiveHeadingSmoothing, 0.35)
        );
      }
      state.filteredHeadingDelta = Math.abs(norm180(state.heading - previousFilteredHeading));
      lastAcceptedHeadingTime = now;
      headingSamples++;
    } else if (holdForStability) {
      state.filteredHeadingDelta = 0;
    }

    if (!isHeadingSpike) {
    lastAbsoluteHeadingTime = Date.now();
    state.sensorActive = true;
    state.lastOrientationTime = Date.now();

    // Ne modifier le statut que lors de l'activation.
    if (!wasSensorActive) {
      setStatus("Orientation active");
    }
    }
  }

  if (pitch !== null) {
    if (pitchSamples === 0) {
      state.pitch = pitch;
    } else {
      state.pitch +=
        (pitch - state.pitch) * pitchSmoothing;
    }

    pitchSamples++;
    state.lastPitchTime = Date.now();
  }

  state.roll = 0;

  state.orientationSamples =
    (state.orientationSamples || 0) + 1;

  recordSensorLog("orientation", {
    ...orientationDiagnostic,
    alpha_deg: Number.isFinite(event.alpha) ? event.alpha : null,
    beta_deg: Number.isFinite(event.beta) ? event.beta : null,
    gamma_deg: Number.isFinite(event.gamma) ? event.gamma : null,
    absolute: event.absolute === true || event.type === "deviceorientationabsolute",
    compass_heading_deg: Number.isFinite(event.webkitCompassHeading) ? event.webkitCompassHeading : null,
    compass_accuracy_deg: Number.isFinite(event.webkitCompassAccuracy) ? event.webkitCompassAccuracy : null,
    pitch_deg: Number.isFinite(pitch) ? pitch : null,
    heading_source: state.headingSource || "indisponible",
    heading_raw_deg: Number.isFinite(state.rawHeading) ? state.rawHeading : null,
    heading_filtered_deg: Number.isFinite(state.heading) ? state.heading : null,
    raw_delta_deg: Number.isFinite(state.rawHeadingDelta) ? state.rawHeadingDelta : null,
    filtered_delta_deg: Number.isFinite(state.filteredHeadingDelta) ? state.filteredHeadingDelta : null,
    heading_decision: state.headingDecision || "indisponible",
    motion_confirmed: !!state.headingMotionConfirmed,
    motion_samples: state.headingMotionSamples || 0,
    candidate_travel_deg: Number.isFinite(state.headingMotionTravel) ? state.headingMotionTravel : null,
    gyro_data_seen: !!state.gyroDataSeen,
    gyro_alpha_dps: Number.isFinite(state.gyroRateAlpha) ? state.gyroRateAlpha : null,
    gyro_beta_dps: Number.isFinite(state.gyroRateBeta) ? state.gyroRateBeta : null,
    gyro_gamma_dps: Number.isFinite(state.gyroRateGamma) ? state.gyroRateGamma : null,
    gyro_magnitude_dps: Number.isFinite(state.gyroRateMagnitude) ? state.gyroRateMagnitude : null,
    gyro_motion_active: !!state.gyroMotionActive,
    orientation_samples: state.orientationSamples || 0
  });

  // Regrouper les événements dans une seule image.
  scheduleDraw();
}

  function listenTo(eventName) {
    if (activeEvents.has(eventName)) {
      return;
    }

    window.addEventListener(
      eventName,
      handleOrientation,
      true
    );

    activeEvents.add(eventName);
  }


function stopListening() {
  activationId++;

  for (const eventName of activeEvents) {
    window.removeEventListener(
      eventName,
      handleOrientation,
      true
    );
  }

  activeEvents.clear();

  if (renderFrameId !== null) {
    window.cancelAnimationFrame(renderFrameId);
    renderFrameId = null;
  }

  lastAbsoluteHeadingTime = 0;
  lastDeviceOrientationAbsoluteTime = 0;
  lastAbsoluteEventLogTime = 0;
  lastMotionTime = 0;
  lastHeadingTime = 0;
  lastAcceptedHeadingTime = 0;
  lastGyroMotionTime = 0;
  gyroMotionSamples = 0;
  gyroDataSeen = false;
  state.gyroDataSeen = false;
  state.gyroRateAlpha = null;
  state.gyroRateBeta = null;
  state.gyroRateGamma = null;
  state.gyroRateMagnitude = null;
  state.gyroLastUpdate = 0;
  state.gyroMotionActive = false;
  state.headingDecision = "inactif";
  state.headingMotionSamples = 0;
  state.headingMotionTravel = 0;
  state.headingMotionConfirmed = false;
  if (deviceMotionListening) {
    window.removeEventListener("devicemotion", handleDeviceMotion, true);
    deviceMotionListening = false;
  }
  headingSamples = 0;
  pitchSamples = 0;
  headingMotionDirection = 0;
  headingMotionSamples = 0;
  headingMotionStart = null;
  headingMotionLastTime = 0;

  state.orientationListening = false;
  state.sensorActive = false;
  state.lastOrientationTime = 0;
  state.lastPitchTime = 0;

  setStatus("Capteurs désactivés");
  drawSky();
}

  async function enableOrientation() {
    if (state.orientationListening) {
      showToast("Capteurs déjà activés.");
      return;
    }

    if (typeof window.DeviceOrientationEvent === "undefined") {
      showToast(
        "Ce navigateur ne prend pas en charge l'orientation."
      );
      return;
    }

    const currentActivation = ++activationId;

    try {
      const OrientationEvent = window.DeviceOrientationEvent;

      if (typeof OrientationEvent.requestPermission === "function") {
        const permission =
          await OrientationEvent.requestPermission();

        if (currentActivation !== activationId) return;

        if (permission !== "granted") {
          showToast(
            "Autorisation des capteurs refusée. Vérifie les réglages du navigateur."
          );
          return;
        }
      }

      headingSamples = 0;
      pitchSamples = 0;
      headingMotionDirection = 0;
      headingMotionSamples = 0;
      headingMotionStart = null;
      headingMotionLastTime = 0;
      lastAbsoluteHeadingTime = 0;
      lastDeviceOrientationAbsoluteTime = 0;
      lastAbsoluteEventLogTime = 0;
      lastMotionTime = 0;
      lastHeadingTime = 0;
      lastAcceptedHeadingTime = 0;
      lastGyroMotionTime = 0;
      gyroMotionSamples = 0;
      gyroDataSeen = false;
      state.gyroDataSeen = false;
      state.gyroRateAlpha = null;
      state.gyroRateBeta = null;
      state.gyroRateGamma = null;
      state.gyroRateMagnitude = null;
      state.gyroLastUpdate = 0;
      state.gyroMotionActive = false;
      state.headingDecision = "en attente de mesures";
      state.headingMotionSamples = 0;
      state.headingMotionTravel = 0;
      state.headingMotionConfirmed = false;

      state.orientationSamples = 0;
      state.sensorActive = false;
      state.lastOrientationTime = 0;
      state.lastPitchTime = 0;

      listenTo("deviceorientation");
      listenTo("deviceorientationabsolute");
      if (typeof window.DeviceMotionEvent !== "undefined") {
        window.addEventListener("devicemotion", handleDeviceMotion, true);
        deviceMotionListening = true;
      }

      state.orientationListening = true;
      setStatus("Recherche du cap géographique…");

      showToast(
        "Capteurs démarrés. Déplace doucement le téléphone."
      );

      /*
       * Certains navigateurs n'émettent aucun événement.
       * Vérifier après un délai et afficher un message explicite.
       */
      window.setTimeout(() => {
        if (
          currentActivation !== activationId ||
          !state.orientationListening
        ) {
          return;
        }

        if (headingSamples === 0 && pitchSamples === 0) {
          setStatus("Aucune donnée du capteur");

          showToast(
            "Aucune donnée reçue. Vérifie HTTPS, les autorisations et la compatibilité de l'appareil."
          );
        } else if (!state.sensorActive) {
          setStatus("Cap géographique indisponible");

          showToast(
            "Inclinaison détectée, mais aucun cap absolu fiable n'est disponible."
          );
        }
      }, 3000);
    } catch (error) {
      if (currentActivation !== activationId) return;

      stopListening();

      console.error("[Atlas] Erreur du capteur :", error);

      showToast(
        "Impossible d'activer les capteurs. Vérifie HTTPS et les autorisations."
      );
    }
  }

  function recenter() {
    const fresh =
      state.sensorActive &&
      Date.now() - lastAbsoluteHeadingTime < SENSOR_TIMEOUT;

    if (!fresh) {
      showToast(
        "Cap géographique indisponible. Vérifie les capteurs et la calibration."
      );
      return;
    }

    drawSky();

    showToast("Orientation actualisée.");
  }

  return {
    getScreenAngle,
    handleOrientation,
    enableOrientation,
    recenter,
    stopListening
  };
}
