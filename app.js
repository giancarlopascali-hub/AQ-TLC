// ── Configuration & State ──────────────────────────────────────────────────
const state = {
  imgEl: null, imgB64: null, imgW: 0, imgH: 0,
  imageRotation: 0,
  lines: [], spottingMarks: [], lanes: [],
  activeTool: 'pan', view: { zoom: 1, dx: 0, dy: 0 },
  dragStart: null, mStart: { x: 0, y: 0 }, viewStart: { dx: 0, dy: 0 },
  activeLine: null, activeLane: null, activeMark: null,
  isPanning: false, isRotating: false, rotateStart: 0,
  editingField: null,
  undoStack: []
};

const $ = id => document.getElementById(id);

// ── Rendering ──────────────────────────────────────────────────────────────
function render() {
  const canvas = $('canvas-main'); if (!state.imgEl || !canvas) return;
  const wrap = canvas.parentElement; canvas.width = wrap.clientWidth; canvas.height = wrap.clientHeight;
  const ctx = canvas.getContext('2d');
  
  // Update Lane Counter Badge
  if ($('lane-count-badge')) {
    $('lane-count-badge').textContent = `${state.lanes.length} Lanes`;
  }

  ctx.save(); ctx.translate(state.view.dx, state.view.dy); ctx.scale(state.view.zoom, state.view.zoom);

  const drawW = canvas.width; const sx = drawW / state.imgW; const sy = sx;
  const drawH = state.imgH * sy;

  ctx.save();
  ctx.translate((state.imgW*sx)/2, (state.imgH*sy)/2); ctx.rotate(state.imageRotation);
  ctx.drawImage(state.imgEl, -(state.imgW*sx)/2, -(state.imgH*sy)/2, drawW, drawH);
  ctx.translate(-(state.imgW*sx)/2, -(state.imgH*sy)/2);

  // Spotting Marks
  state.spottingMarks.forEach(m => {
    const isS = state.activeMark === m;
    ctx.fillStyle = isS ? '#ffc107' : '#58a6ff'; ctx.beginPath(); ctx.arc(m.x*sx, m.y*sy, 6/state.view.zoom, 0, 2*Math.PI); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1/state.view.zoom; ctx.stroke();
  });

  // Lines (Origin/Front)
  state.lines.forEach(l => {
    const isS = state.activeLine === l;
    ctx.save(); ctx.translate(l.cx*sx, l.cy*sy); ctx.rotate(l.angle || 0);
    ctx.strokeStyle = isS ? '#ffc107' : '#238636'; if (l.cy > state.imgH*0.5) ctx.strokeStyle = isS ? '#ffc107' : '#f0883e';
    ctx.lineWidth = 4/state.view.zoom; ctx.beginPath(); ctx.moveTo(-l.w*sx/2, 0); ctx.lineTo(l.w*sx/2, 0); ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle; ctx.font = `bold ${12/state.view.zoom}px Inter`;
    ctx.fillText(l.cy > state.imgH*0.5 ? "ORIGIN" : "FRONT", -l.w*sx/2, -8/state.view.zoom);
    ctx.restore();
  });

  // Lanes
  // Render pairs (Plate Boxes) uniquely
  const pool = [...state.lines];
  const uniquePairs = [];
  while (pool.length >= 2) {
    const l1 = pool.shift();
    // Find closest partner line vertically
    let bestIdx = -1; let minDist = Infinity;
    for (let i=0; i<pool.length; i++) {
        const d = Math.sqrt((l1.cx-pool[i].cx)**2 + (l1.cy-pool[i].cy)**2);
        if (d < minDist && Math.abs(l1.cy - pool[i].cy) > 50) { minDist = d; bestIdx = i; }
    }
    if (bestIdx !== -1) {
        const l2 = pool.splice(bestIdx, 1)[0];
        const [f, o] = l1.cy < l2.cy ? [l1, l2] : [l2, l1];
        uniquePairs.push({ o, f, w: Math.max(o.w, f.w), cy: (o.cy+f.cy)/2, h: Math.abs(o.cy-f.cy)*1.1 });
    }
  }

  uniquePairs.forEach(p => {
      ctx.save();
      ctx.translate(p.o.cx * sx, p.cy * sy);
      ctx.rotate(p.o.angle || 0);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)'; ctx.setLineDash([6, 3]);
      ctx.strokeRect(-p.w*sx/2, -p.h*sy/2, p.w*sx, p.h*sy);
      ctx.restore();
  });

  state.lanes.forEach(l => {
    ctx.save(); ctx.translate(l.cx*sx, l.cy*sy); ctx.rotate(l.angle || 0);
    const isA = state.activeLane === l;
    ctx.strokeStyle = isA ? '#ffc107' : 'rgba(88,166,255,0.4)';
    ctx.lineWidth = isA ? 4/state.view.zoom : 2/state.view.zoom;
    ctx.strokeRect(-(l.w*sx)/2, -(l.h*sy)/2, l.w*sx, l.h*sy);
    
    const n = (l.profile || []).length;
    if (n > 1) {
        (l.peaks || []).forEach(pk => {
            const lb = pk.lb !== undefined ? pk.lb : Math.max(0, pk.idx - 5);
            const rb = pk.rb !== undefined ? pk.rb : Math.min(n-1, pk.idx + 5);
            const y_top = (0.5 - rb/(n-1)) * l.h * sy;
            const y_bot = (0.5 - lb/(n-1)) * l.h * sy;
            ctx.fillStyle = isA ? 'rgba(255,215,0,0.22)' : 'rgba(255,215,0,0.1)';
            ctx.fillRect(-(l.w*sx)/2, y_top, l.w*sx, y_bot - y_top);
            ctx.strokeStyle = isA ? 'rgba(255,215,0,0.7)' : 'rgba(255,215,0,0.3)';
            ctx.lineWidth = 1/state.view.zoom;
            ctx.beginPath(); ctx.moveTo(-(l.w*sx)/2, y_top); ctx.lineTo((l.w*sx)/2, y_top); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(-(l.w*sx)/2, y_bot); ctx.lineTo((l.w*sx)/2, y_bot); ctx.stroke();
        });
    }
    ctx.restore();
  });

  // ROI Rect
  if (state.roiRect) {
    ctx.strokeStyle = '#f0883e'; ctx.lineWidth = 2/state.view.zoom;
    ctx.setLineDash([5/state.view.zoom, 5/state.view.zoom]);
    ctx.strokeRect(state.roiRect.x*sx, state.roiRect.y*sy, state.roiRect.w*sx, state.roiRect.h*sy);
    ctx.fillStyle = 'rgba(240,136,62,0.1)';
    ctx.fillRect(state.roiRect.x*sx, state.roiRect.y*sy, state.roiRect.w*sx, state.roiRect.h*sy);
    ctx.setLineDash([]);
  }

  ctx.restore(); ctx.restore();
}

