// Receipt printer for Ex-voto (Adafruit Tiny Thermal Printer over a USB-to-TTL
// serial adapter, using the browser's Web Serial API; Chrome only).
//
// What it prints, and when (all decided by testing on the real printer):
//   - item confirmed ........ the title (in the title screen's font), dithered item picture
//   - each Continue / choice . the text that was on screen
//   - final screen appears .. the final message, then a few blank lines to tear off
//
// Printing never blocks the game: everything goes through a queue, and if
// there's no printer (or it fails) the game carries on silently.
//
// Operator keys (on the kiosk):  F8 = choose / connect the printer
//                                F9 = print a short test slip
// Adding  ?printer=off  to the page address turns printing off.

const Printer = (() => {
  // ---- Everything you might want to tweak lives here -------------------
  const CONFIG = Object.assign({
    ENABLED: true,
    BAUD_RATE: 9600,          // from the printer's self-test page. Don't raise it.
    LINE_WIDTH: 32,           // characters per line
    PRINTER_DOTS: 384,        // printable width in dots (58 mm paper)
    PICTURE_WIDTH: 280,       // item picture width in dots (was 320)
    PICTURE_MAX_HEIGHT: 280,  // tall items are shrunk to fit this
    PICTURE_ASPECT: 1.0,      // 1 = true shape. Below 1 squashes the picture vertically, above 1 stretches it
    DOT_SCALE: 2,             // each dithered dot prints as 2x2
    CONTRAST: 1.25,
    BRIGHTNESS: 0.9,          // was 1.10. Lower = more black dots = darker picture
    FEED_LINES: 3,            // blank lines after the last line, to clear the tear bar
    LINE_DELAY_MS: 100,       // pause after each line of text
    CHUNK_ROWS: 60,           // picture rows sent per bitmap command (max 255)
    CHUNK_DELAY_MS: 0,        // extra pause after each picture chunk
    // Darkness controls. If prints are pale, raise HEAT_TIME and DENSITY a little at a time.
    HEAT_DOTS: 7,             // ESC 7: dots heated at once = (n+1) x 8. Lower = slower, steadier power
    HEAT_TIME: 200,           // ESC 7: heating time (x10 us). Was 120. HIGHER = DARKER (max 255)
    HEAT_INTERVAL: 50,        // ESC 7: pause between heat cycles (x10 us)
    DENSITY: 22,              // DC2 #: 0-31, darkness = 50% + 5% x n. Was 10 (100%). HIGHER = DARKER
    BREAK_TIME: 2,            // DC2 #: 0-7, cooling pause between cycles (x250 us). Leave at 2
    TITLE: "Ex-voto",                          // printed big, in the title screen's font
    TITLE_FONT_URL: "assets/fonts/Darinia.ttf", // same font file the title screen uses
    TITLE_WIDTH: 340,         // how wide the title is, in dots (max 384)
    TITLE_MAX_HEIGHT: 120,    // title is shrunk if it would be taller than this
    TITLE_PAD: 12,            // blank dots above and below the title
    TITLE_THRESHOLD: 190,     // 0-255. Higher = bolder, fatter title strokes
    TITLE_BOLD: 3,            // extra outline added to the title letters, in dots (0 = none)
    TEXT_ALIGN: 1,            // story text: 0 = left, 1 = centre
    CONNECT_KEY: "F8",
    TEST_KEY: "F9",
  }, window.PRINTER_CONFIG || {});

  const ESC = 0x1b;
  const DC2 = 0x12;
  const BYTES_PER_ROW = CONFIG.PRINTER_DOTS / 8;
  const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

  let port = null;
  let writer = null;
  let connected = false;
  let queue = Promise.resolve();
  let lastKey = null;

  const encoder = new TextEncoder();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...args) => console.log("[printer]", ...args);
  const rule = () => "-".repeat(CONFIG.LINE_WIDTH);

  if (new URLSearchParams(location.search).get("printer") === "off") {
    CONFIG.ENABLED = false;
  }

  // ---- Small on-screen message for the operator (not shown to visitors) --
  function toast(text) {
    try {
      let t = document.getElementById("printer-toast");
      if (!t) {
        t = document.createElement("div");
        t.id = "printer-toast";
        t.style.cssText =
          "position:fixed;left:8px;bottom:8px;z-index:99999;padding:4px 8px;" +
          "font:12px monospace;color:#ede6d6;background:rgba(0,0,0,.75);" +
          "border:1px solid rgba(237,230,214,.4);pointer-events:none;";
        document.body.appendChild(t);
      }
      t.textContent = text;
      t.style.display = "block";
      clearTimeout(t._timer);
      t._timer = setTimeout(() => (t.style.display = "none"), 3500);
    } catch (e) { /* cosmetic only */ }
  }

  // Heat and darkness settings, sent at the start of every receipt.
  function printSettings() {
    return [
      ESC, 0x37, CONFIG.HEAT_DOTS, CONFIG.HEAT_TIME, CONFIG.HEAT_INTERVAL,
      DC2, 0x23, (CONFIG.BREAK_TIME << 5) | CONFIG.DENSITY,
    ];
  }

  // ---- Connection ------------------------------------------------------
  async function closePort() {
    connected = false;
    try { if (writer) writer.releaseLock(); } catch (e) {}
    writer = null;
    try { if (port) await port.close(); } catch (e) {}
    port = null;
  }

  async function openPort(p) {
    await closePort();
    try {
      await p.open({ baudRate: CONFIG.BAUD_RATE });
    } catch (e) {
      // Already open (e.g. after a reload): carry on and just grab the writer.
      if (!p.writable) throw e;
    }
    port = p;
    writer = p.writable.getWriter();
    connected = true;
    log("connected at", CONFIG.BAUD_RATE, "baud");
  }

  // Reconnects to a printer this site was already given permission for. No prompt.
  async function autoConnect() {
    if (!("serial" in navigator) || !CONFIG.ENABLED) return false;
    try {
      const ports = await navigator.serial.getPorts();
      const pick =
        ports.find((p) => (p.getInfo().usbVendorId === 0x10c4)) || ports[0];
      if (!pick) { log("no previously allowed printer; press", CONFIG.CONNECT_KEY); return false; }
      await openPort(pick);
      return true;
    } catch (e) {
      log("auto-connect failed:", e.message);
      return false;
    }
  }

  // Shows Chrome's port chooser (needs a key press / click). Done once by hand.
  async function connect() {
    if (!("serial" in navigator)) { toast("Printer: Web Serial not available (use Chrome)"); return false; }
    try {
      const p = await navigator.serial.requestPort();
      await openPort(p);
      toast("Printer connected");
      return true;
    } catch (e) {
      log("connect cancelled/failed:", e.message);
      toast("Printer not connected: " + e.message);
      return false;
    }
  }

  async function write(bytes) {
    if (!connected || !writer) throw new Error("printer not connected");
    await writer.write(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
  }

  function enqueue(label, job) {
    if (!CONFIG.ENABLED || !connected) { log("skipped (no printer):", label); return; }
    queue = queue.then(job).catch(async (err) => {
      log("failed:", label, err && err.message);
      // Lost the printer mid-print: drop the connection and try to get it back.
      await closePort();
      setTimeout(autoConnect, 1500);
    });
  }

  // ---- Text ------------------------------------------------------------
  // The printer only understands plain ASCII.
  function toAscii(t) {
    const map = {
      "‘": "'", "’": "'", "“": '"', "”": '"',
      "–": "-", "—": "-", "…": "...", " ": " ",
    };
    return String(t)
      .replace(/[‘’“”–—… ]/g, (c) => map[c])
      .replace(/[^\n\x20-\x7E]/g, "?");
  }

  function wrap(text, width) {
    const lines = [];
    toAscii(text).split("\n").forEach((para) => {
      let line = "";
      para.split(/\s+/).filter(Boolean).forEach((word) => {
        while (word.length > width) {
          if (line) { lines.push(line); line = ""; }
          lines.push(word.slice(0, width));
          word = word.slice(width);
        }
        if (!line) line = word;
        else if ((line + " " + word).length <= width) line += " " + word;
        else { lines.push(line); line = word; }
      });
      lines.push(line);
    });
    return lines;
  }

  async function sendLine(text) {
    await write(encoder.encode(text + "\n"));
    if (CONFIG.LINE_DELAY_MS) await sleep(CONFIG.LINE_DELAY_MS);
  }

  async function sendWrapped(text) {
    for (const line of wrap(text, CONFIG.LINE_WIDTH)) await sendLine(line);
  }

  // ---- Picture ---------------------------------------------------------
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("could not load " + src));
      img.src = src;
    });
  }

  function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  }

  // Halve repeatedly, then a final resize: a clean, even downscale.
  function downscale(src, w, h) {
    let cur = src;
    while (cur.width / 2 >= w && cur.height / 2 >= h) {
      const nw = Math.floor(cur.width / 2), nh = Math.floor(cur.height / 2);
      const n = makeCanvas(nw, nh);
      const c = n.getContext("2d");
      c.imageSmoothingQuality = "high";
      c.drawImage(cur, 0, 0, nw, nh);
      cur = n;
    }
    const out = makeCanvas(w, h);
    const oc = out.getContext("2d");
    oc.imageSmoothingQuality = "high";
    oc.drawImage(cur, 0, 0, w, h);
    return out;
  }

  // Same steps as the approved test files:
  // crop to the object, white background, resize, auto contrast (1%),
  // lighten dark items, contrast + brightness, ordered Bayer dither, 2x2 dots.
  async function buildPictureRows(src) {
    const img = await loadImage(src);

    const s = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const W = Math.max(1, Math.round(img.naturalWidth * s));
    const H = Math.max(1, Math.round(img.naturalHeight * s));
    const full = makeCanvas(W, H);
    const fctx = full.getContext("2d", { willReadFrequently: true });
    fctx.drawImage(img, 0, 0, W, H);
    const rgba = fctx.getImageData(0, 0, W, H).data;

    let minX = W, minY = H, maxX = -1, maxY = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (rgba[(y * W + x) * 4 + 3] > 8) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) { minX = 0; minY = 0; maxX = W - 1; maxY = H - 1; }
    const cw = maxX - minX + 1, ch = maxY - minY + 1;

    const crop = makeCanvas(cw, ch);
    const cctx = crop.getContext("2d");
    cctx.fillStyle = "#fff";
    cctx.fillRect(0, 0, cw, ch);
    cctx.drawImage(full, minX, minY, cw, ch, 0, 0, cw, ch);

    let w = Math.floor(CONFIG.PICTURE_WIDTH / CONFIG.DOT_SCALE);
    let h = Math.max(1, Math.round(((ch * w) / cw) * CONFIG.PICTURE_ASPECT));
    const maxH = Math.floor(CONFIG.PICTURE_MAX_HEIGHT / CONFIG.DOT_SCALE);
    if (h > maxH) { w = Math.max(1, Math.round((w * maxH) / h)); h = maxH; }

    const small = downscale(crop, w, h);
    const px = small.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const n = w * h;

    // greyscale
    let g = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      g[i] = Math.floor((299 * px[i * 4] + 587 * px[i * 4 + 1] + 114 * px[i * 4 + 2]) / 1000);
    }

    // auto contrast, cutting 1% off each end of the histogram
    {
      const hist = new Array(256).fill(0);
      for (let i = 0; i < n; i++) hist[g[i]]++;
      let cut = Math.floor((n * 1) / 100);
      for (let lo = 0; lo < 256; lo++) {
        if (cut > hist[lo]) { cut -= hist[lo]; hist[lo] = 0; } else { hist[lo] -= cut; cut = 0; }
        if (cut <= 0) break;
      }
      cut = Math.floor((n * 1) / 100);
      for (let hi = 255; hi >= 0; hi--) {
        if (cut > hist[hi]) { cut -= hist[hi]; hist[hi] = 0; } else { hist[hi] -= cut; cut = 0; }
        if (cut <= 0) break;
      }
      let lo = 0; while (lo < 256 && !hist[lo]) lo++;
      let hi = 255; while (hi >= 0 && !hist[hi]) hi--;
      if (hi > lo) {
        const scale = 255 / (hi - lo), offset = -lo * scale;
        for (let i = 0; i < n; i++) g[i] = Math.max(0, Math.min(255, Math.floor(g[i] * scale + offset)));
      }
    }

    // lighten dark items: gamma puts the object's average tone near mid-grey (never darkens)
    {
      let sum = 0, cnt = 0;
      for (let i = 0; i < n; i++) { const a = g[i] / 255; if (a < 0.97) { sum += a; cnt++; } }
      const mean = cnt ? sum / cnt : 0.5;
      const gamma = Math.min(1, Math.log(0.5) / Math.log(Math.max(mean, 0.02)));
      for (let i = 0; i < n; i++) g[i] = Math.floor(Math.pow(g[i] / 255, gamma) * 255);
    }

    // contrast about the image's mean tone, then brightness
    {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += g[i];
      const mean = Math.floor(sum / n + 0.5);
      for (let i = 0; i < n; i++) {
        g[i] = Math.max(0, Math.min(255, Math.floor(mean + CONFIG.CONTRAST * (g[i] - mean))));
      }
      for (let i = 0; i < n; i++) g[i] = Math.max(0, Math.min(255, Math.floor(g[i] * CONFIG.BRIGHTNESS)));
    }

    // ordered (Bayer 4x4) dither, then each dot enlarged to DOT_SCALE x DOT_SCALE
    const black = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const thr = ((BAYER[y % 4][x % 4] + 0.5) / 16) * 255;
        black[y * w + x] = g[y * w + x] > thr ? 0 : 1;
      }
    }

    const sc = CONFIG.DOT_SCALE;
    const outW = w * sc, outH = h * sc;
    const off = Math.floor((CONFIG.PRINTER_DOTS - outW) / 2);
    const rows = [];
    for (let oy = 0; oy < outH; oy++) {
      const sy = Math.floor(oy / sc);
      const row = new Uint8Array(BYTES_PER_ROW);
      for (let ox = 0; ox < outW; ox++) {
        if (black[sy * w + Math.floor(ox / sc)]) {
          const x = off + ox;
          row[x >> 3] |= 0x80 >> (x & 7);
        }
      }
      rows.push(row);
    }
    return rows;
  }

  async function sendPicture(rows) {
    for (let i = 0; i < rows.length; i += CONFIG.CHUNK_ROWS) {
      const chunk = rows.slice(i, i + CONFIG.CHUNK_ROWS);
      const data = new Uint8Array(4 + chunk.length * BYTES_PER_ROW);
      data.set([DC2, 0x2a, chunk.length, BYTES_PER_ROW], 0);
      chunk.forEach((r, k) => data.set(r, 4 + k * BYTES_PER_ROW));
      await write(data);
      if (CONFIG.CHUNK_DELAY_MS) await sleep(CONFIG.CHUNK_DELAY_MS);
    }
  }

  // ---- Title (drawn in the title screen's font, printed as a picture) ----
  let titleFontPromise = null;
  function ensureTitleFont() {
    if (!titleFontPromise) {
      const face = new FontFace("ExvotoPrintTitle", `url(${CONFIG.TITLE_FONT_URL})`);
      titleFontPromise = face.load().then((f) => { document.fonts.add(f); return f; });
    }
    return titleFontPromise;
  }

  async function buildTitleRows() {
    await ensureTitleFont();
    const text = CONFIG.TITLE;
    const probe = makeCanvas(CONFIG.PRINTER_DOTS, 10).getContext("2d");
    probe.font = '100px "ExvotoPrintTitle"';
    let size = (100 * (CONFIG.TITLE_WIDTH - CONFIG.TITLE_BOLD)) / Math.max(1, probe.measureText(text).width);
    probe.font = `${size}px "ExvotoPrintTitle"`;
    let m = probe.measureText(text);
    const textH = () => m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    if (textH() > CONFIG.TITLE_MAX_HEIGHT) {
      size *= CONFIG.TITLE_MAX_HEIGHT / textH();
      probe.font = `${size}px "ExvotoPrintTitle"`;
      m = probe.measureText(text);
    }
    const asc = Math.ceil(m.actualBoundingBoxAscent), desc = Math.ceil(m.actualBoundingBoxDescent);
    const pad = CONFIG.TITLE_PAD;
    const H = asc + desc + pad * 2;
    const c = makeCanvas(CONFIG.PRINTER_DOTS, H);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, CONFIG.PRINTER_DOTS, H);
    ctx.fillStyle = "#000";
    ctx.font = `${size}px "ExvotoPrintTitle"`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    if (CONFIG.TITLE_BOLD > 0) {
      ctx.strokeStyle = "#000";
      ctx.lineWidth = CONFIG.TITLE_BOLD;
      ctx.lineJoin = "round";
      ctx.strokeText(text, CONFIG.PRINTER_DOTS / 2, pad + asc);
    }
    ctx.fillText(text, CONFIG.PRINTER_DOTS / 2, pad + asc);
    const px = ctx.getImageData(0, 0, CONFIG.PRINTER_DOTS, H).data;
    const rows = [];
    for (let y = 0; y < H; y++) {
      const row = new Uint8Array(BYTES_PER_ROW);
      for (let x = 0; x < CONFIG.PRINTER_DOTS; x++) {
        const i = (y * CONFIG.PRINTER_DOTS + x) * 4;
        const lum = (299 * px[i] + 587 * px[i + 1] + 114 * px[i + 2]) / 1000;
        if (lum < CONFIG.TITLE_THRESHOLD) row[x >> 3] |= 0x80 >> (x & 7);
      }
      rows.push(row);
    }
    return rows;
  }

  // Prints the title as a picture; if the font can't load, falls back to the
  // printer's own double-size text so there is always a title.
  async function sendTitle(rows) {
    await write([ESC, 0x61, 1]);
    if (rows) {
      await sendPicture(rows);
    } else {
      await write([0x1d, 0x21, 0x11]);
      await sendLine(CONFIG.TITLE);
      await write([0x1d, 0x21, 0x00]);
    }
    await write([ESC, 0x61, 0]);
  }

  // ---- What gets printed -----------------------------------------------
  // Item confirmed: the title, then the item picture. No rules anywhere.
  function printHeader(item) {
    lastKey = null;
    if (!item) return;
    const ready = CONFIG.ENABLED && connected;
    const picture = ready
      ? buildPictureRows(item.icon).catch((e) => { log("picture failed:", e.message); return null; })
      : Promise.resolve(null);
    const title = ready
      ? buildTitleRows().catch((e) => { log("title font failed:", e.message); return null; })
      : Promise.resolve(null);

    enqueue("header", async () => {
      const rows = await picture;
      const titleRows = await title;
      await write([ESC, 0x40]);                    // reset
      await sleep(100);
      await write(printSettings());                // heat + darkness
      await sendTitle(titleRows);
      if (rows) { await sendPicture(rows); await sendLine(""); }
    });
  }

  // A story step or a chosen path: the text that was on screen, then a blank line.
  function printStep(text, key) {
    if (!text) return;
    if (key && key === lastKey) return;            // ignore a double click
    lastKey = key || null;
    enqueue("step", async () => {
      await write([ESC, 0x61, CONFIG.TEXT_ALIGN]);
      await sendWrapped(text);
      await sendLine("");
    });
  }

  // Final screen: the final message (no rule, so it reads as part of the story),
  // then blank lines to tear off.
  function printFinale(text, key) {
    if (key && key === lastKey) return;
    lastKey = key || null;
    enqueue("finale", async () => {
      await write([ESC, 0x61, CONFIG.TEXT_ALIGN]);
      await sendWrapped(text || "");
      await write([ESC, 0x61, 0]);
      await write([ESC, 0x64, CONFIG.FEED_LINES]);
    });
  }

  // F9: a short slip showing the title and how the story text sits.
  function printTest() {
    const title = connected
      ? buildTitleRows().catch((e) => { log("title font failed:", e.message); return null; })
      : Promise.resolve(null);
    enqueue("test", async () => {
      const titleRows = await title;
      await write([ESC, 0x40]);
      await sleep(100);
      await write(printSettings());                // heat + darkness
      await sendTitle(titleRows);
      await write([ESC, 0x61, CONFIG.TEXT_ALIGN]);
      await sendWrapped("You began your journey on a dock leading to a collection of intertwined wooden platforms. Their stability was questionable.");
      await write([ESC, 0x61, 0]);
      await sendLine("");
      // Darkness swatches: solid black, 50% grid, 25% grid. Compare these between rolls/settings.
      const swatch = (even, odd) => Array.from({ length: 24 }, (_, i) => new Uint8Array(BYTES_PER_ROW).fill(i % 2 ? odd : even));
      await sendPicture(swatch(0xff, 0xff));
      await sendLine("");
      await sendPicture(swatch(0xaa, 0x55));
      await sendLine("");
      await sendPicture(swatch(0xaa, 0x00));
      await write([ESC, 0x64, CONFIG.FEED_LINES]);
    });
    if (!connected) toast("Printer not connected. Press " + CONFIG.CONNECT_KEY);
    else toast("Test slip sent");
  }

  // ---- Start-up --------------------------------------------------------
  function init() {
    if (!CONFIG.ENABLED) { log("printing is switched off"); return; }
    if (!("serial" in navigator)) { log("Web Serial isn't available in this browser"); return; }

    navigator.serial.addEventListener("disconnect", (e) => {
      if (!port || e.target === port) { log("printer unplugged"); closePort(); toast("Printer unplugged"); }
    });
    navigator.serial.addEventListener("connect", () => {
      log("a serial device appeared");
      setTimeout(autoConnect, 500);
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === CONFIG.CONNECT_KEY) { e.preventDefault(); connect(); }
      else if (e.key === CONFIG.TEST_KEY) { e.preventDefault(); printTest(); }
    });

    ensureTitleFont().catch((e) => log("title font not loaded:", e.message));
    autoConnect().then((ok) => { if (ok) toast("Printer connected"); });
  }

  init();

  return {
    CONFIG,
    connect,
    printHeader,
    printStep,
    printFinale,
    printTest,
    status: () => ({ enabled: CONFIG.ENABLED, connected }),
    _buildPictureRows: buildPictureRows, // exposed for testing
  };
})();

window.Printer = Printer;
