// Briefly show a message
function showMessage(msg, type = 'success') {
    const t = document.getElementById('message');
    t.textContent = msg;
    t.className = `message show ${type}`;
    clearTimeout(t._t);
    t._t = setTimeout(() => t.className = 'message', 2800);
}

// Communicate with the server
async function api(method, path, body) {
    const res = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Request failed');
    return data;
}

// System state populated from arduinoConfig on load (used to check when a setting changes)
const systemState = {
    systemCount: 1,
    systems: {}
};
function getSystem(id) {
    if (!systemState.systems[id]) systemState.systems[id] = {};
    return systemState.systems[id];
}

// Load the system configuration
async function loadSystemCards() {
    try {
        const rows = await api('GET', '/arduinoConfig');
        rows.forEach(({ setting, systemId, value }) => {
            const sid = parseInt(systemId);
            if (setting === 'systemCount') {
                systemState.systemCount = parseInt(value);
            } else if (sid > 0) {
                const sys = getSystem(sid);
                switch (setting) {
                    case 'systemName':     sys.name           = value;             break;
                    case 'targetHumidity': sys.targetHumidity = parseFloat(value); break;
                    case 'targetLight':    sys.targetLight    = parseFloat(value); break;
                    case 'ventMode':       sys.ventMode       = value;             break;
                    case 'ventManual':     sys.ventManual     = parseFloat(value); break;
                    case 'lightMode':      sys.lightMode      = value;             break;
                    case 'lightManual':    sys.lightManual    = parseFloat(value); break;
                    case 'dayTime':        sys.dayTime        = String(value).slice(0, 5); break;
                    case 'nightTime':      sys.nightTime      = String(value).slice(0, 5); break;
                }
            }
        });
    } catch (e) {
        showMessage('Failed to load configuration', 'error');
        console.error(e);
    }
    document.getElementById('systemCount-display').value = systemState.systemCount;
    renderSystemRows();
    renderDayNightRows();
}

// Render one day/night time row per system
function renderDayNightRows() {
    const container = document.getElementById('dayNightRows');
    if (!container) return;
    container.innerHTML = '';
    for (let i = 1; i <= systemState.systemCount; i++) {
        const sys   = getSystem(i);
        const name  = sys.name      ?? `System ${i}`;
        const day   = sys.dayTime   ?? '08:00';
        const night = sys.nightTime ?? '20:00';
        container.insertAdjacentHTML('beforeend', `
            <div class="setting-row">
                <div class="setting-info">
                    <p class="setting-name">${name}</p>
                    <p class="setting-hint">Day starts and night starts for this system</p>
                </div>
                <div class="setting-control">
                    <input type="time" id="dayTime-${i}"   value="${day}"   data-saved="${day}"
                        oninput="onDayNightChange(${i})">
                    <input type="time" id="nightTime-${i}" value="${night}" data-saved="${night}"
                        oninput="onDayNightChange(${i})">
                    <button class="btn-read" id="dayNight-save-${i}" onclick="saveDayNight(${i})" disabled>Save</button>
                </div>
            </div>
        `);
    }
}

function onDayNightChange(i) {
    const dayEl   = document.getElementById(`dayTime-${i}`);
    const nightEl = document.getElementById(`nightTime-${i}`);
    const btn     = document.getElementById(`dayNight-save-${i}`);
    if (!btn) return;
    btn.disabled = dayEl.value === dayEl.dataset.saved && nightEl.value === nightEl.dataset.saved;
}

async function saveDayNight(i) {
    const dayEl   = document.getElementById(`dayTime-${i}`);
    const nightEl = document.getElementById(`nightTime-${i}`);
    try {
        await Promise.all([
            api('PUT', `/arduinoConfig/dayTime/${i}`,   { value: dayEl.value }),
            api('PUT', `/arduinoConfig/nightTime/${i}`, { value: nightEl.value })
        ]);
        dayEl.dataset.saved   = dayEl.value;
        nightEl.dataset.saved = nightEl.value;
        const sys = getSystem(i);
        sys.dayTime   = dayEl.value;
        sys.nightTime = nightEl.value;
        onDayNightChange(i);
        showMessage('Saved — your greenhouse will update shortly');
    } catch (e) {
        showMessage(e.message, 'error');
    }
}