// ── Analytical Functions ────────────────────────────────────────────────────
async function updateDensitograms(detectPeaks = false) {
  if (state.lanes.length === 0 || !state.imgB64) return;
  const prominence = parseFloat($('peak-prominence')?.value || 10);
  const distance   = parseInt($('peak-distance')?.value   || 8);
  try {
    const res = await fetch('/generate_profiles', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ 
        image: state.imgB64, lanes: state.lanes, 
        peak_detection: detectPeaks, 
        peak_prominence: prominence, 
        peak_distance: distance, 
        peak_threshold: parseFloat($('peak-threshold')?.value || 50),
        smooth_sigma: 1.5
      })
    });
    const data = await res.json();
    if (data.results) {
      data.results.forEach(r => { 
        const l = state.lanes.find(ln => ln.id === r.id); 
        if (l) { 
            l.profile = r.profile; 
            // Only update peaks if we were looking for them, otherwise keep existing peaks
            if (detectPeaks || !l.peaks || l.peaks.length === 0) l.peaks = r.peaks || []; 
        }
      });
      renderProfiles();
      render();
    }
  } catch(e) { console.error(e); }
}

function renderProfiles() {
    const list = $('densitogram-list'); if (!list) return;
    list.innerHTML = '';
    
    if (!state.activeLane) {
        list.innerHTML = `<div class="empty-state" style="text-align:center; padding:50px; opacity:0.5">Select a lane to view analysis</div>`;
        return;
    }

    const l = state.activeLane;
    const item = document.createElement('div');
    item.innerHTML = `
        <div style="margin-bottom:15px; display:flex; justify-content:space-between; align-items:center">
            <input type="text" class="lane-name-edit" value="${l.name || 'Lane '+l.id}" 
                   style="background:transparent; border:none; color:white; font-family:Outfit; font-size:1.2rem; font-weight:700; width:150px"
                   onchange="state.lanes.find(ln=>ln.id=='${l.id}').name = this.value; render();">
            <button class="action-btn secondary" onclick="exportReport()" style="font-size:0.75rem; padding:4px 10px">📄 Export Lane</button>
        </div>
        <canvas id="chart-active" style="width:100%; height:280px; background:#010409; border:1px solid var(--border); border-radius:8px"></canvas>
        <div class="integration-table-wrap" style="margin-top:20px">
            <table class="integration-table" style="width:100%">
                <thead>
                    <tr style="border-bottom:2px solid var(--border)">
                        <th style="text-align:left">Peak</th>
                        <th style="text-align:center">Rf</th>
                        <th style="text-align:right">Area</th>
                        <th style="text-align:right">%</th>
                    </tr>
                </thead>
                <tbody id="peak-table-body"></tbody>
            </table>
        </div>
    `;
    list.appendChild(item);

    const totalArea = (l.peaks || []).reduce((sum, pk) => sum + pk.area, 0);
    const tbody = $('peak-table-body');
    (l.peaks || []).forEach((pk, i) => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--border)';
        tr.innerHTML = `
            <td style="color:#ffd700; font-weight:600">
                <input type="text" value="${pk.name || '#'+(i+1)}" 
                       style="background:transparent; border:none; color:#ffd700; width:60px"
                       onchange="state.activeLane.peaks[${i}].name = this.value;">
            </td>
            <td style="text-align:center">${pk.rf.toFixed(3)}</td>
            <td style="text-align:right">${pk.area.toLocaleString(undefined, {maximumFractionDigits:1})}</td>
            <td style="text-align:right; font-weight:700">${totalArea > 0 ? ((pk.area/totalArea)*100).toFixed(1) : 0}%</td>
        `;
        tbody.appendChild(tr);
    });

    setTimeout(() => {
        const cv = $('chart-active'); if (!cv) return;
        cv.width = cv.clientWidth; cv.height = cv.clientHeight;
        const ctx = cv.getContext('2d'); const raw = l.profile; if (!raw || raw.length === 0) return;
        const p = raw.slice().reverse();
        const minV = Math.min(...p); const maxV = Math.max(...p); const range = (maxV - minV) || 1;
        
        // PAD for text and labels
        const PAD_L = 50, PAD_R = 50, PAD_T = 30, PAD_B = 40;
        const plotW = cv.width - PAD_L - PAD_R;
        const plotH = cv.height - PAD_T - PAD_B;
        
        const pts = p.map((val, i) => ({ 
            x: PAD_L + (i/(p.length-1)) * plotW, 
            y: PAD_T + (1 - (val-minV)/range) * plotH 
        }));

        // Grid
        ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
        for(let i=0; i<=4; i++) {
            const gy = PAD_T + (i/4)*plotH;
            ctx.beginPath(); ctx.moveTo(PAD_L, gy); ctx.lineTo(cv.width-PAD_R, gy); ctx.stroke();
        }

        // Fill & Line
        ctx.beginPath(); ctx.moveTo(pts[0].x, PAD_T+plotH); pts.forEach(pt => ctx.lineTo(pt.x, pt.y)); ctx.lineTo(pts[pts.length-1].x, PAD_T+plotH); ctx.closePath();
        ctx.fillStyle = 'rgba(31, 111, 235, 0.15)'; ctx.fill();
        ctx.beginPath(); ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = 2.5; pts.forEach((pt,i) => i===0?ctx.moveTo(pt.x,pt.y):ctx.lineTo(pt.x,pt.y)); ctx.stroke();

        // Labels
        ctx.font = 'bold 11px Inter'; ctx.textAlign = 'center'; ctx.fillStyle = '#8b949e';
        ctx.fillText('ORIGIN (0.0)', PAD_L, cv.height - 15);
        ctx.fillText('FRONT (1.0)', cv.width - PAD_R, cv.height - 15);

        // Peaks
        (l.peaks || []).forEach(pk => {
            const px = PAD_L + (pk.idx/(p.length-1)) * plotW; const py = PAD_T + (1-(pk.height-minV)/range)*plotH;
            ctx.setLineDash([5,3]); ctx.strokeStyle='rgba(255,214,0,0.6)'; ctx.beginPath(); ctx.moveTo(px,py); ctx.lineTo(px,PAD_T+plotH); ctx.stroke();
            ctx.setLineDash([]); ctx.fillStyle='#ffd700'; ctx.beginPath(); ctx.arc(px,py,4,0,Math.PI*2); ctx.fill();
            ctx.font='bold 10px Roboto Mono'; ctx.fillText(pk.rf.toFixed(2), px, py-12);
        });

        // peak interactions (automatically active)
        cv.onmousedown = me => {
            const mrect = cv.getBoundingClientRect();
            const mx = me.clientX - mrect.left; const my = me.clientY - mrect.top;
            let idx = Math.round((mx - PAD_L) / plotW * (p.length - 1));
            idx = Math.max(0, Math.min(p.length-1, idx));
            const hit = (l.peaks || []).find(pk => Math.abs(mx - (PAD_L + (pk.idx/(p.length-1))*plotW)) < 15);

            if (me.button === 2) { // Right click: remove
                if (hit) { l.peaks = l.peaks.filter(pk => pk !== hit); renderProfiles(); render(); }
            } else if (hit) {
                state.isDraggingPeak = hit;
            } else { // Click for new peak
                const val = p[idx];
                let lb=idx, rb=idx;
                while(lb > 0 && p[lb-1] < p[lb]) lb--;
                while(rb < p.length-1 && p[rb+1] < p[rb]) rb++;
                const base = Math.min(p[lb], p[rb]);
                const thresh = base + (val - base) * 0.50;
                let v_lb = lb, v_rb = rb;
                for(let j=idx; j>lb; j--) if(p[j] < thresh) { v_lb = j; break; }
                for(let j=idx; j<rb; j++) if(p[j] < thresh) { v_rb = j; break; }

                let area = 0;
                for (let i = v_lb; i < v_rb; i++) area += (p[i] + p[i+1]) / 2 - base;

                l.peaks.push({ idx, rf: idx/(p.length-1), height: val, area: Math.max(0, area), lb: v_lb, rb: v_rb });
                l.peaks.sort((a,b)=>a.idx-b.idx); renderProfiles(); render();
            }
        };
        cv.ondblclick = () => updateDensitograms(true);
        cv.onmousemove = me => {
            if (!state.isDraggingPeak) return;
            const mrect = cv.getBoundingClientRect();
            const mx = me.clientX - mrect.left;
            let idx = Math.round((mx - PAD_L) / plotW * (p.length - 1));
            idx = Math.max(0, Math.min(p.length-1, idx));
            const pk = state.isDraggingPeak; pk.idx = idx; pk.rf = idx/(p.length-1); pk.height = p[idx];
            
            // Recalculate local bases for live "Gold Band" feedback
            let lb=idx, rb=idx;
            while(lb > 0 && p[lb-1] <= p[lb]) lb--;
            while(rb < p.length-1 && p[rb+1] <= p[rb]) rb++;
            const base = Math.min(p[lb], p[rb]); const thresh = base + (p[idx]-base)*0.5;
            let v_lb = lb, v_rb = rb;
            for(let j=idx; j>lb; j--) if(p[j] < thresh) { v_lb = j; break; }
            for(let j=idx; j<rb; j++) if(p[j] < thresh) { v_rb = j; break; }
            pk.lb = v_lb; pk.rb = v_rb;

            // Simple local numerical integration for live table updates
            let area = 0;
            const threshold = ($('peak-threshold') ? $('peak-threshold').value : 50) / 100.0;
            for (let i = v_lb; i < v_rb; i++) area += (p[i] + p[i+1]) / 2 - base;
            pk.area = Math.max(0, area);

            renderProfiles(); render();
        };
        cv.onmouseup = () => { if (state.isDraggingPeak) updateDensitograms(); state.isDraggingPeak = null; };
        cv.oncontextmenu = e => e.preventDefault();
    }, 0);
}

