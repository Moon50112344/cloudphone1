/**
 * AetherDroid — Frontend Router & UI Controller
 * Backend-driven architecture: all state synced with the Control Plane API.
 * Phase 3: Input Mapping & ADB Bridge — routes touch/key events to /api/input
 * and reports round-trip latency in the Live View overlay.
 */
import { onInput, onHardwareKey, emitKeyboard, initInputHandler } from './input-handler.js';
const API = {
  instances: () => '/api/instances',
  start: () => '/api/start',
  power: () => '/api/power',
  signal: () => '/api/signal',
  input: () => '/api/input',
};
const state = {
  view: 'dashboard',
  instances: [],
  activeSession: null,
  pendingAction: false,
  keyboardCapture: false,
};
const $ = (id) => document.getElementById(id);
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error ?? `Request failed (${res.status})`);
  }
  return data;
}
// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
function toast(message, type = 'info') {
  const container = $('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type} px-4 py-3 rounded-xl text-sm text-slate-100 shadow-lg max-w-xs`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 300);
  }, 3200);
}
// ---------------------------------------------------------------------------
// Loading overlay
// ---------------------------------------------------------------------------
function setLoading(on) {
  const overlay = $('loading-overlay');
  if (!overlay) return;
  overlay.classList.toggle('hidden', !on);
  overlay.classList.toggle('opacity-0', !on);
}
function setBtnLoading(btn, on) {
  if (!btn) return;
  btn.disabled = on;
  btn.classList.toggle('opacity-60', on);
  btn.classList.toggle('cursor-wait', on);
  btn.classList.toggle('pointer-events-none', on);
}
// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const TITLES = { dashboard: 'Command Center', phone: 'Live View Terminal' };
function switchView(view) {
  if (!TITLES[view]) return;
  state.view = view;
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  const target = $(`view-${view}`);
  if (target) {
    target.classList.remove('hidden');
    target.style.animation = 'none';
    void target.offsetHeight;
    target.style.animation = '';
  }
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    const active = btn.getAttribute('data-view') === view;
    btn.classList.toggle('bg-blue-600/15', active);
    btn.classList.toggle('text-blue-400', active);
    btn.classList.toggle('text-slate-400', !active);
  });
  const title = $('page-title');
  if (title) title.textContent = TITLES[view];
  if (view === 'phone') startStream();
  window.scrollTo({ top: 0 });
}
// ---------------------------------------------------------------------------
// Dashboard: instance cards
// ---------------------------------------------------------------------------
const STATUS_STYLES = {
  online: { dot: 'bg-emerald-500', label: 'Online', text: 'text-emerald-400' },
  offline: { dot: 'bg-slate-500', label: 'Offline', text: 'text-slate-400' },
  booting: { dot: 'bg-amber-400 pulse-blue', label: 'Provisioning…', text: 'text-amber-400' },
  connecting: { dot: 'bg-blue-400 pulse-blue', label: 'Connecting…', text: 'text-blue-400' },
};
function renderStats() {
  const online = state.instances.filter((i) => i.status === 'online');
  $('stat-instances').textContent = String(online.length);
  $('stat-cpu').textContent = String(online.reduce((s, i) => s + (i.cpu ?? 0), 0));
  $('stat-ram').textContent = String(online.reduce((s, i) => s + (i.ram ?? 0), 0));
}
function instanceCard(inst) {
  const s = STATUS_STYLES[inst.status] ?? STATUS_STYLES.offline;
  const connectable = inst.status === 'online';
  return `
    <article class="glass-panel rounded-2xl p-6 flex flex-col gap-4" data-id="${inst.id}">
      <div class="flex items-start justify-between">
        <div class="min-w-0">
          <h4 class="font-semibold text-slate-100 truncate">${inst.name ?? 'Cloud Phone'}</h4>
          <p class="text-xs font-mono text-slate-500 mt-0.5">${inst.id}</p>
        </div>
        <span class="flex items-center gap-2 text-xs font-medium ${s.text}">
          <span class="w-2 h-2 rounded-full ${s.dot}"></span>${s.label}
        </span>
      </div>
      <div class="flex flex-wrap gap-4 text-xs text-slate-400">
        <span class="flex items-center gap-1.5">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 4v16M4 9h16"/></svg>
          ${inst.cpu ?? 0} vCPU
        </span>
        <span class="flex items-center gap-1.5">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="10" rx="2"/><circle cx="7" cy="12" r="1" fill="currentColor"/></svg>
          ${inst.ram ?? 0} GB
        </span>
        <span>Android ${inst.os ?? '—'}</span>
        <span>Uptime ${inst.vRuntime ?? '0h'}</span>
      </div>
      <div class="flex gap-2 mt-auto pt-2">
        <button class="connect-btn flex-1 px-3 py-2 rounded-lg text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50 disabled:cursor-not-allowed ${
          connectable
            ? 'bg-blue-600 hover:bg-blue-500 text-white'
            : 'bg-slate-800 text-slate-500 cursor-not-allowed'
        }" data-id="${inst.id}" ${connectable ? '' : 'disabled'}>
          ${inst.status === 'booting' ? 'Provisioning…' : connectable ? 'Connect' : 'Offline'}
        </button>
        <button class="power-btn px-3 py-2 rounded-lg text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50 disabled:cursor-not-allowed ${
          inst.status === 'offline'
            ? 'bg-emerald-600/15 hover:bg-emerald-600/25 text-emerald-400'
            : 'bg-red-600/15 hover:bg-red-600/25 text-red-400'
        }" data-id="${inst.id}" data-action="${inst.status === 'offline' ? 'start' : 'stop'}" aria-label="${inst.status === 'offline' ? 'Start instance' : 'Stop instance'}">
          ${inst.status === 'offline' ? 'Start' : 'Stop'}
        </button>
      </div>
    </article>`;
}
function renderInstances() {
  const grid = $('instance-grid');
  if (!grid) return;
  if (!state.instances.length) {
    grid.innerHTML = `
      <div class="glass-panel rounded-2xl p-10 text-center md:col-span-2 xl:col-span-3">
        <p class="text-slate-300 font-medium">No cloud phones yet</p>
        <p class="text-sm text-slate-500 mt-1">Provision your first Android instance to get started.</p>
      </div>`;
  } else {
    grid.innerHTML = state.instances.map(instanceCard).join('');
  }
  renderStats();
}
// ---------------------------------------------------------------------------
// API sync: fetch instances + stats
// ---------------------------------------------------------------------------
async function fetchInstances() {
  const grid = $('instance-grid');
  if (grid && !state.instances.length) {
    grid.innerHTML = Array.from({ length: 3 })
      .map(() => '<div class="skeleton glass-panel rounded-2xl p-6 h-44"></div>')
      .join('');
  }
  try {
    const data = await api(API.instances());
    state.instances = data.instances ?? [];
    renderInstances();
    try {
      const stats = await api('/api/status');
      if (stats?.stats) {
        $('stat-instances').textContent = String(stats.stats.active ?? 0);
        $('stat-cpu').textContent = String(stats.stats.vcpu ?? 0);
        $('stat-ram').textContent = String(stats.stats.ram ?? 0);
      }
    } catch (_) { /* stats optional; instance render already done */ }
  } catch (err) {
    console.error('[fetchInstances] failed:', err?.message ?? err);
    if (grid) {
      grid.innerHTML = `
        <div class="glass-panel rounded-2xl p-10 text-center md:col-span-2 xl:col-span-3">
          <p class="text-red-400 font-medium">Failed to load instances</p>
          <p class="text-sm text-slate-500 mt-1">${err?.message ?? 'Unknown error'}</p>
          <button id="retry-load" class="mt-4 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-colors">Retry</button>
        </div>`;
      $('retry-load')?.addEventListener('click', fetchInstances);
    }
    toast('Could not reach the Control Plane', 'error');
  }
}
// ---------------------------------------------------------------------------
// Provision & power
// ---------------------------------------------------------------------------
async function provision() {
  const btn = $('provision-btn');
  setBtnLoading(btn, true);
  setLoading(true);
  try {
    const data = await api(API.start(), {
      method: 'POST',
      body: JSON.stringify({ name: `Cloud Phone ${state.instances.length + 1}` }),
    });
    if (data?.instance) {
      state.instances.push(data.instance);
      renderInstances();
      toast(`Provisioned ${data.instance.id}`, 'success');
    }
    await fetchInstances();
  } catch (err) {
    console.error('[provision] failed:', err?.message ?? err);
    toast(err?.message ?? 'Provisioning failed', 'error');
  } finally {
    setBtnLoading(btn, false);
    setLoading(false);
  }
}
async function powerCycle(id, action) {
  if (state.pendingAction) return;
  state.pendingAction = true;
  const btn = document.querySelector(`.power-btn[data-id="${id}"]`);
  setBtnLoading(btn, true);
  try {
    const data = await api(API.power(), {
      method: 'POST',
      body: JSON.stringify({ id, action }),
    });
    if (data?.instance) {
      const idx = state.instances.findIndex((i) => i.id === id);
      if (idx >= 0) state.instances[idx] = data.instance;
      renderInstances();
      toast(
        action === 'stop' ? `${id} powered off` : `${id} is now online`,
        action === 'stop' ? 'error' : 'success'
      );
    }
    // Brief polling to confirm status settles on the backend
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      try {
        const s = await api(`/api/status?id=${encodeURIComponent(id)}`);
        if (s?.instance) {
          const idx = state.instances.findIndex((i) => i.id === id);
          if (idx >= 0) state.instances[idx] = s.instance;
          renderInstances();
        }
        if (attempts >= 3) clearInterval(poll);
      } catch (_) {
        clearInterval(poll);
      }
    }, 1200);
  } catch (err) {
    console.error('[powerCycle] failed:', err?.message ?? err);
    toast(err?.message ?? 'Power action failed', 'error');
  } finally {
    setBtnLoading(btn, false);
    state.pendingAction = false;
  }
}
// ---------------------------------------------------------------------------
// Live view: signaling + mock stream
// ---------------------------------------------------------------------------
function startStream() {
  const inst = state.instances.find((i) => i.status === 'online');
  const statusEl = $('stream-status');
  const textEl = $('stream-status-text');
  const deviceEl = $('session-device');
  const canvas = $('phone-canvas');
  if (!statusEl || !textEl || !deviceEl || !canvas) return;
  if (!inst) {
    textEl.textContent = 'No online device. Provision a phone first.';
    deviceEl.textContent = '—';
    canvas.classList.add('opacity-30');
    return;
  }
  state.activeSession = inst;
  deviceEl.textContent = `${inst.name ?? inst.id} · ${inst.id}`;
  textEl.textContent = 'Handshaking with signaling server…';
  canvas.classList.remove('opacity-30');
  drawMockCanvas(canvas);
  // Real signaling flow: exchange SDP offer → answer via the Control Plane
  signalExchange(inst.id)
    .then(() => {
      statusEl.classList.add('opacity-0', 'pointer-events-none');
      statusEl.style.transition = 'opacity 0.4s ease';
      setLiveIndicator(true);
      toast(`Connected to ${inst.name ?? inst.id}`, 'success');
    })
    .catch((err) => {
      console.error('[signalExchange] failed:', err?.message ?? err);
      textEl.textContent = 'Signaling failed. Use Reconnect to retry.';
      toast('Signaling handshake failed', 'error');
    });
}
async function signalExchange(sessionId) {
  try {
    const data = await api(API.signal(), {
      method: 'POST',
      body: JSON.stringify({ sessionId, type: 'offer', sdp: 'v=0\r\n' }),
    });
    if (!data?.answer?.sdp) throw new Error('Invalid signaling response');
    // ICE servers from the Control Plane are ready for the future RTCPeerConnection
    return data;
  } catch (err) {
    console.error('[signalExchange] error:', err?.message ?? err);
    throw err;
  }
}
function setLiveIndicator(live) {
  const el = $('live-indicator');
  if (!el) return;
  el.classList.toggle('bg-emerald-500', live);
  el.classList.toggle('bg-slate-500', !live);
  el.classList.toggle('pulse-dot', live);
}
function drawMockCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width, h = canvas.height;
  let t = 0;
  if (canvas._mockLoop) cancelAnimationFrame(canvas._mockLoop);
  const loop = () => {
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#0F172A');
    grad.addColorStop(1, '#1e3a5f');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 4; i++) {
      const x = w / 2 + Math.sin(t * 0.02 + i * 1.6) * w * 0.3;
      const y = h / 2 + Math.cos(t * 0.015 + i * 2.1) * h * 0.25;
      ctx.beginPath();
      ctx.arc(x, y, 24 + i * 10, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${i % 2 ? '59,130,246' : '16,185,129'},0.15)`;
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(226,232,240,0.85)';
    ctx.font = '600 16px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('AetherDroid Mock Stream', w / 2, h / 2);
    t++;
    canvas._mockLoop = requestAnimationFrame(loop);
  };
  loop();
}
// ---------------------------------------------------------------------------
// ADB Bridge: transmit input events to the Control Plane
// ---------------------------------------------------------------------------
const KEYCODES = {
  back: 4,
  home: 3,
  recents: 187,
  power: 26,
};
let latencySamples = [];
function updateLatencyDisplay(rttMs) {
  latencySamples.push(rttMs);
  if (latencySamples.length > 10) latencySamples.shift();
  const avg = latencySamples.reduce((a, b) => a + b, 0) / latencySamples.length;
  const el = $('latency-value');
  if (el) {
    el.textContent = `${Math.round(avg)}ms`;
    el.classList.toggle('text-emerald-400', avg < 120);
    el.classList.toggle('text-amber-400', avg >= 120);
  }
}
function sessionReady() {
  return Boolean(state.activeSession && state.activeSession.status === 'online');
}
async function sendInput(payload) {
  if (!sessionReady()) return;
  const started = performance.now();
  try {
    const data = await api(API.input(), {
      method: 'POST',
      body: JSON.stringify({
        sessionId: state.activeSession.id,
        seq: payload.seq,
        ts: payload.ts ?? Date.now(),
        ...payload,
      }),
    });
    // RTT minus server-reported processing time ≈ network latency
    const serverMs = Number(data?.processingMs) || 0;
    updateLatencyDisplay(Math.max(0, performance.now() - started - serverMs));
  } catch (err) {
    console.warn('[sendInput] failed:', err?.message ?? err);
  }
}
// ---------------------------------------------------------------------------
// APK install simulation
// ---------------------------------------------------------------------------
function setupApkInstall() {
  const drop = $('apk-drop');
  const input = $('apk-input');
  if (!drop || !input) return;
  function simulate(file) {
    const wrap = $('apk-progress');
    const bar = $('apk-bar');
    const pct = $('apk-pct');
    const name = $('apk-file-name');
    const status = $('apk-status-text');
    if (!wrap || !bar || !pct || !name || !status) return;
    wrap.classList.remove('hidden');
    name.textContent = file?.name ?? 'app.apk';
    let p = 0;
    const tick = setInterval(() => {
      p = Math.min(100, p + Math.random() * 18);
      bar.style.width = `${p}%`;
      pct.textContent = `${Math.round(p)}%`;
      if (p >= 100) {
        clearInterval(tick);
        status.textContent = 'Installing via ADB bridge…';
        setTimeout(() => {
          status.innerHTML = '<span class="text-emerald-400">Installed successfully</span>';
          toast('APK installed on device', 'success');
        }, 2000);
      } else {
        status.textContent = 'Uploading…';
      }
    }, 350);
  }
  input.addEventListener('change', () => {
    if (input.files?.length) simulate(input.files[0]);
  });
  ['dragover', 'dragenter'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('border-blue-500');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove('border-blue-500');
    })
  );
  drop.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file && file.name.endsWith('.apk')) simulate(file);
    else toast('Only .apk files are supported', 'error');
  });
}
// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function setup() {
  initInputHandler();
  document.querySelectorAll('.nav-btn').forEach((btn) =>
    btn.addEventListener('click', () => switchView(btn.getAttribute('data-view')))
  );
  const sidebar = $('sidebar');
  const backdrop = $('sidebar-backdrop');
  $('menu-btn')?.addEventListener('click', () => {
    sidebar?.classList.toggle('-translate-x-full');
    backdrop?.classList.toggle('hidden');
  });
  backdrop?.addEventListener('click', () => {
    sidebar?.classList.add('-translate-x-full');
    backdrop?.classList.add('hidden');
  });
  $('provision-btn')?.addEventListener('click', provision);
  $('refresh-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setBtnLoading(btn, true);
    await fetchInstances();
    setBtnLoading(btn, false);
    toast('Synced with Control Plane');
  });
  $('instance-grid')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    if (btn.classList.contains('connect-btn')) {
      switchView('phone');
    } else if (btn.classList.contains('power-btn')) {
      powerCycle(id, btn.getAttribute('data-action'));
    }
  });
  $('reconnect-btn')?.addEventListener('click', () => {
    const statusEl = $('stream-status');
    statusEl?.classList.remove('opacity-0', 'pointer-events-none');
    startStream();
  });
  $('end-session-btn')?.addEventListener('click', () => {
    state.activeSession = null;
    latencySamples = [];
    setLiveIndicator(false);
    if ($('latency-value')) $('latency-value').textContent = '--ms';
    const statusEl = $('stream-status');
    statusEl?.classList.remove('opacity-0', 'pointer-events-none');
    if ($('stream-status-text')) $('stream-status-text').textContent = 'Session ended.';
    if ($('session-device')) $('session-device').textContent = '—';
    toast('Session ended');
  });
  // --- ADB bridge: touch input ---
  onInput((p) => {
    if (!sessionReady()) return;
    sendInput({ kind: 'touch', type: p.type, x: p.x, y: p.y, seq: p.seq, ts: p.ts });
  });
  // --- ADB bridge: hardware keys ---
  onHardwareKey((p) => {
    if (!sessionReady()) {
      toast('No active device session', 'error');
      return;
    }
    sendInput({ kind: 'key', key: p.key, keycode: KEYCODES[p.key] ?? null });
  });
  // --- Keyboard capture toggle ---
  const kbBtn = $('keyboard-toggle');
  kbBtn?.addEventListener('click', () => {
    state.keyboardCapture = !state.keyboardCapture;
    kbBtn.setAttribute('aria-pressed', String(state.keyboardCapture));
    kbBtn.classList.toggle('bg-blue-600', state.keyboardCapture);
    kbBtn.classList.toggle('text-white', state.keyboardCapture);
    kbBtn.classList.toggle('bg-slate-800', !state.keyboardCapture);
    kbBtn.classList.toggle('text-slate-400', !state.keyboardCapture);
    toast(state.keyboardCapture
      ? 'Keyboard capture on — physical keys route to device'
      : 'Keyboard capture off', 'info');
  });
  document.addEventListener('keydown', (e) => {
    if (!state.keyboardCapture || !sessionReady()) return;
    if (e.target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if (emitKeyboard(e)) e.preventDefault();
  });
  setupApkInstall();
  fetchInstances();
  const clock = $('clock');
  const updateClock = () => {
    if (clock) clock.textContent = new Date().toLocaleTimeString();
  };
  updateClock();
  setInterval(updateClock, 1000);
}
if (document.readyState !== 'loading') setup();
else document.addEventListener('DOMContentLoaded', setup);