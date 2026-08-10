#!/usr/bin/env bash
#
# Hopper Panel uninstaller.
#
#   sudo bash uninstall.sh              # remove Hopper, keep the game data
#   sudo bash uninstall.sh --purge      # remove everything, game data included
#   sudo bash uninstall.sh --dry-run    # print what would go, touch nothing
#
# The mirror of `install.sh`, and deliberately narrower than it. The installer
# brings in Docker, PostgreSQL, Redis and a web server; this removes **what
# Hopper itself created** and leaves those alone. They are shared services —
# another application on this machine may be sitting on any of them, and an
# uninstaller that took the database server down with it would be the worst
# possible way to find that out.
#
# What is removed:
#
#   - the four systemd units and the `hopper` CLI
#   - /opt/hopper, /etc/hopper
#   - the `hopper` PostgreSQL database and role
#   - the game containers, their Docker network, the `hopper` system user
#   - the panel's vhost, and the certbot renewal hook
#
# What is kept, unless `--purge`:
#
#   - **/var/lib/hopper/volumes** — every server's files. Worlds, plugins,
#     configuration: the part nobody can regenerate.
#   - /var/lib/hopper/backups
#
# What is never touched: Docker, PostgreSQL, Redis, nginx, Apache, certbot and
# the certificates themselves. Removing a certificate would make reinstalling
# on the same domain hit Let's Encrypt's rate limit for no reason.

set -euo pipefail

HOPPER_ROOT="${HOPPER_ROOT:-/opt/hopper}"
DATA_ROOT="${DATA_ROOT:-/var/lib/hopper}"
CONFIG_ROOT=/etc/hopper
DB_NAME="${HOPPER_DB_NAME:-hopper}"
DB_USER="${HOPPER_DB_USER:-hopper}"
DOCKER_NETWORK="${HOPPER_DOCKER_NETWORK:-hopper0}"

PURGE=''
DRY_RUN=''
ASSUME_YES="${HOPPER_NONINTERACTIVE:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
  shift
done

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

# Every destructive action goes through this, so `--dry-run` cannot miss one:
# there is no second path that writes.
run() {
  [ -n "$DRY_RUN" ] || "$@"
}

# What was done, in the tense it was actually done in.
#
# A dry run that prints "removed" is worse than no dry run: it reads exactly
# like the real thing, so an operator scrolling back to check what happened
# finds a report of work nobody did.
did() {
  if [ -n "$DRY_RUN" ]; then
    note "$1 would be $2"
  else
    good "$1 $2"
  fi
}

[ "$(id -u)" -eq 0 ] || die "This script has to run as root: sudo bash uninstall.sh"

# ---------------------------------------------------------------------------
# What is actually here
# ---------------------------------------------------------------------------
#
# Reported before anything is asked, because "uninstall Hopper" is a different
# decision on a machine holding four servers than on a failed install. The
# figures come from the filesystem rather than from the database: the database
# may already be gone, and a half-removed installation has to be finishable.

step "Found"

SERVERS=0
VOLUME_SIZE='0'

