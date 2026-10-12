// Live GPS and barometric altitude from the FlySight 2, plus shared state and navigation.
// UUIDs and packet layouts from flysight/flysight-2-firmware (Docs/ble.md, STM32_WPAN/App/custom_app.c)
const GNSS_SERVICE = '00000001-cc7a-482a-984a-7f2ed5b3e58f';
const GNSS_PV_CHAR = '00000000-8e22-4541-9d4c-21edae82ed19';
const BARO_CHAR = '00000008-8e22-4541-9d4c-21edae82ed19';   // firmware with barometer streaming only
const SD_CONTROL_CHAR = '00000006-8e22-4541-9d4c-21edae82ed19';
const STORE_KEY = 'le-live';

const $ = id => document.getElementById(id);
let device = null, lastMm = null, lastVel = null, lastRx = 0, wakeLock = null, wantConnected = false, connecting = false;
let baro = null, hasBaro = null;   // baro = { h: metres above where the FlySight was switched on, at: Date.now() }

// Remembered between visits: display units, saved dropzones, and the last FlySight
// state.dzs = [{ name, elev, unit }] with elev in the unit it was entered in
let state = { feet: true, agl: true, dzs: [], activeDz: -1, device: null, auto: false };
try { Object.assign(state, JSON.parse(localStorage.getItem(STORE_KEY)) || {}); } catch {}
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {} }

function setStatus(text, cls) { $('status').textContent = text; $('dot').className = cls || ''; }
function setMsg(text) { $('msg').textContent = text || ''; }
function setConnectButton() {
  $('connect').textContent = wantConnected ? 'Disconnect' : 'Connect FlySight →';
  $('connect').classList.toggle('off', wantConnected);
}

const activeDz = () => state.dzs[state.activeDz] || null;
const dzElevM = dz => dz.unit === 'ft' ? dz.elev / FT_PER_M : dz.elev;

function render() {
  const dz = activeDz(), agl = dz && state.agl;
  $('unit').textContent = state.feet ? 'ft' : 'm';
  $('label').textContent = agl ? `[ Altitude // above ${dz.name} ]` : '[ GPS altitude // MSL ]';
  $('dzBtn').textContent = dz ? dz.name : 'Dropzone';
  $('mode').textContent = agl ? 'AGL' : 'MSL';
  $('mode').disabled = !dz;
  $('baroUnit').textContent = state.feet ? 'ft' : 'm';
  const baroLive = baro && Date.now() - baro.at < 3000;
  $('baroLabel').textContent = hasBaro === false ? '[ Barometric // not on this firmware ]'
    : baro && !baroLive ? '[ Barometric // no data ]' : '[ Barometric // above switch-on ]';
  $('baroAlt').textContent = baroLive ? formatAlt(baro.h) : '---';
  document.querySelectorAll('.speedUnit').forEach(el => el.textContent = state.feet ? 'mph' : 'km/h');
  if (lastVel) {
    $('vs').textContent = formatSpeed(lastVel.down);  // positive = descending
    $('gs').textContent = formatSpeed(lastVel.ground);
  }
  if (lastMm === null) return;
  $('alt').textContent = formatAlt(lastMm / 1000 - (agl ? dzElevM(dz) : 0));
}
const formatAlt = m => Math.round(state.feet ? m * FT_PER_M : m).toLocaleString();
const formatSpeed = mms => Math.round(mms / 1000 * (state.feet ? 2.23694 : 3.6));

function onPacket(e) {
  const dv = e.target.value;
  $('raw').textContent = [...new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)]
    .map(b => b.toString(16).padStart(2, '0')).join(' ');

  // Byte 0 is a field mask (0xb0 = time of week + position + velocity); everything is little-endian.
  const mask = dv.getUint8(0);
  let o = 1;
  if (mask & 0x80) o += 4;                       // iTOW (ms)
  if (!(mask & 0x20) || dv.byteLength < o + 12) { setMsg('Packet has no position data'); return; }
  lastMm = dv.getInt32(o + 8, true);             // lon, lat, then hMSL (mm)
  o += 12;
  if ((mask & 0x10) && dv.byteLength >= o + 12) {
    const velN = dv.getInt32(o, true), velE = dv.getInt32(o + 4, true), velD = dv.getInt32(o + 8, true); // mm/s
    lastVel = { down: velD, ground: Math.hypot(velN, velE) };
  }
  lastRx = Date.now();
  setMsg('');
  render();
}

