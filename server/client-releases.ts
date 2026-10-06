import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  clientArchitectures, clientPlatforms, parseClientReleases, releaseFor, updateDecision, validateClientRelease,
  type ClientArch, type ClientChannel, type ClientPlatform, type ClientRelease,
} from "../shared/client-releases";
import { addAudit, dbExec, dbQuery } from "./db";
import { requestAdmin } from "./request-auth";
import { publicOrigin } from "./config";
import { appendLocalArtifact, inspectArtifact, inspectLocalArtifact, localArtifactPath, localArtifactUrl, maxInstallerBytes, presignReleaseUpload, releaseObjectKey, releaseStorage, uploadChunkBytes } from "./release-storage";

export class ReleaseError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}

/** Administrators can do everything; the CI token can only upload, register drafts and publish to beta. */
export type ReleaseActor = { kind: "admin"; userId: string } | { kind: "ci" };

const digest = (value: string) => createHash("sha256").update(value).digest();
export async function releaseActor(request: Request): Promise<ReleaseActor | null> {
  const configured = process.env.VEILBIRD_RELEASE_TOKEN?.trim();
  const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
  if (configured && configured.length >= 32 && token && timingSafeEqual(digest(token), digest(configured))) return { kind: "ci" };
  const admin = await requestAdmin(request);
  return admin ? { kind: "admin", userId: admin.id } : null;
}
const actorId = (actor: ReleaseActor) => actor.kind === "admin" ? actor.userId : null;
const actorLabel = (actor: ReleaseActor) => actor.kind === "admin" ? actor.userId : "release-token";
const requireAdmin = (actor: ReleaseActor) => { if (actor.kind !== "admin") throw new ReleaseError("ADMIN_REQUIRED", 403); };

type ReleaseRow = {
  id: string; platform: ClientPlatform; arch: ClientArch; channel: ClientChannel; version: string; build: number;
  status: ClientRelease["status"]; distribution: ClientRelease["distribution"]; url: string; sha256: string | null; size_bytes: string | null;
  min_os: string; notes: string; storage_key: string | null; verified_at: Date | null; published_at: Date | null;
  created_by: string | null; created_at: Date; updated_at: Date; rollout_percent: number;
};
const iso = (value: Date | null) => value ? new Date(value).toISOString() : null;

function toRelease(row: ReleaseRow): ClientRelease {
  return validateClientRelease({
    platform: row.platform, arch: row.arch, channel: row.channel, version: row.version, build: row.build, status: row.status,
    distribution: row.distribution, url: row.url, minOs: row.min_os, publishedAt: iso(row.published_at) || iso(row.created_at), notes: row.notes,
    ...(row.sha256 ? { sha256: row.sha256, sizeBytes: Number(row.size_bytes) } : {}),
  });
}
function adminRelease(row: ReleaseRow) {
  return { ...toRelease(row), id: row.id, notes: row.notes, storageKey: row.storage_key, verifiedAt: iso(row.verified_at),
    publishedAt: iso(row.published_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), createdBy: row.created_by,
    rolloutPercent: Number(row.rollout_percent ?? 100) };
}

/**
 * Staged rollout: an installation sees a partially rolled-out release only when its
 * per-release bucket (0-99) is below the percentage. Anonymous downloads see only full releases.
 */
export function rolloutBucket(releaseId: string, installation: string) {
  return createHash("sha256").update(`${releaseId}:${installation}`).digest().readUInt32BE(0) % 100;
}
export const validInstallation = (value: string | null | undefined) => !!value && /^[A-Za-z0-9-]{8,64}$/.test(value);

/** Published database releases plus the legacy read-only VEILBIRD_CLIENT_RELEASES_JSON manifest. */
export async function publicReleases(installation?: string): Promise<ClientRelease[]> {
  const legacy = parseClientReleases(process.env.VEILBIRD_CLIENT_RELEASES_JSON || "[]");
  const rows = await dbQuery<ReleaseRow>("SELECT * FROM client_releases WHERE status='published'");
  const visible = rows.filter((row) => Number(row.rollout_percent ?? 100) >= 100
    || (validInstallation(installation) && rolloutBucket(row.id, installation!) < Number(row.rollout_percent)));
  return [...legacy, ...visible.map(toRelease)];
}

