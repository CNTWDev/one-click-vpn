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
