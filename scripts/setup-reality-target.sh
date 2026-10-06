#!/usr/bin/env sh
# Run on the management host, never from a web request or inside the controller.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"
cd "$APP_DIR"
domain=""
email=""
config_dir=/etc/nginx/conf.d
while [ "$#" -gt 0 ]; do
  case "$1" in
    --domain) domain=${2:-}; shift 2 ;;
    --email) email=${2:-}; shift 2 ;;
    --nginx-config-dir) config_dir=${2:-}; shift 2 ;;
    --help|-h)
      echo "Usage: sudo sh scripts/setup-reality-target.sh --domain www.example.com --email ops@example.com [--nginx-config-dir /etc/nginx/conf.d]"
      echo "Requires Linux, Docker Compose, host Nginx, certbot, OpenSSL, curl, flock and systemd. DNS must point to this host; allow inbound TCP 80/443."
      echo "Configures a static site and automatic certificate renewal. Does not change APP/Console vhosts or existing VPN targets."
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "Run as root on the management host." >&2; exit 1; }
[ "${#domain}" -le 253 ] && printf '%s\n' "$domain" | LC_ALL=C grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' || { echo "Use a lowercase public hostname without URL, path or port." >&2; exit 2; }
printf '%s\n' "$email" | LC_ALL=C grep -Eq '^[a-zA-Z0-9._+%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$' || { echo "Provide a valid certificate contact email." >&2; exit 2; }
for tool in nginx certbot openssl curl flock systemctl docker; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing prerequisite: $tool. Install it with your host package manager before continuing." >&2; exit 1; }
done
nginx_bin=$(command -v nginx)
certbot_bin=$(command -v certbot)
case "$nginx_bin:$certbot_bin:$config_dir" in *[!a-zA-Z0-9_./:-]*) echo "Unsupported characters in executable/config paths." >&2; exit 2 ;; esac
[ -d "$config_dir" ] && [ -d /run/systemd/system ] || { echo "A systemd host and an existing Nginx include directory are required." >&2; exit 1; }
exec 9>/run/lock/northstar-reality-target.lock
flock -n 9 || { echo "Another target setup is running." >&2; exit 1; }
for key in APP_DOMAIN VEILBIRD_PORTAL_DOMAIN VEILBIRD_ADMIN_DOMAIN VEILBIRD_API_DOMAIN VEILBIRD_PUBLIC_ORIGIN VEILBIRD_API_ORIGIN VEILBIRD_AGENT_ORIGIN; do
  value=$(env_value "$key" | sed -e 's|^[a-z]*://||' -e 's|/.*$||' -e 's|:.*$||')
  [ "$domain" != "$value" ] || { echo "Use a dedicated domain, not the APP/Console/API hostname." >&2; exit 2; }
done

config="$config_dir/northstar-reality-target.conf"
marker="# Managed by Northstar REALITY target: $domain"
if [ -e "$config" ] && [ "$(head -n 1 "$config")" != "$marker" ]; then
  echo "Refusing to overwrite $config: it is unmanaged or belongs to a different domain. Existing nodes must be migrated explicitly." >&2; exit 1
fi
nginx -t
snapshot=$(mktemp -d /tmp/northstar-reality-setup.XXXXXX)
nginx -T >"$snapshot/nginx.txt" 2>&1
# Check the selected directory is really included by the active Nginx.
if ! awk -v wanted="$config_dir/*.conf;" '$1=="include" && $2==wanted {found=1} END {exit !found}' "$snapshot/nginx.txt"; then
  echo "$config_dir/*.conf is not included by active Nginx. Use --nginx-config-dir with the correct directory (including panel-managed installations)." >&2; exit 1
fi
if ! awk -v domain="$domain" -v own="$config:" '
  /^# configuration file / {file=$4}
  $1=="server_name" && file!=own {for(i=2;i<=NF;i++){gsub(/;/,"",$i);if($i==domain)found=1}}
  END {exit found ? 1 : 0}' "$snapshot/nginx.txt"; then
  echo "This domain already has another Nginx vhost; refusing to replace it." >&2; exit 1
