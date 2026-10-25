/**
 * Minimal ZIP reader for GitHub Actions artifact downloads. It lists entries from the central directory
 * (no full read) and extracts one entry with the browser's own inflater, checking CRC-32 and size.
 * Supports stored and deflated entries, data descriptors and ZIP64; rejects encrypted entries.
 */
export type ZipEntry = { name: string; method: number; crc: number; compressedSize: number; size: number; offset: number };

const u16 = (view: DataView, at: number) => view.getUint16(at, true);
const u32 = (view: DataView, at: number) => view.getUint32(at, true);
const u64 = (view: DataView, at: number) => Number(view.getBigUint64(at, true));
const bytes = async (blob: Blob, start: number, end: number) => new DataView(await blob.slice(start, end).arrayBuffer());

export async function zipEntries(archive: Blob): Promise<ZipEntry[]> {
  const tailStart = Math.max(0, archive.size - 65557), tail = await bytes(archive, tailStart, archive.size);
  let eocd = -1;
  for (let at = tail.byteLength - 22; at >= 0; at--) if (u32(tail, at) === 0x06054b50) { eocd = at; break; }
  if (eocd < 0) throw new Error("Not a ZIP archive");
  let count = u16(tail, eocd + 10), dirSize = u32(tail, eocd + 12), dirOffset = u32(tail, eocd + 16);
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
    if (eocd < 20 || u32(tail, eocd - 20) !== 0x07064b50) throw new Error("Invalid ZIP64 archive");
    const record = await bytes(archive, u64(tail, eocd - 12), u64(tail, eocd - 12) + 56);
    if (u32(record, 0) !== 0x06064b50) throw new Error("Invalid ZIP64 archive");
    count = u64(record, 32); dirSize = u64(record, 40); dirOffset = u64(record, 48);
  }
  const dir = await bytes(archive, dirOffset, dirOffset + dirSize), names = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let at = 0, n = 0; n < count; n++) {
    if (at + 46 > dir.byteLength || u32(dir, at) !== 0x02014b50) throw new Error("Invalid ZIP directory");
    const nameLength = u16(dir, at + 28), extraLength = u16(dir, at + 30), commentLength = u16(dir, at + 32);
    const name = names.decode(new Uint8Array(dir.buffer, at + 46, nameLength));
    let compressedSize = u32(dir, at + 20), size = u32(dir, at + 24), offset = u32(dir, at + 42);
    // ZIP64 extra field: only the values saturated in the fixed header are present, in this order.
    for (let extra = at + 46 + nameLength, end = extra + extraLength; extra + 4 <= end; extra += 4 + u16(dir, extra + 2)) {
      if (u16(dir, extra) !== 1) continue;
      let field = extra + 4;
      if (size === 0xffffffff) { size = u64(dir, field); field += 8; }
      if (compressedSize === 0xffffffff) { compressedSize = u64(dir, field); field += 8; }
      if (offset === 0xffffffff) offset = u64(dir, field);
    }
    if (!name.endsWith("/")) {
      if (u16(dir, at + 8) & 1) throw new Error("Encrypted ZIP entries are not supported");
      entries.push({ name, method: u16(dir, at + 10), crc: u32(dir, at + 16), compressedSize, size, offset });
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

let crcTable: Uint32Array | undefined;
function crc32(data: Uint8Array) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Returns the entry's bytes after checking its size and CRC-32 against the directory. */
export async function extractEntry(archive: Blob, entry: ZipEntry): Promise<ArrayBuffer> {
  const local = await bytes(archive, entry.offset, entry.offset + 30);
  if (u32(local, 0) !== 0x04034b50) throw new Error("Invalid ZIP entry");
  const start = entry.offset + 30 + u16(local, 26) + u16(local, 28), compressed = archive.slice(start, start + entry.compressedSize);
  let data: ArrayBuffer;
  if (entry.method === 0) data = await compressed.arrayBuffer();
  else if (entry.method === 8) data = await new Response(compressed.stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
  else throw new Error("Unsupported ZIP compression");
  if (data.byteLength !== entry.size || crc32(new Uint8Array(data)) !== entry.crc) throw new Error("ZIP entry is corrupted");
  return data;
}
