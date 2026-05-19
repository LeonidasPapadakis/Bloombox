// Populated by loadAll() from the backend on init and on every poll.
const state = {
    connection: { online: null, lastReadingAt: null },
    plantStress: null, // { score, status, confidence, scannedAt } from /analyse-plant
    plantScanError: null, // last scan failure message, cleared on success
    systemCount: 1,
    systems: {}, 
    schedule: [],
    serverClockSkew: 0
};

function serverNow() {
    return Date.now() - state.serverClockSkew;
}

async function loadServerClockSkew() {
    try {
        const before = Date.now();
        const { now } = await api('GET', '/serverTime');
        // Account for round-trip — server's "now" was sampled mid-flight.
        const rttHalf = (Date.now() - before) / 2;
        state.serverClockSkew = before + rttHalf - now;
    } catch (e) {
        console.warn('Could not sync server clock, falling back to browser time:', e);
        state.serverClockSkew = 0;
    }
}

// Sensor severity bands
const BANDS = {
    temperature: { warn: 3, critical: 6, idealMin: 18, idealMax: 28 },
    humidity:    { warn: 10, critical: 20 },
    light:       { warn: 150, critical: 300 }
};

// How long a system can go without a reading before we consider it offline.
const STALE_AFTER_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 15_000;

// localStorage key for caching the last plant scan so it survives navigation.
const SCAN_CACHE_KEY = 'bloombox.lastPlantScan';

// Communicate with the server
async function api(method, path, body) {
    const res = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `${method} ${path} failed`);
    return data;
}

function ensureSystem(id) {
    if (!state.systems[id]) {
        state.systems[id] = {
            name: `System ${id}`,
            sensors: { temperature: null, humidity: null, light: null },
            sensorTimes: {},
            targets: { humidity: 50, light: 500 },
            modes:   { vent: 'auto', light: 'auto' },
            manuals: { vent: 50, light: 50 },
            lastWateringAt: null,
            nextWateringAt: null,
            lastReadingAt: null,
            online: null,
            dayTime: '08:00',
            nightTime: '20:00',
            plantStress: null,     
            plantScanError: null,
            alerts: [],          
            isDummy: false     
        };
    }
    return state.systems[id];
}

// systemCount, names, targets, modes, manuals
async function loadArduinoConfig() {
    const rows = await api('GET', '/arduinoConfig');
    state.systemCount = 1;
    rows.forEach(({ setting, systemId, value }) => {
        const sid = parseInt(systemId);
        if (setting === 'systemCount') {
            state.systemCount = parseInt(value) || 1;
            return;
        }
        if (sid <= 0) return;
        const sys = ensureSystem(sid);
        switch (setting) {
            case 'systemName':     sys.name             = value;             break;
            case 'targetHumidity': sys.targets.humidity = parseFloat(value); break;
            case 'targetLight':    sys.targets.light    = parseFloat(value); break;
            case 'ventMode':       sys.modes.vent       = value;             break;
            case 'ventManual':     sys.manuals.vent     = parseFloat(value); break;
            case 'lightMode':      sys.modes.light      = value;             break;
            case 'lightManual':    sys.manuals.light    = parseFloat(value); break;
            case 'dayTime':        sys.dayTime          = String(value).slice(0, 5); break;
            case 'nightTime':      sys.nightTime        = String(value).slice(0, 5); break;
        }
    });
    // Make sure every system index has a row even if config rows missing.
    for (let i = 1; i <= state.systemCount; i++) ensureSystem(i);
}

