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
# Everything it needs to know is asked **before it writes anything**, and every
# answer can be given as an environment variable instead, for an automated
# deployment:
#
#   HOPPER_DOMAIN=panel.example.com HOPPER_WEBSERVER=nginx HOPPER_TLS=yes \
#   HOPPER_ADMIN_EMAIL=me@example.com HOPPER_ADMIN_USERNAME=me \
#   HOPPER_PANEL_NAME="My panel" HOPPER_LOCALE=fr HOPPER_TIMEZONE=Europe/Paris \
#   HOPPER_NONINTERACTIVE=1 bash install.sh
#
# Rerunning the script on an existing installation updates the code without
# touching the database, the .env file or the vhosts already written — and every
# question is asked again with the current answer offered as the default, so a
# rerun that changes nothing is a matter of pressing Enter.

# Re-exec under bash when started by something else.
#
# `sh install.sh` is a natural thing to type and every page here says `bash`,
# which is exactly the kind of instruction that gets half-followed. On Debian
# `sh` is dash: it would run most of this file and mangle the rest, starting
# with `$'[1m'`, which it leaves as literal text and turns every heading
# into escape codes. Reported against `uninstall.sh` by an operator who typed
# `sh`; the same trap was here.
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi

set -euo pipefail

HOPPER_ROOT="${HOPPER_ROOT:-/opt/hopper}"
DATA_ROOT="${DATA_ROOT:-/var/lib/hopper}"
CONFIG_ROOT=/etc/hopper
PANEL_PORT="${HOPPER_PORT:-8080}"
DAEMON_PORT="${HOPPER_DAEMON_PORT:-8443}"
SFTP_PORT="${HOPPER_SFTP_PORT:-2022}"
REPOSITORY="${HOPPER_REPOSITORY:-https://github.com/hopper-panel/hopper.git}"
NODE_MAJOR=22

DB_NAME="${HOPPER_DB_NAME:-hopper}"
DB_USER="${HOPPER_DB_USER:-hopper}"

ENV_FILE="$HOPPER_ROOT/apps/panel/.env"
DAEMON_FILE="$CONFIG_ROOT/daemon.yml"

# The interface languages. Adding one here without adding it to the panel's
# catalogue would offer an operator a language nothing is written in.
LOCALES="en fr es de ru"

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

# Two columns, so a recap of a dozen answers can be read down the left edge.
pair()  { printf '  %-22s %s\n' "$1" "$2"; }

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

install_packages() {
  if [ "$FAMILY" = debian ]; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y "$@" >/dev/null
  else
    dnf install -y "$@" >/dev/null
  fi
}

# ---------------------------------------------------------------------------
# What is already here
#
# Read before a single question is asked, because every question is better with
# the current answer in front of it. A rerun that used to propose
# `hostname -f` while the panel had been answering on a LAN address for weeks
# invited the operator to change the address by accident — and the one
# reinstall that genuinely means to change it looks exactly the same from here.
# ---------------------------------------------------------------------------

FRESH=1
[ ! -f "$ENV_FILE" ] || FRESH=0

CURRENT_URL=''
[ ! -f "$ENV_FILE" ] || CURRENT_URL=$(sed -n 's/^APP_URL=//p' "$ENV_FILE" | head -1)

# The host part of whatever the panel currently answers on, so the address
# question can offer it back without its scheme.
CURRENT_DOMAIN="${CURRENT_URL#http://}"
CURRENT_DOMAIN="${CURRENT_DOMAIN#https://}"
CURRENT_DOMAIN="${CURRENT_DOMAIN%%[:/]*}"

# One setting out of the database, or nothing at all. Everything here has to
# survive a machine where PostgreSQL is not installed yet, which is the normal
# state of a first installation.
db_setting() {
  command -v psql >/dev/null 2>&1 || return 0
  su - postgres -c "psql -tAq -d $DB_NAME -c \"select value from settings where key = '$1'\"" \
    2>/dev/null | head -1
}

CURRENT_PANEL_NAME=$(db_setting panelName || true)
CURRENT_LOCALE=$(db_setting defaultLocale || true)

