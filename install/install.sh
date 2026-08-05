#!/usr/bin/env bash
#
# Hopper Panel installer.
#
#   bash install.sh
#
# Installs the panel, the daemon and their dependencies on a fresh machine, then
# leaves a reachable instance behind. Built for Debian 12+, Ubuntu 22.04+, Rocky
# and AlmaLinux 9+.
#
# The script is **interactive by default** but entirely drivable through
# environment variables, for an automated deployment:
#
#   HOPPER_DOMAIN=panel.example.com HOPPER_WEBSERVER=nginx HOPPER_TLS=yes \
#   HOPPER_ADMIN_EMAIL=me@example.com HOPPER_ADMIN_USERNAME=me \
#   HOPPER_NONINTERACTIVE=1 bash install.sh
#
# Rerunning the script on an existing installation updates the code without
# touching the database, the .env file or the vhosts already written.

set -euo pipefail

HOPPER_ROOT="${HOPPER_ROOT:-/opt/hopper}"
DATA_ROOT="${DATA_ROOT:-/var/lib/hopper}"
CONFIG_ROOT=/etc/hopper
PANEL_PORT="${HOPPER_PORT:-8080}"
DAEMON_PORT="${HOPPER_DAEMON_PORT:-8443}"
SFTP_PORT="${HOPPER_SFTP_PORT:-2022}"
REPOSITORY="${HOPPER_REPOSITORY:-https://github.com/hopper-panel/hopper.git}"
NODE_MAJOR=22

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; RED=$'\033[31m'
  YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; GREEN=''; RED=''; YELLOW=''; RESET=''
fi

step()  { printf '\n%s→ %s%s\n' "$BOLD" "$1" "$RESET"; }
info()  { printf '  %s\n' "$1"; }
note()  { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
good()  { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn()  { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()   { printf '\n%s✗ %s%s\n' "$RED" "$1" "$RESET" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------

[ "$(id -u)" -eq 0 ] || die "This script has to run as root: sudo bash install.sh"

# shellcheck disable=SC1091
[ -r /etc/os-release ] || die "/etc/os-release not found: unrecognised distribution."
. /etc/os-release

case "${ID:-} ${ID_LIKE:-}" in
  *debian*|*ubuntu*) FAMILY=debian ;;
  *rhel*|*fedora*|*centos*) FAMILY=rhel ;;
  *) die "Unsupported distribution: ${PRETTY_NAME:-unknown}. Debian, Ubuntu, Rocky and Alma are supported." ;;
esac

info "System: ${PRETTY_NAME:-$ID} ($FAMILY family)"

install_packages() {
  if [ "$FAMILY" = debian ]; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y "$@" >/dev/null
  else
    dnf install -y "$@" >/dev/null
  fi
}

# ---------------------------------------------------------------------------
# Questions
# ---------------------------------------------------------------------------

ask() {
  # $1 question, $2 default, $3 name of the variable to set
  local answer=''

  if [ -n "${HOPPER_NONINTERACTIVE:-}" ]; then
    answer="$2"
  else
    read -r -p "  $1 [$2] " answer </dev/tty || answer=''
    [ -n "$answer" ] || answer="$2"
  fi

  printf -v "$3" '%s' "$answer"
}

step "Configuration"

DOMAIN="${HOPPER_DOMAIN:-}"
if [ -z "$DOMAIN" ]; then
  ask "Domain name of the panel (or IP address)" "$(hostname -f 2>/dev/null || hostname)" DOMAIN
fi

# An IP address cannot receive a Let's Encrypt certificate: offering TLS in that
# case would lead the user straight into a certbot failure.
IS_IP=0
case "$DOMAIN" in
  *[!0-9.]*) ;;
  *) IS_IP=1 ;;
esac

WEBSERVER="${HOPPER_WEBSERVER:-}"
if [ -z "$WEBSERVER" ]; then
  ask "Web server (nginx / apache / none)" nginx WEBSERVER
fi

case "$WEBSERVER" in
  nginx|apache|none|aucun) ;;
  *) die "Unknown web server: $WEBSERVER (expected: nginx, apache or none)" ;;
