// 検出コア（detector.js）の合成フレームテスト
//   node test-cross-catch.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Core = require('./detector.js');

const AW = 480, AH = 270;
// index.html と同じ: 検出領域はガイドより広く、計測判定はガイド枠（10%〜90%）基準
const ROI = { x0: 0.02, x1: 0.98, y0: 0.30, y1: 0.70 };
const GUIDE = { x0: 0.10, x1: 0.90 };
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
    const trk = Core.createTracker({ aw: AW, roiX0: GUIDE.x0, roiX1: GUIDE.x1 });
    const kinds = {};
    let hit = null, hitAt = -1, points = 0, maxPts = 0;
    for (let i = 0; i < frames.length; i++) {
        const t = 1000 + i * (opts.dt || DT);
        const r = det.feed(frames[i], t);
        kinds[r.kind] = (kinds[r.kind] || 0) + 1;
        if (r.kind === 'point') { if (trk.push(r.point)) points++; }
        else if (r.kind === 'global') trk.reset();
        trk.prune(t);
        maxPts = Math.max(maxPts, trk.length);
        if (!hit && i > 3) {
            const h = trk.evaluate(null, r.kind !== 'point');
            if (h) { hit = h; hitAt = i; }
        }
    }
    return { hit, hitAt, points, kinds, maxPts };
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

// ---- 速球（プロ野球レベル）---------------------------------------------
const speedOf = (hit) => Core.toKmh(hit.fracPerSec, 18.44, 0.33);
/** 速度 kmh の球を fps で撮影したフレーム列（モーションブラー付き） */
function fastBall({ kmh, fps, bg, r = 3, contrast = 150, exposureFrac = 0.8, noise = 4 }) {
    const visibleM = 18.44 * 0.33;
    const pxPerSec = (kmh / 3.6) / visibleM * AW;
    const pxPerFrame = pxPerSec / fps;
    const blur = pxPerFrame * exposureFrac;                 // 露光中の移動＝筋の長さ
    const level = Math.max(1, Math.round(contrast * Math.min(1, (2 * r) / Math.max(2 * r, blur)))); // 筋は暗くなる
    const frames = [];
    for (let i = 0; i < 10; i++) frames.push(withSensorNoise(bg, noise, 2000 + i));
    let x = -blur;
    let k = 0;
    while (x < AW + blur && k < 40) {
        const g = withSensorNoise(bg, noise, 2100 + k);
        const base = bg[Math.floor(cy) * AW + Math.max(0, Math.min(AW - 1, Math.round(x)))];
        const v = Math.min(255, base + level);
        // 筋: x-blur .. x の横長の帯
        drawRect(g, Math.round(x - blur), Math.round(cy - r), Math.max(1, Math.round(blur)) + 2 * r, 2 * r, v);
        frames.push(g);
        x += pxPerFrame;
        k++;
    }
    for (let i = 0; i < 10; i++) frames.push(withSensorNoise(bg, noise, 2200 + i));
    return { frames, pxPerSec };
}
for (const [kmh, fps] of [[150, 60], [160, 60], [150, 30], [130, 30], [110, 30], [175, 60]]) {
    const bg = makeNoiseBg(85, 18, 50 + kmh + fps);
    const { frames } = fastBall({ kmh, fps, bg });
    const r = run(frames, { dt: 1000 / fps });
    const got = r.hit ? speedOf(r.hit) : NaN;
    A(`速球 ${kmh}km/h @${fps}fps を検出（ブラー付き）`, !!r.hit, JSON.stringify(r.kinds) + ' maxPts=' + r.maxPts);
    if (r.hit) A(`  → 速度誤差 ±4%（測定 ${got.toFixed(1)}）`, Math.abs(got - kmh) / kmh < 0.04, `got=${got.toFixed(1)}`);
}

// 淡い筋（低コントラスト 18 レベル・ノイズ ±4）でも検出
{
    const bg = makeNoiseBg(120, 15, 77);
    const { frames } = fastBall({ kmh: 140, fps: 60, bg, contrast: 18, exposureFrac: 0.0, noise: 4 });
    const r = run(frames);
    A('低コントラストの速球を検出', !!r.hit, JSON.stringify(r.kinds) + ' maxPts=' + r.maxPts);
}

// 2 点だけの偶発ノイズ（高さ・サイズが違う）は確定しない
{
    const bg = makeNoiseBg(100, 20, 91);
    const fr = [];
    for (let i = 0; i < 10; i++) fr.push(withSensorNoise(bg, 3, 3000 + i));
    const g1 = withSensorNoise(bg, 3, 3100); drawCircle(g1, 120, AH * 0.36, 3, 240); fr.push(g1);
    const g2 = withSensorNoise(bg, 3, 3101); drawRect(g2, 300, AH * 0.55, 30, 20, 240); fr.push(g2);
    for (let i = 0; i < 10; i++) fr.push(withSensorNoise(bg, 3, 3200 + i));
    const r = run(fr, { dt: 1000 / 30 });
    A('高さ・サイズの違う 2 点ノイズは確定しない', !r.hit, JSON.stringify(r.kinds));
}

