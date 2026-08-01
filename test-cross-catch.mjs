/**
 * CROSS CATCH v3.1 — 合成白球横断テスト
 * ブラウザなしで列ピーク＋確定ロジックを検証する
 */

const AW = 360, AH = 203;
const BRIGHT_THR = 110;
const MOTION_THR = 10;
const FG_THR = 14;
const BG_ALPHA = 0.04;
const MIN_COL_ENERGY = 80;

function makeFrame(draw) {
  const luma = new Float32Array(AW * AH);
  luma.fill(45);
  draw(luma);
  return luma;
}

function stampBall(luma, cx, cy, r = 5, brightness = 230) {
  const r2 = r * r;
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
      if (x < 0 || x >= AW || y < 0 || y >= AH) continue;
      const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (d <= r2) luma[y * AW + x] = brightness;
      else if (d <= r2 * 2.2) luma[y * AW + x] = Math.max(luma[y * AW + x], brightness * 0.55); // soft edge / blur
    }
  }
}

function stampStreak(luma, x0, x1, cy, brightness = 200) {
  const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
  for (let x = lo; x <= hi; x++) {
    for (let dy = -3; dy <= 3; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= AH || x < 0 || x >= AW) continue;
      const fade = 1 - Math.abs(dy) / 4;
      luma[y * AW + x] = Math.max(luma[y * AW + x], brightness * fade);
    }
  }
}

function detectPeak(luma, prevLuma, bgLuma, roi) {
  const colE = new Float32Array(AW);
  const colY = new Float32Array(AW);
  const colYW = new Float32Array(AW);
  let hitPixels = 0, brightHits = 0;

  for (let y = roi.top; y < roi.bottom; y++) {
    const row = y * AW;
    for (let x = roi.left; x < roi.right; x++) {
      const p = row + x;
      const L = luma[p];
      const motion = Math.abs(L - prevLuma[p]);
      const fg = Math.abs(L - bgLuma[p]);
      if (motion < 6) bgLuma[p] = bgLuma[p] * (1 - BG_ALPHA) + L * BG_ALPHA;

      const bright = L >= BRIGHT_THR;
      const rising = (L - prevLuma[p]) > 7;
      const signal = Math.max(motion, fg * 0.9);
      let keep = false, w = 0;
      if (bright && signal >= MOTION_THR * 0.55) {
        keep = true; w = signal * (1.2 + (L - BRIGHT_THR) / 80); brightHits++;
      } else if ((rising || fg > FG_THR) && L > 85 && signal >= MOTION_THR) {
        keep = true; w = signal * (0.7 + L / 255);
      } else if (signal >= MOTION_THR * 1.8 && L > 70) {
        keep = true; w = signal * 0.55;
      }
      if (!keep) continue;
      colE[x] += w;
      colY[x] += y * w;
      colYW[x] += w;
      hitPixels++;
    }
  }

  let peakX = -1, peakE = 0;
  for (let x = roi.left; x < roi.right; x++) {
    if (colE[x] > peakE) { peakE = colE[x]; peakX = x; }
  }
  if (peakX < 0 || peakE < MIN_COL_ENERGY || hitPixels < 2) return null;

  let sumX = 0, sumW = 0, sumY = 0;
  for (let x = Math.max(roi.left, peakX - 10); x <= Math.min(roi.right - 1, peakX + 10); x++) {
    const e = colE[x];
    if (e <= 0) continue;
    sumX += x * e; sumW += e;
    if (colYW[x] > 0) sumY += (colY[x] / colYW[x]) * e;
  }
  if (sumW <= 0) return null;
  return { x: sumX / sumW, y: sumY / sumW, energy: peakE, brightHits, hits: hitPixels };
}

