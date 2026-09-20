/**
 * AetherDroid — Input Handler
 * Translates browser mouse/touch events on the Android canvas into
 * standardized percentage-based coordinate payloads (0.0 → 1.0),
 * with move-event throttling (~30ms), monotonic sequencing, and
 * local visual touch feedback for low-perceived-latency interaction.
 */
const CANVAS_ID = 'phone-canvas';
const DEBUG_ID = 'coord-debug';
const MOVE_THROTTLE_MS = 30;
const listeners = {
  onTouch: null,
  onKey: null,
};
let seq = 0;
/**
 * Register a callback that receives normalized input payloads.
 * payload: { type: 'down'|'move'|'up', x: 0..1, y: 0..1, seq, ts }
 */
export function onInput(callback) {
  listeners.onTouch = typeof callback === 'function' ? callback : listeners.onTouch;
}
export function onHardwareKey(callback) {
  listeners.onKey = typeof callback === 'function' ? callback : listeners.onKey;
}
/** Normalize a client point into canvas-relative percentage coords (bounds-checked). */
export function normalizePoint(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return { x: 0, y: 0 };
  let x = (clientX - rect.left) / rect.width;
  let y = (clientY - rect.top) / rect.height;
  // Clamp to 0.0 – 1.0
  x = Math.min(1, Math.max(0, x));
  y = Math.min(1, Math.max(0, y));
  return { x, y };
}
// ---------------------------------------------------------------------------
// Local touch feedback ring (pure visual, appended to the phone frame)
// ---------------------------------------------------------------------------
let feedbackEl = null;
let feedbackTimer = null;
function showTouchFeedback(canvas, x, y) {
  const frame = canvas.parentElement;
  if (!frame) return;
  if (!feedbackEl) {
    feedbackEl = document.createElement('div');
    feedbackEl.className =
      'pointer-events-none absolute w-8 h-8 -ml-4 -mt-4 rounded-full border-2 border-blue-400/80 bg-blue-400/20 opacity-0 transition-opacity duration-150 z-10';
    frame.appendChild(feedbackEl);
  }
  feedbackEl.style.left = `${x * 100}%`;
  feedbackEl.style.top = `${y * 100}%`;
  feedbackEl.classList.remove('opacity-0');
  feedbackEl.classList.add('opacity-100');
  if (feedbackTimer) clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => {
    feedbackEl?.classList.remove('opacity-100');
    feedbackEl?.classList.add('opacity-0');
  }, 350);
}
// ---------------------------------------------------------------------------
// Event emission with ordering + throttling
// ---------------------------------------------------------------------------
function emit(type, canvas, clientX, clientY, force = false) {
  const now = performance.now();
  // Throttle 'move' events to ~30ms to avoid flooding the bridge
  if (type === 'move' && !force) {
    if (emit._lastMove && now - emit._lastMove < MOVE_THROTTLE_MS) return;
    emit._lastMove = now;
  }
  const { x, y } = normalizePoint(canvas, clientX, clientY);
  const debugEl = document.getElementById(DEBUG_ID);
  if (debugEl) {
    debugEl.textContent = `${x.toFixed(3)}, ${y.toFixed(3)}`;
  }
  if (type === 'down' || type === 'move') {
    showTouchFeedback(canvas, x, y);
  }
  if (typeof listeners.onTouch === 'function') {
    listeners.onTouch({ type, x, y, seq: ++seq, ts: Date.now() });
  }
}
/**
 * Forward a physical keyboard event (when keyboard capture is active).
 * Returns true if the event was consumed.
 */
export function emitKeyboard(e) {
  let key = e.key ?? '';
  if (key === ' ') key = 'space';
  if (key === 'Enter') key = 'enter';
  if (key === 'Backspace') key = 'del';
  if (key.length !== 1 && !['space', 'enter', 'del', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) {
    return false;
  }
  if (typeof listeners.onKey === 'function') {
    listeners.onKey({ key });
    return true;
  }
  return false;
}
export function initInputHandler() {
  const canvas = document.getElementById(CANVAS_ID);
  if (!canvas) {
    console.warn('[input-handler] canvas not found, input capture disabled');
    return;
  }
  let pointerActive = false;
  // --- Pointer events (covers mouse + touch + pen) ---
  canvas.addEventListener('pointerdown', (e) => {
    pointerActive = true;
    canvas.setPointerCapture(e.pointerId);
    emit('down', canvas, e.clientX, e.clientY, true);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (pointerActive) emit('move', canvas, e.clientX, e.clientY);
  });
  const release = (e) => {
    if (!pointerActive) return;
    pointerActive = false;
    emit('up', canvas, e.clientX, e.clientY, true);
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  // Prevent context menu on long-press / right-click over the device screen
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // --- Hardware key buttons ---
  document.querySelectorAll('.hw-key').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-key');
      if (typeof listeners.onKey === 'function') {
        listeners.onKey({ key });
      }
    });
  });
}
// Auto-init when loaded as a module
if (document.readyState !== 'loading') {
  initInputHandler();
} else {
  document.addEventListener('DOMContentLoaded', initInputHandler);
}