"""
PocketLab laptop computer-vision agent.

Recognises stable hand gestures with MediaPipe and sends them to the PocketLab
server on the phone, which queues the mapped command for the phone agent.

How the server is found (first one that answers wins):
  1. --api URL  or the POCKETLAB_API_BASE environment variable
  2. "apiBase" in pocketlab.config.json (next to this file)
  3. UDP LAN discovery (same Wi-Fi; "POCKETLAB_DISCOVER" on port 37020)
  4. The HostName of "Host pocketlab" in ~/.ssh/config (your Tailscale host)
  5. "fallbackHosts" in pocketlab.config.json

Gesture actions run on a background thread, so the camera never freezes
while waiting for the phone to acknowledge a command.
"""

import argparse
import ipaddress
import json
import os
import platform
import queue
import re
import socket
import subprocess
import threading
import time
from pathlib import Path

import requests

# ============================================================
# CONFIGURATION
# ============================================================

HERE = Path(__file__).resolve().parent
MODEL_PATH = HERE / "gesture_recognizer.task"
CONFIG_FILE = HERE / "pocketlab.config.json"

POCKETLAB_HTTP_PORT = 3000
DISCOVERY_PORT = 37020
DISCOVERY_MESSAGE = b"POCKETLAB_DISCOVER"

DISCOVERY_TIMEOUT = 2.5
HTTP_TIMEOUT = 3.0
PROBE_TIMEOUT = 2.5
ACK_TIMEOUT = 15.0
HEARTBEAT_INTERVAL = 10.0

GESTURE_CONFIDENCE_THRESHOLD = 0.75
STABLE_FRAMES_REQUIRED = 5
RELEASE_FRAMES_REQUIRED = 8
COMMAND_COOLDOWN = 1.5

INVALID_GESTURES = {"", "none", "unknown", "no_gesture", "no gesture"}

# Gesture → PocketLab command (must match the server's supported commands).
GESTURE_COMMANDS = {
    "thumb_up": "status",
    "open_palm": "telemetry",
    "victory": "device_info",
    "closed_fist": "safe",
    "pointing_up": "vibrate",
    "iloveyou": "resume",
}

TAILSCALE_NET = ipaddress.ip_network("100.64.0.0/10")


def log(message):
    print(time.strftime("%H:%M:%S"), message, flush=True)


def gesture_to_command(gesture_name):
    normalized = str(gesture_name).strip().lower().replace(" ", "_").replace("-", "_")
    return GESTURE_COMMANDS.get(normalized)


def load_config():
    try:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        log(f"[CONFIG] Ignoring {CONFIG_FILE.name}: {exc}")
        return {}


def normalize_base(value):
    """'100.82.17.93' / 'phone.tailnet.ts.net:3000' / 'http://x:3000/' -> http://host:port"""
    value = str(value or "").strip().rstrip("/")
    if not value:
        return None
    if not re.match(r"^https?://", value):
        value = f"http://{value}"
    host_part = value.split("://", 1)[1]
    if ":" not in host_part.split("/")[0]:
        value = f"{value}:{POCKETLAB_HTTP_PORT}"
    return value


def describe_host(base_url):
    host = re.sub(r"^https?://", "", base_url).split(":")[0].split("/")[0]
    try:
        ip = ipaddress.ip_address(host)
        if ip in TAILSCALE_NET:
            return "Tailscale"
        if ip.is_private:
            return "LAN"
        return "Internet"
    except ValueError:
        return "Tailscale" if host.endswith(".ts.net") else "Hostname"


# ============================================================
# LAN DISCOVERY (unchanged protocol: UDP 37020)
# ============================================================

def windows_ipv4_adapters():
    """Active IPv4 adapters from Windows (no phone IP is hard-coded)."""
    script = r"""
Get-NetIPConfiguration |
Where-Object { $_.NetAdapter.Status -eq "Up" -and $_.IPv4Address } |
ForEach-Object {
    [PSCustomObject]@{
        Alias   = $_.InterfaceAlias
        IP      = $_.IPv4Address[0].IPAddress
        Prefix  = $_.IPv4Address[0].PrefixLength
        Gateway = if ($_.IPv4DefaultGateway) { $_.IPv4DefaultGateway[0].NextHop } else { "" }
    }
} | ConvertTo-Json -Compress
"""
    try:
        raw = subprocess.check_output(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=8,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).strip()
        data = json.loads(raw) if raw else []
    except Exception as exc:  # noqa: BLE001 - discovery must never crash the agent
        log(f"[DISCOVERY] Windows network lookup failed: {exc}")
        return []

    if isinstance(data, dict):
        data = [data]

    adapters = []
    for item in data:
        try:
            ip = ipaddress.ip_address(str(item["IP"]))
            prefix = int(item["Prefix"])
        except (KeyError, ValueError, TypeError):
            continue
        # Tailscale, link-local and loopback adapters can't carry broadcasts.
        if ip in TAILSCALE_NET or ip.is_link_local or ip.is_loopback:
            continue
        adapters.append({"alias": str(item.get("Alias", "")), "ip": str(ip), "prefix": prefix,
                         "gateway": str(item.get("Gateway") or "")})

    # Wi-Fi first, then adapters that have a gateway.
    def rank(adapter):
        name = adapter["alias"].lower()
        wifi = any(word in name for word in ("wi-fi", "wifi", "wireless", "wlan"))
        return (0 if wifi else 1, 0 if adapter["gateway"] else 1)

    return sorted(adapters, key=rank)


