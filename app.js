'use strict';

// ---------- Konstanter ----------

const PROPERTY_TYPES = {
  hus: { label: 'Hus', icon: '🏠' },
  lejlighed: { label: 'Lejlighed', icon: '🏢' },
  sommerhus: { label: 'Sommerhus', icon: '🏖️' },
  andet: { label: 'Andet', icon: '🏘️' },
};
const ROOM_TYPES = {
  stue: { label: 'Stue', icon: '🛋️' },
  vaerelse: { label: 'Værelse', icon: '🛏️' },
  koekken: { label: 'Køkken', icon: '🍳' },
  badevaerelse: { label: 'Badeværelse', icon: '🛁' },
  gang: { label: 'Gang', icon: '🚪' },
  udenfor: { label: 'Udenfor / have', icon: '🌳' },
  andet: { label: 'Andet', icon: '📦' },
};
const STATUS = {
  mangler: { label: 'Mangler' },
  igang: { label: 'I gang' },
  faerdig: { label: 'Færdig' },
};
const PRIORITY = {
  hoej: { label: 'Høj' },
  normal: { label: 'Normal' },
  lav: { label: 'Lav' },
};
const NO_ROOM = { label: 'Intet bestemt rum', icon: '📍' };

const state = {
  user: null,
  properties: [],
  tasks: [],
  users: [],
  selectedProperty: load('selectedProperty', 'all'),
  filterRoom: 'all',
  filterStatus: load('filterStatus', 'open'),
  search: '',
};

// ---------- Hjælpefunktioner ----------

function load(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignorer */ }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

const $ = (sel, root = document) => root.querySelector(sel);

// '/api/tasks/5' -> 'api.php?r=tasks/5'. PUT/DELETE sendes som POST, da nogle webhoteller blokerer dem.
async function api(path, { method = 'GET', body } = {}) {
  const url = 'api.php?r=' + path.replace(/^\/api\//, '');
  const opts = { method: method === 'GET' ? 'GET' : 'POST', headers: {} };
  if (method !== 'GET' && method !== 'POST') opts.headers['X-HTTP-Method-Override'] = method;
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch { /* tomt svar */ }
  if (res.status === 401 && state.user) {
    state.user = null;
    closeModal();
    renderLogin();
    throw new Error('Du er blevet logget ud');
  }
  if (!res.ok) throw new Error(data?.error || 'Noget gik galt');
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3200);
}

function formatDate(sqlDate) {
  const d = new Date(sqlDate.replace(' ', 'T') + 'Z');
  return d.toLocaleDateString('da-DK', { day: 'numeric', month: 'short', year: 'numeric' });
}

function options(map, selected) {
  return Object.entries(map).map(([value, { label, icon }]) =>
    `<option value="${value}" ${value === selected ? 'selected' : ''}>${icon ? icon + ' ' : ''}${esc(label)}</option>`).join('');
}

function roomInfo(task) {
  return task.room_id ? { icon: ROOM_TYPES[task.room_type]?.icon || '📦', label: task.room_name } : NO_ROOM;
}

function propertyById(pid) {
  return state.properties.find((p) => p.id === Number(pid));
}

// Gør billeder fra mobilen mindre før upload, så det går hurtigere
async function shrinkImage(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, 1920 / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5e6) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

async function imagesFormData(files, extra = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  for (const f of files) fd.append('images', await shrinkImage(f));
  return fd;
}

// ---------- Data ----------

async function refresh() {
  const [properties, tasks] = await Promise.all([api('/api/properties'), api('/api/tasks')]);
  state.properties = properties;
  state.tasks = tasks;
  if (state.selectedProperty !== 'all' && !propertyById(state.selectedProperty)) state.selectedProperty = 'all';
}

// ---------- Login ----------

async function init() {
  try {
    const status = await api('/api/status');
    if (status.installNeeded) return renderInstall(status.sqliteAvailable);
    if (status.setupNeeded) return renderLogin(true);
    if (!status.user) return renderLogin();
    state.user = status.user;
    await refresh();
    renderApp();
  } catch (err) {
    $('#app').innerHTML = `<div class="loading">Kunne ikke forbinde til serveren: ${esc(err.message)}</div>`;
  }
}