// ---- 球径から速度（焦点距離も撮影距離も不要）--------------------------
function measureBall({ radius, fromX, toX, frames, dt, diameterM }) {
    const bg = makeNoiseBg(80, 8, 42);
    const fr = crossing({
        bg,
        draw: (g, x) => drawCircle(g, x, cy, radius, 240),
        fromX, toX, frames, noise: 2
    });
    const det = Core.createDetector({ aw: AW, ah: AH, roi: ROI });
    const trk = Core.createTracker({ aw: AW, roiX0: GUIDE.x0, roiX1: GUIDE.x1 });
    let hit = null;
    const step = dt || DT;
    for (let i = 0; i < fr.length; i++) {
        const t = 1000 + i * step;
        const r = det.feed(fr[i], t);
        if (r.kind === 'point') trk.push(r.point);
        else if (r.kind === 'global') trk.reset();
        trk.prune(t);
        if (!hit && i > 3) {
            const h = trk.evaluate(null, r.kind !== 'point');
            if (h) hit = h;
        }
    }
    if (!hit) return null;
    const pxPerSec = Math.abs(toX - fromX) / ((frames - 1) * step / 1000);
    const expect = pxPerSec * (diameterM / (radius * 2)) * 3.6;
    const solved = Core.solveSpeed(hit.samples, { diameterM, sceneWidthM: 0, frameWidth: AW });
    return { hit, solved, expect, pxPerSec };
}

{
    const diameterM = 0.074;
    const radius = 9;
    const m = measureBall({ radius, fromX: 40, toX: 440, frames: 12, diameterM });
    A('球径換算で速度を返す', !!(m && m.solved && m.solved.method === 'size'), JSON.stringify(m && m.solved));
    if (m && m.solved) {
        const err = Math.abs(m.solved.kmh - m.expect) / m.expect;
        A('球径換算の速度が ±8% 以内', err < 0.08, `got=${m.solved.kmh.toFixed(1)} expect=${m.expect.toFixed(1)} diam=${m.solved.diameterPx}`);
    }
}

{
    // 横に長い筋。太さ（高さ）だけを球径として使う
    const bg = makeNoiseBg(90, 6, 88);
    const radius = 6;
    const blur = 28;
    const framesN = 8;
    const fromX = 50, toX = 420;
    const fr = crossing({
        bg,
        draw: (g, x) => drawRect(g, x - blur / 2, cy - radius, blur, radius * 2, 235),
        fromX, toX, frames: framesN, noise: 2
    });
    const det = Core.createDetector({ aw: AW, ah: AH, roi: ROI });
    const trk = Core.createTracker({ aw: AW, roiX0: GUIDE.x0, roiX1: GUIDE.x1 });
    let hit = null;
    for (let i = 0; i < fr.length; i++) {
        const t = 1000 + i * DT;
        const r = det.feed(fr[i], t);
        if (r.kind === 'point') trk.push(r.point);
        if (!hit && i > 3) {
            const h = trk.evaluate(null, r.kind !== 'point');
            if (h) hit = h;
        }
    }
    const diameterM = 0.074;
    const pxPerSec = Math.abs(toX - fromX) / ((framesN - 1) * DT / 1000);
    const expect = pxPerSec * (diameterM / (radius * 2)) * 3.6;
    const solved = hit && Core.solveSpeed(hit.samples, { diameterM, sceneWidthM: 0, frameWidth: AW });
    A('モーションブラーでも太さから速度を出す', !!(solved && solved.method === 'size'), JSON.stringify(solved));
    if (solved) {
        const err = Math.abs(solved.kmh - expect) / expect;
        A('ブラーありの速度が ±12% 以内', err < 0.12, `got=${solved.kmh.toFixed(1)} expect=${expect.toFixed(1)} diam=${solved.diameterPx}`);
    }
}

