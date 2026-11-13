#!/usr/bin/env python3
"""Localhost HTTP bridge from Seduwa Sky to INDIGO (v2.2: grouped GOTO safety prechecks)."""
from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HOST = os.environ.get("GATEWAY_HOST", "192.168.x.x")
PORT = int(os.environ.get("GATEWAY_PORT", "8765"))
INDIGO_HOST = os.environ.get("INDIGO_HOST", "127.0.0.1")
INDIGO_PORT = int(os.environ.get("INDIGO_PORT", "7624"))
TOOL = os.environ.get("INDIGO_PROP_TOOL") or shutil.which("indigo_prop_tool") or "/usr/local/bin/indigo_prop_tool"
# The active device in the user's INDIGO server is Mount Nexstar, not Mount SynScan.
DEVICE = os.environ.get("INDIGO_DEVICE", "Mount Nexstar")
TIMEOUT = float(os.environ.get("INDIGO_COMMAND_TIMEOUT", "4"))
# Short INDIGO client wait used only for status reads; motion commands keep the default.
READ_WAIT = float(os.environ.get("INDIGO_READ_WAIT", "0.5"))
MOTION_STOP_TIMEOUT = max(TIMEOUT, 4.0)
# indigo_prop_tool waits 2s by default after enumeration; this bounds that client wait.
COORDINATE_CLIENT_WAIT = float(os.environ.get("INDIGO_GOTO_CLIENT_WAIT", "0.75"))
GATEWAY_TOKEN = os.environ.get("GATEWAY_TOKEN", "")
ALLOWED_ORIGINS = {item.strip() for item in os.environ.get("GATEWAY_ALLOWED_ORIGINS", "").split(",") if item.strip()}


def run_tool(*args: str, timeout: float | None = None, wait: float | None = None) -> tuple[int, str, str]:
    """Run one explicitly supplied indigo_prop_tool operation."""
    cmd = [TOOL, args[0], "-r", f"{INDIGO_HOST}:{INDIGO_PORT}"]
    if wait is not None:
        cmd.extend(["-t", str(wait)])
    cmd.extend(args[1:])
    try:
        p = subprocess.run(cmd, capture_output=True, text=True,
                           timeout=TIMEOUT if timeout is None else timeout, check=False)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except subprocess.TimeoutExpired:
        return 124, "", "indigo_prop_tool timed out"
    except OSError as exc:
        return 127, "", str(exc)


def set_goto_coordinates_timed(assignments: str) -> tuple[bool, str, dict]:
    """Write GOTO coordinates while separating process launch from process wait.

    The command, target property and timeout match set_property_items(); only
    the subprocess timing is split for diagnosis. No shorter timeout is used.
    """
    cmd = [TOOL, "set", "-r", f"{INDIGO_HOST}:{INDIGO_PORT}",
           "-t", str(COORDINATE_CLIENT_WAIT),
           f"{DEVICE}.MOUNT_EQUATORIAL_COORDINATES.{assignments}"]
    details: dict[str, float | int | bool] = {
        "coordinateClientWaitLimitSeconds": COORDINATE_CLIENT_WAIT
    }
    launch_started = time.perf_counter()
    try:
        process = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
        details["coordinateProcessStartMs"] = round(
            (time.perf_counter() - launch_started) * 1000, 1
        )
        wait_started = time.perf_counter()
        try:
            stdout, stderr = process.communicate(timeout=TIMEOUT)
            details["coordinateProcessWaitMs"] = round(
                (time.perf_counter() - wait_started) * 1000, 1
            )
            details["coordinateProcessReturnCode"] = process.returncode
            details["coordinateStdoutBytes"] = len(stdout.encode("utf-8"))
            details["coordinateStderrBytes"] = len(stderr.encode("utf-8"))
            # indigo_prop_tool returns 0 even when its connection fails. Treat a
            # missing update of the target property as unconfirmed, never as success.
            property_echo = f"{DEVICE}.MOUNT_EQUATORIAL_COORDINATES." in stdout
            connection_error = "connection failed" in (stdout + "\n" + stderr).lower()
            details["coordinatePropertyUpdateObserved"] = property_echo
            details["coordinateConnectionErrorObserved"] = connection_error
            confirmed = process.returncode == 0 and property_echo and not connection_error
            if not confirmed and process.returncode == 0:
                return False, ("No update of MOUNT_EQUATORIAL_COORDINATES was received within "
                               f"{COORDINATE_CLIENT_WAIT:.2f}s; command submission is uncertain. "
                               "Check the mount before retrying."), details
            return confirmed, (stderr or stdout).strip(), details
        except subprocess.TimeoutExpired:
            process.kill()
            stdout, stderr = process.communicate()
            details["coordinateProcessWaitMs"] = round(
                (time.perf_counter() - wait_started) * 1000, 1
            )
            details["coordinateProcessReturnCode"] = 124
            details["coordinateStdoutBytes"] = len(stdout.encode("utf-8"))
            details["coordinateStderrBytes"] = len(stderr.encode("utf-8"))
            details["coordinatePropertyUpdateObserved"] = False
            details["coordinateConnectionErrorObserved"] = False
            return False, "indigo_prop_tool timed out", details
    except OSError as exc:
        details["coordinateProcessStartMs"] = round(
            (time.perf_counter() - launch_started) * 1000, 1
        )
        details["coordinateProcessWaitMs"] = 0.0
        details["coordinateProcessReturnCode"] = 127
        details["coordinateStdoutBytes"] = 0
        details["coordinateStderrBytes"] = len(str(exc).encode("utf-8"))
        details["coordinatePropertyUpdateObserved"] = False
        details["coordinateConnectionErrorObserved"] = False
        return False, str(exc), details


