# TrackNothing Control Plane

TrackNothing is a lightweight VPN control plane for a small fleet of Linux Edge Nodes.
It includes a customer Portal, an Admin console, a Controller/API, and an outbound
Node Agent. The current data plane supports WireGuard and OpenVPN.

## Architecture

```text
Browser:  app.example.com       -> Portal  :3100
          console.example.com   -> Admin   :3200
          Portal/Admin /api/*    -> veilbird:3000 (Docker network)

Native:   api.example.com       -> API     :3000
Agent:    outbound HTTPS        -> api.example.com/api/v1/agent/*
```

The Controller, Portal, and Admin run as independent Docker services. Host Nginx
terminates HTTPS and forwards each site to its loopback port. Portal/Admin proxy
`/api` internally to `http://veilbird:3000`; only native clients and remote Agents
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
sudo git clone YOUR_REPOSITORY_URL /opt/veilbird
cd /opt/veilbird
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
sudo cp deploy/nginx/snippets/veilbird-proxy.conf \
  /etc/nginx/snippets/veilbird-proxy.conf
sudo cp deploy/nginx/veilbird.conf.example \
  /etc/nginx/sites-available/veilbird.conf
sudo ln -s /etc/nginx/sites-available/veilbird.conf \
  /etc/nginx/sites-enabled/veilbird.conf
sudo nginx -t
sudo systemctl reload nginx
```

Docker binds only to `127.0.0.1`; do not expose ports `3000`, `3100`, or `3200`
directly to the Internet.

Nginx sends all `app.example.com` traffic to Portal and all `console.example.com`
traffic to Admin. Their `/api` requests stay on the Docker network. The separate
`api.example.com` host is only for native clients and remote Edge Agents.

### Request limits

Two layers stop scripts that hammer the API, without extra services:

- **Nginx** (`scripts/setup-nginx-limits.sh`, run by every deploy): for this deployment's hostnames only
  (from `.env`, Console → 站点 and the Agent domain), 20 requests/s per IP (burst 40), 30 connections per IP,
  and 10 sign-in/register/reset requests per minute per IP. It writes `veilbird-limits.conf` into the
  directory Nginx includes in its `http` block (BaoTa: `/www/server/panel/vhost/nginx`, otherwise
  `/etc/nginx/conf.d`; override with `--nginx-config-dir`). Other websites on the same Nginx are not
  affected. If `nginx -t` fails the previous configuration is restored. Re-run it after adding a site.
- **Controller** (`proxy.ts`, `server/rate-limit.ts`): token buckets per IP, per signed-in session, per
  app session (status polling separately), per Agent address, for public endpoints and for installer
  downloads (30/hour). 40 failed authentications (wrong passwords, retries after a sign-in 429, unknown
  Agent node ids) within 10 minutes block that IP for 1 hour; the block is logged in Console → 日志
  (`abuse.address_banned`). Counters are in memory and reset when the Controller restarts.

Behind a CDN every visitor arrives from the CDN's addresses: set `VEILBIRD_NGINX_LIMITS=no` and configure
Nginx `real_ip` first. `VEILBIRD_RATE_LIMIT=off` disables the Controller limits.

## Sites (several brands on one deployment)

Console → **站点** lists the brands this deployment serves. Every site shares the same
accounts, nodes and Agent; only the name, logo and hostnames differ. A site has three
hostnames: the user Portal, the subscription/API domain and (optionally) its own Console.
The Controller picks the site from the requested hostname (`Host` / `X-Forwarded-Host`):
the Portal and Console show that site's name and logo, subscription links use its API
domain and name the Clash group after it, and password-reset emails link to its Portal.
Unknown hostnames get the default site. The first site is created automatically from
`VEILBIRD_PORTAL_DOMAIN`, `VEILBIRD_ADMIN_DOMAIN` and `VEILBIRD_API_DOMAIN`.

The native apps are built for the default site; other sites offer subscriptions and hide
the app downloads.

### Agent domain

Nodes install and heartbeat through one Agent domain that belongs to no site, so adding,
renaming or deleting sites never touches the nodes. It starts as `VEILBIRD_AGENT_ORIGIN`
(the API domain at install time) and can be moved in Console → 站点 → **Agent 接入域名**:

1. Point a hostname such as `agent.example.com` at this server and add it in BaoTa as a
   reverse proxy to `http://127.0.0.1:3000` (`$host` forwarded) with a certificate.
