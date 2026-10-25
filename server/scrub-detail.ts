/**
 * An error text without anything that names a place: URLs, IP addresses, host names and long
 * tokens become "…". The apps scrub the same way before sending; this is the server's own guard.
 */
export function scrubDetail(value: unknown, limit = 200): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "…")
    .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, "…")
    .replace(/\[?\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\]?(:\d+)?/gi, "…")
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(:\d+)?\b/gi, "…")
    .replace(/[A-Za-z0-9+/=_-]{24,}/g, "…")
    .replace(/[\u0000-\u001f]+/g, " ").trim();
  return text ? text.slice(0, limit) : null;
}
