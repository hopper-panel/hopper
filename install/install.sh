#!/usr/bin/env bash
#
# Installeur de Hopper Panel.
#
#   bash install.sh
#
# Installe le panel, le daemon et leurs dépendances sur une machine neuve, puis
# rend une instance joignable. Prévu pour Debian 12+, Ubuntu 22.04+, Rocky et
# AlmaLinux 9+.
#
# Le script est **interactif par défaut** mais entièrement pilotable par
# variables d'environnement, pour un déploiement automatisé :
#
#   HOPPER_DOMAIN=panel.example.com HOPPER_WEBSERVER=nginx HOPPER_TLS=yes \
#   HOPPER_ADMIN_EMAIL=moi@example.com HOPPER_ADMIN_USERNAME=moi \
#   HOPPER_NONINTERACTIVE=1 bash install.sh
#
# Relancer le script sur une installation existante met à jour le code sans
# toucher à la base, au fichier .env ni aux vhosts déjà écrits.

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
# Affichage
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
# Préalables
# ---------------------------------------------------------------------------

[ "$(id -u)" -eq 0 ] || die "Ce script doit être lancé en root : sudo bash install.sh"

# shellcheck disable=SC1091
[ -r /etc/os-release ] || die "/etc/os-release introuvable : distribution non reconnue."
. /etc/os-release

case "${ID:-} ${ID_LIKE:-}" in
  *debian*|*ubuntu*) FAMILY=debian ;;
  *rhel*|*fedora*|*centos*) FAMILY=rhel ;;
  *) die "Distribution non prise en charge : ${PRETTY_NAME:-inconnue}. Debian, Ubuntu, Rocky et Alma le sont." ;;
esac

info "Système : ${PRETTY_NAME:-$ID} (famille $FAMILY)"

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
  # $1 question, $2 défaut, $3 nom de la variable à définir
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
  ask "Nom de domaine du panel (ou adresse IP)" "$(hostname -f 2>/dev/null || hostname)" DOMAIN
fi

# Une adresse IP ne peut pas recevoir de certificat Let's Encrypt : proposer
# TLS dans ce cas conduirait l'utilisateur droit dans un échec de certbot.
IS_IP=0
case "$DOMAIN" in
  *[!0-9.]*) ;;
  *) IS_IP=1 ;;
esac

WEBSERVER="${HOPPER_WEBSERVER:-}"
if [ -z "$WEBSERVER" ]; then
  ask "Serveur web (nginx / apache / aucun)" nginx WEBSERVER
fi

case "$WEBSERVER" in
  nginx|apache|aucun|none) ;;
  *) die "Serveur web inconnu : $WEBSERVER (attendu : nginx, apache ou aucun)" ;;
esac
[ "$WEBSERVER" != none ] || WEBSERVER=aucun

TLS="${HOPPER_TLS:-}"
if [ -z "$TLS" ]; then
  if [ "$WEBSERVER" = aucun ] || [ "$IS_IP" = 1 ]; then
    TLS=no
  else
    ask "Obtenir un certificat Let's Encrypt (oui/non)" oui TLS
  fi
fi

case "$TLS" in oui|yes|y|o) TLS=yes ;; *) TLS=no ;; esac

if [ "$TLS" = yes ] && [ "$IS_IP" = 1 ]; then
  warn "Let's Encrypt ne certifie pas une adresse IP : installation en HTTP."
  TLS=no
fi

CERTBOT_EMAIL="${HOPPER_ADMIN_EMAIL:-}"
ADMIN_EMAIL="${HOPPER_ADMIN_EMAIL:-}"
[ -n "$ADMIN_EMAIL" ] || ask "Adresse e-mail de l'administrateur" "admin@$DOMAIN" ADMIN_EMAIL
ADMIN_USERNAME="${HOPPER_ADMIN_USERNAME:-}"
[ -n "$ADMIN_USERNAME" ] || ask "Identifiant de l'administrateur" admin ADMIN_USERNAME
[ -n "$CERTBOT_EMAIL" ] || CERTBOT_EMAIL="$ADMIN_EMAIL"

if [ "$WEBSERVER" = aucun ]; then
  APP_URL="http://$DOMAIN:$PANEL_PORT"
elif [ "$TLS" = yes ]; then
  APP_URL="https://$DOMAIN"
else
  APP_URL="http://$DOMAIN"
fi

# Le daemon n'est pas derrière le proxy : il écoute lui-même sur son port, avec
# le certificat de certbot quand il y en a un.
if [ "$TLS" = yes ]; then NODE_SCHEME=https; else NODE_SCHEME=http; fi