esac
[ "$WEBSERVER" != aucun ] || WEBSERVER=none

TLS="${HOPPER_TLS:-}"
if [ -z "$TLS" ]; then
  if [ "$WEBSERVER" = none ] || [ "$IS_IP" = 1 ]; then
    TLS=no
  else
    ask "Obtain a Let's Encrypt certificate (yes/no)" yes TLS
  fi
fi

case "$TLS" in yes|y|oui|o) TLS=yes ;; *) TLS=no ;; esac

if [ "$TLS" = yes ] && [ "$IS_IP" = 1 ]; then
  warn "Let's Encrypt does not certify an IP address: installing over HTTP."
  TLS=no
fi

CERTBOT_EMAIL="${HOPPER_ADMIN_EMAIL:-}"
ADMIN_EMAIL="${HOPPER_ADMIN_EMAIL:-}"
[ -n "$ADMIN_EMAIL" ] || ask "Administrator email address" "admin@$DOMAIN" ADMIN_EMAIL
ADMIN_USERNAME="${HOPPER_ADMIN_USERNAME:-}"
[ -n "$ADMIN_USERNAME" ] || ask "Administrator username" admin ADMIN_USERNAME
[ -n "$CERTBOT_EMAIL" ] || CERTBOT_EMAIL="$ADMIN_EMAIL"

if [ "$WEBSERVER" = none ]; then
  APP_URL="http://$DOMAIN:$PANEL_PORT"
elif [ "$TLS" = yes ]; then
  APP_URL="https://$DOMAIN"
else
  APP_URL="http://$DOMAIN"
fi

# The daemon does not sit behind the proxy: it listens on its own port itself,
# with certbot's certificate when there is one.
if [ "$TLS" = yes ]; then NODE_SCHEME=https; else NODE_SCHEME=http; fi

info ""
info "Panel      : $APP_URL"
info "Web server : $WEBSERVER"
info "Daemon     : $NODE_SCHEME://$DOMAIN:$DAEMON_PORT"
info "SFTP       : $DOMAIN:$SFTP_PORT"

if [ -z "${HOPPER_NONINTERACTIVE:-}" ]; then
  ask "Continue? (yes/no)" yes CONFIRM
  case "$CONFIRM" in yes|y|oui|o) ;; *) die "Installation cancelled." ;; esac
fi

# ---------------------------------------------------------------------------
# System dependencies
# ---------------------------------------------------------------------------

step "System dependencies"

if [ "$FAMILY" = debian ]; then
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  install_packages ca-certificates curl gnupg git tar openssl
else
  install_packages ca-certificates curl gnupg git tar openssl
fi
good "base tools"

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]; then
  info "Installing Node $NODE_MAJOR…"
  if [ "$FAMILY" = debian ]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
    install_packages nodejs
  else
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
    install_packages nodejs
  fi
fi
good "Node $(node -v)"

if ! command -v pnpm >/dev/null 2>&1; then
  # `npm i -g` and not corepack: corepack downloads pnpm on first use, which
  # fails on a machine with no outbound access to the registry at the moment one
  # least expects it.
  npm install -g pnpm@10 >/dev/null
fi
good "pnpm $(pnpm --version)"

if ! command -v docker >/dev/null 2>&1; then
  info "Installing Docker…"
  curl -fsSL https://get.docker.com | sh >/dev/null
  systemctl enable --now docker >/dev/null 2>&1 || true
fi
good "Docker $(docker --version | cut -d' ' -f3 | tr -d ,)"

# ---------------------------------------------------------------------------
# PostgreSQL and Redis
# ---------------------------------------------------------------------------

step "Database"

if ! command -v psql >/dev/null 2>&1; then
  if [ "$FAMILY" = debian ]; then
    install_packages postgresql
  else
    install_packages postgresql-server postgresql
    [ -f /var/lib/pgsql/data/PG_VERSION ] || postgresql-setup --initdb >/dev/null
  fi
fi

systemctl enable --now postgresql >/dev/null 2>&1 || die "PostgreSQL did not start."

DB_NAME="${HOPPER_DB_NAME:-hopper}"
DB_USER="${HOPPER_DB_USER:-hopper}"
DB_PASSWORD="${HOPPER_DB_PASSWORD:-$(openssl rand -hex 24)}"

