// One dictionary for every status value the Console shows: Chinese label + semantic tone.
// Tones: success (green), progress (blue), warning (amber), danger (red); neutral is for unknown / intentionally off.
export type Tone = "success" | "progress" | "warning" | "danger" | "neutral";

const S = "success", P = "progress", W = "warning", D = "danger", N = "neutral";
const dictionary: Record<string, [label: string, tone: Tone]> = {
  online: ["在线", S], offline: ["离线", D], provisioning: ["部署中", P], deploying: ["部署中", P], healthy: ["正常", S], ok: ["正常", S],
  attention: ["需关注", W], pending: ["等待中", P], queued: ["排队中", P], running: ["执行中", P], checking: ["检测中", P],
  planned: ["计划中", P], received: ["已接收", P], reconciling: ["同步中", P], reconciling_with_errors: ["同步有异常", W],
  succeeded: ["成功", S], completed: ["已完成", S], completed_with_errors: ["部分失败", W], applied: ["已同步", S],
  failed: ["失败", D], error: ["错误", D], interrupted: ["已中断", D], unavailable: ["不可用", D], blocked: ["暂不可更新", W],
  eligible: ["可同步", S], unsupported: ["不支持", W], "waiting-target": ["等待目标", W], waiting_target: ["等待目标", W],
  disabled: ["已停用", N], enabled: ["已启用", S], active: ["有效", S], issued: ["已签发", S], revoked: ["已撤销", D],
  expired: ["已过期", D], released: ["已释放", N], suspended: ["已停用", W], rejected: ["已拒绝", D],
  "never-connected": ["尚未连接", W], "telemetry-delayed": ["状态延迟", W], "admin-disabled": ["管理员已停用", W],
  "account-disabled": ["账号已停用", W], "user-disabled": ["用户已停用", W], not_configured: ["未配置", N], unknown: ["未知", N],
  managed: ["已托管", S], permissive: ["全部放行", W], unverified: ["未验证", N], listening: ["监听中", S], cancelled: ["已取消", N],
  info: ["信息", P], warning: ["警告", W],
};

export function statusLabel(value?: string | null): string {
  if (!value) return "未知";
  return dictionary[value]?.[0] ?? dictionary[value.toLowerCase()]?.[0] ?? value;
}

export function statusTone(value?: string | null): Tone {
  if (!value) return N;
  return dictionary[value]?.[1] ?? dictionary[value.toLowerCase()]?.[1] ?? N;
}

const rank: Record<Tone, number> = { neutral: 0, success: 1, progress: 2, warning: 3, danger: 4 };
/** The most severe tone of a set (used to summarise several protocols on one node). */
export function worstTone(tones: Tone[]): Tone {
  return tones.reduce<Tone>((worst, tone) => rank[tone] > rank[worst] ? tone : worst, N);
}

export const protocolNames: Record<string, string> = { wireguard: "WireGuard", openvpn: "OpenVPN", vless: "VLESS" };
export const protocolName = (value: string) => protocolNames[value] || value;