// Render rows for system control
function renderSystemRows() {
    const container = document.getElementById('systemRows');
    container.innerHTML = '';

    for (let i = 1; i <= systemState.systemCount; i++) {
        const sys       = getSystem(i);
        const name      = sys.name           ?? `System ${i}`;
        const humidity  = sys.targetHumidity ?? 50;
        const light     = sys.targetLight    ?? 500;
        const ventMode  = sys.ventMode       ?? 'auto';
        const lightMode = sys.lightMode      ?? 'auto';
        const ventMan   = sys.ventManual     ?? 50;
        const lightMan  = sys.lightManual    ?? 50;

        const onChange  = `updateRowSaveBtn(${i})`;

        // Ventilation slider - target humidity or vent open % depending on mode
        const ventControl = ventMode === 'auto' ? `
            <div class="slider-row">
                <input type="range" min="0" max="100" value="${humidity}"
                    id="targetHumidity-${i}" data-saved="${humidity}"
                    oninput="document.getElementById('targetHumidity-val-${i}').textContent = this.value; ${onChange}">
                <span class="slider-value" id="targetHumidity-val-${i}">${humidity}</span>
                <span class="slider-unit">% humidity</span>
            </div>`
            :
            `<div class="slider-row">
                <input type="range" min="0" max="100" value="${ventMan}"
                    id="ventManual-${i}" data-saved="${ventMan}"
                    oninput="document.getElementById('ventManual-val-${i}').textContent = this.value; ${onChange}">
                <span class="slider-value" id="ventManual-val-${i}">${ventMan}</span>
                <span class="slider-unit">% open</span>
            </div>`;

        // Lighting slider - target level or LED brightness depending on mode
        const lightControl = lightMode === 'auto' ? `
            <div class="slider-row">
                <input type="range" min="0" max="1000" step="10" value="${light}"
                    id="targetLight-${i}" data-saved="${light}"
                    oninput="document.getElementById('targetLight-val-${i}').textContent = this.value; ${onChange}">
                <span class="slider-value" id="targetLight-val-${i}">${light}</span>
                <span class="slider-unit">PPFD</span>
            </div>`
            :
            `<div class="slider-row">
                <input type="range" min="0" max="100" value="${lightMan}"
                    id="lightManual-${i}" data-saved="${lightMan}"
                    oninput="document.getElementById('lightManual-val-${i}').textContent = this.value; ${onChange}">
                <span class="slider-value" id="lightManual-val-${i}">${lightMan}</span>
                <span class="slider-unit">% brightness</span>
            </div>`;

        container.insertAdjacentHTML('beforeend', `
            <div class="system-row">

                <!-- Name -->
                <div class="sys-col-name">
                    <input class="system-name-input" type="text" maxlength="20"
                        id="systemName-${i}" value="${name}" data-saved="${name}"
                        oninput="${onChange}"
                        placeholder="System ${i}">
                </div>

                <!-- Ventilation -->
                <div class="sys-col-control">
                    <div class="mode-toggle">
                        <button class="mode-btn ${ventMode === 'auto'   ? 'active' : ''}" onclick="setMode(${i}, 'vent', 'auto')">Auto</button>
                        <button class="mode-btn ${ventMode === 'manual' ? 'active' : ''}" onclick="setMode(${i}, 'vent', 'manual')">Manual</button>
                    </div>
                    ${ventControl}
                </div>

                <!-- Lighting -->
                <div class="sys-col-control">
                    <div class="mode-toggle">
                        <button class="mode-btn ${lightMode === 'auto'   ? 'active' : ''}" onclick="setMode(${i}, 'light', 'auto')">Auto</button>
                        <button class="mode-btn ${lightMode === 'manual' ? 'active' : ''}" onclick="setMode(${i}, 'light', 'manual')">Manual</button>
                    </div>
                    ${lightControl}
                </div>

                <!-- Save -->
                <div class="sys-col-save">
                    <button class="btn-read" id="row-save-${i}" onclick="saveRow(${i})" disabled>Save</button>
                </div>

            </div>`);
    }
}