# The role already exists when the script is rerun: the password is left alone,
# otherwise the kept .env would point at a changed password.
if [ "$(su - postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'\"")" = 1 ]; then
  note "role $DB_USER already present, unchanged"
  DB_PASSWORD=''
else
  su - postgres -c "psql -q -c \"CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASSWORD'\"" >/dev/null
  good "role $DB_USER created"
fi

if [ "$(su - postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$DB_NAME'\"")" = 1 ]; then
  note "database $DB_NAME already present"
else
  su - postgres -c "createdb -O $DB_USER $DB_NAME" >/dev/null
  good "database $DB_NAME created"
fi

if ! command -v redis-server >/dev/null 2>&1 && ! command -v redis-cli >/dev/null 2>&1; then
  if [ "$FAMILY" = debian ]; then install_packages redis-server; else install_packages redis; fi
fi
systemctl enable --now redis-server >/dev/null 2>&1 || systemctl enable --now redis >/dev/null 2>&1 || true
good "Redis"

# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------

step "Sources"

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$SOURCE_DIR/pnpm-workspace.yaml" ] && [ "$SOURCE_DIR" != "$HOPPER_ROOT" ]; then
  info "Copying from $SOURCE_DIR"
  mkdir -p "$HOPPER_ROOT"
  tar -C "$SOURCE_DIR" \
    --exclude=node_modules --exclude=dist --exclude=.turbo --exclude=.git \
    -cf - . | tar -C "$HOPPER_ROOT" -xf -
elif [ -d "$HOPPER_ROOT/.git" ]; then
  info "Updating the existing repository"
  git -C "$HOPPER_ROOT" pull --ff-only
elif [ ! -f "$HOPPER_ROOT/pnpm-workspace.yaml" ]; then
  info "Cloning from $REPOSITORY"
  git clone --depth 1 "$REPOSITORY" "$HOPPER_ROOT"
fi
good "sources in $HOPPER_ROOT"

id hopper >/dev/null 2>&1 || useradd --system --home-dir "$HOPPER_ROOT" --shell /usr/sbin/nologin hopper
mkdir -p "$CONFIG_ROOT" "$DATA_ROOT/volumes" "$DATA_ROOT/backups"
chmod 700 "$CONFIG_ROOT"

step "Build"
note "A few minutes on a first installation."
cd "$HOPPER_ROOT"

# Without `CI`, pnpm refuses to purge a node_modules that has become
# inconsistent — which happens as soon as one updates from a version whose
# dependencies moved — and stops on "Aborted removal of modules directory due to
# no TTY". Errors stay visible: only the normal output is hidden.
export CI=true
pnpm install --frozen-lockfile --prod=false >/dev/null || pnpm install >/dev/null
pnpm --filter @hopper/shared build >/dev/null
pnpm --filter @hopper/templates build >/dev/null 2>&1 || true
pnpm --filter @hopper/panel exec prisma generate >/dev/null
pnpm --filter @hopper/panel build >/dev/null
pnpm --filter @hopper/web build >/dev/null
pnpm --filter @hopper/daemon build >/dev/null
good "panel, interface and daemon built"

# ---------------------------------------------------------------------------
# Panel configuration
# ---------------------------------------------------------------------------

step "Panel configuration"

ENV_FILE="$HOPPER_ROOT/apps/panel/.env"

if [ -f "$ENV_FILE" ]; then
  note ".env already present, kept"
else
  [ -n "$DB_PASSWORD" ] || die "The PostgreSQL role already existed but its password is unknown: set DATABASE_URL in $ENV_FILE then rerun."

  cat > "$ENV_FILE" <<EOF
# Generated by install.sh on $(date -Iseconds).
#
# APP_SECRET encrypts the node tokens, the SQL passwords and the two-factor
# secrets. Changing it makes all of them unreadable: back this file up along
# with the database.
NODE_ENV=production

APP_URL=$APP_URL
HOST=127.0.0.1
PORT=$PANEL_PORT

APP_SECRET=$(openssl rand -base64 48 | tr -d '\n')