function renderLogin(setup = false) {
  $('#app').innerHTML = `
    <div class="auth">
      <form class="auth-card" id="auth-form">
        <div class="auth-logo">🏠</div>
        <h1>Opgavestyring</h1>
        <p class="muted">${setup
          ? 'Velkommen! Opret den første bruger. Derefter er det kun brugere, du selv opretter, der kan logge ind.'
          : 'Log ind for at se og redigere opgaver.'}</p>
        <label>Brugernavn<input name="username" autocomplete="username" required autofocus></label>
        <label>Adgangskode<input name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required ${setup ? 'minlength="6"' : ''}></label>
        <p class="form-error" id="auth-error"></p>
        <button class="btn primary block">${setup ? 'Opret bruger' : 'Log ind'}</button>
      </form>
    </div>`;
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api(setup ? '/api/setup' : '/api/login', {
        method: 'POST', body: { username: f.username.value, password: f.password.value },
      });
      state.user = r.user;
      await refresh();
      renderApp();
    } catch (err) {
      $('#auth-error').textContent = err.message;
    }
  });
}

function renderInstall(sqliteAvailable) {
  $('#app').innerHTML = `
    <div class="auth">
      <form class="auth-card wide" id="install-form">
        <div class="auth-logo">🛠️</div>
        <h1>Installation</h1>
        <p class="muted">Vælg hvor data skal gemmes, og opret din egen bruger. Det skal kun gøres én gang.</p>
        <label>Database<select name="driver">
          ${sqliteAvailable ? '<option value="sqlite">SQLite – fil på webhotellet (nemmest)</option>' : ''}
          <option value="mysql">MySQL – database fra Simply's kontrolpanel</option>
        </select></label>
        <div id="mysql-fields">
          <label>Databaseserver<input name="mysql_host" placeholder="fx mysql123.unoeuro.com" autocomplete="off"></label>
          <label>Databasenavn<input name="mysql_name" autocomplete="off"></label>
          <label>Databasebruger<input name="mysql_user" autocomplete="off"></label>
          <label>Database-adgangskode<input name="mysql_pass" type="password" autocomplete="off"></label>
        </div>
        <h3 class="section-title">Din bruger</h3>
        <label>Brugernavn<input name="username" autocomplete="username" required minlength="3"></label>
        <label>Adgangskode<input name="password" type="password" autocomplete="new-password" required minlength="6"></label>
        <p class="form-error" id="install-error"></p>
        <button class="btn primary block" id="install-submit">Installer</button>
      </form>
    </div>`;
  const form = $('#install-form');
  const toggle = () => {
    const mysql = form.driver.value === 'mysql';
    $('#mysql-fields').hidden = !mysql;
    for (const n of ['mysql_host', 'mysql_name', 'mysql_user']) form[n].required = mysql;
  };
  toggle();
  form.driver.addEventListener('change', toggle);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#install-submit');
    btn.disabled = true;
    btn.textContent = 'Installerer…';
    try {
      const body = Object.fromEntries(new FormData(form));
      const r = await api('/api/install', { method: 'POST', body });
      state.user = r.user;
      await refresh();
      renderApp();
      toast('Installationen er færdig');
    } catch (err) {
      $('#install-error').textContent = err.message;
      btn.disabled = false;
      btn.textContent = 'Installer';
    }
  });
}

async function logout() {
  await api('/api/logout', { method: 'POST' });
  state.user = null;
  location.hash = '';
  renderLogin();
}

// ---------- Ramme ----------