2. Enter it in Console. Saving is refused until `https://<domain>/api/v1/agent/whoami`
   answers as this deployment.
3. Every heartbeat announces the domain. Agent 2.13+ sends one heartbeat through it and
   rewrites `NORTHSTAR_CONTROLLER_URL` only if that succeeds (otherwise it stays on the old
   domain and retries every 10 minutes). Older Agents switch after **升级 Agent**; new
   installs and 重装/修复 use the new domain directly.
4. Keep the old domain until the panel shows every node on the new one.

To add a site: create it in Console, point its DNS records at this server, then add one
reverse-proxy website per hostname in Nginx / BaoTa: Portal → `http://127.0.0.1:3100`,
API → `http://127.0.0.1:3000`, Console → `http://127.0.0.1:3200`, forwarding the original
host (`proxy_set_header Host $host`, BaoTa "发送域名" `$host`), and issue a Let's Encrypt
certificate. **检查域名** on the site confirms each hostname reaches this site over HTTPS.

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

Upgrading an install from before the Veilbird rename needs no manual steps:
`NORTHSTAR_*` keys in `.env` are renamed to `VEILBIRD_*` (backup in
`.env.before-veilbird`), the `northstar` container is replaced by `veilbird`,
and data volumes, the database and Edge Nodes stay as they are. Portal and
Console users sign in once more because the session cookies were renamed.

Recommended upgrade:

```bash
sudo ./one-click-update.sh
```

It pulls the latest code and updates only the modules whose code changed since
they were last deployed, and prints the plan first, e.g. `Updating: console` /
`Unchanged, left running: backend, portal, static site`. The four modules:

| Module | What it is | Updated when these change |
| --- | --- | --- |
| backend | Controller/API (`veilbird`), migrations run on start | `app/`, `server/`, `agent/`, `scripts/migrate.mjs`, dependencies, `shared/` |
| portal | Customer Portal (`portal-web`) | `portal-web/`, `shared/`, dependencies |
| console | Admin Console (`admin-web`) | `admin-web/`, `shared/`, dependencies |
| agent | The Agent on every node | its version differs from the one the backend carries |

Changes to the apps, docs, tests or host scripts rebuild nothing; a file the
script does not recognise rebuilds every module. A database backup is taken
only when the backend is updated, and only the chosen modules are recreated:
the others keep running untouched. If nothing changed, nothing is rebuilt.

After the server modules, node Agents that are behind are upgraded: the node with
the fewest users first, the rest only if it comes back healthy (each node's VPN
services restart once; a failed node rolls itself back within 90 s). Offline nodes
and old Agents without a saved SSH login are listed for Console → 节点.

Options:

```bash
sudo ./one-click-update.sh --only console          # just these modules (comma list:
sudo ./one-click-update.sh --only backend,console  #   backend, portal, console, agent, static)
sudo ./one-click-update.sh --only agent            # only upgrade node Agents
sudo ./one-click-update.sh --all                   # rebuild and restart everything
sudo ./one-click-update.sh --no-agent              # leave node Agents for later
```

`--service veilbird|portal-web|admin-web|all` still works and means the same as `--only`.
When a frontend is chosen by hand while the backend has undeployed changes, the
script warns, because a new page may need the new API.

Before replacing a module, the image it runs is tagged `:previous`. If the new
version does not become healthy, every module of that update goes back to its
previous image automatically (database changes stay; the backup taken before the
update is in `./backups`). Only one update runs at a time. What each module last
deployed is kept in `.deployed/` (delete it to make the next update rebuild all).

You can also run the deployment script directly. In an interactive terminal it
opens a guided menu; with `--service` it stays non-interactive:

```bash
sudo ./scripts/deploy.sh --service backend,portal
```