# The timezone the servers are already running in. It lives on the node row and
# is copied into daemon.yml every time that file is written, so the file is the
# cheaper place to read it — no database, no build, and it is the value the
# containers actually got.
CURRENT_TIMEZONE=''
if [ -f "$DAEMON_FILE" ]; then
  CURRENT_TIMEZONE=$(sed -n 's/^[[:space:]]*timezone:[[:space:]]*//p' "$DAEMON_FILE" | head -1)
fi

# What the machine itself is set to, which is the best guess nobody has to type.
HOST_TIMEZONE=UTC
if command -v timedatectl >/dev/null 2>&1; then
  HOST_TIMEZONE=$(timedatectl show -p Timezone --value 2>/dev/null || echo UTC)
elif [ -L /etc/localtime ]; then
  HOST_TIMEZONE=$(readlink -f /etc/localtime | sed 's|.*/zoneinfo/||')
fi
[ -n "$HOST_TIMEZONE" ] || HOST_TIMEZONE=UTC

# The web server already in front of the panel, if there is one.
CURRENT_WEBSERVER=''
if [ -f /etc/nginx/sites-available/hopper.conf ] || [ -f /etc/nginx/conf.d/hopper.conf ]; then
  CURRENT_WEBSERVER=nginx
elif [ -f /etc/apache2/sites-available/hopper.conf ] || [ -f /etc/httpd/conf.d/hopper.conf ]; then
  CURRENT_WEBSERVER=apache
elif [ "$FRESH" = 0 ]; then
  CURRENT_WEBSERVER=none
fi

# ---------------------------------------------------------------------------
# The interview
#
# Everything is asked here, and nothing outside this section asks anything. The
# script used to interleave questions with work — install packages, ask, build
# for four minutes, ask again — which meant an operator had to sit through a
# build to find out the next question, and a wrong answer was discovered after
# the machine had already been changed.
# ---------------------------------------------------------------------------

ask() {
  # $1 question, $2 default, $3 name of the variable to set
  #
  # The locals are named `__like_this` throughout this section because bash
  # scopes them dynamically: a local called `answer` here would shadow the
  # caller's own `answer`, and `printf -v answer` would then assign to this
  # function's copy and return nothing. `ask_yes_no` reads exactly like that,
  # and it is a silent failure — every question answers "no".
  local __value=''

  if [ -n "${HOPPER_NONINTERACTIVE:-}" ]; then
    __value="$2"
  else
    read -r -p "  $1 [$2] " __value </dev/tty || __value=''
    [ -n "$__value" ] || __value="$2"
  fi

  printf -v "$3" '%s' "$__value"
}

# A question whose answer has to be one of a list, asked again until it is.
#
# The old script accepted anything and died several lines later with
# "Unknown web server: ngnix" — after the confirmation, which is the worst
# possible moment to find out that a typo has cost the whole run.
ask_choice() {
  # $1 question, $2 default, $3 variable, $4… allowed values
  local __question="$1" __default="$2" __name="$3" __choice='' __candidate
  shift 3

  while true; do
    ask "$__question ($(printf '%s/' "$@" | sed 's|/$||'))" "$__default" __choice

    for __candidate in "$@"; do
      if [ "$__choice" = "$__candidate" ]; then
        printf -v "$__name" '%s' "$__choice"
        return 0
      fi
    done

    # A script cannot be asked again: a wrong value in the environment is a
    # mistake in whatever generated it, and looping would hang a deployment.
    [ -z "${HOPPER_NONINTERACTIVE:-}" ] ||
      die "$__name: \"$__choice\" is not one of $*."

    warn "\"$__choice\" is not one of $*."
  done
}

yes_no() {
  # Reads yes/oui/y/o as yes and everything else as no.
  case "$1" in yes|y|oui|o|true|1) return 0 ;; *) return 1 ;; esac
}

ask_yes_no() {
  # $1 question, $2 default (yes/no), $3 variable
  local __yn=''
  ask_choice "$1" "$2" __yn yes no y n oui non o
  if yes_no "$__yn"; then printf -v "$3" '%s' yes; else printf -v "$3" '%s' no; fi
}

step "Configuration"
info "${PRETTY_NAME:-$ID} · $FAMILY family"

if [ "$FRESH" = 0 ]; then
  note "An installation is already here — every answer defaults to the current one."
fi

info ""

# --- Where the panel answers ------------------------------------------------

