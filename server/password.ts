import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;
// Verified against when an account does not exist, so a miss costs as much as a wrong password.
const DUMMY_HASH = `scrypt:${randomBytes(16).toString("base64url")}:${randomBytes(KEY_LENGTH).toString("base64url")}`;

function scryptAsync(password: string, salt: Buffer, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, length, (error, derived) => error ? reject(error) : resolve(derived)));
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEY_LENGTH);
  return `scrypt:${salt.toString("base64url")}:${derived.toString("base64url")}`;
}

export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt:${salt.toString("base64url")}:${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string | undefined | null): Promise<boolean> {
  const [algorithm, saltValue, hashValue] = (encoded || DUMMY_HASH).split(":");
  if (algorithm !== "scrypt" || !saltValue || !hashValue) return false;
  try {
    const expected = Buffer.from(hashValue, "base64url");
    const actual = await scryptAsync(password, Buffer.from(saltValue, "base64url"), expected.length);
    return timingSafeEqual(actual, expected) && Boolean(encoded);
  } catch {
    return false;
  }
}
