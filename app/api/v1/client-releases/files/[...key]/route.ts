import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { localArtifact } from "../../../../../../server/client-releases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Installers kept on the Controller's data volume (local release storage). Builds are immutable, so a
 * Range request (`bytes=N-` or `bytes=N-M`) resumes a broken download where it stopped.
 */
export async function GET(request: Request, context: { params: Promise<{ key: string[] }> }) {
  const key = (await context.params).key.join("/");
  try {
    const artifact = await localArtifact(key, request);
    const info = artifact && await stat(artifact.file).catch(() => null);
    if (!artifact || !info?.isFile()) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    const name = key.split("/").pop()!;
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes",
      "Content-Disposition": `attachment; filename="${name}"`, "X-Content-Type-Options": "nosniff",
      "Cache-Control": artifact.published ? "public, max-age=31536000, immutable" : "no-store",
    };
    const range = request.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
    if (range) {
      const start = Number(range[1]), end = Math.min(range[2] ? Number(range[2]) : info.size - 1, info.size - 1);
      if (start >= info.size || start > end) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${info.size}` } });
      return new Response(Readable.toWeb(createReadStream(artifact.file, { start, end })) as ReadableStream, { status: 206,
        headers: { ...headers, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${info.size}` } });
    }
    return new Response(Readable.toWeb(createReadStream(artifact.file)) as ReadableStream, { headers: { ...headers, "Content-Length": String(info.size) } });
  } catch {
    return NextResponse.json({ code: "CLIENT_RELEASES_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
