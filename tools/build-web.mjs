// Builds the page twice from src/:
//   www/index.html        the Android app (fonts bundled, works offline)
//   dist/slab-plates.html the claude.ai artifact version (fonts from Google Fonts)
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (f) => readFileSync(join(root, "src", f), "utf8");
const strip = (js) => js.replace(/\nif \(typeof module !== "undefined"\) module\.exports = \w+;\n?/, "\n");

const css = src("style.css");
const body = src("body.html");
const scripts = [strip(src("detect.js")), strip(src("labelparse.js")), src("app.js")]
  .map((js) => `<script>\n${js}</script>`).join("\n");
// The app also needs Capacitor's small runtime to talk to the phone (on-device reading, saving).
const capacitorRuntime = readFileSync(join(root, "node_modules", "@capacitor", "core", "dist", "capacitor.js"), "utf8")
  .replace(/\n\/\/# sourceMappingURL=.*$/m, "");

// --- app: bundle the fonts ---
const fonts = [
  ["tinos", "tinos-latin-700-normal.woff2", "Tinos", 700, "normal"],
  ["ibm-plex-sans", "ibm-plex-sans-latin-400-normal.woff2", "IBM Plex Sans", 400, "normal"],
  ["ibm-plex-sans", "ibm-plex-sans-latin-500-normal.woff2", "IBM Plex Sans", 500, "normal"],
  ["ibm-plex-sans", "ibm-plex-sans-latin-600-normal.woff2", "IBM Plex Sans", 600, "normal"],
  ["ibm-plex-sans", "ibm-plex-sans-latin-400-italic.woff2", "IBM Plex Sans", 400, "italic"],
  ["ibm-plex-mono", "ibm-plex-mono-latin-400-normal.woff2", "IBM Plex Mono", 400, "normal"],
  ["ibm-plex-mono", "ibm-plex-mono-latin-500-normal.woff2", "IBM Plex Mono", 500, "normal"],
  ["cinzel", "cinzel-latin-600-normal.woff2", "Cinzel", 600, "normal"],
];
mkdirSync(join(root, "www", "fonts"), { recursive: true });
const faces = fonts.map(([pkg, file, family, weight, style]) => {
  copyFileSync(join(root, "node_modules", "@fontsource", pkg, "files", file), join(root, "www", "fonts", file));
  return `@font-face{font-family:"${family}";font-style:${style};font-weight:${weight};font-display:swap;src:url(fonts/${file}) format("woff2")}`;
}).join("\n");

const reset = ':root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}' +
  'body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}';

const appHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Slab Plates</title>
<style>${reset}</style>
<style>
${faces}
</style>
<style>
${css}</style>
</head><body>
${body}
<script>
${capacitorRuntime}</script>
${scripts}
</body></html>
`;
writeFileSync(join(root, "www", "index.html"), appHtml);

// --- artifact: page content only; the artifact host adds the document skeleton ---
const artifactHtml = `<title>Slab Plates</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=Tinos:wght@700&display=swap">
<style>
${css}</style>
${body}
${scripts}
`;
mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist", "slab-plates.html"), artifactHtml);
console.log(`built www/index.html (${appHtml.length} bytes) and dist/slab-plates.html (${artifactHtml.length} bytes)`);