// Barometer packet, little-endian. Byte 0 is a field mask, like the GNSS packet: 0x80 time (uint32, ms),
// 0x40 pressure (int32, Pa*100), 0x20 temperature (int16, °C*100), 0x10 start pressure (int32, Pa*100), in that
// order. The start pressure is the FlySight's first sample since it was switched on, held for the whole session,
// so the ground reference does not depend on when the phone connected.
function onBaro(e) {
  const dv = e.target.value;
  if (dv.byteLength < 1) return;
  const mask = dv.getUint8(0);
  if ((mask & 0x50) !== 0x50) return;           // needs pressure and start pressure
  let o = 1;
  if (mask & 0x80) o += 4;
  if (dv.byteLength < o + 4 + (mask & 0x20 ? 2 : 0) + 4) return;
  const pa = dv.getInt32(o, true) / 100;
  o += 4;
  if (mask & 0x20) o += 2;
  const startPa = dv.getInt32(o, true) / 100;
  if (!(pa > 10000 && pa < 110000 && startPa > 10000 && startPa < 110000)) return;
  baro = { h: pressureAltitude(pa) - pressureAltitude(startPa), at: Date.now() };
  render();
}

/* ── Bluetooth ─────────────────────────────────────────────────────────── */

function adopt(d) {
  device = d;
  device.addEventListener('gattserverdisconnected', () => {
    crs = null;
    if (!wantConnected) return;
    setStatus('Reconnecting…', 'stale');
    reconnect();
  });
}

async function subscribe() {
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(GNSS_SERVICE);
  const ch = await service.getCharacteristic(GNSS_PV_CHAR);
  ch.addEventListener('characteristicvaluechanged', onPacket);
  await ch.startNotifications();
  try {
    const bc = await service.getCharacteristic(BARO_CHAR);
    // The barometer mask and divider last until the FlySight is switched off, so another app may have changed
    // them. Ask for the default packet (with the start pressure) at the full rate.
    try {
      const cp = await service.getCharacteristic(SD_CONTROL_CHAR);
      await cp.writeValue(Uint8Array.of(0x03, 0, 0xf0));   // set sensor mask: baro, time + pressure + temp + start
      await cp.writeValue(Uint8Array.of(0x10, 0, 1, 0));   // set sensor divider: baro, every sample
    } catch {}
    bc.addEventListener('characteristicvaluechanged', onBaro);
    await bc.startNotifications();
    hasBaro = true;
  } catch { hasBaro = false; }   // firmware without barometer streaming: GPS only
  render();
  setStatus('Connected — waiting for GPS', 'stale');
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}

// Keep trying until the FlySight is back in range or the user disconnects
async function reconnect() {
  if (connecting) return;
  connecting = true;
  while (wantConnected) {
    try { await subscribe(); break; }
    catch { await new Promise(r => setTimeout(r, 1500)); }
  }
  connecting = false;
}

// After a reload, pick the remembered FlySight back up without showing the device picker.
// Chrome only hands back remembered devices when its persistent Bluetooth permissions are on.
async function resume() {
  if (!state.auto || !state.device || !navigator.bluetooth) return;
  let known = [];
  try { known = await navigator.bluetooth.getDevices(); } catch {}
  const d = known.find(x => x.id === state.device.id);
  if (!d) { setStatus(`Tap connect to rejoin ${state.device.name}`); return; }
  adopt(d);
  wantConnected = true;
  setConnectButton();
  setStatus(`Reconnecting to ${state.device.name}…`, 'stale');
  reconnect();
}

// Normally only FlySights are listed. showAll lists every nearby device, as a way out if the filter misses the unit.
async function connect(showAll) {
  if (wantConnected) {
    wantConnected = false;
    state.auto = false; save();
    device?.gatt.disconnect();
    setConnectButton();
    setStatus('Not connected');
    return;
  }
  if (!navigator.bluetooth) {
    setMsg('This browser has no Web Bluetooth. Use Chrome on Android, or the Bluefy browser on iPhone.');
    return;
  }
  try {
    setMsg('');
    $('showAll').hidden = true;
    const services = [GNSS_SERVICE, CRS_SERVICE, DS_SERVICE];
    // List FlySights by advertised name, or by FlySight's manufacturer data for units whose name differs.
    // The firmware advertises company 0x09DB followed by one flag byte (0, or 1 in pairing mode); requiring
    // that byte keeps out other devices that happen to use the same company ID.
    adopt(await navigator.bluetooth.requestDevice(showAll ? { acceptAllDevices: true, optionalServices: services } : {
      filters: [
        { namePrefix: 'FlySight' },
        { manufacturerData: [{ companyIdentifier: 0x09DB, dataPrefix: Uint8Array.of(0x00), mask: Uint8Array.of(0xFE) }] },
      ],
      optionalServices: services,
    }));
    setStatus('Connecting…');
    await subscribe();
    wantConnected = true;
    state.device = { id: device.id, name: device.name || 'FlySight' };
    state.auto = true; save();
    setConnectButton();
  } catch (err) {
    wantConnected = false;
    setStatus('Not connected');
    // NotFoundError = the picker was closed without choosing, most likely because the FlySight was not in it
    if (err.name === 'NotFoundError') $('showAll').hidden = !!showAll;
    else setMsg(err.message + ' The FlySight talks to one device at a time: disconnect any other phone or laptop first. On a device it has not used before, put it in pairing mode and accept the pairing prompt.');
  }
}
$('connect').onclick = () => connect(false);
$('showAll').onclick = () => connect(true);

