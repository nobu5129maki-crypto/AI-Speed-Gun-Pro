// 検出コア（detector.js）の合成フレームテスト
//   node test-cross-catch.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Core = require('./detector.js');

const AW = 480, AH = 270;
const ROI = { x0: 0.10, x1: 0.90, y0: 0.335, y1: 0.665 };
const FPS = 60;
const DT = 1000 / FPS;

let pass = 0, fail = 0;
const A = (name, cond, detail = '') => {
    if (cond) { pass++; console.log('✓', name); }
    else { fail++; console.error('✗', name, detail); }
};

// ---- 合成フレーム生成 -------------------------------------------------------
function makeNoiseBg(mean, amp, seed = 7) {
    let s = seed;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const g = new Uint8Array(AW * AH);
    for (let i = 0; i < g.length; i++) g[i] = Math.max(0, Math.min(255, Math.round(mean + (rnd() - 0.5) * 2 * amp)));
    return g;
}
function withSensorNoise(base, amp, seed) {
    let s = seed;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const g = new Uint8Array(base.length);
    for (let i = 0; i < g.length; i++) g[i] = Math.max(0, Math.min(255, Math.round(base[i] + (rnd() - 0.5) * 2 * amp)));
    return g;
}
function drawCircle(g, cx, cy, r, v) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
        for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
            if (x < 0 || x >= AW || y < 0 || y >= AH) continue;
            if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) g[y * AW + x] = v;
        }
    }
}
function drawRect(g, x0, y0, w, h, v) {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(AH, y0 + h); y++) {
        for (let x = Math.max(0, Math.floor(x0)); x < Math.min(AW, x0 + w); x++) g[y * AW + x] = v;
    }
}
function shiftX(g, s) {
    const out = new Uint8Array(g.length);
    for (let y = 0; y < AH; y++) {
        for (let x = 0; x < AW; x++) {
            const sx = Math.max(0, Math.min(AW - 1, x - s));
            out[y * AW + x] = g[y * AW + sx];
        }
    }
    return out;
}

// ---- シナリオ実行 ---------------------------------------------------------
function run(frames, opts = {}) {
    const det = Core.createDetector({ aw: AW, ah: AH, roi: ROI });
    const trk = Core.createTracker({ aw: AW, roiX0: ROI.x0, roiX1: ROI.x1 });
    const kinds = {};
    let hit = null, hitAt = -1, points = 0;
    for (let i = 0; i < frames.length; i++) {
        const t = 1000 + i * (opts.dt || DT);
        const r = det.feed(frames[i], t);
        kinds[r.kind] = (kinds[r.kind] || 0) + 1;
        if (r.kind === 'point') { if (trk.push(r.point)) points++; }
        else if (r.kind === 'global') trk.reset();
        trk.prune(t);
        if (!hit && i > 3) {
            const h = trk.evaluate();
            if (h) { hit = h; hitAt = i; }
        }
    }
    return { hit, hitAt, points, kinds };
}

/** 物体を左→右に一定速度で横切らせたフレーム列 */
function crossing({ bg, draw, fromX, toX, frames, noise = 0, pre = 12, post = 6 }) {
    const out = [];
    for (let i = 0; i < pre; i++) out.push(noise ? withSensorNoise(bg, noise, 100 + i) : bg);
    for (let i = 0; i < frames; i++) {
        const g = noise ? withSensorNoise(bg, noise, 200 + i) : Uint8Array.from(bg);
        const x = fromX + (toX - fromX) * (i / (frames - 1));
        draw(g, x);
        out.push(g);
    }
    for (let i = 0; i < post; i++) out.push(noise ? withSensorNoise(bg, noise, 300 + i) : bg);
    return out;
}

const cy = AH * 0.5;
const kmhOf = (hit) => Core.toKmh(hit.fracPerSec, 18.44, 0.33);

// 1. 暗背景に明るい小球（遠いボール、3px）
{
    const bg = makeNoiseBg(60, 12);
    const fr = crossing({ bg, draw: (g, x) => drawCircle(g, x, cy, 3, 235), fromX: 20, toX: 460, frames: 9, noise: 3 });
    const r = run(fr);
    A('小さな明るいボール（9フレーム横断）を検出', !!r.hit, JSON.stringify(r.kinds));
}

// 2. 明るい背景（白壁）に暗い指（幅 40px・枠を縦に貫く）
{
    const bg = makeNoiseBg(205, 4);
    const fr = crossing({ bg, draw: (g, x) => drawRect(g, x - 20, 0, 40, AH, 70), fromX: 10, toX: 470, frames: 24, noise: 2 });
    const r = run(fr);
    A('白壁で指の横断を検出', !!r.hit, JSON.stringify(r.kinds));
    if (r.hit) {
        const expectFrac = (460 / AW) / ((24 - 1) * DT / 1000);
        const err = Math.abs(r.hit.fracPerSec - expectFrac) / expectFrac;
        A('指の速度が ±12% 以内', err < 0.12, `got=${r.hit.fracPerSec.toFixed(3)} expect=${expectFrac.toFixed(3)} kmh=${kmhOf(r.hit).toFixed(1)}`);
    }
}

// 3. 模様のある背景に暗い指（テクスチャ背景でもパン誤判定しない）
{
    const bg = makeNoiseBg(140, 45, 3);
    const fr = crossing({ bg, draw: (g, x) => drawRect(g, x - 18, 0, 36, AH, 30), fromX: 10, toX: 470, frames: 18, noise: 3 });
    const r = run(fr);
    A('模様背景で指の横断を検出', !!r.hit, JSON.stringify(r.kinds));
}

