import { createHash, createPublicKey, verify } from "node:crypto";

export class NativeError extends Error {
  constructor(public code: string, public status = 400, public details: Record<string, unknown> = {}) { super(code); }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function identity(raw: unknown) {
  const key = raw as Record<string, unknown> | null;
  if (!key || key.kty !== "EC" || key.crv !== "P-256" || typeof key.x !== "string" || typeof key.y !== "string"
    || !/^[A-Za-z0-9_-]{43}$/.test(key.x) || !/^[A-Za-z0-9_-]{43}$/.test(key.y) || "d" in key) throw new NativeError("PROOF_INVALID");
  const jwk = { kty: "EC", crv: "P-256", x: key.x, y: key.y };
  try { createPublicKey({ key: jwk, format: "jwk" }); } catch { throw new NativeError("PROOF_INVALID"); }
  return { jwk, thumbprint: digest(canonical(jwk)) };
}
export function verifyNativeProof(jwk: string, payload: string, signature: unknown): boolean {
  try {
    if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
    return verify("sha256", Buffer.from(payload, "base64url"), { key: createPublicKey({ key: JSON.parse(jwk), format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
  } catch { return false; }
}
