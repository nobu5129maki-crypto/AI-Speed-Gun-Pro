/**
 * MOTION LOCK v3.2 — 指先・白球・回帰テスト
 */

const AW = 320, AH = 180;
const MOTION_THR = 8;

function makeRgba(draw) {
  const data = new Uint8ClampedArray(AW * AH * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 50; data[i + 1] = 60; data[i + 2] = 50; data[i + 3] = 255;
  }
  draw(data);
  return data;
}

function stampDisk(data, cx, cy, r, rgb) {
  const [R, G, B] = rgb;
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
      if (x < 0 || x >= AW || y < 0 || y >= AH) continue;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
        const i = (y * AW + x) * 4;
        data[i] = R; data[i + 1] = G; data[i + 2] = B;
      }
    }
  }
}

function detect(data, prev) {
  if (!prev) return null;
  const roi = { left: 10, right: AW - 10, top: 40, bottom: AH - 40 };
  const colE = new Float32Array(AW);
  let sumX = 0, sumY = 0, sumW = 0, count = 0;
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
      sumX += x * w; sumY += y * w; sumW += w; count++;
      colE[x] += w;
    }
  }
  if (count < 3 || sumW <= 0) return null;
  let peakX = -1, peakE = 0;
  for (let x = roi.left; x < roi.right; x++) if (colE[x] > peakE) { peakE = colE[x]; peakX = x; }
  let meanX = sumX / sumW, meanY = sumY / sumW;
  if (peakX >= 0) {
    let pSum = 0, pW = 0;
    for (let x = Math.max(roi.left, peakX - 14); x <= Math.min(roi.right - 1, peakX + 14); x++) {
      pSum += x * colE[x]; pW += colE[x];
    }
    if (pW > 0) meanX = 0.35 * meanX + 0.65 * (pSum / pW);
  }
  return { x: meanX, y: meanY, count };
}

/** 旧バグ再現: currentTime が常に 0 だと 2 フレーム目以降が全部スキップされる */
function runWithBrokenCurrentTimeGate(positions, rgb, r = 5) {
  let prev = null;
  let lastVideoTime = -1;
  const track = [];
  let t = 1000;
  let skipped = 0;
  for (const [cx, cy] of positions) {
    const frame = makeRgba(d => stampDisk(d, cx, cy, r, rgb));
    const vt = 0; // MediaStream でよくある「進まない currentTime」
    if (vt === lastVideoTime && prev) {
      skipped++;
      continue; // v3.1 の致命バグ
    }
    lastVideoTime = vt;
    const peak = detect(frame, prev);
    prev = frame;
    t += 33;
    if (peak) track.push({ ...peak, t });
  }
  return { track, skipped };
}

function runAlways(positions, rgb, r = 5) {
  let prev = makeRgba(() => {});
  const track = [];
  let t = 1000;
  for (const [cx, cy] of positions) {
    const frame = makeRgba(d => stampDisk(d, cx, cy, r, rgb));
    const peak = detect(frame, prev);
    prev = frame;
    t += 33;
    if (peak) track.push({ ...peak, t });
  }
  return track;
}

function shouldCatch(track, canvasW = 1280) {
  if (track.length < 2) return false;
  const scale = canvasW / AW;
  const dx = Math.abs(track.at(-1).x - track[0].x) * scale;
  const dy = Math.abs(track.at(-1).y - track[0].y) * scale;
  return dx >= Math.max(canvasW * 0.03, 18) && dx >= dy * 0.35;
}

let passed = 0, failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; console.log('✓', name); }
  else { failed++; console.error('✗', name, detail); }
}

const xs = [30, 70, 110, 150, 190, 230, 270, 300];

{
  const broken = runWithBrokenCurrentTimeGate(xs.map(x => [x, 90]), [230, 230, 230], 5);
  assert('old currentTime=0 bug skips most frames', broken.skipped >= 6, `skipped=${broken.skipped} n=${broken.track.length}`);
  assert('old bug fails to catch white ball', !shouldCatch(broken.track), `n=${broken.track.length}`);
}

{
  const track = runAlways(xs.map(x => [x, 90]), [230, 230, 230], 5);
  assert('v3.2 white ball L→R caught', shouldCatch(track), `n=${track.length} dx=${track.length>1?track.at(-1).x-track[0].x:0}`);
}

{
  const track = runAlways(xs.map(x => [x, 95]), [160, 110, 90], 4);
  assert('skin-tone fingertip L→R caught', shouldCatch(track), `n=${track.length}`);
}

{
  const track = runAlways(xs.map(x => [x, 92]), [90, 70, 55], 3);
  assert('dark small fingertip L→R caught', shouldCatch(track), `n=${track.length}`);
}

{
  const track = runAlways([...xs].reverse().map(x => [x, 88]), [150, 100, 80], 4);
  assert('fingertip R→L caught', shouldCatch(track), `n=${track.length}`);
}

{
  const track = runAlways([[40, 90], [280, 94]], [140, 100, 85], 5);
  assert('2-point finger dash caught', shouldCatch(track), `n=${track.length}`);
}

{
  let prev = makeRgba(() => {});
  const track = [];
  for (let i = 0; i < 8; i++) {
    const f = makeRgba(() => {});
    const peak = detect(f, prev);
    prev = f;
    if (peak) track.push({ ...peak, t: 1000 + i * 33 });
  }
  assert('static no false catch', !shouldCatch(track), `n=${track.length}`);
}

{
  // 輝度ゲートなし: L≈70 の暗い物体でも差分で拾える
  const prev = makeRgba(() => {});
  const cur = makeRgba(d => stampDisk(d, 160, 90, 4, [80, 60, 50]));
  const peak = detect(cur, prev);
  assert('dark object produces motion peak', !!peak && peak.count >= 3, JSON.stringify(peak));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