def broadcast_targets():
    targets = []
    if platform.system() == "Windows":
        for adapter in windows_ipv4_adapters():
            try:
                network = ipaddress.ip_network(f"{adapter['ip']}/{adapter['prefix']}", strict=False)
                targets.append(str(network.broadcast_address))
            except ValueError:
                continue
    targets.append("255.255.255.255")
    return list(dict.fromkeys(targets))


def discover_pocketlab_lan():
    """Ask the local network for PocketLab. Returns base URL or None."""
    targets = broadcast_targets()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.bind(("0.0.0.0", 0))
        for target in targets:
            try:
                sock.sendto(DISCOVERY_MESSAGE, (target, DISCOVERY_PORT))
            except OSError:
                continue

        deadline = time.monotonic() + DISCOVERY_TIMEOUT
        while time.monotonic() < deadline:
            sock.settimeout(max(0.1, deadline - time.monotonic()))
            try:
                data, remote = sock.recvfrom(4096)
            except socket.timeout:
                break
            except OSError:
                break
            try:
                response = json.loads(data.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                continue
            if response.get("service") != "PocketLab":
                continue
            try:
                port = int(response.get("port", POCKETLAB_HTTP_PORT))
            except (TypeError, ValueError):
                port = POCKETLAB_HTTP_PORT
            return f"http://{remote[0]}:{port}"
    finally:
        sock.close()
    return None


def ssh_config_host(alias="pocketlab"):
    """HostName of 'Host pocketlab' in ~/.ssh/config — the same address SSH uses."""
    path = Path.home() / ".ssh" / "config"
    try:
        lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    except OSError:
        return None

    in_block = False
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        key, _, value = stripped.partition(" ")
        key = key.lower()
        if key in ("host", "match"):
            in_block = key == "host" and alias in value.split()
            continue
        if in_block and key == "hostname":
            return value.strip()
    return None


# ============================================================
# POCKETLAB CLIENT
# ============================================================

class PocketLabClient:

    def __init__(self, explicit_api=None, use_discovery=True):
        self.session = requests.Session()
        self.session.trust_env = False  # ignore Windows proxy settings
        self.explicit_api = normalize_base(explicit_api)
        self.use_discovery = use_discovery
        self.config = load_config()
        self.base_url = None
        self.connection = None
        self.lock = threading.Lock()
        self.next_resolve_at = 0.0
        self.resolve_backoff = 3.0
        self.last_error = ""

    # ---------------- connection ----------------

    def probe(self, base_url):
        try:
            response = self.session.get(f"{base_url}/api/health", timeout=PROBE_TIMEOUT)
            if response.ok and response.json().get("service") == "PocketLab":
                return True
            # Older servers have no /api/health.
            response = self.session.get(f"{base_url}/api/context", timeout=PROBE_TIMEOUT)
            return response.ok and bool(response.json().get("success"))
        except (requests.RequestException, ValueError):
            return False

    def candidates(self):
        yield "configured", self.explicit_api
        yield "config file", normalize_base(self.config.get("apiBase"))
        if self.use_discovery:
            yield "LAN discovery", "discover"
        yield "ssh config", normalize_base(ssh_config_host())
        for host in self.config.get("fallbackHosts") or []:
            yield "fallback", normalize_base(host)

    def resolve(self):
        tried = []
        for source, base in self.candidates():
            if not base:
                continue
            if base == "discover":
                log("[DISCOVERY] Asking the local network for PocketLab…")
                base = discover_pocketlab_lan()
                if not base:
                    tried.append("LAN discovery (no answer)")
                    continue
            if base in [t.split(" ")[0] for t in tried]:
                continue
            if self.probe(base):
                with self.lock:
                    self.base_url = base
                    self.connection = describe_host(base)
                log(f"[POCKETLAB] Connected to {base} via {self.connection} ({source})")
                return True
            tried.append(f"{base} ({source})")

        self.last_error = "tried: " + ", ".join(tried) if tried else "no address configured"
        log(f"[POCKETLAB] Server not found — {self.last_error}")
        return False

    def ensure_connected(self):
        if self.base_url:
            return True
        if time.monotonic() < self.next_resolve_at:
            return False
        if self.resolve():
            self.resolve_backoff = 3.0
            return True
        self.next_resolve_at = time.monotonic() + self.resolve_backoff
        self.resolve_backoff = min(30.0, self.resolve_backoff * 2)
        return False

    def mark_failed(self, error):
        with self.lock:
            if self.base_url:
                log(f"[POCKETLAB] Lost connection to {self.base_url}: {error}")
            self.base_url = None
            self.connection = None
        self.last_error = str(error)
        self.next_resolve_at = 0.0

    def request(self, method, path, **kwargs):
        if not self.ensure_connected():
            return None
        base = self.base_url
        try:
            response = self.session.request(method, f"{base}{path}", timeout=HTTP_TIMEOUT, **kwargs)
        except requests.RequestException as exc:
            self.mark_failed(exc.__class__.__name__)
            return None
        return response

    # ---------------- API calls ----------------

    def send_event(self, gesture, confidence, hand_count):
        response = self.request("POST", "/api/cv/event", json={
            "event": gesture, "confidence": round(confidence, 3), "handCount": hand_count, "source": "Laptop-CV",
        })
        if response is not None and response.ok:
            return response.json().get("event")
        return None

    def queue_command(self, command):
        response = self.request("POST", "/api/device/command", json={"command": command, "source": "gesture"})
        if response is None:
            return None, "server unreachable"
        try:
            data = response.json()
        except ValueError:
            data = {}
        if not response.ok or not data.get("success"):
            return None, data.get("error") or f"HTTP {response.status_code}"
        return data.get("command"), None

    def get_command(self, command_id):
        response = self.request("GET", f"/api/device/command/{command_id}")
        if response is None:
            return None
        if response.status_code == 404:
            # Older server: only the current command is available.
            response = self.request("GET", "/api/device/command")
            if response is None or not response.ok:
                return None
            command = response.json().get("command") or {}
            return command if command.get("commandId") == command_id else None
        if not response.ok:
            return None
        return response.json().get("command")

    def wait_for_ack(self, command_id):
        deadline = time.monotonic() + ACK_TIMEOUT
        while time.monotonic() < deadline:
            command = self.get_command(command_id)
            if command and command.get("status") not in (None, "queued"):
                return command
            time.sleep(0.6)
        return None

    def update_cv_event(self, event_id, command, command_id, status, result):
        response = self.request("PATCH", f"/api/cv/history/{event_id}", json={
            "command": command, "commandId": command_id, "commandStatus": status, "commandResult": result,
        })
        return response is not None and response.ok

    def heartbeat(self, info):
        response = self.request("POST", "/api/cv/heartbeat", json=info)
        return response is not None and response.ok


# ============================================================
# BACKGROUND WORKERS
# ============================================================

class ActionWorker(threading.Thread):
    """Sends gestures/commands to PocketLab without blocking the camera."""

    def __init__(self, client):
        super().__init__(daemon=True)
        self.client = client
        self.jobs = queue.Queue(maxsize=8)
        self.status_text = "Show a gesture to the camera"
        self.status_level = "idle"
        self.status_at = time.monotonic()

    def set_status(self, text, level):
        self.status_text = text
        self.status_level = level
        self.status_at = time.monotonic()
        log(f"[ACTION] {text}")

    def submit(self, gesture, confidence, hand_count):
        try:
            self.jobs.put_nowait((gesture, confidence, hand_count))
        except queue.Full:
            self.set_status("Busy — gesture skipped", "warn")

    def run(self):
        while True:
            gesture, confidence, hand_count = self.jobs.get()
            try:
                self.handle(gesture, confidence, hand_count)
            except Exception as exc:  # noqa: BLE001 - keep the worker alive
                self.set_status(f"Error: {exc}", "bad")

    def handle(self, gesture, confidence, hand_count):
        client = self.client
        command = gesture_to_command(gesture)
        event = client.send_event(gesture, confidence, hand_count)

        if event is None:
            self.set_status(f"{gesture}: PocketLab not reachable ({client.last_error})", "bad")
            return

        if not command:
            self.set_status(f"{gesture}: recorded (no command mapped)", "ok")
            return

        queued, error = client.queue_command(command)
        if not queued:
            client.update_cv_event(event.get("id"), command, None, "failed", {"error": error})
            self.set_status(f"{gesture} → {command}: rejected ({error})", "bad")
            return

        command_id = queued.get("commandId")
        client.update_cv_event(event.get("id"), command, command_id, "queued", None)
        self.set_status(f"{gesture} → {command}: waiting for the phone…", "warn")

        final = client.wait_for_ack(command_id)
        if final is None:
            self.set_status(f"{gesture} → {command}: no reply from phone agent", "bad")
            return

        status = final.get("status")
        result = final.get("result")
        client.update_cv_event(event.get("id"), command, command_id, status, result)

        if status == "completed":
            self.set_status(f"{gesture} → {command}: done", "ok")
        elif isinstance(result, dict) and result.get("blocked"):
            self.set_status(f"{gesture} → {command}: blocked (safe state)", "warn")
        else:
            reason = result.get("error") if isinstance(result, dict) else status
            self.set_status(f"{gesture} → {command}: {status} ({reason})", "bad")


class HeartbeatThread(threading.Thread):
    def __init__(self, client, get_info):
        super().__init__(daemon=True)
        self.client = client
        self.get_info = get_info

    def run(self):
        while True:
            self.client.heartbeat(self.get_info())
            time.sleep(HEARTBEAT_INTERVAL)


# ============================================================
# MEDIAPIPE + CAMERA
# ============================================================

def create_gesture_recognizer(mp):
    options = mp.tasks.vision.GestureRecognizerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(MODEL_PATH)),
        running_mode=mp.tasks.vision.RunningMode.VIDEO,
        num_hands=2,
        min_hand_detection_confidence=0.6,
        min_hand_presence_confidence=0.6,
        min_tracking_confidence=0.6,
    )
    return mp.tasks.vision.GestureRecognizer.create_from_options(options)