function currentRoute() {
  const r = location.hash.replace(/^#\/?/, '');
  return ['boliger', 'brugere'].includes(r) ? r : 'oversigt';
}

function renderApp() {
  if (!state.user) return;
  const route = currentRoute();
  const link = (r, label) => `<a href="#/${r === 'oversigt' ? '' : r}" class="${route === r ? 'active' : ''}">${label}</a>`;
  $('#app').innerHTML = `
    <header class="topbar">
      <div class="topbar-inner">
        <a class="brand" href="#/">🏠 <span>Opgavestyring</span></a>
        <nav class="nav">${link('oversigt', 'Oversigt')}${link('boliger', 'Boliger & rum')}${link('brugere', 'Brugere')}</nav>
        <div class="who">
          <span class="muted">${esc(state.user.username)}</span>
          <button class="btn ghost small" data-action="logout">Log ud</button>
        </div>
      </div>
    </header>
    <main class="container" id="view"></main>`;
  if (route === 'boliger') renderProperties();
  else if (route === 'brugere') renderUsers();
  else renderOverview();
}

window.addEventListener('hashchange', () => {
  closeModal();
  renderApp();
});

// ---------- Oversigt ----------

function renderOverview() {
  const view = $('#view');
  if (!state.properties.length) {
    view.innerHTML = `
      <div class="empty big">
        <div class="empty-icon">🏡</div>
        <h2>Ingen boliger endnu</h2>
        <p class="muted">Start med at oprette en bolig – fx dit hus, din lejlighed eller dit sommerhus.</p>
        <button class="btn primary" data-action="new-property">+ Opret bolig</button>
      </div>`;
    return;
  }
  const allOpen = state.tasks.filter((t) => t.status !== 'faerdig').length;
  const chip = (value, label, count) => `
    <button class="pchip ${String(state.selectedProperty) === String(value) ? 'active' : ''}" data-action="select-property" data-id="${value}">
      ${label}<span class="count">${count}</span>
    </button>`;
  view.innerHTML = `
    <div class="pchips">
      ${chip('all', '🗂️ Alle boliger', allOpen)}
      ${state.properties.map((p) => chip(p.id, `${PROPERTY_TYPES[p.type]?.icon || ''} ${esc(p.name)}`, p.open_count)).join('')}
    </div>
    <div class="toolbar">
      <input type="search" id="search" placeholder="Søg i opgaver…" value="${esc(state.search)}">
      <select id="status-filter">
        <option value="open">Ikke færdige</option>
        <option value="all">Alle opgaver</option>
        ${options(STATUS)}
      </select>
      <button class="btn primary" data-action="new-task">+ Ny opgave</button>
    </div>
    <div id="ov-body"></div>`;
  $('#status-filter').value = state.filterStatus;
  $('#search').addEventListener('input', (e) => { state.search = e.target.value; renderOverviewBody(); });
  $('#status-filter').addEventListener('change', (e) => {
    state.filterStatus = e.target.value;
    save('filterStatus', state.filterStatus);
    renderOverviewBody();
  });
  renderOverviewBody();
}

function renderOverviewBody() {
  const body = $('#ov-body');
  if (!body) return;
  const single = state.selectedProperty !== 'all' ? propertyById(state.selectedProperty) : null;
  let tasks = single ? state.tasks.filter((t) => t.property_id === single.id) : state.tasks;

  const counts = { mangler: 0, igang: 0, faerdig: 0 };
  for (const t of tasks) counts[t.status]++;

  // Rumfilter (kun når én bolig er valgt)
  let roomChips = '';
  if (single) {
    const roomIds = new Set(single.rooms.map((r) => r.id));
    if (state.filterRoom !== 'all' && state.filterRoom !== 'none' && !roomIds.has(Number(state.filterRoom))) state.filterRoom = 'all';
    const openIn = (pred) => tasks.filter((t) => t.status !== 'faerdig' && pred(t)).length;
    const rc = (value, label, count) => `
      <button class="rchip ${String(state.filterRoom) === String(value) ? 'active' : ''}" data-action="filter-room" data-id="${value}">
        ${label}${count ? `<span class="count">${count}</span>` : ''}
      </button>`;
    const noRoom = openIn((t) => !t.room_id);
    roomChips = `<div class="rchips">
      ${rc('all', 'Alle rum', 0)}
      ${single.rooms.map((r) => rc(r.id, `${ROOM_TYPES[r.type]?.icon || ''} ${esc(r.name)}`, openIn((t) => t.room_id === r.id))).join('')}
      ${noRoom ? rc('none', `${NO_ROOM.icon} ${NO_ROOM.label}`, noRoom) : ''}
    </div>`;
    if (state.filterRoom === 'none') tasks = tasks.filter((t) => !t.room_id);
    else if (state.filterRoom !== 'all') tasks = tasks.filter((t) => t.room_id === Number(state.filterRoom));
  }

  if (state.filterStatus === 'open') tasks = tasks.filter((t) => t.status !== 'faerdig');
  else if (state.filterStatus !== 'all') tasks = tasks.filter((t) => t.status === state.filterStatus);
  const q = state.search.trim().toLowerCase();
  if (q) {
    tasks = tasks.filter((t) => [t.title, t.description, t.room_name, t.property_name]
      .some((s) => (s || '').toLowerCase().includes(q)));
  }

  // Gruppér efter bolig + rum
  const groups = new Map();
  for (const t of tasks) {
    const key = `${t.property_id}:${t.room_id || 0}`;
    if (!groups.has(key)) groups.set(key, { task: t, items: [] });
    groups.get(key).items.push(t);
  }
  const sortedGroups = [...groups.values()].sort((a, b) =>
    (a.task.property_name.localeCompare(b.task.property_name, 'da'))
    || ((a.task.room_id ? 0 : 1) - (b.task.room_id ? 0 : 1))
    || (a.task.room_name || '').localeCompare(b.task.room_name || '', 'da'));

  body.innerHTML = `
    <div class="stats">
      <div class="stat s-mangler"><b>${counts.mangler}</b><span>Mangler</span></div>
      <div class="stat s-igang"><b>${counts.igang}</b><span>I gang</span></div>
      <div class="stat s-faerdig"><b>${counts.faerdig}</b><span>Færdige</span></div>
    </div>
    ${roomChips}
    ${sortedGroups.length ? sortedGroups.map(({ task, items }) => {
      const room = roomInfo(task);
      return `<section class="group">
        <h2 class="group-title">${room.icon} ${esc(room.label)}
          ${single ? '' : `<span class="group-sub">· ${PROPERTY_TYPES[task.property_type]?.icon || ''} ${esc(task.property_name)}</span>`}
          <span class="count">${items.length}</span></h2>
        <div class="cards">${items.map(taskCard).join('')}</div>
      </section>`;
    }).join('') : `
      <div class="empty">
        <div class="empty-icon">✅</div>
        <p class="muted">${state.tasks.length ? 'Ingen opgaver matcher dit filter.' : 'Ingen opgaver endnu – opret den første!'}</p>
      </div>`}`;
}

function taskCard(t) {
  const img = t.images[0];
  return `
    <article class="card ${t.status === 'faerdig' ? 'done' : ''}" data-action="open-task" data-id="${t.id}" tabindex="0">
      <div class="thumb">${img
        ? `<img src="${esc(img.url)}" alt="" loading="lazy">${t.images.length > 1 ? `<span class="img-count">📷 ${t.images.length}</span>` : ''}`
        : `<span class="thumb-icon">${roomInfo(t).icon}</span>`}</div>
      <div class="card-body">
        <h3>${esc(t.title)}</h3>
        ${t.description ? `<p class="desc">${esc(t.description)}</p>` : ''}
        <div class="meta">
          <span class="badge s-${t.status}">${STATUS[t.status].label}</span>
          ${t.priority !== 'normal' ? `<span class="badge p-${t.priority}">${PRIORITY[t.priority].label} prioritet</span>` : ''}
        </div>
      </div>
    </article>`;
}

// ---------- Opgave: detaljer ----------

function openTask(taskId) {
  const t = state.tasks.find((x) => x.id === Number(taskId));
  if (!t) return;
  const room = roomInfo(t);
  openModal(`
    <div class="modal-head">
      <h2>${esc(t.title)}</h2>
      <button class="icon-btn" data-action="close-modal" aria-label="Luk">✕</button>
    </div>
    <p class="where">${PROPERTY_TYPES[t.property_type]?.icon || ''} ${esc(t.property_name)} · ${room.icon} ${esc(room.label)}</p>
    <div class="status-switch">
      ${Object.entries(STATUS).map(([k, s]) => `
        <button class="seg s-${k} ${t.status === k ? 'active' : ''}" data-action="set-status" data-id="${t.id}" data-status="${k}">${s.label}</button>`).join('')}
    </div>
    ${t.priority !== 'normal' ? `<p><span class="badge p-${t.priority}">${PRIORITY[t.priority].label} prioritet</span></p>` : ''}
    ${t.description ? `<p class="description">${esc(t.description)}</p>` : '<p class="muted">Ingen beskrivelse.</p>'}
    <h3 class="section-title">Billeder</h3>
    <div class="gallery">
      ${t.images.map((img, i) => `
        <div class="gallery-item">
          <img src="${esc(img.url)}" alt="" data-action="lightbox" data-task="${t.id}" data-index="${i}">
          <button class="del-img" data-action="delete-image" data-id="${img.id}" aria-label="Slet billede">✕</button>
        </div>`).join('')}
      <label class="add-img">
        <input type="file" accept="image/*" multiple id="add-images">
        <span>📷<br>Tilføj billeder</span>
      </label>
    </div>
    <p class="muted small">Oprettet ${formatDate(t.created_at)}${t.created_by_name ? ` af ${esc(t.created_by_name)}` : ''}</p>
    <div class="modal-actions">
      <button class="btn danger ghost" data-action="delete-task" data-id="${t.id}">Slet</button>
      <span class="spacer"></span>
      <button class="btn" data-action="edit-task" data-id="${t.id}">Rediger</button>
    </div>`);
  $('#add-images').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    const label = e.target.closest('.add-img');
    label.classList.add('busy');
    try {
      const updated = await api(`/api/tasks/${t.id}/images`, { method: 'POST', body: await imagesFormData(files) });
      replaceTask(updated);
      openTask(t.id);
      toast('Billeder tilføjet');
    } catch (err) {
      label.classList.remove('busy');
      toast(err.message, true);
    }
  });
}

