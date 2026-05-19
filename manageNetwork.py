import sqlite3
import subprocess
import sys
import time

# Database file and NetworkManager profile names
DB_PATH = "bloombox.db"
CLIENT_PROFILE = "bloombox-client"
HOTSPOT_PROFILE = "bloombox-hotspot"
HOTSPOT_SSID = "Bloombox"

# Timing constants
POLL_INTERVAL = 5 # seconds between piConfig polls
CONNECT_TIMEOUT = 30 # seconds to wait for a wifi join before falling back
WIFI_CHANGE_SETTLE = 3 # seconds to wait for paired ssid/password writes to land

# Default piConfig values inserted on first run
DEFAULTS = {
    "wifiSsid": "",
    "wifiPassword": "",
    "hotspotPassword": "bloombox123",
    "networkStatus": "starting",
}

# Open a connection to the bloombox database with WAL mode enabled
def dbConnect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn

# Create piConfig table if missing and insert defaults for any missing settings
def ensureDefaults() -> None:

    # Connect to database
    conn = dbConnect()
    cursor = conn.cursor()

    # Create table if it doesn't exist and insert any missing default settings
    cursor.execute("CREATE TABLE IF NOT EXISTS piConfig (setting TEXT PRIMARY KEY, value TEXT)")
    for setting, value in DEFAULTS.items():
        cursor.execute("INSERT OR IGNORE INTO piConfig(setting, value) VALUES (?, ?)", (setting, value))

    conn.commit()
    conn.close()

# Read all piConfig settings from database into a dictionary
def readConfig() -> dict:

    # Connect to database
    conn = dbConnect()

    # Read all settings into a dictionary
    rows = conn.execute("SELECT setting, value FROM piConfig").fetchall()

    conn.close()
    return {s: v for s, v in rows}

# Write the current network status back to piConfig
def writeStatus(value: str) -> None:
    conn = dbConnect()
    conn.execute(
        "INSERT INTO piConfig(setting, value) VALUES ('networkStatus', ?) "
        "ON CONFLICT(setting) DO UPDATE SET value = excluded.value",
        (value,),
    )
    conn.commit()
    conn.close()

# Run an nmcli command with sudo and return the completed process
def nmcli(*args, check: bool = False, timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["sudo", "nmcli", *args],
        capture_output=True, text=True, check=check, timeout=timeout,
    )

# Find the wifi interface name, falling back to wlan0 if detection fails
def getWifiInterface() -> str:

    # Try to ask nmcli for the list of devices and pick the first wifi one
    try:
        out = nmcli("-t", "-f", "DEVICE,TYPE", "device", check=True)

        # Loop through devices to find the first wifi one
        for line in out.stdout.splitlines():
            parts = line.split(":")
            if len(parts) >= 2 and parts[1] == "wifi":
                return parts[0]
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        pass
    return "wlan0"

# Delete a NetworkManager connection profile if it exists
def deleteProfile(name: str) -> None:
    nmcli("connection", "delete", name, check=False)

# Create the wifi client profile with the given SSID and password
def ensureClientProfile(ssid: str, password: str, iface: str) -> None:

    # Remove any existing client profile so we start fresh
    deleteProfile(CLIENT_PROFILE)

    # Build the nmcli arguments for the new profile
    args = [
        "connection", "add",
        "type", "wifi",
        "con-name", CLIENT_PROFILE,
        "ifname", iface,
        "ssid", ssid,
        "connection.autoconnect", "yes",
    ]

    # Add WPA2 password if one was supplied
    if password:
        args += ["wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", password]
    nmcli(*args, check=True)

# Create the Bloombox hotspot profile with the given password
def ensureHotspotProfile(password: str, iface: str) -> None:

    # Remove any existing hotspot profile so we start fresh
    deleteProfile(HOTSPOT_PROFILE)

    # Add the base hotspot profile
    nmcli(
        "connection", "add",
        "type", "wifi",
        "con-name", HOTSPOT_PROFILE,
        "ifname", iface,
        "ssid", HOTSPOT_SSID,
        "autoconnect", "no",
        check=True,
    )

    # Configure access point mode and WPA2 password
    nmcli(
        "connection", "modify", HOTSPOT_PROFILE,
        "802-11-wireless.mode", "ap",
        "802-11-wireless.band", "bg",
        "ipv4.method", "shared",
        "wifi-sec.key-mgmt", "wpa-psk",
        "wifi-sec.psk", password,
        check=True,
    )

# Bring up a NetworkManager profile, waiting up to timeout seconds for it to establish
def bringUp(profile: str, timeout: int) -> bool:
    result = nmcli("--wait", str(timeout), "connection", "up", profile,
                   check=False, timeout=timeout + 10)
    return result.returncode == 0

# Check the wifi device is actually connected with our profile and has an IPv4 address.
def isClientHealthy(iface: str, profile: str) -> bool:

    # Try to read device state from nmcli
    try:
        out = nmcli("-t", "-f", "GENERAL.STATE,GENERAL.CONNECTION,IP4.ADDRESS",
                    "device", "show", iface, check=False, timeout=10)
    except subprocess.TimeoutExpired:
        return False

    # Parse the device state output line by line
    state = ""
    connection = ""
    hasIp = False
    for line in out.stdout.splitlines():
        key, _, value = line.partition(":")
        value = value.strip()
        if key == "GENERAL.STATE":
            state = value
        elif key == "GENERAL.CONNECTION":
            connection = value
        elif key.startswith("IP4.ADDRESS") and value:
            hasIp = True

    return "connected" in state and connection == profile and hasIp

