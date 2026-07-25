# 06. 部署架构

## 1. 第一阶段：单 Controller + 多 Edge

```text
Cloud VM
  ├── Caddy / HTTPS
  ├── Northstar Controller
  ├── SQLite/PostgreSQL
  └── Backup worker

Cloud VMs in regions
  ├── WireGuard
  ├── Optional OpenVPN/IKEv2
  └── Northstar Agent
```

Controller 可以部署在阿里云 ECS、腾讯云 CVM、GCP Compute Engine 或普通 VPS。Edge Node 可以跨云厂商部署，业务层只记录 provider、region、endpoint 和 capabilities。

## 2. 网络入口

Controller：

- TCP 443：Web、API、Agent Gateway；
- TCP 22：仅 bootstrap/recovery，尽量限制源地址。

Edge Node：

- WireGuard UDP 监听端口；
- OpenVPN UDP/TCP 端口；
- IKEv2/IPsec 所需端口；
- TCP 443 或其他 transport endpoint；
- 不公开数据库和内部管理端口。

每个节点上报自身的监听端口和协议能力，Controller 不能假设所有节点端口相同。

## 3. 云厂商抽象

```ts
interface NodeProviderAdapter {
  id: "alibaba" | "tencent" | "gcp" | "generic";
  discoverNode(): Promise<NodeMetadata>;
  attestNode(): Promise<NodeAttestation | null>;
  getNetworkHints(): Promise<NetworkHints>;
}
```

没有云 API 时使用 `generic` + 一次性 bootstrap token。云厂商 API 只是增强节点身份和网络信息，不应成为业务模型的前提。

## 4. 数据持久化

单机：

- SQLite WAL；
- 独立持久盘；
- 定期备份；
- Master key 独立保存。

多实例：

- PostgreSQL；
- 独立 Job Queue；
- 对象存储保存配置快照和审计归档；
- 多 Controller 通过租约或分布式锁执行 Reconcile。

## 5. 部署原则

- 应用容器不暴露宿主机 Docker socket；
- Agent/协议服务只有必要的 Linux capabilities；
- Controller 端口不直接暴露 3000；
- 数据目录和备份不进 Git；
- 构建、迁移、部署、回滚分开；
- 升级前先备份数据库和配置版本。

## 6. 一键部署和升级

仓库提供可重复执行的 Ubuntu/Debian 部署入口：

首次部署：
sudo ./scripts/one-click-deploy.sh --domain vpn.example.com --admin-email owner@your-domain.example

它负责主机前置依赖、生产配置初始化、密钥生成、Docker Compose 构建、迁移、健康等待和公网健康检查。NORTHSTAR_MASTER_KEY 只在首次生成时写入 .env；更新时脚本默认复用既有配置。

更新代码后执行：
git pull --ff-only
./scripts/deploy.sh

脚本会校验：
- APP_DOMAIN 与 NORTHSTAR_PUBLIC_ORIGIN 必须匹配；
- 生产环境必须使用 HTTPS；
- 管理员密码至少 16 个字符；
- 主密钥必须解码为 32 字节；
- Docker Compose 配置必须可解析；
- Controller 容器必须通过 /api/health 健康检查。

公有云安全组只开放 TCP 22/80/443。Edge Node 的 WireGuard/OpenVPN/IKEv2 数据面端口按节点能力单独开放，不能因为 Controller 使用了 Caddy 就把这些端口混到 Controller 的 Compose 文件里。