// Enables the row's save button if any field differs from its last-saved value.
function updateRowSaveBtn(i) {
    const sys = getSystem(i);
    const ventMode = sys.ventMode ?? 'auto';
    const lightMode = sys.lightMode ?? 'auto';

    const nameEl = document.getElementById(`systemName-${i}`);
    const ventEl = document.getElementById(ventMode === 'auto' ? `targetHumidity-${i}` : `ventManual-${i}`);
    const lightEl = document.getElementById(lightMode === 'auto' ? `targetLight-${i}` : `lightManual-${i}`);

    const changed =
        (nameEl && nameEl.value !== nameEl.dataset.saved) ||
        (ventEl && ventEl.value !== ventEl.dataset.saved) ||
        (lightEl && lightEl.value !== lightEl.dataset.saved);

    const btn = document.getElementById(`row-save-${i}`);
    if (btn) btn.disabled = !changed;
}

// Save an entire row
async function saveRow(i) {
    const sys = getSystem(i);
    const ventMode = sys.ventMode ?? 'auto';
    const lightMode = sys.lightMode ?? 'auto';

    const nameEl = document.getElementById(`systemName-${i}`);
    const ventEl = document.getElementById(ventMode === 'auto' ? `targetHumidity-${i}` : `ventManual-${i}`);
    const lightEl = document.getElementById(lightMode === 'auto' ? `targetLight-${i}` : `lightManual-${i}`);

    const ventSetting = ventMode === 'auto' ? 'targetHumidity' : 'ventManual';
    const lightSetting = lightMode === 'auto' ? 'targetLight' : 'lightManual';

    try {
        await Promise.all([
            api('PUT', `/arduinoConfig/systemName/${i}`, { value: nameEl.value }),
            api('PUT', `/arduinoConfig/${ventSetting}/${i}`, { value: ventEl.value }),
            api('PUT', `/arduinoConfig/${lightSetting}/${i}`, { value: lightEl.value }),
        ]);

        // Persist saved values so the button disables again
        nameEl.dataset.saved = nameEl.value;
        ventEl.dataset.saved = ventEl.value;
        lightEl.dataset.saved = lightEl.value;

        // Keep local state in sync
        sys.name = nameEl.value;
        if (ventMode === 'auto') {
            sys.targetHumidity = parseFloat(ventEl.value);
        } else {
            sys.ventManual = parseFloat(ventEl.value);
        } if (lightMode === 'auto') {
            sys.targetLight = parseFloat(lightEl.value);
        } else {
            sys.lightManual = parseFloat(lightEl.value);
        }

        updateRowSaveBtn(i);
        showMessage('Saved — your greenhouse will update shortly');
    } catch (e) {
        showMessage(e.message, 'error');
    }
}

// Toggle vents or lighting to auto or manual
async function setMode(systemId, type, mode) {
    const setting = type === 'vent' ? 'ventMode' : 'lightMode';
    try {
        await api('PUT', `/arduinoConfig/${setting}/${systemId}`, { value: mode });
        const sys = getSystem(systemId);
        if (type === 'vent') sys.ventMode  = mode;
        else                 sys.lightMode = mode;
        renderSystemRows();
        showMessage('Mode updated — your greenhouse will update shortly');
    } catch (e) {
        showMessage(e.message, 'error');
    }
}

// Change system count
async function changeSystemCount(change) {
    const min = 1;
    const max = 3;
    step('systemCount-display', '', change);
    saveArduino('systemCount', 0, 'systemCount-display');
    systemState.systemCount = Math.min(max, Math.max(min, systemState.systemCount + change));
    renderSystemRows();
    renderDayNightRows();
}


// Load pi config — only populates time-shaped inputs (manualTime, dayTime, etc).
// Other piConfig settings (network credentials, etc) are loaded by their own functions.
async function loadPiConfig() {
    const rows = await api('GET', '/piConfig');
    rows.forEach(row => {
        const el = document.getElementById(row.setting);
        if (el && el.type === 'time') {
            el.value = row.value.slice(0, 5);
            el.dataset.saved = el.value;
        }
    });
}

// Save pi config
async function savePi(setting, inputId, btnId) {
    try {
        const input = document.getElementById(inputId);
        await api('PUT', `/piConfig/${setting}`, { value: input.value });
        input.dataset.saved = input.value;
        handleChange(inputId, btnId);
        showMessage('Saved - Your greenhouse will update shortly');
    } catch (e) {
        showMessage(e.message, 'error');
    }
}

