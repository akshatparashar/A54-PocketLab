import ipaddress
import json
import socket
import subprocess
import time
from pathlib import Path

import cv2
import mediapipe as mp
import requests


# ============================================================
# CONFIGURATION
# ============================================================

MODEL_PATH = Path(__file__).with_name("gesture_recognizer.task")

# PocketLab HTTP server
POCKETLAB_HTTP_PORT = 3000

# UDP discovery
DISCOVERY_PORT = 37020
DISCOVERY_MESSAGE = b"POCKETLAB_DISCOVER"

# Network
DISCOVERY_TIMEOUT = 3.0
HTTP_TIMEOUT = 3.0

# ------------------------------------------------------------
# Gesture confidence
# ------------------------------------------------------------

GESTURE_CONFIDENCE_THRESHOLD = 0.75

# Number of consecutive frames required before a gesture
# is considered stable.
STABLE_FRAMES_REQUIRED = 5

# Number of consecutive frames without a valid gesture
# required before allowing the same gesture again.
RELEASE_FRAMES_REQUIRED = 8

# Additional time protection between command executions.
COMMAND_COOLDOWN = 1.5

# Invalid MediaPipe outputs
INVALID_GESTURES = {
    "",
    "none",
    "unknown",
    "no_gesture",
    "no gesture",
}


# ============================================================
# WINDOWS WI-FI INFORMATION
# ============================================================

