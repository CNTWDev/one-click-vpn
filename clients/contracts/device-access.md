# NORTHSTAR 设备接入协议 v2（开发试点，默认关闭）

本目录记录当前实现及后续目标。设置 `NORTHSTAR_NATIVE_ACCESS_ENABLED=1` 才启用原生 API；现有 `/api/v1/auth/login`、`/api/v1/devices` 不能代替设备签名准入。仅 Android / Apple 的 WireGuard 数据面已接入，仍待真机及故障验收。

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
| POST `/api/v2/native/login` | email/password/identityKey/platform/deviceName；返回 12 小时会话，不占额度 |
| POST `/api/v2/native/challenge` | action + request；返回 id/payload/expiresAt，60 秒有效 |
| POST `/api/v2/native/connect` | challengeId/signature/request；request 包含 publicKey 和可选 nodeId；登记、签发或续租 |
| GET `/api/v2/native/account` | 自己的账号、设备、额度、有效期、近 30 天流量 |
| POST `/api/v2/native/revoke` | 签名请求中的 enrollmentId 必须属于本账号，保留撤销 tombstone |
| POST `/api/v2/native/disconnect` | 签名请求，过期当前安装实例的所有节点租约，不释放设备名额 |
| GET `/api/v2/native/status/{leaseId}` | 验证租约仍有效及节点配置是否已应用，不代表客户端实际隧道握手成功 |
| POST `/api/v2/native/logout` | 删除登录会话；客户端应先断开连接 |
| GET `/api/v2/native/nodes` | 返回当前账号允许访问且协议已部署的节点 |

所有生产接口 HTTPS。签名算法 ES256；身份公钥采用 JWK（kty EC、crv P-256、x/y Base64URL）。签名载荷为服务端 payload 解码后的精确字节，客户端不自行重新序列化 JSON；签名为 IEEE P1363 原始 r||s（64 bytes）后 Base64URL。challenge 绑定会话、目的、请求摘要与有效期，原子消费；签名失败也消费挑战。集成测试覆盖重放、请求篡改、跨身份访问和并发额度；仍需三端真机签名互操作验收。

## 准入与撤销事务

锁定账号权益记录 → 校验会员状态 → 检查已有 enrollment / 撤销 tombstone → 检查名额 → 原子登记和占位 → 提交后下发权限。用数据库唯一约束约束 `(account_id, identity_thumbprint)`，使用请求幂等键；两台设备抢最后名额只能成功一台。

设备状态：`active → revoking → revoked`。离线或断开不释放名额。撤销禁止续租并下发移除；等待旧租约最晚截止加 20 秒才释放名额，不根据早期 ACK 提前释放。旧任务保留原始截止时间，不得延长。Agent 2.9.0 在激活 native peer 之前，以 iptables-restore 单次提交更新独立的允许列表，原生地址带 UTC datestop，legacy 地址不带期限，未知地址默认拒绝。内核负责截止时间阻断，独立 systemd timer 清理过期 peer 和持久化配置；重启恢复前先清理并恢复内核规则。节点时钟必须可靠，Linux 真机故障场景仍须验收，不能声称保存即全网即时下线。

控制器不可用时不新增设备、不续期；已批准租约只能用到本地截止时间。Agent 需要本地到期执行器及重启后的恢复检查。严格模式不可 fallback 到永久静态配置。实际同步延迟与租约长度须经真机测试后制定 SLA。

错误码统一为 `DEVICE_LIMIT_REACHED`、`DEVICE_REVOKED`、`MEMBERSHIP_EXPIRED`、`PROOF_INVALID`、`CHALLENGE_EXPIRED`、`AUTH_REQUIRED`、`NODE_UNAVAILABLE`、`CLIENT_UPDATE_REQUIRED`、`ENGINE_NOT_READY`。额度错误返回 `limit` / `used` 与管理入口；本地化在客户端处理，不返回设备密钥或他人隐私。

## 会员与旁路

当前权益：账号覆盖 > `NORTHSTAR_NATIVE_DEVICE_LIMIT` 默认 3；`membership_expires_at` 为账号到期时间。管理员不可将额度降低到已授权数以下，先解除设备再保存。套餐表、支付事件和宽限降级仍待实现。

账号 `native_only` 默认 false，保留第三方客户端。试点只允许从未导出 Profile 的账号开启。managed 模式阻止传统凭据使用、配置签发/下载、订阅生成，并在数据库 Profile 写入处加账号锁下的检查。旧账号迁移需要换发、节点收敛和回滚方案，当前明确拒绝直接切换。短期 WireGuard 私钥仍有可复制窗口，Apple/Windows 当前保护的是加密存储，并非不可导出硬件证明；不能声称抵抗 root、管理员或被攻陷的客户端。
