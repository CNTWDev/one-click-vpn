# Northstar 架构基线

## 1. 文档用途

这不是一次性的设计稿，而是 Northstar 的长期架构记忆。代码可以重构，云厂商可以更换，VPN 协议可以增加，但下面的核心边界和不变量必须被保留，除非新增一条架构决策记录。

## 2. 产品定位

Northstar 是一个云厂商无关的多协议 VPN 控制面，用于管理：

- 多个云厂商或普通 VPS 上的 Edge Node；
- 多种 VPN 数据面协议；
- 用户、设备、设备凭据和连接 Profile；
- 节点期望状态、配置版本和运行状态；
- 节点 Agent、证书、审计和运维操作。

Controller 不在 VPN 数据包路径中。VPN 数据流量直接在用户设备和 Edge Node 之间传输；Controller 只负责身份、策略、配置、编排和观测。

## 3. 当前实现与目标架构

### 当前已经实现

- Next.js Node.js 控制器；
- SQLite/WAL 持久化；
- 管理员 Cookie 会话和 scrypt 密码哈希；
- AES-256-GCM 加密 SSH 凭据；
- SSH host fingerprint 校验；
- 节点 bootstrap；
- 出站 Agent HTTPS 心跳和 token 认证；
- 受限的节点操作与审计；
- Docker、宿主机 Nginx、健康检查和备份脚本。
- `/api/v1` Bearer 会话、设备、节点能力和 Connection Profile 接口；
- Protocol Adapter 注册表、WireGuard Desired State、IP Lease 和结构化 Agent reconcile 任务；
- Agent 任务拉取、结果回报和 WireGuard 固定操作入口。

### 目标架构尚未完全落地

- OpenVPN/IKEv2 的可运行数据面 Adapter 和独立 CA/证书生命周期；
- macOS/iPhone/Android 原生客户端；
- Agent 短期 mTLS 证书生命周期；
- 自动节点和协议选择；
- 多节点高可用与更大规模数据库。

当前实现不应该被误认为已经完成了 VPN 数据面或完整 mTLS。

## 4. 文档导航

| 文档 | 内容 |
|---|---|
| [00-principles.md](00-principles.md) | 架构原则和不可破坏的不变量 |
| [01-system.md](01-system.md) | 全局组件、边界和数据流 |
| [02-backend.md](02-backend.md) | Controller、数据库、API、任务和状态收敛 |
| [03-protocols.md](03-protocols.md) | WireGuard/OpenVPN/IKEv2 和 Adapter 设计 |
| [04-clients.md](04-clients.md) | Mac、iPhone、Android 客户端架构 |
| [05-security.md](05-security.md) | 身份、密钥、mTLS、凭据、审计和威胁边界 |
| [06-deployment.md](06-deployment.md) | 阿里云、腾讯云、GCP 和普通 VPS 部署 |
| [07-roadmap.md](07-roadmap.md) | 分阶段落地计划和验收标准 |
| [08-decision-log.md](08-decision-log.md) | 重要架构决策记录 |

## 5. 修改规则

涉及以下内容时，必须同步更新架构文档：

- 新增或删除 VPN 协议；
- 修改设备密钥生成或保存位置；
- 修改 Controller/Agent 边界；
- 修改客户端系统 VPN 集成方式；
- 修改数据库中用户、设备、节点或 Profile 的关系；
- 修改部署拓扑、信任边界或密钥轮换策略。

普通 UI 调整、CSS 调整和不改变边界的内部重构，不需要新增架构决策，但应保持文档中的概念名称一致。
