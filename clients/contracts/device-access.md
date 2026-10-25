# TrackNothing 设备接入协议 v2（开发试点，默认关闭）

本目录记录当前实现及后续目标。设置 `VEILBIRD_NATIVE_ACCESS_ENABLED=1` 才启用原生 API；现有 `/api/v1/auth/login`、`/api/v1/devices` 不能代替设备签名准入。仅 Android / Apple 的 WireGuard 数据面已接入，仍待真机及故障验收。

## 身份与计数

- `account_id`：业务账号；会员权益的所有者。
- `enrollment_id`：账号内已授权的客户端安装实例。不是硬件序列号，也不是证书 ID。
- `identity_key`：安装实例生成并尽量使用系统不可导出密钥保存的 P-256 身份签名密钥。与 WireGuard/Xray/OpenVPN 数据面密钥分离。不以 IP、UA、MAC、浏览器指纹识别设备。
- 当前原生访问不创建可导出的 `access_credentials`，WireGuard 公钥绑定 `native_leases`。`devices` 内部记录仅为兼容地址和流量统计，不能用于计数。
- `lease_id`：绑定 enrollment、节点和公钥的 300 秒授权；租约更新复用 `(enrollment_id,node_id)`，既有隧道也受截止时间约束。当前不提供独立的 authorizationVersion 字段。
- 重装或丢失身份密钥可能被视为新安装。客户端安装实例不等于绝对可验证的物理设备；恢复备份、克隆和 root 环境必须列入威胁模型。

## 已实现的路由（先在测试环境使用）

| 路由 | 用途 |
| --- | --- |
| POST `/api/v2/native/login` | email/password/identityKey/platform/deviceName；返回滑动会话（默认 30 天，`VEILBIRD_NATIVE_SESSION_DAYS`），不占额度 |
| POST `/api/v2/native/password-reset` | email/language；无需会话。发送 Portal 的一次性重置链接（1 小时），无论邮箱是否存在都返回 `{status:"received"}`；未配置邮件 `PASSWORD_RESET_UNAVAILABLE`(503)，超限 `RATE_LIMITED`(429)。重置后该账号所有设备需重新登录 |
| POST `/api/v2/native/challenge` | action + request；返回 id/payload/expiresAt，60 秒有效 |
| POST `/api/v2/native/connect` | challengeId/signature/request；request 包含 publicKey 和可选 nodeId；登记、签发或续租 |
| GET `/api/v2/native/account` | 自己的账号、设备、额度、有效期、近 30 天流量 |
| POST `/api/v2/native/revoke` | 签名请求中的 enrollmentId 必须属于本账号，保留撤销 tombstone |
| POST `/api/v2/native/disconnect` | 签名请求，过期当前安装实例的所有节点租约，不释放设备名额 |
| GET `/api/v2/native/status/{leaseId}` | 验证租约仍有效及节点配置是否已应用，不代表客户端实际隧道握手成功 |
| POST `/api/v2/native/logout` | 删除登录会话；客户端应先断开连接 |
| GET `/api/v2/native/nodes` | 返回当前账号允许访问且协议已部署的节点，按负载排序；`probe` 为测延迟用的 TCP 地址（同一主机的 REALITY 端口），没有则为 null；`load` 为节点 CPU 百分比（0–100，无新鲜心跳为 null） |

所有生产接口 HTTPS。签名算法 ES256；身份公钥采用 JWK（kty EC、crv P-256、x/y Base64URL）。签名载荷为服务端 payload 解码后的精确字节，客户端不自行重新序列化 JSON；签名为 IEEE P1363 原始 r||s（64 bytes）后 Base64URL。challenge 绑定会话、目的、请求摘要与有效期，原子消费；签名失败也消费挑战。集成测试覆盖重放、请求篡改、跨身份访问和并发额度；仍需三端真机签名互操作验收。

## 节点选择

三端一致：「自动」与「指定节点」。

