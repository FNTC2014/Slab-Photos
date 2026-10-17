# Download 640px versions of the listed Commons files, with their licence and author for credit.
import json, sys, time, urllib.parse, urllib.request, os
API = "https://commons.wikimedia.org/w/api.php"
UA = "SlabPlatesRefs/1.0 (personal coin photo app; https://github.com/FNTC2014/Slab-Photos)"
def fetch(url, binary=False):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for i in range(4):
        try:
            with urllib.request.urlopen(req, timeout=90) as r: return r.read() if binary else json.load(r)
        except Exception as e:
            err = e; time.sleep(3 + 5 * i)
    raise err
files = [f for f in json.load(open("out/commons-list.json"))["files"] if not f.lower().endswith((".pdf", ".svg", ".tif", ".tiff", ".djvu", ".webm", ".ogv"))]
os.makedirs("img", exist_ok=True)
manifest = []
for i in range(0, len(files), 40):
    batch = files[i:i + 40]
    q = {"action": "query", "titles": "|".join(batch), "prop": "imageinfo", "iiprop": "url|extmetadata|size", "iiurlwidth": "640", "format": "json", "formatversion": "2"}
    d = fetch(API + "?" + urllib.parse.urlencode(q))
    for p in d["query"]["pages"]:
        if "imageinfo" not in p: continue
        ii = p["imageinfo"][0]; md = ii.get("extmetadata", {})
        n = len(manifest); name = f"{n:03d}.jpg"
        try:
            data = fetch(ii.get("thumburl") or ii["url"], True)
            open("img/" + name, "wb").write(data)
        except Exception as e:
            print("fail", p["title"], e, file=sys.stderr); continue
        manifest.append({"file": name, "title": p["title"], "w": ii.get("width"), "h": ii.get("height"),
                         "license": md.get("LicenseShortName", {}).get("value", ""), "artist": md.get("Artist", {}).get("value", "")[:200]})
        time.sleep(0.3)
json.dump(manifest, open("img/manifest.json", "w"), indent=0)
print(len(manifest), "downloaded")
