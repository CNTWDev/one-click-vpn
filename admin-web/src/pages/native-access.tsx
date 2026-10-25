import { t, useConsoleLanguage } from "../i18n";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useConfirm } from "../confirm-dialog";
import { formatTime, InlineNotice, type Notice } from "./shared";
type Access = {managed:boolean;limit:number|null;used:number;devices:{id:string;name:string;platform:string;status:string;lastSeenAt:string;releaseAfter:string|null}[]};
const messages:Record<string,string>={LEGACY_ACCESS_MIGRATION_REQUIRED:"该账号曾导出配置，不能直接切换严格设备控制。请使用新账号试点；旧账号需先完成凭据迁移及所有节点失效确认。",REVOKE_DEVICES_FIRST:"请先解除多余设备的授权，等待生效后再修改。"};
export function NativeAccessPanel({userId}:{userId:string}) {
  useConsoleLanguage();
  const [data,setData]=useState<Access|null>(null),[notice,setNotice]=useState<Notice|null>(null),[busy,setBusy]=useState(false);
  const [managed,setManaged]=useState(false);
  const confirm=useConfirm(),path=`/api/v1/admin/users/${userId}/native-access`;
  function apply(value:Access) {setData(value);setManaged(value.managed);}
  useEffect(()=>{let current=true;api<Access>(path).then(value=>{if(current)apply(value);}).catch(error=>{if(current)setNotice({tone:"error",message:error.message});});return()=>{current=false;};},[path]);
  async function update(body:unknown) {
    setBusy(true);setNotice(null);
    try {apply(await api<Access>(path,{method:"POST",body:JSON.stringify(body)}));setNotice({tone:"success",message:t("已保存。解除授权需节点同步，离线节点最多等待约 5 分钟；生效前继续占用额度。")});}
    catch(error) {const message=(error as Error).message;setNotice({tone:"error",message:messages[message]?t(messages[message]):message});}
    finally {setBusy(false);}
  }
  return <section className="access-subsection"><h3>{t("TrackNothing 授权设备")}</h3><InlineNotice notice={notice}/>{data&&<>
    <p>{t("所有账号都能用 TrackNothing 客户端登录连接，设备上限由账号套餐决定。选择「仅 TrackNothing」会同时停用该账号的订阅和第三方配置。")}</p>
    <div className="account-access-toolbar"><label>{t("访问方式")}<select disabled={busy} value={managed?"managed":"legacy"} onChange={e=>setManaged(e.target.value==="managed")}><option value="legacy">{t("客户端和订阅都可用")}</option><option value="managed">{t("仅 TrackNothing · 严格授权设备")}</option></select></label><button className="button primary" disabled={busy} onClick={()=>void update({action:"settings",managed})}>{t("保存设置")}</button></div>
    <p>{t("设备数（含订阅和节点配置）：{0} / {1}", [data.used, data.limit ?? t("不限")])}</p>
    <div className="review-list">{data.devices.filter(d=>d.status!=="revoked").map(d=><div key={d.id}><span className="grow"><b>{d.name}</b><small>{d.platform} · {t("最近使用 {0}", [formatTime(d.lastSeenAt)])}</small>{d.status==="revoking"&&<small>{t("解除中，预计 {0} 后释放额度", [formatTime(d.releaseAfter)])}</small>}</span><button className="button danger" disabled={busy||d.status!=="active"} onClick={async()=>{if(await confirm({title:t("解除设备授权"),message:t("解除 {0} 的授权？这台设备将无法继续连接。", [d.name]),confirmLabel:t("解除授权"),danger:true}))await update({action:"revoke",enrollmentId:d.id});}}>{t("解除授权")}</button></div>)}</div>
  </>}</section>;
}
