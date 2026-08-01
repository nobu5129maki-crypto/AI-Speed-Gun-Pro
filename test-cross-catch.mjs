/**
 * BALANCE LOCK v3.4 — 指横断は通す / 重い手ブレは拒否
 */

const AW = 320, AH = 180;
const MOTION_THR = 10;
const HEAVY_COVERAGE = 0.28;
const COMPACT_PEAKINESS = 0.11;
const MIN_PEAKINESS = 0.08;
const MAX_SPREAD_Y = 36;
const MAX_MOTION_PIXELS = 4000;

function makeRgba(fill = [50, 60, 50], draw) {
  const data = new Uint8ClampedArray(AW * AH * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0]; data[i + 1] = fill[1]; data[i + 2] = fill[2]; data[i + 3] = 255;
  }
  if (draw) draw(data);
  return data;
}

function stampDisk(data, cx, cy, r, rgb) {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
      if (x < 0 || x >= AW || y < 0 || y >= AH) continue;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
        const i = (y * AW + x) * 4;
        data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2];
      }
    }
  }
}

function globalShift(src, dx, dy) {
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < AH; y++) {
    for (let x = 0; x < AW; x++) {
      const sx = Math.min(AW - 1, Math.max(0, x - dx));
      const sy = Math.min(AH - 1, Math.max(0, y - dy));
      const si = (sy * AW + sx) * 4;
      const di = (y * AW + x) * 4;
      out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = 255;
    }
  }
  return out;
}

function analyze(data, prev) {
  const roi = { left: 20, right: AW - 20, top: 45, bottom: AH - 45 };
  const roiArea = (roi.right - roi.left) * (roi.bottom - roi.top);
  let sumX = 0, sumY = 0, sumX2 = 0, sumY2 = 0, sumW = 0, count = 0;
  const colE = new Float32Array(AW);
  let cornerHits = 0;
  const corners = [
    [roi.left + 4, roi.top + 4], [roi.right - 5, roi.top + 4],
    [roi.left + 4, roi.bottom - 5], [roi.right - 5, roi.bottom - 5]
  ];
  for (const [cx, cy] of corners) {
    let local = 0, n = 0;
    for (let y = cy; y < cy + 6 && y < roi.bottom; y++) {
      for (let x = cx; x < cx + 6 && x < roi.right; x++) {
        const i = (y * AW + x) * 4;
        const diff = Math.max(
          Math.abs(data[i] - prev[i]),
          Math.abs(data[i + 1] - prev[i + 1]),
          Math.abs(data[i + 2] - prev[i + 2])
        );
        if (diff >= MOTION_THR) local++;
        n++;
      }
    }
    if (n && local / n > 0.25) cornerHits++;
  }
  for (let y = roi.top; y < roi.bottom; y++) {
    for (let x = roi.left; x < roi.right; x++) {
      const i = (y * AW + x) * 4;
      const diff = Math.max(
        Math.abs(data[i] - prev[i]),
        Math.abs(data[i + 1] - prev[i + 1]),
        Math.abs(data[i + 2] - prev[i + 2])
      );
      if (diff < MOTION_THR) continue;
      const w = diff * diff;
      sumX += x * w; sumY += y * w; sumX2 += x * x * w; sumY2 += y * y * w;
      sumW += w; count++; colE[x] += w;
    }
  }
  if (count < 4 || sumW <= 0) return { shake: false, peak: null };
  const meanX = sumX / sumW, meanY = sumY / sumW;
  const spreadY = Math.sqrt(Math.max(0, sumY2 / sumW - meanY * meanY));
  const coverage = count / roiArea;
  let peakE = 0, peakX = -1;
  for (let x = roi.left; x < roi.right; x++) if (colE[x] > peakE) { peakE = colE[x]; peakX = x; }
  const peakiness = peakE / (sumW + 1e-6);
  const compactObject = peakiness >= COMPACT_PEAKINESS && spreadY <= MAX_SPREAD_Y && count <= 900;
  const heavyShake = (coverage > HEAVY_COVERAGE && cornerHits >= 3) || count > MAX_MOTION_PIXELS ||
    (cornerHits >= 4 && peakiness < MIN_PEAKINESS);
  const softShake = !compactObject && (
    (cornerHits >= 3 && peakiness < COMPACT_PEAKINESS) ||
    (coverage > 0.12 && peakiness < MIN_PEAKINESS) ||
    (count > 180 && peakiness < 0.07)
  );
  if (heavyShake && !compactObject) return { shake: 'heavy', peak: null };
  if (softShake && !compactObject) return { shake: 'soft', peak: null };
  return { shake: false, peak: { x: peakX >= 0 ? peakX : meanX, y: meanY, peakiness } };
}

