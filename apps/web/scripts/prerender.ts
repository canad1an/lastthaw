/**
 * Prerenders the public pages into dist after `vite build`: dist/home.html, dist/how-to-play.html and the rest, each
 * the built index.html with the page's own title, description and canonical address in the head and its rendered
 * markup in the root element. Caddy serves them for those addresses (see deploy/Caddyfile); every other address
 * still gets the plain index.html and the app renders it in the browser.
 *
 * Runs the app through Vite's server-side module loader, so aliases, JSON, CSS and import.meta.env all resolve as
 * they do in the build. No browser is needed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const indexFile = path.join(dist, "index.html");
if (!existsSync(indexFile)) throw new Error("dist/index.html is missing: run vite build first");
const shell = readFileSync(indexFile, "utf8");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ORIGIN = "https://lastthaw.com";

function page(markup: string, meta: { path: string; title: string; description: string }): string {
  const url = `${ORIGIN}${meta.path === "/" ? "/" : meta.path}`;
  let out = shell.replace(/<title>[^<]*<\/title>/, `<title>${esc(meta.title)}</title>`);
  out = out.replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${esc(meta.description)}" />`);
  out = out.replace(/<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${esc(meta.title)}" />`);
  out = out.replace(/<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${esc(meta.description)}" />`);
  const extra = [`<meta property="og:url" content="${esc(url)}" />`, `<meta name="twitter:card" content="summary" />`, `<link rel="canonical" href="${esc(url)}" />`, `<meta name="robots" content="index, follow" />`].join("\n    ");
  out = out.replace("</head>", `    ${extra}\n  </head>`);
  if (!out.includes('<div id="root"></div>')) throw new Error("index.html has no empty root element to fill");
  return out.replace('<div id="root"></div>', `<div id="root">${markup}</div>`);
}

const vite = await createServer({ root, server: { middlewareMode: true }, appType: "custom", logLevel: "warn" });
try {
  (globalThis as Record<string, unknown>).__APP_VERSION__ = process.env.VITE_APP_VERSION ?? "0.0";
  const entry = (await vite.ssrLoadModule("/src/prerender-entry.tsx")) as { PUBLIC_PAGES: ReadonlyArray<{ path: string; file: string; title: string; description: string }>; render: (p: string) => Promise<string> };
  for (const p of entry.PUBLIC_PAGES) {
    const markup = await entry.render(p.path);
    const text = markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    // Pages that are mostly live data (the hall of fame) render their frame and a loading note here; the manual and the rest carry their full text.
    if (text.length < 100) throw new Error(`${p.path} rendered almost no text (${text.length} chars)`);
    writeFileSync(path.join(dist, p.file), page(markup, p));
    console.log(`prerendered ${p.path} -> dist/${p.file} (${(markup.length / 1024).toFixed(0)} KB, ${text.length} chars of text)`);
  }
} finally {
  await vite.close();
}
