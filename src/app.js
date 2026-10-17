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

  /* ---------- capabilities ---------- */
  const cl = window.claude;
  const canUse = cl && typeof cl.use === "function";
  const samplePromise = canUse ? cl.use("sample").catch(() => null) : Promise.resolve(null);
  const downloadsPromise = canUse ? cl.use("downloads").catch(() => null) : Promise.resolve(null);
  let sampleState = "pending";
  let imageLimits = null;
  samplePromise.then(async (s) => {
    if (!s) { sampleState = "unavailable"; markDirty(); return; }
    try { const lim = await s.limits(); imageLimits = lim && lim.images ? lim.images : null; } catch (e) { imageLimits = null; }
    sampleState = imageLimits ? "ready" : "unavailable";
    markDirty();
  });

  /* ---------- state ---------- */
  let verSeq = 0, photoSeq = 0;
  const blankSide = () => ({ src: null, w: 0, h: 0, cx: 0, cy: 0, r: 0, rot: 0, rw: 0, rh: 0, base: 0, tilt: 0,
    ver: ++verSeq, photoId: 0, manual: false, found: false, busy: false, rings: [], ringIdx: 0, prior: null,
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

  function applyCoin(side, res) {
    if (res && isFinite(res.r) && res.r > 6) {
      side.rings = [{ cx: res.cx, cy: res.cy, r: res.r }].concat(res.alts || []);
      side.ringIdx = 0;
      Object.assign(side, side.rings[0]);
      side.found = true; side.manual = false; side.note = "";
    } else {
      side.found = false;
      side.note = "Couldn't find the coin's edge in this photo. Drag the ring onto the coin and size it to the rim.";
    }
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
    side.busy = false;
    if (isCoin(key)) applyCoin(side, res); else applyRect(side, res, prior);
    bump(side);
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

  // Several photos at once: work out which is the certificate, put the coins in the order
  // they were picked, then let Claude read the label and confirm which coin is the obverse.
  async function loadMany(fileList) {
    const files = [...fileList].filter((f) => !f.type || /^image\//.test(f.type));
    if (!files.length) { toast("Those files aren't photos. Choose JPGs or PNGs."); return; }
    if (files.length === 1) { loadPhoto(files[0], !sides.obv.src ? "obv" : !sides.rev.src ? "rev" : "cert"); return; }
    const use = files.slice(0, 3);
    toast(files.length > 3 ? "Using the first three photos." : `Sorting ${use.length} photos…`);
    const loaded = [];
    for (const f of use) { const s = await sideFromFile(f); if (s) loaded.push(s); }
    if (!loaded.length) { toast("Couldn't open those photos. Try JPGs or PNGs from your gallery."); return; }
    loaded.forEach((s) => { s.busy = true; });
    // show them while sorting
    const keys0 = ["obv", "rev", "cert"];
    loaded.forEach((s, i) => { sides[keys0[i]] = s; });
    markDirty();
    await tick();
    const results = [];
    for (const s of loaded) {
      const g = graysFor(s);
      results.push(await runDetect({ kind: "classify", small: g.small, big: g.big }));
    }
    let certIdx = -1;
    results.forEach((r, i) => {
      const sc = r ? r.certScore : -1;
      if (certIdx < 0 || sc > (results[certIdx] ? results[certIdx].certScore : -1)) certIdx = i;
    });
    if (loaded.length < 3 && !(results[certIdx] && results[certIdx].certScore > 0.2)) certIdx = -1;
    const coinIdx = loaded.map((_, i) => i).filter((i) => i !== certIdx);
    sides.obv = blankSide(); sides.rev = blankSide();
    if (certIdx >= 0) sides.cert = blankSide();
    coinIdx.slice(0, 2).forEach((i, n) => {
      const s = loaded[i]; s.busy = false;
      applyCoin(s, results[i] && results[i].coin);
      sides[n === 0 ? "obv" : "rev"] = s; bump(s);
    });
    if (certIdx >= 0) {
      const s = loaded[certIdx]; s.busy = false;
      applyRect(s, results[certIdx] && results[certIdx].rect, null);
      sides.cert = s; bump(s);
    }
    setActive("obv");
    $("toast").hidden = true;
    if (sides.cert.src && sampleState === "ready") readCert({ checkSides: !!(sides.obv.src && sides.rev.src) });
    else toast(certIdx >= 0 ? "Sorted. Check obverse and reverse, and tap Swap if they're the wrong way round." : "Couldn't tell which photo is the certificate. Check the tiles.");
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
      if (isCoin(active)) side.rot = wrapDeg(side.rot + dir); else side.tilt = clamp(Math.round((side.tilt + dir * 0.1) * 10) / 10, -45, 45);
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
    const hint = coin
      ? "Drag the ring to move it. Pinch or use Size to sit it on the coin's outer edge."
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

  /* ---------- reading the certificate ---------- */
  let readCtl = null, readMsgText = "", readMsgKind = "";
  function readMsg(text, kind) { readMsgText = text; readMsgKind = kind || ""; updateReadUI(); }
  function updateReadUI() {
    const btn = $("readBtn"), note = $("readNote"), reading = !!readCtl;
    btn.disabled = reading || sampleState === "unavailable" || !sides.cert.src;
    if (btn.dataset.reading !== String(reading)) {
      btn.dataset.reading = String(reading);
      btn.innerHTML = reading ? '<span class="spin" aria-hidden="true"></span>Reading the certificate…' : "Read certificate with Claude";
    }
    $("stopBtn").hidden = !reading;
    let text, kind = "";
    if (sampleState === "unavailable") text = "Certificate reading isn't available in this view. Type the details below.";
    else if (reading) text = "Claude is reading the label. This can take up to a minute.";
    else if (readMsgText) { text = readMsgText; kind = readMsgKind; }
    else if (!sides.cert.src) text = "Add the certificate photo, then Claude can read it for you.";
    else text = "Sends the certificate photo to Claude, on your own Claude account, to read the label.";
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
    let sidesNote = "";
    if (coinCtx && sides.obv === coinCtx.obv && sides.rev === coinCtx.rev) {
      const pick = Number(d.obverse_image);
      if (pick === coinCtx.b) { sides.obv = coinCtx.rev; sides.rev = coinCtx.obv; bump(sides.obv); bump(sides.rev); sidesNote = " Obverse and reverse were the wrong way round, so they've been swapped."; }
      else if (pick === coinCtx.a) sidesNote = " Obverse and reverse are in place.";
    }
    if (!filled) readMsg("Claude couldn't make out the label. Try a sharper photo, or type the details in." + sidesNote, "warn");
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
  const PARAMS = ["cx", "cy", "r", "rot", "rw", "rh", "base", "tilt", "rings", "ringIdx", "manual", "found", "note", "prior"];

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

  function groupItems(items) {
    const good = items.filter((x) => !x.bad), groups = [];
    if (!good.some((x) => x.isCert)) {
      for (let i = 0; i < good.length; i += 2) groups.push({ coins: good.slice(i, i + 2), cert: null });
    } else if (good[0].isCert) {
      // certificate shot first, then its coin
      let cur = null;
      for (const x of good) { if (x.isCert) { cur = { cert: x, coins: [] }; groups.push(cur); } else cur.coins.push(x); }
    } else {
      // coin shot first, certificate last
      let coins = [];
      for (const x of good) { if (x.isCert) { groups.push({ coins, cert: x }); coins = []; } else coins.push(x); }
      if (coins.length) groups.push({ coins, cert: null });
    }
    return groups.map((g) => ({
      ...g, saved: false, read: false, state: null, fields: null, msg: "",
      problem: !g.cert ? "No certificate photo found for this coin" : g.coins.length === 0 ? "No coin photos found for this certificate"
        : g.coins.length === 1 ? "Only one coin photo found" : g.coins.length > 2 ? `${g.coins.length} coin photos found; using the first two` : "",
    }));
  }

  async function startBatch(fileList) {
    const files = [...fileList].filter((f) => !f.type || /^image\//.test(f.type));
    if (files.length < 4) { loadMany(files); return; }
    if (readCtl) { readCtl.abort(); readCtl = null; }
    // photos sort in the order they were taken when the phone says so, otherwise as picked
    const times = new Set(files.map((f) => f.lastModified));
    const list = files.map((f, i) => ({ f, i }));
    if (times.size === files.length) list.sort((p, q) => p.f.lastModified - q.f.lastModified);
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
      items.push({ file: list[n].f, res, isCert: !!res && res.certScore > 0, thumb: thumbOf(side, res) });
      side.src = null; side.grays = null;
    }
    batch.groups = groupItems(items);
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
      obv: g.coins[0] && { file: g.coins[0].file, res: g.coins[0].res },
      rev: g.coins[1] && { file: g.coins[1].file, res: g.coins[1].res },
      cert: g.cert && { file: g.cert.file, res: g.cert.res },
    };
    for (const key of ["obv", "rev", "cert"]) {
      const it = plan[key];
      if (!it || !it.file) continue;
      const side = await sideFromFile(it.file);
      if (batch.groups[batch.idx] !== g) return;
      if (!side) continue;
      if (it.params) Object.assign(side, it.params);
      else if (key === "cert") applyRect(side, it.res && it.res.rect, null);
      else applyCoin(side, it.res && it.res.coin);
      sides[key] = side;
      bump(side);
    }
    batch.busy = false;
    batch.progress = "";
    setActive("obv");
    disarm();
    $("plate").scrollIntoView({ behavior: "smooth", block: "nearest" });
    if (!g.read && sides.cert.src && sampleState === "ready") {
      g.read = true;
      readCert({ checkSides: !!(sides.obv.src && sides.rev.src) });
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
    const key = batch.groups.map((x) => (x.saved ? "s" : "") + (x.problem ? "p" : "")).join(",") + "|" + batch.idx + "|" + batch.busy;
    if (key === batch.stripKey) return;
    batch.stripKey = key;
    const strip = $("strip");
    strip.textContent = "";
    batch.groups.forEach((x, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chipcoin" + (i === batch.idx ? " on" : "") + (x.saved ? " saved" : "") + (x.problem ? " problem" : "");
      b.setAttribute("aria-label", `Coin ${i + 1}${x.saved ? ", saved" : ""}${x.problem ? ", needs a check" : ""}`);
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
  });
  document.querySelectorAll('input[name="side"]').forEach((r) => r.addEventListener("change", () => { if (r.checked) setActive(r.value); }));
  $("sizeRange").addEventListener("input", (e) => {
    const side = sides[active]; if (!side.src || !isCoin(active)) return;
    side.r = clampR(side, (Number(e.target.value) / 1000) * Math.min(side.w, side.h));
    side.manual = true; bump(side);
  });
  $("rotRange").addEventListener("input", (e) => {
    const side = sides[active]; if (!side.src) return;
    if (isCoin(active)) side.rot = wrapDeg(Number(e.target.value));
    else { side.tilt = clamp(Number(e.target.value), -45, 45); side.manual = true; }
    bump(side);
  });
  const turn = (dir) => {
    const s = sides[active];
    if (!s.src) return;
    if (isCoin(active)) s.rot = wrapDeg(s.rot + dir * 90);
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

  const bgInput = { black: "bgBlack", graphite: "bgGraphite", white: "bgWhite" };
  $(bgInput[look.bg]).checked = true;
  $("capChk").checked = look.captions;
  document.querySelectorAll('input[name="bg"]').forEach((r) => r.addEventListener("change", () => { if (r.checked) { look.bg = r.value; saveLook(); markDirty(); } }));
  $("capChk").addEventListener("change", (e) => { look.captions = e.target.checked; saveLook(); markDirty(); });
  window.addEventListener("resize", markDirty);

  const fontsReady = document.fonts && document.fonts.load
    ? Promise.all([
      document.fonts.load("700 50px Tinos"),
      document.fonts.load('400 40px "IBM Plex Mono"'),
      document.fonts.load('500 40px "IBM Plex Sans"'),
    ]).catch(() => null).then(() => { exampleCache.clear(); markDirty(); })
    : Promise.resolve();

  render();
})();