// ── Interaction Logic ──────────────────────────────────────────────────────
function getPos(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  const scX = (e.clientX - rect.left) * (canvas.width / rect.width);
  const scY = (e.clientY - rect.top) * (canvas.height / rect.height);
  const z = state.view.zoom;
  let x = (scX - state.view.dx) / z; let y = (scY - state.view.dy) / z;
  const sx = canvas.width / state.imgW;
  const icx = (state.imgW*sx)/2; const icy = (state.imgH*sx)/2;
  x -= icx; y -= icy;
  const sa = Math.sin(-state.imageRotation); const ca = Math.cos(-state.imageRotation);
  const rx = x * ca - y * sa; const ry = x * sa + y * ca;
  return { x: (rx + icx) / sx, y: (ry + icy) / sx, scX, scY };
}

$('canvas-main').onmousedown = e => {
  const p = getPos(e, $('canvas-main')); state.dragStart = p;
  state.mStart = { x: e.clientX, y: e.clientY };

  if (state.activeTool === 'select' || state.activeTool === 'pan') {
    const mHit = state.spottingMarks.find(m => Math.sqrt((p.x-m.x)**2 + (p.y-m.y)**2) < 12);
    const lHit = state.lines.find(l => Math.abs(p.y-l.cy)<20 && p.x>l.cx-l.w/2 && p.x<l.cx+l.w/2);
    const lnHit = state.lanes.find(ln => Math.abs(p.x-ln.cx)<ln.w/2 && Math.abs(p.y-ln.cy)<ln.h/2);

    if (mHit) { saveState(); state.activeMark = mHit; state.activeLine = null; state.activeLane = null; state.editingField = 'move-mark'; }
    else if (lHit) { saveState(); state.activeLine = lHit; state.activeMark = null; state.activeLane = null; state.editingField = 'move-line'; }
    else if (lnHit) { 
        saveState(); state.activeLane = lnHit; state.activeLine = null; state.activeMark = null; state.editingField = 'move-lane'; 
        renderProfiles();
    } else {
        state.activeMark = null; state.activeLine = null; state.activeLane = null;
        if (state.activeTool === 'pan') state.isPanning = true;
        state.viewStart = { ...state.view };
    }
  } else if (state.activeTool === 'roi') { state.roiRect = { x: p.x, y: p.y, w: 1, h: 1 }; }
  else if (state.activeTool === 'line') {
    const hit = state.lines.find(l => {
        const xPad = Math.max(20, l.w/2);
        return Math.abs(p.y-l.cy)<15 && p.x>=l.cx-xPad && p.x<=l.cx+xPad;
    });
    if (hit) {
        saveState(); state.activeLine = hit;
        state.editingField = (Math.abs(p.x - (hit.cx-hit.w/2)) < 20 || Math.abs(p.x - (hit.cx+hit.w/2)) < 20) ? 'resize-line' : 'move-line';
    } else {
        saveState();
        const nl = { cx: p.x, cy: p.y, w: 1, angle: 0 }; state.lines.push(nl); state.activeLine = nl; state.editingField = 'resize-line';
    }
  } else if (state.activeTool === 'spotting') {
    saveState();
    const origins = state.lines.filter(l => l.cy > state.imgH*0.5);
    const o = origins.length > 0 ? origins.reduce((p_best, curr) => {
        const d_curr = Math.sqrt((p.x-curr.cx)**2 + (p.y-curr.cy)**2);
        const d_best = Math.sqrt((p.x-p_best.cx)**2 + (p.y-p_best.cy)**2);
        return d_curr < d_best ? curr : p_best;
    }) : null;
    if (o && Math.abs(p.y - o.cy) < 150) { // Snaps only if somewhat close vertically
        const dx = p.x-o.cx, dy = p.y-o.cy; const cosA = Math.cos(o.angle), sinA = Math.sin(o.angle); 
        const dist = dx*cosA+dy*sinA; 
        state.spottingMarks.push({ x: o.cx+dist*cosA, y: o.cy+dist*sinA }); 
    } else state.spottingMarks.push({ x: p.x, y: p.y });
  } else if (state.activeTool === 'rotate_img') { saveState(); state.isRotating = true; state.rotateStart = state.imageRotation; }
  
  render();
};