// 4. 速球（4フレームで横断）
{
    const bg = makeNoiseBg(90, 20, 5);
    const fr = crossing({ bg, draw: (g, x) => drawCircle(g, x, cy, 4, 240), fromX: 60, toX: 430, frames: 4, noise: 3 });
    const r = run(fr);
    A('速球（4フレーム）を検出', !!r.hit, JSON.stringify(r.kinds) + ' pts=' + r.points);
}

// 5. 手のような大きい物体（幅 120px）も検出
{
    const bg = makeNoiseBg(120, 10, 9);
    const fr = crossing({ bg, draw: (g, x) => drawRect(g, x - 60, 0, 120, AH, 40), fromX: 20, toX: 460, frames: 20, noise: 2 });
    const r = run(fr);
    A('大きい物体（手）の横断を検出', !!r.hit, JSON.stringify(r.kinds));
}

// 6. 枠の外（上端）を通る物体は無視
{
    const bg = makeNoiseBg(80, 15, 11);
    const fr = crossing({ bg, draw: (g, x) => drawCircle(g, x, 20, 5, 240), fromX: 20, toX: 460, frames: 12, noise: 2 });
    const r = run(fr);
    A('枠外を通る物体は計測しない', !r.hit && r.points === 0, JSON.stringify(r.kinds));
}

// 7. 静止シーン＋センサーノイズ（3秒）で誤検知しない
{
    const bg = makeNoiseBg(150, 30, 13);
    const fr = [];
    for (let i = 0; i < 180; i++) fr.push(withSensorNoise(bg, 6, 500 + i));
    const r = run(fr);
    A('静止＋ノイズで誤検知しない', !r.hit, JSON.stringify(r.kinds));
}

// 8. 白壁の微動（明るさゆらぎ）で誤検知しない
{
    const bg = makeNoiseBg(215, 5, 17);
    const fr = [];
    for (let i = 0; i < 120; i++) {
        const g = withSensorNoise(bg, 4, 700 + i);
        const flick = Math.round(Math.sin(i / 3) * 6);
        for (let k = 0; k < g.length; k++) g[k] = Math.max(0, Math.min(255, g[k] + flick));
        fr.push(g);
    }
    const r = run(fr);
    A('白壁のゆらぎで誤検知しない', !r.hit, JSON.stringify(r.kinds));
}

// 9. 手ブレ（毎フレーム ±3px の横ずれ）で誤検知しない
{
    const bg = makeNoiseBg(130, 40, 19);
    const fr = [];
    for (let i = 0; i < 120; i++) fr.push(withSensorNoise(shiftX(bg, Math.round(Math.sin(i * 1.7) * 3)), 3, 900 + i));
    const r = run(fr);
    A('手ブレで誤検知しない', !r.hit, JSON.stringify(r.kinds));
}

// 10. ゆっくりしたパン（毎フレーム 2px 一方向）で誤検知しない
{
    const bg = makeNoiseBg(130, 40, 23);
    const fr = [];
    for (let i = 0; i < 90; i++) fr.push(withSensorNoise(shiftX(bg, i * 2), 3, 1100 + i));
    const r = run(fr);
    A('カメラのパンで誤検知しない', !r.hit, JSON.stringify(r.kinds));
}

// 11. 露出変化（全体が徐々に明るくなる）で誤検知しない
{
    const bg = makeNoiseBg(100, 25, 29);
    const fr = [];
    for (let i = 0; i < 90; i++) {
        const g = withSensorNoise(bg, 3, 1300 + i);
        for (let k = 0; k < g.length; k++) g[k] = Math.min(255, g[k] + Math.round(i * 0.8));
        fr.push(g);
    }
    const r = run(fr);
    A('露出変化で誤検知しない', !r.hit, JSON.stringify(r.kinds));
}

// 12. 枠内に置いたまま止まっている指は吸収され、計測されない
{
    const bg = makeNoiseBg(190, 6, 31);
    const fr = [];
    for (let i = 0; i < 10; i++) fr.push(withSensorNoise(bg, 2, 1500 + i));
    for (let i = 0; i < 120; i++) {
        const g = withSensorNoise(bg, 2, 1600 + i);
        drawRect(g, 230, 0, 30, AH, 60);
        fr.push(g);
    }
    const r = run(fr);
    A('止まった指は計測しない', !r.hit, JSON.stringify(r.kinds));
}

// 13. 右→左でも検出
{
    const bg = makeNoiseBg(70, 15, 37);
    const fr = crossing({ bg, draw: (g, x) => drawCircle(g, x, cy, 5, 230), fromX: 460, toX: 20, frames: 10, noise: 3 });
    const r = run(fr);
    A('右→左の横断を検出', !!r.hit, JSON.stringify(r.kinds));
}

// 14. 30fps でもボールを検出（5フレーム横断）
{
    const bg = makeNoiseBg(90, 20, 41);
    const fr = crossing({ bg, draw: (g, x) => drawCircle(g, x, cy, 4, 240), fromX: 40, toX: 440, frames: 5, noise: 3 });
    const r = run(fr, { dt: 1000 / 30 });
    A('30fps・5フレーム横断を検出', !!r.hit, JSON.stringify(r.kinds) + ' pts=' + r.points);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