if [ -d "$DATA_ROOT/volumes" ]; then
  SERVERS=$(find "$DATA_ROOT/volumes" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
  VOLUME_SIZE=$(du -sh "$DATA_ROOT/volumes" 2>/dev/null | cut -f1)
fi

CONTAINERS=''
if command -v docker >/dev/null 2>&1; then
  CONTAINERS=$(docker ps -aq --filter 'name=^hopper-' 2>/dev/null || true)
fi

[ -d "$HOPPER_ROOT" ] && info "sources        $HOPPER_ROOT" || note "sources        already gone"
[ -d "$CONFIG_ROOT" ] && info "configuration  $CONFIG_ROOT" || note "configuration  already gone"
info "server files   $SERVERS server(s), $VOLUME_SIZE in $DATA_ROOT/volumes"
[ -n "$CONTAINERS" ] && info "containers     $(printf '%s\n' "$CONTAINERS" | wc -l)" || note "containers     none"

if [ -n "$PURGE" ]; then
  warn "--purge: the $SERVERS server(s) in $DATA_ROOT/volumes will be deleted too."
else
  info "The server files are kept. Pass --purge to delete them as well."
fi

# ---------------------------------------------------------------------------
# Confirmation
# ---------------------------------------------------------------------------
#
# Typed in full rather than a y/n, and only when there is something to lose.
# A prompt that takes a keystroke is a prompt that gets a keystroke, and the
# thing on the other side of this one does not come back.

if [ -z "$DRY_RUN" ] && [ -z "$ASSUME_YES" ]; then
  step "Confirm"

  EXPECTED=uninstall
  [ -z "$PURGE" ] || EXPECTED="delete $SERVERS server(s)"

  info "Type ${BOLD}$EXPECTED${RESET} to continue, anything else to stop."
  read -r -p "  > " ANSWER </dev/tty || ANSWER=''

  [ "$ANSWER" = "$EXPECTED" ] || die "Stopped. Nothing was removed."
fi

# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------
#
# Stopped before anything else and in this order: the daemon holds the
# containers, and the update path would otherwise start a service back up in
# the middle of a removal.

step "Services"

for UNIT in hopper-update.path hopper-update.service hopperd.service hopper-panel.service; do
  if systemctl list-unit-files "$UNIT" >/dev/null 2>&1 && systemctl cat "$UNIT" >/dev/null 2>&1; then
    run systemctl disable --now "$UNIT" >/dev/null 2>&1 || true
    run rm -f "/etc/systemd/system/$UNIT"
    did "$UNIT" removed
  else
    note "$UNIT not installed"
  fi
done

run systemctl daemon-reload
# `disable --now` leaves a failed unit in the failed state, where it keeps
# showing up in `systemctl --failed` long after its files are gone.
run systemctl reset-failed hopperd.service hopper-panel.service >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# Containers
# ---------------------------------------------------------------------------
#
# The containers go whatever the mode: they are built from the volumes, not the
# other way round, and one left running would hold a port and a bind mount of a
# directory this script may be about to remove.

step "Containers"

if command -v docker >/dev/null 2>&1; then
  if [ -n "$CONTAINERS" ]; then
    # shellcheck disable=SC2086
    run docker rm -f $CONTAINERS >/dev/null 2>&1 || true
    did "$(printf '%s\n' "$CONTAINERS" | wc -l) container(s)" removed
  else
    note "no Hopper container"
  fi

  if docker network inspect "$DOCKER_NETWORK" >/dev/null 2>&1; then
    run docker network rm "$DOCKER_NETWORK" >/dev/null 2>&1 || true
    did "network $DOCKER_NETWORK" removed
  else
    note "network $DOCKER_NETWORK not present"
  fi

  note "images are left in place; remove them with: docker image prune -a"
else
  note "Docker is not installed here"
fi

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
#
# Dropped in both modes, and that is a choice worth stating: the database holds
# the panel's own records — users, nodes, the encrypted node tokens — and none
# of it means anything without the panel. What `--purge` protects is the game
# files, which are the part that cannot be rebuilt.
#
# The role is dropped after the database it owns, and only if nothing else
# depends on it: `DROP ROLE` fails loudly rather than orphaning objects.

step "Database"

if command -v psql >/dev/null 2>&1 && id postgres >/dev/null 2>&1; then
  if [ "$(su - postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$DB_NAME'\"" 2>/dev/null)" = 1 ]; then
    run su - postgres -c "psql -q -c \"DROP DATABASE $DB_NAME\"" >/dev/null
    did "database $DB_NAME" dropped
  else
    note "database $DB_NAME not present"
  fi

  if [ "$(su - postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'\"" 2>/dev/null)" = 1 ]; then
    run su - postgres -c "psql -q -c \"DROP ROLE $DB_USER\"" >/dev/null 2>&1 ||
      warn "role $DB_USER kept: it still owns objects in another database"
    did "role $DB_USER" dropped
  else
    note "role $DB_USER not present"
  fi
else
  note "PostgreSQL is not installed here"
fi

# ---------------------------------------------------------------------------
# Web server
# ---------------------------------------------------------------------------
#
# Only the vhost this installer wrote, by its own name. A machine serving
# something else keeps serving it.

step "Web server"

VHOST_REMOVED=''

for PAIR in "/etc/nginx/sites-available/hopper.conf:/etc/nginx/sites-enabled/hopper.conf" \
            "/etc/nginx/conf.d/hopper.conf:" \
            "/etc/apache2/sites-available/hopper.conf:/etc/apache2/sites-enabled/hopper.conf" \
            "/etc/httpd/conf.d/hopper.conf:"; do
  FILE="${PAIR%%:*}"
  LINK="${PAIR#*:}"

  if [ -e "$FILE" ]; then
    [ -z "$LINK" ] || run rm -f "$LINK"
    run rm -f "$FILE"
    did "vhost $FILE" removed
    VHOST_REMOVED=1
  fi
done

if [ -n "$VHOST_REMOVED" ]; then
  for SERVICE in nginx apache2 httpd; do
    if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
      run systemctl reload "$SERVICE" >/dev/null 2>&1 || true
      did "$SERVICE" reloaded
    fi
  done
else
  note "no Hopper vhost found"
fi

if [ -f /etc/letsencrypt/renewal-hooks/deploy/hopper.sh ]; then
  run rm -f /etc/letsencrypt/renewal-hooks/deploy/hopper.sh
  did "certbot renewal hook" removed
fi

note "certificates are kept: deleting one would burn a Let's Encrypt rate limit"

# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------

step "Files"

run rm -f /usr/local/bin/hopper
did "CLI" removed

for DIRECTORY in "$HOPPER_ROOT" "$CONFIG_ROOT"; do
  if [ -d "$DIRECTORY" ]; then
    run rm -rf "$DIRECTORY"
    did "$DIRECTORY" removed
  else
    note "$DIRECTORY already gone"
  fi
done

if [ -n "$PURGE" ]; then
  if [ -d "$DATA_ROOT" ]; then
    run rm -rf "$DATA_ROOT"
    did "$DATA_ROOT and the server files in it" removed
  fi
else
  # The state directories that hold nothing anyone would miss go regardless;
  # `volumes` and `backups` are the whole reason this branch exists.
  for LEFTOVER in "$DATA_ROOT/updates" "$DATA_ROOT/tmp"; do
    [ ! -d "$LEFTOVER" ] || run rm -rf "$LEFTOVER"
  done

  good "$DATA_ROOT/volumes kept — $SERVERS server(s), $VOLUME_SIZE"
fi

if id hopper >/dev/null 2>&1; then
  run userdel hopper >/dev/null 2>&1 || warn "system user hopper kept: it still owns files"
  did "system user hopper" removed
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

step "Done"

if [ -n "$DRY_RUN" ]; then
  info "Nothing was removed: this was a dry run."
  exit 0
fi

info "Hopper is uninstalled."

if [ -z "$PURGE" ] && [ -d "$DATA_ROOT/volumes" ]; then
  info ""
  info "The server files are still in $DATA_ROOT/volumes ($VOLUME_SIZE)."
  info "Delete them with: rm -rf $DATA_ROOT"
fi

info ""
note "Docker, PostgreSQL, Redis and the web server were left installed."
note "Ports 8443 and 2022 may still be open in your firewall."