def tcp_reachable() -> bool:
    try:
        with socket.create_connection((INDIGO_HOST, INDIGO_PORT), timeout=1.0):
            return True
    except OSError:
        return False


def get_items(property_name: str, item_names: tuple[str, ...]) -> tuple[bool, list[str], str]:
    """Read named property items. Values are returned as indigo_prop_tool lines."""
    joined = ";".join(item_names)
    rc, output, error = run_tool("get", f"{DEVICE}.{property_name}.{joined}", wait=READ_WAIT)
    values = [line.strip() for line in output.splitlines() if line.strip()]
    return rc == 0 and len(values) >= len(item_names), values, error


def read_status() -> dict:
    tcp_ok = tcp_reachable()
    if not tcp_ok:
        return {
            "gateway": "ok",
            "indi": {"serverRunning": False, "host": INDIGO_HOST, "port": INDIGO_PORT,
                     "driverLoaded": None, "propertyState": None},
            "mount": {"connected": False, "responsive": False, "device": DEVICE,
                      "connectionState": "UNKNOWN", "tracking": None,
                      "slewRate": None, "coordinates": None},
            "diagnostics": {"tcpReachable": False, "toolAvailable": os.path.isfile(TOOL),
                            "tool": TOOL},
        }

    state_rc, state_out, state_err = run_tool("get_state", f"{DEVICE}.CONNECTION", wait=READ_WAIT)
    values_ok, connection_values, values_err = get_items("CONNECTION", ("CONNECTED", "DISCONNECTED"))
    list_rc, list_out, list_err = run_tool("list_state", DEVICE, wait=READ_WAIT)

    property_state = state_out.splitlines()[-1].strip() if state_rc == 0 and state_out else None
    tokens = [value.upper() for value in connection_values]
    connected = tokens[0] == "ON" if len(tokens) >= 1 and values_ok else False
    disconnected = tokens[1] == "ON" if len(tokens) >= 2 and values_ok else not connected
    driver_loaded = bool(list_rc == 0 and re.search(
        rf"(?m)^{re.escape(DEVICE)}\.CONNECTION\s*=\s*OK\s*$", list_out))
    responsive = bool(connected and property_state == "OK" and values_ok)
    connection_state = "CONNECTED" if connected else ("DISCONNECTED" if disconnected else "UNKNOWN")

    tracking_ok, tracking_values, tracking_err = get_items("MOUNT_TRACKING", ("ON", "OFF"))
    rate_ok, rate_values, rate_err = get_items(
        "MOUNT_SLEW_RATE", ("GUIDE", "CENTERING", "FIND", "MAX"))
    coords_ok, coord_values, coord_err = get_items(
        "MOUNT_EQUATORIAL_COORDINATES", ("RA", "DEC"))

    tracking = None
    if tracking_ok:
        tracking = "ON" if tracking_values[0].upper() == "ON" else "OFF" if tracking_values[1].upper() == "ON" else "UNKNOWN"

    slew_rate = None
    if rate_ok:
        for label, value in zip(("GUIDE", "CENTERING", "FIND", "MAX"), rate_values):
            if value.upper() == "ON":
                slew_rate = label
                break

    coordinates = None
    if coords_ok:
        try:
            coordinates = {"raHours": float(coord_values[0]), "decDegrees": float(coord_values[1])}
        except ValueError:
            coordinates = None

    errors = [e for e in (state_err, values_err, list_err, tracking_err, rate_err, coord_err) if e]
    return {
        "gateway": "ok",
        "indi": {"serverRunning": True, "host": INDIGO_HOST, "port": INDIGO_PORT,
                 "driverLoaded": driver_loaded if list_rc == 0 else None,
                 "propertyState": property_state},
        "mount": {"connected": connected, "responsive": responsive, "device": DEVICE,
                  "connectionState": connection_state, "tracking": tracking,
                  "slewRate": slew_rate, "coordinates": coordinates},
        "diagnostics": {"tcpReachable": True, "toolAvailable": os.path.isfile(TOOL),
                        "tool": TOOL, "getStateOk": state_rc == 0,
                        "getValuesOk": values_ok, "listStateOk": list_rc == 0,
                        "trackingReadable": tracking_ok, "slewRateReadable": rate_ok,
                        "coordinatesReadable": coords_ok, "errors": errors},
    }