def get_wifi_info():
    """
    Get active Wi-Fi IPv4 information directly from Windows.

    No phone IP is hard-coded.
    """

    powershell_script = r"""
Get-NetIPConfiguration |
Where-Object {
    $_.NetAdapter.Status -eq "Up" -and
    $_.IPv4Address
} |
ForEach-Object {
    [PSCustomObject]@{
        Alias   = $_.InterfaceAlias
        IP      = $_.IPv4Address.IPAddress
        Prefix  = $_.IPv4Address.PrefixLength
        Gateway = if ($_.IPv4DefaultGateway) {
            $_.IPv4DefaultGateway.NextHop
        } else {
            ""
        }
    }
} |
ConvertTo-Json -Compress
"""

    try:
        raw = subprocess.check_output(
            [
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                powershell_script,
            ],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()

    except Exception as exc:
        print(
            f"[DISCOVERY] Windows network lookup failed: {exc}"
        )
        return []

    if not raw:
        return []

    try:
        data = json.loads(raw)

    except json.JSONDecodeError:
        return []

    if isinstance(data, dict):
        data = [data]

    adapters = []

    for item in data:

        try:
            alias = str(item["Alias"])
            ip = str(item["IP"])
            prefix = int(item["Prefix"])
            gateway = str(item.get("Gateway", ""))

            ipaddress.ip_address(ip)

            name = alias.lower()

            if (
                "wi-fi" in name
                or "wifi" in name
                or "wireless" in name
                or "wlan" in name
            ):
                adapters.append(
                    {
                        "alias": alias,
                        "ip": ip,
                        "prefix": prefix,
                        "gateway": gateway,
                    }
                )

        except (
            KeyError,
            ValueError,
            TypeError,
        ):
            continue

    return adapters


# ============================================================
# POCKETLAB UDP DISCOVERY
# ============================================================

def discover_pocketlab():
    """
    Discover PocketLab through UDP broadcast.

    The PocketLab server announces itself.
    No phone IP is hard-coded.
    """

    wifi = get_wifi_info()

    if not wifi:
        print(
            "[DISCOVERY] No active Wi-Fi adapter found."
        )
        return None

    adapter = wifi[0]

    print(
        f"[DISCOVERY] Adapter: {adapter['alias']}"
    )

    print(
        f"[DISCOVERY] Laptop IP: "
        f"{adapter['ip']}/{adapter['prefix']}"
    )

    if adapter["gateway"]:
        print(
            f"[DISCOVERY] Gateway: "
            f"{adapter['gateway']}"
        )

    try:
        network = ipaddress.ip_network(
            f"{adapter['ip']}/{adapter['prefix']}",
            strict=False,
        )

        broadcast_address = str(
            network.broadcast_address
        )

    except ValueError as exc:
        print(
            f"[DISCOVERY] Invalid network: {exc}"
        )
        return None

    print(
        f"[DISCOVERY] Broadcast address: "
        f"{broadcast_address}"
    )

    sock = socket.socket(
        socket.AF_INET,
        socket.SOCK_DGRAM,
    )

    try:
        sock.setsockopt(
            socket.SOL_SOCKET,
            socket.SO_BROADCAST,
            1,
        )

        sock.setsockopt(
            socket.SOL_SOCKET,
            socket.SO_REUSEADDR,
            1,
        )

        sock.bind(
            ("0.0.0.0", 0)
        )

        sock.settimeout(
            DISCOVERY_TIMEOUT
        )

        print(
            "[DISCOVERY] Asking LAN for PocketLab..."
        )

        sock.sendto(
            DISCOVERY_MESSAGE,
            (
                broadcast_address,
                DISCOVERY_PORT,
            ),
        )

        deadline = (
            time.monotonic()
            + DISCOVERY_TIMEOUT
        )

        while time.monotonic() < deadline:

            remaining = (
                deadline
                - time.monotonic()
            )

            sock.settimeout(
                max(0.1, remaining)
            )

            try:
                data, remote = sock.recvfrom(
                    4096
                )

            except socket.timeout:
                break

            try:
                response = json.loads(
                    data.decode("utf-8")
                )

            except (
                UnicodeDecodeError,
                json.JSONDecodeError,
            ):
                continue

            if response.get("service") != "PocketLab":
                continue

            phone_ip = remote[0]

            try:
                port = int(
                    response.get(
                        "port",
                        POCKETLAB_HTTP_PORT,
                    )
                )

            except (
                TypeError,
                ValueError,
            ):
                port = POCKETLAB_HTTP_PORT

            print(
                "[DISCOVERY] PocketLab announced by "
                f"{phone_ip}:{port}"
            )

            return phone_ip

    finally:
        sock.close()

    print(
        "[DISCOVERY] PocketLab was not found."
    )

    return None


# ============================================================
# POCKETLAB CLIENT
# ============================================================

class PocketLabClient:

    def __init__(self):

        self.base_url = None

        self.session = requests.Session()

        # Ignore Windows proxy environment variables.
        self.session.trust_env = False

        # Final command state captured after acknowledgement.
        self.last_command_info = {}

    def rediscover(self):
        """
        Re-discover PocketLab on the current Wi-Fi.
        """

        self.base_url = None

        ip = discover_pocketlab()

        if not ip:
            return False

        self.base_url = (
            f"http://{ip}:{POCKETLAB_HTTP_PORT}"
        )

        print(
            f"[POCKETLAB] Connected to {self.base_url}"
        )

        return True

    def send_event(
        self,
        gesture,
        confidence,
        hand_count,
    ):
        """
        Send a recognized gesture to PocketLab.

        Returns:
            The stored CV event dictionary on success.
            None on failure.
        """

        if not gesture:
            return None

        if (
            str(gesture).strip().lower()
            in INVALID_GESTURES
        ):
            return None

        if not self.base_url:

            if not self.rediscover():
                return None

        payload = {
            "event": gesture,
            "confidence": confidence,
            "handCount": hand_count,
            "source": "Laptop-CV",
        }

        try:

            response = self.session.post(
                f"{self.base_url}/api/cv/event",
                json=payload,
                timeout=HTTP_TIMEOUT,
            )

            if response.ok:

                data = response.json()

                return data.get("event")

            print(
                "[CV] PocketLab returned HTTP "
                f"{response.status_code}"
            )

        except (
            requests.RequestException,
            ValueError,
            TypeError,
        ) as exc:

            print(
                "[CV] Connection error: "
                f"{exc}"
            )

        print(
            "[DISCOVERY] Re-discovering PocketLab..."
        )

        self.base_url = None

        if not self.rediscover():
            return None

        try:

            response = self.session.post(
                f"{self.base_url}/api/cv/event",
                json=payload,
                timeout=HTTP_TIMEOUT,
            )

            if response.ok:

                data = response.json()

                return data.get("event")

        except (
            requests.RequestException,
            ValueError,
            TypeError,
        ):
            pass

        return None

    def send_command(self, command):
        """
        Queue an IoT command and wait for the phone agent
        to acknowledge completion.
        """

        if not command:
            return False

        if not self.base_url:

            if not self.rediscover():
                return False

        payload = {
            "command": command
        }

        command_id = None

        # ----------------------------------------------------
        # Queue command
        # ----------------------------------------------------

        try:

            response = self.session.post(
                f"{self.base_url}/api/device/command",
                json=payload,
                timeout=HTTP_TIMEOUT,
            )

            if not response.ok:

                print(
                    "[IOT] Command request failed: "
                    f"HTTP {response.status_code}"
                )

                return False

            data = response.json()

            if not data.get("success"):

                print(
                    "[IOT] PocketLab rejected command."
                )

                return False

            command_info = data.get(
                "command",
                {}
            )

            command_id = command_info.get(
                "commandId"
            )

            self.last_command_info = dict(
                command_info
            )

            print(
                f"[IOT] Command queued: {command}"
            )

            if command_id:

                print(
                    f"[IOT] Command ID: {command_id}"
                )

            else:

                return True

        except (
            requests.RequestException,
            ValueError,
            TypeError,
        ) as exc:

            print(
                "[IOT] Failed to queue command: "
                f"{exc}"
            )

            return False

        # ----------------------------------------------------
        # Wait for acknowledgement
        # ----------------------------------------------------

        print(
            "[IOT] Waiting for phone acknowledgement..."
        )

        deadline = (
            time.monotonic()
            + 8.0
        )

        while time.monotonic() < deadline:

            try:

                response = self.session.get(
                    f"{self.base_url}/api/device/command",
                    timeout=HTTP_TIMEOUT,
                )

                if not response.ok:
                    time.sleep(0.5)
                    continue

                data = response.json()

                command_info = data.get(
                    "command",
                    {}
                )

                returned_id = command_info.get(
                    "commandId"
                )

                status = command_info.get(
                    "status"
                )

                if returned_id != command_id:

                    time.sleep(0.5)

                    continue

                if status == "completed":

                    self.last_command_info = dict(
                        command_info
                    )

                    print(
                        "[IOT] Command acknowledged."
                    )

                    result = command_info.get(
                        "result"
                    )

                    if result is not None:

                        print(
                            f"[IOT] Result: {result}"
                        )

                    return True

                if status in {
                    "failed",
                    "error",
                }:

                    self.last_command_info = dict(
                        command_info
                    )

                    print(
                        "[IOT] Command failed: "
                        f"{status}"
                    )

                    result = command_info.get(
                        "result"
                    )

                    if result is not None:

                        print(
                            f"[IOT] Result: {result}"
                        )

                    return False

            except (
                requests.RequestException,
                ValueError,
                TypeError,
            ):
                pass

            time.sleep(0.5)

        print(
            "[IOT] Command sent, but acknowledgement "
            "timed out."
        )

        return False


# ============================================================
    def update_cv_event(
        self,
        event_id,
        command,
        command_id,
        command_status,
        command_result,
    ):
        """
        Attach final IoT command state to the corresponding
        CV history event.
        """

        if not event_id:
            return False

        if not self.base_url:
            if not self.rediscover():
                return False

        payload = {
            "command": command,
            "commandId": command_id,
            "commandStatus": command_status,
            "commandResult": command_result,
        }

        try:
            response = self.session.patch(
                f"{self.base_url}/api/cv/history/{event_id}",
                json=payload,
                timeout=HTTP_TIMEOUT,
            )

            if response.ok:
                print(
                    "[CV HISTORY] Gesture action "
                    "linked successfully."
                )
                return True

            print(
                "[CV HISTORY] Update failed: "
                f"HTTP {response.status_code}"
            )

        except requests.RequestException as exc:
            print(
                "[CV HISTORY] Update error: "
                f"{exc}"
            )

        return False


def gesture_to_command(gesture_name):
    """
    Map recognized gestures to verified PocketLab commands.
    """

    normalized = (
        str(gesture_name)
        .strip()
        .lower()
        .replace(" ", "_")
        .replace("-", "_")
    )

    mapping = {
        "thumb_up": "status",
        "open_palm": "telemetry",
        "victory": "device_info",
        "closed_fist": "safe",
    }

    return mapping.get(normalized)


# ============================================================
# MEDIAPIPE
# ============================================================

def create_gesture_recognizer():

    BaseOptions = mp.tasks.BaseOptions

    GestureRecognizer = (
        mp.tasks.vision.GestureRecognizer
    )

    GestureRecognizerOptions = (
        mp.tasks.vision.GestureRecognizerOptions
    )

    RunningMode = (
        mp.tasks.vision.RunningMode
    )

    options = GestureRecognizerOptions(

        base_options=BaseOptions(
            model_asset_path=str(MODEL_PATH)
        ),

        running_mode=RunningMode.VIDEO,

        num_hands=2,

        min_hand_detection_confidence=0.6,

        min_hand_presence_confidence=0.6,

        min_tracking_confidence=0.6,
    )

    return (
        GestureRecognizer
        .create_from_options(options)
    )


# ============================================================
# MAIN
# ============================================================

def main():

    print(
        "=========================================="
    )

    print(
        "       PocketLab AI / CV Agent"
    )

    print(
        "=========================================="
    )

    print()

    # --------------------------------------------------------
    # Model check
    # --------------------------------------------------------

    if not MODEL_PATH.exists():

        raise FileNotFoundError(
            "Missing model:\n"
            f"{MODEL_PATH}\n\n"
            "Make sure gesture_recognizer.task is "
            "inside C:\\PocketLab-AI."
        )

    # --------------------------------------------------------
    # PocketLab discovery
    # --------------------------------------------------------

    pocketlab = PocketLabClient()

    found = pocketlab.rediscover()

    if not found:

        print()

        print(
            "[WARNING] PocketLab could not be discovered "
            "at startup."
        )

        print(
            "[WARNING] Camera will still start."
        )

        print()

    # --------------------------------------------------------
    # Camera
    # --------------------------------------------------------

    cap = cv2.VideoCapture(0)

    if not cap.isOpened():

        raise RuntimeError(
            "Could not open webcam."
        )

    print(
        "[CAMERA] Webcam opened."
    )

    print(
        "[CV] Gesture recognition started."
    )

    print(
        "[CV] Press Q to quit."
    )

    print()

    frame_index = 0

    # --------------------------------------------------------
    # Stability state
    # --------------------------------------------------------

    candidate_gesture = None
    candidate_frames = 0
    candidate_confidence_total = 0.0

    active_gesture = None
    release_frames = 0

    last_command_time = 0.0

    try:

        with create_gesture_recognizer() as recognizer:

            while True:

                ok, frame = cap.read()

                if not ok:

                    print(
                        "[CAMERA] Failed to read frame."
                    )

                    break

                # Mirror image
                frame = cv2.flip(
                    frame,
                    1,
                )

                # BGR → RGB
                rgb = cv2.cvtColor(
                    frame,
                    cv2.COLOR_BGR2RGB,
                )

                mp_image = mp.Image(
                    image_format=mp.ImageFormat.SRGB,
                    data=rgb,
                )

                timestamp_ms = int(
                    frame_index * 1000 / 30
                )

                result = (
                    recognizer
                    .recognize_for_video(
                        mp_image,
                        timestamp_ms,
                    )
                )

                frame_index += 1

                display_text = (
                    "No gesture detected"
                )

                # ------------------------------------------------
                # Find strongest valid gesture from this frame
                # ------------------------------------------------

                frame_gesture = None
                frame_confidence = 0.0

                if result.gestures:

                    for hand_gestures in result.gestures:

                        if not hand_gestures:
                            continue

                        category = hand_gestures[0]

                        gesture_name = (
                            category.display_name
                            or category.category_name
                            or ""
                        )

                        gesture_name = (
                            str(
                                gesture_name
                            ).strip()
                        )

                        if (
                            gesture_name.lower()
                            in INVALID_GESTURES
                        ):
                            continue

                        confidence = float(
                            category.score
                        )

                        # Ignore low-confidence results
                        if (
                            confidence
                            < GESTURE_CONFIDENCE_THRESHOLD
                        ):
                            continue

                        # Choose strongest detected gesture.
                        if confidence > frame_confidence:

                            frame_gesture = (
                                gesture_name
                            )

                            frame_confidence = (
                                confidence
                            )

                # ------------------------------------------------
                # Display current recognition status
                # ------------------------------------------------

                if frame_gesture:

                    display_text = (
                        f"{frame_gesture} "
                        f"({frame_confidence:.2f})"
                    )

                # ------------------------------------------------
                # NO VALID GESTURE
                # ------------------------------------------------

                if frame_gesture is None:

                    candidate_gesture = None
                    candidate_frames = 0
                    candidate_confidence_total = 0.0

                    if active_gesture is not None:

                        release_frames += 1

                        if (
                            release_frames
                            >= RELEASE_FRAMES_REQUIRED
                        ):

                            print(
                                "[CV] Gesture released."
                            )

                            active_gesture = None
                            release_frames = 0

                    else:

                        release_frames = 0

                # ------------------------------------------------
                # VALID GESTURE
                # ------------------------------------------------

                else:

                    release_frames = 0

                    # Same gesture as candidate
                    if (
                        candidate_gesture
                        == frame_gesture
                    ):

                        candidate_frames += 1

                        candidate_confidence_total += (
                            frame_confidence
                        )

                    # New gesture candidate
                    else:

                        candidate_gesture = (
                            frame_gesture
                        )

                        candidate_frames = 1

                        candidate_confidence_total = (
                            frame_confidence
                        )

                    average_confidence = (
                        candidate_confidence_total
                        / max(
                            candidate_frames,
                            1
                        )
                    )

                    # ------------------------------------------------
                    # Candidate stability display
                    # ------------------------------------------------

                    display_text = (
                        f"{frame_gesture} "
                        f"({frame_confidence:.2f}) "
                        f"[{candidate_frames}/"
                        f"{STABLE_FRAMES_REQUIRED}]"
                    )

                    # ------------------------------------------------
                    # Stable gesture reached
                    # ------------------------------------------------

                    if (
                        candidate_frames
                        >= STABLE_FRAMES_REQUIRED
                    ):

                        stable_gesture = (
                            candidate_gesture
                        )

                        # Don't repeat a gesture while it is
                        # still being held.
                        if (
                            stable_gesture
                            != active_gesture
                        ):

                            now = time.monotonic()

                            # Extra command cooldown.
                            if (
                                now
                                - last_command_time
                                >= COMMAND_COOLDOWN
                            ):

                                print(
                                    "[CV] Stable gesture: "
                                    f"{stable_gesture}"
                                )

                                print(
                                    "[CV] Average confidence: "
                                    f"{average_confidence:.2f}"
                                )

                                # 1. Send CV event and keep its ID
                                # ------------------------------------------------

                                event_record = (
                                    pocketlab.send_event(
                                        gesture=stable_gesture,
                                        confidence=average_confidence,
                                        hand_count=len(
                                            result.gestures
                                        ),
                                    )
                                )

                                event_sent = (
                                    event_record is not None
                                )

                                if event_sent:

                                    print(
                                        "[CV] Sent stable gesture: "
                                        f"{stable_gesture} "
                                        f"({average_confidence:.2f})"
                                    )

                                else:

                                    print(
                                        "[CV] Could not send "
                                        f"{stable_gesture}"
                                    )

                                # ------------------------------------------------
                                # 2. Gesture → command
                                # ------------------------------------------------

                                command = (
                                    gesture_to_command(
                                        stable_gesture
                                    )
                                )

                                if command:

                                    print(
                                        "[IOT] Gesture mapped: "
                                        f"{stable_gesture} "
                                        f"→ {command}"
                                    )

                                    command_success = (
                                        pocketlab.send_command(
                                            command
                                        )
                                    )

                                    if command_success:

                                        print(
                                            "[IOT] Gesture action "
                                            "completed successfully."
                                        )

                                    else:

                                        print(
                                            "[IOT] Gesture action "
                                            "failed."
                                        )

                                    # --------------------------------------------
                                    # Link final IoT command state to this CV event.
                                    # --------------------------------------------

                                    if event_record:

                                        event_id = (
                                            event_record.get("id")
                                        )

                                        command_info = dict(
                                            pocketlab.last_command_info
                                        )

                                        final_command = (
                                            command_info.get("command")
                                            or command
                                        )

                                        final_command_id = (
                                            command_info.get("commandId")
                                        )

                                        final_status = (
                                            command_info.get("status")
                                            or (
                                                "completed"
                                                if command_success
                                                else "failed"
                                            )
                                        )

                                        final_result = (
                                            command_info.get("result")
                                        )

                                        linked = (
                                            pocketlab.update_cv_event(
                                                event_id=event_id,
                                                command=final_command,
                                                command_id=final_command_id,
                                                command_status=final_status,
                                                command_result=final_result,
                                            )
                                        )

                                        if not linked:
                                            print(
                                                "[CV HISTORY] "
                                                "Could not link IoT metadata."
                                            )

                                else:

                                    print(
                                        "[IOT] No command mapped "
                                        f"for {stable_gesture}"
                                    )

                                # Lock this gesture until release.
                                active_gesture = (
                                    stable_gesture
                                )

                                last_command_time = (
                                    now
                                )

                                # Prevent the current stable
                                # gesture from immediately firing again.
                                candidate_frames = 0
                                candidate_confidence_total = 0.0

                # ------------------------------------------------
                # Camera UI
                # ------------------------------------------------

                cv2.rectangle(
                    frame,
                    (10, 10),
                    (1050, 80),
                    (0, 0, 0),
                    -1,
                )

                cv2.putText(
                    frame,
                    display_text,
                    (20, 52),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.70,
                    (0, 255, 0),
                    2,
                    cv2.LINE_AA,
                )

                cv2.imshow(
                    "PocketLab - AI Gesture Recognition",
                    frame,
                )

                key = (
                    cv2.waitKey(1)
                    & 0xFF
                )

                if key in (
                    ord("q"),
                    ord("Q"),
                ):

                    break

    finally:

        cap.release()

        cv2.destroyAllWindows()


# ============================================================
# ENTRY POINT
# ============================================================

if __name__ == "__main__":
    main()