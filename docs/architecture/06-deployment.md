# 06. 部署架构

## 1. 第一阶段：单 Controller + 多 Edge

```text
Cloud VM
  ├── Host Nginx / HTTPS
  ├── Northstar Controller/API :3000
  ├── Northstar Portal Web :3100
  ├── Northstar Admin Web :3200
  ├── PostgreSQL（Docker Compose db 服务）
  └── Backup worker

Cloud VMs in regions
  ├── WireGuard
  ├── Optional OpenVPN/IKEv2
  └── Northstar Agent
```

Controller 可以部署在阿里云 ECS、腾讯云 CVM、GCP Compute Engine 或普通 VPS。Edge Node 可以跨云厂商部署，业务层只记录 provider、region、endpoint 和 capabilities。

## 2. 网络入口

Controller/API：

- TCP 443：由宿主机 Nginx 提供 Portal、Admin、API 和 Agent Gateway；
- TCP 3000：Northstar 容器，仅绑定到 Controller 主机的 `127.0.0.1`；
- TCP 3100：Portal Web，仅绑定到 Controller 主机的 `127.0.0.1`；
- TCP 3200：Admin Web，仅绑定到 Controller 主机的 `127.0.0.1`；
- TCP 22：仅 bootstrap/recovery，尽量限制源地址。Agent 正常运行后只需要向 API/Agent 域名出站 TCP 443，不需要给节点开放 Controller 入站端口。

节点 SSH 可以使用密码或专用私钥。远端权限明确分成 uid 0 的 `root`
模式和 `sudo -n` 的免密 sudo 模式；这个差异由 SSH 执行器消化，后续的
Agent 安装、Desired State 和 VPN Adapter 不区分登录凭据类型。

Portal/Admin 不通过公网域名回调 Controller。两个前端容器统一使用 Docker DNS 地址 `http://northstar:3000` 转发 `/api`。宿主机 Nginx 只负责 TLS 和站点入口；独立 API 域名仅供原生客户端与远程 Agent 使用。

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

当前与多实例：

- PostgreSQL 独立服务和持久卷；
- 定期备份；
- Master key 独立保存。

多实例扩展：

- 托管 PostgreSQL 或独立高可用 PostgreSQL；
- 独立 Job Queue；
- 对象存储保存配置快照和审计归档；
- 多 Controller 通过租约或分布式锁执行 Reconcile。

## 5. 前端和控制面升级边界

Portal Web、Admin Web 和 Controller/API 是独立 Docker 服务：

- 前端服务不连接 PostgreSQL；
- 前端只依赖 `/api/v1` 和管理端 API 合同；
- 更新 Portal 不需要重启 Controller 或 Edge Agent；
- 更新 Admin 不会改变用户 VPN 会话；
- 数据库迁移只由 Controller 部署流程执行；
- 后续可以把 Reconcile Worker 和流量聚合 Worker 从 Controller/API 再拆出来。

## 6. 部署原则

- 应用容器不暴露宿主机 Docker socket；
- Agent/协议服务只有必要的 Linux capabilities；
- Controller 端口不直接暴露 3000；宿主机只绑定 `127.0.0.1:3000`，公网 HTTPS 由 Nginx 转发；
- 证书由宿主机 Nginx 手动管理，Docker Compose 不申请 ACME 证书；
- 数据目录和备份不进 Git；
- 构建、迁移、部署、回滚分开；
- 升级前先备份数据库和配置版本。

## 7. 一键部署和升级

仓库提供可重复执行的 Ubuntu/Debian 部署入口：

首次部署（`--domain` 是基础域名，脚本默认生成 `app/console/api` 三个子域名）：
sudo ./scripts/one-click-deploy.sh --domain example.com --admin-email owner@your-domain.example

它负责主机前置依赖、生产配置初始化、密钥生成、Docker Compose 构建 Controller、Portal 和 Admin、迁移、健康等待和公网健康检查。NORTHSTAR_MASTER_KEY 只在首次生成时写入 .env；更新时脚本默认复用既有配置。

更新代码后执行：
git pull --ff-only
./scripts/deploy.sh

Controller、Portal、Admin 会随本次部署升级；Edge Agent 不会被 Docker 自动覆盖。需要升级 Agent 时，在 Admin 的节点操作中重新执行一次 Bootstrap，让 Controller 重新写入 Agent 文件并等待新的 heartbeat；Agent 升级失败不会影响已有 VPN 数据面配置。

脚本会校验：
- APP_DOMAIN 与 NORTHSTAR_PUBLIC_ORIGIN 必须指向 Portal 域名；`NORTHSTAR_API_ORIGIN` 和 `NORTHSTAR_AGENT_ORIGIN` 必须指向 API 域名；旧单域名 `.env` 会在部署时经过一次交互式迁移并自动备份，避免把已废弃域名继续写入 Edge Agent；
- 生产环境必须使用 HTTPS；
- 管理员密码至少 16 个字符；
- 主密钥必须解码为 32 字节；
- Docker Compose 配置必须可解析；
- Controller 容器必须通过 /api/health 健康检查。

公有云安全组只开放 TCP 22/80/443。Edge Node 的 WireGuard/OpenVPN/IKEv2 数据面端口按节点能力单独开放，不能把这些端口混到 Controller 的 Compose 文件里。

Nginx 需要为 `app.example.com`、`console.example.com` 和 `api.example.com` 配置 DNS 与证书，并安装仓库中的两个配置文件：

```bash
sudo mkdir -p /etc/nginx/snippets
sudo cp deploy/nginx/snippets/northstar-proxy.conf /etc/nginx/snippets/northstar-proxy.conf
sudo cp deploy/nginx/northstar.conf.example /etc/nginx/sites-available/northstar.conf
sudo nginx -t && sudo systemctl reload nginx
```