info ""
info "Panel      : $APP_URL"
info "Serveur web: $WEBSERVER"
info "Daemon     : $NODE_SCHEME://$DOMAIN:$DAEMON_PORT"
info "SFTP       : $DOMAIN:$SFTP_PORT"

if [ -z "${HOPPER_NONINTERACTIVE:-}" ]; then
  ask "Continuer ? (oui/non)" oui CONFIRM
  case "$CONFIRM" in oui|yes|y|o) ;; *) die "Installation annulée." ;; esac
fi

# ---------------------------------------------------------------------------
# Dépendances système
# ---------------------------------------------------------------------------

step "Dépendances système"

if [ "$FAMILY" = debian ]; then
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  install_packages ca-certificates curl gnupg git tar openssl
else
  install_packages ca-certificates curl gnupg git tar openssl
fi
good "outils de base"

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]; then
  info "Installation de Node $NODE_MAJOR…"
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
  # `npm i -g` et non corepack : corepack télécharge pnpm à la première
  # exécution, ce qui échoue sur une machine sans accès sortant vers le registre
  # au moment où l'on s'y attend le moins.
  npm install -g pnpm@10 >/dev/null
fi
good "pnpm $(pnpm --version)"

if ! command -v docker >/dev/null 2>&1; then
  info "Installation de Docker…"
  curl -fsSL https://get.docker.com | sh >/dev/null
  systemctl enable --now docker >/dev/null 2>&1 || true
fi
good "Docker $(docker --version | cut -d' ' -f3 | tr -d ,)"

# ---------------------------------------------------------------------------
# PostgreSQL et Redis
# ---------------------------------------------------------------------------

step "Base de données"

if ! command -v psql >/dev/null 2>&1; then
  if [ "$FAMILY" = debian ]; then
    install_packages postgresql
  else
    install_packages postgresql-server postgresql
    [ -f /var/lib/pgsql/data/PG_VERSION ] || postgresql-setup --initdb >/dev/null
  fi
fi

systemctl enable --now postgresql >/dev/null 2>&1 || die "PostgreSQL n'a pas démarré."

DB_NAME="${HOPPER_DB_NAME:-hopper}"
DB_USER="${HOPPER_DB_USER:-hopper}"
DB_PASSWORD="${HOPPER_DB_PASSWORD:-$(openssl rand -hex 24)}"

# Le rôle existe déjà si le script est relancé : on ne touche pas au mot de
# passe, sinon le .env conservé pointerait sur un mot de passe changé.
if su - postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'\"" | grep -q 1; then
  note "rôle $DB_USER déjà présent, inchangé"
  DB_PASSWORD=''
else
  su - postgres -c "psql -q -c \"CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASSWORD'\"" >/dev/null
  good "rôle $DB_USER créé"
fi

if su - postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$DB_NAME'\"" | grep -q 1; then
  note "base $DB_NAME déjà présente"
else
  su - postgres -c "createdb -O $DB_USER $DB_NAME" >/dev/null
  good "base $DB_NAME créée"
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
  info "Copie depuis $SOURCE_DIR"
  mkdir -p "$HOPPER_ROOT"
  tar -C "$SOURCE_DIR" \
    --exclude=node_modules --exclude=dist --exclude=.turbo --exclude=.git \
    -cf - . | tar -C "$HOPPER_ROOT" -xf -
elif [ -d "$HOPPER_ROOT/.git" ]; then
  info "Mise à jour du dépôt existant"
  git -C "$HOPPER_ROOT" pull --ff-only
elif [ ! -f "$HOPPER_ROOT/pnpm-workspace.yaml" ]; then
  info "Clonage depuis $REPOSITORY"
  git clone --depth 1 "$REPOSITORY" "$HOPPER_ROOT"
fi
good "sources dans $HOPPER_ROOT"

id hopper >/dev/null 2>&1 || useradd --system --home-dir "$HOPPER_ROOT" --shell /usr/sbin/nologin hopper
mkdir -p "$CONFIG_ROOT" "$DATA_ROOT/volumes" "$DATA_ROOT/backups"
chmod 700 "$CONFIG_ROOT"

step "Construction"
note "Quelques minutes à la première installation."
cd "$HOPPER_ROOT"