window.onmousemove = e => {
  if (!state.dragStart) return; const p = getPos(e, $('canvas-main'));
  if (state.isPanning) { state.view.dx = state.viewStart.dx+(e.clientX-state.mStart.x); state.view.dy = state.viewStart.dy+(e.clientY-state.mStart.y); }
  else if (state.isRotating) { state.imageRotation = state.rotateStart + (e.clientX-state.mStart.x)*0.002; }
  else if (state.editingField === 'move-mark') { 
      const origins = state.lines.filter(l => l.cy > state.imgH*0.5);
      const o = origins.length > 0 ? origins.reduce((p_best, curr) => {
          const d_curr = Math.sqrt((p.x-curr.cx)**2 + (p.y-curr.cy)**2);
          const d_best = Math.sqrt((p.x-p_best.cx)**2 + (p.y-p_best.cy)**2);
          return d_curr < d_best ? curr : p_best;
      }) : null;
      if (o && Math.abs(p.y - o.cy) < 150) {
          const dx = p.x-o.cx, dy = p.y-o.cy, cosA = Math.cos(o.angle), sinA = Math.sin(o.angle); 
          const dist = dx*cosA+dy*sinA; 
          state.activeMark.x = o.cx+dist*cosA; state.activeMark.y = o.cy+dist*sinA; 
      } else { state.activeMark.x = p.x; state.activeMark.y = p.y; }
  }
  else if (state.editingField === 'move-line') { state.activeLine.cx = p.x; state.activeLine.cy = p.y; }
  else if (state.editingField === 'move-lane') { state.activeLane.cx = p.x; state.activeLane.cy = p.y; }
  else if (state.editingField === 'resize-line') { state.activeLine.w = Math.abs(p.x-state.activeLine.cx)*2; }
  else if (state.roiRect && state.activeTool === 'roi') { state.roiRect.w = p.x-state.roiRect.x; state.roiRect.h = p.y-state.roiRect.y; }
  render();
};

