import { createHash } from "node:crypto";

/** @param {Buffer} key */
export function fingerprintForms(key) {
  const digest = createHash("sha256").update(key).digest();
  return {
    standard: digest.toString("base64").replace(/=+$/, ""),
    hex: digest.toString("hex").toLowerCase(),
  };
}

/** @param {string} value */
export function normalizeFingerprint(value) {
  const input = value.trim();
  const sha256 = input.match(/SHA256:([A-Za-z0-9+/]+={0,2})/i);
  if (sha256) return sha256[1].replace(/=+$/, "");
  const hex = input.match(/(?:^|\s)([a-f0-9]{64})(?:\s|$)/i);
  if (hex) return hex[1].toLowerCase();
  return input.replace(/^sha256:/i, "").replace(/=+$/, "");
}

/** @param {string} value */
function isHexFingerprint(value) {
  return /^[a-f0-9]{64}$/i.test(value);
}

/** @param {string} value */
function isLegacyLowercasedSha256(value) {
  return !isHexFingerprint(value) && value === value.toLowerCase();
}

/** @param {string} left @param {string} right */
export function fingerprintsEqual(left, right) {
  const normalizedLeft = normalizeFingerprint(left);
  const normalizedRight = normalizeFingerprint(right);
  if (normalizedLeft === normalizedRight) return true;
  if (isHexFingerprint(normalizedLeft) && isHexFingerprint(normalizedRight)) {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  // Releases before node identity discovery lowercased Base64 fingerprints.
  // Keep them usable long enough for the next verified connection to replace
  // the stored value with the canonical, case-sensitive OpenSSH form.
  return (isLegacyLowercasedSha256(normalizedLeft) || isLegacyLowercasedSha256(normalizedRight))
    && normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
}

/** @param {string} value */
export function fingerprintLockKey(value) {
  return normalizeFingerprint(value).toLowerCase();
}
