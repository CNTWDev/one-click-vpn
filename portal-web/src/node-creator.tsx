import { useI18n } from "../../shared/i18n";
import { useState } from "react";
import { x25519 } from "@noble/curves/ed25519.js";
import { api, isUnauthorized } from "./api";
import { protocolLabel } from "./format";
import { Icon, InlineError } from "./ui";

export type Region = { id: string; name: string; code: string };
export type AvailableNode = { id: string; name: string; regionId: string; regionName: string; protocols: string[] };
/** A single-node config is one of these; subscriptions are made on the home page only. */
export const configProtocols = ["wireguard", "openvpn", "vless"] as const;

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const apps: Record<string, string> = { wireguard: "WireGuard", openvpn: "OpenVPN Connect", vless: "Shadowrocket · v2rayNG · Clash" };

/** Pick a node, then one of its protocols, name it: one config for that node only. */
export function NodeCreator({ nodes, regions, deviceNote, onCreated, onUnauthorized }: {
  nodes: AvailableNode[]; regions: Region[]; deviceNote: string; onCreated: (credentialId: string) => void; onUnauthorized: () => void;
}) {
  const { t } = useI18n();
  const [nodeId, setNodeId] = useState(""), [protocol, setProtocol] = useState("");
  const [name, setName] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const node = nodes.find((item) => item.id === nodeId) || nodes[0];
  const offered = configProtocols.filter((item) => node?.protocols.includes(item));
  const chosen = offered.includes(protocol as typeof offered[number]) ? protocol : offered[0] || "";
  const code = (item: AvailableNode) => (regions.find((region) => region.id === item.regionId)?.code || "··").slice(0, 2).toUpperCase();

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !node || !chosen) return;
    const label = name.trim() || `${node.regionName} · ${protocolLabel(chosen)}`;
    setBusy(true); setError("");
    let credentialId = "", issued = false;
    try {
      // WireGuard keys are made here, so the private key never has to be stored by the server unencrypted.
      const secret = chosen === "wireguard" ? x25519.utils.randomSecretKey() : null;
      const created = await api<{ credential: { id: string } }>("/api/v1/credentials", { method: "POST", body: JSON.stringify({ name: label, protocol: chosen, publicKey: secret ? base64(x25519.getPublicKey(secret)) : undefined }) });
      credentialId = created.credential.id;
      const result = await api<{ profile: { id: string }; profiles?: Array<{ id: string }> }>("/api/v1/profiles", { method: "POST", body: JSON.stringify({ credentialId, nodeId: node.id, protocol: chosen, clientPrivateKey: secret ? base64(secret) : undefined }) });
      issued = true;
      await Promise.all((result.profiles?.length ? result.profiles : [result.profile]).map((item) => api(`/api/v1/profiles/${item.id}/activate`, { method: "POST" })));
      setName("");
      onCreated(credentialId);
    } catch (caught) {
      // A config without a profile is useless and would hold a device: take it back.
      if (credentialId && !issued) await api(`/api/v1/credentials/${credentialId}/revoke`, { method: "POST" }).catch(() => undefined);
      if (isUnauthorized(caught)) onUnauthorized(); else setError((caught as Error).message);
      if (credentialId && issued) onCreated(credentialId);
    } finally { setBusy(false); }
  }

  if (!nodes.length) return <p className="hint">{t("暂无可用节点，请等待管理员部署。")}</p>;
  return <form className="node-creator" onSubmit={(event) => void create(event)}>
    <fieldset className="step" disabled={busy}>
      <legend><span className="step-no">1</span>{t("选择节点")}</legend>
      <div className="choice-grid nodes">{nodes.map((item) => <label key={item.id} className={`choice ${node?.id === item.id ? "selected" : ""}`}>
        <input type="radio" name="node" value={item.id} checked={node?.id === item.id} onChange={() => setNodeId(item.id)} />
        <span className="region-code">{code(item)}</span>
        <span><b>{item.regionName} · {item.name}</b><small>{item.protocols.filter((value) => (configProtocols as readonly string[]).includes(value)).map(protocolLabel).join(" · ")}</small></span>
      </label>)}</div>
    </fieldset>
    <fieldset className="step" disabled={busy}>
      <legend><span className="step-no">2</span>{t("选择协议")}</legend>
      <div className="choice-grid">{configProtocols.map((item) => {
        const ok = offered.includes(item);
        return <label key={item} className={`choice ${chosen === item ? "selected" : ""} ${ok ? "" : "unavailable"}`}>
          <input type="radio" name="protocol" value={item} checked={chosen === item} disabled={!ok} onChange={() => setProtocol(item)} />
          <span><b>{protocolLabel(item)}</b><small>{ok ? apps[item] : t("这个节点暂不支持")}</small></span>
        </label>;
      })}</div>
    </fieldset>
    <fieldset className="step" disabled={busy}>
      <legend><span className="step-no">3</span>{t("命名并生成")}</legend>
      <div className="create-row"><label>{t("名称（方便你区分）")}<input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} placeholder={t("例如：公司电脑")} /></label>
        <button className="primary large" disabled={busy || !chosen}>{Icon.plus()}{busy ? t("处理中…") : t("生成配置")}</button></div>
      <p className="hint">{node && chosen ? t("将生成 {0} · {1} 的 {2} 配置，有效期 1 年。", [node.regionName, node.name, protocolLabel(chosen)]) : t("请先选择节点。")} {deviceNote}</p>
    </fieldset>
    {error && <InlineError message={error} />}
  </form>;
}
