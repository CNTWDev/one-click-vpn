# Northstar VPN Control Plane

Northstar is a lightweight VPN control plane for a small fleet of Linux Edge Nodes.
It includes a customer Portal, an Admin console, a Controller/API, and an outbound
Node Agent. The current data plane supports WireGuard and OpenVPN.

## Architecture

```text
Browser:  app.example.com       -> Portal  :3100
          console.example.com   -> Admin   :3200
          /api/*                 -> API     :3000

Native:   api.example.com       -> API     :3000
Agent:    outbound HTTPS        -> api.example.com/api/v1/agent/*
```

The Controller, Portal, and Admin run as independent Docker services. Host Nginx
terminates HTTPS and reverse-proxies to loopback ports. The Agent does not need an
inbound port; it uses HTTPS with a per-node Bearer token. SSH is used only for
bootstrap and repair.

## Requirements

- Ubuntu/Debian server for production;
- Docker Engine with Docker Compose v2;
- DNS records for Portal, Admin, and API;
- HTTPS certificates covering all three hostnames;
- TCP `80/443` to the Controller host;
- Edge Nodes need outbound TCP `443` and their own VPN data-plane ports.

## First deployment

Clone the project:

```bash
sudo git clone YOUR_REPOSITORY_URL /opt/northstar
cd /opt/northstar
```

Run the installer. It generates `.env`, secrets, database configuration, and the
three application services:

```bash
sudo ./scripts/one-click-deploy.sh \
  --domain example.com \
  --admin-email owner@example.com
```

The default hostnames are:

```text
app.example.com       Portal
console.example.com   Admin
api.example.com       API and Edge Agent
```

Use explicit hostnames when needed:

```bash
sudo ./scripts/one-click-deploy.sh \
  --portal-domain app.example.com \
  --admin-domain console.example.com \
  --api-domain api.example.com \
  --admin-email owner@example.com
```

The admin password is requested interactively. Existing `.env` is reused. Use
`--yes` only when intentionally regenerating it; the old file is backed up first.

## Nginx

Point all three DNS records to the Controller host. Install Nginx and certificates,
then edit the hostnames and certificate paths in the template:

```bash
sudo apt-get update
sudo apt-get install -y nginx
sudo mkdir -p /etc/nginx/snippets
sudo cp deploy/nginx/snippets/northstar-proxy.conf \
  /etc/nginx/snippets/northstar-proxy.conf
sudo cp deploy/nginx/northstar.conf.example \
  /etc/nginx/sites-available/northstar.conf
sudo ln -s /etc/nginx/sites-available/northstar.conf \
  /etc/nginx/sites-enabled/northstar.conf
sudo nginx -t
sudo systemctl reload nginx
```

Docker binds only to `127.0.0.1`; do not expose ports `3000`, `3100`, or `3200`
directly to the Internet.

## Services and ports

| Service | Port | Purpose |
| --- | ---: | --- |
| Controller/API | 3000 | API, Agent gateway, migrations |
| Portal Web | 3100 | Registration, approval, devices, profiles, traffic |
| Admin Web | 3200 | User approval, nodes, VPN services, logs |
| PostgreSQL | internal | Persistent application data |

Useful local checks:

```bash
curl --fail http://127.0.0.1:3000/api/health
curl --fail http://127.0.0.1:3100/health
curl --fail http://127.0.0.1:3200/health
```

## Upgrade

Recommended upgrade, including a PostgreSQL backup:

```bash
sudo ./one-click-update.sh
```

Manual upgrade:

```bash
sudo ./scripts/backup.sh ./backups
git pull --ff-only
sudo ./scripts/deploy.sh
```

Database migrations run during Controller deployment. `.env`, certificates, and
Docker volumes are preserved. Never use `docker compose down -v` in production.

To rebuild only the frontends:

```bash
docker compose build portal-web admin-web
docker compose up -d --no-deps portal-web admin-web
```

After upgrading Controller code, use the Admin node action **Reinstall agent** to
upgrade an Edge Agent. Existing VPN configuration is retained.

If the admin password is lost, reset an existing owner/admin account on the
Controller host:

```bash
sudo ./scripts/reset-admin-password.sh
```

## Edge Node bootstrap

In Admin, create a node with its public address, SSH credential, and verified
`SHA256:` host fingerprint. Then choose a deployment template and run Bootstrap.
The Controller installs the Agent and waits for a real heartbeat.

On the Edge Node:

```bash
sudo systemctl status northstar-agent --no-pager
sudo journalctl -u northstar-agent -n 100 --no-pager
sudo grep -E '^(NORTHSTAR_CONTROLLER_URL|NORTHSTAR_NODE_ID)=' \
  /opt/northstar-agent/config.env
```

The Agent reports health, resource usage, VPN service state, and traffic counters.
WireGuard normally uses UDP `51820`; OpenVPN normally uses UDP `1194`. Open those
ports in the Edge Node firewall/security group separately from the Controller.

## Local development

Node.js 22 or newer is required. Start PostgreSQL, configure `.env`, then run:

```bash
npm ci
npm run db:migrate
npm run dev
```

The Controller runs on `http://localhost:3000`. For separated frontends:

```bash
npm run dev:portal       # :3100
npm run dev:admin-web    # :3200
```

Both Vite servers proxy `/api` to the Controller.

## Verification and operations

```bash
npm run lint
npm test

sudo ./scripts/deploy.sh ps
sudo ./scripts/deploy.sh logs
sudo ./scripts/backup.sh ./backups
```

If a frontend build reports `dist/admin-web-web`, update to the current
`Dockerfile.frontend` and `docker-compose.yml`, which pass `DIST_DIR` explicitly:

```bash
docker compose build portal-web admin-web
docker compose up -d --no-deps portal-web admin-web
```

See [ARCHITECTURE.md](ARCHITECTURE.md) and
[docs/architecture](docs/architecture/README.md) for detailed design notes.