DOMAIN="${HOPPER_DOMAIN:-}"
if [ -z "$DOMAIN" ]; then
  ask "Domain name of the panel (or IP address)" \
    "${CURRENT_DOMAIN:-$(hostname -f 2>/dev/null || hostname)}" DOMAIN
fi

# A host name, whatever was typed. People paste URLs.
#
# `http://192.168.1.141/` travelled through this script untouched and broke
# three things at once, none of them near the question that produced it:
#
#   - `APP_URL` became `http://192.168.1.141/`, which the daemon copies into
#     its allowed origins — and a browser's `Origin` header never carries a
#     trailing slash, so every console was refused with "Origin not allowed".
#   - `server_name 192.168.1.141/;` is not a host nginx will ever match.
#   - `IS_IP` below tests for characters outside `[0-9.]`, so the slash made an
#     IP address look like a domain name, and the script offered a Let's
#     Encrypt certificate that could only fail.
#
# Trimmed rather than refused: the answer is unambiguous, and sending somebody
# back to retype an address because of a slash is the kind of strictness that
# teaches nothing.
ORIGINAL_DOMAIN="$DOMAIN"
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN%%/*}"
DOMAIN="$(printf '%s' "$DOMAIN" | tr -d '[:space:]')"

[ -n "$DOMAIN" ] || die "The panel needs a domain name or an IP address."
[ "$DOMAIN" = "$ORIGINAL_DOMAIN" ] || note "domain read as $DOMAIN"

# An IP address cannot receive a Let's Encrypt certificate: offering TLS in that
# case would lead the user straight into a certbot failure.
IS_IP=0
case "$DOMAIN" in
  *[!0-9.]*) ;;
  *) IS_IP=1 ;;
esac

WEBSERVER="${HOPPER_WEBSERVER:-}"
if [ -z "$WEBSERVER" ]; then
  ask_choice "Web server in front of the panel" "${CURRENT_WEBSERVER:-nginx}" \
    WEBSERVER nginx apache none
fi

case "$WEBSERVER" in
  nginx|apache|none) ;;
  aucun) WEBSERVER=none ;;
  *) die "Unknown web server: $WEBSERVER (expected: nginx, apache or none)" ;;
esac

TLS="${HOPPER_TLS:-}"
if [ -z "$TLS" ]; then
  if [ "$WEBSERVER" = none ] || [ "$IS_IP" = 1 ]; then
    TLS=no
  else
    ask_yes_no "Obtain a Let's Encrypt certificate" yes TLS
  fi
fi

if yes_no "$TLS"; then TLS=yes; else TLS=no; fi

if [ "$TLS" = yes ] && [ "$IS_IP" = 1 ]; then
  warn "Let's Encrypt does not certify an IP address: installing over HTTP."
  TLS=no
fi

# --- Who runs it ------------------------------------------------------------

ADMIN_EMAIL="${HOPPER_ADMIN_EMAIL:-}"
[ -n "$ADMIN_EMAIL" ] || ask "Administrator email address" "admin@$DOMAIN" ADMIN_EMAIL
ADMIN_USERNAME="${HOPPER_ADMIN_USERNAME:-}"
[ -n "$ADMIN_USERNAME" ] || ask "Administrator username" admin ADMIN_USERNAME
CERTBOT_EMAIL="${HOPPER_CERTBOT_EMAIL:-$ADMIN_EMAIL}"

# --- What it looks like -----------------------------------------------------

PANEL_NAME="${HOPPER_PANEL_NAME:-}"
if [ -z "$PANEL_NAME" ]; then
  ask "Name of this panel" "${CURRENT_PANEL_NAME:-Hopper}" PANEL_NAME
fi
[ -n "$PANEL_NAME" ] || die "The panel needs a name."

LOCALE="${HOPPER_LOCALE:-}"
if [ -z "$LOCALE" ]; then
  # The language everybody who has not chosen one is served. Every operator
  # until now landed in English on a panel they had installed in one command,
  # and had to find the setting to change it — in English.
  # shellcheck disable=SC2086
  ask_choice "Language of the interface" "${CURRENT_LOCALE:-en}" LOCALE $LOCALES
fi

# --- What time it is --------------------------------------------------------

# The timezone the game servers run in, which is what stamps the time on every
# line of their logs. The daemon has always read it and defaulted it to UTC;
# nothing ever asked, so every installation ran on UTC and every operator
# outside it read their own logs offset by their own longitude.
TIMEZONE="${HOPPER_TIMEZONE:-}"
if [ -z "$TIMEZONE" ]; then
  ask "Timezone of the servers" "${CURRENT_TIMEZONE:-$HOST_TIMEZONE}" TIMEZONE
fi

while [ ! -f "/usr/share/zoneinfo/$TIMEZONE" ]; do
  # Checked against this machine's own tz database, because that is the one the
  # containers will use. An unknown name is not an error where it lands: the
  # container silently falls back to UTC, which is exactly what the answer was
  # meant to change.
  [ -z "${HOPPER_NONINTERACTIVE:-}" ] ||
    die "Unknown timezone: $TIMEZONE (expected an IANA name such as Europe/Paris)."

  warn "This machine does not know the timezone \"$TIMEZONE\"."
  note "IANA names, as in Europe/Paris, America/New_York, UTC."
  ask "Timezone of the servers" "$HOST_TIMEZONE" TIMEZONE
done

# Offering to move the machine's own clock, and only offering.
#
# Default yes when the host is still on UTC — nobody chooses UTC on a machine
# they run games on, it is what an untouched installation says — and no when it
# is set to anything else, which somebody did on purpose.
SET_HOST_TIMEZONE=no
if [ "$HOST_TIMEZONE" != "$TIMEZONE" ] && command -v timedatectl >/dev/null 2>&1; then
  SUGGEST=no
  [ "$HOST_TIMEZONE" != UTC ] || SUGGEST=yes

  SET_HOST_TIMEZONE="${HOPPER_SET_HOST_TIMEZONE:-}"
  if [ -z "$SET_HOST_TIMEZONE" ]; then
    ask_yes_no "This machine's clock is on $HOST_TIMEZONE — set it to $TIMEZONE too" \
      "$SUGGEST" SET_HOST_TIMEZONE
  fi

  if yes_no "$SET_HOST_TIMEZONE"; then SET_HOST_TIMEZONE=yes; else SET_HOST_TIMEZONE=no; fi
fi

# --- What all that adds up to ----------------------------------------------

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
pair "Panel" "$APP_URL"
pair "Name" "$PANEL_NAME"
pair "Language" "$LOCALE"
pair "Web server" "$WEBSERVER$([ "$TLS" = yes ] && echo ' · Let’s Encrypt' || true)"
pair "Daemon" "$NODE_SCHEME://$DOMAIN:$DAEMON_PORT"
pair "SFTP" "$DOMAIN:$SFTP_PORT"
pair "Servers' timezone" "$TIMEZONE$([ "$SET_HOST_TIMEZONE" = yes ] && echo ' · this machine too' || true)"
pair "Administrator" "$ADMIN_USERNAME <$ADMIN_EMAIL>"
pair "Installed in" "$HOPPER_ROOT"
info ""

if [ -z "${HOPPER_NONINTERACTIVE:-}" ]; then
  ask_yes_no "Continue" yes CONFIRM
  yes_no "$CONFIRM" || die "Installation cancelled."
fi

# A way to see the answers without living with them.
#
# `bash install.sh --check` reaches exactly this line and stops: nothing above
# it writes anything, which is the property the rest of this file depends on
# and the reason the questions were gathered here in the first place. It is
# also what lets the interview be tested — every branch of it, on a machine
# nobody has to rebuild afterwards.
if [ -n "${HOPPER_INTERVIEW_ONLY:-}" ] || [ "${1:-}" = --check ]; then
  note "Answers only: nothing on this machine has been changed."
  exit 0
fi

note "Nothing else will be asked."

# ---------------------------------------------------------------------------
# System dependencies
# ---------------------------------------------------------------------------

step "System dependencies"

if [ "$FAMILY" = debian ]; then
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
fi
install_packages ca-certificates curl gnupg git tar openssl
good "base tools"

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]; then
  info "Installing Node $NODE_MAJOR…"
  if [ "$FAMILY" = debian ]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  else
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  fi
  install_packages nodejs
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

if [ "$SET_HOST_TIMEZONE" = yes ]; then
  timedatectl set-timezone "$TIMEZONE" >/dev/null 2>&1 &&
    good "machine clock on $TIMEZONE" ||
    warn "could not set this machine's clock to $TIMEZONE."
fi

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

# The commit that was installed, recorded because the answer is not readable
# afterwards: the copy above deliberately leaves `.git` behind, so $HOPPER_ROOT
# is not a checkout and nothing there can say which revision it holds. The
# administration reads this file to tell an operator whether they are behind.
if [ -d "$SOURCE_DIR/.git" ]; then
  git -C "$SOURCE_DIR" rev-parse HEAD > "$HOPPER_ROOT/.hopper-commit" 2>/dev/null || true
elif [ -d "$HOPPER_ROOT/.git" ]; then
  git -C "$HOPPER_ROOT" rev-parse HEAD > "$HOPPER_ROOT/.hopper-commit" 2>/dev/null || true
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

if [ -f "$ENV_FILE" ]; then
  # Kept, because `APP_SECRET` lives in it and encrypts the node tokens, the
  # SQL passwords and the two-factor secrets: rewriting the file would make
  # every one of them unreadable.
  #
  # **Except the two lines that say where this installation answers.** Those
  # are exactly what a rerun with a different answer is meant to change, and
  # keeping them turned this script into a liar: it printed
  # `Panel : http://192.168.1.141` from the answers just given, wrote nothing,
  # and left the panel on the address typed months earlier. Reported by an
  # operator who reinstalled onto his LAN address three times and kept landing
  # on the default nginx page — the vhost below had the same problem.

  # The panel listens on the loopback when a proxy sits in front of it, and on
  # every interface otherwise — without which it would be reachable from
  # nowhere. That answer can change on a rerun too.
  WANTED_HOST=127.0.0.1
  [ "$WEBSERVER" != none ] || WANTED_HOST=0.0.0.0

  if [ "$CURRENT_URL" = "$APP_URL" ]; then
    note ".env already present, kept"
  else
    sed -i "s|^APP_URL=.*|APP_URL=$APP_URL|" "$ENV_FILE"
    good ".env kept, address updated: ${CURRENT_URL:-unset} → $APP_URL"
  fi

  sed -i "s|^HOST=.*|HOST=$WANTED_HOST|" "$ENV_FILE"
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

# The units name the interpreter absolutely — systemd resolves no PATH — and
# /usr/bin/node is where it happens to sit on the machines this was written on.
# Elsewhere, including on a GitHub runner, the service dies with 203/EXEC and a
# journal that says nothing about why.
NODE_BIN="$(command -v node)"
[ -x "$NODE_BIN" ] || die "node not found after installing it, which should not be possible."

sed "s|{{NODE}}|$NODE_BIN|" "$HOPPER_ROOT/install/hopper-panel.service" > /etc/systemd/system/hopper-panel.service
sed "s|{{NODE}}|$NODE_BIN|" "$HOPPER_ROOT/install/hopperd.service" > /etc/systemd/system/hopperd.service
chmod 644 /etc/systemd/system/hopper-panel.service /etc/systemd/system/hopperd.service
install -m 755 "$HOPPER_ROOT/install/hopper" /usr/local/bin/hopper

# The update button in the administration writes a file here; the path unit
# below turns that into a root-run update. The directory belongs to the panel's
# account because the panel is what creates the trigger — and to nothing else,
# because anyone who can write here can start an update.
install -d -o hopper -g hopper -m 700 "$DATA_ROOT/updates"
install -m 644 "$HOPPER_ROOT/install/hopper-update.service" /etc/systemd/system/hopper-update.service
install -m 644 "$HOPPER_ROOT/install/hopper-update.path" /etc/systemd/system/hopper-update.path

# The same arrangement for a node's own configuration: the panel asks, a root
# unit writes `/etc/hopper/daemon.yml` in mode 600 and restarts hopperd. What
# it replaces is a screen telling the operator to copy a document, chmod it and
# restart a service by hand — three steps, of which the middle one produces a
# daemon that refuses to start and a panel that reports the node as merely
# unreachable.
#
# Its spool is created here for the same reason the updater's is, and the first
# release shipped without this line: /var/lib/hopper belongs to root, so the
# panel — which runs as `hopper` — could not create the directory it was about
# to write into. The units were installed, the button was offered, and pressing
# it answered "Internal server error" with nothing in it to act on.
install -d -o hopper -g hopper -m 700 "$DATA_ROOT/node-apply"
install -m 644 "$HOPPER_ROOT/install/hopper-node-apply.service" /etc/systemd/system/hopper-node-apply.service
install -m 644 "$HOPPER_ROOT/install/hopper-node-apply.path" /etc/systemd/system/hopper-node-apply.path

systemctl daemon-reload

# The answers that live in the database, written before the panel is started so
# that it reads them on the way up: the settings are cached in the process, and
# a value written underneath a running panel is served from the next restart.
step "Panel settings"

hopper_cli() { HOPPER_ROOT="$HOPPER_ROOT" hopper "$@"; }

hopper_cli settings:set --key panelName --value "$PANEL_NAME" >/dev/null
hopper_cli settings:set --key defaultLocale --value "$LOCALE" >/dev/null
good "name \"$PANEL_NAME\", language $LOCALE"

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

  # Kept when it already answers for this domain, rewritten when it does not.
  #
  # A vhost naming the previous address is not a harmless leftover: nginx has
  # no server matching the `Host` header the operator is now typing, falls back
  # to its default site, and serves the "Welcome to nginx!" page. The
  # installation is fine and looks broken, which is the worst way to end a
  # rerun that was performed precisely to change the address.
  if
    [ -f "$VHOST" ] && [ -z "${HOPPER_FORCE_VHOST:-}" ] &&
      grep -E '^[[:space:]]*(server_name|ServerName)' "$VHOST" | grep -Fq "$DOMAIN"
  then
    note "vhost already present and answers for $DOMAIN, kept ($VHOST)"
  else
    [ ! -f "$VHOST" ] || good "vhost rewritten for $DOMAIN ($VHOST)"
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

        # Decisive, not merely regretful. Left at https, the node below would
        # write a certificate path into daemon.yml that is never going to
        # exist, and the daemon would refuse to start for a reason nobody
        # connects back to a DNS record.
        TLS=no
        NODE_SCHEME=http
        APP_URL="http://$DOMAIN"
        sed -i "s|^APP_URL=.*|APP_URL=$APP_URL|" "$ENV_FILE"
        systemctl restart hopper-panel
        warn "the panel has been put back on $APP_URL"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
# The node, and the daemon
#
# Declared **after** the web server, and that order is not cosmetic. With TLS
# the node is registered as `https`, and `hopper node:create` writes the
# Let's Encrypt certificate path into daemon.yml. The daemon reads that path
# when it starts. Started before certbot had run, it read a file that did not
# exist yet and died — on a fresh install with a domain, which is the path the
# documentation recommends. An operator who installs twice, or reboots, never
# sees it.
# ---------------------------------------------------------------------------

step "Node"

# The local node is declared from the command line: on a single machine,
# demanding a trip through the interface before anything works at all would gain
# nothing.
if [ ! -f "$DAEMON_FILE" ]; then
  MEMORY_BYTES=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) * 1024 ))
  DISK_BYTES=$(df -B1 --output=size "$DATA_ROOT" | tail -1 | tr -d ' ')

  hopper_cli node:create \
    --name "$(hostname -s)" --fqdn "$DOMAIN" --scheme "$NODE_SCHEME" \
    --port "$DAEMON_PORT" --sftp-port "$SFTP_PORT" --timezone "$TIMEZONE" \
    --memory "$MEMORY_BYTES" --disk "$DISK_BYTES" \
    --output "$DAEMON_FILE" >/dev/null
  good "local node declared, servers on $TIMEZONE"
else
  # A rerun that changes an answer has to change the machine, or the script is
  # back to printing one thing and doing another.
  #
  # The node row is where the answers land: the panel calls the daemon at the
  # address written there, `daemon.yml` is generated from it — the certificate
  # it presents, the origin it accepts, the timezone it hands every container —
  # and none of that used to move when the script was rerun on a new address.
  # The panel went on calling the machine by the name it had months earlier,
  # and reported it as unreachable.
  #
  # Which node is read from the file rather than guessed: a panel can hold
  # several, and only one of them is this machine.
  NODE_UUID=$(sed -n 's/^uuid:[[:space:]]*//p' "$DAEMON_FILE" | head -1)

  if [ -z "$NODE_UUID" ]; then
    warn "$DAEMON_FILE names no node — leaving it alone."
  else
    NODE_LOG=/tmp/hopper-node-update.log
    NODE_STATUS=0

    hopper_cli node:update --node "$NODE_UUID" \
      --fqdn "$DOMAIN" --scheme "$NODE_SCHEME" \
      --port "$DAEMON_PORT" --sftp-port "$SFTP_PORT" --timezone "$TIMEZONE" \
      >"$NODE_LOG" 2>&1 || NODE_STATUS=$?

    if [ "$NODE_STATUS" -ne 0 ]; then
      sed 's/^/    /' "$NODE_LOG" >&2
      # The likeliest cause is worth naming: the node this file was written for
      # has been deleted from the panel since, which leaves the daemon
      # authenticating against nothing and the panel calling it unreachable.
      warn "the local node could not be updated — does node $NODE_UUID still exist?"
    elif grep -q 'HOPPER_NODE_CHANGED=1' "$NODE_LOG"; then
      # Rewritten only when something moved: the rewrite renews the node token,
      # and renewing a secret on every rerun is a cost with no reason.
      hopper_cli node:token --node "$NODE_UUID" --output "$DAEMON_FILE" >/dev/null
      good "local node moved to $NODE_SCHEME://$DOMAIN:$DAEMON_PORT, servers on $TIMEZONE"
      note "Its token was renewed to rewrite $DAEMON_FILE; the daemon restarts below."
    else
      note "daemon.yml already present and current, kept"
    fi
  fi
