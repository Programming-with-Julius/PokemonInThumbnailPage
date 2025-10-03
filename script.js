(() => {
  // --- Config ---
  const TILE_SIZE = 16; // source image tile width/height in pixels
  const ZOOM_MIN = 0.1;
  const ZOOM_MAX = 8;

  // --- DOM ---
  const viewport = document.getElementById('viewport');
  const stage = document.getElementById('stage');
  const mapImg = document.getElementById('map');
  const markers = document.getElementById('markers');

  const topBar = document.getElementById('topBar');
  const rightBar = document.getElementById('rightBar');
  const bottomBar = document.getElementById('bottomBar');

  const zoomButtons = Array.from(document.querySelectorAll('.zoom-btn'));
  const cmdOutput = document.getElementById('cmdOutput');
  const copyBtn = document.getElementById('copyBtn');

  // --- State ---
  let imgW = 0, imgH = 0;
  let scale = 1;          // world->screen scale
  let panX = 0, panY = 0; // screen translation (in CSS pixels)
  let fitScale = 1;
  let zoomMode = 'fit';   // 'fit' or 'abs'

  // Interaction state
  const pointers = new Map(); // pointerId -> {x,y,type}
  let isPanning = false;
  let panLastX = 0, panLastY = 0;

  let isPinching = false;
  let pinchStartDist = 0;
  let pinchStartScale = 1;
  let pinchMidWorld = { x: 0, y: 0 };

  let isPathDrawing = false;
  let pathTiles = [];            // [{x,y}]
  let pathDirections = [];       // ["right", "up", ...]
  let lastTile = null;

  // --- Helpers ---
  function applyTransform() {
    stage.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  }

  function contentRect() {
    // Area not covered by fixed bars (so "fit" feels right)
    const t = topBar.getBoundingClientRect().height;
    const r = rightBar.getBoundingClientRect().width + 8; // + margin
    const b = bottomBar.getBoundingClientRect().height;
    return {
      x: 0,
      y: t,
      w: window.innerWidth - r,
      h: window.innerHeight - t - b
    };
  }

  function computeFitAndCenter() {
    const rect = contentRect();
    fitScale = Math.min(rect.w / imgW, rect.h / imgH);
    // center image within rect
    scale = fitScale;
    const drawnW = imgW * scale;
    const drawnH = imgH * scale;
    panX = rect.x + (rect.w - drawnW) / 2;
    panY = rect.y + (rect.h - drawnH) / 2;
    applyTransform();
  }

  function setZoomButtonActive(which) {
    zoomButtons.forEach(btn => {
      const m = btn.dataset.zoom;
      btn.classList.toggle('active', (which === m));
    });
  }

  function setZoom(mode) {
    // mode: 'fit' | '1' | '5' (string)
    const rect = contentRect();
    const midScreen = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    const midWorld = screenToWorld(midScreen.x, midScreen.y);

    if (mode === 'fit') {
      zoomMode = 'fit';
      computeFitAndCenter();
    } else {
      zoomMode = 'abs';
      let targetScale = Number(mode);
      targetScale = clamp(targetScale, ZOOM_MIN, ZOOM_MAX);
      // keep midWorld anchored to rect center
      scale = targetScale;
      panX = midScreen.x - scale * midWorld.x;
      panY = midScreen.y - scale * midWorld.y;
      applyTransform();
    }
    setZoomButtonActive(mode);
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function screenToWorld(sx, sy) {
    return { x: (sx - panX) / scale, y: (sy - panY) / scale };
  }

  function worldToTile(wx, wy) {
    return { x: Math.floor(wx / TILE_SIZE), y: Math.floor(wy / TILE_SIZE) };
  }

  function withinImage(wx, wy) {
    return wx >= 0 && wy >= 0 && wx <= imgW && wy <= imgH;
  }

  function clearPath() {
    markers.innerHTML = '';
    pathTiles = [];
    pathDirections = [];
    lastTile = null;
    cmdOutput.value = '';
  }

  function addMarker(tile, isFirst=false) {
    const d = document.createElement('div');
    d.className = 'tile' + (isFirst ? ' first' : '');
    d.style.left = `${tile.x * TILE_SIZE}px`;
    d.style.top = `${tile.y * TILE_SIZE}px`;
    markers.appendChild(d);
  }

  function dirFromStep(dx, dy) {
    if (dx === 1 && dy === 0) return 'right';
    if (dx === -1 && dy === 0) return 'left';
    if (dx === 0 && dy === 1) return 'down';
    if (dx === 0 && dy === -1) return 'up';
    return null;
  }

  function extendPathTo(targetTile) {
    if (!lastTile) return;
    let cx = lastTile.x, cy = lastTile.y;
    const dxTotal = targetTile.x - cx;
    const dyTotal = targetTile.y - cy;

    // Step one tile at a time, favoring the axis with larger remaining delta
    while (cx !== targetTile.x || cy !== targetTile.y) {
      const remX = targetTile.x - cx;
      const remY = targetTile.y - cy;
      let stepX = 0, stepY = 0;

      if (Math.abs(remX) >= Math.abs(remY)) {
        stepX = Math.sign(remX);
      } else {
        stepY = Math.sign(remY);
      }

      cx += stepX;
      cy += stepY;

      const stepDir = dirFromStep(stepX, stepY);
      if (stepDir) {
        pathDirections.push(stepDir);
        const newTile = { x: cx, y: cy };
        pathTiles.push(newTile);
        addMarker(newTile, false);
      }
    }
    lastTile = { x: cx, y: cy };
    cmdOutput.value = pathDirections.join(' ');
  }

  function startPathAtScreen(sx, sy) {
    const w = screenToWorld(sx, sy);
    if (!withinImage(w.x, w.y)) return;

    clearPath();

    const t = worldToTile(w.x, w.y);
    lastTile = { ...t };
    pathTiles.push(lastTile);
    addMarker(lastTile, true);
    isPathDrawing = true;
  }

  function movePathAtScreen(sx, sy, opts = {}) {
    if (!isPathDrawing) return;
    const w = screenToWorld(sx, sy);
    if (!withinImage(w.x, w.y)) return;
    const t = worldToTile(w.x, w.y);

    // Only extend when we enter a new tile
    if (!lastTile || t.x !== lastTile.x || t.y !== lastTile.y) {
      extendPathTo(t);
    }

    // If this is desktop and CTRL was released, finish the path
    if (opts.pointerType === 'mouse' && opts.ctrlKey === false) {
      endPath();
    }
  }

  function endPath() {
    isPathDrawing = false;
  }

  // --- Pointer / gesture handling (Pointer Events) ---

  function onPointerDown(e) {
    viewport.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });

    if (e.pointerType === 'mouse') {
      if (e.button !== 0) return; // left only
      if (e.ctrlKey) {
        startPathAtScreen(e.clientX, e.clientY);
      } else {
        // start panning
        isPanning = true;
        panLastX = e.clientX;
        panLastY = e.clientY;
      }
      return;
    }

    // Touch logic
    if (e.pointerType === 'touch') {
      if (pointers.size === 1) {
        // Single-finger: path draw
        const p = [...pointers.values()][0];
        startPathAtScreen(p.x, p.y);
      } else if (pointers.size === 2) {
        // Two-finger pinch start (only when not drawing)
        if (isPathDrawing) return; // keep drawing if already started with 1 finger
        isPinching = true;
        const [a, b] = getTwoPointers();
        pinchStartDist = dist(a, b);
        pinchStartScale = scale;
        const mid = midpoint(a, b);
        pinchMidWorld = screenToWorld(mid.x, mid.y);
      }
    }
  }

  function onPointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });

    // Pinch zoom (touch)
    if (isPinching && pointers.size >= 2) {
      const [a, b] = getTwoPointers();
      const newDist = dist(a, b);
      if (pinchStartDist > 0) {
        const factor = newDist / pinchStartDist;
        const targetScale = clamp(pinchStartScale * factor, ZOOM_MIN, ZOOM_MAX);
        const mid = midpoint(a, b);
        // keep pinchMidWorld anchored to current midpoint
        scale = targetScale;
        panX = mid.x - scale * pinchMidWorld.x;
        panY = mid.y - scale * pinchMidWorld.y;
        zoomMode = 'abs';
        setZoomButtonActive(null); // none active
        applyTransform();
      }
      return;
    }

    // Mouse panning
    if (isPanning && e.pointerType === 'mouse') {
      const dx = e.clientX - panLastX;
      const dy = e.clientY - panLastY;
      panX += dx;
      panY += dy;
      panLastX = e.clientX;
      panLastY = e.clientY;
      applyTransform();
      return;
    }

    // Path drawing (mouse ctrl-drag or single-finger drag)
    if (isPathDrawing) {
      movePathAtScreen(e.clientX, e.clientY, { pointerType: e.pointerType, ctrlKey: e.ctrlKey });
    }
  }

  function onPointerUp(e) {
    if (pointers.has(e.pointerId)) {
      viewport.releasePointerCapture(e.pointerId);
      pointers.delete(e.pointerId);
    }

    if (e.pointerType === 'mouse') {
      isPanning = false;
      if (isPathDrawing) endPath();
      return;
    }

    if (e.pointerType === 'touch') {
      if (pointers.size < 2) {
        isPinching = false;
      }
      if (pointers.size === 0 && isPathDrawing) {
        endPath();
      }
    }
  }

  function dist(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.hypot(dx, dy);
  }
  function midpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  function getTwoPointers() {
    const arr = [...pointers.values()];
    return [arr[0], arr[1]];
  }

  // --- Events: zoom buttons, copy, resize ---
  zoomButtons.forEach(btn => {
    btn.addEventListener('click', () => setZoom(btn.dataset.zoom));
  });

  copyBtn.addEventListener('click', async () => {
    const txt = cmdOutput.value;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(txt);
      } else {
        // Fallback
        const ta = document.createElement('textarea');
        ta.value = txt;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      // visual feedback
      const i = copyBtn.querySelector('i');
      i.classList.remove('bi-clipboard');
      i.classList.add('bi-check2');
      setTimeout(() => {
        i.classList.remove('bi-check2');
        i.classList.add('bi-clipboard');
      }, 1000);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  });

  window.addEventListener('resize', () => {
    if (zoomMode === 'fit') {
      computeFitAndCenter();
      setZoomButtonActive('fit');
    } else {
      // keep center point stable when resizing
      const rect = contentRect();
      const midScreen = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
      const midWorld = screenToWorld(midScreen.x, midScreen.y);
      panX = midScreen.x - scale * midWorld.x;
      panY = midScreen.y - scale * midWorld.y;
      applyTransform();
    }
  });

  // --- Init once image is ready ---
  function initAfterImage() {
    imgW = mapImg.naturalWidth;
    imgH = mapImg.naturalHeight;

    // Stage & markers base size (world units)
    stage.style.width = `${imgW}px`;
    stage.style.height = `${imgH}px`;
    markers.style.width = `${imgW}px`;
    markers.style.height = `${imgH}px`;

    computeFitAndCenter();
    setZoomButtonActive('fit');

    // Pointer events
    viewport.addEventListener('pointerdown', onPointerDown, { passive: false });
    viewport.addEventListener('pointermove', onPointerMove, { passive: false });
    viewport.addEventListener('pointerup', onPointerUp, { passive: false });
    viewport.addEventListener('pointercancel', onPointerUp, { passive: false });
    viewport.addEventListener('lostpointercapture', onPointerUp, { passive: false });

    // Prevent context menu on long-press/right-click (helps mobile drawing)
    viewport.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  if (mapImg.complete) {
    initAfterImage();
  } else {
    mapImg.addEventListener('load', initAfterImage, { once: true });
    mapImg.addEventListener('error', () => {
      console.error('Failed to load the map image.');
    }, { once: true });
  }
})();