# Sans `CI`, pnpm refuse de purger un node_modules devenu incohérent — ce qui
# arrive dès qu'on met à jour depuis une version dont les dépendances ont
# bougé — et s'arrête sur « Aborted removal of modules directory due to no TTY ».
# Les erreurs restent visibles : seule la sortie normale est masquée.
export CI=true
pnpm install --frozen-lockfile --prod=false >/dev/null || pnpm install >/dev/null
pnpm --filter @hopper/shared build >/dev/null
pnpm --filter @hopper/templates build >/dev/null 2>&1 || true
pnpm --filter @hopper/panel exec prisma generate >/dev/null
pnpm --filter @hopper/panel build >/dev/null
pnpm --filter @hopper/web build >/dev/null
pnpm --filter @hopper/daemon build >/dev/null
good "panel, interface et daemon construits"

# ---------------------------------------------------------------------------
# Configuration du panel
# ---------------------------------------------------------------------------

step "Configuration du panel"

ENV_FILE="$HOPPER_ROOT/apps/panel/.env"

if [ -f "$ENV_FILE" ]; then
  note ".env déjà présent, conservé"
else
  [ -n "$DB_PASSWORD" ] || die "Le rôle PostgreSQL existait déjà mais son mot de passe est inconnu : renseignez DATABASE_URL dans $ENV_FILE puis relancez."

  cat > "$ENV_FILE" <<EOF
# Généré par install.sh le $(date -Iseconds).
#
# APP_SECRET chiffre les jetons de node, les mots de passe SQL et les secrets
# de double authentification. Le changer rend tout cela illisible : sauvegardez
# ce fichier avec la base.
NODE_ENV=production

APP_URL=$APP_URL
HOST=127.0.0.1
PORT=$PANEL_PORT

APP_SECRET=$(openssl rand -base64 48 | tr -d '\n')

DATABASE_URL=postgresql://$DB_USER:$DB_PASSWORD@127.0.0.1:5432/$DB_NAME
REDIS_URL=redis://127.0.0.1:6379
EOF

  # Le panel écoute sur la boucle locale quand un proxy le précède, et sur
  # toutes les interfaces sinon — sans quoi il ne serait joignable de nulle part.
  [ "$WEBSERVER" != aucun ] || sed -i 's/^HOST=.*/HOST=0.0.0.0/' "$ENV_FILE"

  good ".env écrit"
fi

# Hors du bloc de création : un .env laissé lisible par tous par une
# installation précédente expose APP_SECRET et le mot de passe de la base à
# n'importe quel compte de la machine.
chmod 600 "$ENV_FILE"

step "Migration de la base"
cd "$HOPPER_ROOT/apps/panel"
pnpm exec prisma migrate deploy >/dev/null
good "schéma à jour"

ADMIN_PASSWORD="${HOPPER_ADMIN_PASSWORD:-$(openssl rand -base64 18 | tr -d '\n/+=' | cut -c1-20)}"
ADMIN_CREATED=0

if HOPPER_ADMIN_EMAIL="$ADMIN_EMAIL" HOPPER_ADMIN_USERNAME="$ADMIN_USERNAME" \
   HOPPER_ADMIN_PASSWORD="$ADMIN_PASSWORD" pnpm exec prisma db seed 2>&1 | tee /tmp/hopper-seed.log | grep -q 'Compte administrateur créé'; then
  ADMIN_CREATED=1
  good "compte administrateur créé"
else
  note "compte administrateur déjà présent, inchangé"
fi

# En dernier : la migration et l'amorçage tournent en root et déposent des
# fichiers de cache dans node_modules. Les laisser à root ferait échouer le
# panel, qui tourne sous le compte hopper.
chown -R hopper:hopper "$HOPPER_ROOT"

# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------

step "Services systemd"

install -m 644 "$HOPPER_ROOT/install/hopper-panel.service" /etc/systemd/system/hopper-panel.service
install -m 644 "$HOPPER_ROOT/install/hopperd.service" /etc/systemd/system/hopperd.service
install -m 755 "$HOPPER_ROOT/install/hopper" /usr/local/bin/hopper
systemctl daemon-reload
systemctl enable --now hopper-panel >/dev/null
good "hopper-panel"

# Le node local est déclaré depuis la ligne de commande : sur une machine
# unique, exiger un passage par l'interface avant que rien ne fonctionne
# n'apporterait rien.
if [ ! -f "$CONFIG_ROOT/daemon.yml" ]; then
  MEMORY_BYTES=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) * 1024 ))
  DISK_BYTES=$(df -B1 --output=size "$DATA_ROOT" | tail -1 | tr -d ' ')

  HOPPER_ROOT="$HOPPER_ROOT" hopper node:create \
    --name "$(hostname -s)" --fqdn "$DOMAIN" --scheme "$NODE_SCHEME" \
    --port "$DAEMON_PORT" --sftp-port "$SFTP_PORT" \
    --memory "$MEMORY_BYTES" --disk "$DISK_BYTES" \
    --output "$CONFIG_ROOT/daemon.yml" >/dev/null
  good "node local déclaré"
