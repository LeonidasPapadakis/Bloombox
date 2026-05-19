let score   = 27;
let conf    = 89;
let yellow  = 12;
let green   = 81;
let droop   = 8;
let firstPhoto = true;

const cameraState = {
  systemCount: 1,
  systemNames: {},
  currentSystem: 1
};

// Hardcoded mock data for systems that have no real camera attached
const DUMMY_SYSTEMS = {
  2: {
    score: 45, conf: 82, yellow: 22, green: 65, droop: 15,
    lastScan: '13:48:12',
    photos: [
      { time: 'Today 13:48',     status: 'Mild Stress', tag: 'yellow-tag' },
      { time: 'Today 11:30',     status: 'Mild Stress', tag: 'yellow-tag' },
      { time: 'Today 09:15',     status: 'Low Stress',  tag: 'green-tag'  },
      { time: 'Yesterday 17:20', status: 'Mild Stress', tag: 'yellow-tag' },
      { time: 'Yesterday 14:05', status: 'High Stress', tag: 'red-tag'    },
      { time: 'Yesterday 10:00', status: 'Mild Stress', tag: 'yellow-tag' }
    ],
    comparison: {
      old: { stress: 58, green: 55, yellow: 31, cls: 'red-text'   },
      now: { stress: 45, green: 65, yellow: 22, cls: 'green-text' },
      message: 'Plant health has <strong>improved</strong> over the past 7 days. Stress reduced by 13 points.'
    }
  },
  3: {
    score: 33, conf: 87, yellow: 16, green: 75, droop: 11,
    lastScan: '14:05:33',
    photos: [
      { time: 'Today 14:05',     status: 'Low Stress',  tag: 'green-tag'  },
      { time: 'Today 11:00',     status: 'Low Stress',  tag: 'green-tag'  },
      { time: 'Today 08:30',     status: 'Low Stress',  tag: 'green-tag'  },
      { time: 'Yesterday 18:00', status: 'Low Stress',  tag: 'green-tag'  },
      { time: 'Yesterday 13:00', status: 'Mild Stress', tag: 'yellow-tag' },
      { time: 'Yesterday 09:00', status: 'Low Stress',  tag: 'green-tag'  }
    ],
    comparison: {
      old: { stress: 38, green: 72, yellow: 19, cls: 'red-text'   },
      now: { stress: 33, green: 75, yellow: 16, cls: 'green-text' },
      message: 'Plant health is <strong>stable</strong>. Stress reduced by 5 points.'
    }
  }
};

function showScore() {
  document.getElementById('scoreNum').textContent  = score;
  document.getElementById('scoreConf').textContent = 'Confidence: ' + conf + '%';

  const circle = document.getElementById('scoreCircle');
  const status = document.getElementById('scoreStatus');

  if (score >= 60) {
    circle.className  = 'score-circle high';
    status.textContent = 'High Stress';
  } else if (score >= 35) {
    circle.className  = 'score-circle medium';
    status.textContent = 'Mild Stress';
  } else {
    circle.className  = 'score-circle';
    status.textContent = 'Low Stress';
  }

  // update the bars
  document.getElementById('yellowBar').style.width = yellow + '%';
  document.getElementById('yellowNum').textContent  = yellow + '%';

  document.getElementById('greenBar').style.width  = green + '%';
  document.getElementById('greenNum').textContent   = green + '%';

  document.getElementById('droopBar').style.width  = droop + '%';
  document.getElementById('droopNum').textContent   = droop + '%';
}

// Render the photo grid for a dummy system
function renderDummyPhotos(photos) {
  const grid = document.getElementById('photoGrid');
  grid.innerHTML = photos.map(p => `
    <div class="photo">
      <div class="photo-img">
        <img src="assets/camera.png" class="photo-icon" alt="snapshot">
      </div>
      <div class="photo-info">
        <p class="photo-time">${p.time}</p>
        <span class="photo-tag ${p.tag}">${p.status}</span>
      </div>
    </div>
  `).join('');
  firstPhoto = false;
}

// Apply dummy data for systems 2 and 3
function applyDummySystem(systemId) {
  const data = DUMMY_SYSTEMS[systemId];
  if (!data) return;

  score  = data.score;
  conf   = data.conf;
  yellow = data.yellow;
  green  = data.green;
  droop  = data.droop;
  showScore();
  document.getElementById('scoreTime').textContent = 'Last scan: ' + data.lastScan;

  renderDummyPhotos(data.photos);

  const c = data.comparison;
  document.getElementById('old-stress').innerText = c.old.stress + '/100';
  document.getElementById('new-stress').innerText = c.now.stress + '/100';
  document.getElementById('old-green').innerText  = c.old.green + '%';
  document.getElementById('new-green').innerText  = c.now.green + '%';
  document.getElementById('old-yellow').innerText = c.old.yellow + '%';
  document.getElementById('new-yellow').innerText = c.now.yellow + '%';
  document.getElementById('verdictText').innerHTML = c.message;
}

