# Northstar Control Plane

Northstar is a provider-neutral control plane for a small VPN edge fleet. The primary deployment target is one Linux cloud host running Docker. This works on Alibaba Cloud ECS, Tencent Cloud CVM, Google Compute Engine, and ordinary VPS providers without depending on a provider-specific runtime.

The long-term architecture baseline is documented in [`ARCHITECTURE.md`](ARCHITECTURE.md) and [`docs/architecture/README.md`](docs/architecture/README.md). Use that baseline when changing the controller, VPN protocols, clients, or deployment model.

The current implementation includes:

- a protected owner console with cookie sessions and scrypt password hashes;
- PostgreSQL persistence with automatic schema initialization and a Compose health gate;
- AES-256-GCM encryption for SSH recovery credentials;
- audited node creation, bootstrap attempts, agent heartbeats, and node actions;
- SSH host-key verification, password/private-key bootstrap, and a least-privilege systemd agent;
- Docker Compose, host-managed Nginx HTTPS, health checks, backups, and a repeatable deployment script.
- versioned `/api/v1` authentication, device, node capability, Connection Profile, and Agent reconcile endpoints;
- protocol Adapter registry, WireGuard desired-state generation, IP leases, revisions, and structured Agent tasks.
- a browser-based Access workflow that generates a local WireGuard key, activates a profile, and downloads a client configuration for macOS or iPhone;
- lightweight Agent resource telemetry for CPU, load, memory, disk, network counters, and collection time.

The agent uses outbound HTTPS plus a per-node token and can pull structured WireGuard reconcile tasks. A node must have `wireguard-tools` installed before it can apply a real WireGuard configuration. OpenVPN/IKEv2 data-plane adapters, the Agent mTLS CA lifecycle, and native clients remain separate follow-up work.

## Local development

Node.js 22.13 or newer is required for local development. Production deployments run the controller and PostgreSQL in Docker Compose.

```bash
cp .env.example .env
# Set NORTHSTAR_ADMIN_EMAIL, NORTHSTAR_ADMIN_PASSWORD, NORTHSTAR_MASTER_KEY, and NORTHSTAR_DB_PASSWORD.
npm ci
# Start a PostgreSQL service, then set NORTHSTAR_DATABASE_URL to its URL.
npm run db:migrate
npm run dev
```

Open `http://localhost:3000` and sign in with the owner credentials from `.env`.

For a production-like local process:

```bash
npm run build
npm start
```

## Server deployment (Alibaba Cloud / Tencent Cloud / GCP / generic VPS)

The Controller uses the same Docker Compose deployment on every provider and does not depend on a provider SDK. Ubuntu or Debian is recommended. The application steps are the same on Alibaba Cloud ECS, Tencent Cloud CVM, GCP Compute Engine, and generic VPS hosts.

### 1. Prepare the cloud host

- Use at least 2 vCPUs, 4 GB RAM, and persistent storage;
- Point the domain A/AAAA record, such as `vpn.example.com`, to the host public address;
- Install Nginx on the host and let Nginx manage HTTPS and uploaded certificates;
- Allow inbound TCP `80` and `443` in the cloud security group;
- Restrict TCP `22` to trusted administration addresses;
- Do not expose Controller port `3000` to the public Internet;
- Configure Nginx to proxy HTTPS requests to `127.0.0.1:3000`;
- Prepare the domain certificate before deployment. Docker does not request or renew certificates.

WireGuard, OpenVPN, and IKEv2 are Edge Node data-plane services. Open their ports in each Edge Node security group separately; they are not Controller Compose entry points.

### 2. Get the source code

```bash
sudo git clone YOUR_REPOSITORY_URL /opt/northstar
cd /opt/northstar
```

If the source was copied to the host by another method, enter the project directory directly.

### 3. First deployment

```bash
sudo ./scripts/one-click-deploy.sh --domain vpn.example.com --admin-email owner@your-domain.example
```

