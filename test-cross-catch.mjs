/**
 * FRAME FOCUS v4.1 — 枠内横断は通し、中央線なし／手ブレ硬直拒否なし
 */
const AW = 240, AH = 135;
const FRAME_X0 = 0.10, FRAME_X1 = 0.90, FRAME_Y0 = 0.335, FRAME_Y1 = 0.665;
const MOTION_THR = 7, MIN_DX_RATIO = 0.035;

function grayFrame(draw) {
  const g = new Uint8Array(AW * AH);
  g.fill(50);
  if (draw) draw(g);
  return g;
}
function stamp(g, cx, cy, r, val = 210) {
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if (x < 0 || x >= AW || y < 0 || y >= AH) continue;
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) g[y * AW + x] = val;
  }
}
function peak(prev, cur) {
  const x0 = Math.floor(AW * FRAME_X0), x1 = Math.ceil(AW * FRAME_X1);
  const y0 = Math.floor(AH * FRAME_Y0), y1 = Math.ceil(AH * FRAME_Y1);
  const col = new Float32Array(AW);
  let mp = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const d = Math.abs(cur[y * AW + x] - prev[y * AW + x]);
    if (d < MOTION_THR) continue;
    col[x] += d * d; mp++;
  }
  if (mp < 2) return null;
  let peakX = -1, peakE = 0;
  for (let x = x0; x < x1; x++) if (col[x] > peakE) { peakE = col[x]; peakX = x; }
  return peakX < 0 ? null : { x: peakX, y: (y0 + y1) / 2 };
}
function shouldFire(pts, canvasW = 1280) {
  if (pts.length < 2) return false;
  const scale = canvasW / AW;
  const dx = Math.abs(pts.at(-1).x - pts[0].x) * scale;
  const dy = Math.abs(pts.at(-1).y - pts[0].y) * scale;
  const need = Math.max(canvasW * MIN_DX_RATIO, 22);
  return dx >= need && dx >= dy * 0.4;
}

let p = 0, f = 0;
const assert = (n, c, d = '') => { if (c) { p++; console.log('✓', n); } else { f++; console.error('✗', n, d); } };

{
  const xs = [30, 60, 90, 120, 150, 180, 210];
  const track = [];
  let prev = grayFrame();
  let t = 0;
  for (const cx of xs) {
    const cur = grayFrame(g => stamp(g, cx, Math.floor(AH * 0.5), 4, 200));
    const pk = peak(prev, cur); prev = cur; t += 33;
    if (pk) track.push({ ...pk, t });
  }
  assert('in-frame finger fires', shouldFire(track), 'n=' + track.length);
}
{
  const xs = [40, 80, 120, 160, 200];
  const track = [];
  let prev = grayFrame();
  let t = 0;
  for (const cx of xs) {
    const cur = grayFrame(g => stamp(g, cx, Math.floor(AH * 0.5), 5, 230));
    const pk = peak(prev, cur); prev = cur; t += 33;
    if (pk) track.push({ ...pk, t });
  }
  assert('in-frame ball fires', shouldFire(track), 'n=' + track.length);
}
{
  // outside frame vertically should not peak strongly in ROI
  let prev = grayFrame();
  let hits = 0;
  for (const cx of [40, 100, 160]) {
    const cur = grayFrame(g => stamp(g, cx, 10, 4, 220)); // near top, outside guide
    const pk = peak(prev, cur); prev = cur;
    if (pk) hits++;
  }
  assert('outside-frame motion mostly ignored', hits <= 1, 'hits=' + hits);
}
assert('2pt swipe ok', shouldFire([{ x: 30, y: 70, t: 0 }, { x: 200, y: 72, t: 120 }]));

console.log(`\n${p} passed, ${f} failed`);
if (f) process.exit(1);