# Main loop
def main() -> None:

    # Make sure piConfig has all the network settings we need
    ensureDefaults()

    # Verify nmcli is available before entering the loop
    try:
        nmcli("--version", check=True, timeout=5)
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired) as e:
        print(f"nmcli unavailable, manageNetwork cannot run: {e}", file=sys.stderr)
        writeStatus("error:nmcli-unavailable")
        sys.exit(1)

    # Find the wifi interface to operate on
    iface = getWifiInterface()
    print(f"manageNetwork: using wifi interface {iface}")

    # Track what the user last asked for and what we last applied
    prevSsid = None
    prevWifiPwd = None
    prevHotspotPwd = None
    mode = None

    # Loop forever
    while True:

        # Try to read configuration
        try:
            config = readConfig()
        except sqlite3.OperationalError as e:
            print(f"manageNetwork: db read failed: {e}", file=sys.stderr)
            time.sleep(POLL_INTERVAL)
            continue

        # Pull current credentials from the config with sensible fallbacks
        ssid = (config.get("wifiSsid") or "").strip()
        wifiPwd = config.get("wifiPassword") or ""
        hotspotPwd = (config.get("hotspotPassword") or "").strip() or "bloombox123"

        # Detect which credentials have changed since the last poll
        wifiChanged = ssid != prevSsid or wifiPwd != prevWifiPwd
        hotspotChanged = hotspotPwd != prevHotspotPwd

        prevSsid, prevWifiPwd, prevHotspotPwd = ssid, wifiPwd, hotspotPwd

        try:
            # If we think we're a client but the device says otherwise
            # (signal lost, router rebooted), force a rejoin attempt
            if mode == "client" and not isClientHealthy(iface, CLIENT_PROFILE):
                print("manageNetwork: client connection lost, will retry")
                writeStatus(f"reconnecting:{ssid}")
                mode = None

            # Attempt to join the configured network, falling back to hotspot.
            if ssid and (wifiChanged or mode is None):
                if wifiChanged:
                    time.sleep(WIFI_CHANGE_SETTLE)

                    # Re-read config after settling so we use the latest pair
                    try:
                        config = readConfig()
                        ssid = (config.get("wifiSsid") or "").strip()
                        wifiPwd = config.get("wifiPassword") or ""
                        prevSsid, prevWifiPwd = ssid, wifiPwd
                    except sqlite3.OperationalError as e:
                        print(f"manageNetwork: settle re-read failed: {e}", file=sys.stderr)

                    # If user cleared the SSID, drop back to top of loop to start hotspot
                    if not ssid:
                        continue

                # Try to join the configured network
                print(f"manageNetwork: attempting to join '{ssid}'")
                writeStatus(f"connecting:{ssid}")
                try:
                    ensureClientProfile(ssid, wifiPwd, iface)
                    connected = bringUp(CLIENT_PROFILE, CONNECT_TIMEOUT) \
                        and isClientHealthy(iface, CLIENT_PROFILE)
                except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
                    print(f"manageNetwork: client profile error: {e}", file=sys.stderr)
                    connected = False

                # Update mode and status based on whether the join succeeded
                if connected:
                    mode = "client"
                    writeStatus(f"connected:{ssid}")
                    print(f"manageNetwork: connected to {ssid}")
                else:

                    # Auto fallback to hotspot so the user can fix credentials
                    print(f"manageNetwork: failed to join '{ssid}', falling back to hotspot")
                    try:
                        ensureHotspotProfile(hotspotPwd, iface)
                        bringUp(HOTSPOT_PROFILE, 15)
                        mode = "hotspot-fallback"
                        writeStatus(f"hotspot-fallback:{ssid}")
                    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
                        print(f"manageNetwork: fallback hotspot failed: {e}", file=sys.stderr)
                        writeStatus("error:hotspot-failed")

            # Start the Bloombox hotspot when no SSID is configured
            elif not ssid and mode != "hotspot":
                print("manageNetwork: starting Bloombox hotspot")
                try:
                    ensureHotspotProfile(hotspotPwd, iface)
                    if bringUp(HOTSPOT_PROFILE, 15):
                        mode = "hotspot"
                        writeStatus("hotspot")
                    else:
                        writeStatus("error:hotspot-failed")
                except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
                    print(f"manageNetwork: hotspot error: {e}", file=sys.stderr)
                    writeStatus("error:hotspot-failed")

            # Rebuild the hotspot if the password changed while one is running
            elif hotspotChanged and mode in ("hotspot", "hotspot-fallback"):
                print("manageNetwork: hotspot password changed, rebuilding")
                try:
                    ensureHotspotProfile(hotspotPwd, iface)
                    bringUp(HOTSPOT_PROFILE, 15)
                except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
                    print(f"manageNetwork: hotspot rebuild failed: {e}", file=sys.stderr)

        except Exception as e:
            print(f"manageNetwork: unexpected error: {e}", file=sys.stderr)

        time.sleep(POLL_INTERVAL)

if __name__ == "__main__":
    main()
