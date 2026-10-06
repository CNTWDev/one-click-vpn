import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { localArtifact } from "../../../../../../server/client-releases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Installers kept on the Controller's data volume (local release storage). Builds are immutable. */
export async function GET(request: Request, context: { params: Promise<{ key: string[] }> }) {
  const key = (await context.params).key.join("/");
  try {
    const artifact = await localArtifact(key, request);
    const info = artifact && await stat(artifact.file).catch(() => null);
    if (!artifact || !info?.isFile()) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    const name = key.split("/").pop()!;
    return new Response(Readable.toWeb(createReadStream(artifact.file)) as ReadableStream, { headers: {
      "Content-Type": "application/octet-stream", "Content-Length": String(info.size),
      "Content-Disposition": `attachment; filename="${name}"`, "X-Content-Type-Options": "nosniff",
      "Cache-Control": artifact.published ? "public, max-age=31536000, immutable" : "no-store",
    } });
  } catch {
    return NextResponse.json({ code: "CLIENT_RELEASES_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
