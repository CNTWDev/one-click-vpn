import { useState } from "react";
import { api } from "../api";
import { formatTime, InlineNotice, type Notice } from "./shared";

export type RealityDefaults = { serverName: string; checkedAt: string | null; updatedAt: string | null };
export function RealityTargetSetup({ defaults, onSaved }: { defaults: RealityDefaults; onSaved: (value: RealityDefaults) => void }) {
  const [name, setName] = useState(defaults.serverName);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const host = name.trim().toLowerCase();
  const commandReady = host.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) && /^[a-zA-Z0-9._+%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email.trim());
  const command = commandReady ? `sudo sh scripts/setup-reality-target.sh --domain ${host} --email ${email.trim()}` : "";
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setNotice(null);
    try {
      const result = await api<RealityDefaults>("/api/reality-defaults", { method: "PUT", body: JSON.stringify({ serverName: host }) });
      onSaved(result); setName(result.serverName);
      setNotice({ tone: "success", message: "默认目标已检测并保存。新建或等待目标的 VLESS 服务将自动使用；已有目标和用户配置不变。" });
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(false); }
  }
  return <details className="panel" open={!defaults.serverName || undefined}>
    <summary><b>默认 REALITY 目标</b> · {defaults.serverName || "首次使用请先设置"}</summary>
    <form className="stack-form" onSubmit={save}>
      <p>平台只需设置一次；标准模板自动为新节点部署 VLESS，不需要逐台启用。目标未配置时仅 VLESS 等待配置，不影响 WireGuard / OpenVPN。使用独立静态站点，不要填写 APP、Console 或 API 域名。</p>
      <label>独立站点域名<input required maxLength={253} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 www.example.com" /></label>
      <details><summary>还没有目标站点？查看一键初始化步骤</summary>
        <ol><li>将上面的域名解析到管理服务器，并放行 TCP 80 / 443。不要解析到所有 VPN 节点。</li><li>在管理服务器项目目录运行下方命令。脚本启动独立静态服务、配置 Nginx、申请证书并设置自动续期。</li><li>回到这里点击“检测并保存”，以后部署节点无需重复填写。</li></ol>
        <label>证书续期联系邮箱<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="运维邮箱，仅用于生成命令" /></label>
        {command && <p><code style={{ overflowWrap: "anywhere" }}>{command}</code></p>}
        <button className="button ghost" type="button" disabled={!commandReady} onClick={() => void navigator.clipboard.writeText(command).then(() => setNotice({ tone: "success", message: "命令已复制，请在管理服务器执行；此按钮不会直接部署服务器。" })).catch(() => setNotice({ tone: "error", message: "无法访问剪贴板，请手动复制命令。" }))}>复制初始化命令</button>
        <p>需要主机已有 Nginx、Certbot、Docker Compose 和 systemd。宝塔等面板需指定实际 Nginx 配置目录，详见部署文档。域名和证书只需准备一份。</p>
      </details>
      <p>{defaults.checkedAt ? `上次控制端检测：${formatTime(defaults.checkedAt)}。这不是实时健康状态，各节点部署时仍会独立检测。` : "尚无控制端检测记录。保存前会检查公网解析、证书、TLS 1.3 和 HTTP/2。"} 修改默认值不会迁移已有节点。</p>
      <InlineNotice notice={notice} />
      <div><button className="button primary" disabled={busy}>{busy ? "正在检测…" : "检测并保存"}</button></div>
    </form>
  </details>;
}
