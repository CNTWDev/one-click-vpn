import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  clientArchitectures, clientPlatforms, parseClientReleases, releaseFor, updateDecision, validateClientRelease,
  type ClientArch, type ClientChannel, type ClientPlatform, type ClientRelease,
} from "../shared/client-releases";
import { addAudit, dbExec, dbQuery } from "./db";
import { requestAdmin } from "./request-auth";
import { inspectArtifact, presignReleaseUpload, releaseObjectKey, releaseStorage } from "./release-storage";

export class ReleaseError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}

/** Administrators can do everything; the CI token can only upload, register drafts and publish to beta. */
export type ReleaseActor = { kind: "admin"; userId: string } | { kind: "ci" };

const digest = (value: string) => createHash("sha256").update(value).digest();
export async function releaseActor(request: Request): Promise<ReleaseActor | null> {
  const configured = process.env.NORTHSTAR_RELEASE_TOKEN?.trim();
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
  created_by: string | null; created_at: Date; updated_at: Date;
};
const iso = (value: Date | null) => value ? new Date(value).toISOString() : null;

function toRelease(row: ReleaseRow): ClientRelease {
  return validateClientRelease({
    platform: row.platform, arch: row.arch, channel: row.channel, version: row.version, build: row.build, status: row.status,
    distribution: row.distribution, url: row.url, minOs: row.min_os, publishedAt: iso(row.published_at) || iso(row.created_at),
    ...(row.sha256 ? { sha256: row.sha256, sizeBytes: Number(row.size_bytes) } : {}),
  });
}
function adminRelease(row: ReleaseRow) {
  return { ...toRelease(row), id: row.id, notes: row.notes, storageKey: row.storage_key, verifiedAt: iso(row.verified_at),
    publishedAt: iso(row.published_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), createdBy: row.created_by };
}

/** Published database releases plus the legacy read-only NORTHSTAR_CLIENT_RELEASES_JSON manifest. */
export async function publicReleases(): Promise<ClientRelease[]> {
  const legacy = parseClientReleases(process.env.NORTHSTAR_CLIENT_RELEASES_JSON || "[]");
  const rows = await dbQuery<ReleaseRow>("SELECT * FROM client_releases WHERE status='published'");
  return [...legacy, ...rows.map(toRelease)];
}

export async function minimumBuild(platform: ClientPlatform): Promise<number> {
  return (await dbQuery<{ min_build: number }>("SELECT min_build FROM client_policies WHERE platform=$1", [platform]))[0]?.min_build || 0;
}

export async function updateCheck(input: { platform: ClientPlatform; arch?: ClientArch; channel: ClientChannel; build: number | null }) {
  const latest = releaseFor(await publicReleases(), input.platform, input.arch, input.channel);
  return updateDecision(latest, await minimumBuild(input.platform), input.build);
}

export function downloadPath(platform: ClientPlatform, arch?: ClientArch) {
  return `/download/${platform}${arch ? `/${arch}` : ""}`;
}

function member<T extends string>(value: unknown, values: readonly T[], code: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new ReleaseError(code);
  return value as T;
}

export async function requestUpload(actor: ReleaseActor, body: Record<string, unknown>) {
  const storage = releaseStorage();
  if (storage.mode !== "s3") throw new ReleaseError("RELEASE_STORAGE_NOT_CONFIGURED", 409);
  const platform = member(body.platform, clientPlatforms, "INVALID_PLATFORM"), arch = member(body.arch, clientArchitectures, "INVALID_ARCH");
  if (typeof body.version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(body.version) || !Number.isSafeInteger(body.build) || Number(body.build) < 1) throw new ReleaseError("INVALID_VERSION");
  let key: string;
  try { key = releaseObjectKey({ platform, arch, version: body.version, build: Number(body.build), fileName: String(body.fileName || "") }); }
  catch { throw new ReleaseError("INVALID_FILE_NAME"); }
  if ((await dbQuery("SELECT id FROM client_releases WHERE platform=$1 AND arch=$2 AND build=$3", [platform, arch, body.build])).length) throw new ReleaseError("RELEASE_BUILD_EXISTS", 409);
  await addAudit({ actorUserId: actorId(actor), action: "client_release.upload_url", targetType: "client_release", targetId: key, metadata: { actor: actorLabel(actor) } });
  return { storageKey: key, ...presignReleaseUpload(storage, key) };
}