{
    const sceneWidthM = 3.2;
    const fromX = 30, toX = 450, framesN = 10;
    const bg = makeNoiseBg(100, 8, 99);
    const fr = crossing({
        bg,
        draw: (g, x) => drawRect(g, x - 8, 40, 16, 180, 30),
        fromX, toX, frames: framesN, noise: 2
    });
    const det = Core.createDetector({ aw: AW, ah: AH, roi: ROI });
    const trk = Core.createTracker({ aw: AW, roiX0: GUIDE.x0, roiX1: GUIDE.x1 });
    let hit = null;
    for (let i = 0; i < fr.length; i++) {
        const t = 1000 + i * DT;
        const r = det.feed(fr[i], t);
        if (r.kind === 'point') trk.push(r.point);
        if (!hit && i > 3) {
            const h = trk.evaluate(null, r.kind !== 'point');
            if (h) hit = h;
        }
    }
    const solved = hit && Core.solveSpeed(hit.samples, { diameterM: 0.074, sceneWidthM, frameWidth: AW });
    const pxPerSec = Math.abs(toX - fromX) / ((framesN - 1) * DT / 1000);
    // 縦に長い物体は、進行方向に垂直な長さではなく短い側（幅）を太さにする
    const widthPx = solved ? solved.diameterPx : 16;
    const expect = pxPerSec * (0.074 / widthPx) * 3.6;
    A('細長い物体は短い側の太さで速度を出す', !!(solved && (solved.method === 'size' || solved.method === 'size-hi') && solved.diameterPx > 6 && solved.diameterPx < 28), JSON.stringify(solved));
    if (solved && solved.method !== 'distance') {
        const err = Math.abs(solved.kmh - expect) / expect;
        A('短い側換算の速度が ±12% 以内', err < 0.12, `got=${solved.kmh.toFixed(1)} expect=${expect.toFixed(1)} diam=${solved.diameterPx}`);
    }
}

{
    // 指: 縦に長く、低コントラスト。球の縦幅として使うと 5km/h 未満で捨てられていた
    const fromX = 60, toX = 420, framesN = 10;
    const bg = makeNoiseBg(150, 8, 123);
    const fr = crossing({
        bg,
        draw: (g, x) => drawRect(g, x - 7, cy - 40, 14, 80, 138),
        fromX, toX, frames: framesN, noise: 2
    });
    const det = Core.createDetector({ aw: AW, ah: AH, roi: ROI });
    const trk = Core.createTracker({ aw: AW, roiX0: GUIDE.x0, roiX1: GUIDE.x1 });
    let hit = null;
    for (let i = 0; i < fr.length; i++) {
        const t = 1000 + i * (1000 / 30);
        const r = det.feed(fr[i], t);
        if (r.kind === 'point') trk.push(r.point);
        else if (r.kind === 'global') trk.reset();
        if (!hit && i > 3) {
            const h = trk.evaluate(null, r.kind !== 'point');
            if (h) hit = h;
        }
    }
    const solved = hit && Core.solveSpeed(hit.samples, {
        diameterM: 0.074, sceneWidthM: 2.8, frameWidth: AW, minKmh: 3, maxKmh: 180
    });
    A('低コントラストの指を計測する', !!(hit && solved && solved.kmh >= 3 && solved.kmh <= 180), JSON.stringify(solved));
}

// ---- カメラ解像度での半値幅（サブピクセル）------------------------------
function diskGray(size, cx, cy, radius, bg, fg) {
    const g = new Uint8Array(size * size);
    g.fill(bg);
    const r2 = radius * radius;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) g[y * size + x] = fg;
        }
    }
    return g;
}

{
    const radius = 18.5;
    const g = diskGray(160, 80, 70, radius, 30, 220);
    const h = Core.profileWidth(g, 160, 160, 80, 70, true);
    const err = Math.abs(h - radius * 2) / (radius * 2);
    A('半値幅が実直径の ±3% 以内', h > 0 && err < 0.03, `got=${h.toFixed(2)} expect=${(radius * 2).toFixed(2)}`);
}

{
    // 解析座標では太さが約 4px でも、元画像の半値幅を換算すれば速度はずれない
    const diameterM = 0.074;
    const radiusSrc = 16;
    const scale = 480 / 1920; // 元画像を解析幅へ縮めた比
    const diamAnalysis = (radiusSrc * 2) * scale;
    const fromX = 40, toX = 440, framesN = 10;
    const pxPerSec = Math.abs(toX - fromX) / ((framesN - 1) * DT / 1000);
    const expect = pxPerSec * (diameterM / diamAnalysis) * 3.6;
    const samples = [];
    for (let i = 0; i < framesN; i++) {
        const x = fromX + (toX - fromX) * (i / (framesN - 1));
        samples.push({
            x, y: AH * 0.5, t: 1000 + i * DT, w: 20, n: 40,
            diamY: diamAnalysis, diamX: diamAnalysis * 3, hPx: 8, wPx: 30
        });
    }
    const solved = Core.solveSpeed(samples, { diameterM, sceneWidthM: 12, frameWidth: AW });
    A('高解像の太さだけで速度を出す', !!(solved && solved.method === 'size-hi'), JSON.stringify(solved));
    if (solved) {
        const err = Math.abs(solved.kmh - expect) / expect;
        A('高解像換算の速度が ±1% 以内', err < 0.01, `got=${solved.kmh.toFixed(2)} expect=${expect.toFixed(2)}`);
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