def read_goto_prechecks() -> tuple[bool, dict[str, str], str]:
    """Read all GOTO safety properties in one INDIGO list operation."""
    rc, output, error = run_tool(
        "list", "-s", DEVICE, wait=READ_WAIT
    )

    if rc != 0:
        return False, {}, error or output or "INDIGO list failed"

    required = {
        "CONNECTION": ("CONNECTED", "DISCONNECTED"),
        "MOUNT_PARK": ("PARKED", "UNPARKED"),
        "MOUNT_ON_COORDINATES_SET": ("TRACK", "SYNC"),
    }

    states = {}
    values = {}
    prefix = f"{DEVICE}."

    for line in output.splitlines():
        if not line.startswith("[") or "]" not in line:
            continue

        state, entry = line[1:].split("]", 1)
        entry = entry.strip()

        if not entry.startswith(prefix):
            continue

        path, separator, value = entry[len(prefix):].partition(" = ")
        if not separator or "." not in path:
            continue

        property_name, item_name = path.split(".", 1)

        if property_name not in required:
            continue

        states[property_name] = state.strip()
        values[f"{property_name}.{item_name}"] = (
            value.strip().strip('"')
        )

    for property_name, items in required.items():
        if states.get(property_name) != "OK":
            return False, {}, (
                f"{property_name} state is "
                f"{states.get(property_name, 'MISSING')}"
            )

        for item in items:
            key = f"{property_name}.{item}"
            if key not in values:
                return False, {}, f"Missing INDIGO item: {key}"

    return True, values, ""


# Strictly bounded manual motion. Server-side timer stops the mount even if
# the HTTP client disappears. All motion state is serialized by MOTION_LOCK.
MAX_MOTION_SECONDS = 2.0
MOTION_LOCK = threading.RLock()
MOTION_TIMER = None
# False until this process has positively confirmed both manual axes OFF.
# This forces one safe OFF at startup, then avoids redundant OFF writes on GoTo.
MANUAL_AXES_KNOWN_OFF = False
MOTION_GENERATION = 0
PREVIOUS_RATE = None
DIRECTIONS = {
    "north": ("MOUNT_MOTION_DEC", "NORTH"),
    "south": ("MOUNT_MOTION_DEC", "SOUTH"),
    "east": ("MOUNT_MOTION_RA", "EAST"),
    "west": ("MOUNT_MOTION_RA", "WEST"),
}
RATES = {"GUIDE", "CENTERING", "FIND", "MAX"}


def set_property_items(property_name: str, assignments: str) -> tuple[bool, str]:
    all_off = assignments.endswith("=OFF;WEST=OFF") or assignments.endswith("=OFF;SOUTH=OFF")
    rc, output, error = run_tool("set", f"{DEVICE}.{property_name}.{assignments}",
                                 timeout=MOTION_STOP_TIMEOUT if all_off else None)
    return rc == 0, error or output


