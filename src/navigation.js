// Pointer capture keeps a drag attached to the map outside its bounds. Every interruption has
// the same cleanup path, including a release that happened while the window was unfocused.
export function installNavigation(canvas, { getTransform, setTransform, start, end, minScale = 0.2, maxScale = 24 }) {
  const pointers = new Map();
  let anchor = null;
  let moved = false;
  let suppressClick = false;

  function rebase() {
    const [a, b] = pointers.values();
    anchor = a ? {
      transform: getTransform(),
      x: b ? (a.x + b.x) / 2 : a.x,
      y: b ? (a.y + b.y) / 2 : a.y,
      distance: b ? Math.hypot(b.x - a.x, b.y - a.y) : 0,
    } : null;
  }

  function release(id) {
    pointers.delete(id);
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  }

  function cancel() {
    if (!pointers.size) return;
    suppressClick = true;
    for (const id of [...pointers.keys()]) release(id);
    anchor = null;
    end();
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || (event.pointerType === 'mouse' && event.ctrlKey)) return;
    // A new mouse press also recovers from a release lost by the browser/OS.
    if (event.pointerType === 'mouse' && pointers.size) cancel();
    if (!pointers.size) {
      moved = suppressClick = false;
      start();
    } else moved = suppressClick = true; // a pinch must never set the starting point
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    canvas.setPointerCapture(event.pointerId);
    rebase();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    if (event.pointerType !== 'touch' && !(event.buttons & 1)) { cancel(); return; }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const [a, b] = pointers.values();
    const x = b ? (a.x + b.x) / 2 : a.x;
    const y = b ? (a.y + b.y) / 2 : a.y;
    if (!moved && Math.hypot(x - anchor.x, y - anchor.y) <= 5) return;
    moved = suppressClick = true;
    const t = anchor.transform;
    const k = b && anchor.distance > 0
      ? Math.max(minScale, Math.min(maxScale, t.k * Math.hypot(b.x - a.x, b.y - a.y) / anchor.distance)) : t.k;
    setTransform({ k, x: x - (anchor.x - t.x) * k / t.k, y: y - (anchor.y - t.y) * k / t.k });
  });

  canvas.addEventListener('pointerup', (event) => {
    if (!pointers.has(event.pointerId)) return;
    release(event.pointerId);
    rebase(); // lifting one finger continues the pan without jumping
    if (!pointers.size) end();
  });
  canvas.addEventListener('pointercancel', cancel);
  canvas.addEventListener('lostpointercapture', (event) => {
    if (pointers.has(event.pointerId)) cancel();
  });
  window.addEventListener('blur', cancel);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  canvas.addEventListener('click', (event) => {
    if (!suppressClick || event.detail === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressClick = false;
  }, true);
  return { get active() { return pointers.size > 0; }, cancel };
}
