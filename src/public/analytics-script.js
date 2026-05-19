// Shared chart defaults
const defaultLineOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: {
      position: 'bottom',
      labels: {
        font: { family: 'Inter', size: 12 },
        color: '#555',
        boxWidth: 12,
        padding: 14
      }
    }
  },
  scales: {
    x: {
      grid: { color: '#f0f0f0' },
      ticks: { font: { family: 'Inter', size: 11 }, color: '#888', maxTicksLimit: 10 }
    },
    y: {
      grid: { color: '#f0f0f0' },
      ticks: { font: { family: 'Inter', size: 11 }, color: '#888' }
    }
  },
  elements: {
    point: { radius: 3, hoverRadius: 5 }
  }
};

// Build hourly grid spanning the last 24 hours
function make24hGrid() {
  const slots = [];
  const now = new Date();
  for (let i = 24; i >= 0; i--) {
    const t = new Date(now.getTime() - i * 60 * 60 * 1000);
    slots.push({
      label: t.toTimeString().slice(0, 5),
      hour: t.getHours(),
      start: t.getTime(),
      end: t.getTime() + 60 * 60 * 1000
    });
  }
  return slots;
}

// Average real sensor readings into hourly grid slots (null for empty slots)
function bucketByHour(rows, grid) {
  return grid.map(slot => {
    const bucket = rows.filter(r => {
      const rt = new Date(r.timeStamp).getTime();
      return rt >= slot.start && rt < slot.end;
    });
    if (bucket.length === 0) return null;
    const avg = bucket.reduce((s, r) => s + r.sensorValue, 0) / bucket.length;
    return Math.round(avg * 10) / 10;
  });
}

// Generate sine-based mock data for systems that have no real hardware
function generateMockData(type, systemId) {
  const grid = make24hGrid();
  const values = grid.map(({ hour }) => {
    const dayPhase = Math.sin((hour - 6) * Math.PI / 12); // -1 at midnight, +1 at noon
    const noise = Math.sin(hour * 7.3 + systemId * 2.1) * 0.3;

    if (type === 'temperature') {
      const bases = { 2: 23, 3: 21 };
      const amps  = { 2: 2.5, 3: 2 };
      return +((bases[systemId] ?? 22) + (amps[systemId] ?? 2) * 0.5 * dayPhase + noise).toFixed(1);
    }
    if (type === 'humidity') {
      const bases = { 2: 62, 3: 70 };
      const amps  = { 2: 12, 3: 10 };
      return Math.round((bases[systemId] ?? 65) - (amps[systemId] ?? 10) * 0.4 * dayPhase + noise * 4);
    }
    if (type === 'light') {
      const peaks = { 2: 420, 3: 360 };
      const dayFactor = Math.max(0, dayPhase);
      return Math.round((peaks[systemId] ?? 380) * dayFactor + Math.abs(noise) * 40);
    }
    return 0;
  });
  return { labels: grid.map(s => s.label), values };
}

// Fetch sensor data aligned to the 24h hourly grid.
async function fetchSensorData(type, hours = 24, systemId = 'all') {
  const sid = parseInt(systemId);
  if (!isNaN(sid) && sid >= 2) {
    return generateMockData(type, sid);
  }

  const grid = make24hGrid();
  const emptyResult = { labels: grid.map(s => s.label), values: grid.map(() => null) };

  try {
    const params = new URLSearchParams({ type, hours: String(hours) });
    if (systemId !== 'all') params.set('systemId', systemId);
    const res = await fetch(`/api/sensor-data?${params.toString()}`);

    if (res.status === 503) {
      console.warn(`sensorData table not ready for ${type}.`);
      return emptyResult;
    }
    if (!res.ok) {
      console.warn(`API error ${res.status} for ${type}.`);
      return emptyResult;
    }

    const json = await res.json();
    if (!json.rows || json.rows.length === 0) return emptyResult;

    return { labels: grid.map(s => s.label), values: bucketByHour(json.rows, grid) };

  } catch (err) {
    console.error('Failed to fetch sensor data:', err);
    return emptyResult;
  }
}