function replaceTask(task) {
  const i = state.tasks.findIndex((x) => x.id === task.id);
  if (i >= 0) state.tasks[i] = task;
  else state.tasks.unshift(task);
}

async function afterTaskChange() {
  await refresh();
  if (currentRoute() === 'oversigt') renderOverview();
}

// ---------- Opgave: formular ----------

function taskForm(t = null) {
  const pid = t ? t.property_id
    : state.selectedProperty !== 'all' ? Number(state.selectedProperty) : state.properties[0]?.id;
  const presetRoom = t ? t.room_id
    : (state.filterRoom !== 'all' && state.filterRoom !== 'none' ? Number(state.filterRoom) : null);
  openModal(`
    <form id="task-form">
      <div class="modal-head">
        <h2>${t ? 'Rediger opgave' : 'Ny opgave'}</h2>
        <button type="button" class="icon-btn" data-action="close-modal" aria-label="Luk">✕</button>
      </div>
      <label>Hvad skal laves?<input name="title" required maxlength="150" value="${esc(t?.title)}" placeholder="Fx: Male vinduesrammer"></label>
      <label>Beskrivelse<textarea name="description" rows="4" maxlength="5000" placeholder="Detaljer, mål, materialer…">${esc(t?.description)}</textarea></label>
      <div class="row">
        <label>Bolig<select name="property_id" required>
          ${state.properties.map((p) => `<option value="${p.id}" ${p.id === pid ? 'selected' : ''}>${PROPERTY_TYPES[p.type]?.icon || ''} ${esc(p.name)}</option>`).join('')}
        </select></label>
        <label>Rum<select name="room_id"></select></label>
      </div>
      <div class="row">
        <label>Status<select name="status">${options(STATUS, t?.status || 'mangler')}</select></label>
        <label>Prioritet<select name="priority">${options(PRIORITY, t?.priority || 'normal')}</select></label>
      </div>
      ${t ? '' : `
        <label>Billeder
          <input type="file" name="images" accept="image/*" multiple>
        </label>
        <div class="previews" id="previews"></div>`}
      <p class="form-error" id="task-error"></p>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-action="${t ? 'open-task' : 'close-modal'}" data-id="${t?.id || ''}">Annuller</button>
        <span class="spacer"></span>
        <button class="btn primary" id="task-submit">${t ? 'Gem ændringer' : 'Opret opgave'}</button>
      </div>
    </form>`);

  const form = $('#task-form');
  const fillRooms = (selected) => {
    const p = propertyById(form.property_id.value);
    form.room_id.innerHTML = `<option value="">${NO_ROOM.icon} ${NO_ROOM.label}</option>` +
      (p?.rooms || []).map((r) => `<option value="${r.id}" ${r.id === selected ? 'selected' : ''}>${ROOM_TYPES[r.type]?.icon || ''} ${esc(r.name)}</option>`).join('');
  };
  fillRooms(presetRoom);
  form.property_id.addEventListener('change', () => fillRooms(null));

  if (!t) {
    form.images.addEventListener('change', () => {
      $('#previews').innerHTML = [...form.images.files]
        .map((f) => `<img src="${URL.createObjectURL(f)}" alt="">`).join('');
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#task-submit');
    btn.disabled = true;
    btn.textContent = 'Gemmer…';
    const fields = {
      title: form.title.value,
      description: form.description.value,
      property_id: form.property_id.value,
      room_id: form.room_id.value,
      status: form.status.value,
      priority: form.priority.value,
    };
    try {
      let saved;
      if (t) {
        saved = await api(`/api/tasks/${t.id}`, {
          method: 'PUT', body: { ...fields, property_id: Number(fields.property_id), room_id: fields.room_id ? Number(fields.room_id) : null },
        });
      } else {
        saved = await api('/api/tasks', { method: 'POST', body: await imagesFormData([...form.images.files], fields) });
      }
      await afterTaskChange();
      openTask(saved.id);
      toast(t ? 'Opgaven er gemt' : 'Opgaven er oprettet');
    } catch (err) {
      $('#task-error').textContent = err.message;
      btn.disabled = false;
      btn.textContent = t ? 'Gem ændringer' : 'Opret opgave';
    }
  });
}

// ---------- Lightbox ----------

function openLightbox(taskId, index) {
  const t = state.tasks.find((x) => x.id === Number(taskId));
  if (!t) return;
  let i = Number(index);
  const box = document.createElement('div');
  box.className = 'lightbox';
  const show = () => {
    box.innerHTML = `
      <img src="${esc(t.images[i].url)}" alt="">
      ${t.images.length > 1 ? `
        <button class="lb-nav prev" aria-label="Forrige">‹</button>
        <button class="lb-nav next" aria-label="Næste">›</button>
        <span class="lb-count">${i + 1} / ${t.images.length}</span>` : ''}
      <button class="lb-close" aria-label="Luk">✕</button>`;
  };
  const move = (d) => { i = (i + d + t.images.length) % t.images.length; show(); };
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'ArrowLeft') move(-1);
    if (e.key === 'ArrowRight') move(1);
  };
  box.addEventListener('click', (e) => {
    if (e.target.classList.contains('prev')) move(-1);
    else if (e.target.classList.contains('next')) move(1);
    else if (e.target.tagName !== 'IMG') close();
  });
  document.addEventListener('keydown', onKey, true);
  show();
  document.body.appendChild(box);
}