DATABASE_URL=postgresql://$DB_USER:$DB_PASSWORD@127.0.0.1:5432/$DB_NAME
REDIS_URL=redis://127.0.0.1:6379
EOF

  # The panel listens on the loopback when a proxy sits in front, and on every
  # interface otherwise — without which it would be reachable from nowhere.
  [ "$WEBSERVER" != none ] || sed -i 's/^HOST=.*/HOST=0.0.0.0/' "$ENV_FILE"

  good ".env written"
fi

# Outside the creation block: a .env left world-readable by an earlier
# installation exposes APP_SECRET and the database password to any account on
# the machine.
chmod 600 "$ENV_FILE"

step "Database migration"
cd "$HOPPER_ROOT/apps/panel"
pnpm exec prisma migrate deploy >/dev/null
good "schema up to date"

ADMIN_PASSWORD="${HOPPER_ADMIN_PASSWORD:-$(openssl rand -base64 18 | tr -d '\n/+=' | cut -c1-20)}"
ADMIN_CREATED=0

# The seed writes to a file that is searched afterwards, and is never piped
# into `grep -q`. Piping looks equivalent and is not: grep exits at the first
# match, the seed dies of SIGPIPE on its next write, and `pipefail` turns that
# into a failed pipeline (status 141). The installer read that as "an
# administrator already exists", so a fresh installation never printed the
# generated password — an instance nobody could sign in to, reported as a
# success.
SEED_LOG=/tmp/hopper-seed.log
SEED_STATUS=0

HOPPER_ADMIN_EMAIL="$ADMIN_EMAIL" HOPPER_ADMIN_USERNAME="$ADMIN_USERNAME" \
  HOPPER_ADMIN_PASSWORD="$ADMIN_PASSWORD" pnpm exec prisma db seed \
  >"$SEED_LOG" 2>&1 || SEED_STATUS=$?

if grep -q 'HOPPER_SEED_ADMIN_CREATED=1' "$SEED_LOG"; then
  ADMIN_CREATED=1
  good "administrator account created"
elif [ "$SEED_STATUS" -ne 0 ]; then
  # Without this branch a seed that genuinely failed was announced as "already
  # present" and the installation carried on, leaving no administrator at all.
  sed 's/^/    /' "$SEED_LOG" >&2
  die "the seed failed (status $SEED_STATUS) — full output in $SEED_LOG"
else
  note "administrator account already present, unchanged"
fi

# Last: the migration and the seed run as root and drop cache files into
# node_modules. Leaving them owned by root would make the panel fail, since it
# runs under the hopper account.
chown -R hopper:hopper "$HOPPER_ROOT"

# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------

step "systemd services"

install -m 644 "$HOPPER_ROOT/install/hopper-panel.service" /etc/systemd/system/hopper-panel.service
install -m 644 "$HOPPER_ROOT/install/hopperd.service" /etc/systemd/system/hopperd.service
install -m 755 "$HOPPER_ROOT/install/hopper" /usr/local/bin/hopper

# The update button in the administration writes a file here; the path unit
# below turns that into a root-run update. The directory belongs to the panel's
# account because the panel is what creates the trigger — and to nothing else,
# because anyone who can write here can start an update.
install -d -o hopper -g hopper -m 700 "$DATA_ROOT/updates"
install -m 644 "$HOPPER_ROOT/install/hopper-update.service" /etc/systemd/system/hopper-update.service
install -m 644 "$HOPPER_ROOT/install/hopper-update.path" /etc/systemd/system/hopper-update.path
systemctl daemon-reload

# `enable --now` starts a stopped service and leaves a running one alone, which
# made the script useless as the updater it advertises: the files on disk were
# new, the process serving them was not.
#
# The interface made it visible. Vite stamps a digest into every asset name, and
# @fastify/static registers one route per file present when it starts. After an
# update the panel still answered for the previous names while the freshly built
# index.html asked for the new ones — so every asset fell through to the SPA
# fallback and came back as index.html. The browser received HTML where it
# expected JavaScript, and the panel showed a blank page.
systemctl enable hopper-panel >/dev/null
systemctl restart hopper-panel
good "hopper-panel"