// Reflect the current clock mode in the UI
function setClockModeUI(mode) {
    const auto   = document.getElementById('clockMode-auto');
    const manual = document.getElementById('clockMode-manual');
    if (auto)   auto.classList.toggle('active',   mode === 'auto');
    if (manual) manual.classList.toggle('active', mode === 'manual');

    const input = document.getElementById('manualTime');
    const btn   = document.getElementById('manualTime-btn');
    if (input) input.disabled = (mode !== 'manual');
    if (btn) {
        const unchanged = input && input.value === input.dataset.saved;
        btn.disabled = (mode !== 'manual') || unchanged;
    }
}

// Save the chosen clock mode to piConfig and update the UI
async function setClockMode(mode) {
    try {
        await api('PUT', '/piConfig/clockMode', { value: mode });
        setClockModeUI(mode);
        showMessage('Clock mode updated - Your greenhouse will update shortly');
    } catch (e) {
        showMessage(e.message, 'error');
    }
}

// Read the saved clock mode from piConfig and apply it to the UI
async function loadClockMode() {
    try {
        const rows = await api('GET', '/piConfig');
        const row = rows.find(r => r.setting === 'clockMode');
        setClockModeUI((row && row.value) || 'auto');
    } catch (e) {
        showMessage('Could not load clock mode', 'error');
    }
}

// Load advanced interval settings
async function loadAdvancedSettings() {
    try {
        const rows = await api('GET', '/arduinoConfig');
        rows.forEach(({ setting, systemId, value }) => {
            const el = document.getElementById(setting);
            if (el && systemId == 0) {
                el.value = value;
                el.dataset.saved = value;
            }
        });
    } catch (e) {
        showMessage('Could not load settings', 'error');
    }
}

// Save arduino config
async function saveArduino(setting, systemId, inputId, btnId) {
    try {
        const input = document.getElementById(inputId);
        await api('PUT', `/arduinoConfig/${setting}/${systemId}`, { value: input.value });
        input.dataset.saved = input.value;
        handleChange(inputId, btnId);
        showMessage('Saved - Your greenhouse will update shortly');
    } catch (e) {
        showMessage(e.message, 'error');
    }
}

// Load watering schedule and render events
async function loadSchedule() {
    const rows = await api('GET', '/waterSchedule');
    const list = document.getElementById('scheduleList');
    if (rows.length === 0) {
        list.innerHTML = '<p class="empty-state">No events scheduled yet. Add one below.</p>';
        return;
    }
    list.innerHTML = rows.map(row => `
        <div class="alert-item" style="display:flex; align-items:center; gap:12px; margin-bottom:0;">
            
            <div class="schedule-field">
              <span class="schedule-label">Time</span>
              <input type="time" id="schedule-time-${row.rowid}" value="${row.time}"
              oninput="handleChange('schedule-time-${row.rowid}', 'schedule-save-${row.rowid}')" data-saved="${row.time}">
            </div>

            <div class="schedule-field">
              <span class="schedule-label">System</span>
              <div class="stepper">
                <button class="stepper-btn" onclick="step('schedule-system-${row.rowid}', 'schedule-save-${row.rowid}', -1)">−</button>
                <input type="number" class="stepper-display" id="schedule-system-${row.rowid}" value="${row.systemId}" min="1" max="3"
                  oninput="handleChange('schedule-system-${row.rowid}', 'schedule-save-${row.rowid}')" data-saved="${row.systemId}">
                <button class="stepper-btn" onclick="step('schedule-system-${row.rowid}', 'schedule-save-${row.rowid}', 1)">+</button>
              </div>
            </div>

            <div class="schedule-field">
              <span class="schedule-label">Seconds</span>
              <div class="stepper">
                <button class="stepper-btn" onclick="step('schedule-amount-${row.rowid}', 'schedule-save-${row.rowid}', -1)">−</button>
                <input type="number" class="stepper-display" id="schedule-amount-${row.rowid}" value="${row.amount}" min="1" max="3600"
                oninput="handleChange('schedule-amount-${row.rowid}', 'schedule-save-${row.rowid}')" data-saved="${row.amount}">
                <button class="stepper-btn" onclick="step('schedule-amount-${row.rowid}', 'schedule-save-${row.rowid}', 1)">+</button>
              </div>
            </div>

            <div class="spacer"></div>
            <button class="btn-read" id="schedule-save-${row.rowid}" onclick="updateEvent(${row.rowid})" disabled>Save</button>
            <button class="btn-delete" onclick="deleteEvent(${row.rowid})">Remove</button>

        </div>
    `).join('');
}

