/* AI Speed Gun Pro — 検出コア v6.0（ブラウザ / Node 共用）
 *
 * 方式: 背景モデル（選択的更新）＋ノイズ適応しきい値＋前景重心追跡。
 *  - 指・ボール・物体など「枠内を横切る塊」を大小問わず検出する
 *  - 画面全体が変わる（手ブレ・パン・露出変化）ときは背景を即リセットして誤検知を防ぐ
 *  - 軌道は直線性・方向一貫性・横断距離で検証してから速度を確定する
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SpeedGunCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const DETECTOR_DEFAULTS = {
        aw: 480,
        ah: 270,
        roi: { x0: 0.10, x1: 0.90, y0: 0.335, y1: 0.665 }, // HTML のガイド枠と一致
        // しきい値: 3x3 平滑化した差分分布の下位パーセンタイル（＝背景ノイズ）から算出
        // 平滑化で画素ノイズを約 1/3 に抑え、速球のモーションブラー（淡い筋）も拾う
        minThr: 7,
        maxThr: 72,
        noiseGain: 2.6,
        noiseOffset: 4,
        noisePercentile: 0.55,
        // 前景の大きさ
        minPixels: 6,          // これ未満はノイズ
        maxFgFrac: 0.45,       // ROI の 45% 超が動く＝カメラ全体の動き
        globalColsFrac: 0.85,  // 列の 85% 超で前景あり かつ
        globalColsMinFg: 0.15, //   前景 15% 超 ＝ 全体ずれ
        maxSpreadX: 0.20,      // 前景の横広がり（ROI 幅比・標準偏差）
        maxSpreadY: 0.40,      // 前景の縦広がり（ROI 高さ比・標準偏差）
        // 背景更新
        bgAlpha: 0.10,
        bgAlphaFg: 0.02,
        stationaryMs: 900,     // 動かない物体はこの時間で背景に吸収
        stationaryStep: 0.004, // 幅比。これ未満の移動は「止まっている」
        // パン（カメラの横振り）検出: ROI 外の上下バンドの列プロファイルで推定
        panBandFrac: 0.12,
        panMaxShift: 8,
        panMinShift: 2,
        panRatio: 0.7,
        panTexturedCols: 0.40,
        panGradThr: 6
    };

    const TRACKER_DEFAULTS = {
        aw: 480,
        roiX0: 0.10,
        roiX1: 0.90,
        maxAgeMs: 1200,
        minPoints: 3,
        zoneRatio: 0.12,     // 左右ゾーン幅（枠幅比）
        minSpan: 0.18,       // 最低横断距離（枠幅比）
        minDxFrac: 0.06,     // 最低横断距離（画面幅比）
        minStepFrac: 0.003,  // これ未満の移動は同一点扱い
        maxJumpFrac: 0.65,   // 枠幅比。これ超のジャンプは別物体
        minDt: 0.012,
        maxDt: 1.4,
        twoPointMaxDt: 0.25, // 2点のみで確定できる最大時間（両ゾーン通過時）
        // 速球用 2 点確定（30fps で枠内に 2 フレームしか映らない球）
        fastTwoPointMaxDt: 0.09, // 2 点の時間差がこれ以下
        fastTwoPointSpan: 0.20,  // 枠幅比でこれ以上移動
        fastTwoPointDyRatio: 0.35, // |dy| <= dx * 比
        fastTwoPointSizeRatio: 3.0, // 前景サイズ比がこれ以下（同一物体）
        minLinearity: 0.42,
        minDirection: 0.52,
        minHorizRatio: 0.38,
        dyRatio: 0.55
    };

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

    /** RGBA → グレースケール（out を再利用） */
    function toGray(rgba, out) {
        const n = out.length;
        for (let p = 0, i = 0; p < n; p++, i += 4) {
            out[p] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
        }
        return out;
    }

    function createDetector(userOpts) {
        const o = Object.assign({}, DETECTOR_DEFAULTS, userOpts || {});
        const aw = o.aw, ah = o.ah;
        const roi = {
            x0: Math.floor(aw * o.roi.x0),
            x1: Math.ceil(aw * o.roi.x1),
            y0: Math.floor(ah * o.roi.y0),
            y1: Math.ceil(ah * o.roi.y1)
        };
        const roiW = roi.x1 - roi.x0;
        const roiH = roi.y1 - roi.y0;
        const roiN = roiW * roiH;

        let bg = null;                      // Float32Array(aw*ah) 背景（ROI のみ使用）
        const diffBuf = new Uint8Array(aw * ah);   // |gray - bg|
        const hsum = new Uint16Array(aw * ah);     // 横 3 画素和
        const smooth = new Uint8Array(aw * ah);    // 3x3 平均
        // 平滑化用に ROI を 1 画素外側まで差分計算する
        const ex0 = Math.max(0, roi.x0 - 1), ex1 = Math.min(aw, roi.x1 + 1);
        const ey0 = Math.max(0, roi.y0 - 1), ey1 = Math.min(ah, roi.y1 + 1);
        const hist = new Int32Array(256);
        const colHit = new Uint8Array(aw);
        const profile = new Float32Array(aw);
        let prevProfile = null;
        let lastPt = null;
        let stationarySince = 0;
        let frames = 0;

        function reset() {
            bg = null;
            prevProfile = null;
            lastPt = null;
            stationarySince = 0;
            frames = 0;
        }

        /** 上下バンドの列プロファイルから横パンを推定 */
        function estimatePan(gray) {
            const band = Math.max(2, Math.floor(ah * o.panBandFrac));
            profile.fill(0);
            for (let y = 0; y < band; y++) {
                const r1 = y * aw, r2 = (ah - 1 - y) * aw;
                for (let x = 0; x < aw; x++) profile[x] += gray[r1 + x] + gray[r2 + x];
            }
            const inv = 1 / (band * 2);
            for (let x = 0; x < aw; x++) profile[x] *= inv;

            let result = { panning: false, shift: 0 };
            if (prevProfile) {
                // テクスチャ量: 勾配のある列の割合（白壁など平坦なら判定しない）
                let textured = 0;
                for (let x = 1; x < aw; x++) {
                    if (Math.abs(prevProfile[x] - prevProfile[x - 1]) >= o.panGradThr) textured++;
                }
                if (textured >= aw * o.panTexturedCols) {
                    const m = o.panMaxShift;
                    let best = 0, bestSad = Infinity, sad0 = 0;
                    for (let s = -m; s <= m; s++) {
                        let sad = 0;
                        for (let x = m; x < aw - m; x++) sad += Math.abs(profile[x] - prevProfile[x + s]);
                        if (s === 0) sad0 = sad;
                        if (sad < bestSad) { bestSad = sad; best = s; }
                    }
                    if (Math.abs(best) >= o.panMinShift && bestSad < sad0 * o.panRatio) {
                        result = { panning: true, shift: best };
                    }
                }
            } else {
                prevProfile = new Float32Array(aw);
            }
            prevProfile.set(profile);
            return result;
        }

        function updateBg(gray, thr, fgAlpha) {
            const a0 = o.bgAlpha;
            const a1 = fgAlpha == null ? o.bgAlphaFg : fgAlpha;
            for (let y = roi.y0; y < roi.y1; y++) {
                const row = y * aw;
                for (let x = roi.x0; x < roi.x1; x++) {
                    const i = row + x;
                    const a = smooth[i] >= thr ? a1 : a0;
                    bg[i] += a * (gray[i] - bg[i]);
                }
            }
        }

        /** 重心を通る前景の幅と高さ（モーションブラーの長軸と、球の太さ） */
        function blobExtent(smoothImg, thr, cx, cy) {
            const x = clamp(Math.round(cx), roi.x0, roi.x1 - 1);
            const y = clamp(Math.round(cy), roi.y0, roi.y1 - 1);
            let top = y, bot = y, left = x, right = x;
            for (let yy = y; yy >= roi.y0; yy--) {
                if (smoothImg[yy * aw + x] < thr) break;
                top = yy;
            }
            for (let yy = y + 1; yy < roi.y1; yy++) {
                if (smoothImg[yy * aw + x] < thr) break;
                bot = yy;
            }
            for (let xx = x; xx >= roi.x0; xx--) {
                if (smoothImg[y * aw + xx] < thr) break;
                left = xx;
            }
            for (let xx = x + 1; xx < roi.x1; xx++) {
                if (smoothImg[y * aw + xx] < thr) break;
                right = xx;
            }
            return { wPx: right - left + 1, hPx: bot - top + 1 };
        }

        /** |gray-bg| を ROI（＋1画素）で計算し、3x3 平均を smooth に書く */
        function computeSmoothDiff(gray) {
            for (let y = ey0; y < ey1; y++) {
                const row = y * aw;
                for (let x = ex0; x < ex1; x++) {
                    const i = row + x;
                    let d = gray[i] - bg[i];
                    if (d < 0) d = -d;
                    diffBuf[i] = d > 255 ? 255 : (d | 0);
                }
                for (let x = roi.x0; x < roi.x1; x++) {
                    const i = row + x;
                    const l = x > 0 ? diffBuf[i - 1] : diffBuf[i];
                    const r = x < aw - 1 ? diffBuf[i + 1] : diffBuf[i];
                    hsum[i] = l + diffBuf[i] + r;
                }
            }
            for (let y = roi.y0; y < roi.y1; y++) {
                const row = y * aw;
                const up = y > 0 ? row - aw : row;
                const dn = y < ah - 1 ? row + aw : row;
                for (let x = roi.x0; x < roi.x1; x++) {
                    smooth[row + x] = ((hsum[up + x] + hsum[row + x] + hsum[dn + x]) / 9) | 0;
                }
            }
        }

        /**
         * 1 フレーム処理。
         * @param {Uint8Array} gray  aw*ah のグレースケール
         * @param {number} t  フレーム時刻 ms
         * @returns {{kind:string, point?:{x,y,t,w,n}, thr?:number, fgFrac?:number}}
         */
        function feed(gray, t) {
            frames++;
            if (!bg || bg.length !== gray.length) {
                bg = Float32Array.from(gray);
                estimatePan(gray);
                lastPt = null;
                stationarySince = 0;
                return { kind: 'init' };
            }
            const pan = estimatePan(gray);

            // 平滑化差分とヒストグラム（ROI）
            computeSmoothDiff(gray);
            hist.fill(0);
            for (let y = roi.y0; y < roi.y1; y++) {
                const row = y * aw;
                for (let x = roi.x0; x < roi.x1; x++) hist[smooth[row + x]]++;
            }
            let acc = 0, pct = 0;
            const target = roiN * o.noisePercentile;
            for (pct = 0; pct < 256; pct++) {
                acc += hist[pct];
                if (acc >= target) break;
            }
            const thr = clamp(Math.round(pct * o.noiseGain + o.noiseOffset), o.minThr, o.maxThr);

            // 前景統計
            colHit.fill(0);
            let fg = 0, sw = 0, sx = 0, sy = 0, sxx = 0, syy = 0;
            let minX = aw, maxX = -1;
            for (let y = roi.y0; y < roi.y1; y++) {
                const row = y * aw;
                for (let x = roi.x0; x < roi.x1; x++) {
                    const d = smooth[row + x];
                    if (d < thr) continue;
                    fg++;
                    sw += d;
                    sx += x * d; sy += y * d;
                    sxx += x * x * d; syy += y * y * d;
                    colHit[x] = 1;
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                }
            }
            // 前景が検出領域の左右端に接している＝物体が一部しか映っておらず重心が内側に寄る
            const clipped = minX <= roi.x0 + 1 || maxX >= roi.x1 - 2;
            const fgFrac = fg / roiN;
            let activeCols = 0;
            for (let x = roi.x0; x < roi.x1; x++) activeCols += colHit[x];

            const isGlobal = pan.panning
                || fgFrac > o.maxFgFrac
                || (activeCols > roiW * o.globalColsFrac && fgFrac > o.globalColsMinFg);
            if (isGlobal) {
                bg.set(gray);
                lastPt = null;
                stationarySince = 0;
                return { kind: 'global', thr, fgFrac, pan: pan.shift };
            }

            if (fg < o.minPixels) {
                updateBg(gray, thr);
                lastPt = null;
                stationarySince = 0;
                return { kind: 'none', thr, fgFrac };
            }

            const mx = sx / sw, my = sy / sw;
            const spreadX = Math.sqrt(Math.max(0, sxx / sw - mx * mx));
            const spreadY = Math.sqrt(Math.max(0, syy / sw - my * my));
            if (spreadX > roiW * o.maxSpreadX || spreadY > roiH * o.maxSpreadY) {
                // 大きすぎる／散らばりすぎ（体・全体ずれ）: 背景をやや速めに追従
                updateBg(gray, thr, o.bgAlpha * 0.5);
                lastPt = null;
                stationarySince = 0;
                return { kind: 'wide', thr, fgFrac, spreadX, spreadY };
            }

            // 止まっている物体は背景に吸収
            if (lastPt && Math.hypot(mx - lastPt.x, my - lastPt.y) < aw * o.stationaryStep) {
                if (!stationarySince) stationarySince = t;
                else if (t - stationarySince > o.stationaryMs) {
                    bg.set(gray);
                    lastPt = null;
                    stationarySince = 0;
                    return { kind: 'absorbed', thr, fgFrac };
                }
            } else {
                stationarySince = 0;
            }
            lastPt = { x: mx, y: my };
            updateBg(gray, thr);

            const extent = blobExtent(smooth, thr, mx, my);
            return {
                kind: 'point',
                point: {
                    x: mx, y: my, t, w: sw, n: fg, clipped,
                    sx: spreadX, sy: spreadY,
                    wPx: extent.wPx, hPx: extent.hPx
                },
                thr,
                fgFrac,
                spreadX,
                spreadY
            };
        }

        return {
            feed,
            reset,
            get roi() { return roi; },
            get frames() { return frames; },
            get options() { return o; }
        };
    }

    /** 重み付き最小二乗で軌道統計 */
    function trackStats(pts, aw) {
        if (pts.length < 2) return null;
        const a = pts[0], b = pts[pts.length - 1];
        const dt = (b.t - a.t) / 1000;
        if (dt <= 0.004) return null;

        const t0 = a.t;
        let sumW = 0, sumT = 0, sumX = 0, sumY = 0, sumTT = 0, sumTX = 0, sumTY = 0;
        for (const p of pts) {
            const w = Math.max(1, p.w || 1);
            const t = (p.t - t0) / 1000;
            sumW += w;
            sumT += w * t; sumX += w * p.x; sumY += w * p.y;
            sumTT += w * t * t; sumTX += w * t * p.x; sumTY += w * t * p.y;
        }
        const den = sumW * sumTT - sumT * sumT;
        let vx, vy;
        if (Math.abs(den) < 1e-9) {
            vx = (b.x - a.x) / dt;
            vy = (b.y - a.y) / dt;
        } else {
            vx = (sumW * sumTX - sumT * sumX) / den;
            vy = (sumW * sumTY - sumT * sumY) / den;
        }

        const dx = Math.abs(b.x - a.x);
        const dy = Math.abs(b.y - a.y);
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        const lsSpeed = Math.hypot(vx, vy);

        // 区間速度の中央値で外れ値を抑える
        const segs = [];
        for (let i = 1; i < pts.length; i++) {
            const ddt = (pts[i].t - pts[i - 1].t) / 1000;
            if (ddt <= 0.003) continue;
            segs.push(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) / ddt);
        }
        segs.sort((u, v) => u - v);
        const med = segs.length
            ? (segs.length % 2 ? segs[(segs.length - 1) >> 1]
                : 0.5 * (segs[segs.length / 2 - 1] + segs[segs.length / 2]))
            : lsSpeed;
        const speed = lsSpeed * 0.72 + med * 0.28;

        const stepMin = aw * 0.003;
        let agree = 0, tot = 0;
        const sign = Math.sign(b.x - a.x) || 1;
        for (let i = 1; i < pts.length; i++) {
            const ddx = pts[i].x - pts[i - 1].x;
            if (Math.abs(ddx) < stepMin) continue;
            tot++;
            if (Math.sign(ddx) === sign) agree++;
        }
        const dir = tot ? agree / tot : 1;

        let path = 0;
        for (let i = 1; i < pts.length; i++) {
            path += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        }
        const lin = path > 1 ? dist / path : 1;
        const horizRatio = Math.abs(vx) / (speed + 1e-6);

        return { dx, dy, dist, dt, dir, lin, speed, horizRatio, vx, vy };
    }

    function createTracker(userOpts) {
        const o = Object.assign({}, TRACKER_DEFAULTS, userOpts || {});
        const aw = o.aw;
        const left = aw * o.roiX0, right = aw * o.roiX1;
        const roiW = right - left;
        let pts = [];

        function reset() { pts = []; }

        function push(p) {
            if (pts.length) {
                const last = pts[pts.length - 1];
                const dt = p.t - last.t;
                if (dt < 4) return false;
                const jump = Math.hypot(p.x - last.x, p.y - last.y);
                if (jump > roiW * o.maxJumpFrac) {
                    pts = [];
                } else if (jump < aw * o.minStepFrac) {
                    return false;
                }
            }
            pts.push({
                x: p.x, y: p.y, t: p.t, w: p.w || 1, n: p.n || 0, clipped: !!p.clipped,
                sx: p.sx || 0, sy: p.sy || 0, wPx: p.wPx || 0, hPx: p.hPx || 0,
                diamX: p.diamX || 0, diamY: p.diamY || 0
            });
            return true;
        }

        function prune(now) {
            pts = pts.filter(q => now - q.t < o.maxAgeMs);
        }

        function needDx() {
            return Math.max(roiW * o.minSpan, aw * o.minDxFrac);
        }

        function progress() {
            const st = trackStats(pts, aw);
            if (!st) return 0;
            return Math.min(1, st.dx / needDx());
        }

        /** 軌道の横断量（枠幅比） */
        function spanFrac() {
            if (pts.length < 2) return 0;
            return Math.abs(pts[pts.length - 1].x - pts[0].x) / roiW;
        }

        /** 軌道の継続時間 ms */
        function durationMs() {
            if (pts.length < 2) return 0;
            return pts[pts.length - 1].t - pts[0].t;
        }

        function zones(list) {
            const zL = left + roiW * o.zoneRatio;
            const zR = right - roiW * o.zoneRatio;
            let sawL = false, sawR = false;
            for (const p of list) {
                if (p.x <= zL) sawL = true;
                if (p.x >= zR) sawR = true;
            }
            return { sawL, sawR, both: sawL && sawR };
        }

        function cleanTrack(list) {
            if (list.length < 3) return list.slice();
            const st = trackStats(list, aw);
            if (!st) return list.slice();
            const t0 = list[0].t;
            const tol = Math.max(4, aw * 0.06);
            const kept = [];
            for (const p of list) {
                const t = (p.t - t0) / 1000;
                const ex = list[0].x + st.vx * t;
                const ey = list[0].y + st.vy * t;
                if (Math.hypot(p.x - ex, p.y - ey) < tol) kept.push(p);
            }
            return kept.length >= 3 ? kept : list.slice();
        }

        function coreSegment(list) {
            if (list.length < 5) return list.slice();
            return list.slice(1, list.length - 1);
        }

        /** 速球の 2 点軌道: 短時間・大移動・同高さ・同サイズなら同一物体とみなす */
        function fastTwoPoint(list, st) {
            if (list.length !== 2) return false;
            if (st.dt > o.fastTwoPointMaxDt) return false;
            if (st.dx < roiW * o.fastTwoPointSpan) return false;
            if (st.dy > st.dx * o.fastTwoPointDyRatio) return false;
            const n0 = list[0].n || 1, n1 = list[1].n || 1;
            const ratio = Math.max(n0, n1) / Math.max(1, Math.min(n0, n1));
            return ratio <= o.fastTwoPointSizeRatio;
        }

        /**
         * 軌道を評価し、確定できれば速度（画面幅比 / 秒）を返す
         * @param {Array=} list  評価する点列（省略時は内部軌道）
         * @param {boolean=} settled  このフレームで新しい点が来ていない（物体が去った）
         * @returns {null | {fracPerSec:number, points:number, stats:object}}
         */
        function evaluate(list, settled) {
            const src = list || pts;
            if (src.length < 2) return null;
            const cleaned = cleanTrack(src);
            // 端で切れている点（重心が内側に寄る）は速度推定から外す。足りなければ全点を使う
            const whole = cleaned.filter(p => !p.clipped);
            const basis = whole.length >= 2 ? whole : cleaned;
            const core = coreSegment(basis);
            const use = core.length >= 2 ? core : basis;

            const z = zones(cleaned);
            const st = trackStats(use, aw);
            if (!st) return null;

            if (cleaned.length < o.minPoints || use.length < 2) {
                const zonePass = use.length >= 2 && z.both && st.dt <= o.twoPointMaxDt;
                // 2 点の速球は物体が去った後（settled）に確定し、ノイズ 2 点の即発火を防ぐ
                const fastPass = !!settled && use.length === 2 && fastTwoPoint(use, st);
                if (!zonePass && !fastPass) return null;
            } else if (use.length === 2 && !z.both) {
                // 端の点を除いて 2 点しか残らない場合も、速球ルールで同一物体を確認
                if (!(settled && fastTwoPoint(use, st))) return null;
            }
            if (!z.both && st.dx < needDx()) return null;
            if (st.dx < st.dy * o.dyRatio) return null;
            if (st.dt < o.minDt || st.dt > o.maxDt) return null;
            if (st.lin < o.minLinearity) return null;
            if (st.dir < o.minDirection) return null;
            if (st.horizRatio < o.minHorizRatio) return null;

            const endpoint = st.dist / st.dt;
            const pxPerSec = st.speed * 0.84 + endpoint * 0.16;
            return { fracPerSec: pxPerSec / aw, points: use.length, stats: st, zones: z, samples: use };
        }

        return {
            push,
            prune,
            reset,
            progress,
            spanFrac,
            durationMs,
            evaluate,
            get points() { return pts; },
            get length() { return pts.length; },
            get options() { return o; }
        };
    }

    /** 画面幅比/秒 → km/h（画面横幅の実距離 = 総距離 × 画面割合。物理換算のみ、係数補正なし） */
    function toKmh(fracPerSec, totalDistM, visibleFrac) {
        return fracPerSec * totalDistM * visibleFrac * 3.6;
    }

    /**
     * センサー水平画角と、画面に実際に見えている幅の割合から、
     * カメラから distanceM の位置での横幅（メートル）を求める。
     */
    function sceneWidthMeters(distanceM, fullHfovDeg, cropFrac) {
        if (!(distanceM > 0) || !(fullHfovDeg > 0)) return 0;
        const crop = clamp(cropFrac == null ? 1 : cropFrac, 0.05, 1);
        const half = Math.tan((fullHfovDeg * Math.PI / 180) / 2) * crop;
        return 2 * distanceM * half;
    }

    /**
     * 半値幅。横移動の球は縦方向（vertical=true）の太さをサブピクセルで測る。
     * カメラ解像度の切り出しに使う。戻り値はその画像のピクセル。
     */
    function profileWidth(gray, width, height, cx, cy, vertical) {
        const samples = [];
        if (vertical) {
            const x = clamp(Math.round(cx), 0, width - 1);
            const x0 = Math.max(0, x - 1);
            const x1 = Math.min(width - 1, x + 1);
            for (let y = 0; y < height; y++) {
                let s = 0, n = 0;
                for (let xx = x0; xx <= x1; xx++) { s += gray[y * width + xx]; n++; }
                samples.push(s / n);
            }
            return halfMaxSpan(samples, cy);
        }
        const y = clamp(Math.round(cy), 0, height - 1);
        const y0 = Math.max(0, y - 1);
        const y1 = Math.min(height - 1, y + 1);
        for (let x = 0; x < width; x++) {
            let s = 0, n = 0;
            for (let yy = y0; yy <= y1; yy++) { s += gray[yy * width + x]; n++; }
            samples.push(s / n);
        }
        return halfMaxSpan(samples, cx);
    }

    function halfMaxSpan(samples, center) {
        const n = samples.length;
        if (n < 5) return 0;
        const c = clamp(Math.round(center), 1, n - 2);
        const i0 = Math.max(0, c - 48);
        const i1 = Math.min(n - 1, c + 48);
        const bg = (samples[i0] + samples[Math.min(n - 1, i0 + 1)] + samples[i1] + samples[Math.max(0, i1 - 1)]) / 4;
        let peak = bg;
        let peakI = c;
        for (let i = i0; i <= i1; i++) {
            if (Math.abs(samples[i] - bg) > Math.abs(peak - bg)) {
                peak = samples[i];
                peakI = i;
            }
        }
        if (Math.abs(peak - bg) < 12) return 0;
        const half = bg + (peak - bg) * 0.5;
        let left = peakI;
        for (let i = peakI; i > i0; i--) {
            const a = samples[i];
            const b = samples[i - 1];
            if ((a - half) * (b - half) <= 0 && a !== b) {
                left = (i - 1) + (half - b) / (a - b);
                break;
            }
            left = i - 1;
        }
        let right = peakI;
        for (let i = peakI; i < i1; i++) {
            const a = samples[i];
            const b = samples[i + 1];
            if ((a - half) * (b - half) <= 0 && a !== b) {
                right = i + (half - a) / (b - a);
                break;
            }
            right = i + 1;
        }
        const span = right - left;
        if (span < 1.5 || span > 96) return 0;
        return span;
    }

    /** 縦または横の太さ。精密測定（diamX/Y）があればそれを使う。 */
    function axisMeasure(p, vertical) {
        const precise = vertical ? p.diamY : p.diamX;
        if (precise > 1) return { px: precise, precise: true };
        const coarse = vertical ? (p.hPx || 0) : (p.wPx || 0);
        return { px: coarse, precise: false };
    }

    /**
     * 速度に使う太さ。
     * 球は進行方向と垂直な幅（ブラーで伸びた側は使わない）。
     * 指のように垂直側がずっと長いときは、短い側が本当の太さ。
     */
    function minorMeasure(p, vx, vy) {
        const horiz = Math.abs(vx) >= Math.abs(vy);
        const perp = axisMeasure(p, horiz);
        const para = axisMeasure(p, !horiz);
        if (perp.px > 0 && para.px > 0 && perp.px > para.px * 2.2) return para;
        if (perp.px > 0) return perp;
        return para;
    }

    /**
     * スマホ1台での速度。
     * 主: 既知の球径 ÷ 映った太さ。焦点距離も距離も相殺される。
     * 精密な太さがあるときは、画角の見積もりとは混ぜない。
     * 粗い太さだけのときは 3x3 平滑の 2px を引く。球が小さすぎるときだけ距離換算。
     */
    function solveSpeed(samples, opts) {
        const o = opts || {};
        const aw = o.frameWidth || 480;
        const st = trackStats(samples || [], aw);
        if (!st) return null;
        const raw = [];
        let preciseCount = 0;
        for (const p of samples) {
            if (p.clipped) continue;
            const m = minorMeasure(p, st.vx, st.vy);
            const corrected = m.precise ? m.px : m.px - 2;
            const minD = m.precise ? 1.2 : 2.5;
            const maxD = m.precise ? 220 : 80;
            if (corrected >= minD && corrected <= maxD) {
                raw.push(corrected);
                if (m.precise) preciseCount++;
            }
        }
        raw.sort((a, b) => a - b);
        const mid = raw.length ? raw[(raw.length - 1) >> 1] : 0;
        let spread = 1;
        if (raw.length >= 2 && mid > 0) spread = (raw[raw.length - 1] - raw[0]) / mid;

        let sizeKmh = null;
        if (raw.length >= 2 && o.diameterM > 0 && mid >= 1.2 && spread <= 0.85) {
            const pxPerSec = Math.abs(st.vx);
            sizeKmh = pxPerSec * (o.diameterM / mid) * 3.6;
        }

        let distKmh = null;
        if (o.sceneWidthM > 0) {
            distKmh = (Math.abs(st.vx) / aw) * o.sceneWidthM * 3.6;
        }

        const sizeResult = sizeKmh ? {
            kmh: sizeKmh,
            method: preciseCount >= 2 ? 'size-hi' : 'size',
            diameterPx: mid,
            samples: raw.length
        } : null;
        const distResult = distKmh ? {
            kmh: distKmh,
            method: 'distance',
            diameterPx: mid,
            samples: raw.length
        } : null;
        const lo = o.minKmh;
        const hi = o.maxKmh;
        const inRange = (v) => v && (lo == null || v.kmh >= lo) && (hi == null || v.kmh <= hi);
        // 球径換算が遅すぎ・速すぎるときは、設定した距離の換算が範囲内ならそちらを出す
        if (inRange(sizeResult)) return sizeResult;
        if (inRange(distResult)) return distResult;
        return sizeResult || distResult;
    }

    return {
        DETECTOR_DEFAULTS,
        TRACKER_DEFAULTS,
        toGray,
        createDetector,
        createTracker,
        trackStats,
        toKmh,
        sceneWidthMeters,
        profileWidth,
        solveSpeed
    };
});