# The local node is declared from the command line: on a single machine,
# demanding a trip through the interface before anything works at all would gain
# nothing.
if [ ! -f "$CONFIG_ROOT/daemon.yml" ]; then
  MEMORY_BYTES=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) * 1024 ))
  DISK_BYTES=$(df -B1 --output=size "$DATA_ROOT" | tail -1 | tr -d ' ')

  HOPPER_ROOT="$HOPPER_ROOT" hopper node:create \
    --name "$(hostname -s)" --fqdn "$DOMAIN" --scheme "$NODE_SCHEME" \
    --port "$DAEMON_PORT" --sftp-port "$SFTP_PORT" \
    --memory "$MEMORY_BYTES" --disk "$DISK_BYTES" \
    --output "$CONFIG_ROOT/daemon.yml" >/dev/null
  good "local node declared"
else
  note "daemon.yml already present, kept"
fi

systemctl enable hopperd >/dev/null
systemctl restart hopperd
good "hopperd"

# Not `restart`: this unit is a watcher, and restarting it while it is being
# triggered by the very update running right now would cut that update short.
systemctl enable hopper-update.path >/dev/null
systemctl start hopper-update.path >/dev/null 2>&1 || true
good "update watcher"

# ---------------------------------------------------------------------------
# Web server
# ---------------------------------------------------------------------------

write_vhost() {
  # $1 destination file, $2 template, $3 certificate path, $4 key
  sed -e "s|{{DOMAIN}}|$DOMAIN|g" -e "s|{{PORT}}|$PANEL_PORT|g" \
      -e "s|{{CERT}}|$3|g" -e "s|{{KEY}}|$4|g" "$2" > "$1"
}

write_plain_vhost() {
  # HTTP-only vhost: it doubles as the holding configuration while certbot
  # validates the domain, since validation goes through port 80.
  if [ "$WEBSERVER" = nginx ]; then
    cat > "$1" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/ { root /var/www/html; }

    client_max_body_size 1024m;
    client_body_timeout 300s;
    proxy_read_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:$PANEL_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF
  else
    cat > "$1" <<EOF
<VirtualHost *:80>
    ServerName $DOMAIN

    Alias /.well-known/acme-challenge/ /var/www/html/.well-known/acme-challenge/
    <Directory /var/www/html/.well-known/acme-challenge/>
        Require all granted
    </Directory>

    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteRule ^/?(.*) ws://127.0.0.1:$PANEL_PORT/\$1 [P,L]

    ProxyPreserveHost On
    ProxyPass        /.well-known/acme-challenge/ !
    ProxyPass        / http://127.0.0.1:$PANEL_PORT/
    ProxyPassReverse / http://127.0.0.1:$PANEL_PORT/
    ProxyTimeout 300
</VirtualHost>
EOF
  fi
}

