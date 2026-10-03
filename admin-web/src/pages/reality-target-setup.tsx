import { useState } from "react";
import { api } from "../api";
import { useToast } from "../toast";
import { formatTime, InlineNotice, type Notice } from "./shared";

export type RealityMode = "auto" | "custom";
export type RealityDefaults = { mode: RealityMode; serverName: string; candidates: string[]; checkedAt: string | null; updatedAt: string | null };

/** Older Controllers return only { serverName }: a saved name means the self-hosted (custom) flow. */
export function normalizeRealityDefaults(value: Partial<RealityDefaults>): RealityDefaults {
  const serverName = value.serverName || "";
  return { mode: value.mode === "custom" || value.mode === "auto" ? value.mode : serverName ? "custom" : "auto", serverName, candidates: value.candidates || [], checkedAt: value.checkedAt ?? null, updatedAt: value.updatedAt ?? null };
}

export function RealityTargetSetup({ defaults, onSaved }: { defaults: RealityDefaults; onSaved: (value: RealityDefaults) => void }) {
  const [mode, setMode] = useState<RealityMode>(defaults.mode);
  const [name, setName] = useState(defaults.serverName);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const toast = useToast();
  const host = name.trim().toLowerCase();
  const commandReady = host.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) && /^[a-zA-Z0-9._+%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email.trim());
  const command = commandReady ? `sudo sh scripts/setup-reality-target.sh --domain ${host} --email ${email.trim()}` : "";
  const unchanged = mode === defaults.mode && (mode === "auto" || host === defaults.serverName);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setNotice(null);
    try {
      const result = normalizeRealityDefaults(await api<RealityDefaults>("/api/reality-defaults", { method: "PUT", body: JSON.stringify(mode === "auto" ? { mode: "auto" } : { mode: "custom", serverName: host }) }));
      onSaved(result); setName(result.serverName);
      toast(mode === "auto" ? "已切换为自动选择：各节点将自动探测并使用各自最合适的目标。" : "自定义目标已检测并保存。新建或等待目标的 VLESS 服务将自动使用。");
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(false); }
  }
  return <form className="panel reality-setup" onSubmit={save}>
    <div className="panel-head"><div><h2>REALITY 目标</h2><p>VLESS + REALITY 伪装成访问某个真实 HTTPS 站点。平台统一设置一次，标准模板自动为新节点部署 VLESS。</p></div></div>
    <div className="choice-cards" role="radiogroup" aria-label="REALITY 目标模式">
      <label className={`choice-card ${mode === "auto" ? "active" : ""}`}><input type="radio" name="reality-mode" value="auto" checked={mode === "auto"} onChange={() => setMode("auto")} /><span><b>自动选择 <em className="pill tone-success">推荐</em></b><small>每个节点从内置的大型公共站点池（TLS 1.3 + HTTP/2）中自动探测，各自选用最合适的目标。零配置，无需准备域名或证书。</small></span></label>
      <label className={`choice-card ${mode === "custom" ? "active" : ""}`}><input type="radio" name="reality-mode" value="custom" checked={mode === "custom"} onChange={() => setMode("custom")} /><span><b>自定义目标（高级）</b><small>使用你自己部署的独立静态站点作为所有节点的统一目标，需要自行准备域名、证书并保持站点可用。</small></span></label>
    </div>
    {mode === "auto" ? <div className="reality-auto">
      {defaults.candidates.length ? <><small>内置候选站点（{defaults.candidates.length}）</small><div className="candidate-list">{defaults.candidates.map((item) => <code key={item}>{item}</code>)}</div></> : <small>候选站点由 Controller 内置维护，节点部署时自动探测。</small>}
    </div> : <div className="stack-form">
      <label>独立站点域名<input required maxLength={253} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 www.example.com" /><small>使用独立静态站点，不要填写 APP、Console 或 API 域名。目标未就绪时仅 VLESS 等待配置，不影响 WireGuard / OpenVPN。</small></label>
      <details className="disclosure"><summary>还没有目标站点？查看一键初始化步骤</summary>
        <ol><li>将上面的域名解析到管理服务器，并放行 TCP 80 / 443。不要解析到所有 VPN 节点。</li><li>在管理服务器项目目录运行下方命令。脚本启动独立静态服务、配置 Nginx、申请证书并设置自动续期。</li><li>回到这里点击“检测并保存”，以后部署节点无需重复填写。</li></ol>
        <label>证书续期联系邮箱<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="运维邮箱，仅用于生成命令" /></label>
        {command && <p><code className="command">{command}</code></p>}
        <button className="button ghost" type="button" disabled={!commandReady} onClick={() => void navigator.clipboard.writeText(command).then(() => toast("命令已复制，请在管理服务器执行；此按钮不会直接部署服务器。")).catch(() => setNotice({ tone: "error", message: "无法访问剪贴板，请手动复制命令。" }))}>复制初始化命令</button>
        <p>需要主机已有 Nginx、Certbot、Docker Compose 和 systemd。宝塔等面板需指定实际 Nginx 配置目录，详见部署文档。域名和证书只需准备一份。</p>
      </details>
      <small>{defaults.mode === "custom" && defaults.checkedAt ? `上次控制端检测：${formatTime(defaults.checkedAt)}。这不是实时健康状态，各节点部署时仍会独立检测。` : "保存前会检查公网解析、证书、TLS 1.3 和 HTTP/2。"}</small>
    </div>}
    <p className="reality-foot">保存后，新建或等待目标的 VLESS 服务立即使用新设置；已在运行的节点保持原目标。需要为某台节点更换时，在“服务状态”点 VLESS 徽标进入高级设置，更换为平滑切换：旧目标在过渡期内仍然有效，客户端下次刷新订阅时自动使用新目标。{defaults.updatedAt ? ` 最近修改：${formatTime(defaults.updatedAt)}。` : ""}</p>
    <InlineNotice notice={notice} />
    <div className="form-actions"><button className="button primary" disabled={busy || unchanged}>{busy ? "正在检测…" : mode === "auto" ? (defaults.mode === "auto" ? "已在使用自动选择" : "切换为自动选择") : "检测并保存"}</button></div>
  </form>;
}
