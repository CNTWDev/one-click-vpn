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

After upgrading Controller code and running migrations, use **节点运维 → 升级 Agent**
(or select nodes and choose **批量升级 Agent**). The target version is read from the
Controller's bundled source, not from the Internet. This replaces only the Agent
program and restarts it, preserving its token and VPN configuration. Success requires
a fresh authenticated heartbeat reporting the target version. The previous source is
kept as `agent.py.previous`; immediate service restart failures restore it automatically.
A missing installation or rejected Agent identity requires **重新安装 / 修复** instead.
That operation reinstalls dependencies and re-registers the Agent identity via saved SSH.

Batch results report submission per node; queued does not mean successfully upgraded.
Open **详情 / 进度** for execution results. Failed submissions remain selected for retry.
Active operations renew a database lease every 30 seconds, including while waiting in
the Controller queue. Lost operations are marked failed after 60 minutes without renewal
when their node is inspected or another operation is submitted. They are never automatically
replayed. Migrations also respect live leases during rolling deployments. Check remote
service state before retrying an interrupted operation. **VPN 服务 → 批量同步策略** and
**重新部署 VPN** only affect protocol configuration, not the Agent program.

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

In Admin, create a node with its public address and SSH credential, then choose
a deployment template. Before creating the database record, the Controller logs
in, reads and pins the negotiated SSH host key, and reads or atomically creates
`/var/lib/northstar/node-id`. The Controller rejects duplicate node identities,
reused SSH host keys, and reused SSH endpoints before it queues bootstrap.

SSH authentication supports a password or an unencrypted OpenSSH/PEM private
key. Use **root** when the SSH account has uid 0; for cloud accounts such as
`ubuntu`, `ec2-user`, or `debian`, choose **passwordless sudo**. The Admin form
can import a `.pem`/`.key` file and test authentication, the discovered host
fingerprint, and remote privileges before saving. The first connection uses
trust on first use (TOFU); every bootstrap, repair, status, and restart after
that must match the pinned key. API callers with an independently trusted host
fingerprint may still supply `hostFingerprint` to require strict verification
on the first connection. VPN protocol configuration remains Agent-driven.

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

## Dynamic subscriptions and VLESS + REALITY

The Portal uses **新建连接 → 订阅 / 指定节点**, with subscriptions recommended by
default. **我的连接** manages both types together, with type filters and the same
rename/disable/revoke/delete controls. The account view in the admin console also
filters both types. Flow totals default to the same last-30-days UTC window; VLESS
reports recent activity rather than claiming an exact live connection count.

**指定节点** selects exactly one healthy node and generates one profile; it never
silently substitutes another node. Compatible clients are filtered by node capabilities,
and advanced settings allow WireGuard or VLESS selection for Hiddify/Mihomo. OpenVPN
uses its native client format. Existing regional/multi-node files remain usable and are
labelled as legacy regional configurations; they are not converted automatically.

A subscription contains all currently eligible, synchronized nodes
for its selected protocol (WireGuard or VLESS + REALITY). It is not a mixed-protocol
bundle. Clients can select a node or use the automatic latency-selection group.

- Supported target formats: Mihomo/Clash Meta YAML (JSON-compatible YAML).
  Use **Clash Verge Rev** on macOS/Windows/Linux, or **Hiddify** on
  iOS/Android/macOS/Windows/Linux. Import the personal URL as a remote subscription,
  not as a local file. Actual support depends on the installed client/core version.
  Official WireGuard/OpenVPN clients continue using the existing file-download flow.
- The response requests hourly refresh; the actual schedule is client-dependent,
  especially on iOS in the background. Manual refresh remains available. Updating
  the node list does not guarantee seamless migration of existing TCP sessions.
- Initial import may need a retry after Agent acknowledgement (typically tens of
  seconds). A 503 response preserves clients' last successful configuration instead
  of publishing an empty list. New nodes enter on the next successful refresh after
  access provisioning; offline, disabled or unsynchronized services are excluded.
- Links are bearer secrets. They are indexed by hash and additionally stored encrypted
  using the Controller master key so their owner can retrieve the same link after
  verifying their login password. Retrieval/reset is rate-limited and audited; list
  responses and admin endpoints never expose links. Legacy hash-only links remain
  valid but cannot be recovered: users may keep their saved URL, or explicitly reset
  it once and reimport. Never automatically rotate an existing link during upgrade.
  Links are delivered with `no-store`. Configure every reverse proxy/CDN to suppress query
  strings for `/api/subscription`; the supplied Nginx example disables access logs
  for this path. Do not use public subscription converters. Resetting a link only
  invalidates future downloads; revoke the subscription if credentials were exposed.