The administrator password is requested interactively by default. Avoid `--admin-password` so the password does not remain in shell history. The password must be at least 16 characters.

The script automatically:

- installs Docker Engine, Compose, Git, and OpenSSL on Ubuntu/Debian;
- generates a 32-byte `NORTHSTAR_MASTER_KEY`;
- generates a random `NORTHSTAR_DB_PASSWORD`;
- creates a production `.env` with mode `0600`;
- validates the domain, HTTPS origin, administrator credentials, master key, and Compose configuration;
- builds the Northstar image;
- starts or reuses the project PostgreSQL service, waits for its health check, runs migrations, and then starts the Controller;
- checks `http://127.0.0.1:3000/api/health` on the host.

If `.env` already exists, the script reuses it by default. Use `--yes` only when you explicitly want to regenerate the configuration; the existing file is backed up to a timestamped `.env.backup.*` file first. Add `--skip-docker-install` when Docker and Compose are already installed.

You may omit `sudo` when the current user has Docker permissions. If Docker was first installed by root, continue using `sudo`, or add the deployment user to the `docker` group and log in again.

### 4. Verify the deployment

After configuring Nginx in the next section, run the public check:

```bash
sudo ./scripts/deploy.sh ps
curl --fail https://vpn.example.com/api/health
```

The health endpoint should return `status: ok`. Public access is provided by Nginx. If it fails, check Nginx configuration, certificates, DNS, cloud security groups, and Nginx logs. The deployment script also checks the Controller locally before Nginx is configured.

### 5. Host Nginx and manually managed certificates

The project provides an [Nginx configuration template](deploy/nginx/northstar.conf.example). Install Nginx on the cloud host and copy the provider-issued certificate to a directory readable by Nginx, for example:

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

Edit `server_name` and the certificate paths in the configuration. The Nginx upstream must be `http://127.0.0.1:3000`. Keep the real `APP_DOMAIN` and `NORTHSTAR_PUBLIC_ORIGIN` in `.env` so the application generates correct public URLs and Agent callback URLs. Docker itself does not listen on public ports `80` or `443`.

### 6. Manual deployment

For full control over each setting, install Docker Engine and Docker Compose yourself, then run:

```bash
cp .env.example .env
chmod 600 .env
openssl rand -base64 32
```

Put the generated master key, database password, and production values in `.env`. At minimum, replace:

```dotenv
NODE_ENV=production
APP_DOMAIN=vpn.example.com
NORTHSTAR_PUBLIC_ORIGIN=https://vpn.example.com
NORTHSTAR_ADMIN_EMAIL=owner@your-domain.example
NORTHSTAR_ADMIN_PASSWORD=use-a-long-random-password
NORTHSTAR_MASTER_KEY=the-generated-32-byte-base64-value
NORTHSTAR_DB_PASSWORD=use-a-long-random-database-password
```

Then run:

```bash
./scripts/check-env.sh
sudo ./scripts/deploy.sh
```

### 7. Upgrades and backups

The database runs in the Compose `db` service and its data is stored in the Docker volume `northstar-postgres`. The SQLite-to-PostgreSQL switch intentionally does not migrate old SQLite data; this is acceptable while the project is still in development. Before future upgrades, export a PostgreSQL backup, pull the source, and redeploy:

```bash
sudo ./scripts/backup.sh ./backups
git pull --ff-only
sudo ./scripts/deploy.sh
```

You can also use the root-level one-click update script. It backs up PostgreSQL, checks for tracked local changes, pulls the upstream source, rebuilds the service, and runs the health check:

```bash
sudo ./one-click-update.sh
```

If Docker may be using stale build cache, use:

```bash
sudo ./one-click-update.sh --no-cache
```

The update script does not delete `.env` or the `northstar-postgres` volume. Do not use `docker compose down -v`. `deploy.sh` uses the normal build cache by default and force-recreates the service containers; use `--no-cache` only when investigating a cache problem.