window.onmouseup = () => { 
    if (state.activeTool === 'roi' && state.roiRect && Math.abs(state.roiRect.w) > 5) { applyCrop(); }
    if (state.editingField === 'move-lane') updateDensitograms();
    state.dragStart = null; state.isPanning = false; state.isRotating = false; state.editingField = null; render(); 
};

async function applyCrop() {
    saveState();
    const r = state.roiRect; if(!r) return;
    const res = await fetch('/detect/crop', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ image: state.imgB64, x: r.x, y: r.y, w: r.w, h: r.h, angle: state.imageRotation })
    });
    const data = await res.json();
    if (data.image) {
        const img = new Image(); img.onload = () => {
            state.imgEl = img; state.imgB64 = data.image; 
            state.imgW = img.naturalWidth; state.imgH = img.naturalHeight;
            state.roiRect = null; state.imageRotation = 0;
            state.view = { zoom: 1, dx: 0, dy: 0 };
            render();
        };
        img.src = data.image;
    }
}

window.onkeydown = e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
    if (e.key === 'Delete' || e.key === 'Backspace') {
        saveState();
        if (state.activeMark) { state.spottingMarks = state.spottingMarks.filter(m => m !== state.activeMark); state.activeMark = null; }
        else if (state.activeLine) { state.lines = state.lines.filter(l => l !== state.activeLine); state.activeLine = null; }
        else if (state.activeLane) { state.lanes = state.lanes.filter(l => l !== state.activeLane); state.activeLane = null; renderProfiles(); }
        render();
    }
};

$('canvas-main').onwheel = e => {
  e.preventDefault(); const p = getPos(e, $('canvas-main')); const d = e.deltaY > 0 ? 0.9 : 1.1; const old = state.view.zoom;
  state.view.zoom = Math.min(20, Math.max(0.1, state.view.zoom * d));
  state.view.dx -= (p.scX - state.view.dx) * (state.view.zoom/old - 1); state.view.dy -= (p.scY - state.view.dy) * (state.view.zoom/old - 1); render();
};

