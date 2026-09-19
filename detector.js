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
        // しきい値: 差分分布の下位パーセンタイル（＝背景ノイズ）から算出
        minThr: 14,
        maxThr: 72,
        noiseGain: 2.6,
        noiseOffset: 8,
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
        const diffBuf = new Uint8Array(aw * ah);
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
                    const a = diffBuf[i] >= thr ? a1 : a0;
                    bg[i] += a * (gray[i] - bg[i]);
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

            // 差分ヒストグラム（ROI）
            hist.fill(0);
            for (let y = roi.y0; y < roi.y1; y++) {
                const row = y * aw;
                for (let x = roi.x0; x < roi.x1; x++) {
                    const i = row + x;
                    let d = gray[i] - bg[i];
                    if (d < 0) d = -d;
                    d = d > 255 ? 255 : (d | 0);
                    diffBuf[i] = d;
                    hist[d]++;
                }
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
            for (let y = roi.y0; y < roi.y1; y++) {
                const row = y * aw;
                for (let x = roi.x0; x < roi.x1; x++) {
                    const d = diffBuf[row + x];
                    if (d < thr) continue;
                    fg++;
                    sw += d;
                    sx += x * d; sy += y * d;
                    sxx += x * x * d; syy += y * y * d;
                    colHit[x] = 1;
                }
            }
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

            return {
                kind: 'point',
                point: { x: mx, y: my, t, w: sw, n: fg },
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
            pts.push({ x: p.x, y: p.y, t: p.t, w: p.w || 1 });
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

        /**
         * 軌道を評価し、確定できれば速度（画面幅比 / 秒）を返す
         * @returns {null | {fracPerSec:number, points:number, stats:object, reason?:string}}
         */
        function evaluate(list) {
            const src = list || pts;
            if (src.length < 2) return null;
            const cleaned = cleanTrack(src);
            const core = coreSegment(cleaned);
            const use = core.length >= 2 ? core : cleaned;

            const z = zones(cleaned);
            const st = trackStats(use, aw);
            if (!st) return null;

            if (use.length < o.minPoints) {
                if (!(use.length >= 2 && z.both && st.dt <= o.twoPointMaxDt)) return null;
            }
            if (!z.both && st.dx < needDx()) return null;
            if (st.dx < st.dy * o.dyRatio) return null;
            if (st.dt < o.minDt || st.dt > o.maxDt) return null;
            if (st.lin < o.minLinearity) return null;
            if (st.dir < o.minDirection) return null;
            if (st.horizRatio < o.minHorizRatio) return null;

            const endpoint = st.dist / st.dt;
            const pxPerSec = st.speed * 0.84 + endpoint * 0.16;
            return { fracPerSec: pxPerSec / aw, points: use.length, stats: st, zones: z };
        }

        return {
            push,
            prune,
            reset,
            progress,
            evaluate,
            get points() { return pts; },
            get length() { return pts.length; },
            get options() { return o; }
        };
    }

    /** 画面幅比/秒 → km/h（画角補正込み） */
    function toKmh(fracPerSec, totalDistM, visibleFrac) {
        let kmh = fracPerSec * totalDistM * visibleFrac * 3.6;
        if (visibleFrac <= 0.25) kmh *= 0.9;
        else if (visibleFrac <= 0.33) kmh *= 0.93;
        else if (visibleFrac <= 0.5) kmh *= 0.96;
        return kmh;
    }

    return {
        DETECTOR_DEFAULTS,
        TRACKER_DEFAULTS,
        toGray,
        createDetector,
        createTracker,
        trackStats,
        toKmh
    };
});