function runSequence(positions, { streak = false, r = 5 } = {}) {
  const roi = { left: 20, right: AW - 20, top: 50, bottom: AH - 50 };
  let prev = makeFrame(() => {});
  let bg = new Float32Array(prev);
  // warm background
  for (let i = 0; i < 5; i++) {
    const f = makeFrame(() => {});
    detectPeak(f, prev, bg, roi);
    prev = f;
  }
  const track = [];
  let t = 1000;
  for (let i = 0; i < positions.length; i++) {
    const [cx, cy] = positions[i];
    const frame = makeFrame((luma) => {
      if (streak && i > 0) stampStreak(luma, positions[i - 1][0], cx, cy);
      stampBall(luma, cx, cy, r);
    });
    const peak = detectPeak(frame, prev, bg, roi);
    prev = frame;
    t += 33;
    if (peak) track.push({ ...peak, t });
  }
  return track;
}

function shouldCatch(track, canvasW = 1280) {
  if (track.length < 2) return false;
  const first = track[0], last = track[track.length - 1];
  // scale analysis -> canvas roughly
  const scale = canvasW / AW;
  const dx = Math.abs(last.x - first.x) * scale;
  const dy = Math.abs(last.y - first.y) * scale;
  const dt = (last.t - first.t) / 1000;
  const horizontalCross = dx >= Math.max(canvasW * 0.045, 28) && dx >= dy * 0.45;
  const fastDash = dt < 0.22 && dx >= Math.max(canvasW * 0.035, 22);
  return horizontalCross || fastDash;
}

let passed = 0, failed = 0;
function assert(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log('✓', name);
  } else {
    failed++;
    console.error('✗', name, detail);
  }
}

// 1) 左→右の白球
{
  const xs = [40, 70, 100, 130, 160, 190, 220, 250, 280, 310];
  const track = runSequence(xs.map(x => [x, 100]));
  assert('L→R white ball detected across frames', track.length >= 4, `track=${track.length}`);
  assert('L→R travel caught', shouldCatch(track), `n=${track.length} dx=${track.length ? track.at(-1).x - track[0].x : 0}`);
}

// 2) 右→左
{
  const xs = [310, 280, 250, 220, 190, 160, 130, 100, 70, 40];
  const track = runSequence(xs.map(x => [x, 105]));
  assert('R→L white ball caught', shouldCatch(track), `n=${track.length}`);
}

// 3) 速い（少ないフレーム）
{
  const xs = [50, 140, 230, 320];
  const track = runSequence(xs.map(x => [x, 98]), { r: 4 });
  assert('fast 4-frame ball caught', shouldCatch(track), `n=${track.length} dx=${track.length>1?track.at(-1).x-track[0].x:0}`);
}

// 4) モーションブラー帯
{
  const xs = [60, 120, 180, 240, 300];
  const track = runSequence(xs.map(x => [x, 102]), { streak: true, r: 3 });
  assert('blur streak ball caught', shouldCatch(track), `n=${track.length}`);
}

// 5) 小さい遠方球
{
  const xs = [55, 95, 135, 175, 215, 255, 295];
  const track = runSequence(xs.map(x => [x, 100]), { r: 2 });
  assert('small distant ball caught', shouldCatch(track), `n=${track.length}`);
}

// 6) 静止シーンはキャッチしない
{
  const xs = Array.from({ length: 8 }, () => [180, 100]);
  // no ball stamps - just empty
  const roi = { left: 20, right: AW - 20, top: 50, bottom: AH - 50 };
  let prev = makeFrame(() => {});
  let bg = new Float32Array(prev);
  const track = [];
  for (let i = 0; i < 8; i++) {
    const f = makeFrame(() => {});
    const peak = detectPeak(f, prev, bg, roi);
    prev = f;
    if (peak) track.push(peak);
  }
  assert('static scene no false catch', !shouldCatch(track.length ? track.map((p,i)=>({...p,t:1000+i*33})) : []), `n=${track.length}`);
}

// 7) 2点だけでも大きな水平移動ならキャッチ
{
  const track = runSequence([[60, 100], [300, 104]], { r: 5 });
  assert('2-point long dash caught', shouldCatch(track), `n=${track.length}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
