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

添加节点时，Controller 先完成 SSH 认证和权限检查，从握手中取得并固定
host key，然后读取或原子创建 `/var/lib/northstar/node-id`。节点 ID 是机器在
Northstar 中的持久身份；host key 只表示 SSH 端点身份。数据库在同一事务中
检查节点 ID、host key 和 IP/端口，任何冲突都不会进入部署队列。后续部署会
在执行安装命令前重新验证这两种身份，防止 IP 回收、重复配置或镜像克隆导致
操作落到错误服务器。

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

## REALITY 目标

默认是**自动选择**，无需任何配置：每个 Agent 启动时和之后每 6 小时探测一组内置的大型公网站点（TLS 1.3 + HTTP/2，列表见 `server/reality-candidates.ts`，与 `agent/agent.py` 保持一致），Controller 为每台节点从它自己验证通过、延迟最低的几个里挑一个。这样节点不会共用一个可被关联的目标域名，管理服务器也不会通过 SNI 暴露。节点更换目标是平滑切换：密钥不变，旧名称在过渡期内仍被接受，订阅用户下次刷新自动使用新目标。

下面的自建目标站点是可选的高级方案（后台 → VPN 服务 → REALITY 设置 → 自建目标）。

### 自建 REALITY 目标站点（可选）

REALITY 目标与 VPN 节点入口是两个概念。自建模式下多个节点共用一个目标域名；这个域名只解析到静态站点主机，用户仍连接各自 VPN 节点。注意：目标域名解析到管理服务器会让看到 SNI 的人找到控制面，所有节点也会因同一个域名被关联，推荐优先使用自动选择。正常代理业务流量不经目标站点转发，但目标可用性影响 REALITY 的握手与回落。不要直接使用 APP、Console 或 API 域名。

全量部署现在也启动 `reality-target`：一个独立、只读、非 root 的静态容器，仅监听宿主机 `127.0.0.1:3300`，使用独立内部网络，不挂载密钥、数据库或 Docker socket，也不转发任何业务 API。公网 TLS 仍由主机 Nginx 负责。网站只有公开首页与 `/health`；其他路径返回 404，写请求拒绝。

首次初始化：

1. 选择一个独立域名，例如 `www.example.com`，添加指向管理服务器的 DNS A 记录。如果添加 AAAA，必须同时确保服务器 IPv6 和入站防火墙可用。不要启用 CDN 代理，也不要解析到所有 VPN 节点。
2. 主机准备 Linux/systemd、Docker Compose、Nginx（支持 TLS 1.3 和 HTTP/2）、Certbot、OpenSSL、curl、flock；放行 TCP 80/443。脚本不替换现有 Nginx 安装，避免破坏宝塔等面板环境。
3. 在管理服务器项目目录执行（替换域名、邮箱）：

   ```bash
   sudo sh scripts/setup-reality-target.sh --domain www.example.com --email ops@example.com
   ```

   默认使用 `/etc/nginx/conf.d/*.conf`。面板或自定义安装需通过 `--nginx-config-dir` 指定当前 Nginx 实际 include 的目录，并确保 PATH 中的 `nginx` 就是正在提供网站的那个可执行文件。脚本会检查活动配置；不会覆盖其他站点或不同域名的既有托管配置。

4. 后台 → VPN 服务 → 默认 REALITY 目标，填写域名，点击“检测并保存”。初始化命令也可以在这里生成。后端检查公网 DNS、证书、TLS 1.3 和 HTTP/2，成功才保存。显示的检测时间是历史记录，不代表持续实时健康监控。
5. 添加节点时保持“标准：全部可用协议”模板，WireGuard、OpenVPN、VLESS 会走同一自动部署链路，无需额外启用 VLESS。目标尚未配置时仅 VLESS 显示等待/异常，其他协议继续部署；设置好目标后随心跳自动重试。各节点还会独立检测实际连接路径，控制端检测通过不等于所有地区都能访问。

标准策略版本为 v2。老标准节点可通过节点运维中的“重新安装 / 修复”（支持原批量入口）补齐缺少的协议，也可使用 VPN 服务中的标准策略灰度/批量同步，无需逐台创建 VLESS 服务。Controller 更新本身不立即给全部老节点新增监听端口。旧 Agent 未声明 VLESS 能力时会提示先升级；重新安装 / 修复会部署当前 Agent。自定义模板、仅 Agent 节点，以及人为停用后已标记为自定义的节点，不会被标准策略强制接管。

初始化与修复只补缺失服务，保留已有服务的端口、传输方式、密钥和 REALITY 目标。改变全局默认值不会重写已签发配置。单节点特殊情况（例如网站已占用 443）使用统一的“高级：单节点协议配置”，不再为每种协议增加独立部署流程；高级配置只覆盖该节点该协议的端口或目标，节点仍保持标准策略。Agent 部署完成不代表协议全部就绪，任务日志与 VPN 服务状态会显示仍在同步或阻塞的协议。

初始化脚本将构建静态容器，通过 HTTP-01 申请受信任证书，并配置专用 systemd 定时器 `northstar-reality-renew.timer` 每天检查两次。续期后先 `nginx -t` 再平滑 reload；80 端口和 DNS 必须持续可用。初始化过程中 Nginx 配置检测、证书或 TLS 检测失败，会恢复本次修改前的目标站点配置；已签发证书和临时诊断目录保留。重复执行同一域名安全，不能用它直接替换已使用的域名。

```bash
systemctl status northstar-reality-renew.timer
journalctl -u northstar-reality-renew.service
sudo certbot renew --cert-name northstar-reality-www.example.com --dry-run
docker compose logs --tail=100 reality-target
```

默认目标保存在 PostgreSQL 的 `reality_defaults` 表，随 Controller 启动迁移自动创建；无需手工 SQL。可选环境变量 `NORTHSTAR_REALITY_TARGET` 仅作为未保存后台设置时的初始默认值，环境值未检测时界面会明确提示。部署命令本身不修改后台设置。

同主机部署只提供服务隔离，不提供主机级故障隔离。域名与平台的关联仍可被观察；这不是隐蔽性保证。规模扩大后可将站点迁到独立主机，迁移前需验证各节点网络和 Agent 的 DNS 重新检测能力。管理主机如果也作为 VPN 节点，REALITY 不得与 Nginx 共用同一个 443 监听入口，且不能回指自己；应使用独立节点，或指定空闲 TCP 端口并放行对应安全组规则。
