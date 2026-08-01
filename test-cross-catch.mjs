/**
 * STABLE LOCK v3.3 — 手ブレ拒否 / 横断捕捉テスト
 */

const AW = 320, AH = 180;
const MOTION_THR = 12;
const MAX_COVERAGE = 0.18;
const MIN_PEAKINESS = 0.10;
const MAX_SPREAD_Y = 28;
const MAX_SPREAD_X = 90;
const MAX_MOTION_PIXELS = 2200;

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

/** 画面全体をわずかにずらす＝手ブレ近似 */
function globalShift(src, dx, dy) {
  const out = new Uint8ClampedArray(src.length);
  out.set(src);
  for (let y = 0; y < AH; y++) {
    for (let x = 0; x < AW; x++) {
      const sx = Math.min(AW - 1, Math.max(0, x - dx));
      const sy = Math.min(AH - 1, Math.max(0, y - dy));
      const si = (sy * AW + sx) * 4;
      const di = (y * AW + x) * 4;
      out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2];
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
    [roi.left + 4, roi.top + 4],
    [roi.right - 5, roi.top + 4],
    [roi.left + 4, roi.bottom - 5],
    [roi.right - 5, roi.bottom - 5]
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
  if (count < 6 || sumW <= 0) return { shake: false, peak: null };

  const meanX = sumX / sumW, meanY = sumY / sumW;
  const spreadX = Math.sqrt(Math.max(0, sumX2 / sumW - meanX * meanX));
  const spreadY = Math.sqrt(Math.max(0, sumY2 / sumW - meanY * meanY));
  const coverage = count / roiArea;
  let peakE = 0, peakX = -1;
  for (let x = roi.left; x < roi.right; x++) if (colE[x] > peakE) { peakE = colE[x]; peakX = x; }
  const peakiness = peakE / (sumW + 1e-6);

  const widespread = coverage > MAX_COVERAGE || count > MAX_MOTION_PIXELS;
  const flatEnergy = peakiness < MIN_PEAKINESS;
  const blobTooBig = spreadY > MAX_SPREAD_Y && spreadX > MAX_SPREAD_X * 0.7;
  const globalShake = cornerHits >= 3;
  const isShake = widespread || globalShake || (flatEnergy && coverage > 0.06) || blobTooBig;
  if (isShake || spreadY > MAX_SPREAD_Y * 1.15) return { shake: true, peak: null, coverage, peakiness, cornerHits };

  return { shake: false, peak: { x: peakX >= 0 ? peakX : meanX, y: meanY, peakiness }, coverage, peakiness };
}

function trackLinearity(points) {
  if (points.length < 3) return 1;
  let path = 0;
  for (let i = 1; i < points.length; i++) path += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  const direct = Math.hypot(points.at(-1).x - points[0].x, points.at(-1).y - points[0].y);
  return path < 1 ? 1 : direct / path;
}

function directionConsistencyX(points) {
  const globalDx = points.at(-1).x - points[0].x;
  if (Math.abs(globalDx) < 1) return 0;
  const sign = Math.sign(globalDx);
  let agree = 0, total = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    if (Math.abs(dx) < 1.2) continue;
    total++;
    if (Math.sign(dx) === sign) agree++;
  }
  return total === 0 ? 0 : agree / total;
}

function shouldFinalize(points, canvasW = 1280) {
  if (points.length < 3) return false;
  const scale = canvasW / AW;
  const dx = Math.abs(points.at(-1).x - points[0].x) * scale;
  const dy = Math.abs(points.at(-1).y - points[0].y) * scale;
  const minDx = Math.max(canvasW * 0.08, 48);
  const lin = trackLinearity(points.map(p => ({ x: p.x * scale, y: p.y * scale })));
  const dir = directionConsistencyX(points);
  return dx >= minDx && dx >= dy * 0.85 && lin >= 0.62 && dir >= 0.70;
}

let passed = 0, failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; console.log('✓', name); }
  else { failed++; console.error('✗', name, detail); }
}

// 1) かすかな手ブレ（全体1pxシフト）は shake
{
  // textured bg so shift creates diffs everywhere
  const prev = makeRgba([40, 50, 40], d => {
    for (let y = 0; y < AH; y += 3) for (let x = 0; x < AW; x += 3) {
      const i = (y * AW + x) * 4;
      d[i] = 40 + (x % 17); d[i + 1] = 50 + (y % 13); d[i + 2] = 45;
    }
  });
  const cur = globalShift(prev, 1, 1);
  const r = analyze(cur, prev);
  assert('global 1px shake rejected', r.shake === true, JSON.stringify({ coverage: r.coverage, peakiness: r.peakiness, cornerHits: r.cornerHits }));
}

// 2) 往復ジッター軌道は確定しない
{
  const jitter = [];
  let x = 160;
  for (let i = 0; i < 10; i++) {
    x += (i % 2 === 0 ? 6 : -5);
    jitter.push({ x, y: 90 + (i % 3) - 1, t: 1000 + i * 33 });
  }
  assert('oscillating jitter not finalized', !shouldFinalize(jitter), `n=${jitter.length}`);
}

// 3) 正味移動が小さい手ブレ軌道は確定しない
{
  const pts = [];
  for (let i = 0; i < 8; i++) pts.push({ x: 150 + Math.sin(i) * 4, y: 90 + Math.cos(i) * 3, t: 1000 + i * 33 });
  assert('small net displacement not finalized', !shouldFinalize(pts));
}

// 4) 明確な横断は確定する
{
  const xs = [40, 80, 120, 160, 200, 240, 280];
  const track = [];
  let prev = makeRgba();
  let t = 1000;
  for (const cx of xs) {
    const cur = makeRgba([50, 60, 50], d => stampDisk(d, cx, 95, 5, [200, 200, 200]));
    const r = analyze(cur, prev);
    prev = cur;
    t += 33;
    if (r.peak) track.push({ ...r.peak, t });
  }
  assert('clear cross produces peaks', track.length >= 4, `n=${track.length}`);
  assert('clear cross finalized', shouldFinalize(track), `n=${track.length} dx=${track.length>1?track.at(-1).x-track[0].x:0}`);
}

// 5) 肌色指の横断も確定
{
  const xs = [50, 100, 150, 200, 250, 300];
  const track = [];
  let prev = makeRgba();
  let t = 1000;
  for (const cx of xs) {
    const cur = makeRgba([50, 60, 50], d => stampDisk(d, cx, 92, 4, [160, 110, 90]));
    const r = analyze(cur, prev);
    prev = cur; t += 33;
    if (r.peak && !r.shake) track.push({ ...r.peak, t });
  }
  assert('fingertip cross finalized', shouldFinalize(track), `n=${track.length}`);
}

// 6) 2点だけでは確定しない
{
  assert('2-point track rejected', !shouldFinalize([{ x: 40, y: 90, t: 1 }, { x: 280, y: 92, t: 40 }]));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