- 自动（Android）：打开节点列表或连接前，客户端对每个节点的 `probe` 做 TCP 连接计时（节点列表 5 次、连接前 3 次，每次 ≤1.5 秒；前两次都失败即判为不可达），得到延迟中位数、抖动（相邻两次差值的平均）和丢包率。服务端的 `load`（节点 CPU 百分比，心跳超过 3 分钟则为 null）参与排序。综合分 = 延迟 + 2×抖动 + 10×丢包百分比 + 负载 ≥85% 时 +150，越低越好；测不到的节点排在后面并保持服务端顺序。连接时把综合分最好的 nodeId 发给服务端。节点连不上时自动换下一个节点，最多尝试 3 个。节点列表显示色点（优 / 良 / 差 / 不可达）、延迟、抖动、丢包和负载。
- 自动（Apple / Windows）：与 Android 相同的测速与综合分。Apple 的 App 在连接中不测速（流量会走隧道），显示上次结果；Windows 的 App 自身不走隧道，连接中也能测速。
- 指定节点：只连所选节点，不自动切换；不可用时提示用户换一个。
- 传输（三端相同）：内嵌同一个 mihomo 内核（`clients/core`）。Android 自建 VpnService 把 tun 交给内核；Apple 在 Packet Tunnel Extension 里把 utun 交给内核（扩展自身流量不进隧道，iOS 内核内存上限 32 MB）；Windows 由内核子进程 `veilbird-core.exe` 自建 wintun 网卡并接管路由和 DNS，`Veilbird.exe` 按进程名直连。三端 App 的测速和 API 都不进隧道。`connect` 响应除 WireGuard 外带 `proxies`：节点开了 VLESS REALITY 时有 `reality`（TCP 443），开了抗封锁通道（`stealth` 服务）时还有 `hysteria2`（UDP 8443，Salamander 混淆，证书指纹固定）和 `xhttp`（REALITY over XHTTP，TCP 8443）。每台设备一个密钥（`native_secret:<enrollmentId>`），同时是 VLESS UUID 和 Hysteria2 密码。顺序 WireGuard → Hysteria2 → REALITY → XHTTP，连接时并行测试全部，fallback 组用第一个能通的；WireGuard 就绪后流量自动回到 WireGuard。某协议在一个网络上不通而别的能通，就在该网络（运营商代码或 Wi-Fi 的 DNS/网关哈希）把它排到最后，保留 7 天。每 30 秒复测，连续两次全不通则换节点（自动模式）或断开。
- 路由（三端相同）：节点页可选「智能分流」（默认，私有网段和中国大陆域名/IP 直连，规则集与订阅相同，经隧道下载）或「全局」；断开后切换，下次连接生效。Windows 托盘和 Mac 菜单栏也能切换。
- 快捷操作：Windows 托盘图标、Mac 菜单栏图标（连接 / 断开、当前状态、智能 / 全局、打开、退出）；Windows 关闭窗口后留在托盘，只允许运行一个实例。Mac / Windows 主窗口固定大小、不能最大化。Android 下拉快捷开关；iPhone / Mac「快捷指令」和 Siri 可连接 / 断开（需先在 App 里连接过一次）。
- 诊断日志（三端相同；Apple 的 App 和扩展共用 App Group 里的同一份日志）：「我的」底部版本号 4 秒内点 7 次进入。只记连接步骤：网络标签哈希、节点名、协议名、耗时、错误码；不记密钥、令牌、地址和访问的网站（内核日志不导出）。两个 256 KB 文件轮转，超过 7 天的行丢弃。可复制、分享、清空。

## 准入与撤销事务

锁定账号权益记录 → 校验会员状态 → 检查已有 enrollment / 撤销 tombstone → 检查名额 → 原子登记和占位 → 提交后下发权限。用数据库唯一约束约束 `(account_id, identity_thumbprint)`，使用请求幂等键；两台设备抢最后名额只能成功一台。

设备状态：`active → revoking → revoked`。离线或断开不释放名额。撤销禁止续租并下发移除；等待旧租约最晚截止加 20 秒才释放名额，不根据早期 ACK 提前释放。旧任务保留原始截止时间，不得延长。Agent 2.10.0 在激活 native peer 之前，以 iptables-restore 单次提交更新独立的允许列表，原生地址带 UTC datestop，legacy 地址不带期限，未知地址默认拒绝。内核负责截止时间阻断，独立 systemd timer 清理过期 peer 和持久化配置；重启恢复前先清理并恢复内核规则。节点时钟必须可靠，Linux 真机故障场景仍须验收，不能声称保存即全网即时下线。

控制器不可用时不新增设备、不续期；已批准租约只能用到本地截止时间。Agent 需要本地到期执行器及重启后的恢复检查。严格模式不可 fallback 到永久静态配置。实际同步延迟与租约长度须经真机测试后制定 SLA。

错误码统一为 `DEVICE_LIMIT_REACHED`、`DEVICE_REVOKED`、`MEMBERSHIP_EXPIRED`、`PROOF_INVALID`、`CHALLENGE_EXPIRED`、`AUTH_REQUIRED`、`NODE_UNAVAILABLE`、`CLIENT_UPDATE_REQUIRED`、`ENGINE_NOT_READY`。额度错误返回 `limit` / `used` 与管理入口；本地化在客户端处理，不返回设备密钥或他人隐私。

## 会员与旁路

当前权益见 `server/entitlements.ts`：设备上限 = 生效权益中最大的上限，留空为不限（升级前的老账号挂「老用户」套餐：不限期、不限流量、不限设备）。客户端登录、订阅和节点配置合计占用设备数（`account_slots`）；达到上限时新设备返回 `DEVICE_LIMIT_REACHED`；上限降低后只有最早加入的 N 个仍可连接，其余连接时返回 `DEVICE_LIMIT_REACHED`。到期返回 `MEMBERSHIP_EXPIRED`，流量用完返回 `QUOTA_EXHAUSTED`。支付事件仍待实现。

账号 `native_only` 默认 false，保留第三方客户端。试点只允许从未导出 Profile 的账号开启。managed 模式阻止传统凭据使用、配置签发/下载、订阅生成，并在数据库 Profile 写入处加账号锁下的检查。旧账号迁移需要换发、节点收敛和回滚方案，当前明确拒绝直接切换。短期 WireGuard 私钥仍有可复制窗口，Apple/Windows 当前保护的是加密存储，并非不可导出硬件证明；不能声称抵抗 root、管理员或被攻陷的客户端。
