// Looks up a coin's Trends value in a Trends file (made from Canadian Coin News Trends, loaded on
// the phone; the values themselves are never part of this code). Strict on purpose: the
// denomination's own section first, then the date, then the plain date row unless the coin
// names a variety, and only an exact variety match. When anything is unclear it says why and
// gives no value rather than guess.
function trendsModule() {
  "use strict";
  const ALIAS = {
    lg: ["large"], lge: ["large"], large: ["large"], sm: ["small"], small: ["small"],
    lb: ["large", "beads"], sb: ["small", "beads"], bds: ["beads"], bead: ["beads"], beads: ["beads"],
    pt: ["pointed"], ptd: ["pointed"], pointed: ["pointed"], point: ["pointed"], bl: ["blunt"], blunt: ["blunt"],
    p7: ["pointed", "7"], b7: ["blunt", "7"], ml: ["maple", "leaf"], leaf: ["leaf"], maple: ["maple"],
    dbl: ["double"], double: ["double"], doubled: ["double"], dd: ["double", "die"], die: ["die"],
    obverse: ["obv"], "obv.": ["obv"], reverse: ["rev"], nar: ["narrow"], narrow: ["narrow"], wd: ["wide"], wide: ["wide"],
    dt: ["date"], lvs: ["leaves"], leaves: ["leaves"], ovr: ["over"], over: ["over"], hp: ["hp"], arn: ["arnprior"], arnprior: ["arnprior"],
  };
  const STOP = new Set(["variety", "var", "of", "the", "and", "a", "an", "with", "coin", "coins"]);
  function tokens(s) {
    const out = [];
    for (const raw of String(s || "").toLowerCase().replace(/[‘’'"()]/g, "").split(/[\s,;/\\&+.-]+/)) {
      if (!raw || STOP.has(raw)) continue;
      for (const t of ALIAS[raw] || [raw]) out.push(t);
    }
    return out.sort();
  }
  const same = (a, b) => a.length === b.length && a.every((t, i) => t === b[i]);
  // "1871H Obv 2" → { year: "1871", mint: "H", rest: "Obv 2" }; only H and C are Canadian mint marks
  function rowKey(label) {
    const m = String(label).match(/^(\d{4})(?:([HC])(?![A-Za-z]))?\s*,?\s*(.*)$/);
    return m ? { year: m[1], mint: m[2] || "", rest: m[3].trim() } : null;
  }
  const COLOR = { R: "R", RD: "R", RED: "R", RB: "RB", BR: "BR", BN: "BR", BROWN: "BR" };
  const GRADE_RE = /\b(MS|SP|PL|PR|PF|AU|XF|EF|VF|VG|AG|G|F)\s*-?\s*(\d{1,2})\+?\s*(RD|RB|BN|BR|RED|BROWN|R)?\b/i;
  const money = (v) => (v === "BV" || v === "FV" ? v : "$" + Number(v).toLocaleString("en-CA", { maximumFractionDigits: 2 }));

  // coin: { denom: "0100c", year: "1966", mint: "", variety: "Large Beads", grade: "MS-65" }
  function lookup(data, coin) {
    if (!data || !Array.isArray(data.sections)) return { reason: "No Trends file loaded." };
    const year = String(coin.year || "");
    if (!coin.denom || !year) return { reason: "Needs the date and denomination." };
    const gm = String(coin.grade || "").toUpperCase().match(GRADE_RE);
    if (!gm) return { reason: "Needs the grade." };
    const prefix = gm[1] === "XF" ? "EF" : gm[1], grade = `${prefix}-${gm[2]}`, color = gm[3] ? COLOR[gm[3]] : "";
    const want = tokens(coin.variety), mint = String(coin.mint || "").toUpperCase();
    const denoms = Number(year) >= 1968 && coin.denom === "0100c" ? ["0100c-nickel", "0100c"] : [coin.denom];
    const hits = [], dateRows = [], wider = [];
    for (const s of data.sections) {
      if (!denoms.includes(s.d)) continue;
      for (const [label, vals] of s.r) {
        const k = rowKey(label);
        if (!k || k.year !== year || k.mint !== mint) continue;
        dateRows.push(label);
        const have = tokens(k.rest);
        if (same(have, want)) hits.push({ s, label, vals });
        else if (want.length && want.every((t) => have.includes(t))) wider.push({ s, label, vals });
      }
    }
    const what = `${year}${mint}${coin.variety ? " " + coin.variety : ""}`;
    if (!dateRows.length) return { reason: `No ${what} in this Trends file.` };
    // the coin names a variety that Trends splits further ("Maple Leaf" → ML 2XHP, ML single HP):
    // fine only when every one of those rows gives the same value for this grade
    let sub = false;
    if (!hits.length && wider.length) {
      const vs = wider.map((h) => { const i = h.s.c.findIndex((c) => c.split(" ")[0] === grade); return i < 0 ? null : h.vals[i]; });
      if (vs.every((v) => v && v === vs[0])) { hits.push(...wider); sub = true; }
    }
    if (!hits.length) {
      return { reason: want.length ? `Trends has no row for "${coin.variety}" (rows for ${year}: ${dateRows.map((l) => l.replace(/^\d{4}\s*,?\s*/, "") || "plain").join(", ")}).`
        : `Trends lists ${year} by variety only (${dateRows.map((l) => l.replace(/^\d{4}\s*,?\s*/, "")).join(", ")}). Add the variety to the details.` };
    }
    const results = [];
    for (const h of hits) {
      const i = h.s.c.findIndex((c) => c.split(" ")[0] === grade);
      if (i < 0) { results.push({ reason: `Trends has no ${grade} column for ${h.label} (it lists ${h.s.c.join(", ")}).` }); continue; }
      const colColor = h.s.c[i].split(" ")[1] || "";
      if (colColor && colColor !== color) {
        results.push({ reason: `Trends lists ${h.s.c[i]} for ${h.label}; the grade${color ? " is " + gm[3].toUpperCase() : " has no colour"}.` });
        continue;
      }
      const v = h.vals[i];
      if (!v) { results.push({ reason: `No ${grade} value listed for ${h.label}.` }); continue; }
      results.push({ value: v, text: money(v), row: h.label, col: h.s.c[i], series: h.s.s });
    }
    const vals = results.filter((r) => r.value);
    if (!vals.length) return results[0];
    if (vals.some((r) => r.value !== vals[0].value)) return { reason: `More than one ${what} row matches (${vals.map((r) => r.row).join("; ")}).` };
    return { ...vals[0], row: sub || vals.length > 1 ? vals.map((r) => r.row).join(" / ") + " (same value)" : vals[0].row, issue: data.issue || "" };
  }
  function valid(data) {
    return !!(data && data.kind === "slabplates-trends" && Array.isArray(data.sections) && data.sections.every((s) => s.d && Array.isArray(s.c) && Array.isArray(s.r)));
  }
  return { lookup, valid, tokens };
}

if (typeof module !== "undefined") module.exports = trendsModule;