def open_camera(cv2, index):
    if platform.system() == "Windows":
        cap = cv2.VideoCapture(index, cv2.CAP_DSHOW)
        if cap.isOpened():
            return cap
        cap.release()
    return cv2.VideoCapture(index)


COLORS = {"ok": (176, 209, 79), "warn": (68, 181, 245), "bad": (95, 112, 242), "idle": (200, 200, 200)}


def draw_overlay(cv2, frame, client, worker, gesture_text, progress, fps):
    h, w = frame.shape[:2]
    shade = frame.copy()
    cv2.rectangle(shade, (0, 0), (w, 74), (20, 14, 10), -1)
    cv2.rectangle(shade, (0, h - 40), (w, h), (20, 14, 10), -1)
    cv2.addWeighted(shade, 0.72, frame, 0.28, 0, frame)

    if client.base_url:
        conn_text, conn_color = f"PocketLab via {client.connection}  {client.base_url}", COLORS["ok"]
    else:
        conn_text, conn_color = "Searching for PocketLab…", COLORS["warn"]

    cv2.circle(frame, (18, 22), 6, conn_color, -1, cv2.LINE_AA)
    cv2.putText(frame, conn_text, (32, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (235, 236, 230), 1, cv2.LINE_AA)
    cv2.putText(frame, f"{fps:4.1f} fps   Q to quit", (w - 190, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (160, 160, 160), 1, cv2.LINE_AA)

    cv2.putText(frame, gesture_text, (14, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2, cv2.LINE_AA)
    if progress > 0:
        bar_w = 160
        x0 = w - bar_w - 16
        cv2.rectangle(frame, (x0, 50), (x0 + bar_w, 58), (80, 80, 80), -1)
        cv2.rectangle(frame, (x0, 50), (x0 + int(bar_w * min(progress, 1.0)), 58), (255, 156, 181), -1)

    color = COLORS.get(worker.status_level, COLORS["idle"])
    cv2.putText(frame, worker.status_text[:90], (14, h - 14), cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 1, cv2.LINE_AA)


# ============================================================
# MAIN
# ============================================================

def parse_args():
    parser = argparse.ArgumentParser(description="PocketLab laptop gesture agent")
    parser.add_argument("--api", default=os.environ.get("POCKETLAB_API_BASE"),
                        help="PocketLab server, e.g. http://100.82.17.93:3000 (default: env POCKETLAB_API_BASE)")
    parser.add_argument("--camera", type=int, default=int(os.environ.get("POCKETLAB_CAMERA", "0")),
                        help="webcam index (default 0)")
    parser.add_argument("--no-discovery", action="store_true", help="skip UDP LAN discovery")
    return parser.parse_args()


def main():
    args = parse_args()

    print("==========================================")
    print("       PocketLab AI / CV Agent")
    print("==========================================\n")

    if not MODEL_PATH.exists():
        raise FileNotFoundError(f"Missing model: {MODEL_PATH}\nKeep gesture_recognizer.task next to hand_tracking.py.")

    import cv2
    import mediapipe as mp

    client = PocketLabClient(explicit_api=args.api, use_discovery=not args.no_discovery)
    if not client.ensure_connected():
        log("[WARNING] PocketLab not found yet — the camera starts anyway and keeps retrying.")

    worker = ActionWorker(client)
    worker.start()

    live = {"fps": 0.0, "gesture": None}
    HeartbeatThread(client, lambda: {
        "source": "Laptop-CV",
        "host": socket.gethostname(),
        "camera": True,
        "fps": round(live["fps"], 1),
        "connection": client.connection,
        "currentGesture": live["gesture"],
    }).start()

    cap = open_camera(cv2, args.camera)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open webcam {args.camera}. Close other apps using the camera or try --camera 1.")

    log("[CAMERA] Webcam opened. Gesture recognition started. Press Q to quit.")

    candidate_gesture = None
    candidate_frames = 0
    candidate_confidence_total = 0.0
    active_gesture = None
    release_frames = 0
    last_command_time = 0.0
    last_ts = 0
    fps_count, fps_start = 0, time.monotonic()

    try:
        with create_gesture_recognizer(mp) as recognizer:
            while True:
                ok, frame = cap.read()
                if not ok:
                    log("[CAMERA] Failed to read frame.")
                    break

                frame = cv2.flip(frame, 1)
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)

                # MediaPipe VIDEO mode needs strictly increasing timestamps.
                timestamp_ms = max(last_ts + 1, int(time.monotonic() * 1000))
                last_ts = timestamp_ms
                result = recognizer.recognize_for_video(mp_image, timestamp_ms)

                fps_count += 1
                elapsed = time.monotonic() - fps_start
                if elapsed >= 1.0:
                    live["fps"] = fps_count / elapsed
                    fps_count, fps_start = 0, time.monotonic()

                frame_gesture, frame_confidence = None, 0.0
                for hand_gestures in result.gestures or []:
                    if not hand_gestures:
                        continue
                    category = hand_gestures[0]
                    name = str(category.display_name or category.category_name or "").strip()
                    score = float(category.score)
                    if name.lower() in INVALID_GESTURES or score < GESTURE_CONFIDENCE_THRESHOLD:
                        continue
                    if score > frame_confidence:
                        frame_gesture, frame_confidence = name, score

                live["gesture"] = frame_gesture
                gesture_text = "No gesture"
                progress = 0.0

                if frame_gesture is None:
                    candidate_gesture, candidate_frames, candidate_confidence_total = None, 0, 0.0
                    if active_gesture is not None:
                        release_frames += 1
                        if release_frames >= RELEASE_FRAMES_REQUIRED:
                            active_gesture, release_frames = None, 0
                    else:
                        release_frames = 0
                else:
                    release_frames = 0
                    if candidate_gesture == frame_gesture:
                        candidate_frames += 1
                        candidate_confidence_total += frame_confidence
                    else:
                        candidate_gesture, candidate_frames, candidate_confidence_total = frame_gesture, 1, frame_confidence

                    command = gesture_to_command(frame_gesture)
                    gesture_text = f"{frame_gesture} ({frame_confidence:.2f})" + (f"  -> {command}" if command else "")
                    progress = candidate_frames / STABLE_FRAMES_REQUIRED if frame_gesture != active_gesture else 1.0

                    if candidate_frames >= STABLE_FRAMES_REQUIRED and candidate_gesture != active_gesture:
                        now = time.monotonic()
                        if now - last_command_time >= COMMAND_COOLDOWN:
                            average = candidate_confidence_total / max(candidate_frames, 1)
                            log(f"[CV] Stable gesture: {candidate_gesture} ({average:.2f})")
                            worker.submit(candidate_gesture, average, len(result.gestures))
                            active_gesture = candidate_gesture
                            last_command_time = now
                            candidate_frames, candidate_confidence_total = 0, 0.0

                draw_overlay(cv2, frame, client, worker, gesture_text, progress, live["fps"])
                cv2.imshow("PocketLab - Gesture Control", frame)

                key = cv2.waitKey(1) & 0xFF
                if key in (ord("q"), ord("Q"), 27):
                    break
                if cv2.getWindowProperty("PocketLab - Gesture Control", cv2.WND_PROP_VISIBLE) < 1:
                    break
    finally:
        cap.release()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