// ── App Logic ───────────────────────────────────────────────────────────────
function handleFile(file) {
  if (!file) return; const reader = new FileReader(); reader.onload = e => {
    const img = new Image(); img.onload = () => {
      state.imgEl = img; const s = Math.min(1, 1000/Math.max(img.naturalWidth, img.naturalHeight));
      state.imgW = Math.round(img.naturalWidth*s); state.imgH = Math.round(img.naturalHeight*s);
      const c = document.createElement('canvas'); c.width=state.imgW; c.height=state.imgH;
      c.getContext('2d').drawImage(img,0,0,state.imgW,state.imgH); 
      state.imgB64 = c.toDataURL('image/jpeg', 0.9);
      state.originalB64 = state.imgB64; 
      $('upload-prompt').style.display='none'; $('app-grid').style.display='grid';
      state.lines=[]; state.lanes=[]; state.spottingMarks=[];
      state.activeLine=null; state.activeLane=null; state.activeMark=null;
      $('file-input-prompter').value = '';
      render();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function resetState(keepImage = true) {
    state.lines = []; state.lanes = []; state.spottingMarks = []; state.roiRect = null;
    state.activeLine = null; state.activeLane = null; state.activeMark = null;
    state.imageRotation = 0;
    state.view = { zoom: 1, dx: 0, dy: 0 };
    if (!keepImage) {
        state.imgEl = null; state.imgB64 = null;
        state.originalB64 = null; // Purge original on New
        $('upload-prompt').style.display='flex'; $('app-grid').style.display='none';
    } else if (state.originalB64) {
        // Re-load the original image if we were cropped/rotated
        const img = new Image(); img.onload = () => {
            state.imgEl = img; state.imgB64 = state.originalB64; 
            const s = Math.min(1, 1000/Math.max(img.naturalWidth, img.naturalHeight));
            state.imgW = Math.round(img.naturalWidth*s); state.imgH = Math.round(img.naturalHeight*s);
            renderProfiles(); render();
        };
        img.src = state.originalB64;
    }
}

function saveState() {
    const s = {
        lines: JSON.parse(JSON.stringify(state.lines)),
        lanes: JSON.parse(JSON.stringify(state.lanes)),
        marks: JSON.parse(JSON.stringify(state.spottingMarks)),
        rot: state.imageRotation,
        img: state.imgB64,
        w: state.imgW, h: state.imgH
    };
    state.undoStack.push(s);
    if (state.undoStack.length > 50) state.undoStack.shift();
}

function undo() {
    if (state.undoStack.length === 0) return;
    const s = state.undoStack.pop();
    state.lines = s.lines; state.lanes = s.lanes; state.spottingMarks = s.marks;
    state.imageRotation = s.rot;
    if (state.imgB64 !== s.img) {
        state.imgB64 = s.img; state.imgW = s.w; state.imgH = s.h;
        const img = new Image(); img.onload = () => { state.imgEl = img; render(); };
        img.src = s.img;
    }
    renderProfiles(); render();
}

function init() {
  const dz = $('drop-zone');
  const fi = $('file-input-prompter');
  if (dz && fi) {
    dz.onclick = () => fi.click();
    dz.ondragover = e => { e.preventDefault(); dz.style.background = 'rgba(31, 111, 235, 0.1)'; dz.style.borderColor = 'var(--accent)'; };
    dz.ondragleave = () => { dz.style.background = 'rgba(22, 27, 34, 0.5)'; dz.style.borderColor = 'var(--border)'; };
    dz.ondrop = e => { 
      e.preventDefault(); 
      dz.style.background = 'rgba(22, 27, 34, 0.5)'; dz.style.borderColor = 'var(--border)';
      if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]); 
    };
    fi.onchange = e => { if (e.target.files.length) handleFile(e.target.files[0]); };
  }
  $('btn-new').onclick = () => resetState(false);
  $('btn-reset').onclick = () => { resetState(true); renderProfiles(); render(); };
  
  $('peak-prominence').oninput = e => {
      $('peak-prominence-val').textContent = e.target.value;
      if (state.activeLane) updateDensitograms(true);
  };
  $('peak-distance').oninput = e => {
      $('peak-distance-val').textContent = e.target.value;
      if (state.activeLane) updateDensitograms(true);
  };

  $('btn-calc-lanes').onclick = () => {
    saveState();
    state.lanes = [];
    const pool = [...state.lines];
    const pairs = [];
    while (pool.length >= 2) {
        const l1 = pool.shift();
        let bestIdx = -1; let minDist = Infinity;
        for (let i=0; i<pool.length; i++) {
            const d = Math.sqrt((l1.cx-pool[i].cx)**2 + (l1.cy-pool[i].cy)**2);
            if (d < minDist && Math.abs(l1.cy - pool[i].cy) > 50) { minDist = d; bestIdx = i; }
        }
        if (bestIdx !== -1) {
            const l2 = pool.splice(bestIdx, 1)[0];
            const [f, o] = l1.cy < l2.cy ? [l1, l2] : [l2, l1];
            pairs.push({ o, f, id: pairs.length + 1, w: Math.max(o.w, f.w) });
        }
    }

    state.spottingMarks.forEach((m, mi) => {
        // Find closest Origin line to this mark
        const bestPair = pairs.reduce((best, curr) => {
            const d_curr = Math.sqrt((m.x - curr.o.cx)**2 + (m.y - curr.o.cy)**2);
            const d_best = Math.sqrt((m.x - best.o.cx)**2 + (m.y - best.o.cy)**2);
            return d_curr < d_best ? curr : best;
        }, pairs[0]);
        
        if (!bestPair) return;
        const {o, f} = bestPair;
        const oY = o.cy + (m.x - o.cx) * Math.tan(o.angle || 0);
        const fY = f.cy + (m.x - f.cx) * Math.tan(f.angle || 0);
        const h = Math.abs(oY - fY) * 1.10;
        const cy = (oY + fY) / 2;

        // Calculate lane width to avoid overlap with neighbor marks assigned to the same bestPair
        const buddies = state.spottingMarks.filter(bm => {
            const bBest = pairs.reduce((b, c) => Math.abs(bm.x - c.o.cx) < Math.abs(bm.x - b.o.cx) ? c : b, pairs[0]);
            return bBest === bestPair;
        }).sort((a, b) => a.x - b.x);

        let laneW = 35;
        if (buddies.length > 1) {
            let minDist = Infinity;
            for (let i = 0; i < buddies.length - 1; i++) minDist = Math.min(minDist, buddies[i + 1].x - buddies[i].x);
            laneW = Math.min(35, minDist * 0.85);
        }

        state.lanes.push({ 
            id: bestPair.id + "." + (buddies.indexOf(m) + 1), 
            cx: m.x, cy, w: laneW, h, 
            angle: bestPair.o.angle || 0, profile: [], peaks: [] 
        });
    });

    if (state.lanes.length > 0) { state.activeLane = state.lanes[0]; updateDensitograms(true); }
    render();
  };

  $('peak-prominence').oninput = e => {
      $('peak-prominence-val').textContent = e.target.value;
      if (state.activeLane) updateDensitograms(true);
  };
  $('peak-distance').oninput = e => {
      $('peak-distance-val').textContent = e.target.value;
      if (state.activeLane) updateDensitograms(true);
  };
  $('peak-threshold').oninput = e => {
      $('peak-threshold-val').textContent = e.target.value;
      if (state.activeLane) updateDensitograms(true);
  };
  $('btn-export-all').onclick = () => exportReport();

  document.querySelectorAll('.tool-btn').forEach(btn => { 
      btn.onclick = () => { 
          document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active')); 
          btn.classList.add('active'); state.activeTool = btn.dataset.tool; render(); 
      }; 
  });
  
  // Set default tool
  document.querySelector('[data-tool="pan"]').classList.add('active');
  render();

  // Keyboard Delete/Backspace Filter
  window.addEventListener('keydown', e => {
    // If the user is typing in ANY input field, ignore global deletion shortcuts
    const isEditing = e.target.tagName === 'INPUT' || 
                      e.target.tagName === 'TEXTAREA' || 
                      e.target.isContentEditable;
    if (isEditing) return;

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.activeTool === 'select') {
        let changed = false;
        if (state.activeLane) {
          state.lanes = state.lanes.filter(l => l !== state.activeLane);
          state.activeLane = null; changed = true;
        }
        if (state.activeLine) {
          state.lines = state.lines.filter(l => l !== state.activeLine);
          state.activeLine = null; changed = true;
        }
        if (state.activeMark) {
          state.spottingMarks = state.spottingMarks.filter(m => m !== state.activeMark);
          state.activeMark = null; changed = true;
        }
        if (changed) { renderProfiles(); render(); }
      }
    }
  });
}

