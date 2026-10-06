import { createZipBlob } from "./zip";

export type Profile = { nodeId?: string; id: string; credentialId?: string | null; displayName?: string | null; nodeName?: string | null; regionalNodeCount?: number; regionCode?: string | null; regionName?: string | null; protocol: string; status: string; issuedAt: string; expiresAt: string };
export type DownloadFile = { name: string; text: string };

export function filenamePart(value: string | null | undefined, fallback: string, maxLength = 18) {
  return (value || "").normalize("NFKC").trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, maxLength) || fallback;
}
export function profileFilename(profile: Profile) {
  const extension = profile.protocol === "vless" ? "yaml" : profile.protocol === "openvpn" ? "ovpn" : "conf";
  const protocolCode = profile.protocol === "vless" ? "VL" : profile.protocol === "openvpn" ? "OV" : "WG";
  const node = (profile.regionalNodeCount || 0) > 1 ? `${profile.regionalNodeCount}nodes` : filenamePart(profile.nodeName, "node", 12);
  return `${filenamePart(profile.regionCode?.toUpperCase(), "AUTO", 8)}-${filenamePart(profile.displayName, "credential")}-${protocolCode}-${node}.${extension}`;
}
function saveBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob); const link = document.createElement("a");
  link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
/** Saves one file as text, several as a ZIP named `zipName`. */
export function saveFiles(files: DownloadFile[], zipName: string) {
  if (files.length === 1) saveBlob(files[0].name, new Blob([files[0].text], { type: "text/plain;charset=utf-8" }));
  else saveBlob(zipName, createZipBlob(files));
}