Updates clean up after themselves so the disk does not fill over time: only the
newest 10 database dumps in `./backups` are kept (`VEILBIRD_BACKUP_KEEP` in `.env`,
`0` keeps all), each container keeps at most 30 MB of Docker output, and after a
healthy deploy the untagged images left by the previous build and build cache older
than 7 days are removed (`VEILBIRD_DOCKER_PRUNE=no` skips this). Copy important
dumps off the server; they are not a substitute for off-site backups (see
[Off-site backups](#off-site-backups)).

### Server images from CI

By default each update builds the images on the server. CI can build them instead
(`.github/workflows/server-images.yml`, one set per master commit, tagged with the first
12 characters of the commit), so the server only pulls:

1. Set `VEILBIRD_IMAGE_PREFIX` in `.env`, e.g. `ghcr.io/cntwdev/tracknothing`. GHCR packages
   are private by default: run `docker login ghcr.io` once on the server with a token that
   has `read:packages`, or make the packages public. For servers in mainland China, also push
   to Aliyun ACR: set the repository variable `VEILBIRD_ACR_PREFIX` (e.g.
   `registry.cn-hangzhou.aliyuncs.com/<namespace>/tracknothing`) and the secrets
   `VEILBIRD_ACR_USERNAME` / `VEILBIRD_ACR_PASSWORD`, and use that prefix here.
2. Update as usual. Deploy pulls the images for the checked-out commit; if CI has not
   finished yet or the registry cannot be reached, it builds locally as before.
3. Roll back by running an earlier commit's images:
   `sudo ./scripts/deploy.sh --service all --tag <commit>` (database migrations only add,
   so an older Controller keeps working on the newer schema).

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

## Off-site backups

Every night at 03:30 (server time) the database is dumped, encrypted together with
`.env`, and uploaded to an S3-compatible bucket: Aliyun OSS, Cloudflare R2, AWS S3
or MinIO. Every Sunday a restore drill downloads the newest copy, restores it into a
throwaway PostgreSQL container (no network, deleted afterwards) and compares it with
the live database. Production is never touched by the drill.

Setup is four lines in `.env`, then an update:

```bash
VEILBIRD_BACKUP_S3_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com   # R2: https://<account-id>.r2.cloudflarestorage.com
VEILBIRD_BACKUP_S3_BUCKET=tracknothing-backups
VEILBIRD_BACKUP_S3_ACCESS_KEY_ID=...
VEILBIRD_BACKUP_S3_SECRET_ACCESS_KEY=...
```

```bash
sudo ./one-click-update.sh
```

The update installs two systemd timers (`veilbird-backup.timer`,
`veilbird-backup-drill.timer`) and, the first time, makes a backup and runs the drill
right away so a wrong key or bucket shows at once. Use a private bucket in another
region or with another provider, and keys limited to that bucket (read, write, list,
delete objects). The newest 30 copies are kept (`VEILBIRD_BACKUP_S3_KEEP`, `0` keeps
all); they go under `veilbird-backups/` (`VEILBIRD_BACKUP_S3_PREFIX`). Region and
addressing are read from an OSS endpoint; set `VEILBIRD_BACKUP_S3_REGION` /
`VEILBIRD_BACKUP_S3_ADDRESSING` for other providers if they need it.

Each upload, failure and drill result is written to Console → 日志 (search
"backup"). A drill fails, and logs an error, when the newest copy cannot be
decrypted or restored, has no users, or is more than 36 hours old.

Copies are encrypted (AES-256-GCM) with `VEILBIRD_MASTER_KEY`, or with
`VEILBIRD_BACKUP_PASSPHRASE` when set. **Keep that key somewhere other than this
server**: without it a copy cannot be opened, and the encrypted fields in the
database (node SSH logins, keys) cannot be read either.

By hand:

```bash
sudo ./scripts/offsite-backup.sh          # back up now
sudo ./scripts/offsite-backup.sh --list   # copies in the bucket
sudo ./scripts/backup-drill.sh            # restore drill now
sudo ./scripts/install-backup-timer.sh --remove   # stop the nightly backups
```

Restoring after the server was lost: install a new server as usual
(`scripts/one-click-deploy.sh`), add the same `VEILBIRD_BACKUP_S3_*` lines to its
`.env`, then run `sudo ./scripts/offsite-restore.sh` (newest copy; `--list` or a copy
name for another). It asks for the old server's master key when needed, offers to put
that key into `.env`, and restores with `scripts/restore-postgres.sh`, which asks for
confirmation first. The old `.env` is saved beside the dump in `./backups` for the
other settings.

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

Users who forget their Portal password have two ways back, both through a
one-time link that stops working once used (nothing is stored in the database):

- **Console → Users → ⋯ → Password reset link** creates a link valid for 24
  hours. Send it to the user; they choose the new password themselves.
- **Forgot password?** on the Portal sign-in page emails a link valid for 1
  hour. Turn it on in **Console → Controller → Email**: pick Alibaba Cloud
  DirectMail (or any SMTP service), enter the sender address and its SMTP
  password, save and send a test email. Without it the page asks the user to
  contact the administrator.

Setting a new password signs the account out of the Portal and native clients.

## Edge Node bootstrap

**Install command (recommended).** In Console → 节点运维 → 添加节点, choose
**安装命令**, enter the name, public IP, region and template, and run the command it
shows on the server as root:

```bash
curl -fsSL https://<agent domain>/api/v1/agent/join/<install token> | sh
```

The token expires after 1 hour and stops working once the node it installed is online;
only its hash is stored. Downloading it does not use it up, so a run that stopped (not
root, network) can simply be repeated, and chat-app link previews (anything that is not
`curl`/`wget`) are answered with a hint instead of the script. The script
creates `/var/lib/northstar/node-id`, installs the Agent with this node's token and
starts it; the node then appears online and the standard services are deployed. No SSH
credential is stored and no inbound SSH is needed. Node details → **安装命令** creates a
new one for reinstalling or repairing such a node.

**Agent self-upgrade.** Agent 2.17+ upgrades itself: **升级 Agent** hands it the new
version over its HTTPS long-poll, it downloads the source, checks the SHA-256, keeps the
old file and confirms on its first heartbeat; without that heartbeat within 90 seconds a
timer restores the old version. Older Agents are upgraded over SSH once. **清除 SSH 凭据**
(node menu) deletes the stored password or key; nodes deployed over SSH can also delete it
automatically after a successful deploy (on by default). The Controller can still
change what nodes run, so protect the Console and the server like the nodes themselves.

**SSH deployment.** In Admin, create a node with its public address and SSH credential, then choose
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
WireGuard normally uses UDP `51820`; OpenVPN normally uses UDP `1194`; VLESS
REALITY uses TCP `443`; the stealth transports for the TrackNothing apps (Hysteria2 and
VLESS REALITY XHTTP, one mihomo process, Agent 2.12+) use UDP **and** TCP `8443`.
Open those ports in the Edge Node firewall/security group separately from the Controller.

### Port hopping and the spare REALITY port (Agent 2.19+)

For networks that block or throttle one port, every node also accepts **TCP + UDP
`20000-29999`** (the same range on every node):

- UDP: the whole range is redirected (nat `PREROUTING`, `REDIRECT`) to Hysteria2 on 8443.
  Mihomo clients and the apps hop to a random port of `8443,20000-29999` every 20-40 s.
- TCP: one port per node in the range (fixed, derived from the node id, shown in Console →
  node → 诊断) is redirected to REALITY on 443: an extra REALITY line after the 443 one.

The redirect runs before the host firewall, so the Agent adds no INPUT rule for the range;
only the **cloud security group** needs one inbound rule: TCP and UDP `20000-29999` from
`0.0.0.0/0` (and `::/0` with IPv6). Rules survive reboots and firewalld reloads (the Agent
checks them every minute). The Controller tests the range from outside every 12 hours
(hourly while closed); a node only offers these lines once it saw them open, so a node
without the security group rule keeps working exactly as before.

Console alerts also flag a line that looks blocked at one node: in 24 hours apps on 2+
networks (half or more of those that tried) failed on it while the same line worked to
another node from those networks.

## TrackNothing app transports

All TrackNothing apps (Android, iPhone/Mac, Windows) embed the same mihomo core and prefer WireGuard (lightest). When it is blocked they fall back, without any
user choice, to Hysteria2 with Salamander obfuscation (UDP, no QUIC fingerprint), then
VLESS REALITY Vision on TCP 443, then VLESS REALITY over XHTTP. Each enrolled device has
one secret that is its VLESS UUID and Hysteria2 password on every node; revoking the
device or an expired membership removes it from every node on the next heartbeat.
The stealth service reuses the node's REALITY keys and target, so it deploys after
VLESS. AmneziaWG is not used: it needs a kernel module or a separately built userspace
daemon on every node, and Hysteria2 with Salamander covers the same "UDP without a
signature" case.

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

A subscription contains all currently eligible, synchronized nodes. New subscriptions
are VLESS; on a node with the stealth service (Agent 2.12+, UDP+TCP 8443) each node
carries the apps' three lines with the subscription's one UUID: Hysteria2 (Salamander,
certificate pinned), VLESS REALITY (TCP 443) and VLESS REALITY over XHTTP (TCP 8443).
Where the node offers them (see "Port hopping" above), Hysteria2 hops ports (mihomo
clients only; share links keep one port) and a REALITY line on the node's spare TCP port
follows the 443 one. Mihomo/Clash shows one entry per node, a hidden fallback group over its lines, plus the
automatic latency-selection group. Share-link clients list the lines as `Node`,
`Node · 备用 1`, `Node · 备用 2`. Lines are sent by User-Agent: no XHTTP for mihomo older
than 1.19.22, REALITY only for Hiddify (old imports), REALITY + XHTTP for Stash (no Hysteria2
pin there; VLESS lines also carry `sni`), Hysteria2 in share links only for v2rayN/v2rayNG
(pinSHA256). Stealth traffic counts against the subscription like REALITY traffic.
Older WireGuard subscriptions are moved to VLESS under the same link by the minute jobs; their
WireGuard credential keeps working 7 days for devices that have not refreshed yet.

- Supported target formats: Mihomo/Clash Meta YAML (JSON-compatible YAML).
  The Portal offers the same list on every device: Clash Verge Rev (Mac/Windows/Linux),
  ClashX Meta (Mac), v2rayN (Windows), Clash Meta for Android, v2rayNG (Android),
  Shadowrocket, Stash (iPhone/iPad) (`portal-web/src/client-options.ts`). Import the personal URL as a remote subscription,
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

REALITY targets need no configuration by default (**自动选择**): every Agent probes a
built-in pool of large public TLS 1.3 + HTTP/2 sites and the Controller gives each node
a fast target it verified itself, so the fleet does not share one fingerprintable
domain and the management host is never exposed through SNI. **VPN services → REALITY
设置 → 自建目标** remains available for an operator-run static site; the bundled static
service and `scripts/setup-reality-target.sh` support it, see
[deployment instructions](docs/architecture/06-deployment.md).
Standard policy **v2** automatically installs WireGuard, OpenVPN and VLESS on new nodes.
Older standard nodes gain missing protocols through the existing **Reinstall / repair**
or standard-policy canary/batch rollout; VLESS requires Linux amd64/arm64 and Agent 2.7+.
Reinstall / repair installs the current Agent. Custom and Agent-only templates are preserved.
There is no separate per-node VLESS onboarding workflow. A node waiting for its target
blocks only VLESS; standard rollouts still apply the other protocols and VLESS retries
on heartbeat. The node validates the target and pins its resolved public address.
Repeated deployments retain existing keys, ports and targets; changing the global default
does not touch existing nodes. Use the generic advanced service settings only for
exceptions such as TCP/443 already being occupied; they override that one protocol and
keep the node on the standard policy.
Changing a node's target is a smooth switch: keys stay, the previous names remain
accepted (up to three), and issued profiles move to the new name, so subscribers pick it
up on their next refresh and fixed-node users re-download once.
Open that TCP port in the cloud security group as well as the host firewall. Do not
expose the local statistics API on TCP 10085.

The Agent downloads **Xray v26.3.27** from the official XTLS release and checks the
pinned SHA-256 for its architecture; no remote shell installer is executed. Node
egress needs HTTPS access to GitHub releases, the selected REALITY target, and normal
user traffic destinations. A failed download/preflight stays visible as a service error.
The Agent checks occupied ports and never displaces existing web or VPN listeners.
Access changes go through Xray's local API: added users work immediately and removed
users are rejected immediately, without disconnecting anyone. To also close sessions that
removed users already had open, the Agent restarts Xray once 60 seconds later, coalescing
all revocations in that window. Traffic is sampled on heartbeats, so bytes since the last
sample may be lost on a restart.

Subscription links serve Clash/Mihomo YAML by default and a base64 `vless://` list
(`format=v2ray`) for Shadowrocket, v2rayN/v2rayNG and similar clients; the format is also
picked from the client's User-Agent. Every Clash profile has the same two choices: the
`TrackNothing` group defaults to `自动选择` (lowest latency, measured by the client every 5
minutes, switching away from nodes that stop answering) or a fixed node, and the client's
own Global switch also goes through TrackNothing. Routing defaults to `mode=smart` (private
networks and mainland China direct, everything else through TrackNothing) using three small
rule sets (~0.6 MB, MetaCubeX `meta-rules-dat` via jsdelivr) that the client downloads
through the tunnel and refreshes daily; if they cannot be downloaded the profile still
works and simply proxies that traffic. `mode=global` sends everything except private
networks through the tunnel. Node names
read `🇯🇵 Tokyo · node-name` and stay stable when nodes are added. Fixed-node VLESS
profiles also export a single share link (`/api/v1/profiles/{id}/download?format=uri`).

For validation, `npm test` covers unit and integration hooks. Supply a disposable
`VEILBIRD_TEST_DATABASE_URL` to run PostgreSQL/API tests, and optionally
`VEILBIRD_TEST_XRAY` / `VEILBIRD_TEST_MIHOMO` paths to validate generated configs
with real binaries (both routing modes must load offline). `VEILBIRD_TEST_AUTOMATION_DATABASE_URL` and
`VEILBIRD_TEST_REALITY_DATABASE_URL` (separate disposable databases) enable two more suites.
CI runs all of this on every push and pull request (`.github/workflows/backend-tests.yml`).
These checks do not replace iPhone/Android and live-node acceptance tests.

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

### Agent 2.18: one subscription per account

- **Portal home.** Every account has one subscription with every node. It is created the
  first time the user imports it, never by hand. The home page lists the same apps with
  their platforms on every device: one tap through `clash://`,
  `stash://` or `shadowrocket://`; v2rayNG and v2rayN copy the link, and shows the QR code
  and link without asking for a password; resetting the link asks for one. Single-node
  WireGuard / OpenVPN / VLESS configs are made on their own page. Accounts with several
  older subscriptions keep the oldest as the account subscription; the others keep working
  and can only be deleted (single-node page, "之前创建的订阅").
- **Devices.** The subscription no longer takes a device: app sign-ins and single-node
  configs do. Welcome plans and grants move from 1 to 2 devices (migration 009).
- **Online places.** Agent 2.18 reports, with each heartbeat, a 16-hex hash of every source
  address using a subscription over REALITY, Hysteria2 or XHTTP (Xray `statsUserOnline`,
  mihomo connections). The Controller keeps it in memory only for 3 minutes; the Portal and
  Console show "现在在线", and accounts above their device limit are logged hourly as
  `account.online_over_limit`. Nothing is blocked yet.

Rollout: `sudo ./one-click-update.sh` (migration 009) → **升级 Agent** on each node to 2.18
(Xray restarts once to turn on online stats). No new app builds are needed.

### Agent 2.17: outage tolerance, alerts and app entry points

- **Controller outage.** App leases are renewed every 90 s and last 5 minutes. When the Agent
  cannot reach the Controller (not when it is refused) it extends valid app WireGuard
  leases itself, up to 12 h after the last contact (`NORTHSTAR_NATIVE_OFFLINE_GRACE` in the
  Agent's `config.env`, seconds); the apps keep a working tunnel for as long. Revocations,
  expiry and quota still apply as soon as the Controller is back.
- **Tasks on demand.** Agents long-poll for tasks (held up to 25 s and answered as soon as
  there is work) instead of asking every 5 s.
- **Alerts.** Console → Controller → **告警**: recipients for email (sent through the mail
  settings above it) when a node has no heartbeat for 3 minutes, a service is failing for
  10 minutes, a disk is above 85% or an Agent is a day behind; recovery is mailed too.
- **App entry points.** The apps try their own API domain, then the API domains of every
  site and the backup domains in Console → 站点 → **App 备用入口**. Per domain they dial
  addresses that worked before first, then system DNS, then DNS over HTTPS; certificates
  are always checked against the domain. Backup domains need the same Nginx reverse proxy
  to `http://127.0.0.1:3000` and a certificate.
- **Apps.** Kill switch (Windows: firewall rules held by the core; Apple: "include all
  networks"; Android: the system's always-on VPN with blocking), crash reports (APP_CRASH
  in 客户端发布 / 运行日志), automatic location also weighs node load and users, and
  connecting no longer waits for WireGuard when other transports are offered.

Rollout: `sudo ./one-click-update.sh` (migration 006) → **升级 Agent** on each node to 2.17
(this one time over SSH; later upgrades need no SSH) → new app builds.

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

### Monthly node traffic and Agent 2.11

Agent 2.11 reports byte counters of the node's default-route (public) interface. The
Controller accumulates them per UTC calendar month and shows **outbound** (what most clouds
bill) and inbound per node in Console → 节点运维. Tunnel interfaces are excluded so VPN
traffic is not counted twice. Counting starts with the first heartbeat after **升级 Agent**;
reboots and counter resets are handled automatically.

### Client releases and Agent 2.10

Deploy the Controller (migrations add `client_releases`, `client_policies` and client
version columns), then **升级 Agent** on nodes that use TrackNothing native access; 2.10.0 is
the native-lease Agent formerly labelled 2.9.0 on the client branch.

- Console → 客户端 → 客户端发布 registers, publishes, promotes and withdraws native clients.
  Permanent links `/download/{platform}` always redirect to the newest stable build.
- `npm run release:client` uploads an installer (S3-compatible storage such as R2) and
  registers a draft with `VEILBIRD_RELEASE_TOKEN`; see `clients/README.md` and `.env.example`.
- Native clients send `X-Veilbird-Client`; a per-platform minimum build returns
  `426 CLIENT_UPDATE_REQUIRED` at sign-in and connect. No minimum is set by default.
- Tag `client-v<version>` (matching `clients/version.json`) to have GitHub Actions build a
  signed Android APK and publish it to beta; promote it, stage a rollout percentage, set a
  client announcement and read connection-failure reports in the same Console page.
- Agent 2.10 applies lease renewals from its task poll, so a renewing client no longer
  triggers a node-wide WireGuard reconcile. Native sessions slide for
  `VEILBIRD_NATIVE_SESSION_DAYS` (default 30) instead of 12 hours.

### Agent 2.9 update

Deploy the Controller (migrations run automatically), then **升级 Agent** on each node.

- OpenVPN picks its IPv6 handling per node: OpenVPN 2.5+ with kernel IPv6 keeps
  server-side `block-ipv6`; OpenVPN 2.4 (Ubuntu 20.04, Debian 10, CentOS 7) or kernels
  with IPv6 disabled push the client-side `block-ipv6` instead, so the server always
  starts. If OpenVPN still rejects a new configuration, the Agent restores the previous
  one and reports the error instead of leaving a crash loop.
- The new Agent confirms its own upgrade after its first authenticated heartbeat; the
  Controller waits up to 65 seconds for the target version and its SSH confirmation is
  now idempotent. WireGuard leases beyond the first /24 are used only after the upgrade
  is confirmed.
- Each Agent probes the REALITY candidate pool at start and every six hours and reports
  the results in its heartbeat. Pinned target addresses are kept while they still
  handshake, even when CDN DNS answers rotate, so Xray is not restarted needlessly.
- Subscriptions include a node as soon as the Agent applied a revision containing that
  user, so unrelated access changes no longer hide nodes for a few seconds. Concurrent
  refreshes of one link wait instead of failing.