export async function clientAnnouncement(platform: ClientPlatform): Promise<string> {
  return (await dbQuery<{ announcement: string }>("SELECT announcement FROM client_policies WHERE platform=$1", [platform]))[0]?.announcement || "";
}

export async function minimumBuild(platform: ClientPlatform): Promise<number> {
  return (await dbQuery<{ min_build: number }>("SELECT min_build FROM client_policies WHERE platform=$1", [platform]))[0]?.min_build || 0;
}

export async function updateCheck(input: { platform: ClientPlatform; arch?: ClientArch; channel: ClientChannel; build: number | null; installation?: string }) {
  const latest = releaseFor(await publicReleases(input.installation), input.platform, input.arch, input.channel);
  return { ...updateDecision(latest, await minimumBuild(input.platform), input.build), announcement: await clientAnnouncement(input.platform) };
}

export function downloadPath(platform: ClientPlatform, arch?: ClientArch) {
  return `/download/${platform}${arch ? `/${arch}` : ""}`;
}

function member<T extends string>(value: unknown, values: readonly T[], code: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new ReleaseError(code);
  return value as T;
}

/** Validates upload metadata and returns the immutable storage key for this build. */
async function uploadKey(actor: ReleaseActor, body: Record<string, unknown>, audit: string) {
  const platform = member(body.platform, clientPlatforms, "INVALID_PLATFORM"), arch = member(body.arch, clientArchitectures, "INVALID_ARCH");
  const build = Number(body.build);
  if (typeof body.version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(body.version) || !Number.isSafeInteger(build) || build < 1) throw new ReleaseError("INVALID_VERSION");
  let key: string;
  try { key = releaseObjectKey({ platform, arch, version: body.version, build, fileName: String(body.fileName || "") }); }
  catch { throw new ReleaseError("INVALID_FILE_NAME"); }
  if ((await dbQuery("SELECT id FROM client_releases WHERE platform=$1 AND arch=$2 AND build=$3", [platform, arch, build])).length) throw new ReleaseError("RELEASE_BUILD_EXISTS", 409);
  await addAudit({ actorUserId: actorId(actor), action: audit, targetType: "client_release", targetId: key, metadata: { actor: actorLabel(actor) } });
  return key;
}

/** Object storage: a 15-minute presigned PUT URL, so installer bytes never pass through the Controller. */
export async function requestUpload(actor: ReleaseActor, body: Record<string, unknown>) {
  const storage = releaseStorage();
  if (storage.mode !== "s3") throw new ReleaseError("RELEASE_STORAGE_NOT_CONFIGURED", 409);
  const key = await uploadKey(actor, body, "client_release.upload_url");
  return { storageKey: key, ...presignReleaseUpload(storage, key) };
}

/**
 * Local storage: the Console sends the installer in ordered chunks (each under the default Nginx body limit),
 * and it is kept on the Controller's data volume. The last chunk returns the recorded SHA-256 and size.
 */
export async function receiveUpload(actor: ReleaseActor, query: URLSearchParams, stream: ReadableStream<Uint8Array> | null) {
  const storage = releaseStorage();
  if (storage.mode !== "local") throw new ReleaseError("USE_OBJECT_STORAGE_UPLOAD", 409);
  if (!stream) throw new ReleaseError("ARTIFACT_EMPTY");
  const offset = Number(query.get("offset") || 0), final = query.get("final") === "1";
  // Metadata and the duplicate-build check run once, on the first chunk; later chunks only revalidate the key.
  const key = offset === 0 ? await uploadKey(actor, Object.fromEntries(query), "client_release.upload") : chunkKey(query);
  // No release row exists for this build (checked above), so a file under the key is an abandoned upload.
  if (offset === 0) await rm(localArtifactPath(storage, key), { force: true });
  try {
    const result = await appendLocalArtifact(storage, key, { id: String(query.get("upload") || ""), offset, final }, stream);
    return { storageKey: key, ...result, ...(result.complete ? await inspectLocalArtifact(storage, key) : {}) };
  } catch (error) {
    const message = (error as Error).message, code = (error as { code?: string }).code;
    if (code === "EEXIST") throw new ReleaseError("RELEASE_BUILD_EXISTS", 409);
    if (message === "Installer is too large") throw new ReleaseError("ARTIFACT_TOO_LARGE", 413);
    if (message === "Installer is empty") throw new ReleaseError("ARTIFACT_EMPTY");
    if (message === "Upload offset mismatch" || message === "Invalid upload") throw new ReleaseError("UPLOAD_INTERRUPTED", 409);
    throw error;
  }
}
function chunkKey(query: URLSearchParams) {
  try {
    return releaseObjectKey({ platform: member(query.get("platform"), clientPlatforms, "INVALID_PLATFORM"), arch: member(query.get("arch"), clientArchitectures, "INVALID_ARCH"),
      version: String(query.get("version") || ""), build: Number(query.get("build")), fileName: String(query.get("fileName") || "") });
  } catch { throw new ReleaseError("INVALID_FILE_NAME"); }
}