If the server has inconsistent containers, images, or build state, use the clean rebuild script. It creates a database backup by default and requires the `REBUILD` confirmation. It removes only this project's Northstar Controller containers and service images; it does not remove `.env` or the `northstar-postgres` volume:

```bash
sudo ./one-click-rebuild.sh
```

Use the following only when the current containers cannot start and a backup cannot be created:

```bash
sudo ./one-click-rebuild.sh --yes --skip-backup
```

The script does not clean containers, images, or volumes belonging to other projects.

Do not replace `NORTHSTAR_MASTER_KEY` without a credential re-encryption migration. Existing encrypted SSH credentials will otherwise become unreadable.

### 8. Operations and troubleshooting

```bash
sudo ./scripts/deploy.sh ps
sudo ./scripts/deploy.sh logs
sudo journalctl -u nginx -f
sudo docker compose restart northstar
sudo ./scripts/backup.sh ./backups
```

The deployment script prints the latest 120 lines from both PostgreSQL and Controller logs when a health check fails. Alibaba Cloud uses ECS security groups and disks, Tencent Cloud uses CVM security groups and CBS disks, and GCP uses VPC firewalls and Persistent Disk; the application configuration is provider-neutral.

### 9. Docker Compose version problems

The project requires Docker Compose v2. If logs show `KeyError: 'ContainerConfig'`, the server is usually still using the old `docker-compose 1.29.2`. Install Compose v2 first:

```bash
sudo apt-get update
sudo apt-get install -y docker-compose-plugin
docker compose version
```

If `docker-compose-plugin` is not available from the current apt sources, configure the Docker official repository and install it there. Do not continue using Compose v1.

After upgrading Compose, remove only the old Controller containers and recreate them. Do not remove the `northstar-postgres` data volume:

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

Each node's **Logs** view shows the audited bootstrap output, Agent status/restart output, recent WireGuard reconcile errors, and lightweight resource telemetry. The Agent sends telemetry with its existing 30-second heartbeat; no separate metrics daemon or time-series service is required. CPU, memory, disk, and network values are visible in the node diagnostics panel.

The **Access** view is the first end-user connection workflow. It creates a macOS device identity in the browser, generates the private key locally, activates a WireGuard Connection Profile, and downloads a `.conf` file. Import that file into the official WireGuard macOS or iOS application. The private key is never sent to the Controller. The Edge Agent generates its WireGuard server key before its first heartbeat and reports only the public key; profile issuance is blocked until that key is available. Registered devices can be revoked from the Access view, which revokes the profile and reconciles the Edge configuration. Protocol selection remains behind the Connection Profile abstraction so future IKEv2 and OpenVPN adapters can use the same user flow.

The restart action is explicitly allow-listed and audited. Arbitrary shell commands and an interactive browser terminal are not enabled by default because they would turn the control plane into an unrestricted remote-execution service.

## Common operations

The following commands cover the most common operations. Run them from the project root:

```bash
docker compose logs -f northstar
docker compose restart northstar
docker compose logs -f db
docker compose exec northstar node /app/scripts/migrate.mjs
./scripts/backup.sh ./backups
```

Check the database before investigating the Controller:

```bash
sudo docker compose ps
sudo docker compose logs --tail=200 db
sudo docker compose logs --tail=200 northstar
df -h
df -ih
```

If PostgreSQL is healthy but the Controller is restarting, restart only the Controller:

```bash
sudo docker compose restart northstar
curl --fail http://127.0.0.1:3000/api/health
```

If the deployment fails because the database is not ready, rerun the staged deployment. The script starts PostgreSQL, waits for `healthy`, and only then starts Northstar:

```bash
sudo ./scripts/deploy.sh
```

If the PostgreSQL container is unhealthy, inspect its logs before changing or deleting any volume:

```bash
sudo docker compose up -d db
sudo docker compose ps
sudo docker compose logs --tail=200 db
```

If a build fails with `no space left on device`, inspect disk and inode usage, then remove Docker build cache and unused images. Do not remove volumes during this cleanup:

