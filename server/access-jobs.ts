import { dbExec, dbQuery } from "./db";
import { describe, refreshAccess, userGrants } from "./entitlements";
import { mailConfigured, sendMail } from "./mail";
import { publicOrigin } from "./config";
import { PRODUCT_NAME } from "../shared/brand-name";
import { writeOperationalLog } from "./operational-logs";

/**
 * Refreshes accounts whose period just ended or whose next grant just started, and mails the reminders
 * once per period. Runs once a minute from server/jobs.ts; returns how many accounts were refreshed.
 */
export async function runAccessJobs(): Promise<number> {
  const due = await dbQuery<{ id: string }>(`SELECT id FROM users WHERE access_ok AND access_until<=now()
    UNION SELECT DISTINCT user_id FROM access_grants WHERE status='active'
      AND ((starts_at<=now() AND starts_at>now()-interval '10 minutes') OR (ends_at<=now() AND ends_at>now()-interval '10 minutes'))`);
  for (const { id } of due) await refreshAccess(id).catch(() => undefined);
  if (await mailConfigured()) await sendReminders();
  return due.length;
}

const SOON_DAYS = 7;
const LOW_SHARE = 0.1;

type Notice = "soon" | "low" | "ended";
const copy: Record<Notice, { subject: (product: string) => string; body: string[] }> = {
  soon: { subject: (product) => `${product}：账号即将到期 · Your access ends soon`, body: [
    "你的账号将于 {date} 到期，到期后将无法连接。如需继续使用，请联系管理员续期。",
    "Your access ends on {date}. After that you can't connect. Contact your administrator to renew.",
    "Доступ закончится {date}. После этого подключиться будет нельзя. Обратитесь к администратору, чтобы продлить." ] },
  low: { subject: (product) => `${product}：流量即将用完 · Traffic almost used up`, body: [
    "你的流量只剩 {left}（共 {total}），用完后将无法连接。",
    "You have {left} of {total} traffic left. When it runs out you can't connect.",
    "Осталось {left} из {total} трафика. Когда он закончится, подключиться будет нельзя." ] },
  ended: { subject: (product) => `${product}：账号已暂停使用 · Access paused`, body: [
    "你的账号{reason}，现在无法连接。请联系管理员续期或增加流量。",
    "Your {reasonEn}, so you can't connect right now. Contact your administrator to renew or add traffic.",
    "{reasonRu}, поэтому подключиться сейчас нельзя. Обратитесь к администратору, чтобы продлить доступ или добавить трафик." ] },
};

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;

async function sendReminders() {
  // Accounts with an end date or a quota that are close to it, or ended within the last day.
  const candidates = await dbQuery<{ id: string; email: string; access_notice: string }>(`SELECT DISTINCT u.id,u.email,u.access_notice FROM users u
    JOIN access_grants g ON g.user_id=u.id AND g.status='active'
    WHERE u.status='active' AND ((u.access_ok AND u.access_until IS NOT NULL AND u.access_until<=now()+interval '${SOON_DAYS} days')
      OR (g.quota_bytes IS NOT NULL AND g.used_bytes>=g.quota_bytes*${1 - LOW_SHARE} AND g.starts_at<=now() AND (g.ends_at IS NULL OR g.ends_at>now()-interval '1 day')))`);
  for (const user of candidates) {
    const access = describe(await userGrants(user.id));
    let notice: Notice | null = null, key = "";
    if (access.state === "exhausted" || access.state === "expired") { notice = "ended"; key = `ended:${access.endedAt || access.state}`; }
    else if (access.state === "active" && access.until && Date.parse(access.until) - Date.now() <= SOON_DAYS * 86_400_000) { notice = "soon"; key = `soon:${access.until}`; }
    else if (access.state === "active" && access.quotaBytes && access.remainingBytes !== null && access.remainingBytes <= access.quotaBytes * LOW_SHARE) { notice = "low"; key = `low:${access.quotaBytes}`; }
    if (!notice || user.access_notice === key) continue;
    // Claim the notice first: a failed send is not retried every minute.
    if (!(await dbExec("UPDATE users SET access_notice=$2 WHERE id=$1 AND access_notice=$3", [user.id, key, user.access_notice]))) continue;
    const date = access.until ? access.until.slice(0, 10) : "";
    const values: Record<string, string> = {
      date, left: gb(access.remainingBytes || 0), total: gb(access.quotaBytes || 0),
      reason: access.state === "exhausted" ? "流量已用完" : "已到期",
      reasonEn: access.state === "exhausted" ? "traffic is used up" : "access has ended",
      reasonRu: access.state === "exhausted" ? "Трафик закончился" : "Срок доступа истёк",
    };
    const text = [...copy[notice].body.map((line) => line.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? "")), "", publicOrigin()].join("\n\n");
    try { await sendMail({ to: user.email, subject: copy[notice].subject(PRODUCT_NAME), text }); }
    catch (error) {
      await writeOperationalLog({ component: "controller", level: "warning", message: "account.reminder_failed", action: "account.reminder_failed",
        target: { type: "user", id: user.id }, fields: { notice, error: error instanceof Error ? error.message : String(error) } }).catch(() => undefined);
    }
  }
}
