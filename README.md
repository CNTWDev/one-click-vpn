# Northstar Control Plane

Northstar is a provider-neutral control plane for a small VPN edge fleet. The primary deployment target is one Linux cloud host running Docker. This works on Alibaba Cloud ECS, Tencent Cloud CVM, Google Compute Engine, and ordinary VPS providers without depending on a provider-specific runtime.

完整的长期架构基线见 [`ARCHITECTURE.md`](ARCHITECTURE.md) 和 [`docs/architecture/README.md`](docs/architecture/README.md)。后续调整前后端、VPN 协议、客户端或部署方式时，先从架构基线恢复上下文。

The current implementation includes:

- a protected owner console with cookie sessions and scrypt password hashes;
- SQLite persistence with WAL mode and automatic schema initialization;
- AES-256-GCM encryption for SSH recovery credentials;
- audited node creation, bootstrap attempts, agent heartbeats, and node actions;
- SSH host-key verification, password/private-key bootstrap, and a least-privilege systemd agent;
- Docker Compose, host-managed Nginx HTTPS, health checks, backups, and a repeatable deployment script.
- versioned `/api/v1` authentication, device, node capability, Connection Profile, and Agent reconcile endpoints;
- protocol Adapter registry, WireGuard desired-state generation, IP leases, revisions, and structured Agent tasks.

The agent uses outbound HTTPS plus a per-node token and can pull structured WireGuard reconcile tasks. A node must have `wireguard-tools` installed before it can apply a real WireGuard configuration. OpenVPN/IKEv2 data-plane adapters, the Agent mTLS CA lifecycle, and native clients remain separate follow-up work.

## Local development

Node.js 22.13 or newer is required. Node 22+ provides the built-in SQLite runtime used by the controller.

```bash
cp .env.example .env
# Set NORTHSTAR_ADMIN_EMAIL, NORTHSTAR_ADMIN_PASSWORD, NORTHSTAR_MASTER_KEY.
npm ci
npm run db:migrate
npm run dev
```

Open `http://localhost:3000` and sign in with the owner credentials from `.env`.

For a production-like local process:

```bash
npm run build
npm start
```

## 服务端部署（阿里云 / 腾讯云 / GCP / 普通 VPS）

Controller 使用同一套 Docker Compose 部署，不依赖云厂商 SDK。推荐 Ubuntu/Debian；阿里云 ECS、腾讯云 CVM、GCP Compute Engine 和普通 VPS 的应用部署步骤相同。

### 1. 准备云主机

- 推荐至少 2 vCPU、4 GB 内存和持久盘；
- 将域名（例如 `vpn.example.com`）的 A/AAAA 记录指向主机公网地址；
- 在宿主机安装 Nginx，并让 Nginx 管理域名、HTTPS 和手动上传的证书；
- 安全组允许入站 TCP `80` 和 `443`；
- TCP `22` 仅允许可信管理地址访问；
- 不要对公网开放 Controller 的 `3000` 端口；
- 将 Nginx 的 HTTPS 反向代理指向 `127.0.0.1:3000`；
- 部署前准备好域名证书。Docker 本身不会申请或续期证书。

WireGuard/OpenVPN/IKEv2 属于 Edge Node 数据面，其端口应在对应 Edge Node 的安全组中单独开放，不属于 Controller 的 Compose 入口。

### 2. 获取代码

```bash
sudo git clone YOUR_REPOSITORY_URL /opt/northstar
cd /opt/northstar
```

如果代码已经通过其他方式复制到主机，直接进入 `NorthStarVPNServer` 目录。

### 3. 一键首次部署

```bash
sudo ./scripts/one-click-deploy.sh --domain vpn.example.com --admin-email owner@your-domain.example
```

管理员密码默认通过终端安全提示输入，不建议使用 `--admin-password` 参数，以免密码留在 shell 历史中。密码必须至少 16 个字符。

脚本会自动完成：

- 在 Ubuntu/Debian 上安装 Docker Engine、Compose、Git、OpenSSL 等依赖；
- 生成 32 字节 `NORTHSTAR_MASTER_KEY`；
- 创建权限为 `0600` 的生产 `.env`；
- 校验域名、HTTPS Origin、管理员账号、密码、主密钥和 Compose 配置；
- 构建并启动 Northstar；
- 执行数据库迁移并等待 Controller 通过健康检查；
- 检查宿主机上的 `http://127.0.0.1:3000/api/health`。