// latest reading per (systemId, sensorType) + connection status
async function loadSensorReadings() {
    const rows = await api('GET', '/sensorData');
    const latestPerKey = new Map();      // key = systemId : sensorType
    const newestPerSystem = new Map();   // key = systemId
    let newestAt = null;

    for (const row of rows) {
        const key = `${row.systemId}:${row.sensorType}`;
        const at = parseSqliteTimestamp(row.timeStamp);
        const prev = latestPerKey.get(key);
        if (!prev || at > prev.at) latestPerKey.set(key, { value: row.sensorValue, at });
        const sysPrev = newestPerSystem.get(row.systemId) || 0;
        if (at > sysPrev) newestPerSystem.set(row.systemId, at);
        if (newestAt == null || at > newestAt) newestAt = at;
    }

    for (const [key, { value, at }] of latestPerKey) {
        const [sidStr, sensorType] = key.split(':');
        const sys = ensureSystem(parseInt(sidStr));
        if (sensorType in sys.sensors) {
            sys.sensors[sensorType] = value;
            sys.sensorTimes[sensorType] = at;
        }
    }

    const now = serverNow();
    for (let i = 1; i <= state.systemCount; i++) {
        const sys = ensureSystem(i);
        const at = newestPerSystem.get(String(i)) || newestPerSystem.get(i) || null;
        sys.lastReadingAt = at;
        sys.online = at != null ? (now - at) < STALE_AFTER_MS : null;
    }

    state.connection.lastReadingAt = newestAt;
    state.connection.online = newestAt != null && (now - newestAt) < STALE_AFTER_MS;
}

// True if the given system's configured night window contains the Pi-equivalent time right now.
function isNightForSystem(sys) {
    const now = new Date(serverNow());
    const cur = now.getHours() * 60 + now.getMinutes();
    const [dh, dm] = (sys.dayTime   || '08:00').split(':').map(Number);
    const [nh, nm] = (sys.nightTime || '20:00').split(':').map(Number);
    const day   = dh * 60 + dm;
    const night = nh * 60 + nm;
    if (day < night) return cur < day || cur >= night;
    return cur < day && cur >= night;
}

