// Minimal, dependency-free ZIP writer (store method) so the browser can offer
// "download the generated datapack" without any third-party library.
// Output is a real .zip: drop it into saves/<world>/datapacks/ and /reload.
const encoder = new TextEncoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Fixed DOS timestamp (2026-01-01 00:00) keeps archives deterministic.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function writeU16(view, offset, value) {
  view.setUint16(offset, value, true);
  return offset + 2;
}
function writeU32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
  return offset + 4;
}

/**
 * Pack a virtual datapack into a .zip (store / no compression).
 * @param {Record<string, string>} files pack-relative path -> text content
 * @returns {Uint8Array}
 */
export function packToZip(files) {
  const names = Object.keys(files).sort();
  const entries = names.map((name) => {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(files[name]);
    return { nameBytes, data, crc: crc32(data), offset: 0 };
  });

  let localSize = 0;
  for (const e of entries) localSize += 30 + e.nameBytes.length + e.data.length;
  const centralSize = entries.reduce((n, e) => n + 46 + e.nameBytes.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let pos = 0;

  for (const e of entries) {
    e.offset = pos;
    pos = writeU32(view, pos, 0x04034b50); // local file header
    pos = writeU16(view, pos, 20); // version needed
    pos = writeU16(view, pos, 0x0800); // UTF-8 names
    pos = writeU16(view, pos, 0); // method = store
    pos = writeU16(view, pos, DOS_TIME);
    pos = writeU16(view, pos, DOS_DATE);
    pos = writeU32(view, pos, e.crc);
    pos = writeU32(view, pos, e.data.length); // compressed
    pos = writeU32(view, pos, e.data.length); // uncompressed
    pos = writeU16(view, pos, e.nameBytes.length);
    pos = writeU16(view, pos, 0); // extra
    out.set(e.nameBytes, pos);
    pos += e.nameBytes.length;
    out.set(e.data, pos);
    pos += e.data.length;
  }

  const centralStart = pos;
  for (const e of entries) {
    pos = writeU32(view, pos, 0x02014b50); // central directory header
    pos = writeU16(view, pos, 20); // version made by
    pos = writeU16(view, pos, 20); // version needed
    pos = writeU16(view, pos, 0x0800);
    pos = writeU16(view, pos, 0);
    pos = writeU16(view, pos, DOS_TIME);
    pos = writeU16(view, pos, DOS_DATE);
    pos = writeU32(view, pos, e.crc);
    pos = writeU32(view, pos, e.data.length);
    pos = writeU32(view, pos, e.data.length);
    pos = writeU16(view, pos, e.nameBytes.length);
    pos = writeU16(view, pos, 0); // extra
    pos = writeU16(view, pos, 0); // comment
    pos = writeU16(view, pos, 0); // disk
    pos = writeU16(view, pos, 0); // internal attrs
    pos = writeU32(view, pos, 0); // external attrs
    pos = writeU32(view, pos, e.offset);
    out.set(e.nameBytes, pos);
    pos += e.nameBytes.length;
  }

  // end of central directory
  const centralEnd = pos;
  pos = writeU32(view, pos, 0x06054b50);
  pos = writeU16(view, pos, 0); // disk
  pos = writeU16(view, pos, 0); // cd disk
  pos = writeU16(view, pos, entries.length);
  pos = writeU16(view, pos, entries.length);
  pos = writeU32(view, pos, centralEnd - centralStart); // cd size
  pos = writeU32(view, pos, centralStart); // cd offset
  pos = writeU16(view, pos, 0); // comment length

  return out.subarray(0, pos);
}
