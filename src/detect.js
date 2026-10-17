// Coin edge detection on grayscale arrays. Self-contained so it can run in a Worker.
function coinDetectModule() {
  "use strict";

  function boxBlur(src, w, h, rad) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h), k = 2 * rad + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let x = -rad; x <= rad; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / k;
        acc += src[row + Math.min(w - 1, x + rad + 1)] - src[row + Math.max(0, x - rad)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -rad; y <= rad; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / k;
        acc += tmp[Math.min(h - 1, y + rad + 1) * w + x] - tmp[Math.max(0, y - rad) * w + x];
      }
    }
    return out;
  }

  function sobel(g, w, h) {
    const gx = new Float32Array(w * h), gy = new Float32Array(w * h), mag = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1, i = y * w + 1; x < w - 1; x++, i++) {
        const a = g[i - w - 1], b = g[i - w], c = g[i - w + 1], d = g[i - 1], f = g[i + 1];
        const p = g[i + w - 1], q = g[i + w], s = g[i + w + 1];
        const sx = c + 2 * f + s - (a + 2 * d + p);
        const sy = p + 2 * q + s - (a + 2 * b + c);
        gx[i] = sx; gy[i] = sy; mag[i] = Math.sqrt(sx * sx + sy * sy);
      }
    }
    return { gx, gy, mag };
  }

  function percentile(arr, p) {
    let max = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
    if (max <= 0) return 0;
    const bins = 2048, hist = new Uint32Array(bins);
    for (let i = 0; i < arr.length; i++) hist[Math.min(bins - 1, (arr[i] / max * bins) | 0)]++;
    const target = arr.length * p;
    let c = 0;
    for (let b = 0; b < bins; b++) { c += hist[b]; if (c >= target) return (b + 1) / bins * max; }
    return max;
  }

  function bilinear(g, w, h, x, y) {
    if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return NaN;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return g[i] * (1 - fx) * (1 - fy) + g[i + 1] * fx * (1 - fy) + g[i + w] * (1 - fx) * fy + g[i + w + 1] * fx * fy;
  }

  // Gradient-direction Hough transform, one radius slice at a time.
  // Returns the circle with the strongest support per unit of circumference.
  function findCircle(g, w, h, prior) {
    const blurred = boxBlur(boxBlur(g, w, h, 1), w, h, 1);
    const { gx, gy, mag } = sobel(blurred, w, h);
    const thr = Math.max(percentile(mag, 0.87), 10);
    const xs = [], ys = [], us = [], vs = [];
    for (let y = 2; y < h - 2; y++) {
      for (let x = 2, i = y * w + 2; x < w - 2; x++, i++) {
        const m = mag[i];
        if (m >= thr) { xs.push(x); ys.push(y); us.push(gx[i] / m); vs.push(gy[i] / m); }
      }
    }
    const n = xs.length;
    if (n < 30) return null;
    const stride = Math.max(1, Math.ceil(n / 60000));
    const minDim = Math.min(w, h);
    let rMin = Math.max(8, minDim * 0.08), rMax = minDim * 0.52;
    let win = null;
    if (prior) {
      rMin = Math.max(8, prior.r * 0.8);
      rMax = Math.min(Math.max(w, h) * 0.6, prior.r * 1.2);
      const d = minDim * 0.12;
      win = { x0: prior.cx - d, x1: prior.cx + d, y0: prior.cy - d, y1: prior.cy + d };
    }
    if (rMax <= rMin) return null;
    const acc = new Float32Array(w * h);
    const steps = Math.min(96, Math.max(12, Math.round((rMax - rMin) / 1.5)));
    let best = null;
    const perR = [];
    for (let s = 0; s <= steps; s++) {
      let bestR = null;
      const r = rMin + (rMax - rMin) * s / steps;
      acc.fill(0);
      for (let k = 0; k < n; k += stride) {
        const x = xs[k], y = ys[k], u = us[k] * r, v = vs[k] * r;
        let cx = Math.round(x + u), cy = Math.round(y + v);
        if (cx > 0 && cx < w - 1 && cy > 0 && cy < h - 1) acc[cy * w + cx] += 1;
        cx = Math.round(x - u); cy = Math.round(y - v);
        if (cx > 0 && cx < w - 1 && cy > 0 && cy < h - 1) acc[cy * w + cx] += 1;
      }
      // The whole coin should be in frame (a little tolerance for tight shots).
      const m = prior ? r * 0.85 : r * 0.96;
      let x0 = Math.max(1, Math.ceil(m)), x1 = Math.min(w - 2, Math.floor(w - 1 - m));
      let y0 = Math.max(1, Math.ceil(m)), y1 = Math.min(h - 2, Math.floor(h - 1 - m));
      if (win) {
        x0 = Math.max(x0, Math.ceil(win.x0)); x1 = Math.min(x1, Math.floor(win.x1));
        y0 = Math.max(y0, Math.ceil(win.y0)); y1 = Math.min(y1, Math.floor(win.y1));
      }
      if (x0 > x1 || y0 > y1) continue;
      const rn = (r - rMin) / (rMax - rMin);
      const norm = stride / (2 * Math.PI * r) * (0.82 + 0.18 * rn);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0, i = y * w + x0; x <= x1; x++, i++) {
          if (acc[i] === 0) continue;
          const sum = acc[i - w - 1] + acc[i - w] + acc[i - w + 1] + acc[i - 1] + acc[i] + acc[i + 1] +
            acc[i + w - 1] + acc[i + w] + acc[i + w + 1];
          const sc = sum * norm;
          if (!best || sc > best.score) best = { cx: x, cy: y, r, score: sc };
          if (!bestR || sc > bestR.score) bestR = { cx: x, cy: y, r, score: sc };
        }
      }
      if (bestR) perR.push(bestR);
    }
    if (!best || prior) return best;
    // A detailed portrait or a holder crease can score as well as the coin itself. Among the
    // circles that come close to the best, take the one whose edge runs all the way round,
    // and between equals the larger: the coin's rim encloses its own details.
    const near = perR.filter((c, i) => c.score >= best.score * 0.88 &&
      (i === 0 || c.score >= perR[i - 1].score) && (i === perR.length - 1 || c.score >= perR[i + 1].score));
    if (near.length < 2) return best;
    let pick = best, pickV = -1;
    for (const c of near) {
      const v = c.score / best.score * (0.55 + 0.45 * ringSupport(blurred, w, h, c)) * (1 + 0.15 * (c.r / rMax));
      if (v > pickV) { pickV = v; pick = c; }
    }
    return pick;
  }

  // Algebraic circle fit, centred on the mean for numerical stability.
  function fitCircle(pts) {
    const n = pts.length;
    if (n < 6) return null;
    let mx = 0, my = 0;
    for (const p of pts) { mx += p.x; my += p.y; }
    mx /= n; my /= n;
    let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
    for (const p of pts) {
      const u = p.x - mx, v = p.y - my;
      suu += u * u; svv += v * v; suv += u * v;
      suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
    }
    const det = suu * svv - suv * suv;
    if (Math.abs(det) < 1e-9) return null;
    const b1 = 0.5 * (suuu + suvv), b2 = 0.5 * (svvv + svuu);
    const uc = (b1 * svv - b2 * suv) / det, vc = (suu * b2 - suv * b1) / det;
    const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
    return { cx: uc + mx, cy: vc + my, r };
  }

  // Snap the circle to the strongest radial edge near it, then refit.
  function refineCircle(g, w, h, c, span) {
    let { cx, cy, r } = c;
    const N = 240;
    for (let iter = 0; iter < 3; iter++) {
      const pts = [];
      const step = Math.max(0.5, r * 0.004), d = Math.max(1.5, r * 0.006);
      for (let k = 0; k < N; k++) {
        const t = (k / N) * Math.PI * 2, dx = Math.cos(t), dy = Math.sin(t);
        let bestG = 0, bestR = -1;
        for (let rr = r * (1 - span); rr <= r * (1 + span); rr += step) {
          const a = bilinear(g, w, h, cx + dx * (rr - d), cy + dy * (rr - d));
          const b = bilinear(g, w, h, cx + dx * (rr + d), cy + dy * (rr + d));
          if (a !== a || b !== b) continue;
          const gr = Math.abs(b - a);
          if (gr > bestG) { bestG = gr; bestR = rr; }
        }
        if (bestR > 0) pts.push({ x: cx + dx * bestR, y: cy + dy * bestR, rr: bestR, g: bestG });
      }
      if (pts.length < N * 0.3) break;
      const gs = pts.map((p) => p.g).sort((a, b) => a - b);
      const gCut = gs[Math.floor(gs.length * 0.3)];
      const rs = pts.map((p) => p.rr).sort((a, b) => a - b);
      const med = rs[rs.length >> 1];
      const good = pts.filter((p) => p.g >= gCut && Math.abs(p.rr - med) < r * 0.025);
      if (good.length < N * 0.2) break;
      const fit = fitCircle(good);
      if (!fit || !isFinite(fit.r)) break;
      if (Math.abs(fit.r - r) > r * 0.1 || Math.hypot(fit.cx - cx, fit.cy - cy) > r * 0.1) break;
      cx = fit.cx; cy = fit.cy; r = fit.r;
    }
    return { cx, cy, r, score: c.score };
  }

  function medianOf(buf, n) {
    const a = Array.prototype.slice.call(buf, 0, n).sort((x, y) => x - y);
    return a[n >> 1];
  }

  // Median edge strength and brightness on rings around the circle, from lo*r to hi*r.
  function radialProfile(g, w, h, c, lo, hi) {
    const N = 180, steps = Math.max(24, Math.min(400, Math.round((hi - lo) * c.r / 0.75)));
    const d = Math.max(1.2, c.r * 0.005);
    const tg = new Float32Array(N), ta = new Float32Array(N);
    const cs = [], sn = [];
    for (let k = 0; k < N; k++) { const t = (k / N) * Math.PI * 2; cs.push(Math.cos(t)); sn.push(Math.sin(t)); }
    const M = [], A = [], rho = [];
    const G = new Float32Array((steps + 1) * N).fill(-1);
    for (let s = 0; s <= steps; s++) {
      const rr = c.r * (lo + (hi - lo) * s / steps);
      let n = 0;
      for (let k = 0; k < N; k++) {
        const a = bilinear(g, w, h, c.cx + cs[k] * (rr - d), c.cy + sn[k] * (rr - d));
        const b = bilinear(g, w, h, c.cx + cs[k] * (rr + d), c.cy + sn[k] * (rr + d));
        const m = bilinear(g, w, h, c.cx + cs[k] * rr, c.cy + sn[k] * rr);
        if (a !== a || b !== b || m !== m) continue;
        tg[n] = Math.abs(b - a); ta[n] = m; n++;
        G[s * N + k] = Math.abs(b - a);
      }
      rho.push(rr);
      if (n < N * 0.5) { M.push(0); A.push(NaN); } else { M.push(medianOf(tg, n)); A.push(medianOf(ta, n)); }
    }
    // The same, but each direction takes its strongest edge within a few percent of the radius,
    // so a coin with flat sides (the 12-sided nickel) still shows as one continuous ring.
    const win = Math.max(1, Math.round((0.035 / (hi - lo)) * steps)), M2 = [];
    for (let s = 0; s <= steps; s++) {
      let n = 0;
      for (let k = 0; k < N; k++) {
        let mx = -1;
        for (let t = Math.max(0, s - win); t <= Math.min(steps, s + win); t++) mx = Math.max(mx, G[t * N + k]);
        if (mx >= 0) tg[n++] = mx;
      }
      M2.push(n < N * 0.5 ? 0 : medianOf(tg, n));
    }
    return { M, M2, A, rho };
  }

  // 5th and 95th percentile brightness inside a disc.
  function discRange(g, w, h, cx, cy, r) {
    const v = [];
    const st = Math.max(1, r / 40);
    for (let y = -r; y <= r; y += st) {
      for (let x = -r; x <= r; x += st) {
        if (x * x + y * y > r * r) continue;
        const px = Math.round(cx + x), py = Math.round(cy + y);
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        v.push(g[py * w + px]);
      }
    }
    if (v.length < 50) return null;
    v.sort((a, b) => a - b);
    return { lo: v[Math.floor(v.length * 0.05)], hi: v[Math.floor(v.length * 0.95)] };
  }

  // A holder's insert ring often sits just outside the coin and can out-shout the coin's own
  // edge. Look for other continuous rings close to the found one, decide which is the coin,
  // and return the rest as alternatives the person can switch to.
  function pickRing(g, w, h, c) {
    const R = c.r;
    const P = radialProfile(g, w, h, c, 0.68, 1.2);
    const M = P.M.map((v, i, a) => (a[i - 1] ?? v) * 0.25 + v * 0.5 + (a[i + 1] ?? v) * 0.25);
    let MR = 0;
    P.rho.forEach((r, i) => { if (Math.abs(r - R) <= R * 0.012) MR = Math.max(MR, M[i]); });
    if (MR <= 0) return { main: c, alts: [] };
    let inner = null, outer = null;
    for (let i = 1; i < M.length - 1; i++) {
      if (!(M[i] >= M[i - 1] && M[i] >= M[i + 1] && M[i] >= MR * 0.3)) continue;
      const q = P.rho[i] / R;
      if (q >= 0.7 && q <= 0.975 && (!inner || M[i] > inner.m)) inner = { rho: P.rho[i], m: M[i] };
      if (q >= 1.025 && q <= 1.18 && (!outer || M[i] > outer.m)) outer = { rho: P.rho[i], m: M[i] };
    }
    if (!inner) {
      // no round inner edge: look again allowing for flat-sided coins
      let MR2 = 0;
      P.rho.forEach((r, i) => { if (Math.abs(r - R) <= R * 0.012) MR2 = Math.max(MR2, P.M2[i]); });
      const M2 = P.M2;
      for (let i = 1; i < M2.length - 1; i++) {
        const q = P.rho[i] / R;
        if (q < 0.7 || q > 0.93 || !(M2[i] >= M2[i - 1] && M2[i] >= M2[i + 1] && M2[i] >= MR2 * 0.45)) continue;
        // keep the same scale as MR for the checks below
        if (!inner || M2[i] > inner.m2) inner = { rho: P.rho[i], m: MR * (M2[i] / MR2), m2: M2[i] };
      }
    }
    const bandMedian = (r0, r1) => {
      const v = [];
      P.rho.forEach((r, i) => { if (r >= r0 && r <= r1 && P.A[i] === P.A[i]) v.push(P.A[i]); });
      v.sort((a, b) => a - b);
      return v.length ? v[v.length >> 1] : NaN;
    };
    const snap = (rho) => {
      const rc = refineCircle(g, w, h, { cx: c.cx, cy: c.cy, r: rho, score: c.score }, 0.02);
      return Math.abs(rc.r - rho) < rho * 0.03 ? rc : { cx: c.cx, cy: c.cy, r: rho, score: c.score };
    };
    let main = c;
    const alts = [];
    if (inner) {
      const gap = R - inner.rho;
      const band = bandMedian(inner.rho + gap * 0.25, R - gap * 0.25);
      const range = discRange(g, w, h, c.cx, c.cy, inner.rho * 0.9);
      const innerCircle = snap(inner.rho);
      // The coin is metal. If the band between the inner ring and the outer one is darker or
      // brighter than anything on the coin, it is holder or background, so the inner ring is the coin.
      const looksLikeMetal = range && band >= range.lo - 10 && band <= range.hi + 10;
      // Only step inward when the outer ring is a thin holder ring: the band inside it matches
      // what lies outside it (background on both sides). A coin's own rim never looks like that.
      const outside = bandMedian(R * 1.02, R * 1.06);
      const thinRing = outside === outside && Math.abs(outside - band) < 25;
      // A holder insert (often black) fills the gap with an even, featureless band; a coin's own
      // rim band has relief and reads as metal.
      let bandEdge = 0, nBand = 0;
      P.rho.forEach((r, i) => { if (r > inner.rho + gap * 0.2 && r < R - gap * 0.2) { bandEdge += M[i]; nBand++; } });
      // ...and it is wide: an insert gap is a tenth of the radius or more, a rim band far less
      const evenBand = gap >= R * 0.1 && nBand > 2 && bandEdge / nBand < MR * 0.2;
      if (inner.m >= MR * 0.25 && range && !looksLikeMetal && (thinRing || evenBand)) { main = innerCircle; alts.push(c); }
      else alts.push(innerCircle);
    }
    if (outer && main === c) {
      // The found ring can be the inside of the coin's own rim (bright denticles against a
      // mirror field), with the true edge fainter outside it: a silver rim against a cream
      // ICCS label. Then the band out to the outer ring is still coin.
      const gapO = outer.rho - R;
      const tex = (r0, r1) => {
        const out = [], N = 720;
        for (let k = 0; k < 5; k++) {
          const rr = r0 + (r1 - r0) * (k + 0.5) / 5;
          let s = 0, n = 0, prev = NaN;
          for (let j = 0; j <= N; j++) {
            const t = (j / N) * Math.PI * 2, v = bilinear(g, w, h, c.cx + Math.cos(t) * rr, c.cy + Math.sin(t) * rr);
            if (v === v && prev === prev) { s += Math.abs(v - prev); n++; }
            prev = v;
          }
          if (n > N * 0.5) out.push(s / n);
        }
        out.sort((a, b) => a - b);
        return out.length ? out[out.length >> 1] : NaN;
      };
      const texBeyond = tex(outer.rho * 1.03, outer.rho * 1.08);
      // denticles (or other relief) just outside the found ring, and quiet background beyond the outer one
      const texOut = tex(R * 1.0, R * 1.03);
      const dentilsOutside = texOut >= 7 && texOut >= texBeyond * 2;
      // or a plain bright rim between them, as bright as the rim just inside and brighter than beyond
      const range = discRange(g, w, h, c.cx, c.cy, R * 0.9);
      const bandO = bandMedian(R + gapO * 0.25, outer.rho - gapO * 0.25);
      const beyondO = bandMedian(outer.rho * 1.02, outer.rho * 1.06);
      const rimIn = bandMedian(R * 0.985, R * 1.0);
      const plainRim = outer.rho <= R * 1.065 && range && bandO >= beyondO + 5 && Math.abs(bandO - rimIn) <= 25 &&
        bandO >= (range.lo + range.hi) / 2 && bandO <= range.hi + 8 && tex(R + gapO * 0.2, outer.rho - gapO * 0.2) >= texBeyond * 1.2;
      if (outer.rho <= R * 1.12 && (dentilsOutside || plainRim)) { alts.push(c); main = snap(outer.rho); outer = null; }
    }
    if (outer) alts.push(snap(outer.rho));
    return { main, alts };
  }

  // The radius where the edge's brightness change has fully died away on the outside,
  // rather than its midpoint, so the whole rim stays inside the crop.
  function outerEdge(g, w, h, c) {
    const N = 240, d = 1, step = 0.25, lo = c.r * 0.96, hi = c.r * 1.05;
    const ends = [];
    for (let k = 0; k < N; k++) {
      const t = (k / N) * Math.PI * 2, dx = Math.cos(t), dy = Math.sin(t);
      const prof = [];
      for (let rr = lo; rr <= hi; rr += step) {
        const a = bilinear(g, w, h, c.cx + dx * (rr - d), c.cy + dy * (rr - d));
        const b2 = bilinear(g, w, h, c.cx + dx * (rr + d), c.cy + dy * (rr + d));
        prof.push(a !== a || b2 !== b2 ? -1 : Math.abs(b2 - a));
      }
      // the strongest edge near the fitted circle
      let pi = -1, pv = 0;
      const i0 = Math.round((c.r * 0.98 - lo) / step), i1 = Math.round((c.r * 1.02 - lo) / step);
      for (let i = Math.max(0, i0); i <= Math.min(prof.length - 1, i1); i++) if (prof[i] > pv) { pv = prof[i]; pi = i; }
      if (pi < 0 || pv < 8) continue;
      let j = pi;
      while (j + 1 < prof.length && prof[j + 1] >= 0 && prof[j + 1] > pv * 0.2) j++;
      ends.push(lo + j * step + d);
    }
    if (ends.length < N * 0.3) return c.r;
    ends.sort((a, b) => a - b);
    // a little above the median, so many-sided coins (the 12-sided nickel) keep their corners
    const r = ends[Math.floor(ends.length * 0.7)];
    return Math.max(c.r, Math.min(r, c.r * 1.03));
  }

  /* ---------- straightening: the holder's edges, and which side its label is on ---------- */

  const wrap90 = (d) => { let v = ((d + 45) % 90 + 90) % 90 - 45; return v; };

  // How far the holder is turned, from the long straight edges around the coin: the holder's
  // own outline, the insert, the label's edges and its printed lines all run square to it.
  // Gives the tilt modulo 90° (clockwise positive), or null when nothing straight and long
  // enough sits near the coin (a loose coin on a plain cloth, say).
  function holderTilt(g, w, h, c) {
    const bl = boxBlur(boxBlur(g, w, h, 1), w, h, 1);
    const { gx, gy, mag } = sobel(bl, w, h);
    const R = c.r, inner = R * 1.07, reach = R * 5.5;
    const thr = Math.max(percentile(mag, 0.9), 10);
    const DEG = 180 / Math.PI;
    let n = 0;
    const X = new Float32Array(w * h / 5 | 0), Y = new Float32Array(X.length), T = new Float32Array(X.length), A = new Uint8Array(X.length), F = new Uint8Array(X.length);
    const hist = new Float32Array(360);
    for (let y = 2; y < h - 2 && n < X.length; y++) {
      for (let x = 2, i = y * w + 2; x < w - 2; x++, i++) {
        const m = mag[i];
        if (m < thr) continue;
        const dx = x - c.cx, dy = y - c.cy, d2 = dx * dx + dy * dy;
        if (d2 < inner * inner) continue;
        // the edge's normal, folded so both of a rectangle's edge directions land together
        const a = ((Math.atan2(gy[i], gx[i]) * DEG) % 180 + 180) % 180;
        const t = wrap90(a);
        // A: edges running up and down (normal along t); otherwise across (normal along t + 90°)
        // F: far from the coin, only used to spot a ruled background
        X[n] = x; Y[n] = y; T[n] = t; A[n] = Math.round((a - t) / 90) % 2 === 0 ? 1 : 0; F[n] = d2 > reach * reach ? 1 : 0; n++;
        if (n >= X.length) break;
        if (d2 <= reach * reach) hist[Math.min(359, Math.floor((t + 45) * 4))] += 1;
      }
    }
    if (n < 40) return null;
    // smooth over about a degree, round the circle
    const sm = new Float32Array(360);
    for (let i = 0; i < 360; i++) { let s = 0; for (let k = -4; k <= 4; k++) s += hist[(i + k + 360) % 360] * (5 - Math.abs(k)); sm[i] = s; }
    const peaks = [];
    for (let i = 0; i < 360; i++) {
      const v = sm[i];
      if (v <= 0 || v < sm[(i + 359) % 360] || v < sm[(i + 1) % 360]) continue;
      peaks.push({ t: i / 4 - 45 + 0.125, v });
    }
    peaks.sort((p, q) => q.v - p.v);
    const top = [];
    for (const p of peaks) { if (top.every((q) => Math.abs(wrap90(q.t - p.t)) >= 3)) top.push(p); if (top.length >= 3) break; }

    const diag = Math.ceil(Math.hypot(w, h)) + 4;
    const cntA = new Int32Array(2 * diag), cntB = new Int32Array(2 * diag);
    const near = (t0, span, all) => { const idx = []; for (let k = 0; k < n; k++) if ((all || !F[k]) && Math.abs(wrap90(T[k] - t0)) <= span) idx.push(k); return idx; };
    const project = (idx, t) => {
      const r = t / DEG, co = Math.cos(r), si = Math.sin(r);
      cntA.fill(0); cntB.fill(0);
      for (const k of idx) {
        if (A[k]) cntA[Math.round(X[k] * co + Y[k] * si) + diag]++;
        else cntB[Math.round(-X[k] * si + Y[k] * co) + diag]++;
      }
    };
    const sharp = (idx, t) => {
      project(idx, t);
      let s = 0;
      for (let i = 0; i < cntA.length; i++) s += cntA[i] * cntA[i] + cntB[i] * cntB[i];
      return s;
    };
    // the straight runs at angle t: their length (gaps left out) and distance from the coin
    const linesAt = (idx, t) => {
      project(idx, t);
      const r = t / DEG, co = Math.cos(r), si = Math.sin(r);
      const out = [];
      for (const [cnt, fam] of [[cntA, 1], [cntB, 0]]) {
        const c3 = (i) => cnt[i - 1] + cnt[i] + cnt[i + 1];
        const rc = fam ? c.cx * co + c.cy * si : -c.cx * si + c.cy * co;
        const ac = fam ? -c.cx * si + c.cy * co : c.cx * co + c.cy * si;
        for (let i = 2; i < cnt.length - 2; i++) {
          const v = c3(i);
          if (v < R * 0.35 || v < c3(i - 1) || v <= c3(i + 1)) continue;
          // how much of the line is actually there, in 3 px steps, and on which side of the coin
          const cells = new Set();
          let before = 0, after = 0;
          for (const k of idx) {
            if (A[k] !== fam) continue;
            const rho = fam ? X[k] * co + Y[k] * si : -X[k] * si + Y[k] * co;
            if (Math.abs(rho + diag - i) > 1.5) continue;
            const along = fam ? -X[k] * si + Y[k] * co : X[k] * co + Y[k] * si;
            const cell = Math.floor(along / 3);
            if (cells.has(cell)) continue;
            cells.add(cell);
            if (along < ac) before += 3; else after += 3;
          }
          const len = cells.size * 3;
          if (len >= R * 0.3) out.push({ fam, len, dist: Math.abs(i - diag - rc), both: Math.min(before, after) });
        }
      }
      return out;
    };
    // A background with its own ruled lines (a cutting mat, squared paper, floorboards) shows
    // many long lines at even spacing, across the photo. Those don't say where the holder is.
    const ruled = (t) => {
      project(near(t, 1.5, true), t);
      for (const cnt of [cntA, cntB]) {
        const c3 = (i) => cnt[i - 1] + cnt[i] + cnt[i + 1], pos = [];
        for (let i = 2; i < cnt.length - 2; i++) {
          const v = c3(i);
          if (v < R || v < c3(i - 1) || v <= c3(i + 1)) continue;
          if (pos.length && i - pos[pos.length - 1] < 5) continue;
          pos.push(i);
        }
        if (pos.length < 7 || pos[pos.length - 1] - pos[0] < R * 3) continue;
        const gaps = pos.slice(1).map((q, i) => q - pos[i]), med = gaps.slice().sort((a, b) => a - b)[gaps.length >> 1];
        if (med < R * 0.15) continue;
        const even = gaps.filter((gp) => gp <= med * 3.2 && Math.abs(gp / med - Math.max(1, Math.round(gp / med))) <= 0.12).length;
        if (even >= gaps.length * 0.75) return true;
      }
      return false;
    };
    let best = null, second = null, ruledBest = null;
    for (const p of top) {
      const idx = near(p.t, 2.5);
      if (idx.length < 30) continue;
      let bt = p.t, bs = -1;
      for (let t = p.t - 1.2; t <= p.t + 1.2001; t += 0.1) { const s = sharp(idx, t); if (s > bs) { bs = s; bt = t; } }
      for (let t = bt - 0.08; t <= bt + 0.0801; t += 0.02) { const s = sharp(idx, t); if (s > bs) { bs = s; bt = t; } }
      const lines = linesAt(idx, bt);
      // nearer lines count for more: a holder sits right around its coin, a table edge doesn't
      const prox = (d) => 1 / (1 + Math.max(0, d - R * 1.3) / (R * 1.5));
      let sup = 0, longA = 0, longB = 0, through = 0;
      for (const l of lines) {
        // a line that runs behind the coin (on both sides of it) is background: a holder's
        // edges all go round its coin, never across it
        if (l.dist < R * 0.95) { if (l.both >= R * 0.3) through += l.len; continue; }
        sup += l.len * prox(l.dist);
        if (l.fam) longA = Math.max(longA, l.len * prox(l.dist)); else longB = Math.max(longB, l.len * prox(l.dist));
      }
      // a rectangle shows edges both ways; a single family has to be long and close
      const ok = (longA >= R * 0.5 && longB >= R * 0.5) || Math.max(longA, longB) >= R * 1.3;
      const cand = { tilt: Math.round(wrap90(bt) * 10) / 10, support: sup / R, ok };
      if (!ok) continue;
      if (through >= R || ruled(bt)) { if (!ruledBest || cand.support > ruledBest.support) ruledBest = cand; continue; }
      if (!best || cand.support > best.support) { second = best; best = cand; } else if (!second || cand.support > second.support) second = cand;
    }
    // only a ruled background: it may or may not line up with the holder (a label can say)
    if (!best) return ruledBest ? { tilt: ruledBest.tilt, support: Math.round(ruledBest.support * 100) / 100, ruled: true } : null;
    // two different straight-edged things at different angles, near equally strong: don't guess
    if (second && second.support > best.support * 0.7) return null;
    return { tilt: best.tilt, support: Math.round(best.support * 100) / 100 };
  }

  // Which side of the coin the label is on, in the holder's own frame (after taking out the
  // tilt): "up", "right", "down" or "left". The label is a bright rectangle beside the coin,
  // square to the holder and at least about as wide as the coin. rect and c in the same px.
  function labelSide(rect, c, tilt) {
    if (!rect || !(rect.rw > 0)) return null;
    const turn = wrap90(rect.rot - tilt);
    if (Math.abs(turn) > 4) return null;
    const t = tilt * Math.PI / 180, co = Math.cos(t), si = Math.sin(t);
    const dx = rect.cx - c.cx, dy = rect.cy - c.cy;
    const u = dx * co + dy * si, v = -dx * si + dy * co;
    // the label's half sizes along the holder's axes
    const q = ((Math.round((rect.rot - tilt - turn) / 90) % 2) + 2) % 2;
    const hu = (q ? rect.rh : rect.rw) / 2, hv = (q ? rect.rw : rect.rh) / 2;
    // clear of the coin, but close: even a dime's label starts within about three radii
    const R = c.r, gap = R * 0.85, far = R * 4;
    if (hu * 2 * hv * 2 < R * R * 0.6) return null;
    const sides = [];
    if (v + hv < -gap && v + hv > -far && Math.abs(u) < hu + R * 0.4 && hu * 2 >= R * 1.6) sides.push("up");
    if (v - hv > gap && v - hv < far && Math.abs(u) < hu + R * 0.4 && hu * 2 >= R * 1.6) sides.push("down");
    if (u + hu < -gap && u + hu > -far && Math.abs(v) < hv + R * 0.4 && hv * 2 >= R * 1.6) sides.push("left");
    if (u - hu > gap && u - hu < far && Math.abs(v) < hv + R * 0.4 && hv * 2 >= R * 1.6) sides.push("right");
    return sides.length === 1 ? sides[0] : null;
  }

  // The holder's tilt and label side for a found coin c (full-res px). rect: the label found
  // in the same photo (full-res px), or undefined to look for one here.
  function holderOrient(job, c, rect) {
    // half the detection size is plenty for long edges, and four times quicker
    const b = job.big, f = b.w * b.h > 900000 ? 2 : 1, w = Math.floor(b.w / f), h = Math.floor(b.h / f);
    let g = b.g;
    if (f === 2) {
      g = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = 2 * y * b.w + 2 * x;
        g[y * w + x] = (b.g[i] + b.g[i + 1] + b.g[i + b.w] + b.g[i + b.w + 1]) / 4;
      }
    }
    const k = b.scale / f;
    const ht = holderTilt(g, w, h, { cx: c.cx * k, cy: c.cy * k, r: c.r * k });
    if (rect === undefined) { try { rect = detectRect(job); } catch (e) { rect = null; } }
    // A label beside the coin is the surest sign of the holder: it sets the angle, and the
    // edges refine it when they agree. A label cut off by the edge of the photo still shows
    // which side it's on, but its own angle can't be trusted.
    const label = rect ? labelSide(rect, c, wrap90(rect.rot)) : null;
    if (label) {
      const W = b.w / b.scale, H = b.h / b.scale, t = rect.rot * Math.PI / 180;
      const ex = Math.abs(Math.cos(t)) * rect.rw / 2 + Math.abs(Math.sin(t)) * rect.rh / 2;
      const ey = Math.abs(Math.sin(t)) * rect.rw / 2 + Math.abs(Math.cos(t)) * rect.rh / 2, m = Math.min(W, H) * 0.01;
      const cut = rect.cx - ex < m || rect.cy - ey < m || rect.cx + ex > W - m || rect.cy + ey > H - m;
      const d = ht ? Math.abs(wrap90(ht.tilt - rect.rot)) : 99;
      if (ht && !ht.ruled && d <= (cut ? 4 : 1)) return { tilt: ht.tilt, label: labelSide(rect, c, ht.tilt) || label, support: ht.support };
      if (!cut) return { tilt: Math.round(wrap90(rect.rot) * 10) / 10, label, support: 0 };
    }
    if (!ht || ht.ruled) return null;
    return { tilt: ht.tilt, label: rect ? labelSide(rect, c, ht.tilt) : null, support: ht.support };
  }

  // job.small / job.big: {g, w, h, scale} where scale = detection px per full-res px.
  // job.prior (optional): {cx, cy, r} in full-res px.
  // Returns {cx, cy, r, score, alts:[{cx, cy, r}], orient} in full-res px, or null.
  // orient: {tilt, label, support} from the holder around the coin, or null.
  function detect(job, rect) {
    const s = job.small, b = job.big;
    const prior = job.prior ? { cx: job.prior.cx * s.scale, cy: job.prior.cy * s.scale, r: job.prior.r * s.scale } : null;
    const c = findCircle(s.g, s.w, s.h, prior);
    if (!c) return null;
    const k = b.scale / s.scale;
    const bg = boxBlur(b.g, b.w, b.h, 1);
    const rc = refineCircle(bg, b.w, b.h, { cx: c.cx * k, cy: c.cy * k, r: c.r * k, score: c.score }, 0.07);
    const picked = pickRing(bg, b.w, b.h, rc);
    // Sit the crop just outside the outermost edge of the rim, never on it.
    const up = (q) => { const r = outerEdge(b.g, b.w, b.h, q); return { cx: q.cx / b.scale, cy: q.cy / b.scale, r: r / b.scale * 1.002 }; };
    const main = up(picked.main);
    let orient = null;
    if (job.orient !== false) { try { orient = holderOrient(job, main, rect); } catch (e) { orient = null; } }
    return { ...main, score: rc.score, alts: picked.alts.map(up), support: ringSupport(bg, b.w, b.h, rc), orient };
  }

  /* ---------- certificate (label) rectangle ---------- */

  function otsu(g) {
    const hist = new Float64Array(256);
    for (let i = 0; i < g.length; i++) hist[Math.max(0, Math.min(255, g[i] | 0))]++;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, best = -1, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = g.length - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; }
    }
    return thr;
  }

  function components(mask, w, h) {
    const lab = new Int32Array(w * h).fill(-1), stack = new Int32Array(w * h), comps = [];
    for (let i = 0; i < w * h; i++) {
      if (!mask[i] || lab[i] >= 0) continue;
      const id = comps.length;
      let sp = 0, n = 0, sx = 0, sy = 0, minx = w, maxx = 0, miny = h, maxy = 0;
      stack[sp++] = i; lab[i] = id;
      while (sp) {
        const p = stack[--sp], x = p % w, y = (p / w) | 0;
        n++; sx += x; sy += y;
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
        if (x > 0 && mask[p - 1] && lab[p - 1] < 0) { lab[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && lab[p + 1] < 0) { lab[p + 1] = id; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && lab[p - w] < 0) { lab[p - w] = id; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && lab[p + w] < 0) { lab[p + w] = id; stack[sp++] = p + w; }
      }
      comps.push({ id, n, cx: sx / n, cy: sy / n, minx, maxx, miny, maxy });
    }
    return { lab, comps };
  }

  // Tilt of a rectangle: the angle at which its outline has the smallest bounding box.
  function boundaryTilt(lab, id, c, w, h) {
    const px = [], py = [];
    for (let y = c.miny; y <= c.maxy; y++) {
      for (let x = c.minx; x <= c.maxx; x++) {
        const i = y * w + x;
        if (lab[i] !== id) continue;
        const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
          lab[i - 1] !== id || lab[i + 1] !== id || lab[i - w] !== id || lab[i + w] !== id;
        if (edge) { px.push(x - c.cx); py.push(y - c.cy); }
      }
    }
    if (px.length < 20) return 0;
    const stride = Math.max(1, Math.floor(px.length / 3000));
    const us = [], vs = [];
    const areaAt = (deg) => {
      const t = deg * Math.PI / 180, co = Math.cos(t), si = Math.sin(t);
      us.length = 0; vs.length = 0;
      for (let k = 0; k < px.length; k += stride) { us.push(px[k] * co + py[k] * si); vs.push(-px[k] * si + py[k] * co); }
      us.sort((a, b) => a - b); vs.sort((a, b) => a - b);
      const q = (a, p) => a[Math.round((a.length - 1) * p)];
      return (q(us, 0.997) - q(us, 0.003)) * (q(vs, 0.997) - q(vs, 0.003));
    };
    let best = 0, bestA = Infinity;
    for (let d = -45; d < 45; d += 1) { const a = areaAt(d); if (a < bestA) { bestA = a; best = d; } }
    const coarse = best;
    for (let d = coarse - 1; d <= coarse + 1; d += 0.1) { const a = areaAt(d); if (a < bestA) { bestA = a; best = d; } }
    return Math.round(best * 10) / 10;
  }

  function rectOfComponent(lab, c, w, tilt) {
    const t = tilt * Math.PI / 180, co = Math.cos(t), si = Math.sin(t);
    const us = new Float32Array(c.n), vs = new Float32Array(c.n);
    let k = 0;
    for (let y = c.miny; y <= c.maxy; y++) {
      for (let x = c.minx; x <= c.maxx; x++) {
        if (lab[y * w + x] !== c.id) continue;
        const dx = x - c.cx, dy = y - c.cy;
        us[k] = dx * co + dy * si; vs[k] = -dx * si + dy * co; k++;
      }
    }
    us.sort(); vs.sort();
    const q = (a, p) => a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * p)))];
    const u0 = q(us, 0.002), u1 = q(us, 0.998), v0 = q(vs, 0.002), v1 = q(vs, 0.998);
    const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
    const rw = u1 - u0 + 1, rh = v1 - v0 + 1;
    return { cx: c.cx + uc * co - vc * si, cy: c.cy + uc * si + vc * co, rw, rh, rot: tilt, fill: c.n / (rw * rh) };
  }

  // Move each side of the rectangle onto the strongest straight edge near it.
  function snapRect(g, w, h, r, spanFrac) {
    let { cx, cy, rw, rh } = r;
    const t = r.rot * Math.PI / 180, co = Math.cos(t), si = Math.sin(t);
    const toImg = (u, v) => [cx + u * co - v * si, cy + u * si + v * co];
    for (let iter = 0; iter < 2; iter++) {
      const span = Math.max(3, Math.min(rw, rh) * spanFrac), d = 1.5, step = 0.5;
      const sides = [
        { nu: -1, nv: 0 }, { nu: 1, nv: 0 }, { nu: 0, nv: -1 }, { nu: 0, nv: 1 },
      ];
      const shift = [0, 0, 0, 0];
      sides.forEach((s, si2) => {
        const along = s.nu !== 0 ? rh : rw, base = s.nu !== 0 ? rw / 2 : rh / 2;
        let bestT = 0, bestV = -1;
        for (let off = -span; off <= span; off += step) {
          let acc = 0, n = 0;
          for (let k = 0; k < 48; k++) {
            const a = (-0.42 + 0.84 * k / 47) * along;
            const pos = base + off;
            const ui = s.nu !== 0 ? s.nu * (pos - d) : a, vi = s.nu !== 0 ? a : s.nv * (pos - d);
            const uo = s.nu !== 0 ? s.nu * (pos + d) : a, vo = s.nu !== 0 ? a : s.nv * (pos + d);
            const [xi, yi] = toImg(ui, vi), [xo, yo] = toImg(uo, vo);
            const A = bilinear(g, w, h, xi, yi), B = bilinear(g, w, h, xo, yo);
            if (A !== A || B !== B) continue;
            acc += A - B; n++;
          }
          if (n < 12) continue;
          const v = Math.abs(acc / n);
          if (v > bestV) { bestV = v; bestT = off; }
        }
        shift[si2] = bestV > 4 ? bestT : 0;
      });
      // left/right move u bounds, top/bottom move v bounds
      const u0 = -rw / 2 - shift[0], u1 = rw / 2 + shift[1], v0 = -rh / 2 - shift[2], v1 = rh / 2 + shift[3];
      const [ncx, ncy] = toImg((u0 + u1) / 2, (v0 + v1) / 2);
      cx = ncx; cy = ncy; rw = u1 - u0; rh = v1 - v0;
    }
    return { cx, cy, rw, rh, rot: r.rot };
  }

  const boxOf = (r) => {
    const t = r.rot * Math.PI / 180, ex = Math.abs(Math.cos(t)) * r.rw / 2 + Math.abs(Math.sin(t)) * r.rh / 2;
    const ey = Math.abs(Math.sin(t)) * r.rw / 2 + Math.abs(Math.cos(t)) * r.rh / 2;
    return { x0: r.cx - ex, x1: r.cx + ex, y0: r.cy - ey, y1: r.cy + ey };
  };
  const iou = (a, b) => {
    const A = boxOf(a), B = boxOf(b);
    const ix = Math.max(0, Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0)), iy = Math.max(0, Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0));
    const inter = ix * iy, ua = (A.x1 - A.x0) * (A.y1 - A.y0) + (B.x1 - B.x0) * (B.y1 - B.y0) - inter;
    return ua > 0 ? inter / ua : 0;
  };

  // job.small / job.big as for coins; job.prior (optional): {cx, cy, rw, rh, rot} in full-res px.
  // Returns {cx, cy, rw, rh, rot} in full-res px, or null.
  function detectRect(job) {
    const s = job.small, b = job.big, w = s.w, h = s.h;
    const blurred = boxBlur(s.g, w, h, 1);
    const thr = otsu(blurred);
    const above = [];
    for (let i = 0; i < blurred.length; i += 2) if (blurred[i] > thr) above.push(blurred[i]);
    const thr2 = above.length > 200 ? otsu(Float32Array.from(above)) : 255;
    const prior = job.prior ? { cx: job.prior.cx * s.scale, cy: job.prior.cy * s.scale, rw: job.prior.rw * s.scale, rh: job.prior.rh * s.scale, rot: job.prior.rot || 0 } : null;
    const cands = [], pool = [];
    const passes = [{ t: thr, bright: true, level: 0 }, { t: thr2, bright: true, level: 1 }, { t: thr, bright: false, level: 0 }];
    for (const pass of passes) {
      if (pass.level === 1 && pass.t >= 250) continue;
      const mask = new Uint8Array(w * h);
      for (let i = 0; i < mask.length; i++) mask[i] = pass.bright ? (blurred[i] > pass.t ? 1 : 0) : (blurred[i] <= pass.t ? 1 : 0);
      const { lab, comps } = components(mask, w, h);
      for (const c of comps) {
        if (c.n < w * h * 0.03) continue;
        const tilt = boundaryTilt(lab, c.id, c, w, h);
        const r = rectOfComponent(lab, c, w, tilt);
        if (r.fill < 0.55) continue;
        if (r.rw * r.rh > w * h * 0.985) continue; // the whole frame is not a find
        let score = c.n * r.fill * r.fill * (pass.bright ? 1 : 0.7);
        const cand = { ...r, score, level: pass.level, bright: pass.bright };
        pool.push(cand);
        if (prior) { const o = iou(r, prior); if (o < 0.35) continue; cand.score = o * o * o * r.fill * r.fill; }
        cands.push(cand);
      }
    }
    cands.sort((a, b) => b.score - a.score);
    let best = cands[0] || null;
    // A label is the brightest thing in the shot. If brighter rectangles sit inside the winner
    // (a label inside a pale slab), use them, joined together in case a coloured band splits the label.
    if (best) {
      const host = prior || best, B0 = boxOf(host);
      const mx = (B0.x1 - B0.x0) * 0.12, my = (B0.y1 - B0.y0) * 0.12;
      const B = prior ? { x0: B0.x0 - mx, x1: B0.x1 + mx, y0: B0.y0 - my, y1: B0.y1 + my } : B0;
      const nested = pool.filter((c) => c.bright && c.level === 1 && (prior || (c !== best && best.level === 0)) && c.fill >= 0.6 &&
        c.cx > B.x0 && c.cx < B.x1 && c.cy > B.y0 && c.cy < B.y1 && c.rw * c.rh >= host.rw * host.rh * 0.03);
      if (nested.length) {
        nested.sort((a, b) => b.rw * b.rh - a.rw * a.rh);
        const f = nested[0], t = f.rot * Math.PI / 180, co = Math.cos(t), si = Math.sin(t);
        let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
        for (const n of nested) {
          if (Math.abs(n.rot - f.rot) > 1.5) continue;
          const tn = n.rot * Math.PI / 180, cn = Math.cos(tn), sn = Math.sin(tn);
          for (const [a, b2] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            const px = n.cx + (a * n.rw / 2) * cn - (b2 * n.rh / 2) * sn - f.cx;
            const py = n.cy + (a * n.rw / 2) * sn + (b2 * n.rh / 2) * cn - f.cy;
            const u = px * co + py * si, v = -px * si + py * co;
            u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
          }
        }
        const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
        const U = { cx: f.cx + uc * co - vc * si, cy: f.cy + uc * si + vc * co, rw: u1 - u0, rh: v1 - v0, rot: f.rot };
        const ratio = (U.rw * U.rh) / (best.rw * best.rh);
        if (prior ? iou(U, prior) > iou(best, prior) : ratio >= 0.15 && ratio <= 0.92) best = U;
      }
    }
    let rect = best;
    if (!rect && prior) rect = { ...prior };
    if (!rect) return null;
    const k = b.scale / s.scale;
    const bg = boxBlur(b.g, b.w, b.h, 1);
    let rb = { cx: rect.cx * k, cy: rect.cy * k, rw: rect.rw * k, rh: rect.rh * k, rot: rect.rot };
    rb = snapRect(bg, b.w, b.h, rb, best ? 0.04 : 0.08);
    // A hair inside the printed edge, so the slab's border line never shows.
    const support = sideSupport(bg, b.w, b.h, rb);
    const inset = Math.min(rb.rw, rb.rh) * 0.006;
    rb.rw = Math.max(4, rb.rw - 2 * inset); rb.rh = Math.max(4, rb.rh - 2 * inset);
    return { cx: rb.cx / b.scale, cy: rb.cy / b.scale, rw: rb.rw / b.scale, rh: rb.rh / b.scale, rot: rb.rot, support };
  }

  // Share of the outline that has a strong edge on it, judged against the outline's own
  // strongest stretches. A coin's rim is edged all the way round; a label's is not round, etc.
  function strongShare(vals) {
    if (vals.length < 10) return 0;
    const sorted = vals.slice().sort((a, b) => a - b), top = sorted[Math.floor(sorted.length * 0.95)];
    if (top < 8) return 0;
    return vals.filter((v) => v >= top * 0.35).length / vals.length;
  }
  function ringSupport(g, w, h, c) {
    const vals = [], d = Math.max(1, c.r * 0.004);
    for (let k = 0; k < 180; k++) {
      const t = (k / 180) * Math.PI * 2, dx = Math.cos(t), dy = Math.sin(t);
      let m = 0;
      for (let rr = c.r * 0.98; rr <= c.r * 1.02; rr += 0.5) {
        const a = bilinear(g, w, h, c.cx + dx * (rr - d), c.cy + dy * (rr - d)), b2 = bilinear(g, w, h, c.cx + dx * (rr + d), c.cy + dy * (rr + d));
        if (a === a && b2 === b2) m = Math.max(m, Math.abs(b2 - a));
      }
      vals.push(m);
    }
    return strongShare(vals);
  }
  function sideSupport(g, w, h, r) {
    const t = r.rot * Math.PI / 180, co = Math.cos(t), si = Math.sin(t), vals = [];
    const span = Math.max(2, Math.min(r.rw, r.rh) * 0.015), d = 1.5;
    const at = (u, v) => [r.cx + u * co - v * si, r.cy + u * si + v * co];
    for (const [nu, nv] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const along = nu ? r.rh : r.rw, base = nu ? r.rw / 2 : r.rh / 2;
      for (let k = 0; k < 40; k++) {
        const a = (-0.4 + 0.8 * k / 39) * along;
        let m = 0;
        for (let off = -span; off <= span; off += 0.5) {
          const p = base + off;
          const [xi, yi] = nu ? at(nu * (p - d), a) : at(a, nv * (p - d));
          const [xo, yo] = nu ? at(nu * (p + d), a) : at(a, nv * (p + d));
          const A = bilinear(g, w, h, xi, yi), B = bilinear(g, w, h, xo, yo);
          if (A === A && B === B) m = Math.max(m, Math.abs(A - B));
        }
        vals.push(m);
      }
    }
    return strongShare(vals);
  }

  // Is this photo a coin or a certificate? Runs both finders and reports how well each fits.
  function classify(job) {
    let coin = null, rect = null;
    try { rect = detectRect(job); } catch (e) { rect = null; }
    try { coin = detect(job, rect); } catch (e) { coin = null; }
    return { coin, rect, certScore: (rect ? rect.support : 0) - (coin ? coin.support : 0) };
  }

  function run(job) { return job.kind === "rect" ? detectRect(job) : job.kind === "classify" ? classify(job) : detect(job); }

  return { run, detect, detectRect, classify, findCircle, refineCircle, fitCircle, pickRing, snapRect, holderTilt, labelSide, holderOrient };
}

if (typeof module !== "undefined") module.exports = coinDetectModule;