else
  note "daemon.yml déjà présent, conservé"
fi

systemctl enable --now hopperd >/dev/null
good "hopperd"

# ---------------------------------------------------------------------------
# Serveur web
# ---------------------------------------------------------------------------

write_vhost() {
  # $1 fichier de destination, $2 gabarit, $3 chemin du certificat, $4 clé
  sed -e "s|{{DOMAIN}}|$DOMAIN|g" -e "s|{{PORT}}|$PANEL_PORT|g" \
      -e "s|{{CERT}}|$3|g" -e "s|{{KEY}}|$4|g" "$2" > "$1"
}

write_plain_vhost() {
  # Vhost HTTP seul : sert aussi de configuration d'attente pendant que certbot
  # valide le domaine, puisque la validation passe par le port 80.
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

if [ "$WEBSERVER" != aucun ]; then
  step "Serveur web ($WEBSERVER)"

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
    note "vhost déjà présent, conservé ($VHOST)"
  else
    write_plain_vhost "$VHOST"
    [ "$WEBSERVER" != apache ] || [ "$FAMILY" != debian ] || a2ensite hopper >/dev/null
    systemctl enable --now "$SERVICE" >/dev/null
    $TEST >/dev/null 2>&1 || die "Configuration $WEBSERVER invalide : $TEST"
    $RELOAD
    good "vhost HTTP en place"

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

        $TEST >/dev/null 2>&1 || die "Configuration $WEBSERVER invalide après ajout du certificat."
        $RELOAD
        good "certificat obtenu, HTTPS actif"

        # Le daemon lit les mêmes certificats : il tourne en root et peut donc
        # ouvrir /etc/letsencrypt. Un rechargement après renouvellement est
        # nécessaire, d'où ce crochet.
        mkdir -p /etc/letsencrypt/renewal-hooks/deploy
        cat > /etc/letsencrypt/renewal-hooks/deploy/hopper.sh <<'EOF'
#!/bin/sh
# Le daemon garde le certificat en mémoire depuis son démarrage : sans ce
# redémarrage, il continuerait de présenter l'ancien après renouvellement.
systemctl restart hopperd
EOF
        chmod 755 /etc/letsencrypt/renewal-hooks/deploy/hopper.sh
      else
        warn "certbot a échoué — l'installation reste en HTTP."
        warn "Vérifiez que $DOMAIN pointe sur cette machine et que le port 80 est ouvert."
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Politiques locales
# ---------------------------------------------------------------------------

if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" = Enforcing ]; then
  step "SELinux"
  # Sans ce booléen, httpd et nginx se voient refuser la connexion vers le
  # panel : le proxy répond 503 et rien dans leurs journaux ne l'explique.
  setsebool -P httpd_can_network_connect 1 >/dev/null 2>&1 && good "connexions sortantes autorisées pour le serveur web"     || warn "impossible de poser httpd_can_network_connect : le proxy renverra 503."
fi

if systemctl is-active --quiet firewalld 2>/dev/null; then
  step "Pare-feu"
  for PORT in 80/tcp 443/tcp "$DAEMON_PORT/tcp" "$SFTP_PORT/tcp"; do
    firewall-cmd --permanent --add-port="$PORT" >/dev/null 2>&1 || true
  done
  firewall-cmd --reload >/dev/null 2>&1 || true
  good "ports 80, 443, $DAEMON_PORT et $SFTP_PORT ouverts"
  note "Les ports de vos serveurs Minecraft restent à ouvrir."
fi

# ---------------------------------------------------------------------------
# Diagnostic et résumé
# ---------------------------------------------------------------------------

step "Vérification"
sleep 3
HOPPER_ROOT="$HOPPER_ROOT" hopper doctor || true

step "Terminé"
info "Panel      : $APP_URL"

if [ "$ADMIN_CREATED" = 1 ]; then
  info "Identifiant: $ADMIN_USERNAME"
  info "Mot de passe : $ADMIN_PASSWORD"
  note "Notez-le : il n'est pas conservé en clair."
fi

info ""
note "Journaux    : journalctl -u hopper-panel -f   /   journalctl -u hopperd -f"
note "Diagnostic  : hopper doctor"
note "Mise à jour : bash $HOPPER_ROOT/install/install.sh"
info ""
warn "Ouvrez les ports $DAEMON_PORT (daemon), $SFTP_PORT (SFTP) et ceux de vos serveurs."
warn "Filtrez avec DOCKER-USER et non ufw : Docker écrit ses règles avant celles d'ufw."