fi

systemctl enable hopperd >/dev/null
systemctl restart hopperd

# Verified, not assumed. `systemctl restart` returns as soon as the unit is
# activating; a daemon that dies a second later on an unreadable certificate
# would leave this script printing success over a broken installation.
for _ in $(seq 1 20); do
  systemctl is-active --quiet hopperd && break
  sleep 1
done

if ! systemctl is-active --quiet hopperd; then
  journalctl -u hopperd -n 20 --no-pager | sed 's/^/    /' >&2
  die "hopperd did not stay up — its log is above."
fi

good "hopperd"

# Not `restart`: this unit is a watcher, and restarting it while it is being
# triggered by the very update running right now would cut that update short.
systemctl enable hopper-update.path >/dev/null
systemctl start hopper-update.path >/dev/null 2>&1 || true

systemctl enable hopper-node-apply.path >/dev/null
systemctl start hopper-node-apply.path >/dev/null 2>&1 || true
good "update watcher"

# ---------------------------------------------------------------------------
# Local policies
# ---------------------------------------------------------------------------

if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" = Enforcing ]; then
  step "SELinux"
  # Without this boolean, httpd and nginx are refused the connection to the
  # panel: the proxy answers 503 and nothing in their logs explains it.
  setsebool -P httpd_can_network_connect 1 >/dev/null 2>&1 &&
    good "outbound connections allowed for the web server" ||
    warn "could not set httpd_can_network_connect: the proxy will answer 503."
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
hopper_cli doctor || true

step "Done"
pair "Panel" "$APP_URL"
pair "Language" "$LOCALE"
pair "Servers' timezone" "$TIMEZONE"

if [ "$ADMIN_CREATED" = 1 ]; then
  pair "Username" "$ADMIN_USERNAME"
  pair "Password" "$ADMIN_PASSWORD"
  note "Write it down: it is not kept in the clear."
else
  # A rerun creates no account and therefore has no password to print. Saying
  # nothing at all left the operator staring at a sign-in form with credentials
  # from an installation they no longer remembered — and the way out is one
  # command they had no reason to know exists.
  pair "Username" "$ADMIN_USERNAME"
  note "The administrator already existed, so no new password was generated."
  note "Lost it?     hopper user:password --username $ADMIN_USERNAME"
fi

info ""
note "Logs       : journalctl -u hopper-panel -f   /   journalctl -u hopperd -f"
note "Diagnostic : hopper doctor"
note "Update     : bash $HOPPER_ROOT/install/install.sh"
info ""
warn "Open ports $DAEMON_PORT (daemon), $SFTP_PORT (SFTP) and those of your servers."
warn "Filter with DOCKER-USER and not ufw: Docker writes its rules before ufw's."
