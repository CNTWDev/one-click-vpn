import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { extractEntry, zipEntries } from "../admin-web/src/zip.ts";

// Archives are written by Python's zipfile: deflated and stored entries, a folder, ZIP64 records, and a
// streamed archive with data descriptors (how GitHub Actions artifact downloads are built).
const makeZip = (mode, payload) => execFileSync("python3", ["-I", "-c", `
import io, sys, zipfile
data = sys.stdin.buffer.read()
mode = sys.argv[1]
class Stream(io.RawIOBase):
    def __init__(self): self.out = bytearray()
    def writable(self): return True
    def write(self, b): self.out += b; return len(b)
target = Stream() if mode == "stream" else io.BytesIO()
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("dist/", b"")
    with z.open("dist/TrackNothing-1.0.0-42.apk", "w", force_zip64=(mode == "zip64")) as f: f.write(data)
    z.writestr(zipfile.ZipInfo("notes.txt"), b"stored", compress_type=zipfile.ZIP_STORED)
sys.stdout.buffer.write(bytes(target.out) if mode == "stream" else target.getvalue())
`, mode], { input: payload, maxBuffer: 64 * 1024 * 1024 });

for (const mode of ["plain", "stream", "zip64"]) {
  test(`artifact ZIP (${mode}): lists installers and extracts them byte for byte`, { skip: !hasPython() }, async () => {
    const payload = Buffer.concat([randomBytes(300_000), Buffer.alloc(700_000, 7)]);
    const archive = new Blob([makeZip(mode, payload)]);
    const entries = await zipEntries(archive);
    assert.deepEqual(entries.map((entry) => entry.name), ["dist/TrackNothing-1.0.0-42.apk", "notes.txt"]);
    const apk = Buffer.from(await extractEntry(archive, entries[0]));
    assert.equal(createHash("sha256").update(apk).digest("hex"), createHash("sha256").update(payload).digest("hex"));
    assert.equal(Buffer.from(await extractEntry(archive, entries[1])).toString(), "stored");
  });
}

test("corrupted or non-ZIP input is rejected", { skip: !hasPython() }, async () => {
  await assert.rejects(zipEntries(new Blob([randomBytes(2048)])), /Not a ZIP/);
  const bytes = makeZip("plain", Buffer.alloc(50_000, 1));
  const entries = await zipEntries(new Blob([bytes]));
  bytes[entries[0].offset + 80] ^= 0xff;
  await assert.rejects(extractEntry(new Blob([bytes]), entries[0]));
});

function hasPython() {
  try { execFileSync("python3", ["-I", "-c", "pass"]); return true; } catch { return false; }
}