def stop_all_directions(timing_output: dict | None = None) -> tuple[bool, str]:
    """Send the two atomic OFF updates concurrently to minimize stop latency.

    Optional timing_output records each INDIGO command duration independently.
    """
    commands = (
        ("MOUNT_MOTION_RA", "EAST=OFF;WEST=OFF"),
        ("MOUNT_MOTION_DEC", "NORTH=OFF;SOUTH=OFF"),
    )
    with ThreadPoolExecutor(max_workers=2) as executor:
        def timed_off(prop: str, assignments: str):
            command_started = time.perf_counter()
            result = set_property_items(prop, assignments)
            elapsed = round((time.perf_counter() - command_started) * 1000, 1)
            return prop, result, elapsed

        futures = [
            executor.submit(timed_off, prop, assignments)
            for prop, assignments in commands
        ]
        detailed_results = [future.result() for future in futures]
        results = [(prop, result) for prop, result, _elapsed in detailed_results]
        if timing_output is not None:
            for prop, _result, elapsed in detailed_results:
                key = "stopRaOffMs" if prop == "MOUNT_MOTION_RA" else "stopDecOffMs"
                timing_output[key] = elapsed

    errors = [
        f"{prop}: {detail or 'commande OFF non confirmée'}"
        for prop, (ok, detail) in results if not ok
    ]
    global MANUAL_AXES_KNOWN_OFF
    MANUAL_AXES_KNOWN_OFF = not errors
    return not errors, "; ".join(errors)


def cancel_motion_timer() -> None:
    global MOTION_TIMER, MOTION_GENERATION
    MOTION_GENERATION += 1
    if MOTION_TIMER is not None:
        MOTION_TIMER.cancel()
        MOTION_TIMER = None


def restore_previous_rate() -> tuple[bool, str]:
    """Restore the saved rate; retain it if INDIGO does not confirm success."""
    global PREVIOUS_RATE
    if PREVIOUS_RATE is None:
        return True, ""
    rate = PREVIOUS_RATE
    ok, detail = set_property_items("MOUNT_SLEW_RATE", f"{rate}=ON")
    if ok:
        PREVIOUS_RATE = None
    return ok, detail


def stop_active_motion(timing_output: dict | None = None) -> tuple[bool, str]:
    cancel_motion_timer()
    stop_ok, stop_detail = stop_all_directions(timing_output)

    # Never change the slew rate while an axis may still be moving.
    if not stop_ok:
        return False, stop_detail

    rate_started = time.perf_counter()
    rate_ok, rate_detail = restore_previous_rate()
    if timing_output is not None:
        timing_output["rateRestoreMs"] = round((time.perf_counter() - rate_started) * 1000, 1)
    details = rate_detail if not rate_ok else ""
    return rate_ok, details


def timed_stop(generation: int) -> None:
    global MOTION_TIMER
    with MOTION_LOCK:
        if generation != MOTION_GENERATION:
            return
        ok, detail = stop_active_motion()
        MOTION_TIMER = None
        if not ok:
            print(f"ERREUR arrêt automatique / restauration vitesse: {detail}", flush=True)
        else:
            print("Arrêt automatique effectué; vitesse précédente restaurée.", flush=True)