const charts = {};

const analyticsState = {
  systemCount: 1,
  systemNames: {}
};

const SYSTEM_COLORS = ['rgb(34, 197, 94)', 'rgb(59, 130, 246)', 'rgb(249, 115, 22)'];

function toBg(color) {
  if (color.startsWith('rgb(')) {
    return color.replace(')', ', 0.12)').replace('rgb', 'rgba');
  }
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, 0.12)`;
  }
  return color;
}

// Render or replace a line chart
function buildLineChart(canvasId, datasets, labels, yOptions = {}) {
  if (charts[canvasId]) charts[canvasId].destroy();
  const ctx = document.getElementById(canvasId).getContext('2d');
  const fill = datasets.length === 1;
  charts[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: datasets.map(d => ({
        label: d.label,
        data: d.values,
        borderColor: d.color,
        backgroundColor: toBg(d.color),
        borderWidth: 2,
        fill,
        tension: 0.4,
        spanGaps: true
      }))
    },
    options: {
      ...defaultLineOptions,
      scales: {
        ...defaultLineOptions.scales,
        y: { ...defaultLineOptions.scales.y, ...yOptions }
      }
    }
  });
  return charts[canvasId];
}

async function datasetsForMetric(type, hours, systemId, singleColor) {
  if (systemId !== 'all') {
    const d = await fetchSensorData(type, hours, systemId);
    const label = analyticsState.systemNames[parseInt(systemId)] || `System ${systemId}`;
    return { datasets: [{ label, color: singleColor, values: d.values }], labels: d.labels };
  }

  const series = await Promise.all(
    Array.from({ length: analyticsState.systemCount }, (_, i) =>
      fetchSensorData(type, hours, String(i + 1)).then(d => ({
        systemId: i + 1,
        labels: d.labels,
        values: d.values
      }))
    )
  );

  // All series share the same 24h grid so labels are identical
  const labels = series[0].labels;
  const datasets = series.map(s => ({
    label: analyticsState.systemNames[s.systemId] || `System ${s.systemId}`,
    color: SYSTEM_COLORS[(s.systemId - 1) % SYSTEM_COLORS.length],
    values: s.values
  }));
  return { datasets, labels };
}

async function initCharts(systemId = 'all') {
  const temp  = await datasetsForMetric('temperature', 24, systemId, '#ef4444');
  buildLineChart('tempChart',  temp.datasets,  temp.labels,  { suggestedMin: 15, suggestedMax: 35 });

  const hum   = await datasetsForMetric('humidity',    24, systemId, '#3b82f6');
  buildLineChart('humChart',   hum.datasets,   hum.labels,   { suggestedMin: 30, suggestedMax: 100 });

  const light = await datasetsForMetric('light',       24, systemId, '#f59e0b');
  buildLineChart('lightChart', light.datasets, light.labels, { suggestedMin: 0 });
}

async function initSystemSelector() {
  const select = document.getElementById('systemSelect');
  if (!select) return;

  let systemCount = 1;
  const names = {};
  try {
    const res = await fetch('/arduinoConfig');
    if (res.ok) {
      const rows = await res.json();
      for (const { setting, systemId, value } of rows) {
        if (setting === 'systemCount') systemCount = parseInt(value) || 1;
        else if (setting === 'systemName') names[parseInt(systemId)] = value;
      }
    }
  } catch (err) {
    console.warn('Could not load system list, defaulting to 1:', err);
  }

  analyticsState.systemCount = systemCount;
  analyticsState.systemNames = names;

  for (let i = 1; i <= systemCount; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = names[i] || `System ${i}`;
    select.appendChild(opt);
  }

  select.addEventListener('change', () => initCharts(select.value));
}

(async () => {
  await initSystemSelector();
  await initCharts('all');
})();
