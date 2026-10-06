import { t, useConsoleLanguage } from "../i18n";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useConfirm } from "../confirm-dialog";
import { Icon } from "../icons";
import { useToast } from "../toast";
import { Empty, formatBytes, formatTime, InlineNotice, type Notice, PageHeader, Pill } from "./shared";

type Platform = "android" | "ios" | "macos" | "windows";
type Release = {
  id: string; platform: Platform; arch: string; channel: "stable" | "beta"; version: string; build: number;
  status: "draft" | "published" | "withdrawn"; distribution: string; url: string; sha256?: string; sizeBytes?: number;
  minOs: string; notes: string; publishedAt: string | null; createdAt: string; createdBy: string | null; rolloutPercent: number;
};
type Overview = {
  releases: Release[]; policies: Array<{ platform: Platform; minBuild: number; announcement: string; downloadPath: string }>;
  adoption: Array<{ platform: string; version: string | null; build: number | null; devices: number }>;
  diagnostics: Array<{ platform: string; build: number | null; code: string; events: number; users: number; lastAt: string | null }>;
  storage: { mode: "local" | "s3"; publicBaseUrl?: string; maxBytes?: number; chunkBytes?: number }; ciTokenConfigured: boolean;
};
const platformNames: Record<Platform, string> = { android: "Android", ios: "iPhone / iPad", macos: "macOS", windows: "Windows" };
const errors: Record<string, string> = {
  ADMIN_REQUIRED: "需要管理员权限。",
  RELEASE_BUILD_EXISTS: "该平台和架构已存在相同构建号，请递增构建号。",
  ARTIFACT_UNAVAILABLE: "无法下载安装包，请确认 HTTPS 地址可公开访问。",
  ARTIFACT_DIGEST_MISMATCH: "下载到的文件与填写的 SHA-256 不一致。",
  ARTIFACT_SIZE_MISMATCH: "下载到的文件大小与填写的不一致。",
  INVALID_RELEASE: "版本信息不完整或不合法，请检查版本号、构建号、下载地址和最低系统版本。",
  INVALID_RELEASE_STATE: "当前状态不能执行该操作，请刷新后重试。",
  PRERELEASE_CANNOT_BE_STABLE: "预发布版本（带 - 后缀）或 TestFlight 不能晋升为正式版。",
  MIN_BUILD_WITHOUT_RELEASE: "没有已发布的正式版达到该构建号，用户将无法升级。请先发布正式版。",
  LOWER_MINIMUM_BUILD_FIRST: "撤回后将没有满足最低版本要求的正式版，请先调低最低版本。",
  INVALID_MIN_BUILD: "最低构建号必须是不小于 0 的整数。",
  INVALID_ROLLOUT: "灰度比例必须是 1 到 100 之间的整数。",
  INVALID_ANNOUNCEMENT: "公告最多 500 个字符。",
  INVALID_VERSION: "版本号格式应为 1.2.0，构建号为正整数。",
  INVALID_FILE_NAME: "不支持的安装包类型，请上传 .apk、.aab、.zip、.dmg、.pkg、.msix、.msixbundle、.exe 或 .msi 文件。",
  ARTIFACT_TOO_LARGE: "安装包超过 1 GB 上限。",
  ARTIFACT_EMPTY: "安装包是空文件。",
  UPLOAD_INTERRUPTED: "上传中断，请重新上传。",
  RELEASE_STORAGE_NOT_CONFIGURED: "对象存储未配置，无法上传。",
  USE_OBJECT_STORAGE_UPLOAD: "当前使用对象存储，请刷新页面后重试。",
  INVALID_DISTRIBUTION: "上传的安装包只能用于直接下载。",
};
const extensions = ".apk,.aab,.zip,.dmg,.pkg,.msix,.msixbundle,.exe,.msi";
const defaultArch: Record<Platform, string> = { android: "universal", ios: "universal", macos: "universal", windows: "x64" };
const minOsHint: Record<Platform, string> = { android: "Android 8.0", ios: "iOS 16", macos: "macOS 13", windows: "Windows 10" };

async function readError(response: Response) {
  const body = await response.json().catch(() => ({})) as { error?: string };
  return new Error(body.error || t("请求失败（HTTP {0}）", [response.status]));
}
/** PUT with progress (fetch cannot report upload progress). */
function putWithProgress(url: string, body: Blob, onProgress: (sent: number) => void, withCredentials: boolean) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url); xhr.withCredentials = withCredentials;
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(t("上传失败（HTTP {0}）", [xhr.status])));
    xhr.onerror = () => reject(new Error(t("上传失败，请检查网络或对象存储的 CORS 设置。")));
    xhr.send(body);
  });
}
const errorText = (error: unknown) => { const code = (error as Error).message.split(":")[0]; return errors[code] ? t(errors[code]) : (error as Error).message; };