/* ── Units and dropzones ───────────────────────────────────────────────── */

$('units').onclick = () => { state.feet = !state.feet; save(); render(); };
$('mode').onclick = () => { state.agl = !state.agl; save(); render(); };

const NONE = '-1', NEW = 'new';
function fillDzForm() {
  const sel = $('dzSel');
  sel.replaceChildren(
    new Option('None — show MSL', NONE),
    ...state.dzs.map((dz, i) => new Option(`${dz.name} — ${dz.elev} ${dz.unit}`, i)),
    new Option('+ New dropzone', NEW));
  sel.value = activeDz() ? state.activeDz : (state.dzs.length ? NONE : NEW);
  loadDzFields();
}
function loadDzFields() {
  const dz = state.dzs[$('dzSel').value];
  $('dzName').value = dz ? dz.name : '';
  $('dzElev').value = dz ? dz.elev : '';
  $('dzUnit').value = dz ? dz.unit : (state.feet ? 'ft' : 'm');
  $('dzDelete').disabled = !dz;
}

function openDzDialog() { fillDzForm(); $('dzDialog').showModal(); }
$('dzBtn').onclick = openDzDialog;
$('dzClose').onclick = () => $('dzDialog').close();
$('dzDialog').addEventListener('close', () => route());   // a jump on screen may depend on the dropzone list
$('dzSel').onchange = () => {
  const v = $('dzSel').value;
  if (v !== NEW) { state.activeDz = Number(v); state.agl = true; save(); render(); }
  loadDzFields();
};
$('dzGps').onclick = () => {
  if (lastMm === null) { $('dzElev').placeholder = 'No GPS reading yet'; return; }
  const m = lastMm / 1000;
  $('dzElev').value = Math.round($('dzUnit').value === 'ft' ? m * FT_PER_M : m);
};
$('dzSave').onclick = () => {
  const name = $('dzName').value.trim(), elev = parseFloat($('dzElev').value);
  if (!name) { $('dzName').focus(); return; }
  if (!Number.isFinite(elev)) { $('dzElev').focus(); return; }
  const dz = { name, elev, unit: $('dzUnit').value };
  const i = Number($('dzSel').value);
  if (state.dzs[i]) { state.dzs[i] = dz; state.activeDz = i; }
  else { state.dzs.push(dz); state.activeDz = state.dzs.length - 1; }
  state.agl = true;
  save(); render();
  $('dzDialog').close();
};
$('dzDelete').onclick = () => {
  const i = Number($('dzSel').value);
  if (!state.dzs[i]) return;
  state.dzs.splice(i, 1);
  state.activeDz = -1;
  save(); render(); fillDzForm();
};

setInterval(() => {
  if (!lastRx) return;
  const age = (Date.now() - lastRx) / 1000;
  $('age').textContent = age < 2 ? 'live' : `${Math.round(age)}s ago`;
  if (wantConnected && device?.gatt.connected) setStatus(age < 2 ? 'Live' : 'No data — is the FlySight on with a fix?', age < 2 ? 'live' : 'stale');
  render();   // marks the barometer reading stale once it goes quiet
}, 500);

/* ── Navigation: #live, #jumps, #jump/<id> ─────────────────────────────── */

function route() {
  const hash = location.hash.slice(1), jumpId = hash.startsWith('jump/') ? hash.slice(5) : null;
  const view = jumpId ? 'jump' : hash === 'jumps' ? 'jumps' : 'live';
  $('liveView').hidden = view !== 'live';
  $('jumpsView').hidden = view !== 'jumps';
  $('jumpView').hidden = view !== 'jump';
  $('tabLive').classList.toggle('on', view === 'live');
  $('tabJumps').classList.toggle('on', view !== 'live');
  if (view === 'jumps') showJumpList();
  if (view === 'jump') showJump(jumpId);
}
addEventListener('hashchange', route);

// Cache the app so it opens with no data connection
if ('serviceWorker' in navigator) {
  // When a new version takes over, reload once so the screen is never a version behind
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !wantConnected) location.reload(); });
  navigator.serviceWorker.register('sw.js')
    .then(reg => { reg.update().catch(() => {}); return navigator.serviceWorker.ready; })
    .then(() => { if (!lastRx) $('age').textContent = '[ offline ready ]'; })
    .catch(() => {});
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && wantConnected) {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  }
});
