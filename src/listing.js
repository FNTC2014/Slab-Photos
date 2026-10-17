// eBay listing helpers: title, item specifics, description and the Trading API request,
// written to match how Far North Trading Co. lists graded Canadian coins on eBay.ca.
// Pure functions only, so they can be checked without a phone.
function listingModule() {
  "use strict";

  const SILVER_WORDS = { 1: "Cent", 5: "5 Cents", 10: "Dime", 20: "20 Cents", 25: "Quarter", 50: "50 Cents", 100: "Dollar", 200: "Toonie" };
  const UNC = /^(MS|SP|PL|PR|PF|UNC|BU)$/;

  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

  // "$1" → 100, "10¢" / "10c" / "10 cents" → 10, "50 C" → 50
  function centsOf(denom) {
    const t = clean(denom).toLowerCase();
    if (!t) return null;
    const num = t.match(/\d+(?:\.\d+)?/);
    const v = num ? Number(num[0]) : /half/.test(t) ? 0.5 : null;
    if (v == null) return /dollar|loonie/.test(t) ? 100 : /toonie/.test(t) ? 200 : null;
    if (/\$|dollar/.test(t) && !/¢|cent|\dc\b|\d\s*c\b/.test(t)) return Math.round(v * 100);
    return Math.round(v);
  }

  // "MS-64 RD", "MS66", "PCGS MS64RD", "AU-55+" → parts
  function gradeOf(grade) {
    const g = clean(grade).toUpperCase().replace(/\b(PCGS|NGC|ICCS|ANACS|CCCS|CGS)\b/g, " ").trim();
    const m = g.match(/\b(MS|SP|PL|PR|PF|AU|XF|EF|VF|VG|AG|FR|PO|G|F|P)\s*-?\s*(\d{1,2})(\+)?\s*([A-Z★*]{0,5}(?:\s+[A-Z]{2,5})?)?/);
    if (!m) return { prefix: "", num: "", plus: "", extra: "", compact: clean(grade), specific: clean(grade) };
    const extra = clean((m[4] || "").replace(/\*/g, "★"));
    return {
      prefix: m[1], num: m[2], plus: m[3] || "", extra,
      compact: m[1] + m[2] + (m[3] || "") + (extra ? extra.replace(/\s+/g, "") : ""),
      specific: m[1] + " " + m[2],
    };
  }

  function dateOf(date) {
    const t = clean(date);
    const m = t.match(/\b(1[5-9]\d\d|20\d\d)\b/);
    if (!m) return { year: "", suffix: t };
    return { year: m[1], suffix: clean(t.replace(m[0], " ")) };
  }

  // What the coin is: metal, fineness and the word buyers search for. Canadian rules of thumb;
  // every value lands in an editable field, so an odd year is easy to correct.
  function coinInfo(year, cents) {
    const y = Number(year) || 0;
    const info = { type: "", metal: "", composition: "", fineness: "", denomTitle: "", denomSpecific: "" };
    if (cents == null) return info;
    info.denomTitle = cents >= 100 && cents % 100 === 0 ? "$" + cents / 100 : cents + "c";
    info.denomSpecific = cents >= 100 && cents % 100 === 0 ? "$" + cents / 100 : cents + "C";
    const silver = (fine) => { info.metal = "Silver"; info.composition = "Silver"; info.fineness = fine; };
    if (cents === 1) {
      info.type = "Cent";
      info.composition = y && y >= 1997 ? "Copper Plated" : "Copper";
    } else if (cents === 5) {
      if (y && y <= 1921) { silver(y >= 1920 ? "0.8" : "0.925"); info.type = "5 Cents"; }
      else { info.type = "Nickel"; info.composition = y >= 1942 && y <= 1943 ? "Tombac" : (y >= 1944 && y <= 1945) || (y >= 1951 && y <= 1954) || y >= 2000 ? "Steel" : "Nickel"; }
    } else if ([10, 20, 25, 50].includes(cents)) {
      if (!y || y <= 1968) silver(!y ? "" : y <= 1919 ? "0.925" : y === 1968 ? "0.5" : "0.8");
      else info.composition = y >= 2000 ? "Steel" : "Nickel";
      info.type = SILVER_WORDS[cents];
    } else if (cents === 100) {
      if (!y || (y >= 1935 && y <= 1967)) silver(y ? "0.8" : "");
      else info.composition = y >= 1987 ? "Nickel Bronze" : "Nickel";
      info.type = y >= 1987 && !info.metal ? "Loonie" : "Dollar";
    } else if (cents === 200) {
      info.type = "Toonie";
      info.composition = "Bimetallic";
    } else {
      info.type = info.denomTitle;
    }
    return info;
  }

  // ICCS prints comments in capitals; titles read better in title case, keeping short codes (HP, SWL, NWL).
  function tidyVariety(s) {
    let t = clean(s).replace(/^[\s*"]+|[\s*"]+$/g, "");
    if (t && t === t.toUpperCase() && /[A-Z]{4,}/.test(t)) {
      t = t.toLowerCase().replace(/\b([a-z])([a-z]*)/g, (w, a, b) => {
        if (/^(of|and|the|on|in|to|with|at)$/.test(w)) return w;
        return w.length <= 3 && !/^(dot|map|ext|rev|obv|top|pop|lot)$/.test(w) ? w.toUpperCase() : a.toUpperCase() + b;
      });
    }
    return t;
  }

  // The variety part of a title: the date's extra words ("Dot", "Maple Leaf") and the first comment.
  function varietyOf(v) {
    const d = dateOf(v.date);
    const notes = clean(v.notes);
    const first = notes.length <= 28 ? notes : notes.split(/\s*(?:[;·|\n]|,\s(?=[A-Z]))\s*/)[0] || "";
    const parts = [d.suffix, first].map(tidyVariety).filter(Boolean);
    const seen = new Set();
    return parts.filter((p) => { const k = p.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).join(" ");
  }

  function defaultExtras(g) {
    if (g.prefix === "SP") return "Specimen";
    if (g.prefix === "PL") return "Proof Like";
    if (g.prefix === "PR" || g.prefix === "PF") return "Proof";
    if (g.prefix === "MS") return "Uncirculated";
    return g.prefix ? "Circulated" : "";
  }

  // "1950 $1 *Island Logs* ICCS MS66 Canada Silver Dollar Uncirculated", at most 80 characters.
  function buildTitle(v, extras) {
    if (![v.date, v.denom, v.grade, v.service].some((x) => clean(x))) return "";
    const d = dateOf(v.date), g = gradeOf(v.grade), info = coinInfo(d.year, centsOf(v.denom));
    const variety = varietyOf(v);
    const head = [d.year, info.denomTitle || clean(v.denom), variety ? `*${variety}*` : "", clean(v.service).toUpperCase(), g.compact, "Canada", info.metal, info.type]
      .filter(Boolean).join(" ");
    let title = head;
    const more = clean(extras == null ? defaultExtras(g) : extras).split(" ").filter(Boolean);
    for (const w of more) { if ((title + " " + w).length > 80) break; title += " " + w; }
    if (title.length > 80) title = title.slice(0, 80).replace(/\s+\S*$/, "");
    return title;
  }

  // Item specifics in the order the store uses.
  function specificsOf(v) {
    const d = dateOf(v.date), g = gradeOf(v.grade), info = coinInfo(d.year, centsOf(v.denom));
    const notes = clean(v.notes);
    return [
      ["Circulated/Uncirculated", g.prefix ? (UNC.test(g.prefix) ? "Uncirculated" : "Circulated") : ""],
      ["Denomination", info.denomSpecific || clean(v.denom)],
      ["Composition", info.composition],
      ["Year", d.year],
      ["Fineness", info.fineness],
      ["Grade", g.specific],
      ["Variety", tidyVariety([d.suffix, notes].filter(Boolean).join(" ")).slice(0, 65)],
      ["Certification", clean(v.service).toUpperCase()],
      ["Country of Origin", "Canada"],
    ];
  }

  const DEFAULT_FOOTER = "Great coin for any collection.\n\nShips tracked to Canada and USA.\nSales taxes are collected by eBay.\nInternational buyers are responsible for any duties, customs fees, or tariffs that may be due upon delivery.";

  // Plain paragraphs, like the store's own descriptions.
  function buildDescription(v, footer) {
    if (![v.date, v.denom, v.grade, v.service, v.cert, v.notes].some((x) => clean(x))) return "";
    const d = dateOf(v.date), g = gradeOf(v.grade), info = coinInfo(d.year, centsOf(v.denom));
    const service = clean(v.service).toUpperCase();
    const coin = [d.year, d.suffix, "Canada", info.metal, info.type || clean(v.denom)].filter(Boolean).join(" ");
    const lines = [[coin, service ? service + " Graded" : "", g.compact].filter(Boolean).join(" ")];
    const variety = tidyVariety(clean(v.notes));
    if (variety) lines.push(`Noted on the ${service || "certificate"} label: ${variety.replace(/[.\s]+$/, "")}.`);
    if (clean(v.cert)) lines.push(`${service ? service + " certificate" : "Certificate"} number ${clean(v.cert)}.`);
    const foot = clean(footer == null ? DEFAULT_FOOTER : footer) ? String(footer == null ? DEFAULT_FOOTER : footer).trim() : "";
    return lines.join("\n\n") + (foot ? "\n\n" + foot : "");
  }

  const escXml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  function descriptionHtml(text) {
    return String(text || "").trim().split(/\n{2,}/).map((p) =>
      "<p>" + escXml(p.trim()).replace(/\n/g, "<br>") + "</p>").join("\n");
  }
  const money = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);

  // Canadian postal codes as eBay wants them: "A1A 1A1". Anything else comes back blank.
  function postal(s) {
    const t = String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    return /^[ABCEGHJ-NPRSTVXY]\d[A-Z]\d[A-Z]\d$/.test(t) ? t.slice(0, 3) + " " + t.slice(3) : "";
  }
  // Weight and size of the parcel, which calculated shipping (Canada Post rates) needs.
  // pack: { grams, l, w, h } in grams and centimetres.
  function packageXml(pack) {
    if (!pack || !(Number(pack.grams) > 0)) return "";
    const g = Math.round(Number(pack.grams)), cm = (v) => Math.max(1, Math.round(Number(v) || 1));
    return "<ShippingPackageDetails><MeasurementUnit>Metric</MeasurementUnit>" +
      `<PackageDepth unit="cm">${cm(pack.h)}</PackageDepth><PackageLength unit="cm">${cm(pack.l)}</PackageLength><PackageWidth unit="cm">${cm(pack.w)}</PackageWidth>` +
      "<ShippingPackage>PackageThickEnvelope</ShippingPackage>" +
      `<WeightMajor unit="kg">${Math.floor(g / 1000)}</WeightMajor><WeightMinor unit="gr">${g % 1000}</WeightMinor>` +
      "</ShippingPackageDetails>";
  }

  // AddFixedPriceItem / VerifyAddFixedPriceItem on eBay Canada. Listings made this way behave like
  // ones made in Seller Hub, so they can be edited there or in the eBay app afterwards.
  function addItemXml(L, verify) {
    const call = verify ? "VerifyAddFixedPriceItem" : "AddFixedPriceItem";
    const tag = (name, val) => (val === "" || val == null ? "" : `<${name}>${escXml(val)}</${name}>`);
    const specifics = (L.specifics || []).filter(([n, val]) => clean(n) && clean(val))
      .map(([n, val]) => `<NameValueList><Name>${escXml(clean(n))}</Name><Value>${escXml(clean(val))}</Value></NameValueList>`).join("");
    const offer = L.bestOffer
      ? "<BestOfferDetails><BestOfferEnabled>true</BestOfferEnabled></BestOfferDetails>" +
        ((Number(L.autoAccept) > 0 || Number(L.autoDecline) > 0)
          ? "<ListingDetails>" +
            (Number(L.autoAccept) > 0 ? `<BestOfferAutoAcceptPrice currencyID="CAD">${money(L.autoAccept)}</BestOfferAutoAcceptPrice>` : "") +
            (Number(L.autoDecline) > 0 ? `<MinimumBestOfferPrice currencyID="CAD">${money(L.autoDecline)}</MinimumBestOfferPrice>` : "") +
            "</ListingDetails>"
          : "")
      : "";
    const desc = descriptionHtml(L.description).replace(/]]>/g, "]]&gt;");
    return '<?xml version="1.0" encoding="utf-8"?>' +
      `<${call}Request xmlns="urn:ebay:apis:eBLBaseComponents">` +
      "<ErrorLanguage>en_US</ErrorLanguage><WarningLevel>High</WarningLevel>" +
      "<Item>" +
      tag("Title", clean(L.title).slice(0, 80)) +
      `<Description><![CDATA[${desc}]]></Description>` +
      `<PrimaryCategory><CategoryID>${escXml(L.categoryId)}</CategoryID></PrimaryCategory>` +
      `<StartPrice currencyID="CAD">${money(L.price)}</StartPrice>` +
      offer +
      "<Country>CA</Country><Currency>CAD</Currency>" +
      tag("Location", clean(L.location)) +
      tag("PostalCode", postal(L.postalCode)) +
      "<ListingDuration>GTC</ListingDuration><ListingType>FixedPriceItem</ListingType><Quantity>1</Quantity>" +
      tag("SKU", clean(L.sku).slice(0, 50)) +
      ((L.pictures || []).length ? "<PictureDetails>" + L.pictures.map((u) => tag("PictureURL", u)).join("") + "</PictureDetails>" : "") +
      (specifics ? `<ItemSpecifics>${specifics}</ItemSpecifics>` : "") +
      packageXml(L.pack) +
      "<SellerProfiles>" +
      `<SellerShippingProfile><ShippingProfileID>${escXml(L.shippingPolicy)}</ShippingProfileID></SellerShippingProfile>` +
      `<SellerReturnProfile><ReturnProfileID>${escXml(L.returnPolicy)}</ReturnProfileID></SellerReturnProfile>` +
      `<SellerPaymentProfile><PaymentProfileID>${escXml(L.paymentPolicy)}</PaymentProfileID></SellerPaymentProfile>` +
      "</SellerProfiles>" +
      (L.storeCategoryId ? `<Storefront><StoreCategoryID>${escXml(L.storeCategoryId)}</StoreCategoryID></Storefront>` : "") +
      "<Site>Canada</Site>" +
      "</Item>" +
      `</${call}Request>`;
  }

  // Reads a Trading API reply. Works with any XML parser that has getElementsByTagName.
  function tradingResult(doc) {
    const one = (el, name) => { const n = el.getElementsByTagName(name)[0]; return n ? n.textContent.trim() : ""; };
    const ack = one(doc, "Ack");
    const errors = [...doc.getElementsByTagName("Errors")].map((e) => ({
      severity: one(e, "SeverityCode"), code: one(e, "ErrorCode"),
      message: one(e, "LongMessage") || one(e, "ShortMessage"),
    }));
    let fees = 0;
    for (const f of doc.getElementsByTagName("Fee")) {
      const name = one(f, "Name"), amount = Number(one(f, "Fee")) || 0;
      if (name !== "ListingFee" && amount) fees += amount;
    }
    return {
      ok: ack === "Success" || ack === "Warning",
      ack, itemId: one(doc, "ItemID"), fees: Math.round(fees * 100) / 100,
      errors: errors.filter((e) => e.severity === "Error"), warnings: errors.filter((e) => e.severity === "Warning"),
    };
  }

  // Which "Coins: Canada" subcategory a denomination belongs in, by the category's name.
  function categoryFor(cents, cats) {
    const want = {
      1: /^(cents?|one cent|small cents?|large cents?)$/i,
      5: /^(five cents|5 cents|nickels?)$/i,
      10: /^(ten cents|10 cents|dimes?)$/i,
      20: /^(twenty cents|20 cents)$/i,
      25: /^(twenty[- ]five cents|25 cents|quarters?)$/i,
      50: /^(fifty cents|50 cents|half dollars?)$/i,
      100: /^(dollars?|one dollar|\$1)$/i,
      200: /^(two dollars?|\$2|toonies?)$/i,
    }[cents];
    const list = cats || [];
    const hit = want && list.find((c) => want.test(clean(c.name)));
    if (hit) return hit.id;
    const loose = want && list.find((c) => want.source.includes(clean(c.name).toLowerCase().split(" ")[0]));
    return loose ? loose.id : "";
  }

  // Store category: the one named for the grading service, then "Graded", then Coins: Canada.
  function storeCategoryFor(service, cats) {
    const s = clean(service).toUpperCase(), list = cats || [];
    const by = (re) => list.find((c) => re.test(c.name));
    const hit = (s && by(new RegExp("\\b" + s + "\\b", "i"))) || by(/graded/i) || by(/canad/i);
    return hit ? hit.id : "";
  }

  return {
    centsOf, gradeOf, dateOf, coinInfo, tidyVariety, varietyOf, defaultExtras, buildTitle, specificsOf,
    buildDescription, descriptionHtml, addItemXml, postal, tradingResult, categoryFor, storeCategoryFor, DEFAULT_FOOTER,
  };
}

if (typeof module !== "undefined") module.exports = listingModule;