// Pi-equivalent wall-clock time as HH:MM:SS
function fmtSystemClock() {
    return new Date(serverNow()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function tickSystemClock() {
    const el = document.getElementById('systemClock');
    if (el) el.textContent = fmtSystemClock();
}

// derive next/last watering time per system from recurring HH:MM events
async function loadWaterSchedule() {
    state.schedule = await api('GET', '/waterSchedule');

    // Reset before recomputing
    for (const sid in state.systems) {
        state.systems[sid].lastWateringAt = null;
        state.systems[sid].nextWateringAt = null;
    }

    const now = new Date();
    for (const evt of state.schedule) {
        const sys = ensureSystem(parseInt(evt.systemId));
        const [h, m] = evt.time.split(':').map(Number);
        const today = new Date(now); today.setHours(h, m, 0, 0);
        const past   = today <= now ? today : new Date(today.getTime() - 86_400_000);
        const future = today >  now ? today : new Date(today.getTime() + 86_400_000);

        if (sys.lastWateringAt == null || past.getTime()   > sys.lastWateringAt) sys.lastWateringAt = past.getTime();
        if (sys.nextWateringAt == null || future.getTime() < sys.nextWateringAt) sys.nextWateringAt = future.getTime();
    }
}

// SQLite TEXT timestamps come back as 'YYYY-MM-DD HH:MM:SS' written in the Pi's local time
function parseSqliteTimestamp(ts) {
    if (!ts) return 0;
    const iso = /Z|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts.replace(' ', 'T');
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? 0 : ms;
}

// Restore last plant scan from localStorage so it persists across navigation/refresh.
// Only system 1 has a real camera; the cached scan always belongs to it.
function loadCachedPlantScan() {
    try {
        const raw = localStorage.getItem(SCAN_CACHE_KEY);
        if (raw) ensureSystem(1).plantStress = JSON.parse(raw);
    } catch {}
}

// Auto-triggered on page load. Writes the scan result into system 1.
async function runPlantScan() {
    const sys = ensureSystem(1);
    try {
        const resp = await api('GET', '/analyse-plant');
        const ml = resp.stress || {};
        const score = Math.round(Number(ml.stress));
        if (Number.isNaN(score)) throw new Error('No stress score returned');

        sys.plantStress = {
            score,
            status: ml.status || stressStatus(score),
            confidence: ml.confidence != null ? Number(ml.confidence) : null,
            scannedAt: ml.date_time ? Date.parse(ml.date_time) : Date.now()
        };
        sys.plantScanError = null;
        try { localStorage.setItem(SCAN_CACHE_KEY, JSON.stringify(sys.plantStress)); } catch {}
    } catch (e) {
        sys.plantScanError = e.message;
        console.error('Plant scan failed:', e);
    } finally {
        renderSystems();
    }
}

function stressStatus(score) {
    if (score >= 60) return 'High Stress';
    if (score >= 35) return 'Mild Stress';
    return 'Low Stress';
}

// Helpers

function showMessage(msg, type = 'success') {
    const t = document.getElementById('message');
    t.textContent = msg;
    t.className = `message show ${type}`;
    clearTimeout(t._t);
    t._t = setTimeout(() => t.className = 'message', 2500);
}

function fmtRelative(ms) {
    if (ms == null) return '--';
    const diff = serverNow() - ms;
    const abs = Math.abs(diff);
    const future = diff < 0;
    const mins = Math.round(abs / 60_000);
    if (mins < 1)   return future ? 'in a moment' : 'just now';
    if (mins < 60)  return future ? `in ${mins} min`  : `${mins} min`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24)   return future ? `in ${hrs}h`      : `${hrs}h`;
    const days = Math.round(hrs / 24);
    return future ? `in ${days}d` : `${days}d`;
}

function fmtTime(ms) {
    if (ms == null) return '--';
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function severity(metric, value, target) {
    if (value == null) return 'unknown';
    if (metric === 'temperature') {
        const { idealMin, idealMax, warn, critical } = BANDS.temperature;
        const dist = value < idealMin ? idealMin - value : value > idealMax ? value - idealMax : 0;
        if (dist >= critical) return 'critical';
        if (dist >= warn)     return 'warn';
        return 'ok';
    }
    if (target == null) return 'ok';
    const dist = Math.abs(value - target);
    const { warn, critical } = BANDS[metric] || {};
    if (critical != null && dist >= critical) return 'critical';
    if (warn     != null && dist >= warn)     return 'warn';
    return 'ok';
}

function systemSeverity(sys) {
    const t = severity('temperature', sys.sensors.temperature);
    const h = severity('humidity',    sys.sensors.humidity, sys.targets.humidity);
    const l = severity('light',       sys.sensors.light,    sys.targets.light);
    if ([t, h, l].includes('critical')) return 'critical';
    if ([t, h, l].includes('warn'))     return 'warn';
    return 'ok';
}

// Derive alerts per system. Each system block shows only its own alerts.
function deriveAlerts() {
    for (let i = 1; i <= state.systemCount; i++) {
        const sys = state.systems[i];
        if (!sys) continue;
        const out = [];

        if (sys.online === false) {
            out.push({
                id: `${i}-conn`,
                severity: 'critical',
                title: `${sys.name} offline`,
                desc: sys.lastReadingAt
                    ? `No readings received in ${fmtRelative(sys.lastReadingAt)}. Check your power supply.`
                    : 'No sensor readings have been received yet.',
                at: sys.lastReadingAt
            });
        } else {
            const checks = [
                ['temperature', sys.sensors.temperature, null,                 `${sys.name}: temperature out of comfort range`,  v => `Reading ${v.toFixed(1)}°C is outside the ${BANDS.temperature.idealMin}–${BANDS.temperature.idealMax}°C range.`],
                ['humidity',    sys.sensors.humidity,    sys.targets.humidity, `${sys.name}: humidity ${sys.sensors.humidity != null && sys.sensors.humidity > (sys.targets.humidity ?? 0) ? 'above' : 'below'} target`, v => `Reading ${v.toFixed(0)}% vs target ${sys.targets.humidity}%.`],
                ['light',       sys.sensors.light,       sys.targets.light,    `${sys.name}: light level off target`,            v => `Reading ${v.toFixed(0)} vs target ${sys.targets.light} PPFD.`]
            ];
            checks.forEach(([metric, value, target, title, descFn]) => {
                const at = sys.sensorTimes[metric];
                // Dummy systems have synthetic timestamps; allow alerts despite no real freshness signal.
                if (!sys.isDummy && (at == null || (serverNow() - at) >= STALE_AFTER_MS)) return;
                const sev = severity(metric, value, target);
                if (sev === 'warn' || sev === 'critical') {
                    out.push({
                        id: `${i}-${metric}`,
                        severity: sev === 'critical' ? 'critical' : 'warning',
                        title,
                        desc: descFn(value),
                        at: at || serverNow()
                    });
                }
            });
        }

        out.sort((a, b) => (a.severity === 'critical' ? -1 : 1) - (b.severity === 'critical' ? -1 : 1));
        sys.alerts = out;
    }
}

// Renderers

function renderAlertsHTML(sys) {
    if (!sys.alerts.length) {
        return '<p class="empty-state">No active alerts.</p>';
    }
    return sys.alerts.map(a => `
        <div class="alert-item dash-alert">
            <span class="alert-tag tag-${a.severity === 'critical' ? 'critical' : 'warning'}">
                ${a.severity === 'critical' ? 'CRITICAL' : 'WARNING'}
            </span>
            <div class="alert-body">
                <p class="alert-title">${escapeHtml(a.title)}</p>
                <p class="alert-desc">${escapeHtml(a.desc)}</p>
                <p class="alert-time">${fmtRelative(a.at)}</p>
            </div>
        </div>
    `).join('');
}

function renderHealthHTML(sys) {
    const ps = sys.plantStress;
    if (ps && ps.score != null) {
        const cls = ps.score >= 60 ? 'high' : ps.score >= 35 ? 'medium' : '';
        const sub =
            (ps.scannedAt ? `Last scan ${fmtRelative(ps.scannedAt)}` : 'No scan timestamp') +
            (ps.confidence != null ? ` · ${ps.confidence}% confidence` : '');
        return `
            <div class="health-row">
                <div class="health-circle ${cls}">
                    <span class="health-num">${ps.score}</span>
                    <span class="health-out">/100</span>
                </div>
                <div class="health-text">
                    <p class="health-status">${escapeHtml(ps.status || stressStatus(ps.score))}</p>
                    <p class="health-sub">${escapeHtml(sub)}</p>
                </div>
            </div>`;
    }
    if (sys.plantScanError) {
        return `
            <div class="health-row">
                <div class="health-circle unknown"><span class="health-num">--</span><span class="health-out">/100</span></div>
                <div class="health-text">
                    <p class="health-status">Scan unavailable</p>
                    <p class="health-sub">Could not reach the camera (${escapeHtml(sys.plantScanError)})</p>
                </div>
            </div>`;
    }
    return `
        <div class="health-row">
            <div class="health-circle unknown"><span class="health-num">--</span><span class="health-out">/100</span></div>
            <div class="health-text">
                <p class="health-status">Scanning…</p>
                <p class="health-sub">Capturing and analysing plant</p>
            </div>
        </div>`;
}

function renderSystems() {
    const container = document.getElementById('systemsContainer');
    container.innerHTML = '';

    for (let i = 1; i <= state.systemCount; i++) {
        const sys = state.systems[i];
        if (!sys) continue;

        const sev = systemSeverity(sys);
        const tempSev  = severity('temperature', sys.sensors.temperature);
        const humSev   = severity('humidity',    sys.sensors.humidity, sys.targets.humidity);
        const lightSev = severity('light',       sys.sensors.light,    sys.targets.light);

        const ventMode  = sys.modes.vent;
        const lightMode = sys.modes.light;
        const ventVal   = ventMode  === 'auto' ? sys.targets.humidity : sys.manuals.vent;
        const lightVal  = lightMode === 'auto' ? sys.targets.light    : sys.manuals.light;

        const connClass = sys.online === true ? 'online' : sys.online === false ? 'offline' : 'unknown';
        const connText  = sys.online === true ? 'Online' : sys.online === false ? 'Offline' : 'No readings';
        const lastReadingText = sys.lastReadingAt != null
            ? `Last reading ${fmtRelative(sys.lastReadingAt)}`
            : 'No readings yet';
        const night = isNightForSystem(sys);
        const dayNightClass = night ? 'night' : 'day';
        const dayNightText  = night
            ? `Night mode · lights off until ${sys.dayTime}`
            : `Day mode · active until ${sys.nightTime}`;

        container.insertAdjacentHTML('beforeend', `
            <div class="system-block ${sev === 'ok' ? '' : sev}" id="system-${i}">

                <div class="sys-header">
                    <div class="sys-title-group">
                        <p class="sys-title">${escapeHtml(sys.name)}${sys.isDummy ? ' <span class="sys-dummy-tag">demo data</span>' : ''}</p>
                        <p class="sys-meta">
                            <span class="sys-conn ${connClass}"><span class="sys-conn-dot"></span>${connText}</span>
                            <span class="sys-last">${lastReadingText}</span>
                            <span class="sys-daynight ${dayNightClass}">${night ? '🌙' : '🌞'} ${dayNightText}</span>
                        </p>
                    </div>
                    <span class="sys-pill ${sev === 'ok' ? '' : sev}">
                        ${sev === 'ok' ? 'Healthy' : sev === 'warn' ? 'Needs attention' : 'Critical'}
                    </span>
                </div>

                <div class="sys-summary">
                    <div class="sys-summary-block">
                        <p class="sys-summary-label">Alerts</p>
                        ${renderAlertsHTML(sys)}
                    </div>
                    <div class="sys-summary-block">
                        <p class="sys-summary-label">Plant health</p>
                        ${renderHealthHTML(sys)}
                        <a href="camera.html" class="health-link">View camera →</a>
                    </div>
                </div>

                <div class="metric-row">
                    <div class="metric-info">
                        <span class="metric-label">Temperature</span>
                        <span class="metric-value ${tempSev === 'ok' ? '' : tempSev === 'unknown' ? '' : tempSev}">${fmtNum(sys.sensors.temperature)}${sys.sensors.temperature == null ? '' : '°C'}</span>
                        <span class="metric-target">Comfort range ${BANDS.temperature.idealMin}–${BANDS.temperature.idealMax}°C</span>
                    </div>
                    <div class="metric-control"></div>
                </div>

                <div class="metric-row">
                    <div class="metric-info">
                        <span class="metric-label">Humidity</span>
                        <span class="metric-value ${humSev === 'ok' ? '' : humSev === 'unknown' ? '' : humSev}">${fmtNum(sys.sensors.humidity)}${sys.sensors.humidity == null ? '' : '%'}</span>
                        <span class="metric-target">${ventMode === 'auto' ? `Target ${sys.targets.humidity}%` : `Vent open ${sys.manuals.vent}%`}</span>
                    </div>
                    <div class="metric-control">
                        <div class="mode-pills" role="group" aria-label="Ventilation mode">
                            <button class="mode-pill ${ventMode === 'auto'   ? 'active' : ''}" onclick="setMode(${i}, 'vent', 'auto')">Auto</button>
                            <button class="mode-pill ${ventMode === 'manual' ? 'active' : ''}" onclick="setMode(${i}, 'vent', 'manual')">Manual</button>
                        </div>
                        <div class="metric-slider">
                            <input type="range" min="0" max="100" value="${ventVal}"
                                id="vent-slider-${i}" data-saved="${ventVal}"
                                aria-label="${ventMode === 'auto' ? 'Target humidity' : 'Vent opening'}"
                                oninput="onSlider(${i}, 'vent')">
                            <span class="metric-slider-readout" id="vent-readout-${i}">${ventVal}${ventMode === 'auto' ? '% target' : '% open'}</span>
                        </div>
                        <button class="btn-save-compact" id="vent-save-${i}" onclick="saveControl(${i}, 'vent')" disabled>Save</button>
                    </div>
                </div>

                <div class="metric-row">
                    <div class="metric-info">
                        <span class="metric-label">Light</span>
                        <span class="metric-value ${lightSev === 'ok' ? '' : lightSev === 'unknown' ? '' : lightSev}">${fmtNum(sys.sensors.light)}${sys.sensors.light == null ? '' : ' PPFD'}</span>
                        <span class="metric-target">${lightMode === 'auto' ? `Target ${sys.targets.light} PPFD` : `LED at ${sys.manuals.light}%`}</span>
                    </div>
                    <div class="metric-control">
                        <div class="mode-pills" role="group" aria-label="Lighting mode">
                            <button class="mode-pill ${lightMode === 'auto'   ? 'active' : ''}" onclick="setMode(${i}, 'light', 'auto')">Auto</button>
                            <button class="mode-pill ${lightMode === 'manual' ? 'active' : ''}" onclick="setMode(${i}, 'light', 'manual')">Manual</button>
                        </div>
                        <div class="metric-slider">
                            <input type="range" min="0" max="${lightMode === 'auto' ? 1000 : 100}" step="${lightMode === 'auto' ? 10 : 1}" value="${lightVal}"
                                id="light-slider-${i}" data-saved="${lightVal}"
                                aria-label="${lightMode === 'auto' ? 'Target light' : 'LED brightness'}"
                                oninput="onSlider(${i}, 'light')">
                            <span class="metric-slider-readout" id="light-readout-${i}">${lightVal}${lightMode === 'auto' ? ' PPFD' : '% LED'}</span>
                        </div>
                        <button class="btn-save-compact" id="light-save-${i}" onclick="saveControl(${i}, 'light')" disabled>Save</button>
                    </div>
                </div>

                <div class="metric-row">
                    <div class="metric-info">
                        <span class="metric-label">Last watering</span>
                        <span class="metric-value">${fmtRelative(sys.lastWateringAt)}</span>
                        <span class="metric-target">${sys.lastWateringAt != null ? fmtTime(sys.lastWateringAt) : 'No schedule'}</span>
                    </div>
                    <div class="water-info">
                        <span><strong>Next scheduled:</strong> ${sys.nextWateringAt != null ? `${fmtTime(sys.nextWateringAt)} (${fmtRelative(sys.nextWateringAt)})` : 'No schedule'}</span>
                        <a href="config.html" class="health-link">Edit schedule →</a>
                    </div>
                </div>

            </div>
        `);
    }
}

function fmtNum(v) {
    if (v == null || Number.isNaN(v)) return '--';
    return Number.isInteger(v) ? v : Number(v).toFixed(1);
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function renderAll() {
    deriveAlerts();
    renderSystems();
}

// Interactions

function onSlider(systemId, type) {
    const slider  = document.getElementById(`${type}-slider-${systemId}`);
    const readout = document.getElementById(`${type}-readout-${systemId}`);
    const saveBtn = document.getElementById(`${type}-save-${systemId}`);
    const sys = state.systems[systemId];
    const mode = sys.modes[type];

    const suffix = type === 'vent'
        ? (mode === 'auto' ? '% target' : '% open')
        : (mode === 'auto' ? ' PPFD'    : '% LED');
    readout.textContent = slider.value + suffix;
    saveBtn.disabled = (slider.value === slider.dataset.saved);
}

async function saveControl(systemId, type) {
    const slider = document.getElementById(`${type}-slider-${systemId}`);
    const sys = state.systems[systemId];
    const mode = sys.modes[type];
    const value = parseFloat(slider.value);

    const setting =
        type === 'vent'  && mode === 'auto'   ? 'targetHumidity' :
        type === 'vent'  && mode === 'manual' ? 'ventManual'     :
        type === 'light' && mode === 'auto'   ? 'targetLight'    :
                                                'lightManual';
    try {
        await api('PUT', `/arduinoConfig/${setting}/${systemId}`, { value: String(value) });
        if (type === 'vent') {
            if (mode === 'auto') sys.targets.humidity = value;
            else                 sys.manuals.vent     = value;
        } else {
            if (mode === 'auto') sys.targets.light = value;
            else                 sys.manuals.light = value;
        }
        showMessage('Saved — your greenhouse will update shortly');
        renderAll();
    } catch (e) {
        showMessage(`Save failed: ${e.message}`, 'error');
    }
}

async function setMode(systemId, type, mode) {
    const sys = state.systems[systemId];
    if (sys.modes[type] === mode) return;
    const setting = type === 'vent' ? 'ventMode' : 'lightMode';
    try {
        await api('PUT', `/arduinoConfig/${setting}/${systemId}`, { value: mode });
        sys.modes[type] = mode;
        showMessage(`${type === 'vent' ? 'Ventilation' : 'Lighting'} switched to ${mode}`);
        renderAll();
    } catch (e) {
        showMessage(`Mode change failed: ${e.message}`, 'error');
    }
}

// Demo placeholders. Only systems 2 and 3, system 1 always uses real data.
const DUMMY_SYSTEMS = {
    2: {
        name: 'System 2',
        sensors:  { temperature: 22.4, humidity: 55, light: 420 },
        targets:  { humidity: 60, light: 500 },
        plant:    { score: 28, status: 'Low Stress', confidence: 86 }
    },
    3: {
        name: 'System 3',
        sensors:  { temperature: 19.8, humidity: 38, light: 280 },
        targets:  { humidity: 55, light: 600 },
        plant:    { score: 62, status: 'High Stress', confidence: 79 }
    }
};

// Inject dummy sensor + plant-scan values for systems 2 and 3 when no real
// readings exist, so the multi-system layout has something to show.
function fillDummySystemData() {
    const now = serverNow();
    for (const sidStr of Object.keys(DUMMY_SYSTEMS)) {
        const sid = parseInt(sidStr);
        if (sid > state.systemCount) continue;
        const sys = ensureSystem(sid);
        if (sys.lastReadingAt != null) continue;

        const d = DUMMY_SYSTEMS[sid];
        if (!sys.name || sys.name === `System ${sid}`) sys.name = d.name;
        sys.sensors = { ...d.sensors };
        sys.sensorTimes = { temperature: now, humidity: now, light: now };
        sys.lastReadingAt = now;
        sys.online = true;
        sys.targets = { ...sys.targets, ...d.targets };
        sys.isDummy = true;

        if (!sys.plantStress) {
            sys.plantStress = {
                score: d.plant.score,
                status: d.plant.status,
                confidence: d.plant.confidence,
                scannedAt: now
            };
        }
    }
}

// True while the user has an unsaved slider edit on any system.
// Skips rebuilding the system blocks during poll ticks so a mid-drag slider isn't reset.
function hasUnsavedEdits() {
    return !!document.querySelector('.btn-save-compact:not(:disabled)');
}

async function init() {
    try {
        await loadServerClockSkew();
        await Promise.all([loadArduinoConfig(), loadSensorReadings(), loadWaterSchedule()]);
        fillDummySystemData();
        renderAll();
    } catch (e) {
        showMessage(`Could not load data: ${e.message}`, 'error');
        console.error(e);
    }
    runPlantScan();
}

async function poll() {
    try {
        await Promise.all([loadServerClockSkew(), loadSensorReadings(), loadWaterSchedule(), loadArduinoConfig()]);
        fillDummySystemData();
        deriveAlerts();
        if (!hasUnsavedEdits()) renderSystems();
    } catch (e) {
        console.error('Poll failed:', e);
    }
}

loadCachedPlantScan();
init();
setInterval(poll, POLL_INTERVAL_MS);
tickSystemClock();
setInterval(tickSystemClock, 1000);
// Refresh relative timestamps in between polls so they stay accurate.
setInterval(() => {
    if (!hasUnsavedEdits()) renderSystems();
}, 30_000);