// ---------- Boliger & rum ----------

function renderProperties() {
  $('#view').innerHTML = `
    <div class="page-head">
      <h1>Boliger & rum</h1>
      <button class="btn primary" data-action="new-property">+ Ny bolig</button>
    </div>
    ${state.properties.length ? '' : '<div class="empty"><div class="empty-icon">🏡</div><p class="muted">Ingen boliger endnu.</p></div>'}
    <div class="plist">
      ${state.properties.map((p) => `
        <section class="pcard">
          <div class="pcard-head">
            <div class="picon">${PROPERTY_TYPES[p.type]?.icon || '🏘️'}</div>
            <div class="pinfo">
              <h2>${esc(p.name)}</h2>
              <p class="muted">${PROPERTY_TYPES[p.type]?.label || ''}${p.address ? ' · ' + esc(p.address) : ''}</p>
              <p class="muted small">${p.open_count} åbne · ${p.total_count} i alt</p>
            </div>
            <div class="pactions">
              <button class="btn small" data-action="edit-property" data-id="${p.id}">Rediger</button>
              <button class="btn small danger ghost" data-action="delete-property" data-id="${p.id}">Slet</button>
            </div>
          </div>
          <h3 class="section-title">Rum</h3>
          <div class="room-list">
            ${p.rooms.map((r) => `
              <span class="room-tag">
                ${ROOM_TYPES[r.type]?.icon || ''} ${esc(r.name)}
                <button class="tag-btn" data-action="edit-room" data-id="${r.id}" aria-label="Rediger rum">✎</button>
                <button class="tag-btn" data-action="delete-room" data-id="${r.id}" aria-label="Slet rum">✕</button>
              </span>`).join('') || '<span class="muted">Ingen rum endnu.</span>'}
          </div>
          <form class="add-room" data-property="${p.id}">
            <select name="type">${options(ROOM_TYPES, 'vaerelse')}</select>
            <input name="name" placeholder="Navn, fx 'Børneværelse'" maxlength="60" required>
            <button class="btn small">+ Tilføj rum</button>
          </form>
        </section>`).join('')}
    </div>`;

  for (const form of document.querySelectorAll('.add-room')) {
    // Foreslå et navn ud fra rumtypen
    const suggest = () => {
      const p = propertyById(form.dataset.property);
      const type = form.type.value;
      const label = ROOM_TYPES[type].label;
      const n = p.rooms.filter((r) => r.type === type).length;
      form.name.placeholder = type === 'andet' ? 'Navn på rum' : n ? `${label} ${n + 1}` : label;
    };
    suggest();
    form.type.addEventListener('change', suggest);
    form.name.required = false;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = form.name.value.trim() || (form.type.value !== 'andet' ? form.name.placeholder : '');
      try {
        await api(`/api/properties/${form.dataset.property}/rooms`, { method: 'POST', body: { name, type: form.type.value } });
        await refresh();
        renderProperties();
        toast(`Rummet "${name}" er tilføjet`);
      } catch (err) { toast(err.message, true); }
    });
  }
}