export function ReleasesPage() {
  useConsoleLanguage();
  const [data, setData] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [minBuilds, setMinBuilds] = useState<Record<string, string>>({});
  const [announcements, setAnnouncements] = useState<Record<string, string>>({});
  const [rollouts, setRollouts] = useState<Record<string, string>>({});
  const [platformFilter, setPlatformFilter] = useState<"all" | Platform>("all");
  const [formPlatform, setFormPlatform] = useState<Platform>("android");
  const [source, setSource] = useState<"upload" | "url">("upload");
  const [progress, setProgress] = useState<number | null>(null);
  const confirm = useConfirm();
  const toast = useToast();

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const result = await api<Overview>("/api/v1/admin/client-releases");
      setData(result);
      setMinBuilds(Object.fromEntries(result.policies.map((policy) => [policy.platform, String(policy.minBuild)])));
      setAnnouncements(Object.fromEntries(result.policies.map((policy) => [policy.platform, policy.announcement])));
      setRollouts(Object.fromEntries(result.releases.map((release) => [release.id, String(release.rolloutPercent)])));
    } catch (error) { setNotice({ tone: "error", message: errorText(error) }); }
    finally { setBusy(false); }
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void refresh(); }, [refresh]);

  async function run(work: () => Promise<unknown>, success: string) {
    setBusy(true); setNotice(null);
    try { await work(); toast(success); await refresh(); }
    catch (error) { setNotice({ tone: "error", message: errorText(error) }); setBusy(false); }
  }
  async function act(release: Release, action: "publish" | "promote" | "withdraw" | "delete") {
    const label = `${platformNames[release.platform]} ${release.version} (${release.build})`;
    if (action !== "publish" && !(await confirm(action === "promote"
      ? { title: t("晋升为正式版"), message: t("{0} 将成为正式版，固定下载链接和客户端更新检查会立即指向它。", [label]), confirmLabel: t("晋升正式版") }
      : action === "withdraw"
        ? { title: t("撤回版本"), message: t("撤回 {0}？固定下载链接会回到上一个已发布版本。", [label]), confirmLabel: t("撤回"), danger: true }
        : { title: t("删除草稿"), message: t("删除 {0} 的草稿记录？对象存储里的文件不会被删除。", [label]), confirmLabel: t("删除"), danger: true }))) return;
    await run(() => api(`/api/v1/admin/client-releases/${release.id}`, { method: "POST", body: JSON.stringify({ action }) }), t("已更新"));
  }
  async function saveMinimum(platform: Platform) {
    const minBuild = Number(minBuilds[platform] || 0);
    if (minBuild > 0 && !(await confirm({ title: t("设置最低版本"), message: t("构建号低于 {0} 的 {1} 客户端将无法登录和连接，并提示下载新版。", [minBuild, platformNames[platform]]), confirmLabel: t("保存"), danger: true }))) return;
    await run(() => api("/api/v1/admin/client-policy", { method: "PUT", body: JSON.stringify({ platform, minBuild }) }), t("已保存"));
  }
  async function saveAnnouncement(platform: Platform) {
    await run(() => api("/api/v1/admin/client-policy", { method: "PUT", body: JSON.stringify({ platform, announcement: announcements[platform] || "" }) }), t("已保存"));
  }
  async function saveRollout(release: Release) {
    const percent = Number(rollouts[release.id]);
    await run(() => api(`/api/v1/admin/client-releases/${release.id}`, { method: "POST", body: JSON.stringify({ action: "rollout", percent }) }), t("已更新"));
  }
  /** Sends the installer to the configured storage and returns its storage key. */
  async function uploadInstaller(file: File, meta: Record<string, string | number>) {
    const sizeError = data?.storage.maxBytes && file.size > data.storage.maxBytes;
    if (sizeError) throw new Error("ARTIFACT_TOO_LARGE");
    const fields = { ...meta, fileName: file.name };
    if (data?.storage.mode === "s3") {
      const target = await api<{ storageKey: string; uploadUrl: string }>("/api/v1/admin/client-releases/uploads", { method: "POST", body: JSON.stringify(fields) });
      await putWithProgress(target.uploadUrl, file, (sent) => setProgress(sent / file.size), false);
      return target.storageKey;
    }
    // Local storage: ordered chunks, each below the default Nginx request limit.
    const chunk = data?.storage.chunkBytes || 8 * 1024 * 1024, upload = crypto.randomUUID();
    let storageKey = "";
    for (let offset = 0; offset < file.size || offset === 0; offset += chunk) {
      const final = offset + chunk >= file.size;
      const query = new URLSearchParams({ ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)])), upload, offset: String(offset), final: final ? "1" : "0" });
      const response = await fetch(`/api/v1/admin/client-releases/files?${query}`, { method: "PUT", credentials: "include", cache: "no-store", headers: { "Content-Type": "application/octet-stream" }, body: file.slice(offset, offset + chunk) });
      if (!response.ok) throw await readError(response);
      storageKey = ((await response.json()) as { storageKey: string }).storageKey;
      setProgress(Math.min(1, (offset + chunk) / Math.max(file.size, 1)));
      if (final) break;
    }
    return storageKey;
  }
  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget), value = (name: string) => String(form.get(name) || "").trim();
    const meta = { platform: value("platform"), arch: value("arch"), version: value("version"), build: Number(value("build")) };
    const body = { ...meta, channel: value("channel"), minOs: value("minOs"), notes: value("notes") };
    const file = form.get("installer"), target = event.currentTarget;
    await run(async () => {
      try {
        if (source === "upload") {
          if (!(file instanceof File) || !file.size) throw new Error(t("请选择安装包文件。"));
          setProgress(0);
          const storageKey = await uploadInstaller(file, meta);
          await api("/api/v1/admin/client-releases", { method: "POST", body: JSON.stringify({ ...body, distribution: "direct", storageKey }) });
        } else {
          await api("/api/v1/admin/client-releases", { method: "POST", body: JSON.stringify({ ...body, distribution: value("distribution"), url: value("url"), sha256: value("sha256") || undefined }) });
        }
        target.reset(); setFormPlatform("android");
      } finally { setProgress(null); }
    }, source === "upload" ? t("安装包已上传并校验，已保存为草稿") : t("草稿已登记，安装包已校验"));
  }
  const visibleReleases = (data?.releases || []).filter((item) => platformFilter === "all" || item.platform === platformFilter);
  const copy = (path: string) => { void navigator.clipboard?.writeText(new URL(path, window.location.origin).href); toast(t("已复制")); };

  return <>
    <PageHeader title={t("客户端发布")} description={t("上传、发布和撤回 Veilbird 客户端，并保留每个平台的历史版本；门户下载、固定下载链接和客户端更新检查都读取这里。")}
      actions={<button className="button ghost" disabled={busy} onClick={() => void refresh()}><Icon name="refresh" size={16} />{busy ? t("加载中…") : t("刷新")}</button>} />
    <InlineNotice notice={notice} />
    {data && <>
      <InlineNotice notice={{ tone: "info", message: [
        data.storage.mode === "s3" ? t("安装包存储：S3 兼容对象存储（{0}）", [data.storage.publicBaseUrl || ""]) : t("安装包存储：Controller 数据卷"),
        data.ciTokenConfigured ? t("发布令牌已配置：CI 或本地脚本可以上传、登记草稿并发布到测试版。") : t("发布令牌未配置：只能在这里手动登记版本。"),
      ].join(" ") }} />
      <section className="panel flush"><div className="panel-head padded"><h2>{t("下载链接与最低版本")}</h2></div>
        <div className="table-wrap"><table className="data-table"><thead><tr><th>{t("平台")}</th><th>{t("固定下载链接")}</th><th>{t("当前正式版")}</th><th>{t("最低构建号")}</th><th>{t("客户端公告")}</th></tr></thead><tbody>{data.policies.map((policy) => {
          const stable = data.releases.filter((item) => item.platform === policy.platform && item.channel === "stable" && item.status === "published").sort((a, b) => b.build - a.build)[0];
          return <tr key={policy.platform}><td>{platformNames[policy.platform]}</td>
            <td><div className="row-actions"><code>{policy.downloadPath}</code><button className="button ghost small" onClick={() => copy(policy.downloadPath)}>{t("复制")}</button></div></td>
            <td>{stable ? `${stable.version} (${stable.build})` : t("尚未发布")}</td>
            <td><div className="row-actions"><input type="number" min={0} style={{ width: 110 }} aria-label={t("最低构建号")} value={minBuilds[policy.platform] ?? "0"} onChange={(event) => setMinBuilds({ ...minBuilds, [policy.platform]: event.target.value })} /><button className="button ghost small" disabled={busy || String(policy.minBuild) === (minBuilds[policy.platform] ?? "0")} onClick={() => void saveMinimum(policy.platform)}>{t("保存")}</button></div></td>
            <td><div className="row-actions"><input maxLength={500} style={{ minWidth: 180 }} aria-label={t("客户端公告")} placeholder={t("留空则不显示")} value={announcements[policy.platform] ?? ""} onChange={(event) => setAnnouncements({ ...announcements, [policy.platform]: event.target.value })} /><button className="button ghost small" disabled={busy || policy.announcement === (announcements[policy.platform] ?? "")} onClick={() => void saveAnnouncement(policy.platform)}>{t("保存")}</button></div></td></tr>;
        })}</tbody></table></div>
      </section>
      <section className="panel release-upload"><div className="panel-head"><h2>{t("上传新版本")}</h2></div>
        <p className="form-note">{data.storage.mode === "s3" ? t("安装包直接上传到对象存储（{0}）。上传后 Controller 会下载一次，记录真实的 SHA-256 和大小，并保存为草稿。", [data.storage.publicBaseUrl || ""]) : t("安装包保存在 Controller 的数据卷里，门户通过固定链接提供下载。上传后自动记录 SHA-256 和大小，并保存为草稿。")}{" "}{t("每个版本都会保留，用户可以在门户查看和下载历史版本；撤回的版本不再显示。")}</p>
        <div className="tabs" role="tablist" aria-label={t("安装包来源")}>
          <button type="button" role="tab" aria-selected={source === "upload"} className={source === "upload" ? "active" : ""} onClick={() => setSource("upload")}>{t("上传安装包")}</button>
          <button type="button" role="tab" aria-selected={source === "url"} className={source === "url" ? "active" : ""} onClick={() => setSource("url")}>{t("填写下载地址")}</button>
        </div>
        <form className="form-grid" onSubmit={(event) => void register(event)}>
          <label>{t("平台")}<select name="platform" value={formPlatform} onChange={(event) => setFormPlatform(event.target.value as Platform)}>{Object.entries(platformNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>{t("架构")}<select name="arch" key={formPlatform} defaultValue={defaultArch[formPlatform]}><option value="universal">universal</option><option value="arm64">arm64</option><option value="x64">x64</option></select></label>
          <label>{t("版本号")}<input name="version" required placeholder="1.2.0" pattern="\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?" /></label>
          <label>{t("构建号")}<input name="build" type="number" min={1} required /></label>
          <label>{t("渠道")}<select name="channel" defaultValue="beta"><option value="beta">{t("测试版")}</option><option value="stable">{t("正式版")}</option></select></label>
          <label>{t("最低系统版本")}<input name="minOs" required key={formPlatform} placeholder={minOsHint[formPlatform]} /></label>
          {source === "upload"
            ? <label className="span-2">{t("安装包文件")}<input name="installer" type="file" required accept={extensions} /><small>{t("支持 .apk、.aab、.zip、.dmg、.pkg、.msix、.exe、.msi，最大 1 GB。iPhone / iPad 请改用「填写下载地址」登记 App Store 或 TestFlight 链接。")}</small></label>
            : <>
              <label>{t("分发方式")}<select name="distribution" defaultValue="direct"><option value="direct">{t("直接下载")}</option><option value="app-store">App Store</option><option value="testflight">TestFlight</option></select></label>
              <label>{t("下载地址")}<input name="url" type="url" required placeholder="https://downloads.example.com/…" /></label>
              <label className="span-2">{t("SHA-256（可选，用于核对）")}<input name="sha256" pattern="[A-Fa-f0-9]{64}" /></label>
            </>}
          <label className="span-2">{t("更新说明")}<textarea name="notes" maxLength={4000} rows={3} placeholder={t("用户会在门户的下载区看到这段说明。")} /></label>
          {progress !== null && <div className="span-2 upload-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}><i style={{ width: `${Math.round(progress * 100)}%` }} /><span>{progress < 1 ? t("正在上传 {0}%", [Math.round(progress * 100)]) : t("正在校验…")}</span></div>}
          <div className="span-2 form-actions"><button className="button primary" disabled={busy}>{source === "upload" ? t("上传并保存草稿") : t("登记草稿")}</button></div>
        </form>
      </section>
      <section className="panel flush"><div className="panel-head padded"><h2>{t("版本历史")}</h2></div>
        <div className="table-toolbar"><div className="chips" role="group" aria-label={t("平台")}>{(["all", ...Object.keys(platformNames)] as Array<"all" | Platform>).map((value) => <button key={value} type="button" className={platformFilter === value ? "active" : ""} aria-pressed={platformFilter === value} onClick={() => setPlatformFilter(value)}>{value === "all" ? t("全部") : platformNames[value]}<em>{data.releases.filter((item) => value === "all" || item.platform === value).length}</em></button>)}</div></div>
        {visibleReleases.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>{t("版本")}</th><th>{t("平台")}</th><th>{t("渠道")}</th><th>{t("状态")}</th><th>{t("灰度")}</th><th>{t("安装包")}</th><th>{t("发布时间")}</th><th className="align-right">{t("操作")}</th></tr></thead><tbody>{visibleReleases.map((release) => <tr key={release.id}>
          <td><b>{release.version}</b><small> · {t("构建 {0}", [release.build])}</small>{release.notes && <small><br />{release.notes}</small>}</td>
          <td>{platformNames[release.platform]} · {release.arch}<small><br />{release.minOs}</small></td>
          <td><Pill value={release.channel} label={release.channel === "stable" ? t("正式版") : t("测试版")} tone={release.channel === "stable" ? "success" : "progress"} /></td>
          <td><Pill value={release.status} label={release.status === "published" ? t("已发布") : release.status === "draft" ? t("草稿") : t("已撤回")} tone={release.status === "published" ? "success" : release.status === "draft" ? "neutral" : "warning"} /></td>
          <td>{release.status !== "withdrawn" && <div className="row-actions"><input type="number" min={1} max={100} style={{ width: 80 }} aria-label={t("灰度比例 (%)")} title={t("灰度比例 (%)")} value={rollouts[release.id] ?? "100"} onChange={(event) => setRollouts({ ...rollouts, [release.id]: event.target.value })} /><small>%</small>
              <button className="button ghost small" disabled={busy || String(release.rolloutPercent) === (rollouts[release.id] ?? "100")} onClick={() => void saveRollout(release)}>{t("保存")}</button></div>}</td>
          <td><a href={release.url} target="_blank" rel="noopener noreferrer">{release.distribution === "direct" ? formatBytes(release.sizeBytes) : release.distribution}</a>{release.sha256 && <small><br /><code title={release.sha256}>{release.sha256.slice(0, 12)}…</code></small>}</td>
          <td>{release.publishedAt ? formatTime(release.publishedAt) : "—"}</td>
          <td className="align-right cell-actions"><div className="row-actions">
            {release.status !== "published" && <button className="button ghost small" disabled={busy} onClick={() => void act(release, "publish")}>{release.channel === "stable" ? t("发布正式版") : t("发布测试版")}</button>}
            {release.channel === "beta" && release.status !== "withdrawn" && !release.version.includes("-") && release.distribution !== "testflight" && <button className="button primary small" disabled={busy} onClick={() => void act(release, "promote")}>{t("晋升正式版")}</button>}
            {release.status === "published" && <button className="button danger small" disabled={busy} onClick={() => void act(release, "withdraw")}>{t("撤回")}</button>}
            {release.status === "draft" && <button className="button danger small" disabled={busy} onClick={() => void act(release, "delete")}>{t("删除")}</button>}
          </div></td></tr>)}</tbody></table></div>
          : <Empty>{platformFilter === "all" ? t("还没有任何版本。在上方上传安装包，或用 npm run release:client 发布。") : t("这个平台还没有版本。")}</Empty>}
      </section>
      <section className="panel flush"><div className="panel-head padded"><h2>{t("版本分布")}</h2></div>
        {data.adoption.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>{t("平台")}</th><th>{t("版本")}</th><th>{t("授权设备")}</th></tr></thead><tbody>{data.adoption.map((row) => <tr key={`${row.platform}:${row.version}:${row.build}`}><td>{platformNames[row.platform as Platform] || row.platform}</td><td>{row.version ? `${row.version} (${row.build})` : t("未上报")}</td><td>{row.devices}</td></tr>)}</tbody></table></div>
          : <Empty>{t("还没有授权设备上报版本。")}</Empty>}
      </section>
      <section className="panel flush"><div className="panel-head padded"><h2>{t("连接失败上报（近 7 天）")}</h2></div>
        {data.diagnostics.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>{t("平台")}</th><th>{t("构建号")}</th><th>{t("错误代码")}</th><th>{t("次数")}</th><th>{t("用户数")}</th><th>{t("最近一次")}</th></tr></thead><tbody>{data.diagnostics.map((row) => <tr key={`${row.platform}:${row.build}:${row.code}`}><td>{platformNames[row.platform as Platform] || row.platform}</td><td>{row.build ?? t("未上报")}</td><td><code>{row.code}</code></td><td>{row.events}</td><td>{row.users}</td><td>{row.lastAt ? formatTime(row.lastAt) : "—"}</td></tr>)}</tbody></table></div>
          : <Empty>{t("近 7 天没有客户端上报连接失败。")}</Empty>}
      </section>
    </>}
  </>;
}
