/* REMA explorer
 *
 * Reads one GDAL VRT DSN (with <Overview> entries pointing at other VRTs and
 * COGs) and does in the browser what the GDAL warper does: for each display
 * tile pick the pyramid level whose pixel matches the screen, find the source
 * COGs that intersect, pick the best internal overview in each, and read only
 * the windows needed.
 *
 * Display grid: EPSG:3031, 256 px tiles, origin (-4194304, 4194304),
 * resolution 8192 / 2^z m (z12 = 2 m). Same origin as NASA GIBS polar tiles.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- setup
  const GT = window.GeoTIFF;
  proj4.defs('EPSG:3031', '+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs');
  const P = proj4('EPSG:4326', 'EPSG:3031');
  const toXY = (lon, lat) => P.forward([lon, lat]);
  const toLL = (x, y) => P.inverse([x, y]);

  const DEFAULT_DSN = '/vsicurl/https://raw.githubusercontent.com/mdsumner/rema-ovr/main/REMA-2m_dem_ovr.vrt';
  const UNFILLED_100M = 'https://media.githubusercontent.com/media/mdsumner/rema-ovr/main/rema_mosaic_100m_v2.0_dem_int16.tif';
  const ORIGIN = 4194304;
  const RES0 = 8192;
  const TS = 256;           // display tile size
  const GUT = 1;            // gutter for hillshade neighbours
  const TW = TS + 2 * GUT;
  const MAXSRC = 12;        // max source files per display tile
  const DEG = Math.PI / 180;
  const $ = (id) => document.getElementById(id);

  const pool = (GT.Pool && typeof Worker !== 'undefined') ? new GT.Pool(Math.min(4, navigator.hardwareConcurrency || 2)) : null;

  // ZSTD (compression 50000) for the unfilled 100m COG; main thread only.
  if (window.fzstd && GT.addDecoder && GT.BaseDecoder) {
    class ZstdDecoder extends GT.BaseDecoder {
      decodeBlock(buffer) {
        const o = window.fzstd.decompress(new Uint8Array(buffer));
        return o.buffer.slice(o.byteOffset, o.byteOffset + o.byteLength);
      }
    }
    GT.addDecoder(50000, () => Promise.resolve(ZstdDecoder));
  }

  // Sparse COG tiles (TileByteCount == 0, written with SPARSE_OK=YES) are
  // nodata; geotiff.js 2.1 tries to fetch a zero-length range and fails.
  if (GT.GeoTIFFImage) {
    const orig = GT.GeoTIFFImage.prototype.getTileOrStrip;
    GT.GeoTIFFImage.prototype.getTileOrStrip = async function (x, y, sample, pd, signal) {
      const fd = this.fileDirectory;
      if (this.isTiled && this.planarConfiguration === 1 && fd.TileByteCounts) {
        const idx = y * Math.ceil(this.getWidth() / this.getTileWidth()) + x;
        if (fd.TileByteCounts[idx] === 0) {
          const n = this.getTileWidth() * this.getTileHeight() * this.getSamplesPerPixel();
          const bps = this.getBitsPerSample(), sf = this.getSampleFormat();
          const T = sf === 3 ? (bps === 64 ? Float64Array : Float32Array)
            : sf === 2 ? (bps === 8 ? Int8Array : bps === 16 ? Int16Array : Int32Array)
              : (bps === 8 ? Uint8Array : bps === 16 ? Uint16Array : Uint32Array);
          const a = new T(n);
          const nd = this.getGDALNoData();
          if (nd !== null) a.fill(nd);
          return { x, y, sample, data: a.buffer };
        }
      }
      return orig.call(this, x, y, sample, pd, signal);
    };
  }

  // ---------------------------------------------------------------- ledger
  const ledger = { req: 0, bytes: 0, inflight: 0, hosts: {}, errors: 0 };
  const rawFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input.url;
    let host = '?';
    try { host = new URL(url, location.href).host; } catch (e) { /* ignore */ }
    const h = ledger.hosts[host] || (ledger.hosts[host] = { req: 0, bytes: 0, err: 0 });
    ledger.req++; h.req++; ledger.inflight++;
    try {
      const r = await rawFetch(input, init);
      r._ledgerHost = h;
      if (!r.ok) { h.err++; ledger.errors++; }
      return r;
    } catch (e) {
      h.err++; ledger.errors++;
      throw e;
    } finally {
      ledger.inflight--;
      scheduleStatus();
    }
  };

  // Count body bytes as they are consumed (Content-Length is unreliable for
  // cached partial responses, and cross-origin headers vary).
  for (const m of ['arrayBuffer', 'text', 'blob']) {
    const orig = Response.prototype[m];
    Response.prototype[m] = async function () {
      const v = await orig.call(this);
      const n = typeof v === 'string' ? v.length : (v.byteLength !== undefined ? v.byteLength : v.size) || 0;
      ledger.bytes += n;
      if (this._ledgerHost) this._ledgerHost.bytes += n;
      scheduleStatus();
      return v;
    };
  }

  // ---------------------------------------------------------------- utils
  function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }
  function fmtDist(m) {
    if (!isFinite(m)) return '-';
    if (m >= 10000) return (m / 1000).toFixed(0) + ' km';
    if (m >= 1000) return (m / 1000).toFixed(2) + ' km';
    if (m >= 10) return m.toFixed(0) + ' m';
    return m.toFixed(1) + ' m';
  }
  function fmtRes(r) {
    if (r >= 1000) return (r / 1000).toFixed(r % 1000 ? 1 : 0) + 'km';
    return (r >= 10 ? r.toFixed(0) : r.toFixed(r < 1 ? 2 : 1).replace(/\.0$/, '')) + 'm';
  }
  function fmtLL(lon, lat) {
    const ns = lat < 0 ? 'S' : 'N', ew = lon < 0 ? 'W' : 'E';
    return Math.abs(lat).toFixed(5) + '\u00b0' + ns + ' ' + Math.abs(lon).toFixed(5) + '\u00b0' + ew;
  }
  function niceStep(x) {
    const p = Math.pow(10, Math.floor(Math.log10(x)));
    const f = x / p;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function shortName(url) { return url.split('/').pop(); }
  function hostLabel(url) {
    if (/media\.githubusercontent\.com/.test(url)) return 'GitHub LFS';
    if (/raw\.githubusercontent\.com/.test(url)) return 'GitHub raw';
    if (/pgc-opendata-dems/.test(url)) return 'PGC S3';
    try { return new URL(url).host; } catch (e) { return url; }
  }
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(t).then(() => flash('Copied'), () => fallbackCopy(t));
    }
    fallbackCopy(t);
  }
  function fallbackCopy(t) {
    const ta = document.createElement('textarea');
    ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); flash('Copied'); } catch (e) { /* ignore */ }
    ta.remove();
  }
  let flashTimer = 0;
  function flash(msg, ms) {
    const el = $('mapMsg');
    el.textContent = msg; el.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.hidden = true; mapMsgShown = ''; }, ms || 1500);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // Polar stereographic (south, lat_ts -71, WGS84) point scale factor.
  const E = 0.0818191908426215;
  function mFn(phi) { return Math.cos(phi) / Math.sqrt(1 - E * E * Math.sin(phi) ** 2); }
  function tFn(phi) {
    return Math.tan(Math.PI / 4 - phi / 2) / Math.pow((1 - E * Math.sin(phi)) / (1 + E * Math.sin(phi)), E / 2);
  }
  const PHI_C = 71 * DEG, MC = mFn(PHI_C), TC = tFn(PHI_C);
  function scaleK(lat) {
    const phi = Math.min(-lat, 89.99999) * DEG; // south-pole form via symmetry
    return (MC * tFn(phi)) / (TC * mFn(phi));
  }
  // ground length of a map segment, corrected by k along it
  function groundLen(x0, y0, x1, y1) {
    const L = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(L / 10000));
    let s = 0;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const ll = toLL(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
      s += (L / n) / scaleK(ll[1]);
    }
    return s;
  }

  // ---------------------------------------------------------------- DSN -> URL
  function dsnToUrl(s, baseUrl) {
    s = s.trim();
    let m;
    if (s.startsWith('/vsicurl/')) s = s.slice(9);
    else if ((m = s.match(/^\/vsis3\/([^/]+)\/(.*)$/))) {
      const region = m[1] === 'pgc-opendata-dems' ? 's3.us-west-2.amazonaws.com' : 's3.amazonaws.com';
      s = 'https://' + m[1] + '.' + region + '/' + m[2];
    } else if (baseUrl && !/^https?:\/\//.test(s)) {
      s = new URL(s, baseUrl).href;
    }
    // github.com/<o>/<r>/raw/[refs/heads/]<branch>/<path> -> CORS-friendly hosts
    if ((m = s.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/raw\/(?:refs\/heads\/)?([^/]+)\/(.*)$/))) {
      const isTif = /\.tiff?$/i.test(m[4]);
      s = isTif
        ? 'https://media.githubusercontent.com/media/' + m[1] + '/' + m[2] + '/' + m[3] + '/' + m[4]
        : 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/' + m[3] + '/' + m[4];
    }
    return s;
  }

  // ---------------------------------------------------------------- VRT parse
  function attr(s, name) {
    const m = s.match(new RegExp(name + '="([^"]*)"'));
    return m ? m[1] : null;
  }
  function parseVrtHeader(text) {
    const head = text.slice(0, 20000);
    const w = +attr(head, 'rasterXSize'), h = +attr(head, 'rasterYSize');
    const g = head.match(/<GeoTransform>([^<]*)<\/GeoTransform>/);
    const gt = g ? g[1].split(',').map(Number) : [0, 1, 0, 0, 0, -1];
    const nd = head.match(/<NoDataValue>([^<]*)<\/NoDataValue>/);
    return { w, h, gt, nodata: nd ? +nd[1] : null };
  }
  function parseSourceFilename(block, baseUrl) {
    const m = block.match(/<SourceFilename([^>]*)>([^<]*)<\/SourceFilename>/);
    if (!m) return null;
    const rel = /relativeToVRT="1"/.test(m[1]);
    return dsnToUrl(m[2], rel ? baseUrl : null);
  }
  function parseVrtOverviews(text, baseUrl) {
    const out = [];
    const re = /<Overview>([\s\S]*?)<\/Overview>/g;
    let m;
    while ((m = re.exec(text))) {
      const u = parseSourceFilename(m[1], baseUrl);
      if (u) out.push(u);
    }
    return out;
  }
  function parseVrtSources(text, baseUrl, hdr) {
    const out = [];
    const re = /<(ComplexSource|SimpleSource)>([\s\S]*?)<\/\1>/g;
    const gt = hdr.gt;
    let m;
    while ((m = re.exec(text))) {
      const b = m[2];
      const url = parseSourceFilename(b, baseUrl);
      const d = b.match(/<DstRect([^>]*)\/>/);
      if (!url || !d) continue;
      const xo = +attr(d[1], 'xOff'), yo = +attr(d[1], 'yOff'), xs = +attr(d[1], 'xSize'), ys = +attr(d[1], 'ySize');
      const xmin = gt[0] + xo * gt[1], xmax = gt[0] + (xo + xs) * gt[1];
      const ymax = gt[3] + yo * gt[5], ymin = gt[3] + (yo + ys) * gt[5];
      out.push({ url, bbox: [xmin, ymin, xmax, ymax] });
    }
    return out;
  }
  // bucket index over source bboxes
  function buildIndex(sources, cell) {
    const map = new Map();
    sources.forEach((s, i) => {
      const [x0, y0, x1, y1] = s.bbox;
      for (let a = Math.floor(x0 / cell); a <= Math.floor(x1 / cell); a++) {
        for (let b = Math.floor(y0 / cell); b <= Math.floor(y1 / cell); b++) {
          const k = a + ',' + b;
          let arr = map.get(k);
          if (!arr) map.set(k, arr = []);
          arr.push(i);
        }
      }
    });
    return {
      query(bb) {
        const seen = new Set();
        for (let a = Math.floor(bb[0] / cell); a <= Math.floor(bb[2] / cell); a++) {
          for (let b = Math.floor(bb[1] / cell); b <= Math.floor(bb[3] / cell); b++) {
            const arr = map.get(a + ',' + b);
            if (!arr) continue;
            for (const i of arr) {
              const s = sources[i].bbox;
              if (s[0] < bb[2] && s[2] > bb[0] && s[1] < bb[3] && s[3] > bb[1]) seen.add(i);
            }
          }
        }
        return Array.from(seen).sort((p, q) => p - q);
      }
    };
  }

  // ---------------------------------------------------------------- COGs
  const cogCache = new Map();
  const cogReady = new Map();   // url -> opened cog, for synchronous overlay drawing
  const COG_LRU = 96;
  // the image (full res or internal overview) a read at grid resolution R would use
  function pickImage(cog, R) {
    let L = cog.levels[0];
    for (const l of cog.levels) if (l.rx <= R * 1.5 + 1e-9) L = l;
    return L;
  }
  function openCog(url) {
    let p = cogCache.get(url);
    if (p) { cogCache.delete(url); cogCache.set(url, p); return p; }
    p = (async () => {
      const t = await GT.fromUrl(url, { allowFullFile: false, cacheSize: 96, blockSize: 65536 });
      const n = await t.getImageCount();
      const imgs = [];
      for (let i = 0; i < n; i++) imgs.push(await t.getImage(i));
      const base = imgs[0];
      const [ox, oy] = base.getOrigin();
      const [rx, ry] = base.getResolution();
      const W = base.getWidth(), H = base.getHeight();
      const levels = imgs
        .filter((im) => !((im.fileDirectory.NewSubfileType || 0) & 4))
        .map((im) => ({ im, w: im.getWidth(), h: im.getHeight(), rx: rx * W / im.getWidth(), ry: Math.abs(ry) * H / im.getHeight() }))
        .sort((a, b) => a.rx - b.rx);
      return {
        url, ox, oy, levels, nodata: base.getGDALNoData(),
        zstd: base.fileDirectory.Compression === 50000,
        bbox: [ox, oy - Math.abs(ry) * H, ox + rx * W, oy]
      };
    })();
    p.then((c) => { cogReady.set(url, c); while (cogReady.size > 400) cogReady.delete(cogReady.keys().next().value); }, () => cogCache.delete(url));
    cogCache.set(url, p);
    while (cogCache.size > COG_LRU) cogCache.delete(cogCache.keys().next().value);
    return p;
  }

  // Sample a COG into an output grid {x0 (left), y0 (top), res, W, H}.
  // Nearest when the chosen image is at least as fine as the grid, else bilinear.
  async function sampleCog(cog, g, out, opts) {
    opts = opts || {};
    const bb = cog.bbox;
    const gx1 = g.x0 + g.W * g.res, gy1 = g.y0 - g.H * g.res;
    if (bb[0] >= gx1 || bb[2] <= g.x0 || bb[1] >= g.y0 || bb[3] <= gy1) return 0;
    const L = pickImage(cog, g.res);
    const rx = L.rx, ry = L.ry;
    const u0 = (g.x0 + 0.5 * g.res - cog.ox) / rx, du = g.res / rx;
    const v0 = (cog.oy - (g.y0 - 0.5 * g.res)) / ry, dv = g.res / ry;
    const bil = opts.bilinear !== false && rx > g.res * 1.01;
    const pad = bil ? 1 : 0;
    let c0 = Math.floor(u0 - 0.5 * pad), c1 = Math.floor(u0 + (g.W - 1) * du + 0.5 * pad);
    let r0 = Math.floor(v0 - 0.5 * pad), r1 = Math.floor(v0 + (g.H - 1) * dv + 0.5 * pad);
    c0 = Math.max(0, c0); r0 = Math.max(0, r0);
    c1 = Math.min(L.w - 1, c1); r1 = Math.min(L.h - 1, r1);
    if (c1 < c0 || r1 < r0) return 0;
    const ww = c1 - c0 + 1, hh = r1 - r0 + 1;
    if (ww * hh > 6e6) throw new Error('window too large (' + ww + 'x' + hh + ')');
    const ras = await L.im.readRasters({
      window: [c0, r0, c1 + 1, r1 + 1], samples: [0], interleave: true,
      pool: cog.zstd ? undefined : (pool || undefined), signal: opts.signal
    });
    const nd = cog.nodata;
    const ok = (v) => v === v && v !== nd && v > -1e30 && v < 1e30;
    let n = 0;
    const W = g.W;
    if (!bil) {
      for (let j = 0; j < g.H; j++) {
        const r = Math.floor(v0 + j * dv);
        if (r < r0 || r > r1) continue;
        const rowOff = (r - r0) * ww;
        for (let i = 0; i < W; i++) {
          const c = Math.floor(u0 + i * du);
          if (c < c0 || c > c1) continue;
          const v = ras[rowOff + c - c0];
          if (ok(v)) { out[j * W + i] = v; n++; }
        }
      }
    } else {
      for (let j = 0; j < g.H; j++) {
        const fv = v0 + j * dv - 0.5;
        let ra = Math.floor(fv), ty = fv - ra;
        let rb = ra + 1;
        if (ra < r0) { ra = r0; } if (rb > r1) { rb = r1; }
        if (ra > r1 || rb < r0) continue;
        if (fv < r0 - 0.5 || fv > r1 + 0.5) continue;
        for (let i = 0; i < W; i++) {
          const fu = u0 + i * du - 0.5;
          if (fu < c0 - 0.5 || fu > c1 + 0.5) continue;
          let ca = Math.floor(fu); const tx = fu - ca;
          let cb = ca + 1;
          if (ca < c0) ca = c0; if (cb > c1) cb = c1;
          const a = ras[(ra - r0) * ww + ca - c0], b = ras[(ra - r0) * ww + cb - c0];
          const c = ras[(rb - r0) * ww + ca - c0], d = ras[(rb - r0) * ww + cb - c0];
          let s = 0, wsum = 0, w;
          w = (1 - tx) * (1 - ty); if (ok(a)) { s += a * w; wsum += w; }
          w = tx * (1 - ty); if (ok(b)) { s += b * w; wsum += w; }
          w = (1 - tx) * ty; if (ok(c)) { s += c * w; wsum += w; }
          w = tx * ty; if (ok(d)) { s += d * w; wsum += w; }
          if (wsum > 0.25) { out[j * W + i] = s / wsum; n++; }
        }
      }
    }
    return n;
  }

  // ---------------------------------------------------------------- levels
  let levels = [];          // sorted fine -> coarse
  let dsnUrl = '';
  let dsnString = '';
  const unfilled = { url: UNFILLED_100M, enabled: false };

  function levelName(res) { return fmtRes(Math.round(res * 100) / 100); }

  async function ensureSources(level) {
    if (level.sources) return level;
    if (!level.loading) {
      level.loading = (async () => {
        const r = await fetch(level.url);
        if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + level.url);
        const text = await r.text();
        const hdr = parseVrtHeader(text);
        level.hdr = hdr;
        level.sources = parseVrtSources(text, level.url, hdr);
        level.index = buildIndex(level.sources, 100000);
        return level;
      })();
    }
    return level.loading;
  }

  function levelAvailable(l) { return l.status === 'ok'; }
  function purgeErrors() { for (const [k, e] of store) if (e.state === 'error') store.delete(k); }

  async function loadDsn(dsn) {
    dsnString = dsn;
    dsnUrl = dsnToUrl(dsn);
    levels = [];
    clearAllTiles();
    setStatusText('reading DSN ' + shortName(dsnUrl) + ' ...');
    ledgerMark('setup');
    const t0 = performance.now();
    const r = await fetch(dsnUrl);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' reading ' + dsnUrl);
    const text = await r.text();
    const hdr = parseVrtHeader(text);
    const root = {
      name: levelName(hdr.gt[1]), res: hdr.gt[1], kind: 'vrt', url: dsnUrl, status: 'pending',
      hdr, sources: parseVrtSources(text, dsnUrl, hdr), role: 'root'
    };
    root.index = buildIndex(root.sources, 100000);
    root.loading = Promise.resolve(root);
    root.extent = [hdr.gt[0], hdr.gt[3] + hdr.h * hdr.gt[5], hdr.gt[0] + hdr.w * hdr.gt[1], hdr.gt[3]];
    levels.push(root);
    const ovs = parseVrtOverviews(text, dsnUrl);
    const parseMs = performance.now() - t0;

    const ovLevels = ovs.map((url) => ({
      url, kind: /\.vrt$/i.test(url) ? 'vrt' : 'tif', status: 'pending',
      res: root.res * 4, name: '...', role: 'overview'
    }));
    levels.push(...ovLevels);
    renderPyramid();

    await Promise.all(ovLevels.map(async (l) => {
      try {
        if (l.kind === 'tif') {
          const cog = await openCog(l.url);
          l.res = cog.levels[0].rx;
          l.extent = cog.bbox;
          l.internal = cog.levels.length - 1;
        } else {
          await ensureSources(l);
          l.res = l.hdr.gt[1];
          const h = l.hdr;
          l.extent = [h.gt[0], h.gt[3] + h.h * h.gt[5], h.gt[0] + h.w * h.gt[1], h.gt[3]];
        }
        l.name = levelName(l.res);
        l.status = l.kind === 'tif' ? 'ok' : 'pending';
      } catch (e) {
        l.status = 'error';
        l.err = String(e.message || e);
        l.name = l.name === '...' ? '?' : l.name;
      }
      levels.sort((a, b) => a.res - b.res);
      renderPyramid();
      fillLevelSelect();
      purgeErrors();
      scheduleDraw();
    }));

    ledgerRecord();
    ledgerMark();
    // Probe each distinct remote host behind VRT levels with one tiny ranged read.
    const hosts = new Map();
    for (const l of levels) {
      if (l.kind !== 'vrt' || !l.sources || !l.sources.length) continue;
      const u = l.sources[0].url;
      const host = new URL(u).host;
      if (!hosts.has(host)) hosts.set(host, { url: u, levels: [] });
      hosts.get(host).levels.push(l);
    }
    await Promise.all(Array.from(hosts.values()).map(async (h) => {
      let st = 'ok', why = '';
      try {
        const rr = await fetch(h.url, { headers: { Range: 'bytes=0-15' } });
        if (!rr.ok && rr.status !== 206) { st = 'error'; why = 'HTTP ' + rr.status; }
      } catch (e) {
        st = 'blocked'; why = 'browser blocked the request (no CORS on ' + new URL(h.url).host + '?)';
      }
      for (const l of h.levels) { l.status = st; l.err = why; }
    }));
    renderPyramid();
    fillLevelSelect();
    // availability changed: drop data tiles chosen under the old picture
    for (const [k, e] of store) if (!e.bitmap && e.state !== 'loading') store.delete(k);
    const blocked = levels.filter((l) => l.status === 'blocked' || l.status === 'error');
    const banner = $('banner');
    if (blocked.length) {
      banner.hidden = false;
      banner.innerHTML = 'Levels ' + blocked.map((l) => '<b>' + l.name + '</b>').join(', ') +
        ' are unreachable from this page (' + escapeHtml(blocked[0].err || 'error') + '). ' +
        'The explorer falls back to the finest level it can read.';
    } else banner.hidden = true;
    unfilled.enabled = dsnUrl === dsnToUrl(DEFAULT_DSN);
    fillCompareSelect();
    setStatusText('DSN parsed in ' + parseMs.toFixed(0) + ' ms: ' + root.sources.length + ' sources at ' + root.name + ', ' + ovs.length + ' overviews');
    scheduleDraw();
  }

  function chooseLevel(R, onlyVrt) {
    const av = levels.filter((l) => levelAvailable(l) && (!onlyVrt || l.kind === 'vrt'));
    if (!av.length) return null;
    let pick = av[0];
    for (const l of av) if (l.res <= R * 1.5 + 1e-9) pick = l;
    return pick;
  }
  function finestAvailable() {
    const av = levels.filter(levelAvailable);
    return av.length ? av[0] : null;
  }
  function levelByName(n) { return levels.find((l) => l.name === n); }
  // A pinned layer reads one level at its native pixel size at every zoom.
  function pinnedLevel(L) {
    if (!L || L.kind !== 'data') return null;
    if (L.id === 'dem' && S.forceLevel !== 'auto') return levelByName(S.forceLevel) || null;
    const m = L.id.match(/^dem@(.+)$/);
    return m ? levelByName(m[1]) || null : null;
  }
  function nativeZ(res) { return clamp(Math.ceil(Math.log2(RES0 / res) - 1e-9), 0, 14); }
  function layerZ(L) {
    const p = pinnedLevel(L);
    if (p) return nativeZ(p.res);
    return Math.min(zForRes(S.res), L.zmax());
  }
  const MAX_VIEW_TILES = 900;

  // Read one level into grid g. suffix swaps _dem.tif for a sibling product.
  async function readLevel(level, g, out, suffix, opts) {
    const bbox = [g.x0, g.y0 - g.H * g.res, g.x0 + g.W * g.res, g.y0];
    if (level.kind === 'tif') {
      if (suffix) return { n: 0, files: [] };
      const cog = await openCog(level.url);
      const k = await sampleCog(cog, g, out, opts);
      return { n: k ? 1 : 0, files: k ? [level.url] : [] };
    }
    await ensureSources(level);
    const ids = level.index.query(bbox);
    if (ids.length > MAXSRC) {
      const e = new Error(level.name + ' needs ' + ids.length + ' source files here (limit ' + MAXSRC + ')');
      e.tooMany = true; throw e;
    }
    const urls = ids.map((i) => level.sources[i].url).filter((u) => !suffix || /_dem\.tif$/.test(u))
      .map((u) => suffix ? u.replace(/_dem\.tif$/, '_' + suffix + '.tif') : u);
    const res = await Promise.allSettled(urls.map(async (u) => sampleCog(await openCog(u), g, out, opts)));
    const bad = res.filter((r) => r.status === 'rejected');
    if (bad.length && bad.length === res.length) throw bad[0].reason;
    return { n: ids.length, files: urls, failed: bad.length };
  }

  // ---------------------------------------------------------------- layers
  const DATE0 = Date.UTC(2000, 0, 1);
  const daysToDate = (d) => new Date(DATE0 + d * 86400000);
  const dateToDays = (y, m, d) => (Date.UTC(y, m - 1, d) - DATE0) / 86400000;

  const SIB = {
    count: { label: 'REMA count (DEMs per pixel)', palette: 'viridis', vmin: 0, vmax: 20, stretch: 'sqrt', units: '' },
    mad: { label: 'REMA MAD (m)', palette: 'magma', vmin: 0, vmax: 4, stretch: 'sqrt', units: 'm' },
    mindate: { label: 'REMA min date', palette: 'turbo', vmin: dateToDays(2009, 1, 1), vmax: dateToDays(2022, 1, 1), stretch: 'linear', units: 'date' },
    maxdate: { label: 'REMA max date', palette: 'turbo', vmin: dateToDays(2009, 1, 1), vmax: dateToDays(2022, 1, 1), stretch: 'linear', units: 'date' }
  };

  const GIBS = {
    'gibs:BlueMarble_ShadedRelief_Bathymetry': { id: 'BlueMarble_ShadedRelief_Bathymetry', set: '500m', maxZ: 4, ext: 'jpeg', label: 'GIBS Blue Marble relief + bathymetry' },
    'gibs:BlueMarble_NextGeneration': { id: 'BlueMarble_NextGeneration', set: '500m', maxZ: 4, ext: 'jpeg', label: 'GIBS Blue Marble NG' },
    'gibs:MODIS_Terra_CorrectedReflectance_TrueColor': { id: 'MODIS_Terra_CorrectedReflectance_TrueColor', set: '250m', maxZ: 5, ext: 'jpeg', time: true, label: 'GIBS MODIS Terra true colour (daily)' },
    'gibs:VIIRS_SNPP_CorrectedReflectance_TrueColor': { id: 'VIIRS_SNPP_CorrectedReflectance_TrueColor', set: '250m', maxZ: 5, ext: 'jpeg', time: true, label: 'GIBS VIIRS SNPP true colour (daily)' }
  };

  // Layer table: each data layer reads into an arbitrary grid.
  function layerDef(id) {
    if (id === 'dem') {
      return {
        id, kind: 'data', style: 'dem',
        zmax() { const f = finestAvailable(); return f ? zForRes(f.res / 2) : 12; },
        async load(g, opts) {
          let lv = S.forceLevel !== 'auto' ? levelByName(S.forceLevel) : null;
          if (lv && !levelAvailable(lv)) lv = null;
          if (!lv) lv = chooseLevel(g.res);
          if (!lv) throw new Error('no level available');
          const out = new Float32Array(g.W * g.H).fill(NaN);
          const pinned = S.forceLevel !== 'auto' && lv.name === S.forceLevel;
          const r = await readLevel(lv, g, out, null, pinned ? Object.assign({}, opts, { bilinear: false }) : opts);
          return { data: out, level: lv.name, files: r.files, n: r.n };
        }
      };
    }
    let m;
    if ((m = id.match(/^dem@(.+)$/))) {
      const name = m[1];
      return {
        id, kind: 'data', style: 'dem',
        zmax() { const l = levelByName(name); return l ? zForRes(l.res / 2) : 12; },
        async load(g, opts) {
          const lv = levelByName(name);
          if (!lv || !levelAvailable(lv)) throw new Error('level ' + name + ' unavailable');
          const out = new Float32Array(g.W * g.H).fill(NaN);
          const r = await readLevel(lv, g, out, null, Object.assign({}, opts, { bilinear: false }));
          return { data: out, level: lv.name, files: r.files, n: r.n };
        }
      };
    }
    if (id === 'dem100u') {
      return {
        id, kind: 'data', style: 'dem', maxRes: 400,
        zmax() { return zForRes(50); },
        async load(g, opts) {
          const out = new Float32Array(g.W * g.H).fill(NaN);
          const cog = await openCog(unfilled.url);
          const k = await sampleCog(cog, g, out, opts);
          return { data: out, level: '100m (unfilled)', files: k ? [unfilled.url] : [], n: k ? 1 : 0 };
        }
      };
    }
    if (id === 'diff') {
      return {
        id, kind: 'data', style: 'diff', maxRes: 400,
        zmax() { return zForRes(50); },
        async load(g, opts) {
          const l100 = levels.find((l) => Math.abs(l.res - 100) < 1 && l.kind === 'tif');
          if (!l100) throw new Error('no 100m level in this DSN');
          const a = new Float32Array(g.W * g.H).fill(NaN);
          const b = new Float32Array(g.W * g.H).fill(NaN);
          const o = Object.assign({}, opts, { bilinear: false });
          await Promise.all([readLevel(l100, g, a, null, o), openCog(unfilled.url).then((c) => sampleCog(c, g, b, o))]);
          // encode: finite diff where both, +1e6 marker where only filled
          const out = new Float32Array(g.W * g.H).fill(NaN);
          for (let i = 0; i < out.length; i++) {
            const A = a[i], B = b[i];
            if (A === A && B === B) out[i] = A - B;
            else if (A === A) out[i] = 1e6;
          }
          return { data: out, level: '100m filled - unfilled', files: [l100.url, unfilled.url], n: 2 };
        }
      };
    }
    if ((m = id.match(/^sib:(.+)$/))) {
      const suffix = m[1];
      return {
        id, kind: 'data', style: 'sib:' + suffix, maxRes: 160,
        zmax() { const f = levels.find((l) => l.kind === 'vrt' && levelAvailable(l)); return f ? zForRes(f.res / 2) : 12; },
        async load(g, opts) {
          const lv = chooseLevel(g.res, true);
          if (!lv) throw new Error('no PGC level available for ' + suffix);
          const out = new Float32Array(g.W * g.H).fill(NaN);
          const r = await readLevel(lv, g, out, suffix, Object.assign({}, opts, { bilinear: false }));
          return { data: out, level: lv.name + ' ' + suffix, files: r.files, n: r.n };
        }
      };
    }
    if (GIBS[id]) return Object.assign({ id, kind: 'image' }, GIBS[id]);
    return null;
  }
  const layerCache = {};
  function getLayer(id) { return layerCache[id] || (layerCache[id] = layerDef(id)); }

  // ---------------------------------------------------------------- palettes
  const PALETTES = {
    glacier: ['#0b1f3a', '#163e66', '#23668f', '#3f93b0', '#79bfcc', '#b7e0e0', '#e6f4f1', '#f6efe6', '#e8d7cf', '#d9bfc9'],
    ice: ['#08306b', '#08519c', '#2171b5', '#4292c6', '#6baed6', '#9ecae1', '#c6dbef', '#deebf7', '#f7fbff'],
    terrain: ['#2b5d34', '#5e8d43', '#a3b35a', '#d8cd84', '#c8a165', '#a1785a', '#8c7768', '#b7aca5', '#f2f0ee'],
    viridis: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
    magma: ['#000004', '#1c1044', '#4f127b', '#812581', '#b5367a', '#e55964', '#fb8761', '#fec287', '#fcfdbf'],
    turbo: ['#30123b', '#4145ab', '#4675ed', '#39a2fc', '#1bcfd4', '#24eca6', '#61fc6c', '#a4fc3b', '#d1e834', '#f3c63a', '#fe9b2d', '#f36315', '#d93806', '#b11901', '#7a0403'],
    gray: ['#000000', '#ffffff'],
    rdbu: ['#053061', '#2166ac', '#4393c3', '#92c5de', '#d1e5f0', '#f7f7f7', '#fddbc7', '#f4a582', '#d6604d', '#b2182b', '#67001f'],
    aspect: ['#e41a1c', '#ff7f00', '#ffff33', '#4daf4a', '#00bcd4', '#377eb8', '#984ea3', '#f781bf', '#e41a1c']
  };
  const lutCache = {};
  function lut(name) {
    if (lutCache[name]) return lutCache[name];
    const stops = PALETTES[name].map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
    const L = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255 * (stops.length - 1);
      const k = Math.min(stops.length - 2, Math.floor(t)), f = t - k;
      for (let c = 0; c < 3; c++) L[i * 3 + c] = stops[k][c] + (stops[k + 1][c] - stops[k][c]) * f;
    }
    return (lutCache[name] = L);
  }
  function drawLegend(canvas, palette) {
    const c = canvas.getContext('2d');
    const L = lut(palette);
    const w = canvas.width, h = canvas.height;
    const im = c.createImageData(w, h);
    for (let i = 0; i < w; i++) {
      const k = Math.round(i / (w - 1) * 255) * 3;
      for (let j = 0; j < h; j++) {
        const o = (j * w + i) * 4;
        im.data[o] = L[k]; im.data[o + 1] = L[k + 1]; im.data[o + 2] = L[k + 2]; im.data[o + 3] = 255;
      }
    }
    c.putImageData(im, 0, 0);
  }

  // ---------------------------------------------------------------- state
  const S = {
    x: 0, y: 300000, res: 4096,
    mode: 'colorshade', palette: 'glacier', vmin: 0, vmax: 4200, stretch: 'sqrt', autoStretch: true,
    az: 315, alt: 40, exag: 0, mix: 0.65, contours: false, cint: null,
    forceLevel: 'auto', bilinear: true,
    cmp: 'none', cmpMode: 'swipe', cmpOpacity: 1, cmpDate: '2025-12-15', swipe: 0.5,
    grat: true, bnd: 'none', bndLevel: 'lod', bndColor: '#ff2d95',
    tool: 'info'
  };
  let viewCdf = null;   // for equalise stretch
  let styleVer = 0;

  function autoExag(R) { return Math.max(1, Math.sqrt(R / 2)); }
  function effExag(R) { return autoExag(R) * Math.pow(2, S.exag); }

  function demStyleKey() {
    return [S.mode, S.palette, S.vmin, S.vmax, S.stretch, S.az, S.alt, S.exag, S.mix, S.contours, S.cint, S.stretch === 'equalize' ? styleVer : 0].join('|');
  }
  function styleKeyFor(style) {
    if (style === 'dem') return demStyleKey();
    return style + '|' + S.contours;
  }

  // ---------------------------------------------------------------- tile rendering
  function makeStretch(vmin, vmax, mode, cdf) {
    const span = (vmax - vmin) || 1;
    if (mode === 'sqrt') return (v) => Math.sqrt(clamp((v - vmin) / span, 0, 1));
    if (mode === 'equalize' && cdf) {
      return (v) => {
        const t = clamp((v - cdf.min) / (cdf.max - cdf.min || 1), 0, 1) * (cdf.bins.length - 1);
        return cdf.bins[Math.floor(t)];
      };
    }
    return (v) => clamp((v - vmin) / span, 0, 1);
  }

  // data is (OW + 2G) x (OH + 2G); px is an RGBA buffer OW x OH
  function renderImage(data, OW, OH, G, R, style, px) {
    const W = OW + 2 * G;
    let palette, vmin, vmax, stretch;
    if (style === 'dem') { palette = S.palette; vmin = S.vmin; vmax = S.vmax; stretch = S.stretch; }
    else if (style === 'diff') { palette = 'rdbu'; vmin = -5; vmax = 5; stretch = 'linear'; }
    else { const sd = SIB[style.slice(4)]; palette = sd.palette; vmin = sd.vmin; vmax = sd.vmax; stretch = sd.stretch; }
    const L = lut(palette);
    const st = makeStretch(vmin, vmax, stretch, style === 'dem' ? viewCdf : null);
    const mode = style === 'dem' ? S.mode : 'color';
    const needShade = mode === 'colorshade' || mode === 'shade' || mode === 'slope' || mode === 'aspect';
    const ex = effExag(R);
    const zen = (90 - S.alt) * DEG;
    const azm = ((360 - S.az + 90) % 360) * DEG;
    const cz = Math.cos(zen), sz = Math.sin(zen);
    const mix = S.mix;
    const doCont = S.contours && (style === 'dem');
    const ci = doCont ? (S.cint || niceStep(Math.max(1, (S.vmax - S.vmin) / 16))) : 0;
    const AL = lut('aspect'), ML = lut('magma');
    for (let j = 0; j < OH; j++) {
      for (let i = 0; i < OW; i++) {
        const k = (j + G) * W + (i + G);
        const v = data[k];
        const o = (j * OW + i) * 4;
        if (v !== v) { px[o + 3] = 0; continue; }
        let r, g, b;
        if (style === 'diff') {
          if (v === 1e6) { r = 255; g = 150; b = 40; px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 210; continue; }
          if (Math.abs(v) < 0.5) { px[o + 3] = 0; continue; }
        }
        let shade = 1, slope = 0, aspect = 0;
        if (needShade) {
          let a = data[k - W - 1], bb = data[k - W], c = data[k - W + 1];
          let d = data[k - 1], f = data[k + 1];
          let gg = data[k + W - 1], h = data[k + W], ii = data[k + W + 1];
          if (a !== a) a = v; if (bb !== bb) bb = v; if (c !== c) c = v; if (d !== d) d = v;
          if (f !== f) f = v; if (gg !== gg) gg = v; if (h !== h) h = v; if (ii !== ii) ii = v;
          const dzdx = ((c + 2 * f + ii) - (a + 2 * d + gg)) / (8 * R);
          const dzdy = ((gg + 2 * h + ii) - (a + 2 * bb + c)) / (8 * R);
          if (mode === 'slope') {
            slope = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy));
          } else if (mode === 'aspect') {
            aspect = Math.atan2(dzdy, -dzdx);
            slope = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy));
          } else {
            const sl = Math.atan(ex * Math.sqrt(dzdx * dzdx + dzdy * dzdy));
            const as = Math.atan2(dzdy, -dzdx);
            shade = cz * Math.cos(sl) + sz * Math.sin(sl) * Math.cos(azm - as);
            if (shade < 0) shade = 0;
          }
        }
        if (mode === 'shade') {
          r = g = b = 255 * shade;
        } else if (mode === 'slope') {
          const t = Math.min(255, Math.round(Math.sqrt(slope / DEG / 60) * 255)) * 3;
          r = ML[t]; g = ML[t + 1]; b = ML[t + 2];
        } else if (mode === 'aspect') {
          // compass bearing of downslope direction in grid terms
          let deg = (90 - aspect / DEG + 360) % 360;
          const t = Math.round(deg / 360 * 255) * 3;
          const fl = Math.min(1, slope / DEG / 2); // fade flat areas
          r = 128 + (AL[t] - 128) * fl; g = 128 + (AL[t + 1] - 128) * fl; b = 128 + (AL[t + 2] - 128) * fl;
        } else {
          const t = Math.round(st(v) * 255) * 3;
          r = L[t]; g = L[t + 1]; b = L[t + 2];
          if (mode === 'colorshade') {
            const m = 1 - mix + mix * shade * 1.15;
            r *= m; g *= m; b *= m;
          }
        }
        if (doCont) {
          const q = Math.floor(v / ci);
          const vr = data[k + 1], vd = data[k + W];
          if ((vr === vr && Math.floor(vr / ci) !== q) || (vd === vd && Math.floor(vd / ci) !== q)) {
            const thick = (Math.abs(q) % 5 === 4 || (vr === vr && Math.abs(Math.floor(vr / ci)) % 5 === 0 && Math.floor(vr / ci) !== q)) ? 0.25 : 0.45;
            r *= thick; g *= thick; b *= thick;
          }
        }
        px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
      }
    }
  }

  // ---------------------------------------------------------------- tile store
  const store = new Map();  // key -> entry {state, data, meta, canvas, skey, t, img}
  const STORE_MAX = 700;
  function tileKey(layerId, z, x, y) { return layerId + '/' + z + '/' + x + '/' + y; }
  function tileRes(z) { return RES0 / Math.pow(2, z); }
  function zForRes(R) { return clamp(Math.ceil(Math.log2(RES0 / R) - 0.25), 0, 14); }
  function tileGrid(z, x, y) {
    const R = tileRes(z), span = TS * R;
    return { x0: -ORIGIN + x * span - GUT * R, y0: ORIGIN - y * span + GUT * R, res: R, W: TW, H: TW };
  }
  function clearAllTiles() { store.clear(); queue.clear(); }

  function fetchDataTile(layerId, z, x, y) {
    const key = tileKey(layerId, z, x, y);
    let e = store.get(key);
    if (e) { e.t = performance.now(); return e.promise; }
    e = { state: 'loading', t: performance.now(), z, x, y, layerId };
    const L = getLayer(layerId);
    e.promise = (async () => {
      const t0 = performance.now();
      try {
        const r = await L.load(tileGrid(z, x, y), { bilinear: S.bilinear });
        let any = false;
        for (let i = 0; i < r.data.length; i++) if (r.data[i] === r.data[i]) { any = true; break; }
        e.data = any ? r.data : null;
        e.meta = { level: r.level, files: r.files, n: r.n, ms: performance.now() - t0 };
        e.state = 'ready';
      } catch (err) {
        e.state = 'error';
        e.err = err;
      }
      scheduleDraw();
      return e;
    })();
    store.set(key, e);
    evict();
    return e.promise;
  }

  const imgPending = new Map();
  function fetchImageTile(layerId, z, x, y) {
    const key = tileKey(layerId, z, x, y) + (GIBS[layerId].time ? '@' + S.cmpDate : '');
    let e = store.get(key);
    if (e) { e.t = performance.now(); return e.promise; }
    const G = GIBS[layerId];
    e = { state: 'loading', t: performance.now(), z, x, y, layerId };
    const url = 'https://gibs.earthdata.nasa.gov/wmts/epsg3031/best/' + G.id + '/default/' +
      (G.time ? S.cmpDate + '/' : '') + G.set + '/' + z + '/' + y + '/' + x + '.' + G.ext;
    e.promise = (async () => {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const blob = await r.blob();
        e.bitmap = await createImageBitmap(blob);
        e.state = 'ready';
      } catch (err) { e.state = 'error'; e.err = err; }
      scheduleDraw();
      return e;
    })();
    store.set(key, e);
    evict();
    return e.promise;
  }

  function evict() {
    if (store.size <= STORE_MAX) return;
    const arr = Array.from(store.entries()).filter(([, e]) => e.state !== 'loading').sort((a, b) => a[1].t - b[1].t);
    const n = store.size - STORE_MAX * 0.85;
    for (let i = 0; i < n && i < arr.length; i++) store.delete(arr[i][0]);
  }

  // request queue (render-driven)
  const queue = new Map();
  let active = 0;
  const MAXACTIVE = 10;
  let queueGen = 0;
  function want(layerId, z, x, y, prio, isImage) {
    const key = tileKey(layerId, z, x, y) + (isImage && GIBS[layerId].time ? '@' + S.cmpDate : '');
    if (store.has(key)) { store.get(key).t = performance.now(); return store.get(key); }
    const q = queue.get(key);
    if (q) { q.prio = prio; q.gen = queueGen; } else queue.set(key, { prio, gen: queueGen, layerId, z, x, y, isImage });
    return null;
  }
  function pump() {
    while (active < MAXACTIVE && queue.size) {
      let best = null, bk = null;
      for (const [k, q] of queue) if (!best || q.prio < best.prio) { best = q; bk = k; }
      queue.delete(bk);
      active++;
      const p = best.isImage ? fetchImageTile(best.layerId, best.z, best.x, best.y) : fetchDataTile(best.layerId, best.z, best.x, best.y);
      p.finally(() => { active--; pump(); checkSettled(); });
    }
  }

  function tileCanvas(e, style) {
    const sk = styleKeyFor(style);
    if (e.canvas && e.skey === sk) return e.canvas;
    if (!e.canvas) {
      e.canvas = document.createElement('canvas');
      e.canvas.width = TS; e.canvas.height = TS;
    }
    const c = e.canvas.getContext('2d');
    const img = c.createImageData(TS, TS);
    renderImage(e.data, TS, TS, GUT, tileRes(e.z), style, img.data);
    c.putImageData(img, 0, 0);
    e.skey = sk;
    return e.canvas;
  }

  // ---------------------------------------------------------------- view + draw
  const canvas = $('map');
  const ctx = canvas.getContext('2d');
  let CW = 800, CH = 600, DPR = 1;
  function resize() {
    const r = canvas.getBoundingClientRect();
    DPR = Math.min(2, window.devicePixelRatio || 1);
    CW = Math.max(1, r.width); CH = Math.max(1, r.height);
    canvas.width = Math.round(CW * DPR); canvas.height = Math.round(CH * DPR);
    scheduleDraw();
  }
  window.addEventListener('resize', resize);

  const sx = (X) => (X - S.x) / S.res + CW / 2;
  const sy = (Y) => (S.y - Y) / S.res + CH / 2;
  const mx = (px) => S.x + (px - CW / 2) * S.res;
  const my = (py) => S.y - (py - CH / 2) * S.res;
  function viewBbox() { return [mx(0), my(CH), mx(CW), my(0)]; }

  let drawPending = false;
  function scheduleDraw() {
    if (drawPending) return;
    drawPending = true;
    requestAnimationFrame(() => { drawPending = false; draw(); });
  }

  let frameInfo = { levels: new Map(), errors: [], tooMany: false, cmpMsg: '' };
  let mapMsgShown = '';

  function drawTileImage(src, z, x, y, sxs, sys, sws, shs) {
    const span = TS * tileRes(z);
    const X0 = -ORIGIN + x * span, Y0 = ORIGIN - y * span;
    const a = Math.round(sx(X0) * DPR), b = Math.round(sy(Y0) * DPR);
    const c = Math.round(sx(X0 + span) * DPR), d = Math.round(sy(Y0 - span) * DPR);
    if (sws === undefined) ctx.drawImage(src, a, b, c - a, d - b);
    else ctx.drawImage(src, sxs, sys, sws, shs, a, b, c - a, d - b);
  }

  function drawLayer(layerId, prioBase, clipX) {
    const L = getLayer(layerId);
    if (!L) return;
    const isImage = L.kind === 'image';
    let z;
    if (isImage) z = clamp(Math.ceil(Math.log2(RES0 / S.res) - 0.25), 0, L.maxZ);
    else z = layerZ(L);
    const pin = pinnedLevel(L);
    if (L.maxRes && S.res > L.maxRes * 1.5) {
      frameInfo.cmpMsg = (L.style && L.style.startsWith('sib') ? SIB[L.style.slice(4)].label : layerId) + ': zoom in (needs < ' + L.maxRes + ' m/px)';
      return;
    }
    const tsz = isImage ? 512 : TS;
    const span = tsz * RES0 / Math.pow(2, z);
    const ntiles = Math.round(2 * ORIGIN / span);
    const bb = viewBbox();
    const x0 = Math.max(0, Math.floor((bb[0] + ORIGIN) / span)), x1 = Math.min(ntiles - 1, Math.floor((bb[2] + ORIGIN) / span));
    const y0 = Math.max(0, Math.floor((ORIGIN - bb[3]) / span)), y1 = Math.min(ntiles - 1, Math.floor((ORIGIN - bb[1]) / span));
    const cxT = (S.x + ORIGIN) / span, cyT = (ORIGIN - S.y) / span;
    if (pin && (x1 - x0 + 1) * (y1 - y0 + 1) > MAX_VIEW_TILES) {
      frameInfo.pinMsg = 'Pinned at ' + pin.name + ': this view needs ' + ((x1 - x0 + 1) * (y1 - y0 + 1)) + ' tiles of native pixels (limit ' + MAX_VIEW_TILES + '). Zoom in, or unpin.';
      return;
    }
    ctx.save();
    if (clipX !== undefined) {
      ctx.beginPath(); ctx.rect(clipX * DPR, 0, canvas.width - clipX * DPR, canvas.height); ctx.clip();
    }
    if (isImage) ctx.globalAlpha = S.cmp === layerId ? (S.cmpMode === 'overlay' ? S.cmpOpacity : 1) : 1;
    else if (layerId !== 'dem' && S.cmpMode === 'overlay') ctx.globalAlpha = S.cmpOpacity;
    ctx.imageSmoothingEnabled = !pin;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const prio = prioBase + Math.hypot(tx + 0.5 - cxT, ty + 0.5 - cyT);
        const e = want(layerId, z, tx, ty, prio, isImage);
        if (e && e.state === 'ready') {
          if (isImage) { drawTileImage(e.bitmap, z, tx, ty); continue; }
          if (e.data) {
            drawTileImage(tileCanvas(e, L.style), z, tx, ty);
            if (layerId === 'dem') frameInfo.levels.set(e.meta.level, (frameInfo.levels.get(e.meta.level) || 0) + 1);
          }
          continue;
        }
        if (e && e.state === 'error') {
          frameInfo.errors.push(e.err);
          if (e.err && e.err.tooMany) frameInfo.tooMany = e.err.message;
        }
        // fallback: nearest ready ancestor
        for (let dz = 1; dz <= z; dz++) {
          const pz = z - dz, f = Math.pow(2, dz);
          const px = Math.floor(tx / f), py = Math.floor(ty / f);
          const pk = tileKey(layerId, pz, px, py) + (isImage && GIBS[layerId].time ? '@' + S.cmpDate : '');
          const pe = store.get(pk);
          if (pe && pe.state === 'ready' && (isImage ? pe.bitmap : pe.data)) {
            const sub = tsz / f;
            const src = isImage ? pe.bitmap : tileCanvas(pe, L.style);
            const ox = (tx - px * f) * sub, oy = (ty - py * f) * sub;
            drawTileImage(src, z, tx, ty, ox, oy, sub, sub);
            break;
          }
        }
      }
    }
    ctx.restore();
  }

  function draw() {
    queueGen++;
    frameInfo = { levels: new Map(), errors: [], tooMany: false, cmpMsg: '', pinMsg: '' };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0a1a2a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!levels.length) { drawOverlays(); return; }

    const cmp = S.cmp !== 'none' ? getLayer(S.cmp) : null;
    const swipeX = S.cmpMode === 'swipe' ? S.swipe * CW : undefined;
    // imagery under REMA when overlaying a REMA layer is not meaningful; GIBS overlay goes on top
    drawLayer('dem', 0);
    if (cmp) drawLayer(S.cmp, 100, swipeX);
    // drop stale queue entries (not wanted this frame)
    for (const [k, q] of queue) if (q.gen !== queueGen) queue.delete(k);
    pump();
    drawOverlays();
    updateFrameUi();
  }

  function updateFrameUi() {
    const lv = Array.from(frameInfo.levels.entries()).sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    currentLevels = lv;
    renderPyramidActive();
    let msg = '';
    if (frameInfo.pinMsg) msg = frameInfo.pinMsg;
    else if (frameInfo.tooMany) msg = frameInfo.tooMany + '. Zoom in, or set Level to Auto.';
    else if (frameInfo.cmpMsg) msg = frameInfo.cmpMsg;
    if (msg !== mapMsgShown) {
      mapMsgShown = msg;
      const el = $('mapMsg');
      el.hidden = !msg; el.textContent = msg;
    }
    $('swipe').hidden = !(S.cmp !== 'none' && S.cmpMode === 'swipe');
    $('swipe').style.left = (S.swipe * CW) + 'px';
    updateScalebar();
    scheduleStatus();
  }
  let currentLevels = [];

  // ---------------------------------------------------------------- overlays
  function pathLL(pts) {
    ctx.beginPath();
    let pen = false;
    for (const p of pts) {
      const xy = toXY(p[0], p[1]);
      const X = sx(xy[0]) * DPR, Y = sy(xy[1]) * DPR;
      if (!pen) { ctx.moveTo(X, Y); pen = true; } else ctx.lineTo(X, Y);
    }
    ctx.stroke();
  }
  function drawGraticule() {
    const R = S.res;
    const dLat = R > 3000 ? 5 : R > 600 ? 2 : R > 100 ? 1 : R > 20 ? 0.25 : R > 4 ? 0.05 : 0.01;
    const dLon = R > 3000 ? 30 : R > 600 ? 10 : R > 100 ? 5 : R > 20 ? 1 : R > 4 ? 0.2 : 0.05;
    const bb = viewBbox();
    // lat range in view: sample corners and centre
    const pts = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[0], bb[3]], [bb[2], bb[3]], [S.x, S.y], [(bb[0] + bb[2]) / 2, bb[1]], [(bb[0] + bb[2]) / 2, bb[3]], [bb[0], (bb[1] + bb[3]) / 2], [bb[2], (bb[1] + bb[3]) / 2]];
    const lls = pts.map((p) => toLL(p[0], p[1]));
    let latMin = Math.min(...lls.map((l) => l[1])), latMax = Math.max(...lls.map((l) => l[1]));
    const poleIn = bb[0] <= 0 && bb[2] >= 0 && bb[1] <= 0 && bb[3] >= 0;
    if (poleIn) latMin = -90;
    latMax = Math.min(-45, latMax + dLat); latMin = Math.max(-90, latMin - dLat);
    let lonMin = -180, lonMax = 180;
    if (!poleIn) {
      const lons = lls.map((l) => l[0]);
      const cl = toLL(S.x, S.y)[0];
      const rel = lons.map((l) => ((l - cl + 540) % 360) - 180);
      lonMin = cl + Math.min(...rel) - dLon; lonMax = cl + Math.max(...rel) + dLon;
      if (lonMax - lonMin > 360) { lonMin = -180; lonMax = 180; }
    }
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = 1 * DPR;
    ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.font = (10 * DPR) + 'px monospace';
    const nLat = Math.ceil((latMax - latMin) / dLat);
    if (nLat > 400) { ctx.restore(); return; }
    for (let lat = Math.ceil(latMin / dLat) * dLat; lat <= latMax; lat += dLat) {
      if (lat <= -90) continue;
      const line = [];
      const n = 180;
      for (let i = 0; i <= n; i++) line.push([lonMin + (lonMax - lonMin) * i / n, lat]);
      pathLL(line);
    }
    const nLon = Math.ceil((lonMax - lonMin) / dLon);
    if (nLon <= 400) {
      for (let lon = Math.ceil(lonMin / dLon) * dLon; lon <= lonMax; lon += dLon) {
        const line = [];
        const n = 120;
        for (let i = 0; i <= n; i++) line.push([lon, latMin + (latMax - latMin) * i / n]);
        pathLL(line);
      }
    }
    // labels along the view centre meridian / parallel
    const c = toLL(S.x, S.y);
    const decimals = (d) => (d >= 1 ? 0 : d >= 0.5 ? 1 : d >= 0.05 ? 2 : 3);
    for (let lat = Math.ceil(latMin / dLat) * dLat; lat <= latMax; lat += dLat) {
      if (lat <= -90) continue;
      const xy = toXY(c[0], lat);
      const X = sx(xy[0]), Y = sy(xy[1]);
      if (X > 0 && X < CW && Y > 20 && Y < CH - 20) ctx.fillText(Math.abs(lat).toFixed(decimals(dLat)) + 'S', (X + 3) * DPR, (Y - 3) * DPR);
    }
    if (c[1] > -89.9) {
      for (let lon = Math.ceil(lonMin / dLon) * dLon; lon <= lonMax; lon += dLon) {
        const xy = toXY(lon, c[1]);
        const X = sx(xy[0]), Y = sy(xy[1]);
        const L = ((lon + 540) % 360) - 180;
        if (X > 20 && X < CW - 40 && Y > 0 && Y < CH) ctx.fillText(Math.abs(L).toFixed(decimals(dLon)) + (L < 0 ? 'W' : L > 0 ? 'E' : ''), (X + 3) * DPR, (Y + 12) * DPR);
      }
    }
    ctx.restore();
  }

  // Which level the boundary overlay describes, and at what read resolution.
  function boundaryTarget() {
    const dem = getLayer('dem');
    if (S.bndLevel !== 'lod') {
      const lv = levelByName(S.bndLevel);
      return lv ? { lv, z: nativeZ(lv.res), R: lv.res, fixed: true } : null;
    }
    const z = layerZ(dem);
    const pin = pinnedLevel(dem);
    const lv = pin || levelByName(currentLevels[0]) || chooseLevel(tileRes(z));
    return lv ? { lv, z, R: tileRes(z), fixed: false } : null;
  }
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function strokeBox(b, dash) {
    ctx.setLineDash(dash || []);
    ctx.strokeRect(sx(b[0]) * DPR, sy(b[3]) * DPR, (b[2] - b[0]) / S.res * DPR, (b[3] - b[1]) / S.res * DPR);
    ctx.setLineDash([]);
  }
  function drawBoundaries() {
    const t = boundaryTarget();
    if (!t) return;
    const bb = viewBbox();
    ctx.save();
    ctx.lineWidth = 1 * DPR;
    ctx.font = (10 * DPR) + 'px monospace';
    ctx.shadowColor = 'rgba(0,0,0,.85)'; ctx.shadowBlur = 3 * DPR;  // keeps labels and lines legible over bright ice
    let note = '';
    if (S.bnd === 'display') {
      const span = TS * tileRes(t.z);
      const x0 = Math.floor((bb[0] + ORIGIN) / span), x1 = Math.floor((bb[2] + ORIGIN) / span);
      const y0 = Math.floor((ORIGIN - bb[3]) / span), y1 = Math.floor((ORIGIN - bb[1]) / span);
      const n = (x1 - x0 + 1) * (y1 - y0 + 1);
      if (n > 3000) note = 'display tiles z' + t.z + ': ' + n + ' in view, too many to draw';
      else {
        ctx.strokeStyle = hexA(S.bndColor, 0.7); ctx.fillStyle = hexA(S.bndColor, 0.95);
        const big = span / S.res > 110;
        for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
          const X0 = -ORIGIN + tx * span, Y0 = ORIGIN - ty * span;
          strokeBox([X0, Y0 - span, X0 + span, Y0]);
          if (!big) continue;
          const e = store.get(tileKey('dem', t.z, tx, ty));
          ctx.fillText(t.z + '/' + tx + '/' + ty, sx(X0) * DPR + 4 * DPR, sy(Y0) * DPR + 12 * DPR);
          if (e && e.meta) ctx.fillText(e.meta.level + ' ' + e.meta.n + 'f ' + e.meta.ms.toFixed(0) + 'ms', sx(X0) * DPR + 4 * DPR, sy(Y0) * DPR + 24 * DPR);
        }
        note = 'display tiles z' + t.z + ' (' + fmtRes(tileRes(t.z)) + ' px)' + (t.fixed ? ', fixed at ' + t.lv.name : ', following LOD');
      }
    } else {
      // files, or internal COG blocks
      const lv = t.lv;
      let urls = [];
      if (lv.kind === 'tif') urls = [{ url: lv.url, bbox: lv.extent }];
      else if (lv.index) {
        const ids = lv.index.query(bb);
        if (ids.length > 4000) { note = lv.name + ': ' + ids.length + ' files in view, too many to draw'; ids.length = 0; }
        urls = ids.map((i) => lv.sources[i]);
      } else ensureSources(lv).then(scheduleDraw, () => {});
      ctx.strokeStyle = hexA(S.bndColor, S.bnd === 'blocks' ? 0.45 : 0.9); ctx.fillStyle = hexA(S.bndColor, 0.95);
      const labels = urls.length < 80;
      for (const sitem of urls) {
        if (!sitem.bbox) continue;
        strokeBox(sitem.bbox);
        const Wd = (sitem.bbox[2] - sitem.bbox[0]) / S.res;
        if (labels && Wd > 90) ctx.fillText(shortName(sitem.url).replace(/_dem\.tif$/, ''), sx(sitem.bbox[0]) * DPR + 4 * DPR, sy(sitem.bbox[3]) * DPR + 12 * DPR);
      }
      if (S.bnd === 'files') note = lv.name + ': ' + urls.length + ' file' + (urls.length === 1 ? '' : 's') + ' in view' + (t.fixed ? ' (fixed)' : ' (following LOD)');
      if (S.bnd === 'blocks') {
        let drawn = 0, pending = 0, small = 0, desc = new Set();
        ctx.strokeStyle = hexA(S.bndColor, 0.9); ctx.lineWidth = 1.5 * DPR;
        for (const sitem of urls.slice(0, 120)) {
          if (!levelAvailable(lv)) break;
          const cog = cogReady.get(sitem.url);
          if (!cog) { pending++; openCog(sitem.url).then(scheduleDraw, () => {}); continue; }
          const L = pickImage(cog, t.R);
          const tw = L.im.getTileWidth(), th = L.im.getTileHeight();
          const bw = tw * L.rx, bh = th * L.ry;
          if (bw / S.res < 5) { small++; continue; }
          const k = cog.levels.indexOf(L);
          desc.add((k ? 'overview ' + k : 'full res') + ', ' + tw + 'px blocks of ' + fmtRes(L.rx));
          const c0 = Math.max(0, Math.floor((bb[0] - cog.ox) / bw)), c1 = Math.min(Math.ceil(L.w / tw) - 1, Math.floor((bb[2] - cog.ox) / bw));
          const r0 = Math.max(0, Math.floor((cog.oy - bb[3]) / bh)), r1 = Math.min(Math.ceil(L.h / th) - 1, Math.floor((cog.oy - bb[1]) / bh));
          if ((c1 - c0 + 1) * (r1 - r0 + 1) > 6000) { small++; continue; }
          ctx.beginPath();
          for (let c = c0; c <= c1 + 1; c++) {
            const X = sx(cog.ox + Math.min(c * bw, L.w * L.rx)) * DPR;
            ctx.moveTo(X, sy(cog.oy - r0 * bh) * DPR); ctx.lineTo(X, sy(cog.oy - Math.min((r1 + 1) * bh, L.h * L.ry)) * DPR);
          }
          for (let r = r0; r <= r1 + 1; r++) {
            const Y = sy(cog.oy - Math.min(r * bh, L.h * L.ry)) * DPR;
            ctx.moveTo(sx(cog.ox + c0 * bw) * DPR, Y); ctx.lineTo(sx(cog.ox + Math.min((c1 + 1) * bw, L.w * L.rx)) * DPR, Y);
          }
          ctx.stroke();
          drawn++;
        }
        note = lv.name + ' COG blocks: ' + Array.from(desc).join('; ') + (pending ? ' | opening ' + pending + ' headers' : '') + (small ? ' | ' + small + ' file(s) too fine to draw here' : '') + (t.fixed ? ' (fixed)' : ' (following LOD)');
      }
    }
    ctx.restore();
    if (note) {
      ctx.save();
      ctx.font = (11 * DPR) + 'px monospace';
      const w = ctx.measureText(note).width + 12 * DPR;
      ctx.fillStyle = 'rgba(15,20,27,.85)';
      ctx.fillRect(10 * DPR, (CH - 62) * DPR, w, 18 * DPR);
      ctx.fillStyle = '#e3e8ee';
      ctx.fillText(note, 16 * DPR, (CH - 49) * DPR);
      ctx.restore();
    }
  }

  function drawToolGeometry() {
    ctx.save();
    ctx.lineWidth = 2 * DPR;
    const line = (pts, color, closed) => {
      if (!pts.length) return;
      ctx.strokeStyle = color;
      ctx.beginPath();
      pts.forEach((p, i) => { const X = sx(p[0]) * DPR, Y = sy(p[1]) * DPR; if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); });
      if (closed) ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = color;
      for (const p of pts) { ctx.beginPath(); ctx.arc(sx(p[0]) * DPR, sy(p[1]) * DPR, 3.5 * DPR, 0, 7); ctx.fill(); }
    };
    const draft = tool.pts.concat(tool.hover && tool.active ? [tool.hover] : []);
    if (S.tool === 'profile' || S.tool === 'measure') line(draft, S.tool === 'profile' ? '#6cc4ff' : '#ffb86b', false);
    if (profile && profile.pts && S.tool !== 'measure') line(profile.pts, '#6cc4ff', false);
    if (measure && measure.pts && S.tool === 'measure' && !tool.active) line(measure.pts, '#ffb86b', measure.pts.length > 2);
    if (box) {
      ctx.strokeStyle = '#5ad19a'; ctx.setLineDash([6 * DPR, 4 * DPR]);
      const b = box;
      ctx.strokeRect(sx(b[0]) * DPR, sy(b[3]) * DPR, (b[2] - b[0]) / S.res * DPR, (b[3] - b[1]) / S.res * DPR);
      ctx.setLineDash([]);
    }
    if (profileHover) {
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5 * DPR;
      ctx.beginPath(); ctx.arc(sx(profileHover[0]) * DPR, sy(profileHover[1]) * DPR, 5 * DPR, 0, 7); ctx.fill(); ctx.stroke();
    }
    if (infoPoint) {
      const X = sx(infoPoint[0]) * DPR, Y = sy(infoPoint[1]) * DPR;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * DPR;
      ctx.beginPath(); ctx.moveTo(X - 9 * DPR, Y); ctx.lineTo(X + 9 * DPR, Y); ctx.moveTo(X, Y - 9 * DPR); ctx.lineTo(X, Y + 9 * DPR); ctx.stroke();
      ctx.strokeStyle = '#000'; ctx.lineWidth = 1 * DPR; ctx.beginPath(); ctx.arc(X, Y, 5 * DPR, 0, 7); ctx.stroke();
    }
    ctx.restore();
  }

  function drawOverlays() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (S.grat) drawGraticule();
    if (S.bnd !== 'none') drawBoundaries();
    drawToolGeometry();
  }

  function updateScalebar() {
    const ll = toLL(S.x, S.y);
    const k = scaleK(ll[1]);
    const groundPerPx = S.res / k;
    const target = 120 * groundPerPx;
    const nice = niceStep(target);
    const px = nice / groundPerPx;
    const sb = $('scalebar');
    sb.querySelector('.bar').style.width = px.toFixed(0) + 'px';
    sb.querySelector('span').textContent = fmtDist(nice) + '   (' + fmtRes(S.res) + '/px grid, k=' + k.toFixed(4) + ')';
  }

  // ---------------------------------------------------------------- status + ledger UI
  let statusPending = false;
  let statusText = '';
  function setStatusText(t) { statusText = t; scheduleStatus(); }
  function scheduleStatus() {
    if (statusPending) return;
    statusPending = true;
    setTimeout(() => { statusPending = false; renderStatus(); }, 120);
  }
  function renderStatus() {
    const loading = queue.size + active;
    $('status').textContent = (loading ? 'loading ' + loading + ' tiles | ' : '') +
      (currentLevels.length ? 'level ' + currentLevels.join(', ') + ' | ' : '') +
      ledger.req + ' req, ' + fmtBytes(ledger.bytes) + (ledger.inflight ? ' (' + ledger.inflight + ' in flight)' : '') +
      (statusText && !loading ? ' | ' + statusText : '');
    const v = viewLedger;
    $('ledgerNow').textContent = 'this view: ' + (ledger.req - v.req0) + ' req, ' + fmtBytes(ledger.bytes - v.bytes0) +
      (loading ? ' ...' : ' in ' + ((v.done || performance.now()) - v.t0).toFixed(0) + ' ms');
    $('ledgerHosts').textContent = Object.entries(ledger.hosts).map(([h, s]) => h + ': ' + s.req + ' req ' + fmtBytes(s.bytes) + (s.err ? ' (' + s.err + ' failed)' : '')).join('  |  ');
  }

  const viewLedger = { req0: 0, bytes0: 0, t0: performance.now(), done: 0, recorded: true, label: '' };
  const ledgerRows = [];
  function ledgerMark(label) {
    // close current
    viewLedger.req0 = ledger.req; viewLedger.bytes0 = ledger.bytes; viewLedger.t0 = performance.now();
    viewLedger.done = 0; viewLedger.recorded = false; viewLedger.label = label || '';
  }
  function ledgerRecord() {
    viewLedger.done = performance.now();
    viewLedger.recorded = true;
    const bb = viewBbox();
    const w = groundLen(bb[0], S.y, bb[2], S.y);
    ledgerRows.unshift({
      w: viewLedger.label || fmtDist(w), lv: viewLedger.label ? 'DSN + headers' : (currentLevels.join(',') || '-'),
      req: ledger.req - viewLedger.req0, bytes: ledger.bytes - viewLedger.bytes0, ms: viewLedger.done - viewLedger.t0
    });
    if (ledgerRows.length > 12) ledgerRows.pop();
    $('ledgerRows').innerHTML = ledgerRows.map((r) => '<tr><td>' + r.w + '</td><td>' + r.lv + '</td><td>' + r.req + '</td><td>' + fmtBytes(r.bytes) + '</td><td>' + (r.ms / 1000).toFixed(2) + 's</td></tr>').join('');
  }
  let settleTimer = 0;
  function checkSettled() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (queue.size || active || ledger.inflight) return;
      if (viewLedger.recorded) return;
      ledgerRecord();
      computeViewStats();
      renderStatus();
    }, 250);
  }

  // ---------------------------------------------------------------- pyramid UI
  function renderPyramid() {
    const el = $('pyramid');
    el.innerHTML = levels.map((l) => {
      const cls = l.status === 'ok' ? 'ok' : (l.status === 'blocked' || l.status === 'error') ? 'bad' : 'pending';
      const what = l.kind === 'vrt' ? (l.sources ? l.sources.length + ' COGs via ' + shortName(l.url) : shortName(l.url))
        : shortName(l.url) + (l.internal ? ' (+' + l.internal + ' internal)' : '');
      const host = l.kind === 'vrt' && l.sources && l.sources.length ? hostLabel(l.sources[0].url) : hostLabel(l.url);
      return '<div class="lv" data-name="' + escapeHtml(l.name) + '" title="' + escapeHtml(l.url + (l.err ? '\n' + l.err : '')) + '">' +
        '<span class="name">' + escapeHtml(l.name) + '</span><span class="src">' + escapeHtml(what) + '</span>' +
        '<span><span class="muted" style="font-size:10.5px">' + escapeHtml(host) + '</span> <span class="dot ' + cls + '"></span></span></div>';
    }).join('');
    renderPyramidActive();
  }
  function renderPyramidActive() {
    for (const d of $('pyramid').children) {
      d.classList.toggle('active', currentLevels.includes(d.dataset.name));
      d.classList.toggle('pinned', d.dataset.name === S.forceLevel);
      if (!d.onclick) d.onclick = () => setPin(S.forceLevel === d.dataset.name ? 'auto' : d.dataset.name);
    }
  }
  function fillLevelSelect() {
    const sel = $('forceLevel');
    const cur = S.forceLevel;
    sel.innerHTML = '<option value="auto">Auto (like the warper)</option>' + levels.map((l) =>
      '<option value="' + escapeHtml(l.name) + '"' + (levelAvailable(l) ? '' : ' disabled') + '>Pin ' + escapeHtml(l.name) + '</option>').join('');
    sel.value = levels.some((l) => l.name === cur) ? cur : 'auto';
    const bl = $('bndLevel');
    const bcur = S.bndLevel;
    bl.innerHTML = '<option value="lod">Follow LOD</option>' + levels.map((l) =>
      '<option value="' + escapeHtml(l.name) + '">Fixed ' + escapeHtml(l.name) + '</option>').join('');
    bl.value = levels.some((l) => l.name === bcur) ? bcur : 'lod';
    updatePinUi();
  }
  function setPin(name) {
    const lv = name !== 'auto' ? levelByName(name) : null;
    if (lv && !levelAvailable(lv)) { flash(name + ' is not reachable from this page'); return; }
    S.forceLevel = lv ? name : 'auto';
    $('forceLevel').value = S.forceLevel;
    for (const k of Array.from(store.keys())) if (k.startsWith('dem/')) store.delete(k);
    updatePinUi();
    ledgerMark(); updateLegend(); scheduleDraw(); writeHash();
  }
  function updatePinUi() {
    const b = $('pinBtn');
    if (!b) return;
    const on = S.forceLevel !== 'auto';
    b.classList.toggle('on', on);
    b.textContent = on ? 'Pinned ' + S.forceLevel : 'Pin level';
    b.title = on ? 'Unpin: go back to automatic level choice' : 'Pin the level currently on screen so it no longer switches with zoom';
    for (const d of $('pyramid').children) d.classList.toggle('pinned', d.dataset.name === S.forceLevel);
  }
  function fillCompareSelect() {
    const sel = $('cmpLayer');
    const opts = [['none', 'None']];
    for (const k of Object.keys(GIBS)) opts.push([k, GIBS[k].label]);
    if (unfilled.enabled) {
      opts.push(['dem100u', 'REMA 100m without Cop30 fill']);
      opts.push(['diff', 'Cop30 fill vs REMA (100m)']);
    }
    if (levels.some((l) => l.kind === 'vrt' && levelAvailable(l) && /pgc-opendata-dems/.test(((l.sources || [])[0] || {}).url || ''))) {
      for (const k of Object.keys(SIB)) opts.push(['sib:' + k, SIB[k].label]);
    }
    for (const l of levels) if (levelAvailable(l)) opts.push(['dem@' + l.name, 'REMA fixed at ' + l.name]);
    sel.innerHTML = opts.map((o) => '<option value="' + escapeHtml(o[0]) + '">' + escapeHtml(o[1]) + '</option>').join('');
    sel.value = opts.some((o) => o[0] === S.cmp) ? S.cmp : 'none';
    S.cmp = sel.value;
    updateCompareUi();
  }
  function updateCompareUi() {
    const id = S.cmp;
    const wrap = $('cmpLegendWrap');
    let hint = '';
    if (id === 'none') { wrap.hidden = true; hint = 'Swipe or overlay a second layer against the REMA view.'; }
    else if (GIBS[id]) {
      wrap.hidden = true;
      hint = GIBS[id].time ? 'Daily imagery; pick a summer date (Oct-Mar) - polar night is black.' : 'Static mosaic, 500 m best.';
    } else if (id === 'diff') {
      wrap.hidden = false; drawLegend($('cmpLegend'), 'rdbu');
      $('cmpMin').textContent = '-5 m'; $('cmpMid').textContent = 'orange = Cop30 fill only'; $('cmpMax').textContent = '+5 m';
      hint = 'Where the filled 100m overview differs from the unfilled one. Orange: no REMA strip data, filled from Copernicus GLO-30.';
    } else if (id.startsWith('sib:')) {
      const sd = SIB[id.slice(4)];
      wrap.hidden = false; drawLegend($('cmpLegend'), sd.palette);
      const f = (v) => sd.units === 'date' ? daysToDate(v).toISOString().slice(0, 7) : v + (sd.units ? ' ' + sd.units : '');
      $('cmpMin').textContent = f(sd.vmin); $('cmpMid').textContent = sd.stretch === 'sqrt' ? 'sqrt' : ''; $('cmpMax').textContent = f(sd.vmax);
      hint = 'Sibling product of each REMA tile (_' + id.slice(4) + '.tif). These have no overview pyramid, so they only draw below about 160 m/px - which is the point.' +
        (sd.units === 'date' ? ' Decoded as days since 2000-01-01.' : '');
    } else { wrap.hidden = true; hint = 'Same style as the main view, from one level or file only.'; }
    $('cmpHint').textContent = hint;
  }

  // ---------------------------------------------------------------- view stats
  function computeViewStats() {
    const z = layerZ(getLayer('dem'));
    const span = TS * tileRes(z);
    const bb = viewBbox();
    const vals = [];
    for (const e of store.values()) {
      if (e.layerId !== 'dem' || e.z !== z || !e.data) continue;
      const X0 = -ORIGIN + e.x * span, Y0 = ORIGIN - e.y * span;
      if (X0 > bb[2] || X0 + span < bb[0] || Y0 < bb[1] || Y0 - span > bb[3]) continue;
      for (let j = GUT; j < TS + GUT; j += 3) for (let i = GUT; i < TS + GUT; i += 3) {
        const X = X0 + (i - GUT + 0.5) * tileRes(z), Y = Y0 - (j - GUT + 0.5) * tileRes(z);
        if (X < bb[0] || X > bb[2] || Y < bb[1] || Y > bb[3]) continue;
        const v = e.data[j * TW + i];
        if (v === v) vals.push(v);
      }
    }
    if (vals.length < 10) { viewStats = null; return; }
    vals.sort((a, b) => a - b);
    const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
    viewStats = { p2: q(0.02), p98: q(0.98), min: vals[0], max: vals[vals.length - 1] };
    // equalisation curve
    const nb = 512, bins = new Float32Array(nb);
    const lo = viewStats.min, hi = viewStats.max;
    const counts = new Float64Array(nb);
    for (const v of vals) counts[Math.min(nb - 1, Math.floor((v - lo) / (hi - lo || 1) * nb))]++;
    let acc = 0;
    for (let i = 0; i < nb; i++) { acc += counts[i]; bins[i] = acc / vals.length; }
    const newCdf = { min: lo, max: hi, bins };
    if (S.stretch === 'equalize') { viewCdf = newCdf; styleVer++; scheduleDraw(); }
    else viewCdf = newCdf;
    if (S.autoStretch && S.mode !== 'slope' && S.mode !== 'aspect') {
      const a = Math.floor(viewStats.p2), b = Math.ceil(viewStats.p98);
      if (b > a && (Math.abs(a - S.vmin) > 0.5 || Math.abs(b - S.vmax) > 0.5)) {
        S.vmin = a; S.vmax = b; $('vmin').value = a; $('vmax').value = b;
        updateLegend(); scheduleDraw();
      }
    }
  }
  let viewStats = null;

  function updateLegend() {
    let pal = S.palette, a = S.vmin, b = S.vmax, unit = ' m';
    if (S.mode === 'slope') { pal = 'magma'; a = 0; b = 60; unit = '\u00b0 (sqrt)'; }
    if (S.mode === 'aspect') { pal = 'aspect'; }
    if (S.mode === 'shade') { pal = 'gray'; }
    drawLegend($('legend'), pal);
    if (S.mode === 'aspect') { $('legMin').textContent = 'N'; $('legMid').textContent = 'S (grid)'; $('legMax').textContent = 'N'; }
    else if (S.mode === 'shade') { $('legMin').textContent = 'shadow'; $('legMid').textContent = ''; $('legMax').textContent = 'lit'; }
    else {
      $('legMin').textContent = a.toFixed(0) + unit;
      $('legMid').textContent = S.mode === 'slope' ? '' : S.stretch;
      $('legMax').textContent = b.toFixed(0) + unit;
    }
    $('exagLabel').textContent = 'Effective z-exaggeration at this zoom: ' + effExag(tileRes(zForRes(S.res))).toFixed(1) + 'x (auto grows with pixel size so coarse levels still show relief)';
  }

  // ---------------------------------------------------------------- interaction
  const tool = { pts: [], hover: null, active: false };
  let profile = null, measure = null, box = null, infoPoint = null, profileHover = null;
  let drag = null;
  const pointers = new Map();

  function zoomAt(px, py, f) {
    const X = mx(px), Y = my(py);
    S.res = clamp(S.res * f, 0.25, 16384);
    S.x = X - (px - CW / 2) * S.res;
    S.y = Y + (py - CH / 2) * S.res;
    viewChanged();
  }
  let hashTimer = 0;
  function viewChanged() {
    scheduleDraw();
    ledgerMark();
    clearTimeout(hashTimer);
    hashTimer = setTimeout(writeHash, 400);
    updateLegend();
  }

  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const r = canvas.getBoundingClientRect();
    const d = ev.deltaMode === 1 ? ev.deltaY * 30 : ev.deltaY;
    zoomAt(ev.clientX - r.left, ev.clientY - r.top, Math.pow(2, d / 300));
  }, { passive: false });

  canvas.addEventListener('pointerdown', (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    const r = canvas.getBoundingClientRect();
    const p = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    pointers.set(ev.pointerId, p);
    if (pointers.size === 2) {
      const [a, b] = Array.from(pointers.values());
      drag = { pinch: true, d0: Math.hypot(a.x - b.x, a.y - b.y), res0: S.res, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, X: mx((a.x + b.x) / 2), Y: my((a.y + b.y) / 2) };
      return;
    }
    if (S.tool === 'box' && ev.button === 0) {
      drag = { box: true, X0: mx(p.x), Y0: my(p.y) };
      return;
    }
    drag = { x: p.x, y: p.y, cx: S.x, cy: S.y, moved: false, t: performance.now() };
  });
  canvas.addEventListener('pointermove', (ev) => {
    const r = canvas.getBoundingClientRect();
    const p = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, p);
    if (drag && drag.pinch && pointers.size === 2) {
      const [a, b] = Array.from(pointers.values());
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      S.res = clamp(drag.res0 * drag.d0 / Math.max(1, d), 0.25, 16384);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      S.x = drag.X - (cx - CW / 2) * S.res; S.y = drag.Y + (cy - CH / 2) * S.res;
      viewChanged();
      return;
    }
    if (drag && drag.box) {
      const X1 = mx(p.x), Y1 = my(p.y);
      box = [Math.min(drag.X0, X1), Math.min(drag.Y0, Y1), Math.max(drag.X0, X1), Math.max(drag.Y0, Y1)];
      scheduleDraw();
      return;
    }
    if (drag && !drag.pinch) {
      const dx = p.x - drag.x, dy = p.y - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.moved) {
        canvas.classList.add('grabbing');
        S.x = drag.cx - dx * S.res; S.y = drag.cy + dy * S.res;
        viewChanged();
      }
    }
    hoverAt(p.x, p.y);
  });
  function endPointer(ev) {
    pointers.delete(ev.pointerId);
    canvas.classList.remove('grabbing');
    if (!drag) return;
    const d = drag;
    if (d.pinch) { if (pointers.size === 0) drag = null; return; }
    drag = null;
    if (d.box) { if (box && (box[2] - box[0]) / S.res > 4) runBox(box); return; }
    if (!d.moved && ev.type === 'pointerup') {
      const r = canvas.getBoundingClientRect();
      clickAt(ev.clientX - r.left, ev.clientY - r.top, ev);
    }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', () => { tool.hover = null; $('readout').textContent = readoutIdle(); scheduleDraw(); });
  canvas.addEventListener('dblclick', (ev) => {
    ev.preventDefault();
    if ((S.tool === 'profile' || S.tool === 'measure') && tool.active) { finishPolyline(); return; }
    const r = canvas.getBoundingClientRect();
    zoomAt(ev.clientX - r.left, ev.clientY - r.top, ev.shiftKey ? 2 : 0.5);
  });

  function clickAt(px, py) {
    const X = mx(px), Y = my(py);
    if (S.tool === 'info') { runInfo(X, Y); return; }
    if (S.tool === 'profile' || S.tool === 'measure') {
      if (!tool.active) { tool.pts = []; tool.active = true; if (S.tool === 'profile') profile = null; else measure = null; }
      const last = tool.pts[tool.pts.length - 1];
      if (!last || Math.hypot(last[0] - X, last[1] - Y) / S.res > 2) tool.pts.push([X, Y]);
      if (S.tool === 'measure') showMeasure(tool.pts, true);
      scheduleDraw();
    }
  }
  function finishPolyline() {
    const pts = tool.pts.slice();
    tool.active = false; tool.pts = [];
    if (pts.length < 2) { scheduleDraw(); return; }
    if (S.tool === 'profile') runProfile(pts);
    else { measure = { pts }; showMeasure(pts, false); }
    scheduleDraw();
  }

  function readoutIdle() { return 'move over the map'; }
  function sampleViewDem(X, Y) {
    const z = layerZ(getLayer('dem'));
    const R = tileRes(z), span = TS * R;
    const tx = Math.floor((X + ORIGIN) / span), ty = Math.floor((ORIGIN - Y) / span);
    const e = store.get(tileKey('dem', z, tx, ty));
    if (!e || e.state !== 'ready') return { pending: true };
    if (!e.data) return { v: NaN, level: e.meta.level };
    const i = Math.floor((X - (-ORIGIN + tx * span)) / R) + GUT, j = Math.floor(((ORIGIN - ty * span) - Y) / R) + GUT;
    return { v: e.data[j * TW + i], level: e.meta.level, R };
  }
  function hoverAt(px, py) {
    const X = mx(px), Y = my(py);
    if (tool.active) { tool.hover = [X, Y]; scheduleDraw(); if (S.tool === 'measure') showMeasure(tool.pts.concat([[X, Y]]), true); }
    const ll = toLL(X, Y);
    const s = sampleViewDem(X, Y);
    const k = scaleK(ll[1]);
    let src = '';
    if (S.bnd === 'files' || S.bnd === 'blocks') {
      const t = boundaryTarget();
      const lv = t && t.lv;
      let url = null;
      if (lv && lv.index) {
        const ids = lv.index.query([X, Y, X, Y]);
        if (ids.length) url = lv.sources[ids[ids.length - 1]].url;
      } else if (lv && lv.kind === 'tif') url = lv.url;
      if (url) {
        src = '\nsrc  ' + shortName(url);
        const cog = cogReady.get(url);
        if (cog && S.bnd === 'blocks') {
          const L = pickImage(cog, t.R);
          const c = Math.floor((X - cog.ox) / (L.im.getTileWidth() * L.rx)), r = Math.floor((cog.oy - Y) / (L.im.getTileHeight() * L.ry));
          src += '\nblk  ovr ' + cog.levels.indexOf(L) + ' col ' + c + ' row ' + r;
        }
      }
    }
    $('readout').textContent =
      'x,y  ' + X.toFixed(0) + ', ' + Y.toFixed(0) + '\n' +
      'll   ' + fmtLL(ll[0], ll[1]) + '\n' +
      'z    ' + (s.pending ? '...' : (s.v === s.v ? s.v.toFixed(s.R < 20 ? 2 : 1) + ' m' : 'nodata')) + (s.level ? '  @' + s.level : '') + '\n' +
      'k    ' + k.toFixed(5) + src;
  }

  window.addEventListener('keydown', (ev) => {
    if (ev.target && /INPUT|SELECT|TEXTAREA/.test(ev.target.tagName)) return;
    if (ev.key === 'Escape') { tool.active = false; tool.pts = []; box = null; scheduleDraw(); }
    else if (ev.key === 'Enter' && tool.active) finishPolyline();
    else if (ev.key === '+' || ev.key === '=') zoomAt(CW / 2, CH / 2, 0.5);
    else if (ev.key === '-') zoomAt(CW / 2, CH / 2, 2);
    else if (ev.key === 'i' || ev.key === 'I') setTool('info');
    else if (ev.key === 'p' || ev.key === 'P') setTool('profile');
    else if (ev.key === 'm' || ev.key === 'M') setTool('measure');
    else if (ev.key === 'b' || ev.key === 'B') setTool('box');
    else if (ev.key.startsWith('Arrow')) {
      const d = 120 * S.res;
      if (ev.key === 'ArrowLeft') S.x -= d; if (ev.key === 'ArrowRight') S.x += d;
      if (ev.key === 'ArrowUp') S.y += d; if (ev.key === 'ArrowDown') S.y -= d;
      viewChanged();
    }
  });

  function setTool(t) {
    S.tool = t;
    tool.active = false; tool.pts = [];
    for (const b of document.querySelectorAll('.toolbar .tool')) b.classList.toggle('on', b.dataset.tool === t);
    canvas.style.cursor = t === 'box' ? 'cell' : 'crosshair';
    const hints = { info: 'Click for point info', profile: 'Click points along a line; double-click or Enter to finish', measure: 'Click points; double-click or Enter to finish', box: 'Drag a rectangle' };
    flash(hints[t], 1800);
    scheduleDraw();
  }

  // swipe handle
  (function () {
    const h = document.querySelector('.swipeHandle');
    let on = false;
    h.addEventListener('pointerdown', (ev) => { on = true; h.setPointerCapture(ev.pointerId); ev.stopPropagation(); });
    h.addEventListener('pointermove', (ev) => {
      if (!on) return;
      const r = canvas.getBoundingClientRect();
      S.swipe = clamp((ev.clientX - r.left) / CW, 0, 1);
      scheduleDraw();
    });
    h.addEventListener('pointerup', () => { on = false; });
  })();

  // ---------------------------------------------------------------- panel
  function openPanel(title, html, wide) {
    $('panelTitle').textContent = title;
    $('panelBody').innerHTML = html;
    $('panel').hidden = false;
    $('panel').classList.toggle('wide', !!wide);
  }
  $('panelClose').addEventListener('click', () => {
    $('panel').hidden = true; infoPoint = null; profileHover = null; box = null; profile = null; measure = null; scheduleDraw();
  });

  // ---------------------------------------------------------------- info tool
  let infoSeq = 0;
  async function valueAtLevel(lv, X, Y, suffix) {
    const res = lv.res;
    const g = { x0: X - res / 2, y0: Y + res / 2, res, W: 1, H: 1 };
    const out = new Float32Array(1).fill(NaN);
    if (lv.kind === 'tif') {
      if (suffix) return null;
      const cog = await openCog(lv.url);
      await sampleCog(cog, g, out, { bilinear: false });
      return { v: out[0], url: lv.url };
    }
    await ensureSources(lv);
    const ids = lv.index.query([X, Y, X, Y]);
    let url = null;
    for (let i = ids.length - 1; i >= 0; i--) {
      const base = lv.sources[ids[i]].url;
      if (suffix && !/_dem\.tif$/.test(base)) continue;
      const u = suffix ? base.replace(/_dem\.tif$/, '_' + suffix + '.tif') : base;
      try {
        const n = await sampleCog(await openCog(u), g, out, { bilinear: false });
        if (n) { url = u; break; }
      } catch (e) { url = u; out[0] = NaN; if (i === 0) throw e; }
    }
    return { v: out[0], url: url || (ids.length ? lv.sources[ids[ids.length - 1]].url : null), nsrc: ids.length };
  }

  function runInfo(X, Y) {
    const seq = ++infoSeq;
    infoPoint = [X, Y];
    scheduleDraw();
    const ll = toLL(X, Y);
    const k = scaleK(ll[1]);
    const rows = levels.map((l) => ({ l, id: 'lv_' + l.name.replace(/\W/g, '_') }));
    const extra = unfilled.enabled ? [{ name: '100m unfilled', id: 'lv_unf' }] : [];
    const pgcLevel = levels.find((l) => l.kind === 'vrt' && levelAvailable(l) && l.sources && l.sources.length && /_dem\.tif$/.test(l.sources[0].url));
    const html =
      '<div class="kv">' +
      '<span class="k">EPSG:3031</span><span>' + X.toFixed(1) + ', ' + Y.toFixed(1) + '</span>' +
      '<span class="k">lon, lat</span><span>' + ll[0].toFixed(6) + ', ' + ll[1].toFixed(6) + '</span>' +
      '<span class="k"></span><span>' + fmtLL(ll[0], ll[1]) + '</span>' +
      '<span class="k">scale k</span><span>' + k.toFixed(6) + ' (1 grid m = ' + (1 / k).toFixed(4) + ' ground m)</span>' +
      '<span class="k">grid north</span><span>' + (((-ll[0]) % 360 + 540) % 360 - 180).toFixed(2) + '\u00b0 from true north</span>' +
      '</div>' +
      '<div class="subh">Elevation at every level (m, WGS84 ellipsoid)</div>' +
      '<table class="drill"><thead><tr><th>Level</th><th class="num">Value</th><th>Source</th><th class="num">ms</th></tr></thead><tbody>' +
      rows.map((r) => '<tr id="' + r.id + '"><td>' + escapeHtml(r.l.name) + '</td><td class="num">...</td><td class="muted">' + hostLabel(r.l.url) + '</td><td class="num"></td></tr>').join('') +
      extra.map((r) => '<tr id="' + r.id + '"><td>' + r.name + '</td><td class="num">...</td><td class="muted">GitHub LFS</td><td class="num"></td></tr>').join('') +
      '</tbody></table>' +
      (pgcLevel ? '<div class="subh">REMA tile metadata (' + pgcLevel.name + ' sibling files)</div><div class="kv" id="sibKv"><span class="k">...</span><span></span></div><div id="metaTxt" class="hint"></div>' : '') +
      '<div class="btnrow">' +
      '<button id="infZoom">Zoom to 2 m here</button>' +
      '<button id="infCopy">Copy x,y</button>' +
      '<button id="infCopyLL">Copy lon,lat</button>' +
      '<button id="infRecipe">Recipe: 1 km box at 2 m</button>' +
      '</div><div id="infRecipeOut"></div>';
    openPanel('Point', html);
    $('infZoom').onclick = () => { S.x = X; S.y = Y; S.res = 2; viewChanged(); };
    $('infCopy').onclick = () => copyText(X.toFixed(1) + ', ' + Y.toFixed(1));
    $('infCopyLL').onclick = () => copyText(ll[0].toFixed(6) + ', ' + ll[1].toFixed(6));
    $('infRecipe').onclick = () => {
      const bb = [X - 500, Y - 500, X + 500, Y + 500];
      $('infRecipeOut').innerHTML = recipeHtml(bb, 2);
      bindCopyButtons($('infRecipeOut'));
    };
    for (const r of rows) {
      const t0 = performance.now();
      if (!levelAvailable(r.l)) { setCell(r.id, '<span class="bad">' + r.l.status + '</span>', escapeHtml(r.l.err || ''), ''); continue; }
      valueAtLevel(r.l, X, Y).then((res) => {
        if (seq !== infoSeq) return;
        const v = res.v;
        setCell(r.id, v === v ? v.toFixed(r.l.res < 50 ? 2 : 1) : '<span class="muted">nodata</span>',
          res.url ? '<a href="' + escapeHtml(res.url) + '" target="_blank" rel="noopener">' + escapeHtml(shortName(res.url)) + '</a>' : '<span class="muted">no source here</span>',
          (performance.now() - t0).toFixed(0));
      }).catch((e) => { if (seq === infoSeq) setCell(r.id, '<span class="bad">error</span>', escapeHtml(e.message || e), ''); });
    }
    if (unfilled.enabled) {
      const t0 = performance.now();
      openCog(unfilled.url).then(async (cog) => {
        const out = new Float32Array(1).fill(NaN);
        await sampleCog(cog, { x0: X - 50, y0: Y + 50, res: 100, W: 1, H: 1 }, out, { bilinear: false });
        if (seq !== infoSeq) return;
        setCell('lv_unf', out[0] === out[0] ? out[0].toFixed(0) : '<span class="muted">nodata (fill)</span>',
          '<a href="' + unfilled.url + '" target="_blank" rel="noopener">' + shortName(unfilled.url) + '</a>', (performance.now() - t0).toFixed(0));
      }).catch((e) => setCell('lv_unf', '<span class="bad">error</span>', escapeHtml(e.message || e), ''));
    }
    if (pgcLevel) {
      Promise.allSettled(Object.keys(SIB).map((s) => valueAtLevel(pgcLevel, X, Y, s))).then((rs) => {
        if (seq !== infoSeq) return;
        const keys = Object.keys(SIB);
        let html2 = '';
        rs.forEach((r, i) => {
          const key = keys[i];
          let val = '<span class="bad">' + (r.reason ? escapeHtml(r.reason.message || r.reason) : 'n/a') + '</span>';
          if (r.status === 'fulfilled' && r.value) {
            const v = r.value.v;
            if (v !== v) val = '<span class="muted">nodata</span>';
            else if (SIB[key].units === 'date') val = daysToDate(v).toISOString().slice(0, 10) + ' <span class="muted">(' + v + ' days since 2000-01-01)</span>';
            else val = (key === 'mad' ? v.toFixed(3) + ' m' : v.toFixed(0));
          }
          html2 += '<span class="k">' + key + '</span><span>' + val + '</span>';
        });
        $('sibKv').innerHTML = html2;
      });
      ensureSources(pgcLevel).then(async () => {
        const ids = pgcLevel.index.query([X, Y, X, Y]);
        if (!ids.length) { $('metaTxt').textContent = 'No REMA tile here.'; return; }
        const u = pgcLevel.sources[ids[ids.length - 1]].url.replace(/_dem\.tif$/, '_meta.txt');
        const r = await fetch(u);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const t = await r.text();
        if (seq !== infoSeq) return;
        const strips = t.split('\n').filter((s) => /^[A-Z0-9]{4}_\d{8}_/.test(s.trim())).map((s) => s.trim());
        const dates = strips.map((s) => s.split('_')[1]).sort();
        $('metaTxt').innerHTML = '<a href="' + escapeHtml(u) + '" target="_blank" rel="noopener">' + escapeHtml(shortName(u)) + '</a>: ' +
          strips.length + ' strip DEMs in this tile' + (dates.length ? ', ' + dates[0].replace(/(\d{4})(\d\d)(\d\d)/, '$1-$2-$3') + ' to ' + dates[dates.length - 1].replace(/(\d{4})(\d\d)(\d\d)/, '$1-$2-$3') : '') +
          (strips.length ? '<br><span class="muted">' + strips.slice(0, 6).map(escapeHtml).join('<br>') + (strips.length > 6 ? '<br>...' : '') + '</span>' : '');
      }).catch((e) => { if ($('metaTxt')) $('metaTxt').innerHTML = '<span class="muted">meta.txt: ' + escapeHtml(e.message || e) + '</span>'; });
    }
  }
  function setCell(id, val, src, ms) {
    const tr = document.getElementById(id);
    if (!tr) return;
    tr.children[1].innerHTML = val; tr.children[2].innerHTML = src; tr.children[3].textContent = ms;
  }

  // ---------------------------------------------------------------- recipes
  function recipeHtml(bb, res) {
    const nx = Math.round((bb[2] - bb[0]) / res), ny = Math.round((bb[3] - bb[1]) / res);
    // give only the long side; 0 lets GDAL derive the other from the extent's aspect
    const dx = nx >= ny ? nx : 0, dy = nx >= ny ? 0 : ny;
    const te = bb.map((v) => Math.round(v)).join(' ');
    const ext4 = [bb[0], bb[2], bb[1], bb[3]].map((v) => Math.round(v)).join(', ');
    const dsn = dsnString.startsWith('/vsi') ? dsnString : '/vsicurl/' + dsnString;
    const cli = 'gdalwarp -te ' + te + ' -ts ' + dx + ' ' + dy + ' -r bilinear \\\n  ' + dsn + ' rema_box.tif';
    const py = 'from osgeo import gdal\ngdal.UseExceptions()\ndsn = "' + dsn + '"\nds = gdal.Warp("rema_box.tif", dsn,\n  outputBounds=[' + bb.map((v) => Math.round(v)).join(', ') + '],\n  width=' + dx + ', height=' + dy + ', resampleAlg="bilinear")\na = ds.ReadAsArray()';
    const r = 'dsn <- "' + dsn + '"\nv <- vapour::gdal_raster_data(dsn,\n  target_ext = c(' + ext4 + '),\n  target_dim = c(' + dx + ', ' + dy + '), target_crs = "EPSG:3031", resample = "bilinear")\n' +
      '## or terra (needs both dimensions)\nlibrary(terra)\nr <- project(rast(dsn), rast(ext(' + ext4 + '), ncols = ' + nx + ', nrows = ' + ny + ', crs = "EPSG:3031"), by_util = TRUE)';
    const block = (lab, code) => '<div class="subh">' + lab + ' <button class="cpy" data-code="' + escapeHtml(code) + '">copy</button></div><pre class="code">' + escapeHtml(code) + '</pre>';
    return block('GDAL CLI', cli) + block('Python', py) + block('R', r);
  }
  function bindCopyButtons(root) {
    for (const b of root.querySelectorAll('button.cpy')) b.onclick = () => copyText(b.dataset.code);
  }

  // ---------------------------------------------------------------- bed (Bedmap)
  const BED = {
    url: dsnToUrl('https://github.com/mdsumner/rema-ovr/raw/refs/heads/explorer/bedmap2.tif'),
    label: 'Bedmap2 bed', note: 'Bedmap2 heights are relative to the GL04c geoid, REMA to the WGS84 ellipsoid; thickness here carries that offset (tens of m).'
  };
  function bedEnabled() { return unfilled.enabled; }
  function gridSample(data, g, x, y) {
    const fu = (x - g.x0) / g.res - 0.5, fv = (g.y0 - y) / g.res - 0.5;
    const c = Math.floor(fu), r = Math.floor(fv), ax = fu - c, ay = fv - r;
    const at = (i, j) => data[clamp(j, 0, g.H - 1) * g.W + clamp(i, 0, g.W - 1)];
    const a = at(c, r), b = at(c + 1, r), cc = at(c, r + 1), d = at(c + 1, r + 1);
    const v = a * (1 - ax) * (1 - ay) + b * ax * (1 - ay) + cc * (1 - ax) * ay + d * ax * ay;
    return v === v ? v : a;
  }
  async function sampleBedAt(samples) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of samples) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    const R = Math.max(500, Math.max(x1 - x0, y1 - y0) / 1024);
    x0 -= 2 * R; y0 -= 2 * R; x1 += 2 * R; y1 += 2 * R;
    const g = { x0, y0: y1, res: R, W: Math.ceil((x1 - x0) / R), H: Math.ceil((y1 - y0) / R) };
    const out = new Float32Array(g.W * g.H).fill(NaN);
    const cog = await openCog(BED.url);
    await sampleCog(cog, g, out, { bilinear: true });
    return samples.map((p) => gridSample(out, g, p[0], p[1]));
  }

  // ---------------------------------------------------------------- profile tool
  function polyLen(pts) {
    let L = 0, G = 0;
    for (let i = 1; i < pts.length; i++) {
      L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      G += groundLen(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    }
    return { L, G };
  }
  async function runProfile(pts) {
    const { L, G } = polyLen(pts);
    const N = clamp(Math.round(L / S.res), 120, 1200);
    const spacing = L / N;
    const z = Math.min(zForRes(spacing), getLayer('dem').zmax());
    const R = tileRes(z), span = TS * R;
    // sample positions
    const samples = [];
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    for (let s = 0; s <= N; s++) {
      const d = L * s / N;
      let k = 1; while (k < cum.length - 1 && cum[k] < d) k++;
      const t = (d - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1);
      samples.push([pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * t, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * t]);
    }
    const keys = new Map();
    for (const p of samples) {
      const tx = Math.floor((p[0] + ORIGIN) / span), ty = Math.floor((ORIGIN - p[1]) / span);
      keys.set(tx + ',' + ty, [tx, ty]);
    }
    profile = { pts, samples, loading: true };
    openPanel('Profile', '<p class="muted">Reading ' + keys.size + ' tiles at ' + fmtRes(R) + '...</p>', true);
    const req0 = ledger.req, b0 = ledger.bytes, t0 = performance.now();
    const ents = new Map();
    await Promise.all(Array.from(keys.entries()).map(async ([k, [tx, ty]]) => ents.set(k, await fetchDataTile('dem', z, tx, ty))));
    const vals = samples.map((p) => {
      const tx = Math.floor((p[0] + ORIGIN) / span), ty = Math.floor((ORIGIN - p[1]) / span);
      const e = ents.get(tx + ',' + ty);
      if (!e || !e.data) return NaN;
      const fu = (p[0] - (-ORIGIN + tx * span)) / R + GUT - 0.5, fv = ((ORIGIN - ty * span) - p[1]) / R + GUT - 0.5;
      const c = Math.floor(fu), r = Math.floor(fv), ax = fu - c, ay = fv - r;
      const g = (i, j) => e.data[clamp(j, 0, TW - 1) * TW + clamp(i, 0, TW - 1)];
      const a = g(c, r), b = g(c + 1, r), cc = g(c, r + 1), d = g(c + 1, r + 1);
      const v = a * (1 - ax) * (1 - ay) + b * ax * (1 - ay) + cc * (1 - ax) * ay + d * ax * ay;
      return v === v ? v : a;
    });
    const lvls = new Set(Array.from(ents.values()).filter((e) => e.meta).map((e) => e.meta.level));
    let bed = null, bedErr = '';
    if (bedEnabled()) { try { bed = await sampleBedAt(samples); } catch (e) { bedErr = String(e.message || e); } }
    profile.vals = vals; profile.bed = bed; profile.G = G; profile.loading = false;
    // ground distance per sample
    const gd = [0];
    for (let i = 1; i < samples.length; i++) gd.push(gd[i - 1] + groundLen(samples[i - 1][0], samples[i - 1][1], samples[i][0], samples[i][1]));
    profile.gd = gd;
    const fin = vals.filter((v) => v === v);
    let up = 0, down = 0;
    for (let i = 1; i < vals.length; i++) if (vals[i] === vals[i] && vals[i - 1] === vals[i - 1]) { const d = vals[i] - vals[i - 1]; if (d > 0) up += d; else down -= d; }
    const st = fin.length ? { min: Math.min(...fin), max: Math.max(...fin) } : { min: NaN, max: NaN };
    let thickHtml = '';
    if (bed) {
      const th = vals.map((v, i) => v - bed[i]).filter((v) => v === v);
      const bf = bed.filter((v) => v === v);
      if (th.length) thickHtml = '<span class="k">bed (Bedmap2)</span><span>' + Math.min(...bf).toFixed(0) + ' to ' + Math.max(...bf).toFixed(0) + ' m</span>' +
        '<span class="k">ice thickness</span><span>' + Math.min(...th).toFixed(0) + ' to ' + Math.max(...th).toFixed(0) + ' m, mean ' + (th.reduce((a, b) => a + b, 0) / th.length).toFixed(0) + ' m <span class="muted">(REMA minus Bedmap2)</span></span>';
    } else if (bedErr) thickHtml = '<span class="k">bed</span><span class="muted">' + escapeHtml(bedErr) + '</span>';
    const html = profileSvg(gd, vals, bed) +
      '<div class="kv">' +
      '<span class="k">length</span><span>' + fmtDist(G) + ' ground (' + fmtDist(L) + ' grid)</span>' +
      '<span class="k">elevation</span><span>' + st.min.toFixed(1) + ' to ' + st.max.toFixed(1) + ' m</span>' +
      '<span class="k">climb / drop</span><span>+' + up.toFixed(0) + ' m / -' + down.toFixed(0) + ' m</span>' + thickHtml +
      '<span class="k">sampled</span><span>' + (N + 1) + ' points every ' + fmtDist(G / N) + ', tiles at ' + fmtRes(R) + ' from level ' + Array.from(lvls).join(', ') + '</span>' +
      '<span class="k">cost</span><span>' + (ledger.req - req0) + ' req, ' + fmtBytes(ledger.bytes - b0) + ', ' + (performance.now() - t0).toFixed(0) + ' ms</span>' +
      '</div>' + (bed ? '<p class="hint">' + BED.note + '</p>' : '') +
      '<div class="btnrow"><button id="profCsv">Download CSV</button>' + (bed ? '<button id="profGlobe">Cutaway in Globe</button>' : '') + '</div>';
    openPanel('Profile', html, true);
    if ($('profGlobe')) $('profGlobe').onclick = () => openGlobe('profile');
    $('profCsv').onclick = () => {
      const lines = ['dist_m,x,y,lon,lat,elev_m' + (bed ? ',bed_m,thickness_m' : '')];
      const f = (v, d) => (v === v ? v.toFixed(d) : '');
      samples.forEach((p, i) => { const ll = toLL(p[0], p[1]); lines.push([gd[i].toFixed(1), p[0].toFixed(1), p[1].toFixed(1), ll[0].toFixed(6), ll[1].toFixed(6), f(vals[i], 2)].concat(bed ? [f(bed[i], 0), f(vals[i] - bed[i], 0)] : []).join(',')); });
      download(new Blob([lines.join('\n')], { type: 'text/csv' }), 'rema_profile.csv');
    };
    const svg = $('panelBody').querySelector('svg');
    svg.addEventListener('mousemove', (ev) => {
      const r = svg.getBoundingClientRect();
      const fx = (ev.clientX - r.left) / r.width;
      const t = clamp((fx * 600 - 44) / (600 - 54), 0, 1);
      const i = Math.round(t * (samples.length - 1));
      profileHover = samples[i];
      const lab = svg.querySelector('#phov');
      const ln = svg.querySelector('#phl');
      const X = 44 + t * (600 - 54);
      ln.setAttribute('x1', X); ln.setAttribute('x2', X);
      lab.textContent = fmtDist(gd[i]) + '  surface ' + (vals[i] === vals[i] ? vals[i].toFixed(1) + ' m' : 'nodata') +
        (bed && bed[i] === bed[i] ? '  bed ' + bed[i].toFixed(0) + ' m  ice ' + (vals[i] - bed[i]).toFixed(0) + ' m' : '');
      scheduleDraw();
    });
    svg.addEventListener('mouseleave', () => { profileHover = null; scheduleDraw(); });
    scheduleDraw();
  }
  function profileSvg(gd, vals, bed) {
    const W = 600, H = bed ? 240 : 200, l = 44, r = 10, t = 14, b = 24;
    const fin = vals.filter((v) => v === v);
    if (!fin.length) return '<p class="muted">No data along this line.</p>';
    let lo = Math.min(...fin), hi = Math.max(...fin);
    const bfin = bed ? bed.filter((v) => v === v) : [];
    if (bfin.length) lo = Math.min(lo, Math.min(...bfin));
    if (hi - lo < 1) { hi += 0.5; lo -= 0.5; }
    const pad = (hi - lo) * 0.06; lo -= pad * (bfin.length ? 2.5 : 1); hi += pad;
    const D = gd[gd.length - 1] || 1;
    const X = (d) => l + d / D * (W - l - r), Y = (v) => t + (hi - v) / (hi - lo) * (H - t - b);
    let path = '', pen = false;
    vals.forEach((v, i) => { if (v === v) { path += (pen ? 'L' : 'M') + X(gd[i]).toFixed(1) + ' ' + Y(v).toFixed(1); pen = true; } else pen = false; });
    let area = '';
    {
      let seg = []; const segs = [];
      vals.forEach((v, i) => { if (v === v) seg.push([X(gd[i]), Y(v)]); else if (seg.length) { segs.push(seg); seg = []; } });
      if (seg.length) segs.push(seg);
      area = segs.map((s) => 'M' + s[0][0].toFixed(1) + ' ' + (H - b) + s.map((p) => 'L' + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('') + 'L' + s[s.length - 1][0].toFixed(1) + ' ' + (H - b) + 'Z').join('');
    }
    const ys = niceStep((hi - lo) / 4), xs = niceStep(D / 6);
    let grid = '';
    for (let v = Math.ceil(lo / ys) * ys; v <= hi; v += ys) grid += '<line x1="' + l + '" x2="' + (W - r) + '" y1="' + Y(v) + '" y2="' + Y(v) + '" stroke="#2b3440"/><text x="' + (l - 4) + '" y="' + (Y(v) + 3) + '" text-anchor="end">' + v.toFixed(ys < 1 ? 1 : 0) + '</text>';
    for (let d = 0; d <= D; d += xs) grid += '<line y1="' + t + '" y2="' + (H - b) + '" x1="' + X(d) + '" x2="' + X(d) + '" stroke="#2b3440"/><text x="' + X(d) + '" y="' + (H - b + 13) + '" text-anchor="middle">' + fmtDist(d) + '</text>';
    let bedLayers = '';
    if (bfin.length) {
      // rock below the bed, ice between bed and surface
      const segs = []; let seg = [];
      vals.forEach((v, i) => { if (v === v && bed[i] === bed[i]) seg.push(i); else if (seg.length) { segs.push(seg); seg = []; } });
      if (seg.length) segs.push(seg);
      let rock = '', ice = '', bedLine = '';
      for (const sg of segs) {
        const bx = sg.map((i) => X(gd[i]).toFixed(1) + ' ' + Y(bed[i]).toFixed(1));
        rock += 'M' + X(gd[sg[0]]).toFixed(1) + ' ' + (H - b) + 'L' + bx.join('L') + 'L' + X(gd[sg[sg.length - 1]]).toFixed(1) + ' ' + (H - b) + 'Z';
        ice += 'M' + sg.map((i) => X(gd[i]).toFixed(1) + ' ' + Y(vals[i]).toFixed(1)).join('L') + 'L' + bx.reverse().join('L') + 'Z';
        bedLine += 'M' + sg.map((i) => X(gd[i]).toFixed(1) + ' ' + Y(bed[i]).toFixed(1)).join('L');
      }
      bedLayers = '<path d="' + rock + '" fill="#6b4f3a" fill-opacity=".9"/><path d="' + ice + '" fill="#cfeaf6" fill-opacity=".28"/>' +
        '<path d="' + bedLine + '" fill="none" stroke="#e0b088" stroke-width="1.2" vector-effect="non-scaling-stroke"/>';
      area = '';
    }
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="height:' + H + 'px">' + grid + bedLayers +
      (area ? '<path d="' + area + '" fill="rgba(108,196,255,.18)"/>' : '') +
      '<path d="' + path + '" fill="none" stroke="#6cc4ff" stroke-width="1.5" vector-effect="non-scaling-stroke"/>' +
      '<line id="phl" y1="' + t + '" y2="' + (H - b) + '" x1="-10" x2="-10" stroke="#fff" stroke-opacity=".6"/>' +
      '<text id="phov" x="' + (W - r) + '" y="10" text-anchor="end"></text></svg>';
  }

  // ---------------------------------------------------------------- measure tool
  function showMeasure(pts, live) {
    if (pts.length < 2) { if (!live) return; openPanel('Measure', '<p class="muted">Click the next point.</p>'); return; }
    const { L, G } = polyLen(pts);
    let areaHtml = '';
    if (pts.length > 2) {
      let A = 0, cx = 0, cy = 0;
      for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; A += p[0] * q[1] - q[0] * p[1]; cx += p[0]; cy += p[1]; }
      A = Math.abs(A) / 2;
      const k = scaleK(toLL(cx / pts.length, cy / pts.length)[1]);
      const Ag = A / (k * k);
      areaHtml = '<span class="k">area (closed)</span><span>' + (Ag > 1e6 ? (Ag / 1e6).toFixed(Ag > 1e8 ? 0 : 2) + ' km\u00b2' : Ag.toFixed(0) + ' m\u00b2') + ' <span class="muted">(k at centroid)</span></span>';
    }
    const first = toLL(pts[0][0], pts[0][1]), last = toLL(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    openPanel('Measure',
      '<div class="kv"><span class="k">ground</span><span>' + fmtDist(G) + '</span>' +
      '<span class="k">grid</span><span>' + fmtDist(L) + '</span>' +
      '<span class="k">vertices</span><span>' + pts.length + '</span>' + areaHtml +
      '<span class="k">from</span><span>' + fmtLL(first[0], first[1]) + '</span>' +
      '<span class="k">to</span><span>' + fmtLL(last[0], last[1]) + '</span></div>' +
      '<p class="hint">Ground length integrates the polar stereographic scale factor along each segment (straight in the map, not a geodesic).</p>');
  }

  // ---------------------------------------------------------------- box tool
  async function runBox(bb) {
    const w = bb[2] - bb[0], h = bb[3] - bb[1];
    const target = Math.max(w, h) / 1024;
    const f = finestAvailable();
    let R = Math.max(target, f ? f.res : 2);
    // snap to a "nice" resolution
    R = niceStep(R) >= R ? niceStep(R) : R;
    const nx = Math.max(1, Math.round(w / R)), ny = Math.max(1, Math.round(h / R));
    const g = { x0: bb[0], y0: bb[3], res: R, W: nx, H: ny };
    openPanel('Box', '<p class="muted">Reading ' + nx + ' x ' + ny + ' at ' + fmtRes(R) + '...</p>', true);
    const req0 = ledger.req, b0 = ledger.bytes, t0 = performance.now();
    let r;
    try { r = await getLayer('dem').load(g, { bilinear: S.bilinear }); }
    catch (e) { openPanel('Box', '<p class="bad">' + escapeHtml(e.message || e) + '</p><p class="muted">Try a smaller box or zoom in.</p>'); return; }
    const a = r.data;
    let n = 0, s = 0, s2 = 0, mn = Infinity, mxv = -Infinity;
    for (const v of a) if (v === v) { n++; s += v; s2 += v * v; if (v < mn) mn = v; if (v > mxv) mxv = v; }
    const mean = s / n, sd = Math.sqrt(Math.max(0, s2 / n - mean * mean));
    const nb = 40, hist = new Array(nb).fill(0);
    for (const v of a) if (v === v) hist[Math.min(nb - 1, Math.floor((v - mn) / ((mxv - mn) || 1) * nb))]++;
    const hm = Math.max(...hist);
    const bars = hist.map((c, i) => '<rect x="' + (i * 600 / nb + 1) + '" y="' + (110 - c / hm * 100) + '" width="' + (600 / nb - 2) + '" height="' + (c / hm * 100) + '" fill="#5ad19a"/>').join('');
    const ll0 = toLL(bb[0], bb[1]), ll1 = toLL(bb[2], bb[3]);
    const Gw = groundLen(bb[0], (bb[1] + bb[3]) / 2, bb[2], (bb[1] + bb[3]) / 2), Gh = groundLen((bb[0] + bb[2]) / 2, bb[1], (bb[0] + bb[2]) / 2, bb[3]);
    const html =
      '<div class="kv">' +
      '<span class="k">extent</span><span>' + bb.map((v) => v.toFixed(0)).join(', ') + '</span>' +
      '<span class="k">size</span><span>' + fmtDist(Gw) + ' x ' + fmtDist(Gh) + ' ground; ' + nx + ' x ' + ny + ' px at ' + fmtRes(R) + '</span>' +
      '<span class="k">level</span><span>' + escapeHtml(r.level) + ' (' + r.n + ' file' + (r.n === 1 ? '' : 's') + ')</span>' +
      '<span class="k">valid</span><span>' + n + ' / ' + a.length + ' (' + (100 * n / a.length).toFixed(1) + '%)</span>' +
      '<span class="k">min / max</span><span>' + mn.toFixed(2) + ' / ' + mxv.toFixed(2) + ' m</span>' +
      '<span class="k">mean +- sd</span><span>' + mean.toFixed(2) + ' +- ' + sd.toFixed(2) + ' m</span>' +
      '<span class="k">corners</span><span>' + fmtLL(ll0[0], ll0[1]) + '<br>' + fmtLL(ll1[0], ll1[1]) + '</span>' +
      '<span class="k">cost</span><span>' + (ledger.req - req0) + ' req, ' + fmtBytes(ledger.bytes - b0) + ', ' + (performance.now() - t0).toFixed(0) + ' ms</span>' +
      '</div>' +
      '<svg class="chart" viewBox="0 0 600 125" preserveAspectRatio="none" style="height:110px">' + bars +
      '<text x="2" y="122">' + mn.toFixed(0) + ' m</text><text x="598" y="122" text-anchor="end">' + mxv.toFixed(0) + ' m</text></svg>' +
      '<div class="btnrow"><button id="boxTif">Download GeoTIFF (' + fmtBytes(nx * ny * 4) + ')</button><button id="boxStretch">Use as colour range</button><button id="boxZoom">Zoom to box</button></div>' +
      '<div class="subh">The same box as a recipe against the DSN</div>' + recipeHtml(bb, R);
    openPanel('Box', html, true);
    bindCopyButtons($('panelBody'));
    $('boxTif').onclick = () => {
      const buf = window.writeFloat32GeoTIFF(a, nx, ny, { xmin: bb[0], ymax: bb[3], res: R, epsg: 3031, nodata: -9999 });
      download(new Blob([buf], { type: 'image/tiff' }), 'rema_' + fmtRes(R) + '_' + Math.round(bb[0]) + '_' + Math.round(bb[1]) + '.tif');
    };
    $('boxStretch').onclick = () => { setRange(mn, mxv); };
    $('boxZoom').onclick = () => {
      S.x = (bb[0] + bb[2]) / 2; S.y = (bb[1] + bb[3]) / 2;
      S.res = Math.max(w / CW, h / CH) * 1.1; viewChanged();
    };
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------------------------------------------------------------- places
  const PLACES = [
    ['Davis Station', -68.5766, 77.9674, 4, [2302286, 490792]],
    ['Mawson Station', -67.6027, 62.8738, 4],
    ['Casey Station', -66.2823, 110.5278, 4],
    ['McMurdo / Ross Island', -77.8463, 166.6682, 16],
    ['Mount Erebus', -77.5297, 167.153, 8],
    ['McMurdo Dry Valleys', -77.5, 162.0, 40],
    ['South Pole', -90, 0, 64],
    ['Vostok Station', -78.4645, 106.8373, 64],
    ['Dome A (Kunlun)', -80.4174, 77.1166, 64],
    ['Dome C (Concordia)', -75.0997, 123.3326, 64],
    ['Vinson Massif', -78.5254, -85.6171, 16],
    ['Thwaites Glacier', -75.0, -106.5, 128],
    ['Pine Island Glacier', -75.2, -100.0, 128],
    ['Lambert Glacier', -72.5, 68.5, 256],
    ['Amery Ice Shelf front', -69.3, 72.5, 128],
    ['Totten Glacier', -67.0, 116.3, 128],
    ['Denman Glacier', -66.75, 99.5, 128],
    ['Beardmore Glacier', -84.0, 170.0, 128],
    ['Rothera / Peninsula', -67.5679, -68.127, 32],
    ['Ross Ice Shelf', -81.5, -175.0, 1024],
    ['Ronne Ice Shelf', -78.5, -61.0, 1024],
    ['Dome C North (AAD Million Year Ice Core)', -75.0422, 123.6312, 30, [1360602, -905050]],
    ['Little Dome C (Beyond EPICA)', -75.29917, 122.44516, 30, [1355099, -861471]]
  ];
  function placeXY(p) { return p[4] || toXY(p[2], p[1]); }
  function goPlace(p) {
    const xy = placeXY(p);
    S.x = xy[0]; S.y = xy[1]; S.res = p[3];
    viewChanged();
  }
  function goto(text) {
    const t = text.trim();
    const p = PLACES.find((q) => q[0].toLowerCase() === t.toLowerCase()) || PLACES.find((q) => q[0].toLowerCase().includes(t.toLowerCase()) && t.length > 2);
    if (p) { goPlace(p); return; }
    const nums = t.split(/[\s,;]+/).map(Number).filter((v) => isFinite(v));
    if (nums.length >= 2) {
      if (Math.abs(nums[0]) <= 360 && Math.abs(nums[1]) <= 360) {
        // "lat lon" if first is a plausible southern latitude, else lon lat
        let lat = nums[0], lon = nums[1];
        if (Math.abs(lat) > 90 || (lat > 0 && lon < 0 && lon >= -90)) { lat = nums[1]; lon = nums[0]; }
        const xy = toXY(lon, lat); S.x = xy[0]; S.y = xy[1];
      } else { S.x = nums[0]; S.y = nums[1]; }
      if (nums[2] > 0) S.res = nums[2]; else if (S.res > 64) S.res = 32;
      viewChanged();
      return;
    }
    flash('Not found: ' + t);
  }

  // ---------------------------------------------------------------- hash
  function writeHash() {
    const q = new URLSearchParams();
    q.set('x', S.x.toFixed(0)); q.set('y', S.y.toFixed(0)); q.set('r', +S.res.toPrecision(4));
    if (S.mode !== 'colorshade') q.set('mode', S.mode);
    if (S.palette !== 'glacier') q.set('pal', S.palette);
    if (!S.autoStretch) { q.set('vmin', +S.vmin.toFixed(1)); q.set('vmax', +S.vmax.toFixed(1)); }
    if (S.stretch !== 'sqrt') q.set('st', S.stretch);
    if (S.forceLevel !== 'auto') q.set('lvl', S.forceLevel);
    if (S.cmp !== 'none') { q.set('cmp', S.cmp); q.set('cm', S.cmpMode); }
    if (S.cmp !== 'none' && GIBS[S.cmp] && GIBS[S.cmp].time) q.set('date', S.cmpDate);
    if (S.contours) q.set('cont', 1);
    if (S.bnd !== 'none') { q.set('bnd', S.bnd); if (S.bndLevel !== 'lod') q.set('bl', S.bndLevel); if (S.bndColor !== '#ff2d95') q.set('bc', S.bndColor.slice(1)); }
    if (dsnString && dsnString !== DEFAULT_DSN) q.set('dsn', dsnString);
    history.replaceState(null, '', '#' + q.toString());
  }
  function readHash() {
    const q = new URLSearchParams(location.hash.slice(1));
    const num = (k) => (q.has(k) && isFinite(+q.get(k)) ? +q.get(k) : null);
    if (num('x') !== null) S.x = num('x');
    if (num('y') !== null) S.y = num('y');
    if (num('r') !== null) S.res = clamp(num('r'), 0.25, 16384);
    if (q.get('mode')) S.mode = q.get('mode');
    if (q.get('pal') && PALETTES[q.get('pal')]) S.palette = q.get('pal');
    if (num('vmin') !== null) { S.vmin = num('vmin'); S.autoStretch = false; }
    if (num('vmax') !== null) S.vmax = num('vmax');
    if (q.get('st')) S.stretch = q.get('st');
    if (q.get('lvl')) S.forceLevel = q.get('lvl');
    if (q.get('cmp')) S.cmp = q.get('cmp');
    if (q.get('cm')) S.cmpMode = q.get('cm');
    if (q.get('date')) S.cmpDate = q.get('date');
    if (q.get('cont')) S.contours = true;
    if (q.get('bnd')) S.bnd = q.get('bnd');
    if (q.get('bl')) S.bndLevel = q.get('bl');
    if (/^[0-9a-fA-F]{6}$/.test(q.get('bc') || '')) S.bndColor = '#' + q.get('bc');
    return q.get('dsn') || DEFAULT_DSN;
  }

  // ---------------------------------------------------------------- controls
  function setRange(a, b) {
    S.autoStretch = false; $('autoStretch').checked = false;
    S.vmin = Math.floor(a); S.vmax = Math.ceil(b);
    $('vmin').value = S.vmin; $('vmax').value = S.vmax;
    updateLegend(); scheduleDraw(); writeHash();
  }
  function bindControls() {
    const pal = $('palette');
    pal.innerHTML = ['glacier', 'ice', 'terrain', 'viridis', 'magma', 'turbo', 'gray'].map((p) => '<option value="' + p + '">' + p + '</option>').join('');
    const set = (id, key, conv, after) => {
      const el = $(id);
      const v = S[key];
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
      el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'date' ? 'change' : 'input', () => {
        S[key] = el.type === 'checkbox' ? el.checked : conv ? conv(el.value) : el.value;
        if (after) after();
        updateLegend(); scheduleDraw(); writeHash();
      });
    };
    set('mode', 'mode');
    set('palette', 'palette');
    set('vmin', 'vmin', Number, () => { S.autoStretch = false; $('autoStretch').checked = false; });
    set('vmax', 'vmax', Number, () => { S.autoStretch = false; $('autoStretch').checked = false; });
    set('autoStretch', 'autoStretch', null, () => { if (S.autoStretch) computeViewStats(); });
    set('stretch', 'stretch', null, () => { if (S.stretch === 'equalize') { computeViewStats(); styleVer++; } });
    set('az', 'az', Number);
    set('alt', 'alt', Number);
    set('exag', 'exag', Number);
    set('mix', 'mix', Number);
    set('contours', 'contours');
    set('cint', 'cint', (v) => (+v > 0 ? +v : null));
    $('forceLevel').addEventListener('change', () => setPin($('forceLevel').value));
    $('pinBtn').onclick = () => {
      if (S.forceLevel !== 'auto') setPin('auto');
      else if (currentLevels[0]) setPin(currentLevels[0]);
      else flash('Nothing on screen to pin yet');
    };
    set('bilinear', 'bilinear', null, () => { store.clear(); });
    set('cmpLayer', 'cmp', null, () => { updateCompareUi(); ledgerMark(); });
    set('cmpMode', 'cmpMode');
    set('cmpOpacity', 'cmpOpacity', Number);
    set('cmpDate', 'cmpDate', null, () => ledgerMark());
    set('ovGrat', 'grat');
    set('bnd', 'bnd');
    set('bndLevel', 'bndLevel');
    set('bndColor', 'bndColor');
    $('autoRange').onclick = () => {
      computeViewStats();
      if (viewStats) setRange(viewStats.p2, viewStats.p98); else flash('Nothing on screen yet');
    };
    $('gotoBtn').onclick = () => goto($('goto').value);
    $('goto').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') goto($('goto').value); });
    $('placeList').innerHTML = PLACES.map((p) => '<option value="' + escapeHtml(p[0]) + '">').join('');
    $('placeChips').innerHTML = PLACES.slice(0, 10).map((p, i) => '<button data-i="' + i + '">' + escapeHtml(p[0]) + '</button>').join('');
    for (const b of $('placeChips').children) b.onclick = () => goPlace(PLACES[+b.dataset.i]);
    for (const b of document.querySelectorAll('.toolbar .tool')) b.onclick = () => setTool(b.dataset.tool);
    $('zoomIn').onclick = () => zoomAt(CW / 2, CH / 2, 0.5);
    $('zoomOut').onclick = () => zoomAt(CW / 2, CH / 2, 2);
    $('home').onclick = () => { S.x = 0; S.y = 300000; S.res = Math.max(5.6e6 / CW, 5.0e6 / CH); viewChanged(); };
    $('copyLink').onclick = () => { writeHash(); copyText(location.href); };
    $('dsn').value = dsnString || DEFAULT_DSN;
    $('dsnLoad').onclick = () => start($('dsn').value);
    $('dsn').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') start($('dsn').value); });
    $('sideToggle').onclick = () => { $('side').classList.add('hidden'); $('sideOpen').hidden = false; resize(); };
    $('sideOpen').onclick = () => { $('side').classList.remove('hidden'); $('sideOpen').hidden = true; resize(); };
    if (window.innerWidth < 760) { $('side').classList.add('hidden'); $('sideOpen').hidden = false; }
  }

  async function start(dsn) {
    $('dsn').value = dsn;
    try { await loadDsn(dsn); }
    catch (e) {
      const b = $('banner'); b.hidden = false; b.textContent = 'Could not load DSN: ' + (e.message || e);
      setStatusText('DSN failed');
    }
    writeHash();
  }

  // ---------------------------------------------------------------- globe
  // Drapes the styled DEM of the current view (or the whole continent) on the
  // WGS84 ellipsoid with heights along the ellipsoid normal (REMA heights are
  // ellipsoidal, so this is exact at exaggeration 1). Vertices are relative to
  // the mesh centre to keep float32 precision.
  const WGS_A = 6378137, WGS_B = 6356752.314245, WGS_E2 = 1 - (WGS_B * WGS_B) / (WGS_A * WGS_A);
  function ecef3(lon, lat, h) {
    const p = lat * DEG, l = lon * DEG;
    const N = WGS_A / Math.sqrt(1 - WGS_E2 * Math.sin(p) ** 2);
    const X = (N + h) * Math.cos(p) * Math.cos(l), Y = (N + h) * Math.cos(p) * Math.sin(l), Z = (N * (1 - WGS_E2) + h) * Math.sin(p);
    return [X, Z, -Y]; // three.js: y up = polar axis
  }
  let G3 = null;
  function globeExag() { return Math.pow(10, +$('gExag').value / 40); }

  async function initGlobe() {
    let THREE, OrbitControls;
    try {
      THREE = await import('three');
      ({ OrbitControls } = await import('three/addons/controls/OrbitControls.js'));
    } catch (e) { throw new Error('could not load three.js: ' + (e.message || e)); }
    const cv = $('globeCanvas');
    const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, logarithmicDepthBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05080d);
    const camera = new THREE.PerspectiveCamera(40, 1, 1, 1e9);
    const controls = new OrbitControls(camera, cv);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    scene.add(sun); scene.add(sun.target);
    const world = new THREE.Group();
    scene.add(world);
    const sph = new THREE.Mesh(new THREE.SphereGeometry(1, 180, 90), new THREE.MeshLambertMaterial({ color: 0x14324d }));
    sph.scale.set(WGS_A - 400, WGS_B - 400, WGS_A - 400);
    world.add(sph);
    // graticule on the ellipsoid
    const gp = [];
    const seg = (pts) => { for (let i = 1; i < pts.length; i++) gp.push(...pts[i - 1], ...pts[i]); };
    for (let lat = -85; lat <= 85; lat += 5) {
      if (lat > -50 && lat % 15) continue;
      const pts = []; for (let lon = -180; lon <= 180; lon += 2) pts.push(ecef3(lon, lat, 300)); seg(pts);
    }
    for (let lon = -180; lon < 180; lon += 15) {
      const pts = []; for (let lat = -90; lat <= 90; lat += 1) pts.push(ecef3(lon, lat, 300)); seg(pts);
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3));
    const grat = new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: 0x8aa0b4, transparent: true, opacity: 0.35 }));
    world.add(grat);
    G3 = { THREE, renderer, scene, camera, controls, sun, world, grat, sph, mesh: null, running: false };
    const ro = new ResizeObserver(() => globeResize());
    ro.observe($('globeWrap'));
    globeResize();
  }
  function globeResize() {
    if (!G3) return;
    const r = $('globeWrap').getBoundingClientRect();
    G3.renderer.setSize(r.width, r.height, false);
    G3.camera.aspect = r.width / Math.max(1, r.height);
    G3.camera.updateProjectionMatrix();
  }
  function globeLoop() {
    if (!G3 || $('globeWrap').hidden) { if (G3) G3.running = false; return; }
    G3.running = true;
    G3.controls.update();
    // headlight from a little above the camera
    G3.sun.position.copy(G3.camera.position).add(G3.camera.up.clone().multiplyScalar(G3.camera.position.length() * 0.6));
    G3.sun.target.position.copy(G3.controls.target);
    G3.renderer.render(G3.scene, G3.camera);
    requestAnimationFrame(globeLoop);
  }

  async function buildGlobe(which) {
    const info = $('gInfo');
    let bb = which === 'continent' ? [-2700000, -2500000, 2750000, 3342000] : viewBbox();
    const prof = profile && profile.bed && profile.samples ? profile : null;
    let camPt = null;   // a map point on the side the camera looks from
    if (which === 'profile') {
      if (!prof) { info.textContent = 'Draw a Profile on the map first (with the Bedmap bed loaded).'; return; }
      const xs = prof.samples.map((p) => p[0]), ys = prof.samples.map((p) => p[1]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      const half = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 0.7 + 2000;
      bb = [cx - half, cy - half, cx + half, cy + half];
      const a = prof.pts[0], z = prof.pts[prof.pts.length - 1];
      let nx0 = -(z[1] - a[1]), ny0 = z[0] - a[0];
      const nl = Math.hypot(nx0, ny0) || 1;
      camPt = [cx + nx0 / nl * half, cy + ny0 / nl * half];
    }
    G3.lastWhich = which;
    const T = +$('gTex').value, M = +$('gMesh').value;
    const w = bb[2] - bb[0], h = bb[3] - bb[1];
    const R = Math.max(w, h) / T;
    const nx = Math.max(8, Math.round(w / R)), ny = Math.max(8, Math.round(h / R));
    const g = { x0: bb[0] - R, y0: bb[3] + R, res: R, W: nx + 2, H: ny + 2 };
    info.textContent = 'reading ' + nx + ' x ' + ny + ' at ' + fmtRes(R) + ' ...';
    const req0 = ledger.req, b0 = ledger.bytes, t0 = performance.now();
    let r;
    try { r = await getLayer('dem').load(g, { bilinear: S.bilinear }); }
    catch (e) { info.textContent = 'read failed: ' + (e.message || e); return; }
    const data = r.data;
    // texture: the current 2D style
    const tc = document.createElement('canvas');
    tc.width = nx; tc.height = ny;
    const tctx = tc.getContext('2d');
    const img = tctx.createImageData(nx, ny);
    renderImage(data, nx, ny, 1, R, 'dem', img.data);
    tctx.putImageData(img, 0, 0);
    // mesh heights
    const mx = M, my = Math.max(2, Math.round(M * ny / nx));
    const hts = new Float32Array(mx * my), xy = new Float64Array(mx * my * 2);
    const W2 = nx + 2;
    for (let j = 0; j < my; j++) for (let i = 0; i < mx; i++) {
      const X = bb[0] + (i / (mx - 1)) * w, Y = bb[3] - (j / (my - 1)) * h;
      const c = clamp(Math.floor((X - g.x0) / R), 0, nx + 1), rr = clamp(Math.floor((g.y0 - Y) / R), 0, ny + 1);
      hts[j * mx + i] = data[rr * W2 + c];
      xy[(j * mx + i) * 2] = X; xy[(j * mx + i) * 2 + 1] = Y;
    }
    // cutaway: drop the terrain on the camera side of the profile line
    const cutMode = $('gCut').value;
    const useWall = prof && cutMode !== 'off' && prof.samples.every((p) => p[0] > bb[0] && p[0] < bb[2] && p[1] > bb[1] && p[1] < bb[3]);
    if (!camPt) camPt = [(bb[0] + bb[2]) / 2, bb[1]];
    let keep = null;
    if (useWall && cutMode === 'cut') {
      const pts = prof.pts;
      const side = (x, y) => {
        let best = Infinity, sgn = 0;
        for (let k = 1; k < pts.length; k++) {
          const ax = pts[k - 1][0], ay = pts[k - 1][1], dx = pts[k][0] - ax, dy = pts[k][1] - ay;
          const L2 = dx * dx + dy * dy || 1;
          const t = clamp(((x - ax) * dx + (y - ay) * dy) / L2, 0, 1);
          const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
          if (d < best) { best = d; sgn = Math.sign(dx * (y - ay) - dy * (x - ax)); }
        }
        return sgn;
      };
      const camSide = side(camPt[0], camPt[1]);
      keep = new Int8Array(mx * my);
      for (let k = 0; k < mx * my; k++) keep[k] = side(xy[k * 2], xy[k * 2 + 1]) !== camSide ? 1 : 0;
    }
    const idx = [];
    for (let j = 0; j < my - 1; j++) for (let i = 0; i < mx - 1; i++) {
      const a = j * mx + i, b = a + 1, c = a + mx, d = c + 1;
      if (hts[a] !== hts[a] || hts[b] !== hts[b] || hts[c] !== hts[c] || hts[d] !== hts[d]) continue;
      if (keep && keep[a] + keep[b] + keep[c] + keep[d] < 3) continue;
      idx.push(a, c, b, b, c, d);
    }
    const { THREE } = G3;
    const cll = toLL((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2);
    const origin = ecef3(cll[0], cll[1], 0);
    const uv = new Float32Array(mx * my * 2);
    for (let j = 0; j < my; j++) for (let i = 0; i < mx; i++) { uv[(j * mx + i) * 2] = i / (mx - 1); uv[(j * mx + i) * 2 + 1] = 1 - j / (my - 1); }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mx * my * 3), 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geom.setIndex(idx);
    const tex = new THREE.CanvasTexture(tc);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mat = new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide });
    if (G3.mesh) { G3.world.parent.remove(G3.mesh); G3.mesh.geometry.dispose(); G3.mesh.material.map.dispose(); G3.mesh.material.dispose(); }
    const mesh = new THREE.Mesh(geom, mat);
    G3.scene.add(mesh);
    G3.mesh = mesh;
    const hs = Array.from(hts).filter((v) => v === v).sort((p, q) => p - q);
    const centerH = hs.length ? hs[Math.floor(hs.length / 2)] : 0;
    G3.grid = { hts, xy, mx, my, origin, w, h, bb, centerH, up: new THREE.Vector3(...origin).normalize() };
    if (which === 'profile' && prof) {
      // open the cutaway so the ice column is about a third of the profile length
      const sf = prof.vals.filter((v) => v === v), bf = prof.bed.filter((v) => v === v);
      const depth = Math.max(100, Math.max(...sf) - Math.min(...bf));
      const ex0 = clamp((prof.G || w) * 0.33 / depth, 1, 300);
      $('gExag').value = Math.round(40 * Math.log10(ex0));
    }
    G3.world.position.set(-origin[0], -origin[1], -origin[2]);
    // the wall: ice from REMA surface down to the Bedmap bed, rock below
    if (G3.wall) { G3.scene.remove(G3.wall); G3.wall.geometry.dispose(); G3.wall.material.dispose(); G3.wall = null; }
    if (useWall) {
      const n = prof.samples.length;
      const bf = prof.bed.filter((v) => v === v), sf = prof.vals.filter((v) => v === v);
      const base = Math.min(...bf) - 0.35 * (Math.max(...sf) - Math.min(...bf));
      const wcol = new Float32Array(n * 4 * 3);
      const ice = [0.80, 0.91, 0.97], ice2 = [0.55, 0.75, 0.88], rock = [0.50, 0.37, 0.27], rock2 = [0.30, 0.22, 0.16];
      for (let k = 0; k < n; k++) {
        [ice, ice2, rock, rock2].forEach((c, q) => wcol.set(c, (k * 4 + q) * 3));
      }
      const widx = [];
      for (let k = 0; k < n - 1; k++) {
        const ok = (i) => prof.vals[i] === prof.vals[i] && prof.bed[i] === prof.bed[i];
        if (!ok(k) || !ok(k + 1)) continue;
        const a = k * 4, b = (k + 1) * 4;
        widx.push(a, a + 1, b, b, a + 1, b + 1);           // ice: top -> bed
        widx.push(a + 2, a + 3, b + 2, b + 2, a + 3, b + 3); // rock: bed -> base
      }
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 4 * 3), 3));
      wg.setAttribute('color', new THREE.BufferAttribute(wcol, 3));
      wg.setIndex(widx);
      G3.wall = new THREE.Mesh(wg, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
      G3.wall.userData = { samples: prof.samples, vals: prof.vals, bed: prof.bed, base };
      G3.scene.add(G3.wall);
    }
    setGlobeHeights();
    // camera: above the centre, tilted to look from the "bottom" of the map view
    const up = new THREE.Vector3(...origin).normalize();
    const llb = toLL(camPt[0], camPt[1]);
    const pb = ecef3(llb[0], llb[1], 0);
    const down = new THREE.Vector3(pb[0] - origin[0], pb[1] - origin[1], pb[2] - origin[2]).normalize();
    const D = Math.max(w, h) * 1.15;
    G3.camera.up.copy(up);
    G3.camera.position.copy(up.clone().multiplyScalar(D * 0.8).add(down.clone().multiplyScalar(D * 0.75)));
    G3.camera.near = Math.max(1, D / 5000);
    G3.camera.updateProjectionMatrix();
    G3.controls.target.set(0, 0, 0);
    G3.targetH = 0;
    G3.controls.minDistance = Math.max(50, D / 200);
    G3.controls.maxDistance = 4e7;
    retargetGlobe();
    G3.controls.update();
    info.textContent = (useWall ? 'cutaway along the profile, bed from Bedmap2 (geoid heights) | ' : (prof && cutMode !== 'off' ? 'profile not inside this view, no cutaway | ' : '')) +
      nx + ' x ' + ny + ' texture at ' + fmtRes(R) + ' from level ' + r.level + ' (' + r.n + ' file' + (r.n === 1 ? '' : 's') + '), ' + mx + ' x ' + my + ' mesh | ' +
      (ledger.req - req0) + ' req, ' + fmtBytes(ledger.bytes - b0) + ', ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s';
    if (!G3.running) globeLoop();
  }
  function setGlobeHeights() {
    if (!G3 || !G3.grid) return;
    const { hts, xy, mx, my, origin } = G3.grid;
    const ex = globeExag();
    $('gExagLab').textContent = ex.toFixed(ex < 10 ? 1 : 0) + 'x';
    const pos = G3.mesh.geometry.attributes.position.array;
    for (let k = 0; k < mx * my; k++) {
      const ll = toLL(xy[k * 2], xy[k * 2 + 1]);
      const hv = hts[k];
      const p = ecef3(ll[0], ll[1], (hv === hv ? hv : 0) * ex);
      pos[k * 3] = p[0] - origin[0]; pos[k * 3 + 1] = p[1] - origin[1]; pos[k * 3 + 2] = p[2] - origin[2];
    }
    // keep the base ellipsoid under the lowest (geoid-negative) sea surface at this exaggeration
    const drop = 120 + 90 * ex;
    G3.sph.scale.set(WGS_A - drop, WGS_B - drop, WGS_A - drop);
    G3.mesh.geometry.attributes.position.needsUpdate = true;
    G3.mesh.geometry.computeVertexNormals();
    G3.mesh.geometry.computeBoundingSphere();
    if (G3.wall) {
      const { samples, vals, bed, base } = G3.wall.userData;
      const wp = G3.wall.geometry.attributes.position.array;
      samples.forEach((p, k) => {
        const ll = toLL(p[0], p[1]);
        const top = vals[k] === vals[k] ? vals[k] : 0, bd = bed[k] === bed[k] ? bed[k] : top;
        [top, bd, bd, base].forEach((hv, q) => {
          const e = ecef3(ll[0], ll[1], hv * ex);
          wp.set([e[0] - origin[0], e[1] - origin[1], e[2] - origin[2]], (k * 4 + q) * 3);
        });
      });
      G3.wall.geometry.attributes.position.needsUpdate = true;
      G3.wall.geometry.computeBoundingSphere();
    }
  }
  // keep the orbit centre on the (exaggerated) surface at the mesh centre
  function retargetGlobe() {
    if (!G3 || !G3.grid) return;
    const hNew = G3.grid.centerH * globeExag();
    const d = G3.grid.up.clone().multiplyScalar(hNew - (G3.targetH || 0));
    G3.controls.target.add(d);
    G3.camera.position.add(d);
    G3.targetH = hNew;
  }
  async function openGlobe(which) {
    $('globeWrap').hidden = false;
    $('globeBtn').classList.add('on');
    try {
      if (!G3) { $('gInfo').textContent = 'loading three.js ...'; await initGlobe(); }
      await buildGlobe(which);
    } catch (e) { $('gInfo').textContent = String(e.message || e); }
  }
  function closeGlobe() {
    $('globeWrap').hidden = true;
    $('globeBtn').classList.remove('on');
  }
  function bindGlobe() {
    $('globeBtn').onclick = () => ($('globeWrap').hidden ? openGlobe('view') : closeGlobe());
    $('gClose').onclick = closeGlobe;
    $('gView').onclick = () => { closeGlobe(); flash('Frame the view you want, then press Globe again', 2500); };
    $('gRebuild').onclick = () => buildGlobe(G3 && G3.lastWhich === 'profile' ? 'profile' : 'view');
    $('gCut').addEventListener('change', () => { if (G3) buildGlobe(G3.lastWhich || 'view'); });
    $('gCont').onclick = () => buildGlobe('continent');
    $('gExag').addEventListener('input', () => { setGlobeHeights(); retargetGlobe(); });
    $('gExag').addEventListener('change', () => { setGlobeHeights(); retargetGlobe(); });
  }

  // ---------------------------------------------------------------- go
  const initialDsn = readHash();
  bindControls();
  bindGlobe();
  resize();
  if (!location.hash) S.res = Math.max(5.6e6 / CW, 5.0e6 / CH);
  updateLegend();
  $('readout').textContent = readoutIdle();
  // expose for console poking
  window.rema = { S, levels: () => levels, store, ledger, openCog, readLevel, chooseLevel, dsnToUrl };
  start(initialDsn);
})();