if [ "$WEBSERVER" != none ]; then
  step "Web server ($WEBSERVER)"

  if [ "$WEBSERVER" = nginx ]; then
    command -v nginx >/dev/null 2>&1 || install_packages nginx

    if [ -d /etc/nginx/sites-available ]; then
      VHOST=/etc/nginx/sites-available/hopper.conf
      ln -sf "$VHOST" /etc/nginx/sites-enabled/hopper.conf
      rm -f /etc/nginx/sites-enabled/default
    else
      VHOST=/etc/nginx/conf.d/hopper.conf
    fi

    RELOAD='systemctl reload nginx'
    TEST='nginx -t'
    SERVICE=nginx
  else
    if [ "$FAMILY" = debian ]; then
      command -v apache2 >/dev/null 2>&1 || install_packages apache2
      a2enmod proxy proxy_http proxy_wstunnel rewrite headers ssl >/dev/null
      a2dissite 000-default >/dev/null 2>&1 || true
      VHOST=/etc/apache2/sites-available/hopper.conf
      SERVICE=apache2
    else
      command -v httpd >/dev/null 2>&1 || install_packages httpd mod_ssl
      VHOST=/etc/httpd/conf.d/hopper.conf
      SERVICE=httpd
    fi

    RELOAD="systemctl reload $SERVICE"
    TEST="apachectl configtest"
  fi

  mkdir -p /var/www/html

  if [ -f "$VHOST" ] && [ -z "${HOPPER_FORCE_VHOST:-}" ]; then
    note "vhost already present, kept ($VHOST)"
  else
    write_plain_vhost "$VHOST"
    [ "$WEBSERVER" != apache ] || [ "$FAMILY" != debian ] || a2ensite hopper >/dev/null
    systemctl enable --now "$SERVICE" >/dev/null
    $TEST >/dev/null 2>&1 || die "Invalid $WEBSERVER configuration: $TEST"
    $RELOAD
    good "HTTP vhost in place"

    if [ "$TLS" = yes ]; then
      command -v certbot >/dev/null 2>&1 || install_packages certbot

      if certbot certonly --webroot -w /var/www/html -d "$DOMAIN" \
           --non-interactive --agree-tos -m "$CERTBOT_EMAIL" >/dev/null 2>&1; then
        CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
        KEY="/etc/letsencrypt/live/$DOMAIN/privkey.pem"

        if [ "$WEBSERVER" = nginx ]; then
          write_vhost "$VHOST" "$HOPPER_ROOT/install/nginx.conf.tmpl" "$CERT" "$KEY"
        else
          write_vhost "$VHOST" "$HOPPER_ROOT/install/apache.conf.tmpl" "$CERT" "$KEY"
        fi

        $TEST >/dev/null 2>&1 || die "Invalid $WEBSERVER configuration after adding the certificate."
        $RELOAD
        good "certificate obtained, HTTPS active"

        # The daemon reads the same certificates: it runs as root and can
        # therefore open /etc/letsencrypt. A reload after renewal is needed,
        # hence this hook.
        mkdir -p /etc/letsencrypt/renewal-hooks/deploy
        cat > /etc/letsencrypt/renewal-hooks/deploy/hopper.sh <<'EOF'
#!/bin/sh
# The daemon has held the certificate in memory since it started: without this
# restart it would keep presenting the old one after renewal.
systemctl restart hopperd
EOF
        chmod 755 /etc/letsencrypt/renewal-hooks/deploy/hopper.sh
      else
        warn "certbot failed — the installation stays on HTTP."
        warn "Check that $DOMAIN points at this machine and that port 80 is open."
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Local policies
# ---------------------------------------------------------------------------

if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" = Enforcing ]; then
  step "SELinux"
  # Without this boolean, httpd and nginx are refused the connection to the
  # panel: the proxy answers 503 and nothing in their logs explains it.
  setsebool -P httpd_can_network_connect 1 >/dev/null 2>&1 && good "outbound connections allowed for the web server"     || warn "could not set httpd_can_network_connect: the proxy will answer 503."
fi

if systemctl is-active --quiet firewalld 2>/dev/null; then
  step "Firewall"
  for PORT in 80/tcp 443/tcp "$DAEMON_PORT/tcp" "$SFTP_PORT/tcp"; do
    firewall-cmd --permanent --add-port="$PORT" >/dev/null 2>&1 || true
  done
  firewall-cmd --reload >/dev/null 2>&1 || true
  good "ports 80, 443, $DAEMON_PORT and $SFTP_PORT opened"
  note "The ports of your Minecraft servers still have to be opened."
fi

# ---------------------------------------------------------------------------
# Diagnostic and summary
# ---------------------------------------------------------------------------

step "Verification"
sleep 3
HOPPER_ROOT="$HOPPER_ROOT" hopper doctor || true

step "Done"
info "Panel      : $APP_URL"

if [ "$ADMIN_CREATED" = 1 ]; then
  info "Username   : $ADMIN_USERNAME"
  info "Password   : $ADMIN_PASSWORD"
  note "Write it down: it is not kept in the clear."
fi

info ""
note "Logs       : journalctl -u hopper-panel -f   /   journalctl -u hopperd -f"
note "Diagnostic : hopper doctor"
note "Update     : bash $HOPPER_ROOT/install/install.sh"
info ""
warn "Open ports $DAEMON_PORT (daemon), $SFTP_PORT (SFTP) and those of your servers."
warn "Filter with DOCKER-USER and not ufw: Docker writes its rules before ufw's."