const $$ = s => document.querySelectorAll(s);

async function exportReport() {
    if (!state.activeLane) { alert("Please select a lane first."); return; }
    const l = state.activeLane;
    const chart = $('chart-active');
    
    // 1. Create High-Resolution Rotated Lane Strip (TRIMMED TO ORIGIN/FRONT ONLY)
    const laneStrip = document.createElement('canvas');
    // Align EXACTLY with solvent path (strip the 10% padding used for the plate box)
    const solventRange = l.h / 1.10; // Extract the actual distance between lines
    laneStrip.width = solventRange; laneStrip.height = l.w; 
    const sctx = laneStrip.getContext('2d');
    
    const img = new Image(); img.src = state.imgB64;
    await new Promise(r => img.onload = r);
    
    sctx.save();
    // Crop and Rotate so that Front is on the LEFT, Origin on the RIGHT (User requested flip)
    sctx.translate(solventRange/2, l.w/2);
    sctx.rotate(Math.PI/2 - l.angle); // Rotate 90deg CW to move bottom (Origin) to Right
    sctx.drawImage(img, -l.cx, -l.cy); 
    sctx.restore();

    // Draw Gold Bands on the horizontal strip
    const n = (l.profile || []).length;
    if (n > 1) {
        (l.peaks || []).forEach(pk => {
            const lb = pk.lb !== undefined ? pk.lb : Math.max(0, pk.idx - 5);
            const rb = pk.rb !== undefined ? pk.rb : Math.min(n-1, pk.idx + 5);
            
            // Flipped: Origin is on the RIGHT. 
            // rb (integrated index closest to Front) is on the LEFT side of the strip.
            // lb (integrated index closest to Origin) is on the RIGHT side.
            const x_pos_rb_flipped = (lb/(n-1)) * solventRange; 
            const x_pos_lb_flipped = (rb/(n-1)) * solventRange;
            
            sctx.fillStyle = 'rgba(255,215,0,0.35)';
            sctx.fillRect(x_pos_rb_flipped, 0, x_pos_lb_flipped - x_pos_rb_flipped, l.w);
            sctx.strokeStyle = 'rgba(255,165,0,0.8)'; sctx.lineWidth = 1;
            sctx.beginPath(); sctx.moveTo(x_pos_rb_flipped, 0); sctx.lineTo(x_pos_rb_flipped, l.w); sctx.stroke();
            sctx.beginPath(); sctx.moveTo(x_pos_lb_flipped, 0); sctx.lineTo(x_pos_lb_flipped, l.w); sctx.stroke();
        });
    }

    // 2. High-Resolution Chart Export (Supersampled)
    const hiResChart = document.createElement('canvas');
    hiResChart.width = 1600; hiResChart.height = 800;
    const hctx = hiResChart.getContext('2d');
    hctx.fillStyle = '#ffffff'; hctx.fillRect(0,0,1600,800);
    
    // DRAW PROFILE IN REVERSE (Origin at Left)
    const p_orig = l.profile; 
    const p = [...p_orig].reverse(); // Now p[0] is Origin
    const padL = 80; const padR = 120; const pw = 1600 - padL - padR;
    const maxVal = Math.max(...p);
    hctx.strokeStyle = '#0366d6'; hctx.lineWidth = 3; hctx.beginPath();
    p.forEach((v, i) => {
        const x = padL + (i / (p.length - 1)) * pw;
        const y = 700 - (v / maxVal) * 600;
        if (i === 0) hctx.moveTo(x, y); else hctx.lineTo(x, y);
    });
    hctx.stroke();

    // Rf Tick Marks 0 -> 1
    hctx.fillStyle = '#000'; hctx.font = 'bold 24px Inter'; hctx.textAlign = 'center';
    hctx.fillText('Retention Factor (Rf)', 800, 785);
    for(let i=0; i<=10; i++) {
        const rf = i/10;
        const x = padL + rf * pw;
        hctx.font = '18px Inter';
        hctx.fillText(rf.toFixed(1), x, 730);
        hctx.beginPath(); hctx.moveTo(x, 700); hctx.lineTo(x, 690); hctx.stroke();
    }

    const laneStripUrl = laneStrip.toDataURL();
    const chartImgUrl = hiResChart.toDataURL();

    // 3. Integration Table Data
    const totalArea = (l.peaks || []).reduce((s, p) => s + p.area, 0);
    const rows = (l.peaks || []).map((pk, i) => `
        <tr>
            <td>${pk.name || '#'+(i+1)}</td>
            <td style="text-align:center">${pk.rf.toFixed(3)}</td>
            <td style="text-align:right">${pk.area.toFixed(1)}</td>
            <td style="text-align:right; font-weight:700; color:#0366d6">${totalArea > 0 ? ((pk.area/totalArea)*100).toFixed(1) : 0}%</td>
        </tr>`).join('');

    // Aligned Report Geometry (Exactly PAD_L in our high-res draw was 80)
    const html = `<html><head><title>AQ-TLC Analytical - ${l.name || l.id}</title><style>
        body { font-family: 'Segoe UI', Arial, sans-serif; padding: 40px; color: #1a1a1a; max-width: 1000px; margin: auto; }
        .header { display: flex; justify-content: space-between; border-bottom: 3px solid #ffc107; padding-bottom: 15px; margin-bottom: 30px; }
        .stack-wrap { border: 1px solid #ddd; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.08); background: #000; padding-bottom: 10px; }
        .lane-strip-area { position: relative; height: 100px; background: #000; overflow: hidden; margin-bottom: -1px; }
        .lane-strip-img { position: absolute; left: ${ (80/1600)*100 }%; width: ${ ( (1600-80-120)/1600 )*100 }%; height: 100%; object-fit: fill; }
        .chart-img { width: 100%; display: block; border-top: 2px solid #ffc107; }
        table { width: 100%; border-collapse: collapse; margin-top: 30px; font-size: 0.95rem; }
        th, td { border-bottom: 1px solid #eee; padding: 12px 15px; text-align: left; }
        th { background: #f8f9fa; font-weight: 700; color: #555; text-transform: uppercase; font-size: 0.75rem; }
        .badge { background: #ffc107; padding: 2px 10px; border-radius: 12px; font-size: 0.8rem; font-weight: 700; color:#000; }
    </style></head><body>
        <div class="header">
            <div><h1 style="color:#0366d6; margin:0">AQ-TLC Analytical Report <span class="badge">v1.0</span></h1>
                 <p style="color:#666; margin:5px 0 0 0">Sample: <strong>${l.name || l.id}</strong></p></div>
            <div style="text-align:right; color:#888; font-size:0.9rem">${new Date().toLocaleString()}</div>
        </div>
        <div class="stack-wrap">
            <h3 style="color:#fff; font-size:0.65rem; padding:8px 15px; margin:0; text-transform:uppercase; letter-spacing:1px">Physical-to-Signal Alignment Stack</h3>
            <div class="lane-strip-area"><img src="${laneStripUrl}" class="lane-strip-img"></div>
            <img src="${chartImgUrl}" class="chart-img">
        </div>
        <h3 style="margin-top:40px; border-bottom:2px solid #eee; padding-bottom:10px; font-size:0.9rem">QUANTITATIVE INTEGRATION</h3>
        <table><thead><tr><th>PEAK NAME</th><th style="text-align:center">Rf</th><th style="text-align:right">AREA (AU)</th><th style="text-align:right">% AREA</th></tr></thead><tbody>${rows}</tbody></table>
        <script>window.onload = () => { setTimeout(() => window.print(), 1000); }</script>
    </body></html>`;

    const win = window.open('', '_blank');
    win.document.write(html);
    win.document.close();
}

// ── Geometry Utilities ─────────────────────────────────────────────────────
function getLineGroups(lines) {
  const groups = [];
  [...lines].sort((a,b)=>a.cx-b.cx).forEach(l => {
     let g = groups.find(grp => { const l1 = grp[0]; return Math.abs(l1.cx - l.cx) < (l1.w + l.w)/2 * 0.8; });
     if (g) g.push(l); else groups.push([l]);
  });
  return groups;
}

init();
