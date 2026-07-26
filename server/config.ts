function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function sessionTtlSeconds(): number {
  const value = Number(process.env.NORTHSTAR_SESSION_TTL_SECONDS || 60 * 60 * 12);
  return Number.isFinite(value) && value > 300 ? value : 60 * 60 * 12;
}

export function adminSeed(): { email: string; password: string; displayName: string } | null {
  const email = process.env.NORTHSTAR_ADMIN_EMAIL?.trim();
  const password = process.env.NORTHSTAR_ADMIN_PASSWORD;
  if (!email || !password) return null;
  return {
    email: email.toLowerCase(),
    password,
    displayName: process.env.NORTHSTAR_ADMIN_NAME?.trim() || "Owner",
  };
}

export function masterKey(): Buffer {
  const raw = process.env.NORTHSTAR_MASTER_KEY?.trim();
  if (raw) {
    const key = /^[0-9a-f]{64}$/i.test(raw)
      ? Buffer.from(raw, "hex")
      : Buffer.from(raw, "base64");
    if (key.length === 32) return key;
    throw new Error("NORTHSTAR_MASTER_KEY must decode to exactly 32 bytes");
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("NORTHSTAR_MASTER_KEY is required in production");
  }

  return Buffer.from("northstar-local-development-key-32", "utf8").subarray(0, 32);
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export function allowTofuHostKeys(): boolean {
  return process.env.NORTHSTAR_ALLOW_TOFU_HOST_KEYS === "true" && !isProduction();
}

export function publicOrigin(): string {
  const value = process.env.NORTHSTAR_PUBLIC_ORIGIN?.trim();
  if (isProduction() && !value) throw new Error("NORTHSTAR_PUBLIC_ORIGIN is required in production");
  return value || "http://localhost:3000";
}

/** The origin used by native clients and the Agent gateway. */
export function apiOrigin(): string {
  const value = process.env.NORTHSTAR_API_ORIGIN?.trim();
  return value || publicOrigin();
}

/** Kept separate so the Agent can move to its own hostname without changing client URLs. */
export function agentOrigin(): string {
  const value = process.env.NORTHSTAR_AGENT_ORIGIN?.trim();
  return value || apiOrigin();
}

export function requireProductionSecret(name: string): string {
  if (!isProduction()) return process.env[name] || "development-only";
  return required(name);
}
