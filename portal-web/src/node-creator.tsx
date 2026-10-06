import { useI18n } from "../../shared/i18n";
import { useState } from "react";
import { x25519 } from "@noble/curves/ed25519.js";
import { api, fetchText, isUnauthorized } from "./api";
import { clientFormat, clientName, clientOptions, clientProtocol, type ClientChoice } from "./client-options";
import { filenamePart, profileFilename, saveFiles, type DownloadFile, type Profile } from "./files";
import { protocolLabel } from "./format";
import { AppIcon, Icon, InlineError, type Notify } from "./ui";

export type Region = { id: string; name: string; country: string; code: string; protocols: string[]; status: string; protocolNodeCounts?: Record<string, number> };
export type AvailableNode = { id: string; name: string; regionId: string; regionName: string; protocols: string[] };
export type NodePreset = { name: string; client: ClientChoice; nodeId: string };
type Download = { client: ClientChoice; protocol: string; name: string; files: DownloadFile[] };

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const flexible = (client: ClientChoice) => client === "clash" || client === "hiddify";
const wanted = (client: ClientChoice, preference: string) => flexible(client) ? (preference ? [preference] : ["wireguard", "vless"]) : [clientProtocol(client)];
const supports = (node: AvailableNode, client: ClientChoice, preference = "") => wanted(client, preference).some((protocol) => node.protocols.includes(protocol));

