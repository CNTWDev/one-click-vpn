import { currentUser } from "../../../../../../server/auth";
import { findConnectionProfile, findDevice } from "../../../../../../server/control-db";
import { renderOpenVpnProfile } from "../../../../../../server/openvpn-pki";
import { jsonError } from "../../../../../../server/http";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  const profile = await findConnectionProfile(id);
  const device = profile ? await findDevice(profile.device_id) : undefined;
  if (!profile || !device || device.user_id !== user.id) return jsonError("Connection profile not found", 404);
  if (profile.status !== "active") return jsonError("Activate this profile before downloading it", 409);
  if (profile.protocol !== "openvpn") return jsonError("This profile is downloaded from its client workflow", 409);
  try {
    const config = await renderOpenVpnProfile({ endpoint: profile.endpoint, transport: profile.transport, dns: profile.dns, payload: profile.protocol_payload });
    return new Response(config, {
      headers: {
        "Content-Type": "application/x-openvpn-profile; charset=utf-8",
        "Content-Disposition": `attachment; filename="northstar-${profile.id}.ovpn"`,
        "Cache-Control": "no-store, private",
      },
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to export OpenVPN profile", 409);
  }
}