// Update event in watering schedule
async function updateEvent(rowid) {
    try {
        const time = document.getElementById(`schedule-time-${rowid}`);
        const systemId = document.getElementById(`schedule-system-${rowid}`);
        const amount = document.getElementById(`schedule-amount-${rowid}`);
        await api('PUT', `/waterSchedule/${rowid}`, {
            time: time.value,
            systemId: systemId.value,
            amount: amount.value
        });
        time.dataset.saved = time.value;
        systemId.dataset.saved = systemId.value;
        amount.dataset.saved = amount.value;
        handleChange(`schedule-time-${rowid}`, `schedule-save-${rowid}`);
        showMessage('Watering event updated');
    } catch (e) { showMessage(e.message, 'error'); }
}

// Delete event from watering schedule
async function deleteEvent(rowid) {
    try {
        await api('DELETE', `/waterSchedule/${rowid}`);
        showMessage('Event removed');
        loadSchedule();
    } catch (e) { showMessage(e.message, 'error'); }
}

// Add a new event to watering schedule
async function addEvent() {
    const time = document.getElementById('new-time').value;
    const systemId = document.getElementById('new-systemId').value;
    const amount = document.getElementById('new-amount').value;
    if (!time || !systemId || !amount) { 
        showMessage('Fill in all fields', 'error'); 
        return; 
    }
    try {
        await api('POST', '/waterSchedule', { time, systemId, amount });
        showMessage('Event added');
        document.getElementById('new-time').value = '09:00';
        document.getElementById('new-systemId').value = '1';
        document.getElementById('new-amount').value = '30';
        loadSchedule();
    } catch (e) {
        if (e.message.includes('UNIQUE constraint failed')) {
            showMessage('Event already exists', 'error');
        } else {
            showMessage(e.message, 'error'); 
        }
    }
}

// Method to increment/decrement value in a stepper input
function step(inputId, btnId, hop) {
    const input = document.getElementById(inputId);
    const min = parseInt(input.min ?? 1);
    const max = parseInt(input.max ?? 3600000);
    input.value = Math.min(max, Math.max(min, parseInt(input.value || 0) + hop));
    handleChange(inputId, btnId);
}

// Enable/disable a save button based on whether the input value differs from its original value
function handleChange(inputId, btnId) {
    const input = document.getElementById(inputId);
    const btn = document.getElementById(btnId);
    if (btn) {
        btn.disabled = (input.value == input.dataset.saved);
    }
}

// Default values for advanced interval settings
const ADVANCED_DEFAULTS = {
    readingInterval: '60',
    ventInterval: '5000',
    lightInterval: '50'
};

// Reset all interval settings to their defaults and save to db
async function resetToDefaults() {
    try {
        await Promise.all(
            Object.entries(ADVANCED_DEFAULTS).map(([setting, value]) =>
                api('PUT', `/arduinoConfig/${setting}/0`, { value })
            )
        );
        // Update inputs to reflect defaults
        Object.entries(ADVANCED_DEFAULTS).forEach(([setting, value]) => {
            const el = document.getElementById(setting);
            if (el) {
                el.value = value;
                el.dataset.saved = value;
            }
            const btn = document.getElementById(setting + '-btn');
            if (btn) btn.disabled = true;
        });
        showMessage('All settings reset to defaults');
    } catch (e) {
        showMessage('Reset failed: ' + e.message, 'error');
    }
}

// Render the networkStatus piConfig value as a friendly status line
function renderNetworkStatus(raw) {
    const el = document.getElementById('network-status');
    if (!el) return;
    const status = raw || 'unknown';
    const [kind, detail] = status.split(':', 2);
    let text;
    switch (kind) {
        case 'connected':         text = `Connected to ${detail || 'WiFi'}`; break;
        case 'connecting':        text = `Connecting to ${detail || 'WiFi'}…`; break;
        case 'hotspot':           text = `Running Bloombox hotspot`; break;
        case 'hotspot-fallback':  text = `Couldn't join ${detail || 'WiFi'} — running Bloombox hotspot as fallback`; break;
        case 'failed':            text = `Failed to join ${detail || 'WiFi'}`; break;
        case 'starting':          text = 'Starting up…'; break;
        case 'error':             text = `Error: ${detail || 'unknown'}`; break;
        default:                  text = status;
    }
    el.textContent = `Status: ${text}`;
}

