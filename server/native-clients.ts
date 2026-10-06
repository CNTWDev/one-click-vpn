import { parseClientAgent, type ClientAgent, type ClientPlatform } from "../shared/client-releases";
import { downloadPath, minimumBuild } from "./client-releases";
import { dbExec } from "./db";
import { digest, NativeError } from "./native-proof";

export const clientHeader = "x-northstar-client";

/**
 * Reads `X-Northstar-Client: <platform>/<version>+<build>` and blocks builds below the configured minimum.
 * A missing or mismatched header counts as build 0, so clients that predate the header are blocked too
 * once an administrator sets a minimum (no minimum is set by default).
 */
export async function requireSupportedClient(request: Request, platform: ClientPlatform): Promise<ClientAgent | null> {
  const parsed = parseClientAgent(request.headers.get(clientHeader));
  const agent = parsed?.platform === platform ? parsed : null;
  const minBuild = await minimumBuild(platform);
  if (minBuild > 0 && (agent?.build ?? 0) < minBuild) throw new NativeError("CLIENT_UPDATE_REQUIRED", 426, { minBuild, downloadPath: downloadPath(platform) });
  return agent;
}

export async function recordSessionClient(accessToken: string, agent: ClientAgent | null) {
  if (agent) await dbExec("UPDATE native_sessions SET client_version=$2,client_build=$3 WHERE token_hash=$1", [digest(accessToken), agent.version, agent.build]);
}

export async function recordEnrollmentClient(enrollmentId: string, agent: ClientAgent | null) {
  if (agent) await dbExec("UPDATE native_enrollments SET client_version=$2,client_build=$3 WHERE id=$1", [enrollmentId, agent.version, agent.build]);
}