export async function createRelease(actor: ReleaseActor, body: Record<string, unknown>) {
  const platform = member(body.platform, clientPlatforms, "INVALID_PLATFORM");
  const distribution = member(body.distribution ?? "direct", ["direct", "app-store", "testflight"] as const, "INVALID_DISTRIBUTION");
  const storageKey = typeof body.storageKey === "string" && body.storageKey ? body.storageKey : null;
  const storage = releaseStorage();
  let url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url && storageKey && storage.mode === "s3") url = `${storage.publicBaseUrl}/${storageKey.split("/").map(encodeURIComponent).join("/")}`;
  const draft: Record<string, unknown> = {
    platform, arch: body.arch ?? (platform === "windows" ? "x64" : "universal"), channel: body.channel ?? "beta", version: body.version,
    build: body.build, status: "draft", distribution, url, minOs: body.minOs, publishedAt: new Date().toISOString(),
  };
  if (distribution === "direct") {
    // Never trust the uploader's digest: record what the public URL actually serves.
    try { validateClientRelease({ ...draft, sha256: "0".repeat(64), sizeBytes: 1 }); }
    catch (error) { throw new ReleaseError(`INVALID_RELEASE: ${(error as Error).message}`); }
    let inspected: { sha256: string; sizeBytes: number };
    try { inspected = await inspectArtifact(url); }
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

export async function transitionRelease(actor: ReleaseActor, id: string, action: unknown) {
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
  } else if (action === "delete") {
    requireAdmin(actor);
    changed = await dbExec("DELETE FROM client_releases WHERE id=$1 AND status='draft'", [id]);
  } else throw new ReleaseError("INVALID_ACTION");
  if (!changed) throw new ReleaseError("INVALID_RELEASE_STATE", 409);
  if (action === "withdraw") {
    // Never strand users: a minimum build must stay reachable from a published stable release.
    const minBuild = await minimumBuild(release.platform);
    if (minBuild > 0 && !(await stableBuildAtLeast(release.platform, minBuild))) {
      await dbExec("UPDATE client_releases SET status='published',updated_at=now() WHERE id=$1", [id]);
      throw new ReleaseError("LOWER_MINIMUM_BUILD_FIRST", 409);
    }
  }
  await addAudit({ actorUserId: actorId(actor), action: `client_release.${action}`, targetType: "client_release", targetId: id, metadata: { actor: actorLabel(actor) } });
  return action === "delete" ? { id, deleted: true } : findRelease(id);
}

async function stableBuildAtLeast(platform: ClientPlatform, build: number) {
  return (await dbQuery("SELECT id FROM client_releases WHERE platform=$1 AND channel='stable' AND status='published' AND build>=$2 LIMIT 1", [platform, build])).length > 0
    || parseClientReleases(process.env.NORTHSTAR_CLIENT_RELEASES_JSON || "[]").some((item) => item.platform === platform && item.channel === "stable" && item.status === "published" && item.build >= build);
}

export async function setMinimumBuild(actor: ReleaseActor, body: Record<string, unknown>) {
  requireAdmin(actor);
  const platform = member(body.platform, clientPlatforms, "INVALID_PLATFORM");
  const minBuild = Number(body.minBuild);
  if (!Number.isSafeInteger(minBuild) || minBuild < 0) throw new ReleaseError("INVALID_MIN_BUILD");
  if (minBuild > 0 && !(await stableBuildAtLeast(platform, minBuild))) throw new ReleaseError("MIN_BUILD_WITHOUT_RELEASE", 409);
  await dbExec(`INSERT INTO client_policies (platform,min_build,updated_by,updated_at) VALUES ($1,$2,$3,now())
    ON CONFLICT (platform) DO UPDATE SET min_build=excluded.min_build,updated_by=excluded.updated_by,updated_at=now()`, [platform, minBuild, actorLabel(actor)]);
  await addAudit({ actorUserId: actorId(actor), action: "client_policy.update", targetType: "client_policy", targetId: platform, metadata: { minBuild } });
  return releaseOverview();
}

export async function releaseOverview() {
  const storage = releaseStorage();
  const [rows, policies, adoption] = await Promise.all([
    dbQuery<ReleaseRow>("SELECT * FROM client_releases ORDER BY platform, build DESC, arch LIMIT 500"),
    dbQuery<{ platform: ClientPlatform; min_build: number; updated_at: Date }>("SELECT platform,min_build,updated_at FROM client_policies"),
    dbQuery<{ platform: string; client_version: string | null; client_build: number | null; devices: number }>(`SELECT platform,client_version,client_build,COUNT(*)::int AS devices
      FROM native_enrollments WHERE status='active' GROUP BY platform,client_version,client_build ORDER BY platform,client_build DESC NULLS LAST`),
  ]);
  return {
    releases: rows.map(adminRelease),
    policies: clientPlatforms.map((platform) => ({ platform, minBuild: policies.find((p) => p.platform === platform)?.min_build || 0, downloadPath: downloadPath(platform) })),
    adoption: adoption.map((row) => ({ platform: row.platform, version: row.client_version, build: row.client_build, devices: row.devices })),
    storage: storage.mode === "s3" ? { mode: storage.mode, publicBaseUrl: storage.publicBaseUrl } : { mode: storage.mode },
    ciTokenConfigured: (process.env.NORTHSTAR_RELEASE_TOKEN?.trim().length || 0) >= 32,
  };
}
