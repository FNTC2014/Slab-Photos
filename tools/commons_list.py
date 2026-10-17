# List coin photos of Canada on Wikimedia Commons (category crawl), for picking upright references.
import json, sys, time, urllib.parse, urllib.request
API = "https://commons.wikimedia.org/w/api.php"
UA = "SlabPlatesRefs/1.0 (personal coin photo app; https://github.com/FNTC2014/Slab-Photos)"
def get(params):
    params = {**params, "format": "json", "formatversion": "2"}
    req = urllib.request.Request(API + "?" + urllib.parse.urlencode(params), headers={"User-Agent": UA})
    for i in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r: return json.load(r)
        except Exception as e:
            time.sleep(2 + 3 * i); err = e
    raise err
def members(cat, kind):
    out, cont = [], {}
    while True:
        d = get({"action": "query", "list": "categorymembers", "cmtitle": cat, "cmtype": kind, "cmlimit": "500", **cont})
        out += [m["title"] for m in d["query"]["categorymembers"]]
        if "continue" not in d: return out
        cont = d["continue"]
roots = sys.argv[1:] or ["Category:Coins of Canada"]
seen, files, queue = set(), {}, [(r, 0) for r in roots]
MAXD = 4
while queue:
    cat, depth = queue.pop(0)
    if cat in seen: continue
    seen.add(cat)
    try:
        for f in members(cat, "file"): files.setdefault(f, []).append(cat)
        if depth < MAXD:
            for c in members(cat, "subcat"):
                low = c.lower()
                # stay on Canadian coins; skip modern-only, banknotes, tokens and the like
                if any(w in low for w in ["banknote", "token", "medal", "stamp", "people", "logo", "maple leaf (bullion", "bullion"]): continue
                queue.append((c, depth + 1))
    except Exception as e:
        print("skip", cat, e, file=sys.stderr)
    time.sleep(0.2)
json.dump({"cats": sorted(seen), "files": files}, open("out/commons-list.json", "w"), indent=0)
print(len(seen), "categories", len(files), "files")