function propertyForm(p = null) {
  openModal(`
    <form id="property-form">
      <div class="modal-head">
        <h2>${p ? 'Rediger bolig' : 'Ny bolig'}</h2>
        <button type="button" class="icon-btn" data-action="close-modal" aria-label="Luk">✕</button>
      </div>
      <label>Navn<input name="name" required maxlength="80" value="${esc(p?.name)}" placeholder="Fx: Huset i Aarhus"></label>
      <label>Type<select name="type">${options(PROPERTY_TYPES, p?.type || 'hus')}</select></label>
      <label>Adresse (valgfri)<input name="address" maxlength="200" value="${esc(p?.address)}"></label>
      ${p ? '' : `<label class="check"><input type="checkbox" name="defaultRooms" checked> Opret standardrum (stue, køkken, gang, badeværelse, værelse)</label>`}
      <p class="form-error" id="property-error"></p>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-action="close-modal">Annuller</button>
        <span class="spacer"></span>
        <button class="btn primary">${p ? 'Gem' : 'Opret bolig'}</button>
      </div>
    </form>`);
  $('#property-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { name: f.name.value, type: f.type.value, address: f.address.value, defaultRooms: f.defaultRooms?.checked };
    try {
      const r = await api(p ? `/api/properties/${p.id}` : '/api/properties', { method: p ? 'PUT' : 'POST', body });
      if (!p) state.selectedProperty = r.id;
      await refresh();
      closeModal();
      renderApp();
      toast(p ? 'Boligen er gemt' : 'Boligen er oprettet');
    } catch (err) {
      $('#property-error').textContent = err.message;
    }
  });
}

