import { t, useConsoleLanguage } from "../i18n";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useConfirm } from "../confirm-dialog";
import { formatTime, InlineNotice, type Notice } from "./shared";
type Access = {managed:boolean;limit:number;limitSource:string;used:number;expiresAt:string|null;devices:{id:string;name:string;platform:string;status:string;lastSeenAt:string;releaseAfter:string|null}[]};
const messages:Record<string,string>={LEGACY_ACCESS_MIGRATION_REQUIRED:"该账号曾导出配置，不能直接切换严格设备控制。请使用新账号试点；旧账号需先完成凭据迁移及所有节点失效确认。",REVOKE_DEVICES_FIRST:"请先解除多余设备的授权，等待生效后再修改。",INVALID_DEVICE_LIMIT:"设备上限应为 1–100。"};
export function NativeAccessPanel({userId}:{userId:string}) {
  useConsoleLanguage();
  const [data,setData]=useState<Access|null>(null),[notice,setNotice]=useState<Notice|null>(null),[busy,setBusy]=useState(false);
  const [managed,setManaged]=useState(false),[limit,setLimit]=useState(""),[expiry,setExpiry]=useState("");
  const confirm=useConfirm(),path=`/api/v1/admin/users/${userId}/native-access`;
  function apply(value:Access) {setData(value);setManaged(value.managed);setLimit(value.limitSource==="default"?"":String(value.limit));setExpiry(value.expiresAt?.slice(0,10)||"");}
  useEffect(()=>{let current=true;api<Access>(path).then(value=>{if(current)apply(value);}).catch(error=>{if(current)setNotice({tone:"error",message:error.message});});return()=>{current=false;};},[path]);
  async function update(body:unknown) {
    setBusy(true);setNotice(null);
    try {apply(await api<Access>(path,{method:"POST",body:JSON.stringify(body)}));setNotice({tone:"success",message:t("已保存。解除授权需节点同步，离线节点最多等待约 5 分钟；生效前继续占用额度。")});}
    catch(error) {const message=(error as Error).message;setNotice({tone:"error",message:messages[message]?t(messages[message]):message});}
    finally {setBusy(false);}
  }
  return <section className="access-subsection"><h3>{t("Veilbird 授权设备")}</h3><InlineNotice notice={notice}/>{data&&<>
    <p>{t("设备额度与会员有效期仅对 Veilbird 模式生效。兼容模式无法限制第三方配置复制后的设备数量。")}</p>
    <div className="account-access-toolbar"><label>{t("访问方式")}<select disabled={busy} value={managed?"managed":"legacy"} onChange={e=>setManaged(e.target.value==="managed")}><option value="legacy">{t("兼容模式 · 保留第三方客户端")}</option><option value="managed">{t("仅 Veilbird · 严格授权设备")}</option></select></label><label>{t("设备上限")}<input type="number" min={1} max={100} placeholder={t("系统默认（{0}）", [data.limit])} value={limit} onChange={e=>setLimit(e.target.value)}/></label><label>{t("会员有效期（UTC）")}<input type="date" value={expiry} onChange={e=>setExpiry(e.target.value)}/></label><button className="button primary" disabled={busy} onClick={()=>void update({action:"settings",managed,limit:limit===""?null:Number(limit),expiresAt:expiry?`${expiry}T23:59:59.999Z`:null})}>{t("保存设置")}</button></div>
    <p>{t("已授权设备：{0} / {1}", [data.used, data.limit])} · {t("留空额度跟随系统默认，留空有效期表示不限期。")}</p>
    <div className="review-list">{data.devices.filter(d=>d.status!=="revoked").map(d=><div key={d.id}><span className="grow"><b>{d.name}</b><small>{d.platform}{t("· 最近使用")}{formatTime(d.lastSeenAt)}</small>{d.status==="revoking"&&<small>{t("解除中，预计 {0} 后释放额度", [formatTime(d.releaseAfter)])}</small>}</span><button className="button danger" disabled={busy||d.status!=="active"} onClick={async()=>{if(await confirm({title:t("解除设备授权"),message:t("解除 {0} 的授权？这台设备将无法继续连接。", [d.name]),confirmLabel:t("解除授权"),danger:true}))await update({action:"revoke",enrollmentId:d.id});}}>{t("解除授权")}</button></div>)}</div>
  </>}</section>;
}
