(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const CoinDetect = coinDetectModule();
  const FONT_CAPTION = 'Tinos, "Times New Roman", Times, serif';
  const FONT_BODY = '"IBM Plex Sans", system-ui, -apple-system, sans-serif';
  const FONT_MONO = '"IBM Plex Mono", ui-monospace, monospace';
  const RING = "#E9C767";
  const TAU = Math.PI * 2;
  const dpr = () => Math.min(2, window.devicePixelRatio || 1);
  const isCoin = (key) => key !== "cert";
  const tick = () => new Promise((r) => setTimeout(r, 20));

  /* ---------- plate design: square, coins on top, certificate sized to its own shape below ---------- */
  const BG = {
    black: { bg: "#000000", cap: "#FFFFFF", empty: "#55524B", shadow: null, edge: null },
    graphite: { bg: "#1C2024", cap: "#F1EFE9", empty: "#59606A", shadow: "rgba(0,0,0,0.5)", edge: null },
    white: { bg: "#FFFFFF", cap: "#111315", empty: "#BCC2C8", shadow: "rgba(18,22,26,0.28)", edge: "rgba(0,0,0,0.16)" },
  };
  const P = { S: 2000, margin: 56, d: 905, top: 48, capSize: 50, capGap: 64, certTop: 1090, certTopNoCap: 1005, certBottom: 1952, certMaxW: 1800 };
  const EXAMPLE_CERT_ASPECT = 1.08;
  const FIELDS = { date: "fDate", denom: "fDenom", grade: "fGrade", service: "fService", cert: "fCert", notes: "fNotes" };

  /* ---------- per-viewer look settings ---------- */
  const STORE_KEY = "slabplates.look.v2";
  const look = { bg: "black", captions: true };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    if (BG[saved.bg]) look.bg = saved.bg;
    if (typeof saved.captions === "boolean") look.captions = saved.captions;
  } catch (e) { /* storage unavailable */ }
  const saveLook = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(look)); } catch (e) { /* ignore */ } };

  /* ---------- capabilities ----------
     In the Android app, labels are read and plates saved on the phone (SlabVision plugin).
     In claude.ai, Claude reads labels on the viewer's own account and the viewer saves files. */
  const capx = window.capacitorExports;
  const isNative = !!(capx && capx.Capacitor && typeof capx.Capacitor.isNativePlatform === "function" && capx.Capacitor.isNativePlatform());
  const Vision = isNative ? capx.registerPlugin("SlabVision") : null;
  const LabelParse = typeof labelParseModule === "function" ? labelParseModule() : null;
  const cl = window.claude;
  const canUse = !isNative && cl && typeof cl.use === "function";
  const samplePromise = canUse ? cl.use("sample").catch(() => null) : Promise.resolve(null);
  const downloadsPromise = canUse ? cl.use("downloads").catch(() => null) : Promise.resolve(null);
  let sampleState = isNative ? "native" : "pending";
  let imageLimits = null;
  const canRead = () => sampleState === "ready" || sampleState === "native";
  if (!isNative) samplePromise.then(async (s) => {
    if (!s) { sampleState = "unavailable"; markDirty(); return; }
    try { const lim = await s.limits(); imageLimits = lim && lim.images ? lim.images : null; } catch (e) { imageLimits = null; }
    sampleState = imageLimits ? "ready" : "unavailable";
    markDirty();
  });

  /* ---------- state ---------- */
  let verSeq = 0, photoSeq = 0;
  const blankSide = () => ({ src: null, w: 0, h: 0, cx: 0, cy: 0, r: 0, rot: 0, rw: 0, rh: 0, base: 0, tilt: 0,
    ver: ++verSeq, photoId: 0, manual: false, found: false, busy: false, rings: [], ringIdx: 0, prior: null,
    orient: null, rotAuto: true, upFrom: "", textUp: null, textFine: null, typeM: null, typeKey: "", textDone: false, textJob: null, legend: 0,
    grays: null, note: "", ed: null, edKey: "", tile: null, tileKey: "" });
  const sides = { obv: blankSide(), rev: blankSide(), cert: blankSide() };
  let active = "obv";
  const bump = (side) => { side.ver = ++verSeq; markDirty(); };
  const values = () => { const o = {}; for (const k in FIELDS) o[k] = $(FIELDS[k]).value.trim(); return o; };
  const exampleMode = () => !sides.obv.src && !sides.rev.src && !sides.cert.src;
  const certRot = (s) => s.base + s.tilt;

  /* ---------- canvas helpers ---------- */
  function scaledCanvas(src, sw, sh, maxDim) {
    const s = Math.min(1, maxDim / Math.max(sw, sh));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(sw * s));
    c.height = Math.max(1, Math.round(sh * s));
    const x = c.getContext("2d");
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = "high";
    x.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  function grayData(c, fullW) {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    const g = new Float32Array(c.width * c.height);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    return { g, w: c.width, h: c.height, scale: c.width / fullW };
  }
  function graysFor(side) {
    if (!side.grays) {
      const big = scaledCanvas(side.src, side.w, side.h, 1600);
      const small = scaledCanvas(big, big.width, big.height, 420);
      side.grays = { big: grayData(big, side.w), small: grayData(small, side.w) };
    }
    return side.grays;
  }
  const toJpeg = (canvas, maxDim) => new Promise((resolve) => scaledCanvas(canvas, canvas.width, canvas.height, maxDim).toBlob(resolve, "image/jpeg", 0.92));

  /* ---------- detection, in a worker when possible ---------- */
  let worker = null, jobSeq = 0;
  const pending = new Map();
  function dropWorker() { worker = null; for (const [id, p] of pending) { pending.delete(id); p.local(); } }
  try {
    const src = "const CD=(" + coinDetectModule.toString() + ")();onmessage=function(e){var d=e.data,res=null,err=null;try{res=CD.run(d.job);}catch(x){err=String((x&&x.message)||x);}postMessage({id:d.id,res:res,err:err});};";
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.err) p.local(); else p.done(e.data.res);
    };
    worker.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); dropWorker(); };
  } catch (e) { worker = null; }

  function runDetect(job) {
    return new Promise((resolve) => {
      let settled = false, timer = 0;
      const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
      const local = () => { if (settled) return; try { done(CoinDetect.run(job)); } catch (e) { done(null); } };
      if (!worker) { setTimeout(local, 30); return; }
      const id = ++jobSeq;
      timer = setTimeout(() => { if (pending.has(id)) { pending.delete(id); worker = null; local(); } }, 9000);
      pending.set(id, { done, local });
      try { worker.postMessage({ id, job }); } catch (e) { pending.delete(id); local(); }
    });
  }

  function applyCoin(side, res, key) {
    if (res && isFinite(res.r) && res.r > 6) {
      side.rings = [{ cx: res.cx, cy: res.cy, r: res.r }].concat(res.alts || []);
      side.ringIdx = 0;
      Object.assign(side, side.rings[0]);
      side.found = true; side.manual = false; side.note = "";
      side.orient = res.orient || null;
      if (side.rotAuto) side.rot = autoRot(side, key);
    } else {
      side.found = false;
      side.note = "Couldn't find the coin's edge in this photo. Drag the ring onto the coin and size it to the rim.";
    }
  }

  /* ---------- straightening the coins ----------
     The holder's straight edges give the exact angle (detect.js). Which way is up: the label
     when it's in the photo (above the obverse; below the reverse, as Canadian and US coins are
     struck with coin alignment, so turning the holder over top to bottom shows the reverse
     upright); otherwise the photo as taken, or for a reverse, how this person usually shoots
     holder backs. On the phone the legend is read too (lettering across the top faces outward,
     along the bottom inward) and turns a coin over when it clearly disagrees. A coin someone
     has turned by hand is left alone. */
  const wrap180 = (d) => { let v = ((d + 180) % 360 + 360) % 360 - 180; if (v === -180) v = 180; return v; };
  const QUARTER = { up: 0, right: 90, down: 180, left: 270 };
  // How this person usually shoots holder backs, learned from the reverses they turned over by
  // hand when nothing in the photo said which way was up: true when they come out upside down.
  const HABIT_KEY = "slabplates.reverseHabit";
  let revHabit = [];
  try { const h = JSON.parse(localStorage.getItem(HABIT_KEY) || "[]"); if (Array.isArray(h)) revHabit = h.filter((v) => typeof v === "boolean").slice(-5); } catch (e) { /* none yet */ }
  const revUpsideDown = () => revHabit.length >= 2 && revHabit.slice(-3).filter(Boolean).length >= 2;
  // Returns the rotation and what decided which way is up.
  function straightenOf(side, key, useHabit) {
    const o = side.orient, t = side.textUp;
    const base = o ? -o.tilt : 0;
    const cands = [0, 90, 180, 270].map((q) => Math.round(wrap180(base + q) * 10) / 10);
    // The coin's own lettering has the last word: a coin can sit crooked in its holder. When it
    // lands within a few degrees of a way the holder is square, the holder's exact angle is used.
    // A match against the coin's own type (its design) comes first, then its lettering.
    const own = side.typeM ? { up: side.typeM.up, sq: "type", turned: "type" } : typeof side.textFine === "number" ? { up: side.textFine, sq: "text", turned: "coin" } : null;
    if (own) {
      const want = wrap180(-own.up);
      let best = 0;
      cands.forEach((c, q) => { if (Math.abs(wrap180(c - want)) < Math.abs(wrap180(cands[best] - want))) best = q; });
      // (with no holder edges in view there's nothing exact to snap to)
      return o && Math.abs(wrap180(cands[best] - want)) <= 3 ? { rot: cands[best], from: own.sq } : { rot: Math.round(want * 10) / 10, from: own.turned };
    }
    let pick = 0, from = "photo";
    if (o && o.label && QUARTER[o.label] != null) { pick = (((key === "rev" ? 2 : 0) - QUARTER[o.label] / 90) % 4 + 4) % 4; from = "label"; }
    else if (key === "rev" && useHabit !== false && revUpsideDown()) { pick = 2; from = "habit"; }
    if (t && isFinite(t.up)) {
      // The legend only settles up or down. Where its "up" lands for each choice: turn over when
      // it lands clearly nearer the bottom. A partly read legend can be a quarter turn out, so it
      // never turns a coin sideways, and it overrules the label only when it reads clearly.
      const err = (q) => Math.abs(wrap180(t.up + cands[q]));
      const alt = (pick + 2) % 4, clearly = err(alt) + 40 < err(pick);
      const trusted = t.strong || (key === "rev" && from !== "label");
      if (clearly && trusted) { pick = alt; from = "text"; }
      else if (!clearly && err(pick) < 50 && from !== "label") from = "text";
    }
    return { rot: cands[pick], from };
  }
  function autoRot(side, key) {
    ensureType(side, key);
    const s = straightenOf(side, key);
    side.upFrom = s.from;
    return s.rot;
  }
  // When a reverse is saved, note whether it ended up turned over from the photo as taken, but
  // only where the photo itself couldn't say (no label in view, nothing readable).
  function learnHabit() {
    const s = sides.rev;
    if (!s.src || !s.found) return;
    const plain = straightenOf(s, "rev", false);
    if (plain.from !== "photo") return;
    const d = Math.abs(wrap180(s.rot - plain.rot));
    if (d > 135) revHabit.push(true); else if (d < 45) revHabit.push(false); else return;
    revHabit = revHabit.slice(-5);
    try { localStorage.setItem(HABIT_KEY, JSON.stringify(revHabit)); } catch (e) { /* not kept */ }
  }
  function restraighten() {
    for (const key of ["obv", "rev"]) {
      const s = sides[key];
      if (!s.src || !s.rotAuto || !s.found) continue;
      const r = autoRot(s, key);
      if (r !== s.rot) { s.rot = r; bump(s); }
    }
  }
  /* ---------- coin types: turning a coin by its design ----------
     Each Canadian type from 1858 to 1967 has an upright obverse and reverse in coinrefs.js
     (from the Numista catalogue, reduced to a map of where the design's edges sit around the
     centre). The label's date and denomination say which type a coin is; its photo is then
     lined up against that type's design, which gives the exact angle whatever the lettering
     does. Plates you save add your own photos of each type, so it keeps getting surer. */
  const TypeMatch = typeof typeMatchModule === "function" ? typeMatchModule() : null;
  const typeLib = [];
  let typeLibVer = 0;
  if (TypeMatch && typeof coinRefsData === "function") {
    try {
      for (const r of coinRefsData()) typeLib.push({ side: r.s, denom: r.d, y0: r.y0, y1: r.y1, name: r.name, from: "catalogue", p: TypeMatch.prepare(TypeMatch.unpack(TypeMatch.fromB64(r.b))) });
    } catch (e) { typeLib.length = 0; }
  }
  const yearOf = (s) => { const m = String(s || "").match(/\b(1[5-9]\d\d|20\d\d)\b/); return m ? Number(m[1]) : 0; };
  const denomKey = (s) => { const d = s ? denomPart(s) : ""; return /^\d{4}(\.\d+)?c$/.test(d) ? d : ""; };
  // The coin as photographed (not turned), at the size the design map is measured on.
  function coinGray(side, rot) {
    const n = TypeMatch.N, c = document.createElement("canvas");
    c.width = c.height = n;
    const x = c.getContext("2d");
    x.fillStyle = "#000"; x.fillRect(0, 0, n, n);
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high";
    x.translate(n / 2, n / 2); x.rotate((rot * Math.PI) / 180);
    const k = n / (2 * side.r);
    x.scale(k, k);
    x.drawImage(side.src, -side.cx, -side.cy);
    const d = x.getImageData(0, 0, n, n).data, g = new Float32Array(n * n);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    return g;
  }
  const descCache = new Map();
  function coinDesc(side, rot) {
    const key = [side.photoId, Math.round(side.cx), Math.round(side.cy), Math.round(side.r), rot || 0].join("|");
    if (!descCache.has(key)) {
      if (descCache.size > 12) descCache.delete(descCache.keys().next().value);
      descCache.set(key, TypeMatch.prepare(TypeMatch.describe(coinGray(side, rot || 0), TypeMatch.N)));
    }
    return descCache.get(key);
  }
  // Which references to try: this side's, of the label's year and denomination when known. With
  // a year but no reference of that denomination, the same years' other coins stand in (a
  // monarch's portrait is the same design on every denomination).
  function typeCands(key) {
    const v = values(), denom = denomKey(v.denom), year = yearOf(v.date);
    const all = typeLib.filter((r) => r.side === key);
    const byYear = year ? all.filter((r) => year >= r.y0 && year <= r.y1) : [];
    const exact = denom ? byYear.filter((r) => r.denom === denom) : [];
    if (exact.length) return { list: exact, mode: "exact" };
    if (byYear.length) return { list: byYear, mode: "era" };
    const byDenom = denom ? all.filter((r) => r.denom === denom) : [];
    return { list: byDenom.length ? byDenom : all, mode: "guess" };
  }
  // How sure a match has to be, measured on photos of the same designs taken by different people
  // (score 0.2 lines up within 4° about 96% of the time; other designs rarely pass 0.3). Knowing
  // the type from the label, the design only has to line up; guessing, it must stand clear.
  const TYPE_SURE = { exact: { score: 0.2, margin: 0.05 }, era: { score: 0.25, margin: 0.08 }, guess: { score: 0.33, margin: 0.1 } };
  function matchType(side, key) {
    const { list, mode } = typeCands(key);
    if (!list.length) return null;
    const q = coinDesc(side, 0);
    const ms = list.map((r) => ({ ...TypeMatch.compare(q, r.p), ref: r })).sort((a, b) => b.score - a.score);
    const best = ms[0], need = TYPE_SURE[mode];
    // two photos of the type agreeing count as much as one clear match
    const agree = ms.filter((m) => m !== best && m.score >= 0.15 && Math.abs(wrap180(m.turn - best.turn)) <= 5);
    const sure = (best.score >= need.score && best.margin >= need.margin) || (mode !== "guess" && best.score >= 0.15 && agree.length > 0);
    if (!sure) return null;
    // a different design scoring nearly as well but pointing elsewhere: not sure enough
    const rival = ms.find((m) => m.ref.name !== best.ref.name && Math.abs(wrap180(m.turn - best.turn)) > 10);
    if (mode === "guess" && rival && rival.score > best.score - 0.04) return null;
    // the angle: the good matches that agree with the best, weighted by how well they match
    let wx = 0, wy = 0;
    for (const m of [best, ...agree]) { if (m.score < best.score - 0.1) continue; const t = (m.turn * Math.PI) / 180; wx += m.score * Math.cos(t); wy += m.score * Math.sin(t); }
    const up = Math.round(((Math.atan2(wy, wx) * 180) / Math.PI) * 10) / 10;
    return { up, score: Math.round(best.score * 100) / 100, name: best.ref.name, from: best.ref.from, mode };
  }
  function ensureType(side, key) {
    if (!TypeMatch || !side.src || !side.found || !typeLib.length) { side.typeM = null; return; }
    const v = values();
    const tk = [side.photoId, Math.round(side.cx), Math.round(side.cy), Math.round(side.r), key, denomKey(v.denom), yearOf(v.date), typeLibVer].join("|");
    if (side.typeKey === tk) return;
    side.typeKey = tk;
    try { side.typeM = matchType(side, key); } catch (e) { side.typeM = null; }
  }

  // Your own saved plates, kept on this device, teach it each type in your lighting.
  const TYPE_DB = "slabplates-types", MINE_PER = 8;
  function typeDb() {
    return new Promise((ok, no) => {
      if (!window.indexedDB) { no(new Error("no storage")); return; }
      const r = indexedDB.open(TYPE_DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("refs", { keyPath: "id", autoIncrement: true });
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error);
    });
  }
  const dbAll = (db) => new Promise((ok, no) => { const q = db.transaction("refs").objectStore("refs").getAll(); q.onsuccess = () => ok(q.result || []); q.onerror = () => no(q.error); });
  const dbDo = (db, fn) => new Promise((ok, no) => { const t = db.transaction("refs", "readwrite"); fn(t.objectStore("refs")); t.oncomplete = () => ok(); t.onerror = () => no(t.error); });
  if (TypeMatch) typeDb().then(dbAll).then((rows) => {
    for (const r of rows) typeLib.push({ id: r.id, side: r.side, denom: r.denom, y0: r.year, y1: r.year, name: r.name, from: "yours", at: r.at, p: TypeMatch.prepare(TypeMatch.unpack(TypeMatch.fromB64(r.b))) });
    if (rows.length) { typeLibVer++; restraighten(); }
  }).catch(() => { /* kept for this session only */ });
  async function learnTypes() {
    if (!TypeMatch) return;
    const v = values(), denom = denomKey(v.denom), year = yearOf(v.date);
    if (!denom || !year) return;
    const add = [];
    for (const key of ["obv", "rev"]) {
      const s = sides[key];
      if (!s.src || !s.found) continue;
      const d = TypeMatch.describe(coinGray(s, s.rot), TypeMatch.N), p = TypeMatch.prepare(d);
      const same = typeLib.filter((r) => r.side === key && r.denom === denom && year >= r.y0 && year <= r.y1);
      // as saved it should be upright: skip it if the catalogue design says otherwise, or if
      // it's a near copy of one already kept
      let skip = false;
      for (const r of same) {
        const m = TypeMatch.compare(p, r.p);
        if (r.from === "catalogue" && m.score >= TYPE_SURE.exact.score && Math.abs(m.turn) > 8) skip = true;
        if (r.from === "yours" && m.score > 0.85 && Math.abs(m.turn) < 2) skip = true;
      }
      if (!skip) add.push({ side: key, denom, year, name: [v.date, v.denom].filter(Boolean).join(" "), at: Date.now(), b: TypeMatch.toB64(TypeMatch.pack(d)), p });
    }
    if (!add.length) return;
    for (const a of add) typeLib.push({ side: a.side, denom: a.denom, y0: a.year, y1: a.year, name: a.name, from: "yours", at: a.at, p: a.p });
    typeLibVer++;
    try {
      const db = await typeDb();
      await dbDo(db, (st) => { for (const a of add) { const { p, ...row } = a; st.add(row); } });
      // keep the newest few of each denomination and side
      const rows = await dbAll(db), drop = [];
      const groups = new Map();
      for (const r of rows) { const g = r.side + r.denom; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); }
      for (const g of groups.values()) if (g.length > MINE_PER) drop.push(...g.sort((a, b) => b.at - a.at).slice(MINE_PER));
      if (drop.length) await dbDo(db, (st) => { for (const r of drop) st.delete(r.id); });
    } catch (e) { /* this session only */ }
  }

  function applyRect(side, res, prior) {
    if (res && res.rw > 8 && res.rh > 8) {
      Object.assign(side, { cx: res.cx, cy: res.cy, rw: res.rw, rh: res.rh, base: 0, tilt: Math.round(res.rot * 10) / 10 });
      side.found = true; side.manual = false; side.note = "";
    } else if (!prior) {
      const m = Math.min(side.w, side.h) * 0.01;
      Object.assign(side, { cx: side.w / 2, cy: side.h / 2, rw: side.w - 2 * m, rh: side.h - 2 * m, base: 0, tilt: 0 });
      side.found = false;
      side.note = "Using the whole photo. If the label is smaller than the frame, drag the corners onto it.";
    }
  }

  async function detectSide(key, prior) {
    const side = sides[key];
    if (!side.src) return;
    const pid = side.photoId;
    side.busy = true; side.note = "";
    markDirty();
    await tick();
    const g = graysFor(side);
    const res = await runDetect({ kind: isCoin(key) ? "coin" : "rect", small: g.small, big: g.big, prior: prior || null });
    if (side.photoId !== pid) return;
    if (isCoin(key)) applyCoin(side, res, key); else applyRect(side, res, prior);
    if (!isCoin(key) && isNative && !prior) await refineCertByText(side);
    if (side.photoId !== pid) return;
    side.busy = false;
    bump(side);
    if (isCoin(key) && isNative) textPass(false);
  }

  /* ---------- loading photos ---------- */
  async function decodePhoto(file) {
    const viaImage = async (src, cleanup) => {
      const img = new Image();
      img.src = src;
      try {
        if (img.decode) await img.decode();
        else await new Promise((ok, no) => { img.onload = ok; img.onerror = no; });
        if (img.naturalWidth > 0) return { el: img, w: img.naturalWidth, h: img.naturalHeight, done: cleanup };
      } catch (e) { /* try the next way */ }
      if (cleanup) cleanup();
      return null;
    };
    let url = "";
    try { url = URL.createObjectURL(file); } catch (e) { url = ""; }
    if (url) { const r = await viaImage(url, () => URL.revokeObjectURL(url)); if (r) return r; }
    try {
      const dataUrl = await new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = no; fr.readAsDataURL(file); });
      const r = await viaImage(dataUrl, null);
      if (r) return r;
    } catch (e) { /* try the next way */ }
    if (window.createImageBitmap) {
      try {
        const bm = await createImageBitmap(file, { imageOrientation: "from-image" });
        return { el: bm, w: bm.width, h: bm.height, done: () => bm.close && bm.close() };
      } catch (e) { /* give up */ }
    }
    return null;
  }

  async function sideFromFile(file) {
    const pic = await decodePhoto(file);
    if (!pic) return null;
    const c = scaledCanvas(pic.el, pic.w, pic.h, 3000);
    if (pic.done) pic.done();
    const side = blankSide();
    Object.assign(side, { src: c, w: c.width, h: c.height, photoId: ++photoSeq,
      cx: c.width / 2, cy: c.height / 2, r: Math.min(c.width, c.height) * 0.35, rw: c.width * 0.8, rh: c.height * 0.8, file });
    return side;
  }
  // A second use of the same photo (a holder front is both the obverse and the certificate).
  function sharedSide(base) {
    const s = blankSide();
    Object.assign(s, { src: base.src, w: base.w, h: base.h, file: base.file, grays: base.grays, photoId: ++photoSeq,
      cx: base.w / 2, cy: base.h / 2, r: Math.min(base.w, base.h) * 0.35, rw: base.w * 0.8, rh: base.h * 0.4 });
    return s;
  }

  // Several photos at once: work out which is the certificate, put the coins in the order
  // they were picked, then let Claude read the label and confirm which coin is the obverse.
  async function loadMany(fileList, plan) {
    const all = [...fileList];
    const keep = all.map((f, i) => i).filter((i) => !all[i].type || /^image\//.test(all[i].type));
    const files = keep.map((i) => all[i]);
    if (plan) plan = keep.map((i) => plan[i]);
    if (!files.length) { toast("Those files aren't photos. Choose JPGs or PNGs."); return; }
    if (!batch.active && (files.length > 1 || soloListing.itemId)) newSoloListing();
    if (files.length === 1) { loadPhoto(files[0], !sides.obv.src ? "obv" : !sides.rev.src ? "rev" : "cert"); return; }
    const use = files.slice(0, 3);
    toast(files.length > 3 ? "Using the first three photos." : `Sorting ${use.length} photos…`);
    const loaded = [], lplan = [];
    for (let i = 0; i < use.length; i++) { const s = await sideFromFile(use[i]); if (s) { loaded.push(s); lplan.push(plan ? plan[i] : null); } }
    if (!loaded.length) { toast("Couldn't open those photos. Try JPGs or PNGs from your gallery."); return; }
    loaded.forEach((s) => { s.busy = true; });
    // show them while sorting
    const keys0 = ["obv", "rev", "cert"];
    loaded.forEach((s, i) => { sides[keys0[i]] = s; });
    markDirty();
    await tick();
    const results = [], roles = [];
    for (const s of loaded) {
      const g = graysFor(s);
      const r = await runDetect({ kind: "classify", small: g.small, big: g.big });
      results.push(r);
      roles.push(await roleOf(s, r));
    }
    const stepAt = (st) => lplan.findIndex((p) => p && p.step === st);
    const guided = lplan.length > 0 && lplan.every(Boolean);
    let frontIdx = roles.findIndex((r) => r.role === "front");
    let certIdx = frontIdx;
    let coinIdx = null;
    const certLike = (i) => (roles[i].role === "label" ? 2 : 0) + (results[i] ? results[i].certScore : -1)
      - (results[i] && results[i].coin ? 0.5 * (results[i].coin.support || 0) : 0);
    if (guided && lplan[0].mode === "three") {
      // taken with the camera's prompts: obverse, reverse, certificate, in that order
      coinIdx = [stepAt(0), stepAt(1)].filter((i) => i >= 0);
      certIdx = stepAt(2);
      frontIdx = -1;
    } else if (guided && lplan[0].mode === "two") {
      // holder front (obverse and label) and holder back
      coinIdx = [stepAt(0), stepAt(1)].filter((i) => i >= 0);
      certIdx = stepAt(0);
      frontIdx = certIdx;
      if (certIdx >= 0 && roles[certIdx].role !== "front") roles[certIdx] = { role: "front", rect: results[certIdx] && results[certIdx].rect };
    } else if (frontIdx >= 0 && loaded.length >= 3) {
      // three photos and one shows the label beside the coin (an ICCS holder, say): the photo
      // that looks most like a certificate on its own is the certificate; the front is the obverse
      const others = loaded.map((_, i) => i).filter((i) => i !== frontIdx);
      certIdx = others.reduce((b, i) => (certLike(i) > certLike(b) ? i : b), others[0]);
      frontIdx = -1;
      const fi = roles.findIndex((r) => r.role === "front");
      coinIdx = [fi].concat(others.filter((i) => i !== certIdx));
    } else if (certIdx < 0) {
      results.forEach((r, i) => {
        const sc = r ? r.certScore : -1;
        if (certIdx < 0 || sc > (results[certIdx] ? results[certIdx].certScore : -1)) certIdx = i;
      });
      if (loaded.length < 3 && !(results[certIdx] && results[certIdx].certScore > 0.2)) certIdx = -1;
    }
    // the holder front is the obverse; other coin photos follow in the order picked
    if (!coinIdx) coinIdx = loaded.map((_, i) => i).filter((i) => i === frontIdx || i !== certIdx)
      .sort((p, q) => (q === frontIdx) - (p === frontIdx));
    sides.obv = blankSide(); sides.rev = blankSide();
    if (certIdx >= 0) sides.cert = blankSide();
    coinIdx.slice(0, 2).forEach((i, n) => {
      const s = loaded[i]; s.busy = false;
      applyCoin(s, results[i] && results[i].coin, n === 0 ? "obv" : "rev");
      sides[n === 0 ? "obv" : "rev"] = s; bump(s);
    });
    if (certIdx >= 0) {
      const base = loaded[certIdx], s = certIdx === frontIdx ? sharedSide(base) : base;
      s.busy = false;
      applyRect(s, certIdx === frontIdx ? roles[certIdx].rect || (results[certIdx] && results[certIdx].rect) : results[certIdx] && results[certIdx].rect, null);
      sides.cert = s; bump(s);
    }
    setActive("obv");
    $("toast").hidden = true;
    // with the camera's prompts the obverse is known, so it isn't second-guessed
    const both = !!(sides.obv.src && sides.rev.src) && !guided;
    if (sides.cert.src && canRead()) readCert({ checkSides: both });
    else {
      if (isNative) textPass(both);
      toast(certIdx >= 0 ? "Sorted. Check obverse and reverse, and tap Swap if they're the wrong way round." : "Couldn't tell which photo is the certificate. Check the tiles.");
    }
  }

  async function loadPhoto(file, key) {
    if (!file) return;
    if (file.type && !/^image\//.test(file.type)) { toast("That file isn't a photo. Choose a JPG or PNG."); return; }
    toast("Opening photo…");
    const side = await sideFromFile(file);
    if (!side) { toast("Couldn't open that photo. Try a JPG or PNG from your gallery."); return; }
    sides[key] = side;
    setActive(key);
    $("toast").hidden = true;
    markDirty();
    await detectSide(key);
  }

  /* ---------- crops (no colour changes: pixels are only resampled) ---------- */
  const cropCache = new Map();
  const remember = (key, c) => { cropCache.set(key, c); if (cropCache.size > 12) cropCache.delete(cropCache.keys().next().value); return c; };
  function featherCircle(x, d) {
    const R = d / 2, f = Math.max(1, d * 0.0025);
    x.globalCompositeOperation = "destination-in";
    const gr = x.createRadialGradient(R, R, Math.max(0, R - f), R, R, R);
    gr.addColorStop(0, "rgba(0,0,0,1)");
    gr.addColorStop(1, "rgba(0,0,0,0)");
    x.fillStyle = gr;
    x.fillRect(0, 0, d, d);
    x.globalCompositeOperation = "source-over";
  }
  function coinCanvas(side, d) {
    const key = "coin|" + side.ver + "|" + d;
    if (cropCache.has(key)) return cropCache.get(key);
    const c = document.createElement("canvas");
    c.width = c.height = d;
    const x = c.getContext("2d");
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high";
    x.translate(d / 2, d / 2);
    x.rotate(side.rot * Math.PI / 180);
    const k = d / (2 * side.r);
    x.scale(k, k);
    x.drawImage(side.src, -side.cx, -side.cy);
    x.setTransform(1, 0, 0, 1, 0, 0);
    featherCircle(x, d);
    return remember(key, c);
  }
  function certCanvas(side, w) {
    const h = Math.max(1, Math.round(w * side.rh / side.rw));
    const key = "cert|" + side.ver + "|" + w;
    if (cropCache.has(key)) return cropCache.get(key);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const x = c.getContext("2d");
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high";
    x.translate(w / 2, h / 2);
    x.rotate(-certRot(side) * Math.PI / 180);
    const k = w / side.rw;
    x.scale(k, k);
    x.drawImage(side.src, -side.cx, -side.cy);
    return remember(key, c);
  }
  const certAspect = (side) => side.rw / side.rh;

  /* ---------- example coins and certificate (procedural, clearly labelled) ---------- */
  const exampleCache = new Map();
  function arcText(x, text, cx, cy, rad, size) {
    x.font = `700 ${size}px ${FONT_CAPTION}`;
    const ws = [...text].map((ch) => x.measureText(ch).width + size * 0.14);
    const total = ws.reduce((a, b) => a + b, 0) / rad;
    let a = -Math.PI / 2 - total / 2;
    x.textAlign = "center"; x.textBaseline = "middle";
    [...text].forEach((ch, i) => {
      a += ws[i] / 2 / rad;
      x.save(); x.translate(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad); x.rotate(a + Math.PI / 2);
      x.fillText(ch, 0, 0); x.restore();
      a += ws[i] / 2 / rad;
    });
  }
  function emboss(x, draw) {
    x.save(); x.translate(3, 4); x.fillStyle = "rgba(40,40,44,0.45)"; draw(); x.restore();
    x.save(); x.translate(-2, -2); x.fillStyle = "rgba(255,255,255,0.8)"; draw(); x.restore();
    x.fillStyle = "rgba(150,152,156,0.9)"; draw();
  }
  function makeExampleCoin(kind) {
    const S = 900, R = S / 2, c = document.createElement("canvas");
    c.width = c.height = S;
    const x = c.getContext("2d");
    const g = x.createRadialGradient(R * 0.72, R * 0.62, R * 0.08, R, R, R);
    g.addColorStop(0, "#F7F6F2"); g.addColorStop(0.55, "#C9CBCD"); g.addColorStop(1, "#7C8086");
    x.fillStyle = g; x.beginPath(); x.arc(R, R, R, 0, TAU); x.fill();
    x.lineWidth = 20; x.strokeStyle = "rgba(255,255,255,0.32)"; x.beginPath(); x.arc(R, R, R - 13, 0, TAU); x.stroke();
    x.fillStyle = "rgba(55,58,62,0.32)";
    for (let i = 0; i < 150; i++) {
      const a = (i / 150) * TAU;
      x.save(); x.translate(R + Math.cos(a) * (R - 40), R + Math.sin(a) * (R - 40)); x.rotate(a); x.fillRect(-8, -4, 16, 8); x.restore();
    }
    emboss(x, () => arcText(x, kind === "obv" ? "EXAMPLE COIN" : "ADD YOUR PHOTOS", R, R, R - 100, 62));
    x.textAlign = "center"; x.textBaseline = "middle";
    if (kind === "obv") emboss(x, () => { x.font = `700 200px ${FONT_CAPTION}`; x.fillText("1952", R, R + 20); });
    else {
      emboss(x, () => { x.font = `700 280px ${FONT_CAPTION}`; x.fillText("$1", R, R - 20); });
      emboss(x, () => { x.font = `700 70px ${FONT_CAPTION}`; x.fillText("DOLLAR", R, R + 160); });
    }
    return c;
  }
  function makeExampleCert() {
    const W = 1080, H = 1000, c = document.createElement("canvas");
    c.width = W; c.height = H;
    const x = c.getContext("2d");
    x.fillStyle = "#EFE2C6"; x.fillRect(0, 0, W, H);
    x.textAlign = "center"; x.textBaseline = "middle";
    const ink = "#2B2722", brown = "#7A4E33";
    x.fillStyle = ink; x.font = `400 60px ${FONT_MONO}`; x.fillText("EXAMPLE CERTIFICATE", W / 2, 120);
    x.fillStyle = brown; x.font = `500 46px ${FONT_BODY}`; x.fillText("— COMMENTS —", W / 2, 230);
    x.fillStyle = ink; x.font = `400 54px ${FONT_MONO}`; x.fillText("Your label goes here", W / 2, 390);
    x.fillStyle = brown; x.font = `500 46px ${FONT_BODY}`; x.fillText("— CERTIFICATION NO. —", W / 2, 600);
    x.fillStyle = ink; x.font = `400 60px ${FONT_MONO}`; x.fillText("000 000", W / 2, 680);
    x.strokeStyle = brown; x.lineWidth = 3; x.beginPath(); x.moveTo(110, 770); x.lineTo(W - 110, 770); x.stroke();
    x.fillStyle = brown; x.font = `500 42px ${FONT_BODY}`;
    x.fillText("Wide PCGS and NGC labels and", W / 2, 860);
    x.fillText("taller ICCS labels both fit.", W / 2, 920);
    return c;
  }
  function exampleImage(kind, w) {
    const key = kind + "|" + w;
    if (exampleCache.has(key)) return exampleCache.get(key);
    if (!exampleCache.has(kind)) exampleCache.set(kind, kind === "cert" ? makeExampleCert() : makeExampleCoin(kind));
    const src = exampleCache.get(kind);
    const c = scaledCanvas(src, src.width, src.height, kind === "cert" ? w : w);
    if (kind !== "cert") featherCircle(c.getContext("2d"), c.width);
    exampleCache.set(key, c);
    return c;
  }

  /* ---------- plate ---------- */
  function setLS(x, px) { if ("letterSpacing" in x) x.letterSpacing = px + "px"; }
  function plateGeometry(aspect) {
    const gap = P.S - 2 * P.margin - 2 * P.d;
    const top = look.captions ? P.certTop : P.certTopNoCap;
    const availH = P.certBottom - top, availW = P.certMaxW;
    let cert = null;
    if (aspect) {
      let w = availW, h = w / aspect;
      if (h > availH) { h = availH; w = h * aspect; }
      cert = { x: (P.S - w) / 2, y: top + (availH - h) / 2, w, h };
    }
    return { gap, capY: P.top + P.d + P.capGap, cert };
  }
  function renderPlate(canvas, outW, preview) {
    const L = BG[look.bg], k = outW / P.S, S = Math.round(P.S * k);
    if (canvas.width !== S || canvas.height !== S) { canvas.width = S; canvas.height = S; }
    const x = canvas.getContext("2d");
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.fillStyle = L.bg; x.fillRect(0, 0, S, S);
    const ex = exampleMode(), cs = sides.cert;
    const aspect = ex ? EXAMPLE_CERT_ASPECT : cs.src ? certAspect(cs) : preview ? EXAMPLE_CERT_ASPECT : null;
    const G = plateGeometry(aspect);
    const d = Math.round(P.d * k), top = Math.round(P.top * k);
    const placeholder = (draw, label, lx, ly) => {
      x.save(); x.strokeStyle = L.empty; x.lineWidth = 3 * k; x.setLineDash([12 * k, 16 * k]); draw(); x.restore();
      x.fillStyle = L.empty; x.font = `500 ${40 * k}px ${FONT_BODY}`; setLS(x, 0);
      x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(label, lx, ly);
    };
    ["obv", "rev"].forEach((key, i) => {
      const ox = Math.round((P.margin + i * (P.d + G.gap)) * k), side = sides[key];
      const cc = ex ? exampleImage(key, d) : side.src ? coinCanvas(side, d) : null;
      if (cc) {
        x.save();
        if (L.shadow) { x.shadowColor = L.shadow; x.shadowBlur = 44 * k; x.shadowOffsetY = 16 * k; }
        x.drawImage(cc, ox, top, d, d);
        x.restore();
      } else if (preview) {
        placeholder(() => { x.beginPath(); x.arc(ox + d / 2, top + d / 2, d / 2 - 3 * k, 0, TAU); x.stroke(); },
          i ? "Reverse photo" : "Obverse photo", ox + d / 2, top + d / 2);
      }
      if (look.captions) {
        x.fillStyle = L.cap; x.font = `700 ${P.capSize * k}px ${FONT_CAPTION}`; setLS(x, P.capSize * k * 0.03);
        x.textAlign = "center"; x.textBaseline = "middle";
        x.fillText(i ? "REVERSE" : "OBVERSE", ox + d / 2 + P.capSize * k * 0.015, G.capY * k);
        setLS(x, 0);
      }
    });
    if (G.cert) {
      const r = { x: Math.round(G.cert.x * k), y: Math.round(G.cert.y * k), w: Math.round(G.cert.w * k), h: Math.round(G.cert.h * k) };
      const img = ex ? exampleImage("cert", r.w) : cs.src ? certCanvas(cs, r.w) : null;
      if (img) {
        x.save();
        if (L.shadow) { x.shadowColor = L.shadow; x.shadowBlur = 40 * k; x.shadowOffsetY = 14 * k; }
        x.drawImage(img, r.x, r.y, r.w, r.h);
        x.restore();
        if (L.edge) { x.strokeStyle = L.edge; x.lineWidth = Math.max(1, 2 * k); x.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1); }
      } else if (preview) {
        placeholder(() => { x.strokeRect(r.x, r.y, r.w, r.h); }, "Certificate photo", r.x + r.w / 2, r.y + r.h / 2);
      }
    }
  }

  /* ---------- crop editor ---------- */
  const editor = $("editor"), edWrap = $("editorWrap");
  let edScale = 1;
  const rectCorners = (s) => {
    const t = certRot(s) * Math.PI / 180, co = Math.cos(t), si = Math.sin(t);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
      const u = sx * s.rw / 2, v = sy * s.rh / 2;
      return { sx, sy, x: s.cx + u * co - v * si, y: s.cy + u * si + v * co };
    });
  };
  function drawEditor() {
    const side = sides[active];
    $("editorEmpty").hidden = !!side.src;
    editor.hidden = !side.src;
    $("busyChip").hidden = !side.busy;
    $("busyText").textContent = isCoin(active) ? "Finding the coin…" : "Finding the label…";
    if (!side.src) return;
    const availW = edWrap.clientWidth || 300;
    const maxH = Math.max(240, Math.min(window.innerHeight * 0.56, 620));
    let s = availW / side.w;
    if (side.h * s > maxH) s = maxH / side.h;
    const cw = Math.max(1, Math.round(side.w * s)), ch = Math.max(1, Math.round(side.h * s));
    const r = dpr(), pw = Math.round(cw * r), ph = Math.round(ch * r);
    if (editor.width !== pw || editor.height !== ph) { editor.width = pw; editor.height = ph; }
    editor.style.width = cw + "px"; editor.style.height = ch + "px";
    edScale = cw / side.w;
    const key = pw + "x" + ph;
    if (side.edKey !== key) { side.ed = scaledCanvas(side.src, side.w, side.h, Math.max(pw, ph)); side.edKey = key; }
    const x = editor.getContext("2d");
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.drawImage(side.ed, 0, 0, pw, ph);
    const k = pw / side.w;
    x.fillStyle = "rgba(5,6,7,0.6)";
    x.beginPath(); x.rect(0, 0, pw, ph);
    let topAt, topDir;
    if (isCoin(active)) {
      const cx = side.cx * k, cy = side.cy * k, rr = side.r * k;
      x.moveTo(cx + rr, cy); x.arc(cx, cy, rr, 0, TAU); x.fill("evenodd");
      x.lineWidth = 3.5 * r; x.strokeStyle = "rgba(0,0,0,0.6)"; x.beginPath(); x.arc(cx, cy, rr + 1.6 * r, 0, TAU); x.stroke();
      x.lineWidth = 1.6 * r; x.strokeStyle = RING; x.beginPath(); x.arc(cx, cy, rr, 0, TAU); x.stroke();
      const a = (-90 - side.rot) * Math.PI / 180;
      topAt = [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]; topDir = a;
      x.strokeStyle = "rgba(233,199,103,0.7)"; x.lineWidth = 1.2 * r;
      x.beginPath(); x.moveTo(cx - 8 * r, cy); x.lineTo(cx + 8 * r, cy); x.moveTo(cx, cy - 8 * r); x.lineTo(cx, cy + 8 * r); x.stroke();
    } else {
      const cs = rectCorners(side).map((p) => [p.x * k, p.y * k]);
      x.moveTo(cs[0][0], cs[0][1]); for (let i = 1; i < 4; i++) x.lineTo(cs[i][0], cs[i][1]); x.closePath();
      x.fill("evenodd");
      const poly = () => { x.beginPath(); x.moveTo(cs[0][0], cs[0][1]); for (let i = 1; i < 4; i++) x.lineTo(cs[i][0], cs[i][1]); x.closePath(); };
      x.lineWidth = 3.5 * r; x.strokeStyle = "rgba(0,0,0,0.6)"; poly(); x.stroke();
      x.lineWidth = 1.6 * r; x.strokeStyle = RING; poly(); x.stroke();
      for (const [px, py] of cs) {
        x.beginPath(); x.arc(px, py, 9 * r, 0, TAU);
        x.fillStyle = RING; x.fill(); x.lineWidth = 2 * r; x.strokeStyle = "rgba(0,0,0,0.7)"; x.stroke();
      }
      const t = certRot(side) * Math.PI / 180;
      topAt = [(side.cx + (side.rh / 2) * Math.sin(t)) * k, (side.cy - (side.rh / 2) * Math.cos(t)) * k];
      topDir = t - Math.PI / 2;
    }
    // marks where the top of the finished crop will be
    x.save(); x.translate(topAt[0], topAt[1]); x.rotate(topDir + Math.PI / 2);
    x.fillStyle = RING; x.beginPath(); x.moveTo(0, -3 * r); x.lineTo(-7 * r, -15 * r); x.lineTo(7 * r, -15 * r); x.closePath(); x.fill();
    x.restore();
  }
  function drawCropPreview() {
    const cv = $("cropPrev"), S = Math.round(124 * dpr());
    if (cv.width !== S) { cv.width = S; cv.height = S; }
    const x = cv.getContext("2d");
    x.fillStyle = BG[look.bg].bg; x.fillRect(0, 0, S, S);
    const side = sides[active];
    if (!side.src) return;
    if (isCoin(active)) { x.drawImage(coinCanvas(side, S), 0, 0); return; }
    const a = certAspect(side), m = S * 0.06;
    let w = S - 2 * m, h = w / a;
    if (h > S - 2 * m) { h = S - 2 * m; w = h * a; }
    x.drawImage(certCanvas(side, Math.round(w * 2)), (S - w) / 2, (S - h) / 2, w, h);
  }

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const clampR = (side, r) => clamp(r, Math.min(side.w, side.h) * 0.03, Math.max(side.w, side.h) * 0.75);
  const clampDim = (side, v) => clamp(v, Math.min(side.w, side.h) * 0.03, Math.max(side.w, side.h) * 1.5);
  const wrapDeg = (d) => { let v = ((d + 180) % 360 + 360) % 360 - 180; if (v === -180) v = 180; return Math.round(v * 2) / 2; };

  const ptrs = new Map();
  let gest = null;
  function pointerImage(p) { const b = editor.getBoundingClientRect(); return { x: (p.x - b.left) / edScale, y: (p.y - b.top) / edScale }; }
  function gestureStart() {
    const side = sides[active], pts = [...ptrs.values()];
    if (!pts.length || !side.src) { gest = null; return; }
    const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length, my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    gest = { n: pts.length, cx: side.cx, cy: side.cy, r: side.r, rw: side.rw, rh: side.rh, mx, my, mode: "move",
      d: pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0 };
    if (!isCoin(active) && pts.length === 1) {
      const ip = pointerImage(pts[0]), reach = 30 / edScale;
      let best = null;
      for (const c of rectCorners(side)) { const dd = Math.hypot(c.x - ip.x, c.y - ip.y); if (dd < reach && (!best || dd < best.dd)) best = { ...c, dd }; }
      if (best) { gest.mode = "corner"; gest.sx = best.sx; gest.sy = best.sy; }
    }
  }
  editor.addEventListener("pointerdown", (e) => {
    if (!sides[active].src) return;
    try { editor.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gestureStart();
    e.preventDefault();
  });
  editor.addEventListener("pointermove", (e) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gest || gest.n !== ptrs.size) gestureStart();
    const side = sides[active], pts = [...ptrs.values()];
    const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length, my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    const dx = (mx - gest.mx) / edScale, dy = (my - gest.my) / edScale;
    if (gest.mode === "corner") {
      const t = certRot(side) * Math.PI / 180, co = Math.cos(t), si = Math.sin(t);
      const du = dx * co + dy * si, dv = -dx * si + dy * co;
      side.rw = clampDim(side, gest.rw + gest.sx * du);
      side.rh = clampDim(side, gest.rh + gest.sy * dv);
      const au = (side.rw - gest.rw) * gest.sx / 2, av = (side.rh - gest.rh) * gest.sy / 2;
      side.cx = gest.cx + au * co - av * si;
      side.cy = gest.cy + au * si + av * co;
    } else {
      side.cx = clamp(gest.cx + dx, 0, side.w);
      side.cy = clamp(gest.cy + dy, 0, side.h);
      if (pts.length > 1 && gest.d > 8) {
        const f = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) / gest.d;
        if (isCoin(active)) side.r = clampR(side, gest.r * f);
        else { side.rw = clampDim(side, gest.rw * f); side.rh = clampDim(side, gest.rh * f); }
      }
    }
    side.manual = true;
    bump(side);
  });
  const endPtr = (e) => { if (ptrs.delete(e.pointerId)) gestureStart(); };
  editor.addEventListener("pointerup", endPtr);
  editor.addEventListener("pointercancel", endPtr);
  editor.addEventListener("wheel", (e) => {
    const side = sides[active];
    if (!side.src) return;
    e.preventDefault();
    const f = Math.exp(-e.deltaY * 0.0012);
    if (isCoin(active)) side.r = clampR(side, side.r * f);
    else { side.rw = clampDim(side, side.rw * f); side.rh = clampDim(side, side.rh * f); }
    side.manual = true; bump(side);
  }, { passive: false });
  editor.addEventListener("keydown", (e) => {
    const side = sides[active];
    if (!side.src) return;
    const m = Math.min(side.w, side.h), st = m * (e.shiftKey ? 0.02 : 0.004);
    const moves = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] };
    const scale = (f) => { if (isCoin(active)) side.r = clampR(side, side.r * f); else { side.rw = clampDim(side, side.rw * f); side.rh = clampDim(side, side.rh * f); } };
    if (moves[e.key]) { side.cx = clamp(side.cx + moves[e.key][0], 0, side.w); side.cy = clamp(side.cy + moves[e.key][1], 0, side.h); }
    else if (e.key === "+" || e.key === "=") scale(1.01);
    else if (e.key === "-" || e.key === "_") scale(1 / 1.01);
    else if (e.key === "[" || e.key === "]") {
      const dir = e.key === "[" ? -1 : 1;
      if (isCoin(active)) { side.rot = Math.round(wrap180(side.rot + dir) * 10) / 10; side.rotAuto = false; }
      else side.tilt = clamp(Math.round((side.tilt + dir * 0.1) * 10) / 10, -45, 45);
    } else return;
    e.preventDefault(); side.manual = true; bump(side);
  });

  /* ---------- tiles ---------- */
  const SUB = { obv: "Coin photo", rev: "Coin photo", cert: "Label photo" };
  function drawTile(key) {
    const side = sides[key], cv = $(key + "Thumb"), hit = $(key + "Pick");
    hit.classList.toggle("loaded", !!side.src);
    $(key + "Empty").hidden = !!side.src;
    $(key + "Busy").hidden = !side.busy;
    $(key + "Sub").textContent = side.src ? "Tap to replace" : SUB[key];
    cv.hidden = !side.src;
    if (!side.src) return;
    const r = dpr(), w = Math.round(hit.clientWidth * r), h = Math.round(hit.clientHeight * r);
    if (!w || !h) return;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const x = cv.getContext("2d");
    x.fillStyle = "#0A0B0C"; x.fillRect(0, 0, w, h);
    const s = Math.min(w / side.w, h / side.h), ox = (w - side.w * s) / 2, oy = (h - side.h * s) / 2;
    const tk = w + "x" + h;
    if (side.tileKey !== tk) { side.tile = scaledCanvas(side.src, side.w, side.h, Math.max(side.w * s, side.h * s)); side.tileKey = tk; }
    x.drawImage(side.tile, ox, oy, side.w * s, side.h * s);
    if (side.busy) return;
    x.lineWidth = 2 * r; x.strokeStyle = RING;
    x.beginPath();
    if (isCoin(key)) x.arc(ox + side.cx * s, oy + side.cy * s, side.r * s, 0, TAU);
    else { const cs = rectCorners(side); x.moveTo(ox + cs[0].x * s, oy + cs[0].y * s); for (let i = 1; i < 4; i++) x.lineTo(ox + cs[i].x * s, oy + cs[i].y * s); x.closePath(); }
    x.stroke();
  }

  /* ---------- render loop ---------- */
  let raf = 0;
  function markDirty() { if (!raf) raf = requestAnimationFrame(render); }
  function render() {
    raf = 0;
    const plate = $("plate"), frameW = plate.parentElement.clientWidth || 600;
    renderPlate(plate, Math.min(1600, Math.round(frameW * dpr())), true);
    const ex = exampleMode();
    $("exampleChip").hidden = !ex;
    const missing = ["obv", "rev", "cert"].filter((k) => !sides[k].src).map((k) => ({ obv: "obverse", rev: "reverse", cert: "certificate" })[k]);
    $("plateHint").textContent = ex ? "Add your photos to replace the example" : missing.length ? `Still to add: ${missing.join(", ")}` : "";
    const th = $("thumb"), tw = Math.round(44 * dpr());
    if (th.width !== tw) { th.width = tw; th.height = tw; }
    th.getContext("2d").drawImage(plate, 0, 0, tw, tw);
    drawEditor();
    drawCropPreview();
    drawTile("obv"); drawTile("rev"); drawTile("cert");
    $("namePreview").textContent = fileName();
    syncControls();
    renderBatch();
    renderListing();
  }

  let lastMode = "";
  function syncControls() {
    const side = sides[active], has = !!side.src, coin = isCoin(active);
    const mode = coin ? "coin" : "cert";
    if (mode !== lastMode) {
      lastMode = mode;
      const rr = $("rotRange");
      if (coin) { rr.min = "-180"; rr.max = "180"; rr.step = "0.5"; $("rotLabel").textContent = "Rotate"; }
      else { rr.min = "-45"; rr.max = "45"; rr.step = "0.1"; $("rotLabel").textContent = "Straighten"; }
      $("sizeWrap").hidden = !coin;
    }
    ["sizeRange", "rotRange", "rotL", "rotR", "autoBtn"].forEach((id) => { $(id).disabled = !has || side.busy; });
    const rotVal = coin ? side.rot : side.tilt;
    if (has) {
      if (document.activeElement !== $("sizeRange") && coin) $("sizeRange").value = Math.round((side.r / Math.min(side.w, side.h)) * 1000);
      if (document.activeElement !== $("rotRange")) $("rotRange").value = rotVal;
      $("sizeOut").textContent = coin ? `${Math.round(side.r * 2)} px across` : "";
    } else {
      $("sizeOut").textContent = "–";
    }
    $("rotOut").textContent = `${rotVal > 0 ? "+" : ""}${rotVal}°`;
    const multi = coin && has && side.rings.length > 1 && !side.busy;
    $("ringBtn").hidden = !multi;
    if (multi) $("ringBtn").textContent = `Other ring (${side.ringIdx + 1} of ${side.rings.length})`;
    let straight = "";
    if (coin && has && side.found && side.rotAuto && !side.busy) {
      const why = { text: "the lettering", label: "where the label is", habit: "how you usually shoot holder backs" }[side.upFrom];
      if (side.upFrom === "type" || (side.upFrom === "text" && side.typeM)) straight = `Turned upright by matching the ${side.typeM ? side.typeM.name : "coin's"} design. `;
      else if (side.upFrom === "coin") straight = "Turned upright by the coin's own lettering, as the coin sits crooked in its holder. ";
      else if (side.upFrom === "text" && typeof side.textFine === "number") straight = "Straightened to the holder, checked against the coin's lettering. ";
      else if (side.orient) straight = "Straightened to the holder's edges. ";
      if (side.upFrom !== "coin" && side.upFrom !== "type" && !side.typeM && why && Math.abs(side.rot) > 45) straight += `Turned the right way up going by ${why}. `;
    }
    const hint = coin
      ? straight + "Drag the ring to move it. Pinch or use Size to sit it on the coin's outer edge."
      : has ? `Drag inside to move, drag a corner to resize. ${Math.round(side.rw)} × ${Math.round(side.rh)} px crop.` : "Drag inside to move, drag a corner to resize.";
    $("cropNote").textContent = side.note || hint;
    $("cropNote").className = side.note ? "note warn" : "note";
    $("dotObv").classList.toggle("on", !!sides.obv.src);
    $("dotRev").classList.toggle("on", !!sides.rev.src);
    $("dotCert").classList.toggle("on", !!sides.cert.src);
    $("swapBtn").disabled = !sides.obv.src && !sides.rev.src;
    updateReadUI();
  }

  function setActive(key) {
    active = key;
    $({ obv: "sideObv", rev: "sideRev", cert: "sideCert" }[key]).checked = true;
    markDirty();
  }

  /* ---------- on-device reading (Android app) ---------- */
  const LABEL_TEXT = /PCGS|NGC|ICCS|ANACS|CCCS|CERTIFICATION|COMMENTS|GENUINE|\b(MS|PR|PF|SP|PL|AU|XF|EF|VF)\s*-?\s*\d{1,2}\b|\d{3,6}\s*[.,]\s*\d{1,2}\s*\/\s*\d{5,10}/i;
  async function ocrLines(canvas, maxDim) {
    const c = scaledCanvas(canvas, canvas.width, canvas.height, maxDim), k = canvas.width / c.width;
    const res = await Vision.readText({ image: c.toDataURL("image/jpeg", 0.92) });
    return ((res && res.lines) || []).map((l) => ({ text: String(l.text || ""), x: (l.x || 0) * k, y: (l.y || 0) * k, w: (l.w || 0) * k, h: (l.h || 0) * k,
      angle: typeof l.angle === "number" ? l.angle : undefined }));
  }
  async function barcodeBoxes(canvas, maxDim) {
    const c = scaledCanvas(canvas, canvas.width, canvas.height, maxDim), k = canvas.width / c.width;
    const res = await Vision.readBarcodes({ image: c.toDataURL("image/jpeg", 0.92) });
    return ((res && res.barcodes) || []).map((b) => ({ value: String(b.value || ""), x: (b.x || 0) * k, y: (b.y || 0) * k, w: (b.w || 0) * k, h: (b.h || 0) * k }));
  }
  // Join pieces that sit on the same row, left to right, so "CAN 1950 $1 MS66" stays one line.
  function rowsOf(lines) {
    const ls = lines.filter((l) => l.text.trim()).sort((p, q) => (p.y + p.h / 2) - (q.y + q.h / 2));
    const rows = [];
    for (const l of ls) {
      const cy = l.y + l.h / 2, last = rows[rows.length - 1];
      if (last && Math.abs(last.cy - cy) < Math.min(last.h, l.h) * 0.5) last.items.push(l);
      else rows.push({ cy, h: l.h, items: [l] });
    }
    return rows.map((r) => r.items.sort((p, q) => p.x - q.x).map((i) => i.text).join(" "));
  }
  const unionBox = (bs) => bs.reduce((u, b) => ({ x0: Math.min(u.x0, b.x), y0: Math.min(u.y0, b.y), x1: Math.max(u.x1, b.x + b.w), y1: Math.max(u.y1, b.y + b.h) }),
    { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
  // Where is the label in this photo? Its printed text and barcode say, even on a whole holder.
  async function findLabelByText(side, coin) {
    const lines = await ocrLines(side.src, 1600);
    let codes = [];
    try { codes = await barcodeBoxes(side.src, 1600); } catch (e) { codes = []; }
    const above = (b) => !coin || b.y + b.h < coin.cy - coin.r * 0.55;
    const key = lines.filter((l) => LABEL_TEXT.test(l.text) && above(l));
    if (key.length < 2) return null;
    let U = unionBox(key);
    const gx = (U.x1 - U.x0) * 0.35, gy = (U.y1 - U.y0) * 0.6;
    const near = lines.concat(codes).filter((b) => above(b) && b.x >= U.x0 - gx && b.x + b.w <= U.x1 + gx && b.y >= U.y0 - gy && b.y + b.h <= U.y1 + gy);
    U = unionBox(key.concat(near));
    const w = U.x1 - U.x0, h = U.y1 - U.y0;
    const insideCoin = !!coin && lines.some((l) => LABEL_TEXT.test(l.text) && Math.hypot(l.x + l.w / 2 - coin.cx, l.y + l.h / 2 - coin.cy) < coin.r * 0.8);
    return { prior: { cx: (U.x0 + U.x1) / 2, cy: (U.y0 + U.y1) / 2, rw: w * 1.12, rh: h * 1.3 + w * 0.04, rot: 0 }, insideCoin };
  }
  // What is this photo: a coin, a certificate, or a holder front with both?
  async function roleOf(side, res) {
    const coin = res && res.coin, base = res && res.certScore > 0 ? "label" : "coin";
    if (!isNative || !coin || !(coin.support >= 0.5)) return { role: base };
    let t = null;
    try { t = await findLabelByText(side, coin); } catch (e) { t = null; }
    if (!t || t.insideCoin) return { role: base };
    const g = graysFor(side);
    const rect = await runDetect({ kind: "rect", small: g.small, big: g.big, prior: t.prior });
    return { role: "front", rect: rect && iou(rect, t.prior) > 0.3 ? rect : { ...t.prior } };
  }
  // A certificate photo that turns out to be a whole holder: move the crop onto the label.
  async function refineCertByText(side) {
    let t = null;
    try { t = await findLabelByText(side, null); } catch (e) { t = null; }
    if (!t) return;
    const current = { cx: side.cx, cy: side.cy, rw: side.rw, rh: side.rh, rot: certRot(side) };
    if (side.found && iou(current, t.prior) > 0.3) return;
    const g = graysFor(side);
    const rect = await runDetect({ kind: "rect", small: g.small, big: g.big, prior: t.prior });
    applyRect(side, rect && iou(rect, t.prior) > 0.3 ? rect : { ...t.prior }, null);
  }

  async function readCertNative(opts) {
    const cert = sides.cert;
    if (!cert.src || !LabelParse) return;
    const token = { stop: false };
    readCtl = { abort() { token.stop = true; } };
    readMsgText = "";
    updateReadUI();
    try {
      const crop = certCanvas(cert, Math.round(Math.min(2000, Math.max(1000, cert.rw))));
      const lines = await ocrLines(crop, 2000);
      let codes = [];
      try { codes = await barcodeBoxes(crop, 2000); } catch (e) { codes = []; }
      if (token.stop || sides.cert !== cert) {
        readCtl = null;
        if (token.stop) readMsg("Stopped. Tap Read certificate to try again.");
        return;
      }
      const d = LabelParse.parse(rowsOf(lines));
      // PCGS and NGC barcodes carry the cert number; use it when the printed one wasn't readable
      if (!d.cert && d.service !== "ICCS") {
        const num = codes.map((b) => b.value.replace(/\D/g, "")).find((v) => v.length >= 7 && v.length <= 10);
        if (num) d.cert = num;
      }
      readCtl = null;
      const found = ["date", "denomination", "grade", "cert"].filter((k) => d[k]).length;
      applyLabel({ ...d, comments: "", confidence: found >= 3 ? "high" : "low" }, cert, null);
    } catch (e) {
      readCtl = null;
      readMsg("Couldn't read the label on this phone. Type the details in, or try a sharper photo.", "warn");
    } finally {
      updateReadUI();
    }
    await textPass(!!(opts && opts.checkSides));
  }

  // Which coin photo is the obverse? Unroll the legend around the rim into straight rows of text,
  // read them, and look for the monarch's name and titles (or LIBERTY) versus CANADA, CENTS, DOLLAR.
  const OBV_WORDS = ["GEORGIVS", "GEORGIUS", "GEORGE", "ELIZABETH", "EDWARDVS", "EDWARDUS", "EDWARD", "VICTORIA", "CHARLES",
    "REGINA", "REX", "DEI", "GRATIA", "IMPERATOR", "IMP", "IND", "BRITT", "OMN", "LIBERTY"];
  const REV_WORDS = ["CANADA", "CENTS", "CENT", "DOLLAR", "DOLLARS", "UNITED", "STATES", "AMERICA", "PLURIBUS", "HALF", "QUARTER", "DIME"];
  // Which way is up, from where the legend sits: lettering whose tops face the rim runs across
  // the top of a coin, lettering whose tops face the centre runs along the bottom. Returns the
  // design's up in degrees clockwise from the top of the crop, and how sure that is, or null.
  function legendUp(lines, arcOf, only) {
    const outB = new Uint8Array(180), inB = new Uint8Array(180);
    for (const l of lines) {
      const chars = String(l.text || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      // denticles and scratches can read as rows of I, L or 1
      if (chars.length < 3 || new Set(chars).size < 2 || /^[IL1]+$/.test(chars)) continue;
      if (only && !only(l)) continue;
      const arc = arcOf(l);
      if (!arc) continue;
      // a line the reader reports upside down belongs to the other kind of row
      const outward = typeof l.angle === "number" && Math.abs(wrap180(l.angle)) > 120 ? arc.row !== 0 : arc.row === 0;
      const bins = outward ? outB : inB;
      for (let d = arc.from; d <= arc.to; d += 2) bins[(((Math.floor(d / 2)) % 180) + 180) % 180] = 1;
    }
    let vx = 0, vy = 0, n = 0;
    for (let i = 0; i < 180; i++) {
      const v = outB[i] - inB[i], a = ((i * 2 + 1) * Math.PI) / 180;
      n += outB[i] + inB[i];
      vx += v * Math.cos(a); vy += v * Math.sin(a);
    }
    const covered = n * 2, conf = n ? Math.hypot(vx, vy) / n : 0;
    if (covered < 12 || conf < 0.25) return null;
    return { up: Math.round((Math.atan2(vy, vx) * 180) / Math.PI), strong: covered >= 24 && conf >= 0.5, covered, conf: Math.round(conf * 100) / 100 };
  }
  // Words that turn up in coin legends. A line of reading that contains one is the rim lettering
  // rather than a scratch, a denticle or the holder's wood-grain background.
  const LEGEND_WORDS = ["ELIZABETH", "REGINA", "CANADA", "CANADIAN", "CENTS", "DOLLAR", "DOLLARS", "VICTORIA", "GEORGIVS", "GEORGIUS",
    "EDWARDVS", "EDWARDUS", "CHARLES", "LIBERTY", "UNITED", "STATES", "AMERICA", "PLURIBUS", "UNUM", "TRUST", "QUARTER", "HALF",
    "IMPERATOR", "GRATIA", "FIDEI", "DEFENSOR", "BRITT", "OMN", "DIME", "DEI"];
  const near = (a, b) => {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return a.slice(i + 1) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i) || a.slice(i) === b.slice(i + 1);
  };
  // Letters of legend words found in this reading (0 when none).
  function legendLetters(text) {
    const up = String(text || "").toUpperCase(), toks = up.replace(/[^A-Z]+/g, " ").trim().split(" ").filter(Boolean), glued = up.replace(/[^A-Z]/g, "");
    let n = 0;
    for (const w of LEGEND_WORDS) {
      if (w.length < 6) { if (toks.includes(w)) n += w.length; continue; }
      if (toks.some((t) => t.length >= 5 && near(t, w)) || glued.includes(w)) { n += w.length; continue; }
      // a word cut by the edge of the strip or half-read: five or more letters in a row still count
      for (let L = w.length - 1; L >= 5; L--) {
        let hit = false;
        for (let i = 0; i + L <= w.length && !hit; i++) hit = glued.includes(w.slice(i, i + L));
        if (hit) { n += L; break; }
      }
    }
    return n;
  }
  // Rows of rim lettering unrolled flat. Each spec is { start, span, inward }: degrees clockwise from
  // the top of the crop where the row begins, how far it runs, and whether the lettering faces the
  // centre (the bottom of the coin, read left to right) rather than the rim.
  function unroll(side, specs) {
    const D = 800, R = D / 2, src = coinCanvas(side, D), sd = src.getContext("2d").getImageData(0, 0, D, D).data;
    const r0 = R * 0.66, r1 = R * 0.99, H = Math.round(r1 - r0), rm = (r0 + r1) / 2, gap = 16, pxDeg = (rm * Math.PI) / 180;
    const W = Math.round(Math.max(...specs.map((q) => q.span)) * pxDeg), rowH = H + gap;
    const out = document.createElement("canvas");
    out.width = W; out.height = specs.length * rowH;
    const x = out.getContext("2d"), img = x.createImageData(W, out.height), p = img.data;
    for (let i = 3; i < p.length; i += 4) p[i] = 255;
    specs.forEach((q, row) => {
      for (let v = 0; v < H; v++) {
        const rad = q.inward ? r0 + v : r1 - v, oy = row * rowH + v;
        for (let u = 0; u < W; u++) {
          const d = u / pxDeg;
          if (d > q.span) break;
          const t = (((q.inward ? q.start - d : q.start + d) - 90) * Math.PI) / 180, sx = R + rad * Math.cos(t), sy = R + rad * Math.sin(t);
          if (sx < 0 || sy < 0 || sx >= D - 1 || sy >= D - 1) continue;
          const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0, o = (oy * W + u) * 4;
          for (let ch = 0; ch < 3; ch++) {
            const i = (y0 * D + x0) * 4 + ch;
            p[o + ch] = sd[i] * (1 - fx) * (1 - fy) + sd[i + 4] * fx * (1 - fy) + sd[i + D * 4] * (1 - fx) * fy + sd[i + D * 4 + 4] * fx * fy;
          }
        }
      }
    });
    x.putImageData(img, 0, 0);
    const arc = (l) => {
      const row = Math.floor((l.y + l.h / 2) / rowH), q = specs[row];
      if (!q) return null;
      const at = (px) => (q.inward ? q.start - Math.max(0, px) / pxDeg : q.start + Math.max(0, px) / pxDeg);
      const a = at(l.x), b = at(l.x + l.w);
      return { row, from: Math.min(a, b), to: Math.max(a, b) };
    };
    return { canvas: out, arc };
  }
  // The coin's own up, found by centring the rim lettering. Starts from a rough guess (degrees
  // clockwise from the top of the photo) and re-reads strips centred on it until the legend sits
  // squarely at the top (or, along the bottom, squarely opposite). Lettering is only counted when it
  // spells legend words. Returns the design's up in photo terms, or null when it isn't clear.
  async function refineLegend(side, guess) {
    let est = guess, letters = 0;
    for (let it = 0; it < 6; it++) {
      const cur = side.rot, c = est + cur;
      const un = unroll(side, [{ start: c - 135, span: 270, inward: false }, { start: c + 315, span: 270, inward: true }]);
      const lines = await ocrLines(un.canvas, 1500);
      const ext = [null, null], n = [0, 0];
      for (const l of lines) {
        const k = legendLetters(l.text), a = k >= 4 && un.arc(l);
        if (!a) continue;
        const e = ext[a.row] || (ext[a.row] = { from: Infinity, to: -Infinity });
        e.from = Math.min(e.from, a.from); e.to = Math.max(e.to, a.to); n[a.row] += k;
      }
      const v = [ext[0] && n[0] >= 4 ? (ext[0].from + ext[0].to) / 2 : null, ext[1] && n[1] >= 4 ? (ext[1].from + ext[1].to) / 2 - 180 : null];
      if (v[0] == null && v[1] == null) return null;
      let now;
      if (v[0] != null && v[1] != null) {
        if (Math.abs(wrap180(v[0] - v[1])) > 25) { if (n[0] < 6) return null; now = v[0]; }
        else now = v[0] + wrap180(v[1] - v[0]) * (n[1] / (n[0] + n[1]));
      } else now = v[0] != null ? v[0] : v[1];
      letters = n[0] + n[1];
      const next = wrap180(now - cur), moved = Math.abs(wrap180(next - est));
      est = next;
      if (moved < 1.5) break;
      if (it === 5 && moved > 4) return null;
    }
    return letters >= 6 ? { up: Math.round(est * 10) / 10, letters } : null;
  }
  async function legendRead(side) {
    // the whole rim unrolled twice over: lettering facing the rim, and lettering facing the centre
    const rot = side.rot, un = unroll(side, [{ start: 0, span: 450, inward: false }, { start: 360, span: 450, inward: true }]);
    const lines = await ocrLines(un.canvas, 2200);
    const text = " " + lines.map((l) => l.text).join(" ").toUpperCase().replace(/[^A-Z]+/g, " ") + " ";
    const has = (w) => text.includes(" " + w + " ") || (w.length >= 6 && text.includes(w));
    const dg = /\bD\s?G\b/.test(text) ? 1 : 0;
    const up = legendUp(lines, un.arc);
    // kept relative to the photo itself, so it still holds after the crop is turned
    if (up) up.up = Math.round(wrap180(up.up - rot) * 10) / 10;
    // any angle, not just up or down: from lettering that spells legend words
    let fine = null;
    const rough = legendUp(lines, un.arc, (l) => legendLetters(l.text) >= 4);
    if (rough) {
      try { fine = await refineLegend(side, wrap180(rough.up - rot)); } catch (e) { fine = null; }
    }
    return { fine, score: OBV_WORDS.filter(has).length + dg - REV_WORDS.filter(has).length, up };
  }
  // Read both coins' legends once each (phone only): to straighten them and, when asked,
  // to tell which is the obverse.
  function readLegendOnce(s) {
    if (!s.textJob) {
      s.textJob = s.textDone ? Promise.resolve() : legendRead(s)
        .then((r) => { s.textUp = r.up; s.legend = r.score; s.textFine = r.fine ? r.fine.up : null; })
        .catch(() => { /* unreadable: straightened from the holder alone */ })
        .then(() => { s.textDone = true; });
    }
    return s.textJob;
  }
  async function textPass(checkSides) {
    const a = sides.obv, b = sides.rev;
    if (!isNative) return;
    for (const s of [a, b]) if (s.src && s.found && !s.busy) await readLegendOnce(s);
    if (sides.obv !== a || sides.rev !== b) return;
    if (checkSides && a.src && b.src && a.textDone && b.textDone && b.legend > a.legend) {
      sides.obv = b; sides.rev = a; bump(a); bump(b);
      toast("Obverse and reverse were the wrong way round, so they've been swapped.");
    }
    restraighten();
  }

  /* ---------- reading the certificate ---------- */
  let readCtl = null, readMsgText = "", readMsgKind = "";
  function readMsg(text, kind) { readMsgText = text; readMsgKind = kind || ""; updateReadUI(); }
  function updateReadUI() {
    const btn = $("readBtn"), note = $("readNote"), reading = !!readCtl;
    btn.disabled = reading || sampleState === "unavailable" || !sides.cert.src;
    if (btn.dataset.reading !== String(reading)) {
      btn.dataset.reading = String(reading);
      btn.innerHTML = reading ? '<span class="spin" aria-hidden="true"></span>Reading the certificate…' : isNative ? "Read certificate" : "Read certificate with Claude";
    }
    $("stopBtn").hidden = !reading;
    let text, kind = "";
    if (sampleState === "unavailable") text = "Certificate reading isn't available in this view. Type the details below.";
    else if (reading) text = isNative ? "Reading the label…" : "Claude is reading the label. This can take up to a minute.";
    else if (readMsgText) { text = readMsgText; kind = readMsgKind; }
    else if (!sides.cert.src) text = isNative ? "Add the certificate photo and it's read for you." : "Add the certificate photo, then Claude can read it for you.";
    else text = isNative ? "Reads the label on your phone. Nothing is sent anywhere." : "Sends the certificate photo to Claude, on your own Claude account, to read the label.";
    if (note.textContent !== text) note.textContent = text;
    note.className = "note" + (kind ? " " + kind : "");
  }

  function buildPrompt(hasCrop, coins) {
    return [
      "These images show the certificate label from a certified coin holder (a slab). A collector needs the label details to name a photo file.",
      "Image 1 is the label photo as taken." + (hasCrop ? " Image 2 is the same label, cropped and straightened." : ""),
      coins ? `Images ${coins[0]} and ${coins[1]} are the two sides of the coin.` : "",
      "",
      "Read the label exactly as printed. Common services are PCGS, NGC, ICCS (International Coin Certification Service, Canada), ANACS, CCCS and CGS. If a value is not printed or not readable, use an empty string. Do not guess a cert number.",
      "",
      "Reply with only this JSON object:",
      '{"service":"","cert":"","date":"","denomination":"","grade":"","variety":"","comments":"","confidence":"high","label_box":{"x0":0.1,"y0":0.1,"x1":0.9,"y1":0.9}' + (coins ? `,"obverse_image":${coins[0]}` : "") + "}",
      "",
      "Field rules:",
      "- service: the grading company's short name, e.g. PCGS, NGC, ICCS. Use the logo or watermark if the name is not spelled out.",
      "- cert: the certification number exactly as printed, including letters, e.g. \"XCU 760\" or \"45678912\".",
      '- date: the year with mint mark and any date-level variety, kept short, e.g. "1921-D", "1936 Dot", "1947 Maple Leaf".',
      '- denomination: as a short form with a symbol where natural, e.g. "1¢", "5¢", "25¢", "50¢", "$1".',
      '- grade: the full grade with prefix and designations, written like "MS-64", "MS-65 RD", "AU-58", "PR-69 DCAM", "MS-64 PL". Keep a plus sign or star if printed. Details grades look like "XF Details – Cleaned".',
      '- variety: variety, attribution or comments printed on the label, e.g. "NWL; 2/2", "Near Leaf", "Blunt 7". Empty if none.',
      "- comments: anything else on the label worth keeping. Empty if nothing.",
      "- confidence: high, medium or low, for how sure you are of the label text overall.",
      "- label_box: the label's edges in image 1, as fractions of that image's width (x0, x1) and height (y0, y1).",
      coins ? `- obverse_image: ${coins[0]} or ${coins[1]}, whichever shows the obverse. On coins with a monarch or other portrait, that is the portrait side; otherwise use the side numismatic references call the obverse.` : "",
    ].filter((l, i, arr) => l !== "" || (arr[i - 1] !== "" && i > 0)).join("\n");
  }

  async function readCert(opts) {
    if (isNative) return readCertNative(opts);
    const s = await samplePromise;
    if (!s || sampleState === "unavailable") { updateReadUI(); return; }
    const cert = sides.cert;
    if (!cert.src) return;
    const checkSides = !!(opts && opts.checkSides === true && sides.obv.src && sides.rev.src);
    const ctl = new AbortController();
    readCtl = ctl; readMsgText = "";
    updateReadUI();
    try {
      const max = Math.max(1, (imageLimits && imageLimits.maxCount) || 2);
      const imgs = [await toJpeg(cert.src, 1600)];
      const cropUseful = cert.rw * cert.rh < cert.w * cert.h * 0.6 || Math.abs(cert.tilt) > 0.5 || cert.base !== 0;
      if (cropUseful && imgs.length < max - (checkSides ? 2 : 0)) imgs.push(await toJpeg(certCanvas(cert, Math.round(Math.min(1600, cert.rw))), 1600));
      let coinCtx = null;
      if (checkSides && imgs.length + 2 <= max) {
        const obv = sides.obv, rev = sides.rev;
        imgs.push(await toJpeg(coinCanvas(obv, 640), 640));
        imgs.push(await toJpeg(coinCanvas(rev, 640), 640));
        coinCtx = { a: imgs.length - 1, b: imgs.length, obv, rev };
      }
      if (imgs.some((b) => !b)) throw { code: "image_rejected" };
      const data = await s.json(buildPrompt(imgs.length > (coinCtx ? 3 : 1), coinCtx ? [coinCtx.a, coinCtx.b] : null), { images: imgs, signal: ctl.signal });
      if (ctl !== readCtl) return;
      readCtl = null;
      applyLabel(data, cert, coinCtx);
    } catch (e) {
      if (ctl !== readCtl) return;
      readCtl = null;
      handleReadError(e);
    }
  }

  function handleReadError(e) {
    const code = e && e.code;
    switch (code) {
      case "cancelled": readMsg("Stopped. Tap Read certificate to try again."); break;
      case "not_granted": case "sampling_disabled": case "not_declared": case "capability_disabled":
      case "capability_removed": case "images_unavailable":
        sampleState = "unavailable"; readMsg(""); break;
      case "rate_limited": readMsg("Claude is busy for your account right now. Wait a minute, then try again.", "warn"); break;
      case "session_expired": readMsg("Your Claude sign-in has expired. Sign in again, then try again.", "warn"); break;
      case "image_rejected": readMsg("Claude couldn't use the photo. Try a clearer photo or a smaller file.", "warn"); break;
      case "refused": case "empty_completion": case "invalid_json":
        readMsg("Couldn't read the label from this photo. Try a sharper, straight-on shot, or type the details in.", "warn"); break;
      default: readMsg("The connection dropped while reading the label. Tap Read certificate to try again.", "warn");
    }
  }

  function applyLabel(d, cert, coinCtx) {
    if (!d || typeof d !== "object" || Array.isArray(d)) {
      readMsg("Couldn't read the label from this photo. Try a sharper, straight-on shot, or type the details in.", "warn");
      return;
    }
    const str = (v) => (v == null ? "" : String(v)).replace(/\s+/g, " ").trim();
    let filled = 0;
    const put = (id, val) => {
      if (!val) return;
      $(id).value = val; filled++;
      const w = $("w-" + id);
      w.classList.remove("filled"); void w.offsetWidth; w.classList.add("filled");
    };
    put("fDate", str(d.date));
    put("fDenom", str(d.denomination));
    put("fGrade", str(d.grade));
    put("fService", str(d.service));
    put("fCert", str(d.cert));
    put("fNotes", [str(d.variety), str(d.comments)].filter(Boolean).join(" · "));
    useLabelBox(cert, d.label_box);
    restraighten();
    let sidesNote = "";
    if (coinCtx && sides.obv === coinCtx.obv && sides.rev === coinCtx.rev) {
      const pick = Number(d.obverse_image);
      if (pick === coinCtx.b) { sides.obv = coinCtx.rev; sides.rev = coinCtx.obv; bump(sides.obv); bump(sides.rev); restraighten(); sidesNote = " Obverse and reverse were the wrong way round, so they've been swapped."; }
      else if (pick === coinCtx.a) sidesNote = " Obverse and reverse are in place.";
    }
    if (!filled) readMsg("Couldn't make out the label. Try a sharper photo, or type the details in." + sidesNote, "warn");
    else if (str(d.confidence).toLowerCase() === "low") readMsg("Filled in, but parts of the label were hard to read. Check each field." + sidesNote, "warn");
    else readMsg(`Filled in from the ${str(d.service) || "certificate"} label. Check the fields before saving.` + sidesNote, "ok");
    markDirty();
  }

  function boxOf(r) {
    const t = r.rot * Math.PI / 180, ex = Math.abs(Math.cos(t)) * r.rw / 2 + Math.abs(Math.sin(t)) * r.rh / 2;
    const ey = Math.abs(Math.sin(t)) * r.rw / 2 + Math.abs(Math.cos(t)) * r.rh / 2;
    return { x0: r.cx - ex, x1: r.cx + ex, y0: r.cy - ey, y1: r.cy + ey };
  }
  function iou(a, b) {
    const A = boxOf(a), B = boxOf(b);
    const ix = Math.max(0, Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0)), iy = Math.max(0, Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0));
    const inter = ix * iy, u = (A.x1 - A.x0) * (A.y1 - A.y0) + (B.x1 - B.x0) * (B.y1 - B.y0) - inter;
    return u > 0 ? inter / u : 0;
  }
  function useLabelBox(cert, b) {
    if (!b || typeof b !== "object" || !cert.src || cert !== sides.cert) return;
    const x0 = Number(b.x0), y0 = Number(b.y0), x1 = Number(b.x1), y1 = Number(b.y1);
    if (![x0, y0, x1, y1].every(Number.isFinite) || x1 - x0 < 0.05 || y1 - y0 < 0.05 || x0 < -0.05 || y0 < -0.05 || x1 > 1.05 || y1 > 1.05) return;
    const prior = { cx: (x0 + x1) / 2 * cert.w, cy: (y0 + y1) / 2 * cert.h, rw: (x1 - x0) * cert.w, rh: (y1 - y0) * cert.h, rot: 0 };
    cert.prior = prior;
    if (cert.manual || cert.busy) return;
    const current = { cx: cert.cx, cy: cert.cy, rw: cert.rw, rh: cert.rh, rot: certRot(cert) };
    if (cert.found && iou(current, prior) > 0.55) return;
    detectSide("cert", prior);
  }

  /* ---------- saving ---------- */
  // File names sort on a desktop by date, then denomination, then grade, then comment, then
  // certificate. Fields are separated by spaces (which sort before any letter or digit), so a
  // plain date comes before the same year with a mint mark or variety. Numbers are padded so
  // plain alphabetical sorting and the desktop's number-aware sorting agree.
  const slug = (s, keepDot) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[★*]/g, " star ").replace(/\+/g, " plus ").replace(/&/g, " and ")
    .replace(keepDot ? /[^A-Za-z0-9.]+/g : /[^A-Za-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  function datePart(s) {
    const m = s.match(/\b(1[5-9]\d\d|20\d\d)\b/);
    if (!m) return slug(s) || "-";
    const rest = slug(s.replace(m[0], " "));
    return m[1] + (rest ? "-" + rest : "");
  }
  function denomPart(s) {
    const t = s.toLowerCase().trim();
    if (!t) return "-";
    const frac = t.match(/(\d+)\s*\/\s*(\d+)/), num = t.match(/\d+(?:\.\d+)?/);
    const dollars = /\$|dollar/.test(t), centsMarked = /¢|cent|penny|pence|\d\s*c\b|^c\b/.test(t);
    let v = frac ? Number(frac[1]) / Number(frac[2]) : num ? Number(num[0]) : /½|half/.test(t) ? 0.5 : null;
    if (v == null && dollars) v = 1;
    if (v == null || (!dollars && !centsMarked)) return slug(s) || "-";
    const cents = Math.round((dollars && !centsMarked ? v * 100 : v) * 100) / 100;
    const whole = Math.floor(cents), part = Math.round((cents - whole) * 100);
    return String(whole).padStart(4, "0") + (part ? "." + String(part).padStart(2, "0").replace(/0$/, "") : "") + "c";
  }
  const GRADE_BASE = { PO: 1, P: 1, FR: 2, AG: 3, G: 4, VG: 8, F: 12, VF: 20, EF: 40, XF: 40, AU: 50, UNC: 60, BU: 60, MS: 60, PR: 60, PF: 60, SP: 60 };
  function gradePart(s) {
    const g = s.toUpperCase().trim();
    if (!g) return "-";
    const pre = g.match(/^(MS|PR|PF|SP|AU|XF|EF|VF|VG|AG|UNC|BU|FR|PO|G|F|P)(?![A-Z])/);
    const n = g.match(/\d{1,2}/);
    const value = n ? Number(n[0]) : pre ? GRADE_BASE[pre[1]] : 0;
    let rest = g;
    if (pre) rest = rest.slice(pre[0].length);
    if (n) rest = rest.replace(n[0], " ");
    const plus = /\+/.test(rest);
    rest = slug(rest.replace(/\+/g, " "));
    return String(value).padStart(2, "0") + (plus ? "plus" : "") + (pre ? "-" + pre[1] : "") + (rest ? "-" + rest : "");
  }
  function fileName() {
    const v = values();
    if (!Object.values(v).some(Boolean)) return "coin-plate.jpg";
    const comment = slug(v.notes).slice(0, 40).replace(/-$/, "") || "-";
    const cert = slug([v.service, v.cert].filter(Boolean).join(" "));
    const parts = [datePart(v.date), denomPart(v.denom), gradePart(v.grade), comment];
    if (cert) parts.push(cert);
    return parts.join(" ").slice(0, 140) + ".jpg";
  }
  /* ---------- details written into the JPG ----------
     EXIF Title/Subject/Tags/Comments are what Windows shows and searches; the XMP copy
     (dc:title, dc:description, dc:subject) is what Mac Spotlight and photo apps read. */
  function metaFor(v) {
    const title = [v.date, v.denom, v.grade].filter(Boolean).join(" ");
    const subject = [v.service, v.cert].filter(Boolean).join(" ");
    const summary = [title, subject, v.notes].filter(Boolean).join(" · ");
    const keywords = [v.date, v.denom, v.grade, v.service, v.cert, v.notes].filter(Boolean).map((k) => k.replace(/;/g, ","));
    return { title, subject, summary, keywords };
  }
  const utf16le = (s) => {
    const b = new Uint8Array(s.length * 2 + 2);
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); b[i * 2] = c & 255; b[i * 2 + 1] = c >> 8; }
    return b;
  };
  const asciiZ = (s) => {
    const t = s.replace(/¢/g, "c").replace(/[–—]/g, "-").replace(/·/g, "-").replace(/★/g, "*")
      .normalize("NFKD").replace(/[^\x20-\x7E]/g, "");
    const b = new Uint8Array(t.length + 1);
    for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i);
    return b;
  };
  function exifSegment(m) {
    const entries = [
      { tag: 0x010e, type: 2, data: asciiZ(m.summary) },
      { tag: 0x9c9b, type: 1, data: utf16le(m.title) },
      { tag: 0x9c9c, type: 1, data: utf16le(m.summary) },
      { tag: 0x9c9e, type: 1, data: utf16le(m.keywords.join(";")) },
      { tag: 0x9c9f, type: 1, data: utf16le(m.subject) },
    ].filter((e) => e.data.length > (e.type === 2 ? 1 : 2));
    if (!entries.length) return new Uint8Array(0);
    const ifd = 2 + entries.length * 12 + 4;
    let size = 8 + ifd;
    for (const e of entries) if (e.data.length > 4) size += e.data.length + (e.data.length & 1);
    const tiff = new Uint8Array(size), dv = new DataView(tiff.buffer);
    tiff[0] = 0x49; tiff[1] = 0x49; dv.setUint16(2, 42, true); dv.setUint32(4, 8, true);
    dv.setUint16(8, entries.length, true);
    let p = 10, d = 8 + ifd;
    for (const e of entries) {
      dv.setUint16(p, e.tag, true); dv.setUint16(p + 2, e.type, true); dv.setUint32(p + 4, e.data.length, true);
      if (e.data.length <= 4) tiff.set(e.data, p + 8);
      else { dv.setUint32(p + 8, d, true); tiff.set(e.data, d); d += e.data.length + (e.data.length & 1); }
      p += 12;
    }
    dv.setUint32(p, 0, true);
    const len = 2 + 6 + tiff.length;
    if (len > 65535) return new Uint8Array(0);
    const seg = new Uint8Array(2 + len);
    seg.set([0xff, 0xe1, len >> 8, len & 255, 0x45, 0x78, 0x69, 0x66, 0, 0]);
    seg.set(tiff, 10);
    return seg;
  }
  function xmpSegment(m) {
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const alt = (s) => `<rdf:Alt><rdf:li xml:lang="x-default">${esc(s)}</rdf:li></rdf:Alt>`;
    const xml = '<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      (m.title ? `<dc:title>${alt(m.title)}</dc:title>` : "") +
      (m.summary ? `<dc:description>${alt(m.summary)}</dc:description>` : "") +
      (m.keywords.length ? `<dc:subject><rdf:Bag>${m.keywords.map((k) => `<rdf:li>${esc(k)}</rdf:li>`).join("")}</rdf:Bag></dc:subject>` : "") +
      '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
    const head = new TextEncoder().encode("http://ns.adobe.com/xap/1.0/\0");
    const body = new TextEncoder().encode(xml);
    const len = 2 + head.length + body.length;
    if (len > 65535) return new Uint8Array(0);
    const seg = new Uint8Array(2 + len);
    seg.set([0xff, 0xe1, len >> 8, len & 255]);
    seg.set(head, 4); seg.set(body, 4 + head.length);
    return seg;
  }
  async function withMetadata(blob, v) {
    const m = metaFor(v);
    if (!m.title && !m.subject && !m.summary) return blob;
    const buf = new Uint8Array(await blob.arrayBuffer());
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return blob;
    let pos = 2;
    if (buf[2] === 0xff && buf[3] === 0xe0) pos = 4 + ((buf[4] << 8) | buf[5]);
    const exif = exifSegment(m), xmp = xmpSegment(m);
    return new Blob([buf.subarray(0, pos), exif, xmp, buf.subarray(pos)], { type: "image/jpeg" });
  }

  let viewerUrl = "";
  function showViewer(blob) {
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    viewerUrl = URL.createObjectURL(blob);
    $("viewerImg").src = viewerUrl;
    $("viewer").hidden = false;
    $("viewerClose").focus();
  }
  $("viewerClose").addEventListener("click", () => {
    $("viewer").hidden = true;
    if (batch.active && batch.advanceOnClose) { batch.advanceOnClose = false; advanceAfterSave(); }
  });

  let saving = false;
  async function savePlate() {
    if (saving) return "";
    if (exampleMode()) { toast("Add your photos first. The plate above is an example."); return ""; }
    learnHabit();
    try { learnTypes(); } catch (e) { /* not learned */ }
    const btn = $("saveBtn");
    btn.disabled = true; saving = true;
    try {
      await Promise.race([fontsReady, new Promise((r) => setTimeout(r, 2500))]);
      const c = document.createElement("canvas");
      renderPlate(c, P.S, false);
      const plain = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.95));
      if (!plain) { toast("Couldn't create the image. Try again."); return ""; }
      let blob = plain;
      try { blob = await withMetadata(plain, values()); } catch (e) { blob = plain; }
      const name = fileName();
      if (isNative) {
        try {
          const data = await new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = no; fr.readAsDataURL(blob); });
          await Vision.saveImage({ data, filename: name, folder: "Slab Plates" });
          toast(`Saved to Pictures/Slab Plates`);
          return "saved";
        } catch (e) {
          toast("Couldn't save the image. " + ((e && e.message) || "Try again."));
          return "";
        }
      }
      const dl = await downloadsPromise;
      if (!dl) { showViewer(blob); return "viewer"; }
      try {
        const res = await dl.save({ filename: name, data: blob });
        toast(res && res.status === "delivered" ? "Sent." : `Saved ${name}`);
        return "saved";
      } catch (e) {
        const code = e && e.code;
        if (code === "declined") toast("Not saved.");
        else if (code === "rate_limited") toast("A save is already waiting for your answer.");
        else { showViewer(blob); return "viewer"; }
        return "";
      }
    } finally {
      saving = false;
      btn.disabled = false;
    }
  }

  /* ---------- next coin ---------- */
  let armTimer = 0;
  function disarm() { clearTimeout(armTimer); const b = $("nextBtn"); delete b.dataset.armed; b.textContent = batch.active ? "Skip" : "Next coin"; }
  function resetCoin() {
    if (readCtl) { readCtl.abort(); readCtl = null; }
    sides.obv = blankSide(); sides.rev = blankSide(); sides.cert = blankSide();
    for (const k in FIELDS) $(FIELDS[k]).value = "";
    readMsgText = "";
    newSoloListing();
    setActive("obv");
    window.scrollTo({ top: 0, behavior: "smooth" });
    toast("Cleared. Add the next coin's photos.");
  }
  $("nextBtn").addEventListener("click", () => {
    if (batch.active) { if (!batch.busy && batch.idx < batch.groups.length - 1) openGroup(batch.idx + 1); return; }
    const b = $("nextBtn"), v = values();
    const hasWork = sides.obv.src || sides.rev.src || sides.cert.src || Object.values(v).some(Boolean);
    if (!hasWork) { toast("Nothing to clear yet."); return; }
    if (b.dataset.armed !== "1") {
      b.dataset.armed = "1"; b.textContent = "Tap again to clear";
      armTimer = setTimeout(disarm, 3500);
      return;
    }
    disarm(); resetCoin();
  });

  /* ---------- batch: a whole session of photos, one coin at a time ----------
     Only the current coin's three photos are held at full size; the rest of the session
     is kept as the picked files plus what was found in them, so a phone doesn't run out of memory. */
  const batch = { active: false, busy: false, groups: [], idx: -1, progress: "", stripKey: "", advanceOnClose: false };
  const PARAMS = ["cx", "cy", "r", "rot", "rw", "rh", "base", "tilt", "rings", "ringIdx", "manual", "found", "note", "prior",
    "orient", "rotAuto", "upFrom", "textUp", "textFine", "typeM", "typeKey", "textDone", "legend"];

  function thumbOf(side, res) {
    const S = 96, c = document.createElement("canvas");
    c.width = c.height = S;
    const x = c.getContext("2d");
    x.fillStyle = "#000"; x.fillRect(0, 0, S, S);
    if (res && res.coin) {
      const t = { ...side, ...res.coin, rot: 0, ver: -1 };
      x.save(); x.beginPath(); x.arc(S / 2, S / 2, S / 2 - 2, 0, TAU); x.clip();
      const k = (S - 4) / (2 * t.r);
      x.drawImage(side.src, t.cx - t.r, t.cy - t.r, t.r * 2, t.r * 2, 2, 2, t.r * 2 * k, t.r * 2 * k);
      x.restore();
    } else {
      const s = Math.min(S / side.w, S / side.h);
      x.drawImage(side.src, (S - side.w * s) / 2, (S - side.h * s) / 2, side.w * s, side.h * s);
    }
    return c.toDataURL("image/jpeg", 0.8);
  }

  // Walk the session in the order taken. Each coin needs an obverse, a reverse and a certificate;
  // a holder front gives two of those at once (PCGS, NGC). A role that's already filled, or a
  // complete set, starts the next coin, so the certificate can be shot first or last.
  function groupItems(items) {
    const good = items.filter((x) => !x.bad), groups = [];
    const fresh = () => ({ obv: null, rev: null, cert: null });
    let cur = fresh();
    const close = () => { if (cur.obv || cur.rev || cur.cert) groups.push(cur); cur = fresh(); };
    const frontCert = (g) => !!(g && g.cert && g.cert.role === "front");
    for (let n = 0; n < good.length; n++) {
      const x = good[n];
      if (x.role === "front") {
        if (cur.obv && !cur.rev && !cur.cert) { cur.rev = cur.obv; cur.obv = null; } // back was shot first
        if (cur.obv || frontCert(cur)) close();
        cur.obv = x;
        if (!cur.cert) cur.cert = x; // a label photo already taken for this coin stays its certificate
      } else if (x.role === "label") {
        const empty = !cur.obv && !cur.rev && !cur.cert;
        const prev = groups[groups.length - 1], next = good[n + 1];
        const t = (y) => (y && y.file && y.file.lastModified) || 0;
        const last = prev && (prev.rev || prev.obv);
        // when the next photo starts a coin of its own, or this one was taken closer to the last coin
        const toPrev = !next || next.role === "front" || t(x) - t(last) <= t(next) - t(x);
        if (empty && frontCert(prev) && !prev.ownLabel && toPrev) {
          // obverse (label showing), reverse, then a close-up of the label: it belongs to that coin
          prev.cert = x; prev.ownLabel = true;
          continue;
        }
        if (cur.cert && !frontCert(cur)) close();
        cur.cert = x; // replaces the label seen in a holder front
      } else {
        if (cur.obv && cur.rev) close();
        if (!cur.obv) cur.obv = x; else cur.rev = x;
      }
      if (cur.obv && cur.rev && cur.cert) close();
    }
    close();
    return groups.map((g) => ({
      ...g, coins: [g.obv, g.rev].filter(Boolean), saved: false, read: false, state: null, fields: null, msg: "",
      problem: !g.cert ? "No certificate photo found for this coin" : !g.obv ? "No coin photos found for this certificate"
        : !g.rev ? "Only one coin photo found" : "",
    }));
  }

  // Photos from the camera's prompts: each one's coin and role are already known.
  function groupsFromPlan(items) {
    const byCoin = new Map();
    for (const x of items) {
      if (x.bad || !x.plan) continue;
      if (!byCoin.has(x.plan.coin)) byCoin.set(x.plan.coin, []);
      byCoin.get(x.plan.coin).push(x);
    }
    const groups = [];
    for (const xs of byCoin.values()) {
      const at = (st) => xs.find((x) => x.plan.step === st) || null;
      let g;
      if (xs[0].plan.mode === "two") {
        const front = at(0), back = at(1);
        if (front && front.role !== "front") { front.role = "front"; front.rect = front.rect || (front.res && front.res.rect) || null; }
        g = { obv: front, rev: back, cert: front, guided: true };
      } else {
        const lab = at(2);
        if (lab) { lab.role = "label"; lab.rect = null; }
        g = { obv: at(0), rev: at(1), cert: lab, guided: true };
      }
      groups.push(g);
    }
    return groups.map((g) => ({
      ...g, coins: [g.obv, g.rev].filter(Boolean), saved: false, read: false, state: null, fields: null, msg: "",
      problem: !g.cert ? "No certificate photo for this coin" : !g.obv ? "No obverse photo for this coin" : !g.rev ? "No reverse photo for this coin" : "",
    }));
  }

  async function startBatch(fileList, plan) {
    const all = [...fileList];
    const keepI = all.map((f, i) => i).filter((i) => !all[i].type || /^image\//.test(all[i].type));
    const files = keepI.map((i) => all[i]);
    if (plan) plan = keepI.map((i) => plan[i]);
    if (files.length < 4 && !(plan && new Set(plan.map((p) => p.coin)).size > 1)) { loadMany(files, plan); return; }
    if (readCtl) { readCtl.abort(); readCtl = null; }
    // photos sort in the order they were taken when the phone says so, otherwise as picked
    // (photos from the camera's prompts are already in order)
    const times = new Set(files.map((f) => f.lastModified));
    const list = files.map((f, i) => ({ f, i }));
    if (!plan && times.size === files.length) list.sort((p, q) => p.f.lastModified - q.f.lastModified);
    Object.assign(batch, { active: true, busy: true, groups: [], idx: -1, stripKey: "", advanceOnClose: false });
    sides.obv = blankSide(); sides.rev = blankSide(); sides.cert = blankSide();
    for (const k in FIELDS) $(FIELDS[k]).value = "";
    readMsgText = "";
    disarm();
    const items = [];
    let failed = 0;
    for (let n = 0; n < list.length; n++) {
      batch.progress = `Sorting photo ${n + 1} of ${list.length}…`;
      markDirty();
      await tick();
      if (!batch.active) return;
      const side = await sideFromFile(list[n].f);
      if (!side) { failed++; items.push({ bad: true }); continue; }
      const g = graysFor(side);
      const res = await runDetect({ kind: "classify", small: g.small, big: g.big });
      const role = await roleOf(side, res);
      items.push({ file: list[n].f, res, role: role.role, rect: role.rect || null, thumb: thumbOf(side, res), plan: plan ? plan[list[n].i] : null });
      side.src = null; side.grays = null;
    }
    batch.groups = plan ? groupsFromPlan(items) : groupItems(items);
    batch.progress = "";
    batch.busy = false;
    if (failed) toast(`${failed} photo${failed > 1 ? "s" : ""} couldn't be opened and ${failed > 1 ? "were" : "was"} left out.`);
    if (!batch.groups.length) { endBatch(); toast("Couldn't find any coins in those photos."); return; }
    await openGroup(0);
  }

  function stashGroup() {
    const g = batch.groups[batch.idx];
    if (!g) return;
    if (readCtl) { readCtl.abort(); readCtl = null; g.read = false; }
    g.state = {};
    for (const key of ["obv", "rev", "cert"]) {
      const s = sides[key];
      if (!s.src) continue;
      const params = {};
      for (const p of PARAMS) params[p] = s[p];
      g.state[key] = { file: s.file, params };
    }
    g.fields = values();
    g.msg = readMsgText;
  }

  async function openGroup(i) {
    if (batch.busy || i < 0 || i >= batch.groups.length) return;
    if (batch.idx >= 0 && batch.idx !== i) stashGroup();
    batch.idx = i; batch.busy = true; batch.advanceOnClose = false;
    const g = batch.groups[i];
    batch.progress = `Opening coin ${i + 1}…`;
    sides.obv = blankSide(); sides.rev = blankSide(); sides.cert = blankSide();
    cropCache.clear();
    for (const k in FIELDS) $(FIELDS[k]).value = (g.fields && g.fields[k]) || "";
    readMsgText = g.msg || "";
    markDirty();
    await tick();
    const plan = g.state ? g.state : {
      obv: g.obv && { file: g.obv.file, res: g.obv.res },
      rev: g.rev && { file: g.rev.file, res: g.rev.res },
      cert: g.cert && { file: g.cert.file, res: g.cert.res, rect: g.cert.role === "front" ? g.cert.rect : null },
    };
    const opened = new Map();
    for (const key of ["obv", "rev", "cert"]) {
      const it = plan[key];
      if (!it || !it.file) continue;
      // a holder front is used twice; open it once
      const seen = opened.get(it.file);
      const side = seen ? sharedSide(seen) : await sideFromFile(it.file);
      if (batch.groups[batch.idx] !== g) return;
      if (!side) continue;
      if (!seen) opened.set(it.file, side);
      if (it.params) Object.assign(side, it.params);
      else if (key === "cert") applyRect(side, it.rect || (it.res && it.res.rect), null);
      else applyCoin(side, it.res && it.res.coin, key);
      sides[key] = side;
      bump(side);
    }
    batch.busy = false;
    batch.progress = "";
    setActive("obv");
    disarm();
    $("plate").scrollIntoView({ behavior: "smooth", block: "nearest" });
    const both = !!(sides.obv.src && sides.rev.src) && !g.guided;
    if (!g.read && sides.cert.src && canRead()) {
      g.read = true;
      readCert({ checkSides: both && !g.state });
    } else if (isNative) {
      const check = !g.read && both;
      if (check) g.read = true;
      textPass(check);
    }
  }

  function advanceAfterSave() {
    if (batch.idx < batch.groups.length - 1) { openGroup(batch.idx + 1); return; }
    const left = batch.groups.filter((g) => !g.saved).length;
    toast(left ? `That was the last coin. ${left} still not saved.` : `All ${batch.groups.length} coins saved.`);
  }

  function endBatch() {
    if (readCtl) { readCtl.abort(); readCtl = null; }
    Object.assign(batch, { active: false, busy: false, groups: [], idx: -1, progress: "", stripKey: "", advanceOnClose: false });
    sides.obv = blankSide(); sides.rev = blankSide(); sides.cert = blankSide();
    cropCache.clear();
    for (const k in FIELDS) $(FIELDS[k]).value = "";
    readMsgText = "";
    disarm();
    setActive("obv");
  }

  function renderBatch() {
    const bar = $("batchBar");
    bar.hidden = !batch.active;
    $("saveBtn").textContent = batch.active ? (batch.idx < batch.groups.length - 1 ? "Save and next" : "Save") : "Save image";
    if (!batch.active) return;
    const n = batch.groups.length, saved = batch.groups.filter((g) => g.saved).length;
    $("batchCount").textContent = n ? `Coin ${batch.idx + 1} of ${n}` : "Batch";
    const g = batch.groups[batch.idx];
    $("batchSub").textContent = batch.progress || (g && g.problem ? g.problem : `${saved} of ${n} saved`);
    $("batchSub").className = !batch.progress && g && g.problem ? "warn" : "";
    $("prevCoin").disabled = batch.busy || batch.idx <= 0;
    $("nextCoin").disabled = batch.busy || batch.idx >= n - 1;
    $("nextBtn").disabled = batch.busy || batch.idx >= n - 1;
    $("saveBtn").disabled = batch.busy || saving;
    const key = batch.groups.map((x) => (x.saved ? "s" : "") + (x.listed ? "l" : "") + (x.problem ? "p" : "")).join(",") + "|" + batch.idx + "|" + batch.busy;
    if (key === batch.stripKey) return;
    batch.stripKey = key;
    const strip = $("strip");
    strip.textContent = "";
    batch.groups.forEach((x, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chipcoin" + (i === batch.idx ? " on" : "") + (x.saved ? " saved" : "") + (x.listed ? " listed" : "") + (x.problem ? " problem" : "");
      b.setAttribute("aria-label", `Coin ${i + 1}${x.saved ? ", saved" : ""}${x.listed ? ", listed on eBay" : ""}${x.problem ? ", needs a check" : ""}`);
      if (i === batch.idx) b.setAttribute("aria-current", "true");
      b.disabled = batch.busy;
      const thumbSrc = (x.coins[0] && x.coins[0].thumb) || (x.cert && x.cert.thumb);
      if (thumbSrc) { const im = document.createElement("img"); im.src = thumbSrc; im.alt = ""; b.appendChild(im); }
      const num = document.createElement("span"); num.className = "num"; num.textContent = String(i + 1); b.appendChild(num);
      b.addEventListener("click", () => openGroup(i));
      strip.appendChild(b);
    });
    const cur = strip.children[batch.idx];
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest", inline: "center" });
  }

  let endArm = 0;
  $("prevCoin").addEventListener("click", () => openGroup(batch.idx - 1));
  $("nextCoin").addEventListener("click", () => openGroup(batch.idx + 1));
  $("endBatch").addEventListener("click", () => {
    const b = $("endBatch");
    if (b.dataset.armed !== "1") {
      b.dataset.armed = "1"; b.textContent = "Tap again to end";
      clearTimeout(endArm); endArm = setTimeout(() => { delete b.dataset.armed; b.textContent = "End batch"; }, 3500);
      return;
    }
    clearTimeout(endArm); delete b.dataset.armed; b.textContent = "End batch";
    endBatch();
    toast("Batch ended.");
  });

  /* ---------- taking photos with the phone's camera ----------
     Each tap opens the camera app at full resolution. The prompts walk through each coin;
     the photos are then sorted exactly as if they had been chosen from the gallery. */
  const SHOOT_STEPS = { three: ["Obverse", "Reverse", "Certificate"], two: ["Holder front", "Holder back"] };
  const shoot = { active: false, shots: [], mode: "three", coin: 0, step: 0, stripKey: "" };
  try { const m = localStorage.getItem("slabplates.shootMode"); if (SHOOT_STEPS[m]) shoot.mode = m; } catch (e) { /* ignore */ }
  if (!isNative) shoot.mode = "three"; // telling a holder front from its back needs the phone's text reading
  function renderShoot() {
    $("shootBar").hidden = !shoot.active;
    $("addRow").hidden = shoot.active;
    $("addNote").hidden = shoot.active;
    document.querySelector(".tiles").hidden = shoot.active;
    if (!shoot.active) return;
    const steps = SHOOT_STEPS[shoot.mode], n = shoot.shots.length;
    $("shootStep").textContent = `Coin ${shoot.coin + 1} · ${steps[shoot.step]}`;
    const done = shoot.coin;
    $("shootCount").textContent = !n ? "Take the first photo" : `${n} photo${n > 1 ? "s" : ""} taken · ${done} coin${done === 1 ? "" : "s"} complete`;
    $("shootModes").hidden = !isNative;
    $("modeThree").checked = shoot.mode === "three";
    $("modeTwo").checked = shoot.mode === "two";
    $("modeThree").disabled = $("modeTwo").disabled = shoot.step !== 0;
    $("shootUndo").disabled = !n;
    $("shootDone").disabled = !n;
    $("shootDone").textContent = n > 3 ? `Use these ${n} photos` : "Use these photos";
    $("keepWrap").hidden = !isNative;
    const key = shoot.shots.map((s) => s.url).join("|");
    if (key !== shoot.stripKey) {
      shoot.stripKey = key;
      const strip = $("shootStrip");
      strip.textContent = "";
      shoot.shots.forEach((s) => {
        const d = document.createElement("div"); d.className = "shoot-shot";
        const im = document.createElement("img"); im.src = s.url; im.alt = s.label;
        const t = document.createElement("span"); t.textContent = s.label;
        d.append(im, t); strip.appendChild(d);
      });
      strip.scrollLeft = strip.scrollWidth;
    }
  }
  function endShoot() {
    shoot.shots.forEach((s) => URL.revokeObjectURL(s.url));
    Object.assign(shoot, { active: false, shots: [], coin: 0, step: 0, stripKey: "" });
    renderShoot();
  }
  async function keepOriginal(file, label) {
    if (!isNative || !$("keepChk").checked) return;
    try {
      const d = new Date(file.lastModified || Date.now()), p = (v) => String(v).padStart(2, "0");
      const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
      const data = await new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = no; fr.readAsDataURL(file); });
      await Vision.saveImage({ data, filename: `${stamp} ${label.toLowerCase()}.jpg`, folder: "Slab Plates/Photos" });
    } catch (e) { /* the photo is still used for the plate */ }
  }
  $("shootStart").addEventListener("click", () => {
    endShoot();
    shoot.active = true;
    renderShoot();
    $("shootBar").scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  $("shootInput").addEventListener("change", () => {
    const f = $("shootInput").files && $("shootInput").files[0];
    $("shootInput").value = "";
    if (!f) return;
    const steps = SHOOT_STEPS[shoot.mode], label = `Coin ${shoot.coin + 1} ${steps[shoot.step]}`;
    shoot.shots.push({ file: f, url: URL.createObjectURL(f), label, coin: shoot.coin, step: shoot.step, mode: shoot.mode });
    keepOriginal(f, label);
    shoot.step++;
    if (shoot.step >= steps.length) { shoot.step = 0; shoot.coin++; toast(`Coin ${shoot.coin} done. Carry on with the next coin, or tap Use these photos.`); }
    renderShoot();
  });
  $("shootUndo").addEventListener("click", () => {
    const s = shoot.shots.pop();
    if (!s) return;
    URL.revokeObjectURL(s.url);
    shoot.coin = s.coin; shoot.step = s.step;
    renderShoot();
  });
  document.querySelectorAll('input[name="shootMode"]').forEach((r) => r.addEventListener("change", () => {
    if (!r.checked || shoot.step !== 0) return;
    shoot.mode = r.value;
    try { localStorage.setItem("slabplates.shootMode", shoot.mode); } catch (e) { /* ignore */ }
    renderShoot();
  }));
  let shootArm = 0;
  $("shootCancel").addEventListener("click", () => {
    const b = $("shootCancel");
    if (shoot.shots.length && b.dataset.armed !== "1") {
      b.dataset.armed = "1"; b.textContent = "Tap again to discard";
      clearTimeout(shootArm); shootArm = setTimeout(() => { delete b.dataset.armed; b.textContent = "Cancel"; }, 3500);
      return;
    }
    clearTimeout(shootArm); delete b.dataset.armed; b.textContent = "Cancel";
    endShoot();
  });
  $("shootDone").addEventListener("click", () => {
    const files = shoot.shots.map((s) => s.file);
    const plan = shoot.shots.map((s) => ({ coin: s.coin, step: s.step, mode: s.mode }));
    endShoot();
    const coins = new Set(plan.map((p) => p.coin)).size;
    if (coins > 1 || files.length > 3) startBatch(files, plan);
    else if (files.length) loadMany(files, plan);
  });

  /* ---------- eBay listing (phone app only) ----------
     Listings go up through eBay's Trading API, so they're ordinary listings that can be edited in
     Seller Hub or the eBay app afterwards. The native Ebay plugin holds the sign-in and signs calls. */
  const Listing = typeof listingModule === "function" ? listingModule() : null;
  const EbayNative = isNative && Listing ? capx.registerPlugin("Ebay") : null;
  const EBAY_STORE = "slabplates.ebay.v1";
  const API = "https://api.ebay.com";
  const ebay = {
    status: { configured: false, connected: false, user: "" },
    settings: { shipping: "", payment: "", returns: "", location: "Brantford, Ontario", postal: "N3R 7X3", grams: "50", size: "6 x 9 x 1 in", footer: Listing ? Listing.DEFAULT_FOOTER : "" },
    cache: { ship: [], pay: [], ret: [], cats: [], store: [], at: 0 },
    busy: false, loading: false, loadMsg: "", photoKey: "",
  };
  try {
    const saved = JSON.parse(localStorage.getItem(EBAY_STORE) || "{}");
    if (saved.settings) Object.assign(ebay.settings, saved.settings);
    // the first defaults (120 g, 19 x 13 x 3 cm) were a guess; your parcels are 50 g, 6 x 9 x 1 in
    if (!String(ebay.settings.postal || "").trim()) ebay.settings.postal = "N3R 7X3";
    if (ebay.settings.grams === "120" && ebay.settings.size === "19 x 13 x 3") { ebay.settings.grams = "50"; ebay.settings.size = "6 x 9 x 1 in"; }
    if (saved.cache) Object.assign(ebay.cache, saved.cache);
  } catch (e) { /* storage unavailable */ }
  const saveEbay = () => { try { localStorage.setItem(EBAY_STORE, JSON.stringify({ settings: ebay.settings, cache: ebay.cache })); } catch (e) { /* ignore */ } };

  const freshListing = () => ({
    title: "", titleEdited: false, extras: null, price: "", bestOffer: true, accept: "", decline: "",
    cat: "", catEdited: false, store: "", storeEdited: false, ship: "", spec: {}, desc: "", descEdited: false,
    photos: { plate: true, obv: true, rev: true, cert: true, oobv: true, orev: true, ocert: true }, uploads: {}, itemId: "", note: "", noteKind: "",
  });
  let soloListing = freshListing();
  function curListing() {
    if (batch.active) { const g = batch.groups[batch.idx]; if (g) return g.listing || (g.listing = freshListing()); }
    return soloListing;
  }
  const newSoloListing = () => { soloListing = freshListing(); };
  const priceOf = (s) => { const n = parseFloat(String(s || "").replace(/,/g, ".").replace(/[^0-9.]/g, "")); return Number.isFinite(n) ? n : 0; };
  const errText = (e) => (e && e.message) || "Something went wrong. Try again.";

  function specsNow(L, v) {
    return Listing.specificsOf(v).map(([name, auto]) => [name, Object.prototype.hasOwnProperty.call(L.spec, name) ? L.spec[name] : auto]);
  }
  function autoFill(L, v) {
    if (!L.titleEdited) L.title = Listing.buildTitle(v, L.extras);
    if (!L.descEdited) L.desc = Listing.buildDescription(v, ebay.settings.footer);
    const cents = Listing.centsOf(v.denom);
    if (!L.catEdited) L.cat = Listing.categoryFor(cents, ebay.cache.cats) || L.cat;
    if (!L.storeEdited) L.store = Listing.storeCategoryFor(v.service, ebay.cache.store);
    if (!L.ship || !ebay.cache.ship.some((p) => p.id === L.ship)) L.ship = ebay.settings.shipping;
  }
  const setVal = (id, val) => { const el = $(id); if (document.activeElement !== el && el.value !== val) el.value = val; };
  function fillSelect(id, list, selected, emptyText) {
    const el = $(id);
    const key = JSON.stringify([list.map((x) => x.id + x.name), emptyText]);
    if (el.dataset.key !== key) {
      el.dataset.key = key;
      el.textContent = "";
      if (emptyText != null) { const o = document.createElement("option"); o.value = ""; o.textContent = emptyText; el.appendChild(o); }
      for (const x of list) { const o = document.createElement("option"); o.value = x.id; o.textContent = x.path || x.name; el.appendChild(o); }
    }
    if (el.value !== (selected || "")) el.value = selected || "";
  }

  // listing photos: the plate, the three crops, then the original photos as taken
  // (an original used twice, like a holder front that gives the obverse and the label, appears once)
  const PHOTO_KEYS = [["plate", "Plate"], ["obv", "Obverse"], ["rev", "Reverse"], ["cert", "Certificate"],
    ["oobv", "Obverse photo"], ["orev", "Reverse photo"], ["ocert", "Label photo"]];
  const ORIGINAL_OF = { oobv: "obv", orev: "rev", ocert: "cert" };
  const isOriginal = (k) => !!ORIGINAL_OF[k];
  function photoAvailable(k) {
    if (k === "plate") return !exampleMode();
    const side = sides[ORIGINAL_OF[k] || k];
    if (!side.src) return false;
    if (k === "ocert" && side.file && (side.file === sides.obv.file || side.file === sides.rev.file)) return false;
    if (k === "orev" && side.file && side.file === sides.obv.file) return false;
    return true;
  }
  const holderShots = () => !!(sides.cert.file && sides.cert.file === sides.obv.file);
  function photoLabel(k, label) {
    if (holderShots() && k === "oobv") return "Front photo";
    if (holderShots() && k === "orev") return "Back photo";
    return label;
  }
  // The original photo, re-encoded: same pixels and colour, but no location or other camera data.
  // Cropped square around the holder (eBay's gallery is square), trimming empty background but
  // never cutting into the holder: what isn't background, plus the coin and label found in it.
  const squareCache = new Map();
  function squareBox(side) {
    const key = side.photoId + "|" + side.w + "x" + side.h;
    if (squareCache.has(key)) return squareCache.get(key);
    const n = 300, k = n / Math.max(side.w, side.h), w = Math.max(1, Math.round(side.w * k)), h = Math.max(1, Math.round(side.h * k));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const x = c.getContext("2d"); x.drawImage(side.src, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data, lum = (i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    // the background's colour: the median brightness round the photo's border
    const edge = [];
    for (let i = 0; i < w; i++) { edge.push(lum(i * 4), lum(((h - 1) * w + i) * 4)); }
    for (let j = 0; j < h; j++) { edge.push(lum(j * w * 4), lum((j * w + w - 1) * 4)); }
    edge.sort((a, b) => a - b);
    const bg = edge[Math.floor(edge.length / 2)], xs = [], ys = [];
    for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
      if (Math.abs(lum((j * w + i) * 4) - bg) > 28) { xs.push(i); ys.push(j); }
    }
    let box = null;
    if (xs.length > w * h * 0.02) {
      xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
      const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
      box = { x0: q(xs, 0.005) / k, x1: q(xs, 0.995) / k, y0: q(ys, 0.005) / k, y1: q(ys, 0.995) / k };
    }
    const add = (x0, y0, x1, y1) => { box = box ? { x0: Math.min(box.x0, x0), y0: Math.min(box.y0, y0), x1: Math.max(box.x1, x1), y1: Math.max(box.y1, y1) } : { x0, y0, x1, y1 }; };
    for (const sd of [sides.obv, sides.rev, sides.cert]) {
      if (sd.src !== side.src || !sd.found) continue;
      if (sd.r > 0) add(sd.cx - sd.r, sd.cy - sd.r, sd.cx + sd.r, sd.cy + sd.r);
      else if (sd.rw > 0) { const e = Math.hypot(sd.rw, sd.rh) / 2; add(sd.cx - e, sd.cy - e, sd.cx + e, sd.cy + e); }
    }
    let out = null;
    if (box) {
      const short = Math.min(side.w, side.h);
      const size = Math.round(Math.min(short, Math.max(box.x1 - box.x0, box.y1 - box.y0) * 1.1));
      const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
      const x0 = Math.round(Math.max(0, Math.min(side.w - size, cx - size / 2))), y0 = Math.round(Math.max(0, Math.min(side.h - size, cy - size / 2)));
      out = { x: x0, y: y0, s: size };
    }
    squareCache.set(key, out);
    return out;
  }
  function originalCanvas(side, maxDim) {
    const b = squareBox(side);
    if (!b) return Math.max(side.w, side.h) <= maxDim ? side.src : scaledCanvas(side.src, side.w, side.h, maxDim);
    const out = Math.min(maxDim, b.s), c = document.createElement("canvas");
    c.width = c.height = out;
    const x = c.getContext("2d");
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high";
    x.drawImage(side.src, b.x, b.y, b.s, b.s, 0, 0, out, out);
    return c;
  }
  function buildPhotoPicker() {
    const box = $("ePhotos");
    for (const [k, label] of PHOTO_KEYS) {
      const l = document.createElement("label"); l.className = "ephoto";
      const i = document.createElement("input"); i.type = "checkbox"; i.id = "eph-" + k; i.checked = true;
      const c = document.createElement("canvas"); c.width = c.height = 152; c.id = "ephc-" + k;
      const s = document.createElement("span"); s.textContent = label; s.id = "ephl-" + k;
      l.append(i, c, s); box.appendChild(l);
      i.addEventListener("change", () => { curListing().photos[k] = i.checked; renderListing(); });
    }
  }
  function drawListingPhotos() {
    const key = ["obv", "rev", "cert"].map((k) => sides[k].ver + ":" + sides[k].photoId).join(".") + look.bg + look.captions;
    if (key === ebay.photoKey) return;
    ebay.photoKey = key;
    for (const [k, label] of PHOTO_KEYS) {
      const c = $("ephc-" + k), x = c.getContext("2d");
      $("ephl-" + k).textContent = photoLabel(k, label);
      $("eph-" + k).parentElement.hidden = k !== "plate" && !photoAvailable(k) && isOriginal(k);
      x.fillStyle = isOriginal(k) ? "#000" : BG[look.bg].bg; x.fillRect(0, 0, c.width, c.height);
      let src = null;
      if (!photoAvailable(k)) src = null;
      else if (k === "plate") src = $("plate");
      else if (isOriginal(k)) src = originalCanvas(sides[ORIGINAL_OF[k]], 400);
      else src = k === "cert" ? certCanvas(sides[k], 400) : coinCanvas(sides[k], 300);
      if (!src) continue;
      const s = Math.min(c.width / src.width, c.height / src.height);
      x.drawImage(src, (c.width - src.width * s) / 2, (c.height - src.height * s) / 2, src.width * s, src.height * s);
    }
  }

  // The parcel from eBay settings: weight in grams, size "19 x 13 x 3" in centimetres.
  function packOf() {
    const set = ebay.settings, n = String(set.size || "").match(/\d+(?:\.\d+)?/g) || [];
    // centimetres unless marked in inches ("in", "inch" or ")
    const k = /in|"|”/i.test(String(set.size || "")) ? 2.54 : 1, d = (i, def) => (Number(n[i]) || def) * k;
    return { grams: Number(String(set.grams || "").replace(/[^\d.]/g, "")) || 0, l: d(0, 9), w: d(1, 6), h: d(2, 1) };
  }
  function listingProblem(L) {
    if (!ebay.status.connected) return "Connect your eBay account first.";
    if (exampleMode()) return "Add the coin's photos first.";
    if (!L.title.trim()) return "Add a title.";
    if (priceOf(L.price) <= 0) return "Add a price.";
    if (!L.cat) return ebay.cache.cats.length ? "Choose a category." : "eBay's categories haven't loaded. Open eBay settings and tap Reload from eBay.";
    if (!L.ship || !ebay.settings.payment || !ebay.settings.returns) return "Choose your shipping, payment and return policies in eBay settings.";
    if (!Listing.postal(ebay.settings.postal)) return ebay.settings.postal.trim() ? "The postal code in eBay settings doesn't look right. It should be like N3T 0A1." : "Add your postal code in eBay settings.";
    if (!(packOf().grams > 0)) return "Add the parcel weight in eBay settings.";
    if (!PHOTO_KEYS.some(([k]) => L.photos[k] && photoAvailable(k))) return "Choose at least one photo.";
    return "";
  }

  function renderListing() {
    if (!EbayNative) return;
    $("ebayPanel").hidden = false;
    const st = ebay.status, L = curListing(), v = values();
    $("ebaySetBtn").hidden = !st.connected;
    $("ebayConnect").hidden = st.connected;
    $("ebayForm").hidden = !st.connected;
    $("ebayConnectBtn").hidden = !st.configured;
    $("ebayConnectNote").textContent = !st.configured
      ? "eBay isn't switched on in this copy of the app yet. It arrives in an update once the eBay developer keys are added."
      : "Connect your eBay account to list each coin straight from here, with the plate and crops as its photos.";
    // the App ID and RuName are public (they're in every eBay sign-in link); showing them makes the setup easy to check
    const showIds = !!(st.configured && !st.connected);
    $("ebayConnectErr").hidden = !showIds;
    if (showIds) {
      $("ebayErrText").hidden = !ebay.connectError;
      $("ebayErrText").textContent = ebay.connectError || "";
      $("ebayIdApp").textContent = st.clientId || "(missing)";
      $("ebayIdRu").textContent = st.ruName || "(missing)";
    }
    if (!st.connected) return;
    autoFill(L, v);
    setVal("eTitle", L.title);
    $("eTitleCount").textContent = `${L.title.length} / 80`;
    $("eTitleReset").hidden = !L.titleEdited;
    $("eTitleHint").textContent = L.titleEdited ? "Edited" : "Built from the details above";
    setVal("eExtras", L.extras == null ? Listing.defaultExtras(Listing.gradeOf(v.grade)) : L.extras);
    setVal("ePrice", L.price);
    $("eOffer").checked = L.bestOffer;
    $("eAcceptWrap").hidden = $("eDeclineWrap").hidden = !L.bestOffer;
    setVal("eAccept", L.accept);
    setVal("eDecline", L.decline);
    fillSelect("eCat", ebay.cache.cats, L.cat, ebay.cache.cats.length ? "Choose a category" : "Categories not loaded");
    fillSelect("eShip", ebay.cache.ship, L.ship, ebay.cache.ship.length ? "Choose a shipping policy" : "Policies not loaded");
    $("eStoreWrap").hidden = !ebay.cache.store.length;
    fillSelect("eStore", ebay.cache.store, L.store, "None");
    const specs = specsNow(L, v);
    specs.forEach(([name, val]) => setVal("spec-" + slug(name), val));
    $("eSpecsSum").textContent = specs.map(([, val]) => val).filter(Boolean).join(" · ");
    setVal("eDesc", L.desc);
    $("eDescReset").hidden = !L.descEdited;
    for (const [k] of PHOTO_KEYS) {
      const i = $("eph-" + k), has = photoAvailable(k);
      i.disabled = !has; i.checked = has && L.photos[k] !== false;
    }
    drawListingPhotos();
    $("eNote").textContent = L.note;
    $("eNote").className = "note" + (L.noteKind ? " " + L.noteKind : "");
    $("eDone").hidden = !L.itemId;
    $("eDoneText").textContent = L.itemId ? `Listed on eBay · item ${L.itemId}` : "";
    $("eActions").hidden = !!L.itemId;
    $("eCheck").disabled = $("ePost").disabled = ebay.busy;
    $("ePost").textContent = ebay.busy ? "Working…" : "List on eBay";
  }
  function listNote(L, text, kind) { L.note = text; L.noteKind = kind || ""; renderListing(); }

  function buildSpecInputs() {
    const box = $("eSpecs");
    for (const [name] of Listing.specificsOf({})) {
      const w = document.createElement("div"); w.className = "field";
      const id = "spec-" + slug(name);
      const l = document.createElement("label"); l.htmlFor = id; l.textContent = name;
      const i = document.createElement("input"); i.id = id; i.autocomplete = "off";
      i.addEventListener("input", () => { curListing().spec[name] = i.value; renderListing(); });
      w.append(l, i); box.appendChild(w);
    }
  }

  // photos are made up front, so moving to another coin mid-upload can't mix them up
  function jpegOf(canvas, q) { return canvas.toDataURL("image/jpeg", q || 0.92); }
  function onBackground(src) {
    const c = document.createElement("canvas"); c.width = src.width; c.height = src.height;
    const x = c.getContext("2d"); x.fillStyle = BG[look.bg].bg; x.fillRect(0, 0, c.width, c.height); x.drawImage(src, 0, 0);
    return c;
  }
  async function listingImages(L) {
    await Promise.race([fontsReady, new Promise((r) => setTimeout(r, 2500))]);
    const plateKey = ["obv", "rev", "cert"].map((k) => sides[k].ver).join(".") + look.bg + look.captions;
    const out = [];
    for (const [k] of PHOTO_KEYS) {
      if (L.photos[k] === false || !photoAvailable(k)) continue;
      const key = k === "plate" ? plateKey : isOriginal(k) ? "sq" + sides[ORIGINAL_OF[k]].photoId : String(sides[k].ver);
      if (L.uploads[k] && L.uploads[k].key === key) { out.push({ k, key, url: L.uploads[k].url }); continue; }
      let c;
      if (k === "plate") { c = document.createElement("canvas"); renderPlate(c, P.S, false); }
      else if (isOriginal(k)) c = originalCanvas(sides[ORIGINAL_OF[k]], 3000);
      else if (k === "cert") c = certCanvas(sides.cert, Math.min(1600, Math.max(400, Math.round(sides.cert.rw))));
      else c = onBackground(coinCanvas(sides[k], Math.min(1600, Math.max(400, Math.round(sides[k].r * 2)))));
      out.push({ k, key, data: jpegOf(c, isOriginal(k) ? 0.9 : 0.92) });
    }
    return out;
  }

  async function runListing(verify) {
    if (ebay.busy || !EbayNative) return;
    const L = curListing(), v = values();
    autoFill(L, v);
    const problem = listingProblem(L);
    if (problem) { listNote(L, problem, "warn"); return; }
    if (!verify && L.itemId) return;
    const g = batch.active ? batch.groups[batch.idx] : null;
    ebay.busy = true;
    listNote(L, "Preparing photos…");
    try {
      const imgs = await listingImages(L);
      const specifics = specsNow(L, v);
      const toSend = imgs.filter((x) => !x.url);
      let n = 0;
      for (const im of toSend) {
        n++;
        listNote(L, `Uploading photo ${n} of ${toSend.length}…`);
        const res = await EbayNative.uploadImage({ data: im.data, filename: `${slug(L.title).slice(0, 40) || "coin"}-${im.k}.jpg` });
        L.uploads[im.k] = { key: im.key, url: res.imageUrl };
        im.url = res.imageUrl; im.data = null;
      }
      listNote(L, verify ? "Checking with eBay…" : "Listing on eBay…");
      const xml = Listing.addItemXml({
        title: L.title, description: L.desc, categoryId: L.cat, price: priceOf(L.price),
        bestOffer: L.bestOffer, autoAccept: L.bestOffer ? priceOf(L.accept) : 0, autoDecline: L.bestOffer ? priceOf(L.decline) : 0,
        location: ebay.settings.location, postalCode: ebay.settings.postal, pack: packOf(),
        sku: [v.service, v.cert].filter(Boolean).join(" "), pictures: imgs.map((x) => x.url), specifics,
        shippingPolicy: L.ship, paymentPolicy: ebay.settings.payment, returnPolicy: ebay.settings.returns, storeCategoryId: L.store,
      }, verify);
      const send = async (body) => {
        const res = await EbayNative.request({ trading: verify ? "VerifyAddFixedPriceItem" : "AddFixedPriceItem", body });
        return { res, r: Listing.tradingResult(new DOMParser().parseFromString(res.body || "", "text/xml")) };
      };
      let { res, r } = await send(xml);
      // eBay Canada is particular about the kind of package: try the others it may want
      for (const type of ["LargeEnvelope", "PackageThickEnvelope", "ExtraLargePack"]) {
        if (r.ok || !r.errors.some((e) => /ShippingPackage/i.test(e.message))) break;
        ({ res, r } = await send(xml.replace(/(<ShippingPackage>[^<]*<\/ShippingPackage>)?<WeightMajor/, `<ShippingPackage>${type}</ShippingPackage><WeightMajor`)));
      }
      const said = (list) => list.map((e) => e.message).filter(Boolean).slice(0, 3).join(" ");
      if (!r.ok) {
        listNote(L, "eBay didn't accept it: " + (said(r.errors) || `no reason given (status ${res.status}).`), "warn");
        return;
      }
      if (verify) {
        listNote(L, `Ready to list. eBay's listing fees come to C$${r.fees.toFixed(2)}.` + (r.warnings.length ? " eBay notes: " + said(r.warnings) : ""), "ok");
      } else {
        L.itemId = r.itemId;
        if (g) g.listed = true;
        listNote(L, r.warnings.length ? "eBay notes: " + said(r.warnings) : "", "");
        toast("Listed on eBay.");
        markDirty();
      }
    } catch (e) {
      listNote(L, errText(e), "warn");
      if (e && e.code === "NOT_CONNECTED") refreshEbayStatus();
    } finally {
      ebay.busy = false;
      renderListing();
    }
  }

  async function api(path, opts) {
    const res = await EbayNative.request({ url: API + path, method: "GET", ...(opts || {}) });
    let body = null;
    try { body = JSON.parse(res.body || "null"); } catch (e) { body = null; }
    if (res.status >= 300) {
      const m = body && body.errors && body.errors[0];
      throw new Error((m && (m.longMessage || m.message)) || `eBay answered ${res.status}.`);
    }
    return body || {};
  }
  function walkStore(doc) {
    const out = [];
    const kids = (el, tag) => [...el.children].filter((c) => c.localName === tag);
    const text = (el, tag) => { const c = kids(el, tag)[0]; return c ? c.textContent.trim() : ""; };
    const visit = (el, trail) => {
      const name = text(el, "Name"), id = text(el, "CategoryID");
      const path = trail ? trail + " › " + name : name;
      const children = kids(el, "ChildCategory");
      if (id && name) out.push({ id, name, path });
      children.forEach((c) => visit(c, path));
    };
    const root = doc.getElementsByTagName("CustomCategories")[0];
    if (root) kids(root, "CustomCategory").forEach((c) => visit(c, ""));
    return out;
  }
  function flattenCats(node, trail, out) {
    if (!node) return out;
    const name = node.category && node.category.categoryName, id = node.category && node.category.categoryId;
    const kids = node.childCategoryTreeNodes || [];
    if (node.leafCategoryTreeNode || !kids.length) { if (id) out.push({ id, name, path: trail ? trail + " › " + name : name }); }
    else kids.forEach((k) => flattenCats(k, trail === null ? "" : (trail ? trail + " › " : "") + name, out));
    return out;
  }
  async function loadAccountData() {
    if (!EbayNative || !ebay.status.connected || ebay.loading) return;
    ebay.loading = true;
    ebay.loadMsg = "Loading from eBay…";
    renderSheet();
    const problems = [];
    const q = "?marketplace_id=EBAY_CA";
    await Promise.all([
      api("/sell/account/v1/fulfillment_policy" + q).then((b) => { ebay.cache.ship = (b.fulfillmentPolicies || []).map((p) => ({ id: p.fulfillmentPolicyId, name: p.name })); }).catch((e) => problems.push("shipping policies: " + errText(e))),
      api("/sell/account/v1/payment_policy" + q).then((b) => { ebay.cache.pay = (b.paymentPolicies || []).map((p) => ({ id: p.paymentPolicyId, name: p.name })); }).catch((e) => problems.push("payment policies: " + errText(e))),
      api("/sell/account/v1/return_policy" + q).then((b) => { ebay.cache.ret = (b.returnPolicies || []).map((p) => ({ id: p.returnPolicyId, name: p.name })); }).catch((e) => problems.push("return policies: " + errText(e))),
      (async () => {
        const t = await api("/commerce/taxonomy/v1/get_default_category_tree_id" + q, { app: true });
        const tree = t.categoryTreeId || "2";
        const sub = await api(`/commerce/taxonomy/v1/category_tree/${encodeURIComponent(tree)}/get_category_subtree?category_id=3377`, { app: true });
        const cats = flattenCats(sub.categorySubtreeNode, null, []);
        if (cats.length) ebay.cache.cats = cats;
      })().catch((e) => problems.push("categories: " + errText(e))),
      EbayNative.request({ trading: "GetStore", body: '<?xml version="1.0" encoding="utf-8"?><GetStoreRequest xmlns="urn:ebay:apis:eBLBaseComponents"><CategoryStructureOnly>true</CategoryStructureOnly></GetStoreRequest>' })
        .then((res) => { ebay.cache.store = walkStore(new DOMParser().parseFromString(res.body || "", "text/xml")); })
        .catch(() => { ebay.cache.store = []; }),
    ]);
    // keep the saved choice while it still exists; otherwise start from eBay's first policy
    const keep = (list, cur) => (!list.length || list.some((p) => p.id === cur) ? cur : list[0].id);
    ebay.settings.shipping = keep(ebay.cache.ship, ebay.settings.shipping);
    ebay.settings.payment = keep(ebay.cache.pay, ebay.settings.payment);
    ebay.settings.returns = keep(ebay.cache.ret, ebay.settings.returns);
    ebay.cache.at = Date.now();
    saveEbay();
    ebay.loading = false;
    ebay.loadMsg = problems.length ? "Couldn't load " + problems.join("; ") : `Loaded ${ebay.cache.ship.length} shipping, ${ebay.cache.pay.length} payment and ${ebay.cache.ret.length} return policies, and ${ebay.cache.cats.length} coin categories.`;
    renderSheet();
    renderListing();
  }

  function renderSheet() {
    if (!EbayNative) return;
    const st = ebay.status;
    $("acctName").textContent = st.connected ? (st.user ? `Connected as ${st.user}` : "Connected") : "Not connected";
    $("acctBtn").textContent = st.connected ? "Disconnect" : "Connect";
    fillSelect("sShip", ebay.cache.ship, ebay.settings.shipping, ebay.cache.ship.length ? null : "Not loaded");
    fillSelect("sPay", ebay.cache.pay, ebay.settings.payment, ebay.cache.pay.length ? null : "Not loaded");
    fillSelect("sRet", ebay.cache.ret, ebay.settings.returns, ebay.cache.ret.length ? null : "Not loaded");
    setVal("sLoc", ebay.settings.location);
    setVal("sPostal", ebay.settings.postal);
    setVal("sGrams", ebay.settings.grams);
    setVal("sSize", ebay.settings.size);
    setVal("sFoot", ebay.settings.footer);
    $("sRefresh").disabled = ebay.loading || !st.connected;
    $("sNote").textContent = ebay.loadMsg;
  }

  async function refreshEbayStatus() {
    try { ebay.status = await EbayNative.status(); } catch (e) { ebay.status = { configured: false, connected: false, user: "" }; }
    renderListing(); renderSheet();
  }
  async function connectEbay() {
    try {
      const r = await EbayNative.connect();
      ebay.connectError = "";
      ebay.status = { ...ebay.status, configured: true, connected: true, user: (r && r.user) || "" };
      toast(r && r.user ? `Connected to eBay as ${r.user}.` : "Connected to eBay.");
      renderListing(); renderSheet();
      loadAccountData();
    } catch (e) {
      if (e && e.code === "CANCELLED") return;
      ebay.connectError = errText(e);
      renderListing();
      toast(errText(e));
    }
  }

  if (EbayNative) {
    buildSpecInputs();
    buildPhotoPicker();
    $("ebayConnectBtn").addEventListener("click", connectEbay);
    $("ebaySetBtn").addEventListener("click", () => { $("ebaySheet").hidden = false; renderSheet(); });
    $("sheetClose").addEventListener("click", () => { $("ebaySheet").hidden = true; renderListing(); });
    $("ebaySheet").addEventListener("click", (e) => { if (e.target === $("ebaySheet")) { $("ebaySheet").hidden = true; renderListing(); } });
    $("acctBtn").addEventListener("click", async () => {
      if (!ebay.status.connected) { connectEbay(); return; }
      const b = $("acctBtn");
      if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Tap again to disconnect"; setTimeout(() => { delete b.dataset.armed; renderSheet(); }, 3500); return; }
      delete b.dataset.armed;
      try { await EbayNative.disconnect(); } catch (e) { /* already gone */ }
      $("ebaySheet").hidden = true;
      await refreshEbayStatus();
      toast("eBay disconnected from this phone.");
    });
    $("sRefresh").addEventListener("click", loadAccountData);
    $("sShip").addEventListener("change", (e) => { ebay.settings.shipping = e.target.value; saveEbay(); });
    $("sPay").addEventListener("change", (e) => { ebay.settings.payment = e.target.value; saveEbay(); });
    $("sRet").addEventListener("change", (e) => { ebay.settings.returns = e.target.value; saveEbay(); });
    $("sLoc").addEventListener("input", (e) => { ebay.settings.location = e.target.value; saveEbay(); });
    $("sPostal").addEventListener("input", (e) => { ebay.settings.postal = e.target.value; saveEbay(); });
    $("sGrams").addEventListener("input", (e) => { ebay.settings.grams = e.target.value; saveEbay(); });
    $("sSize").addEventListener("input", (e) => { ebay.settings.size = e.target.value; saveEbay(); });
    $("sFoot").addEventListener("input", (e) => { ebay.settings.footer = e.target.value; saveEbay(); });
    const onL = (id, ev, fn) => $(id).addEventListener(ev, (e) => { const L = curListing(); fn(L, e.target); if (!L.itemId) { L.note = ""; L.noteKind = ""; } renderListing(); });
    onL("eTitle", "input", (L, t) => { if (/[\r\n]/.test(t.value)) t.value = t.value.replace(/\s*[\r\n]+\s*/g, " "); L.title = t.value; L.titleEdited = true; });
    $("eTitle").addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
    onL("eExtras", "input", (L, t) => { L.extras = t.value; });
    onL("ePrice", "input", (L, t) => { L.price = t.value; });
    onL("eOffer", "change", (L, t) => { L.bestOffer = t.checked; });
    onL("eAccept", "input", (L, t) => { L.accept = t.value; });
    onL("eDecline", "input", (L, t) => { L.decline = t.value; });
    onL("eCat", "change", (L, t) => { L.cat = t.value; L.catEdited = true; });
    onL("eShip", "change", (L, t) => { L.ship = t.value; });
    onL("eStore", "change", (L, t) => { L.store = t.value; L.storeEdited = true; });
    onL("eDesc", "input", (L, t) => { L.desc = t.value; L.descEdited = true; });
    $("eTitleReset").addEventListener("click", () => { const L = curListing(); L.titleEdited = false; renderListing(); });
    $("eDescReset").addEventListener("click", () => { const L = curListing(); L.descEdited = false; renderListing(); });
    $("eSpecsReset").addEventListener("click", () => { curListing().spec = {}; renderListing(); });
    $("eCheck").addEventListener("click", () => runListing(true));
    $("ePost").addEventListener("click", () => runListing(false));
    $("eView").addEventListener("click", () => {
      const L = curListing();
      if (L.itemId) EbayNative.openUrl({ url: `https://www.ebay.ca/itm/${encodeURIComponent(L.itemId)}` }).catch((e) => toast(errText(e)));
    });
    refreshEbayStatus().then(() => {
      const stale = Date.now() - (ebay.cache.at || 0) > 24 * 3600 * 1000;
      if (ebay.status.connected && (stale || !ebay.cache.cats.length || !ebay.cache.ship.length)) loadAccountData();
    });
  }

  /* ---------- toast ---------- */
  let toastTimer = 0;
  function toast(text) {
    const t = $("toast");
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }

  /* ---------- wiring ---------- */
  ["obv", "rev", "cert"].forEach((key) => {
    const input = $(key + "Input"), hit = $(key + "Pick");
    input.addEventListener("change", () => {
      const f = input.files && input.files[0];
      if (f) loadPhoto(f, key);
      input.value = "";
    });
    hit.addEventListener("dragover", (e) => { e.preventDefault(); hit.classList.add("drop"); });
    hit.addEventListener("dragleave", () => hit.classList.remove("drop"));
    hit.addEventListener("drop", (e) => {
      e.preventDefault(); hit.classList.remove("drop");
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadPhoto(f, key);
    });
  });
  $("allInput").addEventListener("change", () => {
    const fl = $("allInput").files;
    if (fl && fl.length > 3) startBatch(fl);
    else if (fl && fl.length) loadMany(fl);
    $("allInput").value = "";
  });
  $("allPick").addEventListener("dragover", (e) => e.preventDefault());
  $("allPick").addEventListener("drop", (e) => {
    e.preventDefault();
    const fl = e.dataTransfer && e.dataTransfer.files;
    if (fl && fl.length > 3) startBatch(fl);
    else if (fl && fl.length) loadMany(fl);
  });
  $("swapBtn").addEventListener("click", () => {
    const t = sides.obv; sides.obv = sides.rev; sides.rev = t;
    bump(sides.obv); bump(sides.rev);
    restraighten();
  });
  document.querySelectorAll('input[name="side"]').forEach((r) => r.addEventListener("change", () => { if (r.checked) setActive(r.value); }));
  $("sizeRange").addEventListener("input", (e) => {
    const side = sides[active]; if (!side.src || !isCoin(active)) return;
    side.r = clampR(side, (Number(e.target.value) / 1000) * Math.min(side.w, side.h));
    side.manual = true; bump(side);
  });
  $("rotRange").addEventListener("input", (e) => {
    const side = sides[active]; if (!side.src) return;
    if (isCoin(active)) { side.rot = wrapDeg(Number(e.target.value)); side.rotAuto = false; }
    else { side.tilt = clamp(Number(e.target.value), -45, 45); side.manual = true; }
    bump(side);
  });
  const turn = (dir) => {
    const s = sides[active];
    if (!s.src) return;
    // a quarter turn keeps the straightening's fine angle
    if (isCoin(active)) { s.rot = Math.round(wrap180(s.rot + dir * 90) * 10) / 10; s.rotAuto = false; }
    else { s.base = ((s.base - dir * 90) % 360 + 360) % 360; const t = s.rw; s.rw = s.rh; s.rh = t; }
    bump(s);
  };
  $("rotL").addEventListener("click", () => turn(-1));
  $("rotR").addEventListener("click", () => turn(1));
  $("autoBtn").addEventListener("click", () => detectSide(active, isCoin(active) ? sides[active].prior : null));
  $("ringBtn").addEventListener("click", () => {
    const s = sides[active];
    if (s.rings.length < 2) return;
    s.ringIdx = (s.ringIdx + 1) % s.rings.length;
    Object.assign(s, s.rings[s.ringIdx]);
    bump(s);
  });
  $("readBtn").addEventListener("click", () => readCert());
  $("stopBtn").addEventListener("click", () => { if (readCtl) readCtl.abort(); });
  $("saveBtn").addEventListener("click", async () => {
    if (!batch.active) { savePlate(); return; }
    if (batch.busy) return;
    const g = batch.groups[batch.idx], result = await savePlate();
    if (!result || !batch.active || batch.groups[batch.idx] !== g) return;
    g.saved = true;
    markDirty();
    if (result === "viewer") { batch.advanceOnClose = true; return; }
    advanceAfterSave();
  });
  $("thumb").addEventListener("click", () => $("plate").scrollIntoView({ behavior: "smooth", block: "center" }));
  for (const k in FIELDS) $(FIELDS[k]).addEventListener("input", markDirty);
  // a typed date or denomination says which coin type to line the coins up against
  let typeTimer = 0;
  for (const id of ["fDate", "fDenom"]) $(id).addEventListener("input", () => { clearTimeout(typeTimer); typeTimer = setTimeout(restraighten, 500); });

  const bgInput = { black: "bgBlack", graphite: "bgGraphite", white: "bgWhite" };
  $(bgInput[look.bg]).checked = true;
  $("capChk").checked = look.captions;
  document.querySelectorAll('input[name="bg"]').forEach((r) => r.addEventListener("change", () => { if (r.checked) { look.bg = r.value; saveLook(); markDirty(); } }));
  $("capChk").addEventListener("change", (e) => { look.captions = e.target.checked; saveLook(); markDirty(); });
  window.addEventListener("resize", markDirty);
  /* ---------- version and updates (phone app only) ---------- */
  if (isNative && window.SLAB_VERSION) {
    const mine = String(window.SLAB_VERSION);
    $("appVersion").textContent = "Version " + mine;
    $("appVersion").hidden = false;
    const num = (v) => String(v).replace(/^v/, "").split(".").map((x) => parseInt(x, 10) || 0);
    const newer = (a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
    if (mine !== "dev") {
      fetch("https://api.github.com/repos/FNTC2014/Slab-Photos/releases/latest", { headers: { Accept: "application/vnd.github+json" } })
        .then((r) => (r.ok ? r.json() : null))
        .then((rel) => {
          if (!rel || !rel.tag_name || !newer(rel.tag_name, mine)) return;
          const apk = (rel.assets || []).find((a) => /\.apk$/i.test(a.name));
          $("updateTitle").textContent = `Version ${rel.tag_name.replace(/^v/, "")} is ready`;
          if (apk) $("updateLink").href = apk.browser_download_url;
          $("updateBar").hidden = false;
        })
        .catch(() => { /* offline: try again next time */ });
    }
  }
  if (isNative) {
    $("addNote").textContent = "Photos are sorted for you. PCGS and NGC coins need just a holder front and back. Labels are read on your phone, and the obverse is found from the coin's legend.";
  }

  const fontsReady = document.fonts && document.fonts.load
    ? Promise.all([
      document.fonts.load("700 50px Tinos"),
      document.fonts.load('400 40px "IBM Plex Mono"'),
      document.fonts.load('500 40px "IBM Plex Sans"'),
    ]).catch(() => null).then(() => { exampleCache.clear(); markDirty(); })
    : Promise.resolve();

  // test hook: only present when a test page asks for it before the app loads
  if (window.__slabDebug) { window.__slabDebug.state = () => ({ sides, batch }); window.__slabDebug.types = () => typeLib.map((r) => [r.side, r.denom, r.y0, r.from]); window.__slabDebug.square = (k) => originalCanvas(sides[k], 600).toDataURL("image/jpeg", 0.8); }

  render();
})();