function findRoom(roomId) {
  for (const p of state.properties) {
    const r = p.rooms.find((x) => x.id === Number(roomId));
    if (r) return r;
  }
  return null;
}

function roomForm(room) {
  openModal(`
    <form id="room-form">
      <div class="modal-head">
        <h2>Rediger rum</h2>
        <button type="button" class="icon-btn" data-action="close-modal" aria-label="Luk">✕</button>
      </div>
      <label>Navn<input name="name" required maxlength="60" value="${esc(room.name)}"></label>
      <label>Type<select name="type">${options(ROOM_TYPES, room.type)}</select></label>
      <p class="form-error" id="room-error"></p>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-action="close-modal">Annuller</button>
        <span class="spacer"></span>
        <button class="btn primary">Gem</button>
      </div>
    </form>`);
  $('#room-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/api/rooms/${room.id}`, { method: 'PUT', body: { name: e.target.name.value, type: e.target.type.value } });
      await refresh();
      closeModal();
      renderApp();
    } catch (err) {
      $('#room-error').textContent = err.message;
    }
  });
}

// ---------- Brugere ----------

async function renderUsers() {
  const view = $('#view');
  view.innerHTML = '<div class="loading">Indlæser…</div>';
  try {
    state.users = await api('/api/users');
  } catch (err) {
    view.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
    return;
  }
  view.innerHTML = `
    <div class="page-head"><h1>Brugere</h1></div>
    <p class="muted">Kun brugere på denne liste kan logge ind og oprette eller redigere opgaver.</p>
    <div class="two-col">
      <section class="panel">
        <h2>Brugere med adgang</h2>
        <ul class="user-list">
          ${state.users.map((u) => `
            <li>
              <span>👤 ${esc(u.username)} ${u.id === state.user.id ? '<span class="muted">(dig)</span>' : ''}</span>
              ${u.id === state.user.id ? '' : `<button class="btn small danger ghost" data-action="delete-user" data-id="${u.id}">Fjern</button>`}
            </li>`).join('')}
        </ul>
        <h3 class="section-title">Tilføj bruger</h3>
        <form id="user-form" class="stack">
          <input name="username" placeholder="Brugernavn" autocomplete="off" required minlength="3">
          <input name="password" type="password" placeholder="Adgangskode (mindst 6 tegn)" autocomplete="new-password" required minlength="6">
          <button class="btn primary">Opret bruger</button>
        </form>
      </section>
      <section class="panel">
        <h2>Skift din adgangskode</h2>
        <form id="pw-form" class="stack">
          <input name="currentPassword" type="password" placeholder="Nuværende adgangskode" autocomplete="current-password" required>
          <input name="newPassword" type="password" placeholder="Ny adgangskode (mindst 6 tegn)" autocomplete="new-password" required minlength="6">
          <button class="btn">Skift adgangskode</button>
        </form>
      </section>
    </div>`;
  $('#user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/users', { method: 'POST', body: { username: e.target.username.value, password: e.target.password.value } });
      toast('Brugeren er oprettet');
      renderUsers();
    } catch (err) { toast(err.message, true); }
  });
  $('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/me/password', {
        method: 'POST', body: { currentPassword: e.target.currentPassword.value, newPassword: e.target.newPassword.value },
      });
      e.target.reset();
      toast('Adgangskoden er skiftet');
    } catch (err) { toast(err.message, true); }
  });
}