- User/admin disable controls are independent. Revocation, deletion, account
  suspension and credential expiry propagate to node access lists. Offline nodes
  cannot acknowledge revocation until they reconnect. Historical traffic is retained.
- WireGuard simultaneous installations need separate named subscriptions/identities.
  No device tracking is required. Subscription traffic contributes to account totals;
  VLESS presence is based on recent traffic, not an exact count of installed devices.

### Deploying the upgrade

Back up PostgreSQL, deploy all three services with `./scripts/deploy.sh deploy --service all`,
and update the Nginx subscription logging rule above. Docker runs the idempotent schema
migration automatically. Existing credentials stay intact; updating the Controller alone
does not immediately open new protocol listeners on old nodes.

Configure **VPN services → Default REALITY target** once for the platform, using an
independent static HTTPS site with TLS 1.3 and HTTP/2. The bundled static service and
`scripts/setup-reality-target.sh` support a separate domain on the management host;
see [deployment instructions](docs/architecture/06-deployment.md).
Standard policy **v2** automatically installs WireGuard, OpenVPN and VLESS on new nodes.
Older standard nodes gain missing protocols through the existing **Reinstall / repair**
or standard-policy canary/batch rollout; VLESS requires Linux amd64/arm64 and Agent 2.7+.
Reinstall / repair installs the current Agent. Custom and Agent-only templates are preserved.
There is no separate per-node VLESS onboarding workflow. Missing target configuration
blocks only VLESS; after target setup, already-created services retry on heartbeat.
The node validates the target and pins its resolved public address. Repeated deployments
retain existing keys, ports and targets; changing the global default does not invalidate
downloaded profiles. Use the generic advanced service settings only for exceptions such
as TCP/443 already being occupied. Those overrides mark the node as custom-managed.
Targets cannot change while the node has valid VLESS profiles. A failed initial setup
with no valid profiles can be corrected and redeployed without changing keys.
Open that TCP port in the cloud security group as well as the host firewall. Do not
expose the local statistics API on TCP 10085.

The Agent downloads **Xray v26.3.27** from the official XTLS release and checks the
pinned SHA-256 for its architecture; no remote shell installer is executed. Node
egress needs HTTPS access to GitHub releases, the selected REALITY target, and normal
user traffic destinations. A failed download/preflight stays visible as a service error.
The Agent checks occupied ports and never displaces existing web or VPN listeners.
Access-list changes restart only the managed VLESS service to terminate removed users'
sessions; other VLESS users can experience a brief reconnect. Traffic is sampled on
heartbeats, so bytes since the last sample may be lost on a restart.

For validation, `npm test` covers unit and integration hooks. Supply a disposable
`NORTHSTAR_TEST_DATABASE_URL` to run PostgreSQL/API tests, and optionally
`NORTHSTAR_TEST_XRAY` / `NORTHSTAR_TEST_MIHOMO` paths to validate generated configs
with real binaries. These checks do not replace iPhone/Android and live-node acceptance tests.

## Local development setup

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

### Agent 2.8 reliability and routing update

Deploy the Controller and run `npm run db:migrate`, then use **升级 Agent** on each
node. A confirmed upgrade queues a fresh apply for every enabled VPN service, so
existing nodes receive the routing changes without rotating credentials.

- Upgrades remain provisional until an authenticated target-version heartbeat
  arrives. A node-local 90-second watchdog restores the pre-upgrade source if the
  Controller or SSH connection disappears; `.previous` changes only on confirmation.
- The default WireGuard pool grows from `10.70.0.0/24` to `10.70.0.0/20` (4093 client
  addresses). Existing leases stay valid. Agents older than 2.8 remain limited to
  the first /24 until upgraded. Native full-tunnel clients capture IPv6 and use MTU
  1280; re-download and re-import existing files to receive those client changes.
- OpenVPN assigns an internal IPv6 address and pushes IPv6 routing; the server
  rejects IPv6 with `block-ipv6`, preventing it from bypassing the IPv4 VPN. This
  requires clients supporting IPv6 (the existing cipher configuration already
  requires modern OpenVPN). Verify Android/iOS clients after deployment.
- REALITY revalidates public DNS destinations and TLS/HTTP2 every five minutes.
  A failed validation keeps the last working configuration and reports an Agent
  error. A changed destination restarts Xray. Added users use its local API;
  revocation still restarts Xray to terminate established sessions.
- Unchanged subscriptions reuse desired state. VLESS heartbeat reconciliation
  compares encrypted-material fingerprints before decrypting UUIDs. Superseded
  bundles are removed after a one-day grace period once no desired or retryable
  task references them.