// Load network settings (SSID, hotspot password, status)
async function loadNetworkSettings() {
    try {
        const rows = await api('GET', '/piConfig');
        const map = Object.fromEntries(rows.map(r => [r.setting, r.value]));

        const ssidEl = document.getElementById('wifiSsid');
        const wifiPwdEl = document.getElementById('wifiPassword');
        const hotspotPwdEl = document.getElementById('hotspotPassword');

        if (ssidEl) {
            ssidEl.value = map.wifiSsid || '';
            ssidEl.dataset.saved = ssidEl.value;
        }
        if (wifiPwdEl) {
            wifiPwdEl.value = map.wifiPassword || '';
            wifiPwdEl.dataset.saved = wifiPwdEl.value;
        }
        if (hotspotPwdEl) {
            hotspotPwdEl.value = map.hotspotPassword || '';
            hotspotPwdEl.dataset.saved = hotspotPwdEl.value;
        }
        onWifiChange();
        handleChange('hotspotPassword', 'hotspotPassword-btn');
        renderNetworkStatus(map.networkStatus);
    } catch (e) {
        console.error('Failed to load network settings', e);
    }
}

// Poll just the status field so the UI reflects the manageNetwork.py loop.
async function loadNetworkStatus() {
    try {
        const rows = await api('GET', '/piConfig');
        const row = rows.find(r => r.setting === 'networkStatus');
        renderNetworkStatus(row && row.value);
    } catch (e) {}
}

// Enable the WiFi save button if either SSID or password has changed
function onWifiChange() {
    const ssidEl = document.getElementById('wifiSsid');
    const pwdEl = document.getElementById('wifiPassword');
    const btn = document.getElementById('wifi-save-btn');
    if (!ssidEl || !pwdEl || !btn) return;
    const changed = ssidEl.value !== ssidEl.dataset.saved
                 || pwdEl.value !== pwdEl.dataset.saved;
    btn.disabled = !changed || !ssidEl.value.trim();
}

// Save both wifiSsid and wifiPassword
async function saveWifi() {
    const ssidEl = document.getElementById('wifiSsid');
    const pwdEl = document.getElementById('wifiPassword');
    const ssid = ssidEl.value.trim();
    if (!ssid) { showMessage('Enter a network name', 'error'); return; }
    try {
        await Promise.all([
            api('PUT', '/piConfig/wifiSsid', { value: ssid }),
            api('PUT', '/piConfig/wifiPassword', { value: pwdEl.value })
        ]);
        ssidEl.dataset.saved = ssid;
        pwdEl.dataset.saved = pwdEl.value;
        onWifiChange();
        showMessage('WiFi saved — your greenhouse will switch shortly');
    } catch (e) {
        showMessage(e.message, 'error');
    }
}

// Clear saved WiFi credentials so the Pi reverts to hotspot mode
async function forgetWifi() {
    if (!confirm('Forget saved WiFi? Your greenhouse will switch back to its Bloombox hotspot.')) return;
    const ssidEl = document.getElementById('wifiSsid');
    const pwdEl = document.getElementById('wifiPassword');
    try {
        await Promise.all([
            api('PUT', '/piConfig/wifiSsid', { value: '' }),
            api('PUT', '/piConfig/wifiPassword', { value: '' })
        ]);
        ssidEl.value = '';
        pwdEl.value = '';
        ssidEl.dataset.saved = '';
        pwdEl.dataset.saved = '';
        onWifiChange();
        showMessage('WiFi cleared — falling back to Bloombox hotspot');
    } catch (e) {
        showMessage(e.message, 'error');
    }
}

// Save the hotspot password (WPA2 requires 8–63 chars)
async function saveHotspotPassword() {
    const el = document.getElementById('hotspotPassword');
    const pwd = el.value;
    if (pwd.length < 8 || pwd.length > 63) {
        showMessage('Hotspot password must be 8 - 63 characters', 'error');
        return;
    }
    try {
        await api('PUT', '/piConfig/hotspotPassword', { value: pwd });
        el.dataset.saved = pwd;
        handleChange('hotspotPassword', 'hotspotPassword-btn');
        showMessage('Hotspot password saved');
    } catch (e) {
        showMessage(e.message, 'error');
    }
}

loadSystemCards();
loadPiConfig();
loadSchedule();
