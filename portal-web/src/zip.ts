const encoder = new TextEncoder();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, value >>> 8 & 0xff]);
}

function u32(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff]);
}

function join(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

function dosTime(date: Date): { time: number; day: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function createZipBlob(files: Array<{ name: string; text: string }>): Blob {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  const timestamp = dosTime(new Date());
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.text);
    const checksum = crc32(data);
    const local = join([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(timestamp.time), u16(timestamp.day),
      u32(checksum), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data,
    ]);
    localParts.push(local);
    centralParts.push(join([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(timestamp.time), u16(timestamp.day),
      u32(checksum), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ]));
    offset += local.length;
  }
  const central = join(centralParts);
  const archive = join([
    ...localParts,
    central,
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(central.length), u32(offset), u16(0),
  ]);
  return new Blob([archive.buffer as ArrayBuffer], { type: "application/zip" });
}
