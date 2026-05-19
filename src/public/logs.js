let allLogs = [];
let catFilter = 'all';
let trigFilter = 'all';

function loadLogs() {
  document.getElementById('logList').innerHTML = '<p class="loading-row">Loading activity...</p>';

  fetch('/actionLogs')
    .then(res => {
      if (!res.ok) throw new Error('not ready');
      return res.json();
    })
    .then(data => {
      allLogs = data;
      applyFilters();
    })
    .catch(() => {
      allLogs = makeMockEvents();
      applyFilters();
    });
}

// mock events
function makeMockEvents() {
  return [
    // watering
    { time: nowMinus(2),    cat: 'watering',   trig: 'auto',   title: 'Scheduled watering ran',   detail: 'System 1 watered for 30 seconds (09:00 schedule)' },
    { time: nowMinus(310),  cat: 'watering',   trig: 'manual', title: 'Manual watering triggered',detail: 'System 1 watered for 60 seconds' },
    { time: nowMinus(1080), cat: 'watering',   trig: 'manual', title: 'Schedule entry removed',   detail: 'Removed event: 18:00 — System 2' },
    { time: nowMinus(120),  cat: 'watering',   trig: 'manual', title: 'Schedule entry added',     detail: 'New event: 09:00 — System 2 — 45 seconds' },
    // lighting
    { time: nowMinus(85),   cat: 'lighting',   trig: 'auto',   title: 'Lights brightened',        detail: 'System 1 LED raised to 75% (low light reading)' },
    { time: nowMinus(420),  cat: 'lighting',   trig: 'auto',   title: 'Lights dimmed',            detail: 'System 1 LED lowered to 40% (target reached)' },
    { time: nowMinus(95),   cat: 'lighting',   trig: 'manual', title: 'Lighting mode changed',    detail: 'System 1 switched from auto to manual (60%)' },
    { time: nowMinus(1260), cat: 'lighting',   trig: 'manual', title: 'Target light changed',     detail: 'System 2 target light set to 80%' },

    // ventilation
    { time: nowMinus(70),   cat: 'ventilation',trig: 'auto',   title: 'Vent opened',              detail: 'System 1 humidity 78% > target 70%, vent opened to 35%' },
    { time: nowMinus(220),  cat: 'ventilation',trig: 'auto',   title: 'Vent closed',              detail: 'System 1 humidity dropped to 65%, vent fully closed' },
    { time: nowMinus(380),  cat: 'ventilation',trig: 'manual', title: 'Vent mode changed',       detail: 'System 1 vent set to manual (50%)' },
    { time: nowMinus(15),   cat: 'ventilation',trig: 'manual', title: 'Target humidity changed', detail: 'System 1 target humidity set to 70%' },

    // day/night
    { time: nowMinus(45),   cat: 'dayNight',   trig: 'auto',   title: 'Night mode started',       detail: 'Reached night time (20:00) — lights and sensors disabled' },
    { time: nowMinus(180),  cat: 'dayNight',   trig: 'auto',   title: 'Day mode started',         detail: 'Reached day time (08:00) — lights and sensors enabled' },
    { time: nowMinus(900),  cat: 'dayNight',   trig: 'manual', title: 'Day time changed',         detail: 'Day start time updated to 07:30' },
    { time: nowMinus(960),  cat: 'dayNight',   trig: 'manual', title: 'Night time changed',       detail: 'Night start time updated to 21:00' },

    // settings.. renaming, system count
    { time: nowMinus(540),  cat: 'settings',   trig: 'manual', title: 'System renamed',           detail: 'System 1 renamed to "Tomatoes"' },
    { time: nowMinus(240),  cat: 'settings',   trig: 'manual', title: 'System count changed',    detail: 'Total active systems updated to 2' },
  ];
}

function nowMinus(mins) {
  const d = new Date(Date.now() - mins * 60000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function filterCat(cat, btn) {
  catFilter = cat;
  document.querySelectorAll('.cat-filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  applyFilters();
}

function filterTrig(trig, btn) {
  trigFilter = trig;
  document.querySelectorAll('.trig-filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  applyFilters();
}

function applyFilters() {
  const search = document.getElementById('searchBox').value.toLowerCase();

  let filtered = allLogs;

  if (catFilter !== 'all') {
    filtered = filtered.filter(e => e.cat === catFilter);
  }

  if (trigFilter !== 'all') {
    filtered = filtered.filter(e => e.trig === trigFilter);
  }

  if (search) {
    filtered = filtered.filter(e => {
      return e.title.toLowerCase().includes(search)
        || e.detail.toLowerCase().includes(search)
        || e.time.toLowerCase().includes(search);
    });
  }

  filtered.sort((a, b) => b.time.localeCompare(a.time));
  drawList(filtered);
}

function drawList(events) {
  const list = document.getElementById('logList');
  const count = document.getElementById('resultCount');

  if (events.length === 0) {
    list.innerHTML = '<p class="empty-row">No events match your filters</p>';
    count.textContent = '0 events';
    return;
  }

  let html = '';
  events.forEach(e => {
    html += '<div class="log-entry">';
    html += '<div class="log-bar bar-' + e.cat + '"></div>';
    html += '<div class="log-body">';
    html += '<p class="log-title">' + e.title + '</p>';
    html += '<p class="log-detail">' + e.detail + '</p>';
    html += '<div class="log-meta">';
    html += '<span class="log-cat cat-' + e.cat + '">' + catLabel(e.cat) + '</span>';
    html += '<span class="log-trig trig-' + e.trig + '">' + (e.trig === 'auto' ? 'Automatic' : 'Manual') + '</span>';
    html += '<span>' + timeAgo(e.time) + '</span>';
    html += '</div>';
    html += '</div>';
    html += '<span class="log-time">' + e.time + '</span>';
    html += '</div>';
  });

  list.innerHTML = html;
  count.textContent = events.length + ' events';
}

function catLabel(cat) {
  if (cat === 'dayNight') return 'Day/Night';
  return cat.charAt(0).toUpperCase() + cat.slice(1);
}

function timeAgo(timeStr) {
  const then = new Date(timeStr.replace(' ', 'T'));
  const diff = Math.floor((Date.now() - then) / 1000);

  if (diff < 60)    return 'just now';
  if (diff < 3600)  return Math.floor(diff / 60) + ' min ago';
  if (diff < 86400) return Math.floor(diff / 3600) + ' hours ago';
  return Math.floor(diff / 86400) + ' days ago';
}

loadLogs();
