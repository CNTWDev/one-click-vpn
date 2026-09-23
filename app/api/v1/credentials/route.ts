import { NextResponse } from "next/server";
import { addAudit } from "../../../../server/db";
import { createAccessCredential, listAccessCredentials, type Protocol } from "../../../../server/control-db";
import { manageCredentialsAccess } from "../../../../server/credential-access";
import { cleanText, jsonError, readJson } from "../../../../server/http";
import { requestUser } from "../../../../server/request-auth";
import { credentialAccessOverview } from "../../../../server/traffic";

export const runtime = "nodejs";

const protocols = new Set<Protocol>(["wireguard", "openvpn"]);

export async function PATCH(request: Request) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  try {
    const { action } = await readJson(request);
    if (action !== "disable" && action !== "revoke") return jsonError("Unsupported bulk action");
    const credentials = (await listAccessCredentials(user.id)).filter((item) => !item.deleted_at && item.status === "active"
      && (action === "revoke" || !item.expires_at || item.expires_at > new Date().toISOString()));
    return NextResponse.json(await manageCredentialsAccess(user.id, credentials.map((item) => item.id), action, { id: user.id, admin: false }));
  } catch (error) { return jsonError(error instanceof Error ? error.message : "Unable to update credentials", 409); }
}

export async function GET(request: Request) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  const url = new URL(request.url);
  return NextResponse.json(await credentialAccessOverview(user.id, {
    from: url.searchParams.get("from") || undefined,
    to: url.searchParams.get("to") || undefined,
  }));
}

export async function POST(request: Request) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  try {
    const body = await readJson(request);
    const displayName = cleanText(body.name || body.displayName, 120);
    const protocol = cleanText(body.protocol, 32) as Protocol;
    const publicKey = cleanText(body.publicKey, 512);
    if (!displayName || !protocols.has(protocol)) return jsonError("name and a supported protocol are required");
    if (protocol === "wireguard" && !/^[A-Za-z0-9+/]{43}=$/.test(publicKey)) return jsonError("A valid WireGuard public key is required");
    const credential = await createAccessCredential({ userId: user.id, displayName, protocol, identityKey: publicKey });
    await addAudit({ actorUserId: user.id, action: "credential.created", targetType: "credential", targetId: credential.id, metadata: { protocol } });
    return NextResponse.json({ credential: {
      id: credential.id, name: credential.display_name, protocol: credential.protocol, status: credential.status,
      identitySuffix: credential.identity_key.replaceAll(":", "").slice(-10), createdAt: credential.created_at,
    } }, { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to create credential", 409);
  }
}
