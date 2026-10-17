// Which way up is this coin? Matched against upright coins of known types by their design.
// A coin crop (the coin filling a square) is reduced to a ring-by-ring map of where its relief
// edges sit around the centre. Turning the coin only slides that map round, so lining it up
// against an upright reference gives both how well the designs agree and the exact angle.
// Self-contained (no DOM) so it can be tested in Node and run anywhere.
function typeMatchModule() {
  "use strict";
  const N = 256;            // crop size the map is measured on
  const A = 256;            // steps around the coin (1.4° each, refined between steps)
  const NR = 20;            // rings, from near the centre to just inside the legend's outer edge
  const R0 = 0.12, R1 = 0.93;
  const POOL = 4, AC = A / POOL;

  function blur3(src, n) {
    const tmp = new Float32Array(n * n), out = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
      const o = y * n;
      for (let x = 0; x < n; x++) {
        const l = src[o + Math.max(0, x - 1)], r = src[o + Math.min(n - 1, x + 1)];
        tmp[o + x] = 0.25 * l + 0.5 * src[o + x] + 0.25 * r;
      }
    }
    for (let y = 0; y < n; y++) {
      const u = Math.max(0, y - 1) * n, d = Math.min(n - 1, y + 1) * n, o = y * n;
      for (let x = 0; x < n; x++) out[o + x] = 0.25 * tmp[u + x] + 0.5 * tmp[o + x] + 0.25 * tmp[d + x];
    }
    return out;
  }

  // gray: n×n values 0–255 with the coin filling the square. Returns the map, each ring
  // scaled to zero mean and unit spread, as a Float32Array of NR × A.
  function describe(gray, n) {
    if (n !== N) gray = resample(gray, n, N);
    // relative contrast: lighting and toning change brightness, the relief's edges stay put
    const L = new Float32Array(N * N);
    for (let i = 0; i < L.length; i++) L[i] = Math.log(gray[i] + 10);
    const B = blur3(L, N), G = new Float32Array(N * N);
    for (let y = 1; y < N - 1; y++) {
      for (let x = 1; x < N - 1; x++) {
        const i = y * N + x, gx = B[i + 1] - B[i - 1], gy = B[i + N] - B[i - N];
        G[i] = Math.sqrt(Math.sqrt(gx * gx + gy * gy));
      }
    }
    const S = blur3(blur3(G, N), N);
    const out = new Float32Array(NR * A), c = (N - 1) / 2, R = N / 2;
    for (let k = 0; k < NR; k++) {
      const rad = R * (R0 + ((R1 - R0) * (k + 0.5)) / NR);
      let sum = 0, sq = 0;
      for (let a = 0; a < A; a++) {
        const t = (2 * Math.PI * a) / A, sx = c + rad * Math.sin(t), sy = c - rad * Math.cos(t);
        const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0, i = y0 * N + x0;
        const v = S[i] * (1 - fx) * (1 - fy) + S[i + 1] * fx * (1 - fy) + S[i + N] * (1 - fx) * fy + S[i + N + 1] * fx * fy;
        out[k * A + a] = v; sum += v; sq += v * v;
      }
      normRing(out, k * A, A, sum, sq);
    }
    return out;
  }
  function normRing(arr, o, len, sum, sq) {
    if (sum === undefined) { sum = 0; sq = 0; for (let i = 0; i < len; i++) { sum += arr[o + i]; sq += arr[o + i] * arr[o + i]; } }
    const m = sum / len, sd = Math.sqrt(Math.max(0, sq / len - m * m));
    for (let i = 0; i < len; i++) arr[o + i] = sd > 1e-6 ? (arr[o + i] - m) / sd : 0;
  }
  function resample(src, n, m) {
    const out = new Float32Array(m * m), k = n / m;
    for (let y = 0; y < m; y++) {
      for (let x = 0; x < m; x++) {
        const sx = Math.min(n - 1.001, (x + 0.5) * k - 0.5), sy = Math.min(n - 1.001, (y + 0.5) * k - 0.5);
        const x0 = Math.max(0, Math.floor(sx)), y0 = Math.max(0, Math.floor(sy)), fx = sx - x0, fy = sy - y0, i = y0 * n + x0;
        out[y * m + x] = src[i] * (1 - fx) * (1 - fy) + src[i + 1] * fx * (1 - fy) + src[i + n] * (1 - fx) * fy + src[i + n + 1] * fx * fy;
      }
    }
    return out;
  }
  function pooled(d) {
    const out = new Float32Array(NR * AC);
    for (let k = 0; k < NR; k++) {
      for (let a = 0; a < AC; a++) {
        let s = 0;
        for (let j = 0; j < POOL; j++) s += d[k * A + a * POOL + j];
        out[k * AC + a] = s;
      }
      normRing(out, k * AC, AC);
    }
    return out;
  }
  const W = Array.from({ length: NR }, (_, k) => 0.6 + (k + 0.5) / NR);
  const WSUM = W.reduce((a, b) => a + b, 0);
  // Agreement (−1 to 1) with the reference turned so its step `s` lines up with step 0.
  function corrAt(q, ref, len, s) {
    let tot = 0;
    for (let k = 0; k < NR; k++) {
      const o = k * len;
      let acc = 0;
      for (let a = 0; a < len; a++) acc += q[o + a] * ref[o + ((a + s) % len)];
      tot += W[k] * acc;
    }
    return tot / (len * WSUM);
  }

  // A prepared reference or query: the full map and a coarse copy for a quick first pass.
  function prepare(d) { return { d, c: pooled(d) }; }

  // How far the query is turned (degrees clockwise) from the reference, how well they agree,
  // and how much better that is than the best answer at least 40° away.
  function compare(q, ref) {
    const cs = new Float32Array(AC);
    for (let s = 0; s < AC; s++) cs[s] = corrAt(q.c, ref.c, AC, s);
    // the strongest few coarse peaks, refined on the full map
    const peaks = [];
    for (let s = 0; s < AC; s++) {
      const l = cs[(s + AC - 1) % AC], r = cs[(s + 1) % AC];
      if (cs[s] >= l && cs[s] >= r) peaks.push(s);
    }
    peaks.sort((a, b) => cs[b] - cs[a]);
    let best = { score: -2, s: 0 };
    for (const p of peaks.slice(0, 3)) {
      for (let f = p * POOL - POOL - 2; f <= p * POOL + POOL + 2; f++) {
        const s = ((f % A) + A) % A, v = corrAt(q.d, ref.d, A, s);
        if (v > best.score) best = { score: v, s };
      }
    }
    const l = corrAt(q.d, ref.d, A, (best.s + A - 1) % A), r = corrAt(q.d, ref.d, A, (best.s + 1) % A);
    const den = l - 2 * best.score + r, off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den)) : 0;
    // query step a matches reference step a + s: the query is the reference turned by -s steps
    const shift = ((best.s + off) * 360) / A;
    let turn = -shift;
    turn = ((turn + 180) % 360 + 360) % 360 - 180;
    const bestC = Math.round((best.s + off) / POOL);
    let second = -2;
    for (let s = 0; s < AC; s++) {
      const dist = Math.min(Math.abs(s - bestC) % AC, AC - (Math.abs(s - bestC) % AC));
      if (dist * POOL * (360 / A) >= 40 && cs[s] > second) second = cs[s];
    }
    // the coarse map scores a little higher than the full one; compare like with like
    const coarseBest = cs[((bestC % AC) + AC) % AC];
    return { turn: Math.round(turn * 10) / 10, score: best.score, margin: coarseBest - second };
  }

  // Compact storage: a byte per step.
  function pack(d) {
    const b = new Uint8Array(d.length);
    for (let i = 0; i < d.length; i++) b[i] = Math.max(0, Math.min(255, Math.round(d[i] * 32 + 128)));
    return b;
  }
  function unpack(b) {
    const d = new Float32Array(b.length);
    for (let i = 0; i < b.length; i++) d[i] = (b[i] - 128) / 32;
    for (let k = 0; k < NR; k++) normRing(d, k * A, A);
    return d;
  }
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function toB64(b) {
    let s = "";
    for (let i = 0; i < b.length; i += 3) {
      const n = (b[i] << 16) | ((b[i + 1] || 0) << 8) | (b[i + 2] || 0);
      s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < b.length ? B64[n & 63] : "=");
    }
    return s;
  }
  function fromB64(s) {
    const clean = s.replace(/[^A-Za-z0-9+/]/g, ""), out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let o = 0;
    for (let i = 0; i < clean.length; i += 4) {
      const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12) | ((B64.indexOf(clean[i + 2]) & 63) << 6) | (B64.indexOf(clean[i + 3]) & 63);
      if (o < out.length) out[o++] = (n >> 16) & 255;
      if (o < out.length) out[o++] = (n >> 8) & 255;
      if (o < out.length) out[o++] = n & 255;
    }
    return out;
  }

  return { N, A, NR, describe, prepare, compare, pack, unpack, toB64, fromB64 };
}

if (typeof module !== "undefined") module.exports = typeMatchModule;
