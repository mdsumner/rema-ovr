// Minimal single-band Float32 GeoTIFF writer (uncompressed, one strip).
// Enough to hand a browser-read window to GDAL/R/Python with its georeferencing.
(function (root) {
  'use strict';

  function writeFloat32GeoTIFF(values, width, height, opts) {
    // opts: { xmin, ymax, res, epsg, nodata }
    const epsg = opts.epsg || 3031;
    const nodataStr = String(opts.nodata == null ? -9999 : opts.nodata) + '\0';
    const geoKeys = [
      1, 1, 0, 3,            // header: version 1.1.0, 3 keys
      1024, 0, 1, 1,         // GTModelTypeGeoKey = projected
      1025, 0, 1, 1,         // GTRasterTypeGeoKey = PixelIsArea
      3072, 0, 1, epsg       // ProjectedCSTypeGeoKey
    ];
    // tag: [code, type, count, valueArrayOrNumber]
    // types: 2 ASCII, 3 SHORT, 4 LONG, 12 DOUBLE
    const dataBytes = width * height * 4;
    const tags = [
      [256, 4, 1, width],
      [257, 4, 1, height],
      [258, 3, 1, 32],
      [259, 3, 1, 1],
      [262, 3, 1, 1],
      [273, 4, 1, 0],           // StripOffsets, patched below
      [277, 3, 1, 1],
      [278, 4, 1, height],
      [279, 4, 1, dataBytes],
      [284, 3, 1, 1],
      [339, 3, 1, 3],
      [33550, 12, 3, [opts.res, opts.res, 0]],
      [33922, 12, 6, [0, 0, 0, opts.xmin, opts.ymax, 0]],
      [34735, 3, geoKeys.length, geoKeys],
      [42113, 2, nodataStr.length, nodataStr]
    ];
    const typeSize = { 2: 1, 3: 2, 4: 4, 12: 8 };
    const ifdSize = 2 + tags.length * 12 + 4;
    const ifdOffset = 8;
    let extraOffset = ifdOffset + ifdSize;
    // lay out out-of-line values
    const extras = [];
    for (const t of tags) {
      const n = t[2] * typeSize[t[1]];
      if (n > 4) {
        if (extraOffset % 2) extraOffset++;
        t.push(extraOffset);
        extras.push(t);
        extraOffset += n;
      }
    }
    if (extraOffset % 4) extraOffset += 4 - (extraOffset % 4);
    const dataOffset = extraOffset;
    for (const t of tags) if (t[0] === 273) t[3] = dataOffset;

    const buf = new ArrayBuffer(dataOffset + dataBytes);
    const dv = new DataView(buf);
    const LE = true;
    dv.setUint16(0, 0x4949, LE); // 'II'
    dv.setUint16(2, 42, LE);
    dv.setUint32(4, ifdOffset, LE);
    dv.setUint16(ifdOffset, tags.length, LE);

    function writeValues(off, type, vals) {
      if (type === 2) {
        for (let i = 0; i < vals.length; i++) dv.setUint8(off + i, vals.charCodeAt(i));
        return;
      }
      const arr = Array.isArray(vals) ? vals : [vals];
      for (let i = 0; i < arr.length; i++) {
        if (type === 3) dv.setUint16(off + i * 2, arr[i], LE);
        else if (type === 4) dv.setUint32(off + i * 4, arr[i], LE);
        else if (type === 12) dv.setFloat64(off + i * 8, arr[i], LE);
      }
    }

    let p = ifdOffset + 2;
    for (const t of tags) {
      dv.setUint16(p, t[0], LE);
      dv.setUint16(p + 2, t[1], LE);
      dv.setUint32(p + 4, t[2], LE);
      const n = t[2] * typeSize[t[1]];
      if (n > 4) {
        dv.setUint32(p + 8, t[4], LE);
        writeValues(t[4], t[1], t[3]);
      } else {
        writeValues(p + 8, t[1], t[3]);
      }
      p += 12;
    }
    dv.setUint32(p, 0, LE); // no next IFD

    const nd = opts.nodata == null ? -9999 : opts.nodata;
    for (let i = 0; i < width * height; i++) {
      const v = values[i];
      dv.setFloat32(dataOffset + i * 4, Number.isFinite(v) ? v : nd, LE);
    }
    return buf;
  }

  root.writeFloat32GeoTIFF = writeFloat32GeoTIFF;
})(typeof window !== 'undefined' ? window : globalThis);
