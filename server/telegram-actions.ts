import { addAudit, dbExec, dbQuery, deleteSessionsForUser, findUserById, updateUserStatus } from "./db";
import { revokeApiSessionsForUser } from "./control-db";
import { reconcileUserAccess } from "./credential-access";
import { transitionRelease } from "./client-releases";
import { consoleLink, registerApproval, requestApproval, settleApproval } from "./telegram";

// What the Controller itself asks for in Telegram: new sign-ups and beta client builds. Importing this file
// registers the approval handlers, so every caller of these functions (and the polling loop) has them.

const PLATFORM_NAMES: Record<string, string> = { android: "Android", macos: "Mac", windows: "Windows", ios: "iPhone" };

async function ownerId(): Promise<string | null> {
  return (await dbQuery<{ id: string }>("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1"))[0]?.id ?? null;
}

registerApproval("signup", {
  async decide(userId, approve, by) {
    const user = await findUserById(userId);
    if (!user) return "用户已不存在";
    if (user.status !== "pending") return `已在 Console 处理（${user.status === "active" ? "已通过" : user.status === "rejected" ? "已拒绝" : user.status}）`;
    const status = approve ? "active" : "rejected";
    await updateUserStatus(userId, status, `telegram:${by.telegramId}`);
    if (!approve) await Promise.all([deleteSessionsForUser(userId), revokeApiSessionsForUser(userId), dbExec("DELETE FROM native_sessions WHERE user_id=$1", [userId])]);
    await reconcileUserAccess(userId);
    await addAudit({ action: `user.${status}`, targetType: "user", targetId: userId, metadata: { via: "telegram", telegramUser: by.telegramId, telegramName: by.name } });
    return approve ? "✅ 已通过" : "✖️ 已拒绝";
  },
});

/** A new account waits for approval: ask in Telegram. Never throws. */
export async function askSignupApproval(user: { id: string; email: string; displayName: string }, siteName: string): Promise<void> {
  await requestApproval({
    kind: "signup", target: user.id, event: "signups",
    message: { tone: "approval", title: "新用户待审核", fields: [{ label: "名字", value: user.displayName }, { label: "邮箱", value: user.email, code: true }, { label: "站点", value: siteName }], link: await consoleLink("/users") },
  }).catch(() => undefined);
}

/** The Console approved or rejected the account: close its Telegram buttons. */
export async function settleSignup(userId: string, status: string): Promise<void> {
  await settleApproval("signup", userId, status === "active" ? "✅ 已在 Console 通过" : "✖️ 已在 Console 处理");
}

registerApproval("release", {
  async decide(version) {
    const owner = await ownerId();
    if (!owner) throw new Error("no owner account");
    const builds = await dbQuery<{ id: string }>("SELECT id FROM client_releases WHERE version = $1 AND channel = 'beta' AND status = 'published'", [version]);
    if (!builds.length) return "已在 Console 处理";
    for (const build of builds) await transitionRelease({ kind: "admin", userId: owner }, build.id, "promote");
    return "⬆️ 已晋升正式版，从 10% 开始灰度";
  },
});

/**
 * Minute job: once a version's beta builds have stopped arriving for 5 minutes, post one message for all
 * of them with a "promote to stable" button. CI publishes each platform separately; this keeps it one message.
 */
export async function announceBetaReleases(): Promise<number> {
  const versions = await dbQuery<{ version: string; platforms: string[] }>(`
    SELECT version, array_agg(DISTINCT platform ORDER BY platform) AS platforms FROM client_releases
    WHERE channel = 'beta' AND status = 'published' AND version NOT LIKE '%-%' AND published_at::timestamptz > now() - interval '1 day'
    GROUP BY version HAVING max(published_at::timestamptz) < now() - interval '5 minutes'
      AND NOT EXISTS (SELECT 1 FROM telegram_approvals a WHERE a.kind = 'release' AND a.target = version)`);
  let sent = 0;
  for (const row of versions) {
    const ok = await requestApproval({
      kind: "release", target: row.version, event: "releases", approveLabel: "⬆️ 晋升正式版", rejectLabel: null,
      message: { tone: "release", title: `客户端 ${row.version} 已发布到测试版`, lines: [row.platforms.map((item) => PLATFORM_NAMES[item] || item).join(" · "), "测试没问题再晋升正式版：先发给 10% 的用户，指标正常每 24 小时自动放量。"], link: await consoleLink("/releases") },
    }).catch(() => false);
    if (ok) sent++;
  }
  return sent;
}

/** The Console promoted or withdrew a version: close its Telegram button once no beta build is left. */
export async function settleRelease(version: string): Promise<void> {
  const left = await dbQuery("SELECT 1 FROM client_releases WHERE version = $1 AND channel = 'beta' AND status = 'published' LIMIT 1", [version]);
  if (!left.length) await settleApproval("release", version, "已在 Console 处理");
}