def start_manual_motion(direction: str, rate: str, duration_ms: int) -> tuple[bool, str]:
    global MOTION_TIMER, PREVIOUS_RATE
    with MOTION_LOCK:
        # First clear any previous movement and finish any pending rate restore.
        ok, detail = stop_active_motion()
        if not ok:
            return False, f"Arrêt préalable ou restauration de vitesse non confirmé: {detail}"

        # Establish a known stopped state before enabling any direction.
        ok, detail = stop_all_directions()
        if not ok:
            return False, f"Arrêt initial non confirmé: {detail}"

        # Preserve the user's existing speed.
        rate_ok, rate_values, rate_error = get_items(
            "MOUNT_SLEW_RATE", ("GUIDE", "CENTERING", "FIND", "MAX"))
        selected = [
            name for name, value in zip(
                ("GUIDE", "CENTERING", "FIND", "MAX"), rate_values
            ) if value.upper() == "ON"
        ] if rate_ok else []
        if len(selected) != 1:
            return False, f"Vitesse INDIGO actuelle non déterminée: {rate_error or rate_values}"
        PREVIOUS_RATE = selected[0]

        # INDIGO's slew-rate switch is a one-of-many property.
        ok, detail = set_property_items("MOUNT_SLEW_RATE", f"{rate}=ON")
        if not ok:
            restore_ok, restore_detail = restore_previous_rate()
            suffix = f"; restauration: {restore_detail}" if not restore_ok else ""
            return False, f"Sélection de vitesse impossible: {detail}{suffix}"

        # Start the safety timer immediately before issuing the direction ON
        # command. If indigo_prop_tool is slow to return, the timer waits on
        # MOTION_LOCK and stops the axes as soon as this function releases it.
        generation = MOTION_GENERATION
        timer = threading.Timer(duration_ms / 1000.0, timed_stop, args=(generation,))
        timer.daemon = True
        MOTION_TIMER = timer
        try:
            timer.start()
        except RuntimeError as exc:
            MOTION_TIMER = None
            stop_ok, stop_detail = stop_all_directions()
            restore_ok, restore_detail = (
                restore_previous_rate() if stop_ok else (False, "vitesse conservée car arrêt non confirmé")
            )
            details = "; ".join(x for x in (str(exc), stop_detail, restore_detail) if x)
            return False, f"Timer de sécurité impossible à démarrer: {details}"

        prop, item = DIRECTIONS[direction]
        ok, detail = set_property_items(prop, f"{item}=ON")
        if not ok:
            cancel_motion_timer()
            stop_ok, stop_detail = stop_all_directions()
            restore_ok, restore_detail = (
                restore_previous_rate() if stop_ok else (False, "vitesse conservée car arrêt non confirmé")
            )
            cleanup = "; ".join(
                x for x in (
                    stop_detail if not stop_ok else "",
                    restore_detail if not restore_ok else ""
                ) if x
            )
            suffix = f"; nettoyage: {cleanup}" if cleanup else ""
            return False, f"Activation de direction impossible: {detail}{suffix}"

        global MANUAL_AXES_KNOWN_OFF
        MANUAL_AXES_KNOWN_OFF = False
        return True, "Déplacement lancé; arrêt automatique programmé côté serveur."


def stop_manual_motion() -> tuple[bool, str]:
    with MOTION_LOCK:
        return stop_active_motion()


def send_abort_pulse() -> tuple[bool, str]:
    ok, detail = set_property_items("MOUNT_ABORT_MOTION", "ABORT_MOTION=ON")
    if not ok:
        return False, detail
    off_ok, off_detail = set_property_items("MOUNT_ABORT_MOTION", "ABORT_MOTION=OFF")
    return off_ok, off_detail