/** Fixed-node flow: pick the client first, then a compatible node; incompatible choices stay visible with a reason. */
export function NodeCreator({ nodes, regions, regionId, onRegion, preset, notify, onCreated, onUnauthorized }: {
  nodes: AvailableNode[]; regions: Region[]; regionId: string; onRegion: (id: string) => void; preset?: NodePreset;
  notify: Notify; onCreated: (credentialId: string) => void /* "" = refresh only */; onUnauthorized: () => void;
}) {
  const { t } = useI18n();
  const [client, setClient] = useState<ClientChoice>(preset?.client || "hiddify");
  const [preference, setPreference] = useState("");
  const [nodeId, setNodeId] = useState(preset?.nodeId || "");
  const [customName, setName] = useState<string | null>(preset?.name ?? null);
  const name = customName ?? t("我的 VPN");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [download, setDownload] = useState<Download | null>(null);

  const visibleNodes = nodes.filter((node) => !regionId || node.regionId === regionId).sort((a, b) => Number(supports(b, client, preference)) - Number(supports(a, client, preference)));
  const chosen = visibleNodes.find((node) => node.id === nodeId && supports(node, client, preference)) || visibleNodes.find((node) => supports(node, client, preference));
  const protocol = flexible(client) ? (preference || (chosen?.protocols.includes("wireguard") ? "wireguard" : "vless")) : clientProtocol(client);
  const wantedLabel = (target: ClientChoice) => wanted(target, flexible(target) ? preference : "").map(protocolLabel).join(" / ");
  const regionsWithNodes = regions.filter((region) => nodes.some((node) => node.regionId === region.id));

  async function create(event?: React.FormEvent) {
    event?.preventDefault();
    if (busy || !chosen) return;
    if (!name.trim()) { setError(t("请输入连接名称，不能只包含空格。")); return; }
    setBusy(true); setError(""); setDownload(null);
    let createdCredentialId = "", profileIssued = false;
    try {
      const privateBytes = protocol === "wireguard" ? x25519.utils.randomSecretKey() : null;
      const clientPrivateKey = privateBytes ? base64(privateBytes) : undefined;
      const publicKey = privateBytes ? base64(x25519.getPublicKey(privateBytes)) : undefined;
      const created = await api<{ credential: { id: string } }>("/api/v1/credentials", { method: "POST", body: JSON.stringify({ name: name.trim(), protocol, publicKey }) });
      createdCredentialId = created.credential.id;
      const issued = await api<{ profile: Profile; profiles?: Profile[] }>("/api/v1/profiles", { method: "POST", body: JSON.stringify({ credentialId: created.credential.id, nodeId: chosen.id, protocol, clientPrivateKey }) });
      profileIssued = true;
      const issuedProfiles = issued.profiles?.length ? issued.profiles : [issued.profile];
      const activated = await Promise.all(issuedProfiles.map(async (item) => ({ ...(await api<{ profile: Profile }>(`/api/v1/profiles/${item.id}/activate`, { method: "POST" })).profile, displayName: name })));
      const mihomo = clientFormat(client) === "mihomo";
      const files = await Promise.all(activated.map(async (item) => ({
        name: mihomo ? profileFilename(item).replace(/\.conf$/, `-${item.id}-Clash.yaml`) : profileFilename(item),
        text: await fetchText(`/api/v1/profiles/${item.id}/download${mihomo ? "?format=mihomo" : ""}`),
      })));
      const prepared: Download = { client, protocol, files, name: `${filenamePart(name, "credential")}-${clientName(client)}.zip` };
      setDownload(prepared); saveFiles(prepared.files, prepared.name);
      notify(t("「{0}」已创建，{1} 配置开始下载。", [name.trim(), clientName(client)]));
      onCreated(created.credential.id);
    } catch (caught) {
      if (createdCredentialId && !profileIssued) await api(`/api/v1/credentials/${createdCredentialId}/revoke`, { method: "POST" }).catch(() => undefined);
      if (isUnauthorized(caught)) onUnauthorized(); else setError((caught as Error).message);
      if (createdCredentialId) onCreated(""); // refresh only; a half-created connection is revoked or shown as is
    } finally { setBusy(false); }
  }

  return <form className="node-creator" onSubmit={create}>
    <fieldset className="step" disabled={busy}>
      <legend><span className="step-no">1</span>{t("你用哪个客户端？")}</legend>
      <div className="choice-grid">{clientOptions.map((option) => {
        const count = nodes.filter((node) => supports(node, option.id, flexible(option.id) ? preference : "")).length;
        return <label key={option.id} className={`choice ${client === option.id ? "selected" : ""} ${count ? "" : "unavailable"}`}>
          <input type="radio" name="client" value={option.id} checked={client === option.id} disabled={!count} onChange={() => setClient(option.id)} />
          <AppIcon id={option.id} /><span><b>{option.name}</b><small>{count ? t(option.description) : t("暂无支持 {0} 的节点", [wantedLabel(option.id)])}</small></span>
        </label>;
      })}</div>
      {flexible(client) && <div className="inline-field"><span>{t("连接协议")}</span><div className="segmented" role="group" aria-label={t("连接协议")}>{[["", t("自动")], ["wireguard", "WireGuard"], ["vless", "VLESS"]].map(([value, label]) => <button key={value} type="button" aria-pressed={preference === value} onClick={() => setPreference(value)}>{label}</button>)}</div></div>}
    </fieldset>
    <fieldset className="step" disabled={busy}>
      <legend><span className="step-no">2</span>{t("选择节点")}</legend>
      {regionsWithNodes.length > 1 && <div className="chips" role="group" aria-label={t("按区域筛选")}><button type="button" aria-pressed={!regionId} onClick={() => onRegion("")}>{t("全部区域")}</button>{regionsWithNodes.map((region) => <button key={region.id} type="button" aria-pressed={regionId === region.id} onClick={() => onRegion(region.id)}>{region.name}</button>)}</div>}
      <div className="choice-grid nodes">{visibleNodes.map((node) => {
        const ok = supports(node, client, preference);
        return <label key={node.id} className={`choice ${chosen?.id === node.id ? "selected" : ""} ${ok ? "" : "unavailable"}`}>
          <input type="radio" name="node" value={node.id} checked={chosen?.id === node.id} disabled={!ok} onChange={() => setNodeId(node.id)} />
          <span className="region-code">{(regions.find((region) => region.id === node.regionId)?.code || "··").slice(0, 2).toUpperCase()}</span>
          <span><b>{node.regionName} · {node.name}</b><small>{ok ? node.protocols.map(protocolLabel).join(" · ") : t("不支持 {0}", [wantedLabel(client)])}</small></span>
        </label>;
      })}{!visibleNodes.length && <p className="hint">{nodes.length ? t("这个区域暂无节点，请选择其他区域。") : t("暂无可用节点，请等待管理员部署。")}</p>}</div>
    </fieldset>
    <fieldset className="step" disabled={busy}>
      <legend><span className="step-no">3</span>{t("命名并下载")}</legend>
      <div className="create-row"><label>{t("连接名称")}<input required value={name} maxLength={120} onChange={(event) => setName(event.target.value)} placeholder={t("例如：公司电脑")} /></label>
        <button className="primary large" disabled={busy || !chosen}>{Icon.download()}{busy ? t("处理中…") : t("创建并下载")}</button></div>
      <p className="hint">{chosen ? t("将生成 {0} · {1} 的 {2} 配置，有效期 1 年。", [chosen.regionName, chosen.name, protocolLabel(protocol)]) : t("请先选择可用的客户端和节点。")}{client === "clash" ? t(" 需要 Mihomo 内核的 Clash 客户端。") : ""}{t("仅包含所选节点，节点变化时请重新生成。")}</p>
    </fieldset>
    {error && <InlineError message={error} onRetry={() => void create()} busy={busy} />}
    {download && <div className="callout success" role="status"><div><b>{t("已开始下载，下一步导入")}{clientName(download.client)}</b>
      <p>{download.files.length > 1 ? t("先解压下载的 ZIP，再选择一份配置文件导入。") : t("在客户端选择「导入配置 / 从文件导入」，打开刚下载的文件。")}{download.client === "clash" ? t(" 启用配置后，打开系统代理或 TUN。") : t(" 导入后开启连接。")}{download.protocol === "wireguard" ? t(" 同一份 WireGuard 连接请勿在多个设备同时开启。") : ""}{download.protocol === "vless" ? t(" 也可在连接详情里复制 vless:// 链接或扫码导入。") : ""}</p></div>
      <button type="button" className="secondary" onClick={() => saveFiles(download.files, download.name)}>{t("重新下载")}</button></div>}
  </form>;
}
