(() => {
  // ----- Constants -----
  // Real image is 7200x7200 (1x). We tiled a 2x upscale -> 14400x14400.
  const IMG_W1 = 7200, IMG_H1 = 7200;
  const UPSCALE = 2;
  const IMG_W2 = IMG_W1 * UPSCALE, IMG_H2 = IMG_H1 * UPSCALE;

  // Real in-game tile = 16px at 1x => 32px at our 2x tiles
  const TILE_1X = 16;
  const TILE_2X = TILE_1X * UPSCALE; // 32

  const MAX_ZOOM = 5; // we built tiles for z=0..5
  const TILE_URL = './kanto_tiles_512/{z}/{x}/{y}.png'; // adjust if hosted elsewhere

  // UI refs
  const helpHint = document.getElementById('helpHint');
  const cmdOutput = document.getElementById('cmdOutput');
  const copyBtn = document.getElementById('copyBtn');
  const zoomButtons = Array.from(document.querySelectorAll('.zoom-btn'));
  const overlay = document.getElementById('overlay');

  // ----- Leaflet map -----
  const map = L.map('map', {
    crs: L.CRS.Simple,
    minZoom: 0,
    maxZoom: MAX_ZOOM,
    zoomSnap: 1,
    zoomDelta: 1,
    wheelPxPerZoomLevel: 120,
    inertia: true,
    zoomControl: false
  });

  // define image bounds in pixels (2x space) -> latlng
  const southWest = map.unproject([0, IMG_H2], MAX_ZOOM);
  const northEast = map.unproject([IMG_W2, 0], MAX_ZOOM);
  const bounds = L.latLngBounds(southWest, northEast);
  map.setMaxBounds(bounds);
  map.fitBounds(bounds);

  // tiles
  L.tileLayer(TILE_URL, {
    tileSize: 512,
    noWrap: true,
    minZoom: 0, maxZoom: MAX_ZOOM,
    bounds
  }).addTo(map);

  // overlay sizing follows map container
  const resizeOverlay = () => {
    const r = map.getContainer().getBoundingClientRect();
    overlay.setAttribute('width', r.width);
    overlay.setAttribute('height', r.height);
  };
  resizeOverlay();
  map.on('resize zoom move', () => requestAnimationFrame(resizeOverlay));

  // ----- Path state -----
  let pathTiles = [];      // [{x,y}] in 1x tile coordinates (16px grid)
  let pathDirections = []; // ["right","up",...]
  let lastTile = null;

  // Interaction state (Pointer Events)
  const pointers = new Map(); // id -> {type}
  let drawingPointerId = null;
  let isPathDrawing = false;
  let drawCandidate = null;
  const DRAW_DELAY_MS = 120;
  const DRAW_MOVE_THRESHOLD = 8; // px

  // ----- Helpers -----
  const setHint = () => {
    const isTouch =
      (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
      (navigator.maxTouchPoints && navigator.maxTouchPoints > 0);
    helpHint.textContent = isTouch
      ? '1 finger: draw path • 2 fingers: pan & pinch-zoom • Zoom: Fit / Z2 / Z4 / Z5 →'
      : 'Ctrl+drag: draw path • Drag: pan • Zoom: Fit / Z2 / Z4 / Z5 →';
  };
  setHint();
  window.addEventListener('resize', setHint);

  function setZoomButtonActive(which) {
    zoomButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.zoom === which));
  }

  function setZoom(mode) {
    if (mode === 'fit') {
      map.fitBounds(bounds);
      setZoomButtonActive('fit');
    } else {
      const z = Number(mode);
      map.setZoom(z);
      setZoomButtonActive(mode);
    }
  }
  zoomButtons.forEach(btn => btn.addEventListener('click', () => setZoom(btn.dataset.zoom)));
  setZoomButtonActive('fit');

  function dirFromStep(dx, dy) {
    if (dx === 1 && dy === 0) return 'right';
    if (dx === -1 && dy === 0) return 'left';
    if (dx === 0 && dy === 1) return 'down';
    if (dx === 0 && dy === -1) return 'up';
    return null;
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // Convert DOM mouse/touch event to 2x pixel point inside the image
  function eventToWorld2x(e) {
    // Leaflet supplies e.latlng for map container events; if missing, compute from screen point
    let latlng = e.latlng;
    if (!latlng && e.clientX != null) {
      latlng = map.mouseEventToLatLng(e);
    }
    const p2 = map.project(latlng, MAX_ZOOM); // point in 2x pixels at max zoom
    return { x: p2.x, y: p2.y };
  }

  function world2xToTile1x(wx2, wy2) {
    // convert 2x pixel coords to 1x tile indices
    const x = Math.floor((wx2 / UPSCALE) / TILE_1X); // == Math.floor(wx2 / TILE_2X)
    const y = Math.floor((wy2 / UPSCALE) / TILE_1X);
    return { x, y };
  }

  function tile1xToBoundsLatLng(t) {
    // return Leaflet LatLngBounds for drawing rectangle covering this tile (in 2x pixels)
    const left2 = t.x * TILE_2X;
    const top2  = t.y * TILE_2X;
    const right2 = left2 + TILE_2X;
    const bottom2 = top2 + TILE_2X;
    const nw = map.unproject([left2, top2], MAX_ZOOM);
    const se = map.unproject([right2, bottom2], MAX_ZOOM);
    return L.latLngBounds(nw, se);
  }

  function withinImage2x(wx2, wy2) {
    return wx2 >= 0 && wy2 >= 0 && wx2 <= IMG_W2 && wy2 <= IMG_H2;
  }

  // ----- Drawing (SVG overlay) -----
  function clearPath() {
    pathTiles = [];
    pathDirections = [];
    lastTile = null;
    cmdOutput.value = '';
    overlay.innerHTML = '';
  }

  function addRectForTile(t, isFirst = false) {
    // compute rectangle in screen space each time (so it follows pan/zoom)
    // We'll store a tag with tile coords; on move/zoom we'll re-render all (lightweight).
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    const b = tile1xToBoundsLatLng(t);
    // Convert LatLngBounds corners to container pixels
    const p1 = map.latLngToContainerPoint(b.getNorthWest());
    const p2 = map.latLngToContainerPoint(b.getSouthEast());
    g.setAttribute('x', String(p1.x));
    g.setAttribute('y', String(p1.y));
    g.setAttribute('width', String(p2.x - p1.x));
    g.setAttribute('height', String(p2.y - p1.y));
    g.setAttribute('class', 'tile' + (isFirst ? ' first' : ''));
    overlay.appendChild(g);
  }

  function rerenderOverlay() {
    overlay.innerHTML = '';
    for (let i = 0; i < pathTiles.length; i++) {
      addRectForTile(pathTiles[i], i === 0);
    }
  }

  map.on('zoom move', () => requestAnimationFrame(rerenderOverlay));

  function extendPathTo(targetTile) {
    if (!lastTile) return;
    let cx = lastTile.x, cy = lastTile.y;

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
      }
    }
    lastTile = { x: cx, y: cy };
    cmdOutput.value = pathDirections.join(' ');
    rerenderOverlay();
  }

  function startPathAtEvent(e) {
    const w = eventToWorld2x(e);
    if (!withinImage2x(w.x, w.y)) return;

    clearPath();

    const t = world2xToTile1x(w.x, w.y);
    lastTile = { ...t };
    pathTiles.push(lastTile);
    rerenderOverlay();
    isPathDrawing = true;
  }

  function movePathAtEvent(e) {
    if (!isPathDrawing) return;
    const w = eventToWorld2x(e);
    if (!withinImage2x(w.x, w.y)) return;
    const t = world2xToTile1x(w.x, w.y);

    if (!lastTile || t.x !== lastTile.x || t.y !== lastTile.y) {
      extendPathTo(t);
    }
  }

  function endPath() {
    isPathDrawing = false;
    drawingPointerId = null;
  }

  // ----- Touch gating like your original -----
  function cancelTouchCandidate() {
    if (drawCandidate && drawCandidate.timer) clearTimeout(drawCandidate.timer);
    drawCandidate = null;
  }

  function tryStartCandidateIfMoved(e) {
    if (!drawCandidate || e.pointerId !== drawCandidate.id) return;
    const dx = e.clientX - drawCandidate.x;
    const dy = e.clientY - drawCandidate.y;
    if (Math.hypot(dx, dy) >= DRAW_MOVE_THRESHOLD && pointers.size === 1) {
      cancelTouchCandidate();
      drawingPointerId = e.pointerId;
      startPathAtEvent(e);
      map.dragging.disable(); // prevent map panning while drawing
    }
  }

  // ----- Pointer handlers on the map container -----
  const container = map.getContainer();

  container.addEventListener('pointerdown', (e) => {
    // Let Leaflet do its thing unless we're starting a draw
    pointers.set(e.pointerId, { type: e.pointerType });

    if (e.pointerType === 'mouse') {
      if (e.button !== 0) return;
      if (e.ctrlKey) {
        L.DomEvent.stop(e);
        startPathAtEvent(e);
        isPathDrawing = true;
      }
      return;
    }

    if (e.pointerType === 'touch') {
      if (pointers.size === 2) {
        // pinch intent: cancel any pending draw
        cancelTouchCandidate();
        if (isPathDrawing) { endPath(); }
        return;
      }
      if (pointers.size === 1) {
        // start a candidate (delay to allow second finger to join)
        const id = e.pointerId;
        cancelTouchCandidate();
        drawCandidate = {
          id,
          x: e.clientX,
          y: e.clientY,
          timer: setTimeout(() => {
            if (pointers.size === 1) {
              drawingPointerId = id;
              startPathAtEvent(e);
              map.dragging.disable();
            }
            cancelTouchCandidate();
          }, DRAW_DELAY_MS)
        };
      }
    }
  }, { passive: false });

  container.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;

    if (e.pointerType === 'mouse') {
      if (isPathDrawing) {
        L.DomEvent.stop(e);
        movePathAtEvent(e);
      }
      return;
    }

    if (e.pointerType === 'touch') {
      // If it's a one-finger candidate, movement may start drawing
      tryStartCandidateIfMoved(e);
      if (isPathDrawing && e.pointerId === drawingPointerId) {
        movePathAtEvent(e);
      }
    }
  }, { passive: false });

  function finishPointer(e) {
    if (pointers.has(e.pointerId)) pointers.delete(e.pointerId);

    if (e.pointerType === 'mouse') {
      if (isPathDrawing) { endPath(); }
      return;
    }

    if (e.pointerType === 'touch') {
      if (drawCandidate && e.pointerId === drawCandidate.id) cancelTouchCandidate();
      if (isPathDrawing && e.pointerId === drawingPointerId) {
        endPath();
        map.dragging.enable();
      }
    }
  }
  container.addEventListener('pointerup', finishPointer, { passive: false });
  container.addEventListener('pointercancel', finishPointer, { passive: false });
  container.addEventListener('lostpointercapture', finishPointer, { passive: false });

  // Prevent native context menus from fighting with drawing UX
  container.addEventListener('contextmenu', (e) => e.preventDefault());

  // ----- Copy button -----
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(cmdOutput.value);
      const i = copyBtn.querySelector('i');
      i.classList.remove('bi-clipboard'); i.classList.add('bi-check2');
      setTimeout(() => { i.classList.remove('bi-check2'); i.classList.add('bi-clipboard'); }, 1000);
    } catch (err) {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = cmdOutput.value; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    }
  });
})();
