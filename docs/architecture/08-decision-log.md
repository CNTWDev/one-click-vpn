# 08. 架构决策记录

## ADR-0001：Controller 与 VPN 数据面分离

状态：Accepted
日期：2026-07-25

Controller 不转发用户 VPN 流量，只负责配置、身份、策略、审计和编排。这样可以减少控制器带宽压力，也能让 Edge Node 跨云部署。

## ADR-0002：WireGuard 作为第一数据面

状态：Accepted  
日期：2026-07-25

WireGuard 作为默认协议，但不能成为业务模型的前提。它通过独立 Adapter 接入，后续可增加 OpenVPN 和 IKEv2。

## ADR-0003：多协议通过 Connection Profile 抽象

状态：Accepted  
日期：2026-07-25

客户端不直接理解 Controller 的数据库或节点配置，只接收绑定到 Device 的 Connection Profile。Profile 负责协议、transport、endpoint、路由、DNS、MTU、revision 和过期时间。

## ADR-0004：设备私钥本地生成

状态：Accepted  
日期：2026-07-25

Controller 保存公钥和证书元数据，不默认保存用户设备的 WireGuard/OpenVPN/IKEv2 私钥。这样设备撤销和密钥泄漏范围更容易控制。

## ADR-0005：Agent 不提供任意 Shell

状态：Accepted  
日期：2026-07-25

Agent 只执行结构化、allow-listed 的操作。SSH 只负责 bootstrap 和紧急恢复。浏览器终端如果未来开放，必须建立独立的权限、短期会话、录屏/命令审计和强制超时模型。

## ADR-0006：先做单机控制器，再考虑多实例

状态：Accepted  
日期：2026-07-25

PostgreSQL + Docker Compose 是当前单 Controller 的部署基线；后续出现多实例、高并发或多区域需求时，再补充连接池治理、队列和分布式锁。

## ADR-0007：mTLS 是 Agent 身份，不是 VPN 用户身份

状态：Accepted  
日期：2026-07-25

Agent mTLS、Web session、Device identity 和 VPN protocol credential 必须分离。当前代码仍使用 Agent HTTPS token，后续按 [07-roadmap.md](07-roadmap.md) 升级为短期 mTLS。

## ADR-0008：Node、VPN Service 与 Connection Profile 分层

状态：Accepted
日期：2026-07-26

Node 只表示安装 Agent 的受管 Linux 主机；VPN Service 表示某个 Node 上启用的协议监听器及其期望状态；Connection Profile 表示分配给具体 Device 的客户端身份和连接配置。创建 Profile 不再负责首次启动服务。

新增 Node 时通过部署模板创建 VPN Service，Agent 首次认证心跳后自动收敛服务状态。终端用户只选择协议和可选 Region，由 Controller 在心跳新鲜、运行时健康且监听正常的服务中自动分配 Node。这样扩容、服务重装和用户发放可以分别管理，也避免把基础设施细节暴露给终端用户。

## ADR-0009：Standard 是版本化持续策略

状态：Accepted
日期：2026-07-26

Standard 不再只是新增 Node 时复制的一组静态服务，而是持久化在 Node 上的版本化部署策略。协议 Adapter 提供默认监听参数和结构化 apply/disable 任务名；进入 Standard 的 Adapter 必须显式标记并提升策略版本。

老节点升级采用 capability preflight、单节点 Canary 和有限批次 rollout。无新鲜心跳或未上报目标协议能力的节点保持 blocked，不修改其现有服务。Custom 和 Agent-only 节点不参加 Standard rollout；管理员手动启停服务会将节点切换为 Custom，防止未来 rollout 覆盖明确的人为选择。