```bash
df -h
df -ih
sudo docker system df
sudo docker builder prune -af
sudo docker image prune -af
```

To remove old generated backups while retaining the newest five PostgreSQL dumps:

```bash
find backups -maxdepth 1 -type f -name 'northstar-*.dump' -printf '%T@ %p\n' \
  | sort -nr | tail -n +6 | sed 's/^[^ ]* //' | xargs -r rm -f --
```

To back up and restore PostgreSQL explicitly:

```bash
sudo ./scripts/backup.sh ./backups
sudo ./scripts/restore-postgres.sh ./backups/northstar-YYYYmmddTHHMMSSZ.dump
```

The restore script requires typing `RESTORE` and replaces the current database contents.

### Node Agent operations

Use the node row's `Actions` menu in the console:

- `Check agent`: run a status check over SSH;
- `Restart agent`: restart the allow-listed systemd service;
- `Reinstall agent`: rerun the SSH bootstrap and repair the Agent installation;
- `View logs`: inspect bootstrap output, Agent actions, and reconcile errors;
- `Edit configuration`: update node address, region, credentials, or fingerprint;
- `Delete node`: remove the node from the Controller after confirmation.

For fleet operations, select nodes in the table (optionally after filtering by
region) and choose `Check agents`, `Restart agents`, or `Reinstall agents`.
Checks run immediately. Restart and reinstall require a confirmation and are
queued by the Controller, which processes at most three remote actions at once;
they continue after the browser page is closed.

For a node that failed during bootstrap, first update the Controller code and redeploy it, then select `Actions` → `Reinstall agent`. The bootstrap script installs `python3` when needed and does not require an optional NetworkManager directory to exist. NetworkManager manages its own connection files through its daemon.

On the Edge Node, use these diagnostics:

```bash
sudo systemctl status northstar-agent --no-pager --full
sudo journalctl -u northstar-agent -n 200 --no-pager
sudo journalctl -u northstar-agent -f
command -v python3
```

`attention` with `heartbeat expired` means the Controller has not received a
successful Agent heartbeat for more than 90 seconds. `agent installed` only
confirms that bootstrap created the service; it does not prove that the Agent
can reach or authenticate to the Controller. Check the journal first, then
verify the configured public Controller URL without printing the Agent token:

```bash
sudo grep -E '^(NORTHSTAR_CONTROLLER_URL|NORTHSTAR_NODE_ID)=' /opt/northstar-agent/config.env
curl --fail --silent --show-error https://vpn.example.com/api/v1/health
```

The Agent records heartbeat and task-poll failures in the journal (rate-limited
to one repeated message per minute). A URL, TLS, DNS, firewall, or credential
failure is therefore visible directly on the Edge Node.

If the service was generated by an older bootstrap, remove the obsolete optional path from the unit before restarting it:

```bash
sudo sed -i '\|^ReadWritePaths=/etc/NetworkManager/system-connections$|d' /etc/systemd/system/northstar-agent.service
sudo systemctl daemon-reload
sudo systemctl restart northstar-agent
```

Keep `.env` and backup files outside source control. Production data is stored in the `northstar-postgres` Docker volume. Use `./scripts/restore-postgres.sh` only after a deliberate restore confirmation. Rotate `NORTHSTAR_MASTER_KEY` only with a planned credential re-encryption migration; changing it blindly makes existing encrypted credentials unreadable.

## Verification

```bash
npm run lint
npm test
```

`npm test` builds the production bundle. Integration tests additionally require `NORTHSTAR_TEST_DATABASE_URL` pointing to a disposable PostgreSQL database.

## Optional Cloudflare adapter

The original repository's Vinext/Cloudflare files remain as an optional adapter for the existing Sites project. They are not the primary deployment path because a Worker cannot safely act as the SSH control process for arbitrary cloud VMs. Use the Docker/Node deployment above for Alibaba Cloud, Tencent Cloud, GCP, and other host providers.
