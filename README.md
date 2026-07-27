# Northstar VPN Control Plane

Northstar is a lightweight VPN control plane for a small fleet of Linux Edge Nodes.
It includes a customer Portal, an Admin console, a Controller/API, and an outbound
Node Agent. The current data plane supports WireGuard and OpenVPN.

## Architecture

```text
Browser:  app.example.com       -> Portal  :3100
          console.example.com   -> Admin   :3200
          Portal/Admin /api/*    -> northstar:3000 (Docker network)

Native:   api.example.com       -> API     :3000
Agent:    outbound HTTPS        -> api.example.com/api/v1/agent/*
```

The Controller, Portal, and Admin run as independent Docker services. Host Nginx
terminates HTTPS and forwards each site to its loopback port. Portal/Admin proxy
`/api` internally to `http://northstar:3000`; only native clients and remote Agents
use the public API hostname. SSH is used only for node bootstrap and repair.

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

Nginx sends all `app.example.com` traffic to Portal and all `console.example.com`
traffic to Admin. Their `/api` requests stay on the Docker network. The separate
`api.example.com` host is only for native clients and remote Edge Agents.

## Services and ports

| Service | Port | Purpose |
| --- | ---: | --- |
| Controller/API | 3000 | API, Agent gateway, migrations |
| Portal Web | 3100 | Registration, approval, devices, profiles, traffic |
| Admin Web | 3200 | User access, node operations, VPN policy, diagnostics |
| PostgreSQL | internal | Persistent application data |

Useful local checks:

```bash
curl --fail http://127.0.0.1:3000/api/health
curl --fail http://127.0.0.1:3100/health
curl --fail http://127.0.0.1:3200/health
```

## Admin console

Open `console.example.com` with the owner/admin account. The Console includes:

- user approval, rejection, suspension, and reactivation;
- node creation/editing, Agent checks/restarts, reinstall/repair, deletion, and
  fleet batch operations;
- node connectivity, protocol, firewall, action-event, and reconcile diagnostics;
- VPN service enable/disable/restart/redeploy and Standard policy canary/batch rollout;
- region and Controller settings, plus operational log query/purge.

End-user devices, VPN profiles, and traffic remain in the customer Portal. Node
repair uses the saved encrypted SSH credential; normal Agent communication uses
outbound HTTPS to the Controller API.

When a region has multiple healthy nodes, the Portal uses the least-loaded node
first. OpenVPN exports one profile containing all regional endpoints for automatic
failover. WireGuard exports one profile per node in a ZIP package; enable only one
of them at a time. Revoking the device invalidates the complete generated group.

## Upgrade

Recommended upgrade, including a PostgreSQL backup:

```bash
sudo ./one-click-update.sh
```

You can also run the deployment script directly. In an interactive terminal it
opens a guided menu for `all`, `northstar`, `portal-web`, or `admin-web`:

```bash
sudo ./scripts/deploy.sh
```

When called by automation or with an explicit `--service`, it stays non-interactive.

For a small, isolated change, update only the affected service:

```bash
sudo ./one-click-update.sh --service northstar    # Controller/API
sudo ./one-click-update.sh --service portal-web   # Portal
sudo ./one-click-update.sh --service admin-web    # Admin
```

Regional multi-node profiles change both the Controller and Portal, so deploy them
together with `sudo ./one-click-update.sh --service all`.

`northstar` and `all` create a database backup. Frontend-only updates skip the
database backup and do not restart the Controller. Use the full update when a
change touches dependencies, migrations, Compose configuration, or shared code.

When upgrading a legacy single-domain installation, deployment opens a one-time
domain migration prompt and rewrites only the seven Portal/Admin/API origin keys.
It backs up `.env` first; passwords and application secrets are preserved.

Manual upgrade:

```bash
sudo ./scripts/backup.sh ./backups
git pull --ff-only
sudo ./scripts/deploy.sh
```

Database migrations run during Controller deployment. `.env`, certificates, and
Docker volumes are preserved. Never use `docker compose down -v` in production.

To rebuild only the frontends without pulling code:

```bash
docker compose build portal-web admin-web
docker compose up -d --no-deps portal-web admin-web
```

## Uninstall and clean reinstall

For a guided full reset that keeps the source tree, Nginx, certificates, and DNS:

```bash
sudo ./one-click-uninstall.sh
```

The script removes this Compose project's containers, local images, data volumes,
`.env`, and local backups. It creates a recovery package beside the project by
default and prints the exact reinstall command when finished. Use `--no-backup`
only when the old database, secrets, and configuration must be unrecoverable.
Run `sudo ./one-click-uninstall.sh --check` first to verify the resolved project
path and Compose configuration without removing anything.

After upgrading Controller code, use the Admin node action **Reinstall agent** to
upgrade an Edge Agent. Existing VPN configuration is retained.

After upgrading to Agent 2.5, redeploy OpenVPN once from **VPN Services** to
enable per-credential online status and traffic counters. This status file stays
local to the Edge Node and is read only by the Agent.

For runtime recovery, open **VPN Services** in Admin and choose **Restart service**.
Use **Redeploy** when configuration or credentials changed; redeploy now restarts
OpenVPN automatically so the running process loads the newly written key material.

If the admin password is lost, reset an existing owner/admin account on the
Controller host:

```bash
sudo ./scripts/reset-admin-password.sh
```

## Edge Node bootstrap

In Admin, create a node with its public address, SSH credential, and verified
`SHA256:` host fingerprint. Then choose a deployment template and run Bootstrap.
The Controller installs the Agent and waits for a real heartbeat.

Get the trusted fingerprint from the Edge Node's cloud console:

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

The Admin node form includes this command, a copy button, and a remote
`ssh-keyscan` command generated from the entered IP and SSH port. Always compare
remote scan output with the trusted console value before the first deployment.

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

The frontend Docker targets copy only their own source directory. Backend changes
therefore keep the Portal/Admin dependency and build layers cached.

See [ARCHITECTURE.md](ARCHITECTURE.md) and
[docs/architecture](docs/architecture/README.md) for detailed design notes.
