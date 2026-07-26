import { requestUser } from "../../../../../../server/request-auth";
import { findConnectionProfile, findDevice } from "../../../../../../server/control-db";
import { renderOpenVpnProfile } from "../../../../../../server/openvpn-pki";
import { renderWireGuardProfile } from "../../../../../../server/control-plane";
import { jsonError } from "../../../../../../server/http";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  const profile = await findConnectionProfile(id);
  const device = profile ? await findDevice(profile.device_id) : undefined;
  if (!profile || !device || device.user_id !== user.id) return jsonError("Profile not found", 404);
  if (profile.status !== "active") return jsonError("Activate this profile before downloading it", 409);
  try {
    const config = profile.protocol === "openvpn"
      ? await renderOpenVpnProfile({ endpoint: profile.endpoint, transport: profile.transport, dns: profile.dns, payload: profile.protocol_payload })
      : await renderWireGuardProfile(profile);
    const extension = profile.protocol === "openvpn" ? "ovpn" : "conf";
    return new Response(config, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="northstar-${profile.id}.${extension}"`,
        "Cache-Control": "no-store, private",
      },
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to export OpenVPN profile", 409);
  }
}
