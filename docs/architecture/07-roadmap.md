# 07. 架构落地路线

## Phase 0：当前控制器基线

已完成：

- Node.js Controller；
- 管理员会话；
- PostgreSQL；
- 加密 SSH 凭据；
- SSH bootstrap；
- Agent HTTPS 心跳；
- Docker + 宿主机 Nginx 部署。

## Phase 1：WireGuard 数据面（Server 已完成第一版）

目标：让一个 Edge Node 能通过结构化 Agent 任务承载真实 WireGuard 用户连接。

已完成：

- Protocol Adapter 和能力声明；
- Device、IP Lease、Connection Profile 数据模型；
- Desired/Observed Config 和 reconcile task；
- Agent 任务拉取、结果回报和固定 WireGuard 操作；
- `/api/v1` 认证、设备、节点、Profile 和 Agent API。

仍需实机验收：

- 在全新 Linux 节点安装 `wireguard-tools` 后完成真实隧道测试；
- 节点重启、配置回滚、网络切换和大规模 Peer 压测；
- 防火墙、IPv6、MTU 和流量指标的云厂商差异验证。

验收标准：

- 节点本地生成 WireGuard 私钥；
- Controller 获取节点公钥；
- 设备本地生成客户端私钥；
- Controller 分配唯一 VPN IP；
- Agent 应用 Peer desired state；
- 重复 Reconcile 不破坏连接；
- 设备撤销后 Peer 被移除；
- 配置 revision 可追踪和回滚。

## Phase 2：Device 和 Profile（Server 已完成，客户端待后续）

目标：为 Mac/iPhone/Android 提供统一设备模型和稳定 Profile API。

Server 已完成：

- Bearer access token 和 rotating refresh token；
- Device 注册、查询、撤销；
- Profile 签发、激活、轮换、过期和撤销；
- 节点能力和配置 revision 查询。

验收标准：

- 每台设备独立身份；
- Keychain/Keystore 保存私钥；
- Connection Profile 版本化；
- 全隧道/分流；
- 节点和 Profile 状态可观测；
- 客户端可以撤销和重新注册。

## Phase 3：三端 WireGuard 客户端（暂缓）

目标：先不追求多协议，完成稳定的原生系统 VPN 集成。

验收标准：

- macOS Packet Tunnel；
- iPhone Packet Tunnel；
- Android VpnService；
- 登录、设备注册、连接、断开、重连；
- 网络切换和后台恢复；
- 诊断信息和错误分类。

## Phase 4：Agent mTLS

目标：把当前 HTTPS token Agent 升级为短期 mTLS Agent。

验收标准：

- 一次性 bootstrap token；
- 本地生成 Agent key/CSR；
- 短期客户端证书；
- 自动续签；
- 节点撤销；
- 证书轮换期间不中断或可恢复。

## Phase 5：OpenVPN Adapter

目标：为特定网络环境和兼容性提供第二数据面。

验收标准：

- UDP/TCP Profile；
- 独立证书生命周期；
- 客户端能力协商；
- 协议切换状态机；
- 自动 fallback；
- 协议特有指标和故障码。

## Phase 6：IKEv2、云 attestation 和 HA

只有在真实数据证明需要时再做：

- IKEv2；
- SPIFFE/SPIRE；
- 云厂商 attestation；
- PostgreSQL；
- 多 Controller；
- 区域调度和节点故障转移。
