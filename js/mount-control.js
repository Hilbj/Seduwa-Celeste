import { t } from "./i18n.js";

/** INDI status monitoring and explicitly confirmed, guarded selected-object GoTo commands. */
export function initMountControl() {
  const panel = document.getElementById("mount-control-panel");
  const triggers = [...document.querySelectorAll("[data-mount-control-open]")];
  const close = document.getElementById("mount-control-close");
  const hostMode = document.getElementById("mount-host-mode");
  const endpoint = document.getElementById("mount-endpoint");
  const serverIndicator = document.getElementById("mount-server-status")?.closest(".mount-connection-indicator");
  const serverText = document.getElementById("mount-server-status");
  const mountIndicator = document.getElementById("mount-device-status")?.closest(".mount-connection-indicator");
  const mountText = document.getElementById("mount-device-status");
  const tokenInput = document.getElementById("mount-goto-token");
  const selectedGotoButton = document.getElementById("mount-goto-selected");
  const selectedGotoStatus = document.getElementById("mount-goto-selected-status");
  if (!panel || !triggers.length || !serverIndicator || !serverText || !mountIndicator || !mountText || !endpoint) return;

  let pollHandle = null;
  let requestController = null;
  let requestSequence = 0;
  let gotoInProgress = false;
  let arrivalPollHandle = null;
  let arrivalController = null;
  let positionPollHandle = null;
  let positionRequestController = null;
  let selectedTarget = null;

  const emitMountPosition = position => {
    window.dispatchEvent(new CustomEvent("seduwa:mount-position", { detail: position }));
  };
  const clearMountPosition = () => {
    positionRequestController?.abort();
    positionRequestController = null;
    emitMountPosition({ available: false });
  };

  const setIndicator = (element, text, message, state) => {
    if (element.dataset.state === state && text.textContent === message) return;
    text.textContent = message;
    element.dataset.state = state;
  };
  const setChecking = () => {
    setIndicator(serverIndicator, serverText, t("mountControl.checking"), "checking");
    setIndicator(mountIndicator, mountText, t("mountControl.checking"), "checking");
  };
  const setUnavailable = () => {
    setIndicator(serverIndicator, serverText, t("mountControl.serverUnavailable"), "offline");
    setIndicator(mountIndicator, mountText, t("mountControl.mountUnknownServerDown"), "unknown");
    stopPositionPolling();
    updateGotoButtons();
  };
  const statusUrl = () => `${endpoint.value.trim().replace(/\/+$/, "")}/api/status`;
  const gatewayBase = () => endpoint.value.trim().replace(/\/+$/, "");
  const mountIsReady = () => mountIndicator.dataset.state === "online" && serverIndicator.dataset.state === "online";
  const updateGotoButtons = () => {
    const enabled = !gotoInProgress && mountIsReady() && Boolean(tokenInput?.value.trim());
    if (selectedGotoButton) {
      selectedGotoButton.hidden = !mountIsReady() || !selectedTarget?.available;
      selectedGotoButton.disabled = !enabled || !selectedTarget?.available;
    }
  };
  const setGotoMessage = (message, state = "info") => {
    if (!selectedGotoStatus) return;
    selectedGotoStatus.textContent = message;
    selectedGotoStatus.dataset.state = state;
    selectedGotoStatus.hidden = false;
  };

  const readMountPosition = async () => {
    if (!mountIsReady() || positionRequestController || document.visibilityState === "hidden") return;
    const controller = new AbortController();
    positionRequestController = controller;
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(`${gatewayBase()}/api/mount/goto/diagnostic`, {
        method: "GET", mode: "cors", credentials: "omit", cache: "no-store",
        headers: { Accept: "application/json" }, signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const coordinates = data?.currentCoordinates;
      const raHours = Number(coordinates?.raHours ?? coordinates?.ra);
      const decDegrees = Number(coordinates?.decDegrees ?? coordinates?.dec);
      if (data?.valuesReadable !== true || !coordinates ||
          !Number.isFinite(raHours) || raHours < 0 || raHours >= 24 ||
          !Number.isFinite(decDegrees) || decDegrees < -90 || decDegrees > 90) {
        throw new Error(data?.valuesError || "coordinates_unavailable");
      }
      emitMountPosition({ available: true, raHours, decDegrees, updatedAt: Date.now() });
    } catch {
      emitMountPosition({ available: false });
    } finally {
      clearTimeout(timeout);
      if (positionRequestController === controller) positionRequestController = null;
    }
  };

  function stopPositionPolling() {
    if (positionPollHandle !== null) clearInterval(positionPollHandle);
    positionPollHandle = null;
    clearMountPosition();
  }

  const startPositionPolling = () => {
    if (positionPollHandle !== null) return;
    readMountPosition();
    positionPollHandle = setInterval(readMountPosition, 3000);
  };

  const checkGateway = async () => {
    const url = statusUrl();
    if (!/^https?:\/\//i.test(url)) {
      setUnavailable();
      return;
    }
    const sequence = ++requestSequence;
    requestController?.abort();
    const controller = new AbortController();
    requestController = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    if (serverIndicator.dataset.state === "unknown" && mountIndicator.dataset.state === "unknown") setChecking();
    try {
      const response = await fetch(url, {
        method: "GET", mode: "cors", credentials: "omit", cache: "no-store",
        headers: { Accept: "application/json" }, signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (sequence !== requestSequence) return;
      const serverRunning = data?.indi?.serverRunning === true || data?.server?.indiRunning === true;
      const serverStopped = data?.indi?.serverRunning === false || data?.server?.indiRunning === false;
      const mount = data?.mount || data?.indi?.mount || data?.device || {};
      const mountConnected = mount?.connected === true || data?.indi?.connected === true;
      const mountResponsive = mount?.responsive === true || data?.indi?.mountResponsive === true;
      if (serverRunning) setIndicator(serverIndicator, serverText, t("mountControl.serverRunning"), "online");
      else if (serverStopped) setIndicator(serverIndicator, serverText, t("mountControl.serverUnavailable"), "offline");
      else setIndicator(serverIndicator, serverText, t("mountControl.serverUnknown"), "unknown");
      if (serverRunning && mountConnected && mountResponsive) {
        setIndicator(mountIndicator, mountText, t("mountControl.mountResponding"), "online");
      } else if (serverRunning && mountConnected) {
        setIndicator(mountIndicator, mountText, t("mountControl.mountNotResponding"), "not-responding");
      } else if (serverRunning) {
        setIndicator(mountIndicator, mountText, t("mountControl.mountDisconnected"), "offline");
      } else if (serverStopped) {
        setIndicator(mountIndicator, mountText, t("mountControl.mountUnknownServerDown"), "unknown");
      } else {
        setIndicator(mountIndicator, mountText, t("mountControl.mountUnknown"), "unknown");
      }
      if (mountIsReady()) startPositionPolling();
      else stopPositionPolling();
      updateGotoButtons();
    } catch (error) {
      if (sequence !== requestSequence) return;
      setUnavailable();
    } finally {
      clearTimeout(timeout);
    }
  };

  const angularSeparationDegrees = (a, b) => {
    // The v1.6 diagnostic endpoint returns {ra, dec}; /api/status uses
    // {raHours, decDegrees}. Accept both documented shapes.
    const ra1 = Number(a.raHours ?? a.ra) * 15 * Math.PI / 180;
    const ra2 = Number(b.raHours ?? b.ra) * 15 * Math.PI / 180;
    const dec1 = Number(a.decDegrees ?? a.dec) * Math.PI / 180;
    const dec2 = Number(b.decDegrees ?? b.dec) * Math.PI / 180;
    if (![ra1, ra2, dec1, dec2].every(Number.isFinite)) return Infinity;
    const cosDistance = Math.sin(dec1) * Math.sin(dec2) + Math.cos(dec1) * Math.cos(dec2) * Math.cos(ra1 - ra2);
    return Math.acos(Math.max(-1, Math.min(1, cosDistance))) * 180 / Math.PI;
  };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  const monitorArrival = async (target, startedAt) => {
    const url = `${gatewayBase()}/api/mount/goto/diagnostic`;
    const deadline = performance.now() + 180000;
    let consecutive = 0;
    while (performance.now() < deadline && gotoInProgress) {
      await delay(2500);
      if (!gotoInProgress) return;
      arrivalController?.abort();
      const controller = new AbortController();
      arrivalController = controller;
      const timeout = setTimeout(() => controller.abort(), 9000);
      try {
        const response = await fetch(url, { method: "GET", mode: "cors", credentials: "omit", cache: "no-store", headers: { Accept: "application/json" }, signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (data?.valuesReadable !== true || !data.currentCoordinates) throw new Error(data?.valuesError || "coordinates_unavailable");
        const separation = angularSeparationDegrees(data.currentCoordinates, target);
        if (separation <= 0.25) consecutive += 1; else consecutive = 0;
        if (consecutive >= 2) {
          const totalSeconds = ((performance.now() - startedAt) / 1000).toFixed(1);
          setGotoMessage(t("mountControl.gotoArrived", { seconds: totalSeconds }), "success");
          return;
        }
        setGotoMessage(t("mountControl.gotoProgress", { degrees: separation.toFixed(2) }), "info");
      } catch (error) {
        setGotoMessage(t("mountControl.gotoAcceptedNoPosition"), "warning");
        return;
      } finally {
        clearTimeout(timeout);
      }
    }
    if (gotoInProgress) setGotoMessage(t("mountControl.gotoArrivalTimeout"), "warning");
  };

  const sendGoto = async (name, target) => {
    if (gotoInProgress || !mountIsReady()) return;
    const token = tokenInput?.value.trim();
    if (!token) {
      setGotoMessage(t("mountControl.gotoTokenRequired"), "warning");
      updateGotoButtons();
      return;
    }
    if (!window.confirm(t("mountControl.gotoSelectedConfirm", { name }))) return;
    gotoInProgress = true;
    updateGotoButtons();
    setGotoMessage(t("mountControl.gotoSending", { name }), "info");
    const startedAt = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`${gatewayBase()}/api/mount/goto`, {
        method: "POST", mode: "cors", credentials: "omit", cache: "no-store", signal: controller.signal,
        headers: { "Accept": "application/json", "Content-Type": "application/json", "X-Seduwa-Token": token },
        body: JSON.stringify({ raHours: target.raHours, decDegrees: target.decDegrees, confirm: true })
      });
      const data = await response.json().catch(() => ({}));
      const ackSeconds = ((performance.now() - startedAt) / 1000).toFixed(2);
      if (!response.ok || data?.ok !== true) {
        const reason = data?.error || `HTTP ${response.status}`;
        setGotoMessage(t("mountControl.gotoFailed", { reason, seconds: ackSeconds }), "error");
        return;
      }
      setGotoMessage(t("mountControl.gotoAccepted", { name, seconds: ackSeconds }), "success");
      await monitorArrival(target, startedAt);
    } catch (error) {
      setGotoMessage(error?.name === "AbortError" ? t("mountControl.gotoRequestTimeout") : t("mountControl.gotoNetworkError"), "error");
    } finally {
      clearTimeout(timeout);
      arrivalController?.abort();
      gotoInProgress = false;
      updateGotoButtons();
    }
  };

  selectedGotoButton?.addEventListener("click", () => {
    if (!selectedTarget?.available) {
      setGotoMessage(t("mountControl.gotoSelectedUnavailable"), "warning");
      return;
    }
    sendGoto(selectedTarget.name, {
      raHours: selectedTarget.raHours,
      decDegrees: selectedTarget.decDegrees
    });
  });
  window.addEventListener("seduwa:object-card-target", event => {
    const target = event.detail;
    selectedTarget = target?.available ? target : null;
    if (selectedGotoStatus) {
      selectedGotoStatus.hidden = true;
      selectedGotoStatus.textContent = "";
      delete selectedGotoStatus.dataset.state;
    }
    updateGotoButtons();
  });
  tokenInput?.addEventListener("input", updateGotoButtons);

  const setOpen = open => {
    panel.hidden = !open;
    triggers.forEach(trigger => {
      trigger.classList.toggle("is-active", open);
      trigger.setAttribute("aria-expanded", String(open));
    });
    if (open) {
      panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
      checkGateway();
    }
  };
  triggers.forEach(trigger => {
    trigger.setAttribute("aria-controls", "mount-control-panel");
    trigger.setAttribute("aria-expanded", "false");
    trigger.addEventListener("click", () => setOpen(panel.hidden));
  });
  close?.addEventListener("click", () => setOpen(false));
  hostMode?.addEventListener("change", () => {
    endpoint.value = hostMode.value === "local" ? "http://127.0.0.1:8768" : "http://raspberrypi.local:8768";
    if (!panel.hidden) checkGateway();
    updateGotoButtons();
  });
  endpoint.addEventListener("change", () => { if (!panel.hidden) checkGateway(); updateGotoButtons(); });
  document.addEventListener("localechange", () => {
    const refresh = (element, text, key) => { if (element.dataset.state === "checking") text.textContent = t("mountControl.checking"); else text.textContent = t(key); };
    const serverStates = { online: "mountControl.serverRunning", offline: "mountControl.serverUnavailable", unknown: "mountControl.serverUnknown" };
    const mountStates = { online: "mountControl.mountResponding", offline: "mountControl.mountDisconnected", "not-responding": "mountControl.mountNotResponding", unknown: "mountControl.mountUnknown" };
    refresh(serverIndicator, serverText, serverStates[serverIndicator.dataset.state] || "mountControl.serverUnknown");
    refresh(mountIndicator, mountText, mountStates[mountIndicator.dataset.state] || "mountControl.mountUnknown");
  });
  updateGotoButtons();
  checkGateway();
  if (pollHandle === null) {
    pollHandle = setInterval(() => {
      if (document.visibilityState !== "hidden") checkGateway();
    }, 10000);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkGateway();
    else positionRequestController?.abort();
  });
}