function shouldFinalize(points, canvasW = 1280) {
  if (points.length < 2) return false;
  const scale = canvasW / AW;
  const dx = Math.abs(points.at(-1).x - points[0].x) * scale;
  const dy = Math.abs(points.at(-1).y - points[0].y) * scale;
  const minDx = Math.max(canvasW * 0.05, 28);
  const dt = (points.at(-1).t - points[0].t) / 1000;
  const fastSwipe = points.length === 2 && dx >= minDx * 1.2 && dx >= dy && dt < 0.45;
  if (points.length < 3 && !fastSwipe) return false;
  return dx >= minDx && dx >= dy * 0.55;
}

let passed = 0, failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; console.log('✓', name); }
  else { failed++; console.error('✗', name, detail); }
}

// heavy global shake
{
  const prev = makeRgba([40, 50, 40], d => {
    for (let y = 0; y < AH; y += 2) for (let x = 0; x < AW; x += 2) {
      const i = (y * AW + x) * 4;
      d[i] = 40 + (x % 23); d[i + 1] = 50 + (y % 19); d[i + 2] = 45;
    }
  });
  const cur = globalShift(prev, 2, 2);
  const r = analyze(cur, prev);
  assert('heavy/global shake not a peak', r.peak == null, JSON.stringify(r));
  assert('shake classified', r.shake === 'heavy' || r.shake === 'soft', JSON.stringify(r));
}

// fingertip cross
{
  const xs = [40, 90, 140, 190, 240, 290];
  const track = [];
  let prev = makeRgba();
  let t = 1000;
  for (const cx of xs) {
    const cur = makeRgba([50, 60, 50], d => stampDisk(d, cx, 95, 4, [160, 110, 90]));
    const r = analyze(cur, prev);
    prev = cur; t += 33;
    if (r.peak && !r.shake) track.push({ ...r.peak, t });
  }
  assert('fingertip peaks kept', track.length >= 3, `n=${track.length}`);
  assert('fingertip finalized', shouldFinalize(track), `n=${track.length}`);
}

// dark fingertip
{
  const xs = [50, 110, 170, 230, 290];
  const track = [];
  let prev = makeRgba();
  let t = 1000;
  for (const cx of xs) {
    const cur = makeRgba([50, 60, 50], d => stampDisk(d, cx, 92, 3, [90, 70, 55]));
    const r = analyze(cur, prev);
    prev = cur; t += 33;
    if (r.peak) track.push({ ...r.peak, t });
  }
  assert('dark fingertip finalized', shouldFinalize(track), `n=${track.length}`);
}

// fast 2-point swipe
{
  assert('fast 2-point swipe ok', shouldFinalize([
    { x: 40, y: 90, t: 1000 },
    { x: 280, y: 95, t: 1080 }
  ]));
}

// tiny jitter not finalized
{
  const pts = [];
  for (let i = 0; i < 8; i++) pts.push({ x: 160 + Math.sin(i) * 3, y: 90, t: 1000 + i * 33 });
  assert('tiny jitter rejected', !shouldFinalize(pts));
}

// soft shake must not invent peak
{
  // mild shift
  const prev = makeRgba([50, 55, 50], d => {
    for (let i = 0; i < d.length; i += 16) { d[i] += (i % 7); }
  });
  const cur = globalShift(prev, 1, 0);
  const r = analyze(cur, prev);
  assert('soft/global without compact peak', r.peak == null || r.shake, JSON.stringify(r));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
