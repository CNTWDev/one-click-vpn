import { requestUser } from "../../../../../../server/request-auth";
import { assertCredentialUsable } from "../../../../../../server/credential-access";
import { findConnectionProfile, findDevice } from "../../../../../../server/control-db";
import { renderOpenVpnProfile } from "../../../../../../server/openvpn-pki";
import { renderWireGuardProfile } from "../../../../../../server/control-plane";
import { jsonError } from "../../../../../../server/http";
import { readSecretMaterial } from "../../../../../../server/secret-materials";
import { renderSubscription, vlessShareLink } from "../../../../../../server/subscription-format";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  const profile = await findConnectionProfile(id);
  const device = profile ? await findDevice(profile.device_id) : undefined;
  if (!profile || !device || device.user_id !== user.id) return jsonError("Profile not found", 404);
  if (profile.status !== "active") return jsonError("Activate this profile before downloading it", 409);
  const format = new URL(request.url).searchParams.get("format") || "native";
  if (!["native", "mihomo", "uri"].includes(format)) return jsonError("Unsupported export format", 400);
  if (format === "uri" && profile.protocol !== "vless") return jsonError("分享链接仅支持 VLESS", 400);
  if (format === "mihomo" && !["wireguard", "vless"].includes(profile.protocol)) return jsonError("此协议不支持该客户端格式", 400);
  if (!Number.isFinite(Date.parse(profile.expires_at)) || Date.parse(profile.expires_at) <= Date.now()) return jsonError("Profile has expired; create a replacement credential", 409);
  try {
    if (profile.credential_id) await assertCredentialUsable(profile.credential_id);
    if (profile.protocol === "vless") {
      const payload = profile.protocol_payload;
      const uuid = await readSecretMaterial(String(payload.clientUuidSecretId || ""));
      if (!uuid) return jsonError("连接密钥不可用，请联系管理员", 409);
      const proxy = { name: "Veilbird", type: "vless", server: profile.endpoint.host, port: profile.endpoint.port,
        uuid, network: "tcp", tls: true, udp: true, flow: "xtls-rprx-vision", servername: payload.serverName,
        "client-fingerprint": "chrome", "reality-opts": { "public-key": payload.publicKey, "short-id": payload.shortId } };
      if (format === "uri") return new Response(vlessShareLink(proxy) + "\n", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" } });
      const content = renderSubscription([proxy]);
      return new Response(content, { headers: { "Content-Type": "application/yaml; charset=utf-8", "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff", "Content-Disposition": `attachment; filename="northstar-${profile.id}.yaml"` } });
    }
    const config = profile.protocol === "openvpn"
      ? await renderOpenVpnProfile({ endpoint: profile.endpoint, transport: profile.transport, dns: profile.dns, payload: profile.protocol_payload })
      : await renderWireGuardProfile(profile, format as "native" | "mihomo");
    const extension = format === "mihomo" ? "yaml" : profile.protocol === "openvpn" ? "ovpn" : "conf";
    return new Response(config, {
      headers: {
        "Content-Type": format === "mihomo" ? "application/yaml; charset=utf-8" : "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `attachment; filename="northstar-${profile.id}.${extension}"`,
        "Cache-Control": "no-store, private",
      },
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to export connection profile", 409);
  }
}