如果 `.env` 已存在，脚本默认复用原配置。只有明确需要重新生成配置时才使用 `--yes`；脚本会先创建带时间戳的 `.env.backup.*`。已有 Docker/Compose 且不希望脚本安装依赖时，可增加 `--skip-docker-install`。

当前用户拥有 Docker 权限时可以省略 `sudo`。如果首次部署由 root 安装 Docker，后续可以继续使用 `sudo`，或将部署用户加入 `docker` 组并重新登录。

### 4. 验证部署

完成下一节的 Nginx 配置后再执行公网检查：

```bash
sudo ./scripts/deploy.sh ps
curl --fail https://vpn.example.com/api/health
```

健康接口应返回 `status: ok`。公网访问由 Nginx 提供；如果失败，检查 Nginx 配置、证书、DNS、云安全组和 Nginx 日志。即使尚未配置 Nginx，部署脚本也会先通过宿主机本地地址检查 Controller。

### 5. 宿主机 Nginx 和手动证书

项目提供了 [Nginx 配置模板](deploy/nginx/northstar.conf.example)。在 ECS 上安装 Nginx，并将阿里云下载的证书放到 Nginx 可读目录，例如：

```bash
sudo apt-get update
sudo apt-get install -y nginx
sudo mkdir -p /etc/nginx/ssl/vpn.example.com
sudo cp fullchain.pem /etc/nginx/ssl/vpn.example.com/fullchain.pem
sudo cp privkey.pem /etc/nginx/ssl/vpn.example.com/privkey.pem
sudo chmod 600 /etc/nginx/ssl/vpn.example.com/privkey.pem
sudo cp deploy/nginx/northstar.conf.example /etc/nginx/sites-available/northstar.conf
sudo ln -s /etc/nginx/sites-available/northstar.conf /etc/nginx/sites-enabled/northstar.conf
sudo nginx -t
sudo systemctl reload nginx
```

编辑配置中的 `server_name` 和证书路径。Nginx 的上游必须是 `http://127.0.0.1:3000`。应用的 `.env` 仍然保留真实的 `APP_DOMAIN` 和 `NORTHSTAR_PUBLIC_ORIGIN`，用于生成正确的公网 URL 和 Agent 回连地址；Docker 容器本身不监听公网 80/443。

### 6. 手动部署

需要逐项控制配置时，可以不用一键初始化。先自行安装 Docker Engine 与 Docker Compose，然后执行：

```bash
cp .env.example .env
chmod 600 .env
openssl rand -base64 32
```

将生成的主密钥和生产参数写入 `.env`，至少替换：

```dotenv
NODE_ENV=production
APP_DOMAIN=vpn.example.com
NORTHSTAR_PUBLIC_ORIGIN=https://vpn.example.com
NORTHSTAR_ADMIN_EMAIL=owner@your-domain.example
NORTHSTAR_ADMIN_PASSWORD=use-a-long-random-password
NORTHSTAR_MASTER_KEY=the-generated-32-byte-base64-value
```

然后执行：

```bash
./scripts/check-env.sh
sudo ./scripts/deploy.sh
```

### 7. 升级和备份

数据库保存在 Docker 命名卷 `northstar-data` 中。升级前先导出 SQLite 一致性备份，再拉取代码和重新部署：

```bash
sudo ./scripts/backup.sh ./backups
git pull --ff-only
sudo ./scripts/deploy.sh
```

也可以使用仓库根目录的一键升级脚本。它会先备份 SQLite 数据库，确认工作区没有本地改动，拉取上游代码，然后强制重建并健康检查 Controller：

```bash
sudo ./one-click-update.sh
```

如果怀疑 Docker 使用了旧的构建缓存，使用：

```bash
sudo ./one-click-update.sh --no-cache
```

升级脚本不会删除 `.env` 或 `northstar-data` 数据卷；不要使用 `docker compose down -v`。`deploy.sh` 默认使用正常缓存，但每次都会强制重新创建 Controller 容器；仅在排查缓存问题时使用 `--no-cache`。

如果服务器上的容器、镜像或构建状态已经混乱，可以使用清理重建脚本。脚本默认先备份数据库，并要求输入 `REBUILD` 确认；它只删除本项目的 Northstar 容器和服务镜像，不删除 `.env` 或 `northstar-data` 数据卷：

```bash
sudo ./one-click-rebuild.sh
```

如果当前容器已经完全无法启动、无法完成备份，才使用：

```bash
sudo ./one-click-rebuild.sh --yes --skip-backup
```

该脚本不会清理其他项目的 Docker 容器、镜像或卷。