class Handler(BaseHTTPRequestHandler):
    server_version = "SeduwaINDIGOGateway/2.2"

    def origin_allowed(self) -> bool:
        origin = self.headers.get("Origin")
        return not origin or origin in ALLOWED_ORIGINS

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin")
        if origin and origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Accept, Content-Type, X-Seduwa-Token")
        self.end_headers()
        if status != 204:
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                # The browser may cancel a polling request (refresh/navigation).
                # The gateway and INDIGO connection remain available; this is
                # a normal client disconnect, not a server failure.
                self.close_connection = True

    def do_OPTIONS(self):
        if not self.origin_allowed():
            self.send_json(403, {"gateway": "ok", "error": "origin_not_allowed"})
            return
        self.send_json(204, {})

    def do_GET(self):
        if not self.origin_allowed():
            self.send_json(403, {"gateway": "ok", "error": "origin_not_allowed"})
            return
        path = urlparse(self.path).path
        if path == "/api/status":
            self.send_json(200, read_status())
        elif path == "/api/health":
            self.send_json(200, {"gateway": "ok", "readOnly": False,
                                 "commands": ["abort", "motion_start", "motion_stop", "goto_diagnostic", "goto"],
                                 "maxMotionSeconds": MAX_MOTION_SECONDS,
                                 "directions": sorted(DIRECTIONS), "rates": sorted(RATES),
                                 "indiHost": INDIGO_HOST, "indiPort": INDIGO_PORT,
                                 "device": DEVICE, "version": "2.2"})
        elif path == "/api/mount/goto/diagnostic":
            # Read-only inspection only: never writes coordinates or starts a slew.
            rc, output, error = run_tool("list_state", DEVICE, wait=READ_WAIT)
            if rc != 0:
                self.send_json(502, {"gateway": "ok", "error": "indi_property_read_failed",
                                     "detail": error or output})
                return
            lines = output.splitlines()
            prefix = f"{DEVICE}.MOUNT_EQUATORIAL_COORDINATES"
            start = next((i for i, line in enumerate(lines) if line.strip().startswith(prefix)), None)
            block = []
            if start is not None:
                block.append(lines[start])
                for line in lines[start + 1:]:
                    if line.strip().startswith(f"{DEVICE}."):
                        break
                    block.append(line)
            values_ok, values, values_error = get_items("MOUNT_EQUATORIAL_COORDINATES", ("RA", "DEC"))
            self.send_json(200, {"gateway": "ok", "readOnly": True,
                                 "device": DEVICE,
                                 "property": "MOUNT_EQUATORIAL_COORDINATES",
                                 "propertyFound": start is not None,
                                 "propertyDefinition": "\n".join(block),
                                 "currentCoordinates": ({"ra": values[0], "dec": values[1]} if values_ok else None),
                                 "valuesReadable": values_ok,
                                 "valuesError": values_error,
                                 "note": "Diagnostic en lecture seule : aucun GoTo ni déplacement n'a été envoyé."})
        else:
            self.send_json(404, {"gateway": "ok", "error": "not_found"})

    def do_POST(self):
        path = urlparse(self.path).path
        allowed_paths = ("/api/mount/abort", "/api/mount/motion/start", "/api/mount/motion/stop", "/api/mount/goto")
        if path not in allowed_paths:
            self.send_json(404, {"gateway": "ok", "error": "not_found"})
            return
        if not self.origin_allowed():
            self.send_json(403, {"gateway": "ok", "error": "origin_not_allowed"})
            return
        if not GATEWAY_TOKEN:
            self.send_json(503, {"gateway": "ok", "error": "command_token_not_configured"})
            return
        import hmac
        if not hmac.compare_digest(self.headers.get("X-Seduwa-Token", ""), GATEWAY_TOKEN):
            self.send_json(403, {"gateway": "ok", "error": "invalid_token"})
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length < 0 or content_length > 2048:
                raise ValueError
            raw = self.rfile.read(content_length) if content_length else b""
            body = json.loads(raw.decode("utf-8")) if raw else {}
            if not isinstance(body, dict):
                raise ValueError
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            self.send_json(400, {"gateway": "ok", "error": "invalid_json_body"})
            return

        if path == "/api/mount/goto":
            # A GoTo is an actual mount movement. Require an explicit confirmation
            # field in addition to the gateway token; never accept implicit defaults.
            if set(body) != {"raHours", "decDegrees", "confirm"} or body.get("confirm") is not True:
                self.send_json(400, {"gateway": "ok", "error": "explicit_confirmation_required",
                                     "requiredFields": ["raHours", "decDegrees", "confirm"],
                                     "confirmMustBe": True})
                return
            ra, dec = body.get("raHours"), body.get("decDegrees")
            if (isinstance(ra, bool) or not isinstance(ra, (int, float)) or
                    isinstance(dec, bool) or not isinstance(dec, (int, float))):
                self.send_json(400, {"gateway": "ok", "error": "coordinates_must_be_numbers"})
                return
            if not (0.0 <= float(ra) < 24.0 and -90.0 <= float(dec) <= 90.0):
                self.send_json(400, {"gateway": "ok", "error": "coordinates_out_of_range",
                                     "raHoursRange": "0 <= RA < 24", "decDegreesRange": "-90 <= Dec <= 90"})
                return
            request_started = time.perf_counter()
            timings = {}
            started = time.perf_counter()
            preflight_ok, preflight, preflight_error = read_goto_prechecks()
            timings["preflightCheckMs"] = round(
                (time.perf_counter() - started) * 1000, 1
            )

            if not preflight_ok:
                self.send_json(409, {
                    "gateway": "ok",
                    "error": "goto_preflight_unreadable",
                    "detail": preflight_error,
                    "timingsMs": timings
                })
                return

            if (preflight["CONNECTION.CONNECTED"].upper() != "ON" or
                    preflight["CONNECTION.DISCONNECTED"].upper() != "OFF"):
                self.send_json(409, {
                    "gateway": "ok",
                    "error": "mount_not_connected",
                    "timingsMs": timings
                })
                return

            if (preflight["MOUNT_PARK.PARKED"].upper() != "OFF" or
                    preflight["MOUNT_PARK.UNPARKED"].upper() != "ON"):
                self.send_json(409, {
                    "gateway": "ok",
                    "error": "mount_not_confirmed_unparked",
                    "timingsMs": timings
                })
                return

            if preflight["MOUNT_ON_COORDINATES_SET.SYNC"].upper() == "ON":
                self.send_json(409, {
                    "gateway": "ok",
                    "error": "mount_mode_is_sync",
                    "message": "Le mode SYNC est actif; aucun déplacement n'a été envoyé.",
                    "timingsMs": timings
                })
                return

            if preflight["MOUNT_ON_COORDINATES_SET.TRACK"].upper() != "ON":
                started = time.perf_counter()
                mode_set_ok, mode_set_detail = set_property_items(
                    "MOUNT_ON_COORDINATES_SET", "TRACK=ON"
                )
                if not mode_set_ok:
                    self.send_json(502, {
                        "gateway": "ok",
                        "error": "goto_track_mode_failed",
                        "detail": mode_set_detail,
                        "timingsMs": timings
                    })
                    return

                mode_ok, mode_values, mode_error = get_items(
                    "MOUNT_ON_COORDINATES_SET", ("TRACK", "SYNC")
                )
                if (not mode_ok or mode_values[0].upper() != "ON" or
                        mode_values[1].upper() != "OFF"):
                    self.send_json(502, {
                        "gateway": "ok",
                        "error": "goto_track_mode_not_confirmed",
                        "detail": mode_error or mode_values,
                        "timingsMs": timings
                    })
                    return

                timings["trackModeCorrectionMs"] = round(
                    (time.perf_counter() - started) * 1000, 1
                )

            # Serialize with gateway-managed manual motion. At process startup,
            # manual axes are considered UNKNOWN, so the first GoTo performs a
            # safety OFF. Once OFF is confirmed, subsequent GoTos skip redundant
            # OFF writes unless this gateway has started manual motion again.
            started = time.perf_counter()
            with MOTION_LOCK:
                lock_acquired = time.perf_counter()
                timings["manualStopLockWaitMs"] = round((lock_acquired - started) * 1000, 1)
                needs_manual_stop = (
                    not MANUAL_AXES_KNOWN_OFF or MOTION_TIMER is not None or PREVIOUS_RATE is not None
                )
                timings["manualStopSkipped"] = not needs_manual_stop
                if needs_manual_stop:
                    stop_ok, stop_detail = stop_active_motion(timings)
                    if not stop_ok:
                        timings["manualStopMs"] = round((time.perf_counter() - lock_acquired) * 1000, 1)
                        self.send_json(502, {"gateway": "ok", "error": "manual_motion_stop_failed",
                                             "detail": stop_detail, "timingsMs": timings})
                        return
                else:
                    timings["manualStopMs"] = 0.0
                    timings["rateRestoreMs"] = 0.0
                timings["manualStopMs"] = round((time.perf_counter() - lock_acquired) * 1000, 1)
                assignments = f"RA={float(ra):.8f};DEC={float(dec):.8f}"
                started = time.perf_counter()
                goto_ok, goto_detail, coordinate_process_timings = set_goto_coordinates_timed(assignments)
                timings.update(coordinate_process_timings)
                timings["coordinateWriteMs"] = round((time.perf_counter() - started) * 1000, 1)
                timings["coordinateToolCallMs"] = timings["coordinateWriteMs"]
            if not goto_ok:
                self.send_json(502, {"gateway": "ok", "error": "goto_command_failed",
                                     "detail": goto_detail, "timingsMs": timings,
                                     "target": {"raHours": float(ra), "decDegrees": float(dec)}})
                return
            timings["gotoHandlerTotalMs"] = round((time.perf_counter() - request_started) * 1000, 1)
            self.send_json(200, {"gateway": "ok", "ok": True, "command": "goto",
                                 "mode": "TRACK", "target": {"raHours": float(ra),
                                 "decDegrees": float(dec)}, "timingsMs": timings,
                                 "message": "Coordonnées cibles transmises au pilote INDIGO en mode TRACK."})
            return

        status = read_status()
        mount = status.get("mount", {})
        if not mount.get("connected") or not mount.get("responsive"):
            self.send_json(409, {"gateway": "ok", "error": "mount_not_connected"})
            return

        if path == "/api/mount/motion/start":
            if set(body) != {"direction", "rate", "durationMs"}:
                self.send_json(400, {"gateway": "ok", "error": "unexpected_request_fields"})
                return
            direction, rate, duration_ms = body.get("direction"), body.get("rate"), body.get("durationMs")
            if not isinstance(direction, str) or not isinstance(rate, str) or direction not in DIRECTIONS or rate not in RATES:
                self.send_json(400, {"gateway": "ok", "error": "invalid_direction_or_rate",
                                     "allowedDirections": sorted(DIRECTIONS),
                                     "allowedRates": sorted(RATES)})
                return
            if isinstance(duration_ms, bool) or not isinstance(duration_ms, int) or not 100 <= duration_ms <= 2000:
                self.send_json(400, {"gateway": "ok", "error": "invalid_duration",
                                     "minDurationMs": 100, "maxDurationMs": 2000})
                return
            park_ok, park_values, park_error = get_items("MOUNT_PARK", ("PARKED", "UNPARKED"))
            if not park_ok or park_values[0].upper() != "OFF" or park_values[1].upper() != "ON":
                self.send_json(409, {"gateway": "ok", "error": "mount_not_confirmed_unparked",
                                     "detail": park_error})
                return
            ok, detail = start_manual_motion(direction, rate, duration_ms)
            if not ok:
                self.send_json(502, {"gateway": "ok", "error": "motion_start_failed", "detail": detail})
                return
            self.send_json(200, {"gateway": "ok", "ok": True, "command": "motion_start",
                                 "direction": direction, "rate": rate, "durationMs": duration_ms,
                                 "message": detail})
            return

        if body:
            self.send_json(400, {"gateway": "ok", "error": "request_body_not_allowed"})
            return
        if path == "/api/mount/motion/stop":
            ok, detail = stop_manual_motion()
            if not ok:
                self.send_json(502, {"gateway": "ok", "error": "motion_stop_failed", "detail": detail})
                return
            self.send_json(200, {"gateway": "ok", "ok": True, "command": "motion_stop",
                                 "message": "Les quatre directions ont reçu OFF."})
            return

        # ABORT has priority: cancel timer, switch all manual directions OFF,
        # then pulse the driver's abort switch. Tracking is never changed.
        with MOTION_LOCK:
            stop_ok, stop_detail = stop_manual_motion()
            # Always attempt the driver's ABORT pulse, even if a manual OFF
            # command failed: the driver's emergency abort may still stop motion.
            abort_ok, abort_detail = send_abort_pulse()
        if not stop_ok or not abort_ok:
            self.send_json(502, {"gateway": "ok", "error": "abort_command_failed",
                                 "detail": "; ".join(x for x in (stop_detail, abort_detail) if x)})
            return
        self.send_json(200, {"gateway": "ok", "ok": True, "command": "abort",
                             "message": "Directions coupées et arrêt d'urgence transmis au pilote INDIGO."})

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)


def main():
    if HOST not in ("127.0.0.1", "localhost", "::1", "192.168.x.x"):
        raise SystemExit("Sécurité : GATEWAY_HOST doit être localhost ou 192.168.x.x.")
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.daemon_threads = True
    print(f"Passerelle Seduwa INDIGO v2.2 (précontrôles GOTO groupés) : http://{HOST}:{PORT}", flush=True)
    print(f"INDIGO cible : {INDIGO_HOST}:{INDIGO_PORT} ; périphérique : {DEVICE} ; outil : {TOOL}", flush=True)
    print("Commandes : abort, motion/start (max 2 s), motion/stop, goto (confirmation explicite).", flush=True)
    print(f"Origines navigateur autorisées : {', '.join(sorted(ALLOWED_ORIGINS)) or '(aucune — accès navigateur désactivé)' }", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        # Best-effort cleanup on orderly shutdown (Ctrl+C / normal exit).
        with MOTION_LOCK:
            ok, detail = stop_active_motion()
            if not ok:
                print(f"ERREUR arrêt lors de la fermeture: {detail}", flush=True)
        httpd.server_close()


if __name__ == "__main__":
    main()