// ---------- Modal ----------

function openModal(html) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeModal(); });
  document.body.appendChild(overlay);
  document.body.classList.add('no-scroll');
  overlay.querySelector('input:not([type=file]), textarea')?.focus();
}

function closeModal() {
  document.querySelector('.overlay')?.remove();
  document.body.classList.remove('no-scroll');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
  if (e.key === 'Enter' && e.target.matches?.('.card')) openTask(e.target.dataset.id);
});

// ---------- Klik-handlinger ----------

const actions = {
  'logout': () => logout(),
  'close-modal': () => closeModal(),
  'select-property': (el) => {
    state.selectedProperty = el.dataset.id;
    state.filterRoom = 'all';
    save('selectedProperty', state.selectedProperty);
    renderOverview();
  },
  'filter-room': (el) => { state.filterRoom = el.dataset.id; renderOverviewBody(); },
  'new-task': () => taskForm(),
  'open-task': (el) => (el.dataset.id ? openTask(el.dataset.id) : closeModal()),
  'edit-task': (el) => taskForm(state.tasks.find((t) => t.id === Number(el.dataset.id))),
  'set-status': async (el) => {
    try {
      replaceTask(await api(`/api/tasks/${el.dataset.id}`, { method: 'PUT', body: { status: el.dataset.status } }));
      await afterTaskChange();
      openTask(el.dataset.id);
    } catch (err) { toast(err.message, true); }
  },
  'delete-task': async (el) => {
    if (!confirm('Vil du slette denne opgave og dens billeder?')) return;
    try {
      await api(`/api/tasks/${el.dataset.id}`, { method: 'DELETE' });
      closeModal();
      await afterTaskChange();
      toast('Opgaven er slettet');
    } catch (err) { toast(err.message, true); }
  },
  'delete-image': async (el) => {
    if (!confirm('Vil du slette billedet?')) return;
    try {
      const updated = await api(`/api/images/${el.dataset.id}`, { method: 'DELETE' });
      replaceTask(updated);
      openTask(updated.id);
      if (currentRoute() === 'oversigt') renderOverviewBody();
    } catch (err) { toast(err.message, true); }
  },
  'lightbox': (el) => openLightbox(el.dataset.task, el.dataset.index),
  'new-property': () => propertyForm(),
  'edit-property': (el) => propertyForm(propertyById(el.dataset.id)),
  'delete-property': async (el) => {
    const p = propertyById(el.dataset.id);
    if (!confirm(`Vil du slette "${p.name}"? Alle rum, opgaver og billeder i boligen bliver også slettet.`)) return;
    try {
      await api(`/api/properties/${p.id}`, { method: 'DELETE' });
      await refresh();
      renderApp();
      toast('Boligen er slettet');
    } catch (err) { toast(err.message, true); }
  },
  'edit-room': (el) => roomForm(findRoom(el.dataset.id)),
  'delete-room': async (el) => {
    const r = findRoom(el.dataset.id);
    if (!confirm(`Vil du slette rummet "${r.name}"? Opgaver i rummet bliver beholdt under "${NO_ROOM.label}".`)) return;
    try {
      await api(`/api/rooms/${r.id}`, { method: 'DELETE' });
      await refresh();
      renderApp();
    } catch (err) { toast(err.message, true); }
  },
  'delete-user': async (el) => {
    const u = state.users.find((x) => x.id === Number(el.dataset.id));
    if (!confirm(`Vil du fjerne brugeren "${u.username}"?`)) return;
    try {
      await api(`/api/users/${u.id}`, { method: 'DELETE' });
      renderUsers();
    } catch (err) { toast(err.message, true); }
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || !actions[el.dataset.action]) return;
  if (el.tagName === 'A') e.preventDefault();
  actions[el.dataset.action](el);
});

init();
