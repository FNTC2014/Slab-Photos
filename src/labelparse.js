// Turns the text read off a certificate (lines, top to bottom) into plate details.
// Written for on-device text recognition, which returns lines and makes predictable slips:
// O for 0, S for 5, I or l for 1, missing or extra spaces.
function labelParseModule() {
  "use strict";

  const GRADE_RE = /\b(MS|PR|PF|SP|PL|AU|EF|XF|VF|VG|AG|UNC|BU|F|G)\s*-?\s*([0-9OSIl]{1,2})(\+)?(?![0-9])/i;
  const YEAR_RE = /\b(1[5-9][0-9OSIl]{2}|20[0-9OSIl]{2})\b/;
  const fixDigits = (s) => s.replace(/[Oo]/g, "0").replace(/[Il|]/g, "1").replace(/S/g, "5");
  const norm = (s) => String(s || "").replace(/[—–]/g, "-").replace(/\s+/g, " ").trim();

  function denomOf(t) {
    let m = t.match(/[$S]\s*(\d+(?:\.\d+)?)(?![0-9])/);
    if (m && /\$/.test(m[0])) return "$" + m[1];
    m = t.match(/\b(\d{1,3})\s*(?:c|¢|cents?)\b/i);
    if (m) return m[1] + "¢";
    m = t.match(/\bS(\d{1,2})\b/); // "$1" read as "S1"
    if (m) return "$" + m[1];
    return "";
  }

  function headerOf(line) {
    // e.g. "CAN 1950 $1 MS66", "CAN 1936 Dot 1c MS-64 RD"
    // a year read with a letter in it ("I946", "195O") is put right first
    const t = norm(line).replace(/\b[0-9OSIl]{4}\b/g, (tok) => (/^(1[5-9]|20)\d\d$/.test(fixDigits(tok)) ? fixDigits(tok) : tok));
    const y = t.match(YEAR_RE);
    const g = t.match(GRADE_RE);
    if (!y || !g) return null;
    const year = fixDigits(y[1]);
    const denom = denomOf(t.slice(y.index + y[0].length, g.index));
    // anything between the year and the denomination is part of the date (mint mark, variety)
    const between = t.slice(y.index + y[0].length, g.index).replace(/[$S]?\s*\d+(?:\.\d+)?\s*(?:c|¢|cents?)?/i, " ").replace(/[^A-Za-z0-9\- ]/g, " ");
    const suffix = norm(between);
    const grade = g[1].toUpperCase() + "-" + fixDigits(g[2]) + (g[3] || "");
    const after = norm(t.slice(g.index + g[0].length));
    return { date: year + (suffix ? " " + suffix : ""), denomination: denom, grade: grade + (after ? " " + after : "") };
  }

  function certOf(line) {
    const t = norm(line).toUpperCase();
    const m = t.match(/^([A-Z]{2,4})\s*([0-9OSIL]{2,6})$/);
    if (!m) return "";
    return m[1] + " " + fixDigits(m[2].replace(/L/g, "1"));
  }

  function parseICCS(lines) {
    const L = lines.map(norm).filter(Boolean);
    const up = L.map((s) => s.toUpperCase());
    const ci = up.findIndex((s) => /COMMENTS/.test(s));
    const ni = up.findIndex((s) => /CERTIFICATION\s*N[O0]/.test(s));
    let head = null;
    for (let i = 0; i < (ci >= 0 ? ci : L.length) && !head; i++) head = headerOf(L[i]);
    const comments = ci >= 0 ? L.slice(ci + 1, ni > ci ? ni : ci + 1).filter((s) => !/ICCS|International Coin/i.test(s)).join(" ") : "";
    let cert = "";
    if (ni >= 0) {
      // the number is on the same line ("CERTIFICATION NO. XCU 758") or the next one
      const sameLine = L[ni].replace(/.*CERTIFICATION\s*NO\.?\s*-?/i, "");
      cert = certOf(sameLine) || (L[ni + 1] ? certOf(L[ni + 1]) : "");
    }
    return {
      service: "ICCS",
      date: head ? head.date : "",
      denomination: head ? head.denomination : "",
      grade: head ? head.grade : "",
      variety: comments,
      cert,
    };
  }

  // PCGS: "1906  1C" / "PCGS MS64RD" / "Canada Belzberg" / "30141.64/90035307".
  // Old green labels put PCGS on its own line and the grade alone ("PL66").
  const PCGS_GRADE_RE = /\b(MS|PR|PF|SP|PL|AU|XF|EF|VF|VG|AG|F|G)\s*-?\s*([0-9OSIl]{1,2})(\+)?\s*(DCAM|DPL|CAM|FBL|FB|FH|FT|RD|RB|BN|PL)?(★|\*)?(?![A-Za-z0-9])/i;
  const COUNTRIES = /\b(CANADA|NEWFOUNDLAND|NEW BRUNSWICK|NOVA SCOTIA|PRINCE EDWARD ISLAND|UNITED STATES|GREAT BRITAIN)\b/gi;
  function pcgsDenom(t) {
    let m = t.match(/\b(?:[SG])?\$\s*(\d+(?:\.\d+)?)/);
    if (m) return "$" + m[1];
    m = t.match(/\b(\d{1,3})\s*C\b/i);
    if (m) return m[1] + "¢";
    return "";
  }
  function parsePCGS(lines) {
    const L = lines.map(norm).filter(Boolean);
    const used = new Set();
    let date = "", denomination = "", grade = "", cert = "";
    L.forEach((s, i) => {
      const m = s.replace(/\s+/g, "").match(/(\d{3,6})[.,·](\d{1,2})\/([0-9OSIl]{6,10})/);
      if (m && !cert) { cert = fixDigits(m[3]); used.add(i); }
    });
    L.forEach((s, i) => {
      if (date || used.has(i)) return;
      const t = s.replace(/\b[0-9OSIl]{4}\b/g, (tok) => (/^(1[5-9]|20)\d\d$/.test(fixDigits(tok)) ? fixDigits(tok) : tok));
      const y = t.match(YEAR_RE);
      if (!y) return;
      date = y[1];
      const rest = t.slice(y.index + y[0].length);
      denomination = pcgsDenom(rest);
      const suffix = norm(rest.replace(/\b(?:[SG])?\$\s*\d+(?:\.\d+)?|\b\d{1,3}\s*C\b/i, " ").replace(/[^A-Za-z0-9\- ]/g, " "));
      if (suffix) date += " " + suffix;
      used.add(i);
    });
    // the denomination can come through as a line of its own ("1C", "S$1")
    if (!denomination) L.forEach((s, i) => {
      if (denomination || used.has(i)) return;
      if (/^\s*(?:[SG]?\$\s*\d+(?:\.\d+)?|\d{1,3}\s*C)\s*$/i.test(s)) { denomination = pcgsDenom(s); used.add(i); }
    });
    L.forEach((s, i) => {
      if (grade || used.has(i)) return;
      const g = s.replace(/PCGS/i, " ").match(PCGS_GRADE_RE);
      if (!g) return;
      grade = g[1].toUpperCase() + "-" + fixDigits(g[2]) + (g[3] || "") + (g[4] ? " " + g[4].toUpperCase() : "") + (g[5] ? "★" : "");
      used.add(i);
    });
    const notes = L.filter((s, i) => !used.has(i))
      .map((s) => norm(s.replace(/PCGS|PROFESSIONAL COIN GRADING SERVICE/gi, " ").replace(COUNTRIES, " ").replace(/[|!Il]{4,}/g, " ")))
      .filter((s) => s && /[A-Za-z]{2,}/.test(s));
    return { service: "PCGS", date, denomination, grade, variety: notes.join(" · "), cert };
  }

  // NGC and anything else: the same pieces in a looser layout ("1952 CANADA S$1", "MS 64",
  // "4285301-005"). Year, denomination and grade are found wherever they sit.
  function parseGeneric(lines, service) {
    const L = lines.map(norm).filter(Boolean);
    const used = new Set();
    let date = "", denomination = "", grade = "", cert = "";
    L.forEach((s, i) => {
      const m = s.replace(/\s+/g, "").match(/(\d{6,8}-\d{3})/) || (service === "NGC" && s.match(/\b(\d{7,10})\b/));
      if (m && !cert) { cert = m[1]; used.add(i); }
    });
    L.forEach((s, i) => {
      if (date || used.has(i)) return;
      const t = s.replace(/\b[0-9OSIl]{4}\b/g, (tok) => (/^(1[5-9]|20)\d\d$/.test(fixDigits(tok)) ? fixDigits(tok) : tok));
      const y = t.match(YEAR_RE);
      if (!y) return;
      date = y[1];
      const rest = t.slice(y.index + y[0].length);
      if (!denomination) denomination = pcgsDenom(rest);
      const suffix = norm(rest.replace(COUNTRIES, " ").replace(/\b(?:[SG])?\$\s*\d+(?:\.\d+)?|\b\d{1,3}\s*C\b/i, " ").replace(/[^A-Za-z0-9\- ]/g, " "));
      if (suffix && !PCGS_GRADE_RE.test(suffix)) date += " " + suffix;
      used.add(i);
    });
    if (!denomination) L.forEach((s, i) => {
      if (denomination || used.has(i)) return;
      const d = pcgsDenom(s);
      if (d && /^\s*(?:[SG]?\$\s*\d+(?:\.\d+)?|\d{1,3}\s*C)\s*$/i.test(s.replace(COUNTRIES, " "))) { denomination = d; used.add(i); }
    });
    L.forEach((s, i) => {
      if (grade || used.has(i)) return;
      const g = s.replace(/NGC|PCGS/gi, " ").match(PCGS_GRADE_RE);
      if (!g) return;
      grade = g[1].toUpperCase() + "-" + fixDigits(g[2]) + (g[3] || "") + (g[4] ? " " + g[4].toUpperCase() : "") + (g[5] ? "★" : "");
      const after = norm(s.slice(s.indexOf(g[0]) + g[0].length));
      if (after && /^[A-Z ]+$/i.test(after)) grade += " " + after.toUpperCase();
      used.add(i);
    });
    const notes = L.filter((s, i) => !used.has(i))
      .map((s) => norm(s.replace(/NGC|NUMISMATIC GUARANTY (CORPORATION|COMPANY)|PCGS/gi, " ").replace(COUNTRIES, " ").replace(/[|!Il]{4,}/g, " ")))
      .filter((s) => s && /[A-Za-z]{2,}/.test(s));
    return { service, date, denomination, grade, variety: notes.join(" · "), cert };
  }

  function detectService(lines) {
    const all = lines.join(" ").toUpperCase();
    if (/PCGS|P[CG]GS\s*[A-Z]{2}\s*\d/.test(all)) return "PCGS";
    if (/CERTIFICATION\s*NO|GENUINE ORIGINAL ITEM|ICCS/.test(all)) return "ICCS";
    if (/NGC|NUMISMATIC GUARANTY/.test(all)) return "NGC";
    return "";
  }

  function parse(lines) {
    const service = detectService(lines);
    if (service === "ICCS") return parseICCS(lines);
    if (service === "PCGS") return parsePCGS(lines);
    return parseGeneric(lines, service);
  }

  return { parse, parseICCS, parsePCGS, parseGeneric, headerOf, certOf, detectService };
}

if (typeof module !== "undefined") module.exports = labelParseModule;
