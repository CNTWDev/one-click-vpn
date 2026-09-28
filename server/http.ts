import { NextResponse } from "next/server";

export function jsonError(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

const MAX_JSON_BYTES = 64 * 1024;

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_JSON_BYTES) throw new Error("Request body is too large");
  // Content-Length is absent on chunked uploads, so enforce the cap while reading.
  const chunks: Uint8Array[] = [];
  let received = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new Error("Request body is too large");
      }
      chunks.push(value);
    }
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Request body must be a JSON object");
  return body as Record<string, unknown>;
}

export function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function isValidIp(value: string): boolean {
  return /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.|$)){4}$/.test(value);
}

export function isValidPort(value: unknown): number {
  const port = Number(value || 22);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 22;
}