不要在没有凭据重加密迁移的情况下替换 `NORTHSTAR_MASTER_KEY`，否则已有加密 SSH 凭据将无法解密。

### 8. 运维与故障检查

```bash
sudo ./scripts/deploy.sh ps
sudo ./scripts/deploy.sh logs
sudo journalctl -u nginx -f
sudo docker compose restart northstar
sudo ./scripts/backup.sh ./backups
```

部署脚本会在应用未通过健康检查时输出最近 120 行 Controller 日志。阿里云使用 ECS 安全组和云盘，腾讯云使用 CVM 安全组和 CBS，GCP 使用 VPC 防火墙和 Persistent Disk；应用配置无需因云厂商而改变。

### 9. Docker Compose 版本故障

项目要求 Docker Compose v2。若日志出现 `KeyError: 'ContainerConfig'`，通常是服务器仍在使用旧的 `docker-compose 1.29.2`。先安装 Compose v2：

```bash
sudo apt-get update
sudo apt-get install -y docker-compose-plugin
docker compose version
```

如果 `docker-compose-plugin` 不在当前 apt 源中，请按 Docker 官方文档配置 Docker 软件源后再安装，不要继续使用 Compose v1。

升级 Compose 后，只删除旧的 Controller 容器再重建；不要删除 `northstar-data` 数据卷：

```bash
sudo docker rm -f one-click-vpn_northstar_1 2>/dev/null || true
sudo docker rm -f one-click-vpn_caddy_1 2>/dev/null || true
sudo docker compose up -d --build --remove-orphans
```

## Node bootstrap

In the console, add a node with its public IPv4 address, SSH user, credential, and the SSH `SHA256:` host fingerprint. In production, the fingerprint is required; trust-on-first-use is only allowed in local development when `NORTHSTAR_ALLOW_TOFU_HOST_KEYS=true`.

To obtain the fingerprint from the node itself (prefer an out-of-band console or an already trusted session), run:

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

Copy the value beginning with `SHA256:` into the node form. The controller checks this value during every SSH connection, so a changed or intercepted host key is rejected instead of silently trusted. `ssh-keyscan` can be used only after independently verifying that the returned key belongs to the intended server.

The controller stores the credential only as an AES-256-GCM ciphertext. It then uses SSH to install `/opt/northstar-agent/agent.py` and a `northstar-agent.service`. The agent only sends outbound health heartbeats to the controller and does not accept inbound commands.

The current production data-plane path is WireGuard over IPv4. Bootstrap installs `wireguard-tools` and `iptables`, enables IPv4 forwarding, and the Agent applies a WireGuard interface with outbound masquerading. On DNF-based systems it first uses the enabled repositories, then tries the common CRB/PowerTools and EPEL/ELRepo paths. If the distribution vendor does not publish `wireguard-tools`, the failed bootstrap log includes `/etc/os-release` and `dnf repolist` so the missing repository can be identified. Open UDP `51820` in the Edge Node's cloud security group/firewall; the controller cannot change a provider firewall without a provider-specific integration. OpenVPN and IKEv2 are registered as planned adapters and are not deployable yet.

Each node's **Logs** view shows the audited bootstrap output, Agent status/restart output, and recent WireGuard reconcile errors. The console refreshes node state and diagnostics periodically, so a failed SSH bootstrap or a lost Agent heartbeat appears as `Needs attention` with the recorded error instead of remaining silently online.

The restart action is explicitly allow-listed and audited. Arbitrary shell commands and an interactive browser terminal are not enabled by default because they would turn the control plane into an unrestricted remote-execution service.

## Operations

常用部署命令见上面的“运维与故障检查”。也可以直接使用 Docker Compose：

```bash
docker compose logs -f northstar
docker compose restart northstar
docker compose exec northstar node /app/scripts/migrate.mjs
./scripts/backup.sh ./backups
```

Keep `.env` and backup files outside source control. Production data is stored in the `northstar-data` Docker volume. Rotate `NORTHSTAR_MASTER_KEY` only with a planned credential re-encryption migration; changing it blindly makes existing encrypted credentials unreadable.

## Verification

```bash
npm run lint
npm test
```

`npm test` builds the production bundle and starts a temporary production server to verify health, authentication, session cookies, and the protected node API.

## Optional Cloudflare adapter

The original repository's Vinext/Cloudflare files remain as an optional adapter for the existing Sites project. They are not the primary deployment path because a Worker cannot safely act as the SSH control process for arbitrary cloud VMs. Use the Docker/Node deployment above for Alibaba Cloud, Tencent Cloud, GCP, and other host providers.
