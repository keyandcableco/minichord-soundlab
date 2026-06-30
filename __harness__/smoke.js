/* Headless boot smoke test for the whole app.
 *
 * Serves the repo over a throwaway local HTTP server, loads index.html in
 * headless Chrome, walks the three views and asserts the load-bearing DOM:
 * the Play grid + harp, painted graph canvases, the About cards, zero page
 * errors and no leaked "undefined" text. Zero dependencies.
 *
 * Usage:  node smoke.js            (from __harness__/, or anywhere)
 *         CHROME="path/to/chrome" node smoke.js   to override the browser
 */
"use strict";
const http = require("http");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const ROOT = path.join(__dirname, "..");
const CHROME = process.env.CHROME || [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find(p => fs.existsSync(p));

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2" };

// the driver page: loads the app in an iframe (same origin), dismisses the
// first-run welcome, walks the views and prints one RESULT json line
const DRIVER = `<!doctype html><html><body>
<iframe src="/index.html#customize/chord/chord_osc" style="width:1480px;height:900px"></iframe>
<div id="out">PENDING</div>
<script>
// load directly at a graph tab (canvases paint during the initial render —
// post-hashchange redraws don't reliably produce frames under --dump-dom),
// then walk to Play and About with clicks like a user would.
const f = document.querySelector("iframe");
f.onload = () => setTimeout(() => {
  const w = f.contentWindow, d = f.contentDocument, out = { errors: [] };
  w.addEventListener("error", e => out.errors.push(String(e.message)));
  try {
    const ov = d.querySelector(".welcome-overlay");
    if (ov) {
      Array.from(ov.querySelectorAll(".seg-btn")).find(b => b.textContent === "Beginner").click();
      ov.querySelector(".welcome-go").click();
    }
    const canv = Array.from(d.querySelectorAll("canvas")).filter(c => c.clientWidth > 0);
    out.canvases = canv.length;
    out.painted = canv.some(c => {
      try {
        const px = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < px.length; i += 4) if (px[i] !== 0) return true;
      } catch (e) { /* tainted canvas can't happen same-origin; be safe */ }
      return false;
    });
    d.querySelector('#view-switch .view-btn[data-view="play"]').click();
    out.playGrid = d.querySelectorAll(".dm-chord").length;            // 21 chord pads
    out.harpStrings = d.querySelectorAll(".dm-string").length;        // 12 strings
    d.querySelector('#view-switch .view-btn[data-view="about"]').click();
    out.aboutCards = d.querySelectorAll(".about-root .about-card, .about-side .about-card").length;
    out.undefinedText = (d.body.textContent.match(/undefined/g) || []).length;
    document.getElementById("out").textContent = "RESULT " + JSON.stringify(out);
  } catch (e) {
    document.getElementById("out").textContent = "RESULT " + JSON.stringify({ fatal: String(e) });
  }
}, 1000);
</script></body></html>`;

function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const url = req.url.split("?")[0];
      if (url === "/__smoke__") { res.writeHead(200, { "content-type": "text/html" }); res.end(DRIVER); return; }
      const file = path.join(ROOT, decodeURIComponent(url === "/" ? "/index.html" : url));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

(async () => {
  if (!CHROME) { console.error("smoke: no Chrome found — set CHROME=path/to/chrome"); process.exit(2); }
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/__smoke__`;
  execFile(CHROME, ["--headless", "--disable-gpu", "--dump-dom", "--virtual-time-budget=10000", url],
    { maxBuffer: 64 * 1024 * 1024, timeout: 60000 }, (err, stdout) => {
      srv.close();
      const m = (stdout || "").match(/RESULT ({.*?})</);
      if (err && !m) { console.error("smoke: chrome failed:", err.message); process.exit(2); }
      if (!m) { console.error("smoke: no RESULT in page output (driver never finished)"); process.exit(1); }
      const r = JSON.parse(m[1]);
      const checks = [
        ["page errors", (r.errors || []).length === 0, JSON.stringify(r.errors)],
        ["no fatal driver error", !r.fatal, r.fatal],
        ["21 chord pads", r.playGrid === 21, r.playGrid],
        ["12 harp strings", r.harpStrings === 12, r.harpStrings],
        ["graph canvases sized", r.canvases > 0, r.canvases],
        ["a graph painted pixels", r.painted === true, r.painted],
        ["8 about cards", r.aboutCards === 8, r.aboutCards],
        ["no leaked 'undefined' text", r.undefinedText === 0, r.undefinedText],
      ];
      let failed = 0;
      for (const [name, ok, got] of checks) {
        console.log((ok ? "  ok  " : "  FAIL") + "  " + name + (ok ? "" : "   (got: " + got + ")"));
        if (!ok) failed++;
      }
      if (failed) console.log("raw: " + JSON.stringify(r));
      console.log(failed ? `smoke: ${failed} check(s) FAILED` : "smoke: all checks passed");
      process.exit(failed ? 1 : 0);
    });
})();