fi
had_config=no
if [ -f "$config" ]; then cp -p "$config" "$snapshot/original.conf"; had_config=yes; fi
committed=no
changed=no
cleanup() {
  if [ "$committed" != yes ] && [ "$changed" = yes ]; then
    if [ "$had_config" = yes ]; then cp -p "$snapshot/original.conf" "$config"; else rm -f "$config"; fi
    nginx -t && nginx -s reload || true
    echo "Setup failed; the previous target vhost was restored. Diagnostics remain in $snapshot. Issued certificates are retained." >&2
  fi
}
trap cleanup EXIT
trap 'exit 1' INT TERM

compose up -d --build --no-deps reality-target
attempt=0
until curl -fsS --max-time 2 http://127.0.0.1:3300/health >/dev/null; do
  attempt=$((attempt + 1)); [ "$attempt" -lt 20 ] || { echo "Static target failed its health check." >&2; exit 1; }; sleep 2
done
mkdir -p /var/lib/northstar-reality-acme/.well-known/acme-challenge
write_http() {
  printf '%s\n' "$marker"
  cat <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $domain;
    location ^~ /.well-known/acme-challenge/ { root /var/lib/northstar-reality-acme; }
    location / { return 301 https://$domain\$request_uri; }
}
EOF
}
# Keep an existing HTTPS vhost available during certificate renewal.
if [ "$had_config" = no ]; then
  write_http >"$snapshot/candidate.conf"
  changed=yes
  cp "$snapshot/candidate.conf" "$config"
  nginx -t
  nginx -s reload
fi
cert_name="northstar-reality-$domain"
certbot certonly --non-interactive --agree-tos --email "$email" --webroot -w /var/lib/northstar-reality-acme --cert-name "$cert_name" -d "$domain" --keep-until-expiring --deploy-hook "$nginx_bin -t && $nginx_bin -s reload"
write_http >"$snapshot/candidate.conf"
cat >>"$snapshot/candidate.conf" <<EOF
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $domain;
    ssl_certificate /etc/letsencrypt/live/$cert_name/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$cert_name/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:NorthstarReality:1m;
    server_tokens off;
    auth_basic off;
    client_max_body_size 1k;
    client_header_timeout 10s;
    client_body_timeout 10s;
    access_log off;
    location / {
        limit_except GET HEAD { deny all; }
        proxy_pass http://127.0.0.1:3300;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header Cookie "";
        proxy_set_header Authorization "";
        proxy_set_header Host $domain;
        proxy_connect_timeout 3s;
        proxy_read_timeout 10s;
        proxy_hide_header Set-Cookie;
    }
}
EOF
changed=yes
cp "$snapshot/candidate.conf" "$config"
nginx -t
nginx -s reload
# Verify the local TLS termination, certificate hostname and ALPN, without relying on public NAT hairpin.
openssl s_client -connect 127.0.0.1:443 -servername "$domain" -verify_hostname "$domain" -verify_return_error -tls1_3 -alpn h2 </dev/null >"$snapshot/tls.txt" 2>&1
grep -q 'ALPN protocol: h2' "$snapshot/tls.txt" || { echo "Nginx did not negotiate HTTP/2." >&2; exit 1; }
curl -fsS --resolve "$domain:443:127.0.0.1" --max-time 10 "https://$domain/health" >/dev/null

unit=/etc/systemd/system/northstar-reality-renew.service
timer=/etc/systemd/system/northstar-reality-renew.timer
for file in "$unit" "$timer"; do
  if [ -e "$file" ] && [ "$(head -n 1 "$file")" != '# Managed by Northstar REALITY renewal' ]; then
    echo "Refusing to overwrite an unmanaged renewal unit: $file" >&2; exit 1
  fi
done
cat >"$unit" <<EOF
# Managed by Northstar REALITY renewal
[Unit]
Description=Renew the Northstar static-site certificate
[Service]
Type=oneshot
ExecStart=$certbot_bin renew --cert-name $cert_name --quiet
EOF
cat >"$timer" <<'EOF'
# Managed by Northstar REALITY renewal
[Unit]
Description=Check Northstar static-site certificate twice daily
[Timer]
OnCalendar=*-*-* 00,12:00:00
RandomizedDelaySec=3600
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now northstar-reality-renew.timer
committed=yes
echo "Ready: https://$domain — TLS 1.3 / HTTP/2 checked locally; automatic certificate renewal enabled."
echo "In Admin > VPN services > Default REALITY target, enter $domain and choose 检测并保存. Each VPN node also validates independently."
echo "Only the target vhost was changed. Existing nodes were NOT migrated. Setup diagnostics: $snapshot"