/** Streams a locally stored installer. Drafts are reachable only by administrators testing them. */
export async function localArtifact(key: string, request: Request) {
  const storage = releaseStorage();
  if (storage.mode !== "local") return null;
  const row = (await dbQuery<{ status: string }>("SELECT status FROM client_releases WHERE storage_key=$1 ORDER BY (status='published') DESC LIMIT 1", [key]))[0];
  if (!row || (row.status !== "published" && !(await requestAdmin(request)))) return null;
  try { return { file: localArtifactPath(storage, key), published: row.status === "published" }; } catch { return null; }
}

export async function createRelease(actor: ReleaseActor, body: Record<string, unknown>) {
  const platform = member(body.platform, clientPlatforms, "INVALID_PLATFORM");
  const distribution = member(body.distribution ?? "direct", ["direct", "app-store", "testflight"] as const, "INVALID_DISTRIBUTION");
  const storageKey = typeof body.storageKey === "string" && body.storageKey ? body.storageKey : null;
  const storage = releaseStorage();
  let url = typeof body.url === "string" ? body.url.trim() : "";
  const local = !!storageKey && storage.mode === "local";
  if (!url && storageKey && storage.mode === "s3") url = `${storage.publicBaseUrl}/${storageKey.split("/").map(encodeURIComponent).join("/")}`;
  if (local) {
    if (body.distribution !== undefined && body.distribution !== "direct") throw new ReleaseError("INVALID_DISTRIBUTION");
    url = localArtifactUrl(publicOrigin(), storageKey!);
  }
  const draft: Record<string, unknown> = {
    platform, arch: body.arch ?? (platform === "windows" ? "x64" : "universal"), channel: body.channel ?? "beta", version: body.version,
    build: body.build, status: "draft", distribution, url, minOs: body.minOs, publishedAt: new Date().toISOString(),
  };
  if (distribution === "direct") {
    // Never trust the uploader's digest: record what the public URL actually serves.
    try { validateClientRelease({ ...draft, sha256: "0".repeat(64), sizeBytes: 1 }); }
    catch (error) { throw new ReleaseError(`INVALID_RELEASE: ${(error as Error).message}`); }
    let inspected: { sha256: string; sizeBytes: number };
    try { inspected = local ? await inspectLocalArtifact(storage as Extract<typeof storage, { mode: "local" }>, storageKey!) : await inspectArtifact(url); }
    catch (error) { throw new ReleaseError(`ARTIFACT_UNAVAILABLE: ${(error as Error).message}`, 422); }
    if (typeof body.sha256 === "string" && body.sha256 && body.sha256.toLowerCase() !== inspected.sha256) throw new ReleaseError("ARTIFACT_DIGEST_MISMATCH", 422);
    if (body.sizeBytes !== undefined && Number(body.sizeBytes) !== inspected.sizeBytes) throw new ReleaseError("ARTIFACT_SIZE_MISMATCH", 422);
    Object.assign(draft, inspected);
  }
  let release: ClientRelease;
  try { release = validateClientRelease(draft); }
  catch (error) { throw new ReleaseError(`INVALID_RELEASE: ${(error as Error).message}`); }
  const id = `rel_${randomUUID()}`, notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 4000) : "";
  try {
    await dbExec(`INSERT INTO client_releases (id,platform,arch,channel,version,build,status,distribution,url,sha256,size_bytes,min_os,notes,storage_key,verified_at,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [id, release.platform, release.arch, release.channel, release.version, release.build, release.distribution, release.url, release.sha256 ?? null,
      release.sizeBytes ?? null, release.minOs, notes, storageKey, release.sha256 ? new Date().toISOString() : null, actorLabel(actor)]);
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new ReleaseError("RELEASE_BUILD_EXISTS", 409);
    throw error;
  }
  await addAudit({ actorUserId: actorId(actor), action: "client_release.create", targetType: "client_release", targetId: id,
    metadata: { actor: actorLabel(actor), platform: release.platform, arch: release.arch, version: release.version, build: release.build } });
  if (body.publish === true) return transitionRelease(actor, id, "publish");
  return findRelease(id);
}

async function findRelease(id: string) {
  const row = (await dbQuery<ReleaseRow>("SELECT * FROM client_releases WHERE id=$1", [id]))[0];
  if (!row) throw new ReleaseError("RELEASE_NOT_FOUND", 404);
  return adminRelease(row);
}

export async function transitionRelease(actor: ReleaseActor, id: string, action: unknown, extra?: Record<string, unknown>) {
  const release = await findRelease(id);
  let changed = 0;
  if (action === "publish") {
    if (actor.kind === "ci" && release.channel !== "beta") throw new ReleaseError("ADMIN_REQUIRED", 403);
    changed = await dbExec("UPDATE client_releases SET status='published',published_at=now(),updated_at=now() WHERE id=$1 AND status IN ('draft','withdrawn')", [id]);
  } else if (action === "promote") {
    requireAdmin(actor);
    if (release.version.includes("-") || release.distribution === "testflight") throw new ReleaseError("PRERELEASE_CANNOT_BE_STABLE");
    changed = await dbExec("UPDATE client_releases SET channel='stable',status='published',published_at=now(),updated_at=now() WHERE id=$1 AND channel='beta' AND status<>'withdrawn'", [id]);
  } else if (action === "withdraw") {
    requireAdmin(actor);
    changed = await dbExec("UPDATE client_releases SET status='withdrawn',updated_at=now() WHERE id=$1 AND status='published'", [id]);
  } else if (action === "rollout") {
    requireAdmin(actor);
    const percent = Number(extra?.percent);
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) throw new ReleaseError("INVALID_ROLLOUT");
    changed = await dbExec("UPDATE client_releases SET rollout_percent=$2,updated_at=now() WHERE id=$1 AND status<>'withdrawn'", [id, percent]);
  } else if (action === "delete") {
    requireAdmin(actor);
    changed = await dbExec("DELETE FROM client_releases WHERE id=$1 AND status='draft'", [id]);
    const storage = releaseStorage();
    // Drafts uploaded to the Controller's own volume are removed with them; object storage is left untouched.
    if (changed && storage.mode === "local" && release.storageKey) await rm(localArtifactPath(storage, release.storageKey), { force: true }).catch(() => undefined);
  } else throw new ReleaseError("INVALID_ACTION");
  if (!changed) throw new ReleaseError("INVALID_RELEASE_STATE", 409);
  if (action === "withdraw" || action === "rollout") {
    // Never strand users: a minimum build must stay reachable from a fully rolled-out stable release.
    const minBuild = await minimumBuild(release.platform);
    if (minBuild > 0 && !(await stableBuildAtLeast(release.platform, minBuild))) {
      await dbExec("UPDATE client_releases SET status='published',rollout_percent=$2,updated_at=now() WHERE id=$1", [id, release.rolloutPercent]);
      throw new ReleaseError("LOWER_MINIMUM_BUILD_FIRST", 409);
    }
  }
  await addAudit({ actorUserId: actorId(actor), action: `client_release.${action}`, targetType: "client_release", targetId: id,
    metadata: { actor: actorLabel(actor), ...(action === "rollout" ? { percent: extra?.percent } : {}) } });
  return action === "delete" ? { id, deleted: true } : findRelease(id);
}

async function stableBuildAtLeast(platform: ClientPlatform, build: number) {
  return (await dbQuery("SELECT id FROM client_releases WHERE platform=$1 AND channel='stable' AND status='published' AND rollout_percent=100 AND build>=$2 LIMIT 1", [platform, build])).length > 0
    || parseClientReleases(process.env.VEILBIRD_CLIENT_RELEASES_JSON || "[]").some((item) => item.platform === platform && item.channel === "stable" && item.status === "published" && item.build >= build);
}

export async function setMinimumBuild(actor: ReleaseActor, body: Record<string, unknown>) {
  requireAdmin(actor);
  const platform = member(body.platform, clientPlatforms, "INVALID_PLATFORM");
  const current = (await dbQuery<{ min_build: number; announcement: string }>("SELECT min_build,announcement FROM client_policies WHERE platform=$1", [platform]))[0];
  const minBuild = body.minBuild === undefined ? current?.min_build ?? 0 : Number(body.minBuild);
  if (!Number.isSafeInteger(minBuild) || minBuild < 0) throw new ReleaseError("INVALID_MIN_BUILD");
  if (minBuild > (current?.min_build ?? 0) && !(await stableBuildAtLeast(platform, minBuild))) throw new ReleaseError("MIN_BUILD_WITHOUT_RELEASE", 409);
  if (body.announcement !== undefined && (typeof body.announcement !== "string" || body.announcement.length > 500)) throw new ReleaseError("INVALID_ANNOUNCEMENT");
  const announcement = typeof body.announcement === "string" ? body.announcement.trim() : current?.announcement ?? "";
  await dbExec(`INSERT INTO client_policies (platform,min_build,announcement,updated_by,updated_at) VALUES ($1,$2,$3,$4,now())
    ON CONFLICT (platform) DO UPDATE SET min_build=excluded.min_build,announcement=excluded.announcement,updated_by=excluded.updated_by,updated_at=now()`, [platform, minBuild, announcement, actorLabel(actor)]);
  await addAudit({ actorUserId: actorId(actor), action: "client_policy.update", targetType: "client_policy", targetId: platform, metadata: { minBuild, announcement: !!announcement } });
  return releaseOverview();
}

export async function releaseOverview() {
  const storage = releaseStorage();
  const [rows, policies, adoption, diagnostics] = await Promise.all([
    dbQuery<ReleaseRow>("SELECT * FROM client_releases ORDER BY platform, build DESC, arch LIMIT 500"),
    dbQuery<{ platform: ClientPlatform; min_build: number; announcement: string; updated_at: Date }>("SELECT platform,min_build,announcement,updated_at FROM client_policies"),
    dbQuery<{ platform: string; client_version: string | null; client_build: number | null; devices: number }>(`SELECT platform,client_version,client_build,COUNT(*)::int AS devices
      FROM native_enrollments WHERE status='active' GROUP BY platform,client_version,client_build ORDER BY platform,client_build DESC NULLS LAST`),
    dbQuery<{ platform: string; client_build: number | null; code: string; events: number; users: number; last_at: Date }>(`SELECT platform,client_build,code,COUNT(*)::int AS events,
      COUNT(DISTINCT user_id)::int AS users,MAX(occurred_at) AS last_at FROM native_diagnostics WHERE created_at>now()-interval '7 days'
      GROUP BY platform,client_build,code ORDER BY events DESC LIMIT 50`),
  ]);
  return {
    releases: rows.map(adminRelease),
    policies: clientPlatforms.map((platform) => { const policy = policies.find((p) => p.platform === platform);
      return { platform, minBuild: policy?.min_build || 0, announcement: policy?.announcement || "", downloadPath: downloadPath(platform) }; }),
    adoption: adoption.map((row) => ({ platform: row.platform, version: row.client_version, build: row.client_build, devices: row.devices })),
    diagnostics: diagnostics.map((row) => ({ platform: row.platform, build: row.client_build, code: row.code, events: row.events, users: row.users, lastAt: iso(row.last_at) })),
    storage: storage.mode === "s3" ? { mode: storage.mode, publicBaseUrl: storage.publicBaseUrl } : { mode: storage.mode, maxBytes: maxInstallerBytes, chunkBytes: uploadChunkBytes },
    ciTokenConfigured: (process.env.VEILBIRD_RELEASE_TOKEN?.trim().length || 0) >= 32,
  };
}
