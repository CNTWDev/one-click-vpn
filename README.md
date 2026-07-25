# Northstar Control Plane

Northstar is a provider-neutral control plane for a small VPN edge fleet. The primary deployment target is one Linux cloud host running Docker. This works on Alibaba Cloud ECS, Tencent Cloud CVM, Google Compute Engine, and ordinary VPS providers without depending on a provider-specific runtime.

完整的长期架构基线见 [`ARCHITECTURE.md`](ARCHITECTURE.md) 和 [`docs/architecture/README.md`](docs/architecture/README.md)。后续调整前后端、VPN 协议、客户端或部署方式时，先从架构基线恢复上下文。

The current implementation includes:

- a protected owner console with cookie sessions and scrypt password hashes;
- SQLite persistence with WAL mode and automatic schema initialization;
- AES-256-GCM encryption for SSH recovery credentials;
- audited node creation, bootstrap attempts, agent heartbeats, and node actions;
- SSH host-key verification, password/private-key bootstrap, and a least-privilege systemd agent;
- Docker Compose, Caddy HTTPS, health checks, backups, and a repeatable deployment script.
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
- 安全组允许入站 TCP `80` 和 `443`；
- TCP `22` 仅允许可信管理地址访问；
- 不要对公网开放 Controller 的 `3000` 端口；
- 部署前确认 DNS 已生效，否则 Caddy 无法申请 HTTPS 证书。

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
- 构建并启动 Northstar 与 Caddy；
- 执行数据库迁移并等待 Controller 通过健康检查；
- 检查公网 `https://域名/api/health`。

如果 `.env` 已存在，脚本默认复用原配置。只有明确需要重新生成配置时才使用 `--yes`；脚本会先创建带时间戳的 `.env.backup.*`。已有 Docker/Compose 且不希望脚本安装依赖时，可增加 `--skip-docker-install`。

当前用户拥有 Docker 权限时可以省略 `sudo`。如果首次部署由 root 安装 Docker，后续可以继续使用 `sudo`，或将部署用户加入 `docker` 组并重新登录。

### 4. 验证部署

```bash
sudo ./scripts/deploy.sh ps
curl --fail https://vpn.example.com/api/health
```

健康接口应返回 `status: ok`。Caddy 会自动申请和续期 HTTPS 证书。若容器内部已经健康但公网检查失败，优先检查 DNS、云安全组的 80/443 端口以及 Caddy 日志。

### 5. 手动部署

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

### 6. 升级和备份

数据库保存在 Docker 命名卷 `northstar-data` 中。升级前先导出 SQLite 一致性备份，再拉取代码和重新部署：

```bash
sudo ./scripts/backup.sh ./backups
git pull --ff-only
sudo ./scripts/deploy.sh
```

不要在没有凭据重加密迁移的情况下替换 `NORTHSTAR_MASTER_KEY`，否则已有加密 SSH 凭据将无法解密。

### 7. 运维与故障检查

```bash
sudo ./scripts/deploy.sh ps
sudo ./scripts/deploy.sh logs
sudo docker compose logs -f caddy
sudo docker compose restart northstar
sudo ./scripts/backup.sh ./backups
```

部署脚本会在应用未通过健康检查时输出最近 120 行 Controller 日志。阿里云使用 ECS 安全组和云盘，腾讯云使用 CVM 安全组和 CBS，GCP 使用 VPC 防火墙和 Persistent Disk；应用配置无需因云厂商而改变。

## Node bootstrap

In the console, add a node with its public IPv4 address, SSH user, credential, and the SSH `sha256:` host fingerprint. In production, the fingerprint is required; trust-on-first-use is only allowed in local development when `NORTHSTAR_ALLOW_TOFU_HOST_KEYS=true`.

The controller stores the credential only as an AES-256-GCM ciphertext. It then uses SSH to install `/opt/northstar-agent/agent.py` and a `northstar-agent.service`. The agent only sends outbound health heartbeats to the controller and does not accept inbound commands.

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