// Switch the camera page to a given system
async function selectSystem(systemId) {
  cameraState.currentSystem = systemId;
  const camTag = document.getElementById('camTag');
  if (camTag) camTag.textContent = `CAM-A${systemId}`;

  if (systemId === 1) {
    // Real data path — reset to defaults and fetch comparison from the Pi
    score = 27; conf = 89; yellow = 12; green = 81; droop = 8;
    showScore();
    document.getElementById('scoreTime').textContent = 'Last scan: --:--:--';
    document.getElementById('photoGrid').innerHTML =
      '<p style="color:#999; font-size:13px; padding:20px 0;">Capture a snapshot to start.</p>';
    firstPhoto = true;
    await loadComparison();
  } else {
    applyDummySystem(systemId);
  }
}

// Populate the system dropdown from arduinoConfig
async function initSystemSelector() {
  const select = document.getElementById('systemSelect');
  if (!select) return;

  try {
    const res = await fetch('/arduinoConfig');
    if (res.ok) {
      const rows = await res.json();
      for (const { setting, systemId, value } of rows) {
        if (setting === 'systemCount') cameraState.systemCount = parseInt(value) || 1;
        else if (setting === 'systemName') cameraState.systemNames[parseInt(systemId)] = value;
      }
    }
  } catch (err) {
    console.warn('Could not load system list, defaulting to 1:', err);
  }

  for (let i = 1; i <= cameraState.systemCount; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = cameraState.systemNames[i] || `System ${i}`;
    select.appendChild(opt);
  }

  select.addEventListener('change', () => selectSystem(parseInt(select.value)));
}

// clock in the feed overlay
function updateClock() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const t = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
  document.getElementById('clock').textContent = t;
}

setInterval(updateClock, 1000);
updateClock();

function takeSnapshot() {
  // here i should tell the Pi to save a photo..
  alert('Snapshot captured! (Connect Pi to save real images)');
}

function clearPhotos() {
  const grid = document.getElementById('photoGrid');
  if (grid) grid.innerHTML = '<p style="color:#999; font-size:13px; padding:20px 0;">No snapshots yet.</p>';
}

function addPhotoToGrid(data){
  const grid = document.getElementById("photoGrid");

  if(firstPhoto){
    grid.innerHTML = "";
    firstPhoto = false;
  }

  let tagClass = "green-tag";
  if (data.status === "Mild Stress") tagClass = "yellow-tag";
  if (data.status === "Severe Stress") tagClass = "red-tag";

  const date = new Date(data.date_time);
  const timeString = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  const photoHTML = `
    <div class="photo">
      <div class="photo-img">
        <img src="${data.photo_url}" alt="snapshot">
      </div>
      <div class="photo-info">
        <p class="photo-time">${timeString}</p>
        <span class="photo-tag" ${tagClass}">${data.status}</span>
      </div>
    </div>
  `;

  grid.insertAdjacentHTML("afterbegin", photoHTML)
}

function clearPhotos(){
  document.getElementById("photoGrid").innerHTML = "";
}

async function analysePlant(){
    if (cameraState.currentSystem !== 1) {
      // Dummy systems
      const data = DUMMY_SYSTEMS[cameraState.currentSystem];
      if (!data) return;
      addPhotoToGrid({
        date_time: new Date().toISOString(),
        photo_url: 'assets/camera.png',
        status: data.score >= 60 ? 'Severe Stress' : data.score >= 35 ? 'Mild Stress' : 'Low Stress'
      });
      return;
    }

    const res = await fetch("/camera/predict");
    const data = await res.json();

    document.getElementById("scoreNum").innerText = Math.round(data.stress);
    document.getElementById("scoreStatus").innerText = data.status;
    document.getElementsByClassName("score-time")[0].innerText = data.date_time;

    document.getElementById("greenNum").innerText = data.green_vibrancy + "%";
    document.getElementById("yellowNum").innerText = data.yellow_pixel + "%";
    document.getElementById("greenBar").style.width = data.green_vibrancy + "%";
    document.getElementById("yellowBar").style.width = data.yellow_pixel + "%";
    document.getElementById("droopNum").innerText = data.plant_height + "%";
    document.getElementById("droopBar").style.width = data.plant_height + "%";

    addPhotoToGrid(data);
    await loadComparison();
  }

async function loadComparison(){
  const res = await fetch("/camera/comparison");
  const data = await res.json();

  if (data.error){
    document.getElementById("verdictText").textContent = data.error;
    return;
  }

  document.getElementById("old-photo").src = data.seven_days_ago.photo_url;
  document.getElementById("today-photo").src = data.today.photo_url;

  document.getElementById("old-stress").innerText = Math.round(data.seven_days_ago.stress) + "/100";
  document.getElementById("new-stress").innerText = Math.round(data.today.stress) + "/100";

  document.getElementById("old-green").innerText = data.seven_days_ago.green_vibrancy + "%";
  document.getElementById("new-green").innerText = data.today.green_vibrancy + "%";

  document.getElementById("old-yellow").innerText = data.seven_days_ago.yellow_pixel + "%";
  document.getElementById("new-yellow").innerText = data.today.yellow_pixel + "%";

  document.getElementById("verdictText").innerHTML = data.message;
}

(async () => {
  await initSystemSelector();
  showScore();
  await loadComparison();
})();
