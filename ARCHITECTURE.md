# Northstar Architecture

Northstar 的架构基线位于 [`docs/architecture/README.md`](docs/architecture/README.md)。任何涉及控制器、节点 Agent、VPN 协议、客户端或部署方式的重大修改，都应该先检查这份文档，并在决策记录中留下变更原因。

当前版本：`architecture-v1`  
最后更新：2026-07-25  
系统定位：云厂商无关的多协议 VPN 控制面

## 快速恢复设计上下文

阅读顺序：

1. [`docs/architecture/README.md`](docs/architecture/README.md)
2. [`docs/architecture/01-system.md`](docs/architecture/01-system.md)
3. [`docs/architecture/02-backend.md`](docs/architecture/02-backend.md)
4. [`docs/architecture/03-protocols.md`](docs/architecture/03-protocols.md)
5. [`docs/architecture/04-clients.md`](docs/architecture/04-clients.md)
6. [`docs/architecture/05-security.md`](docs/architecture/05-security.md)
7. [`docs/architecture/07-roadmap.md`](docs/architecture/07-roadmap.md)

## 一句话原则

Northstar 是统一的 VPN 控制面，不是某一个 VPN 协议的实现。WireGuard 是第一数据面，OpenVPN/IKEv2/其他传输通过独立 Adapter 接入；Controller 管理期望状态，节点 Agent 收敛期望状态，客户端使用平台原生 VPN 扩展。
