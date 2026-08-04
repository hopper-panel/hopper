# Installation

## Ce qu'il vous faut

- Une machine **Debian 12+, Ubuntu 22.04+, Rocky ou AlmaLinux 9+**, fraîchement installée de
  préférence, avec les droits root.
- **2 Go de RAM au minimum** pour le panel et un serveur Minecraft. Comptez la mémoire de vos
  serveurs en plus : un Paper moderne demande 2 à 4 Go à lui seul.
- Un **nom de domaine** qui pointe déjà sur la machine si vous voulez du HTTPS. Sans domaine,
  l'installation reste possible en HTTP sur une adresse IP.
- Les ports **80**, **443**, **8443** (daemon) et **2022** (SFTP) joignables depuis l'extérieur, plus
  ceux de vos serveurs Minecraft.

Une machine virtuelle chez n'importe quel hébergeur convient, à une condition : les conteneurs
Docker doivent pouvoir tourner. Les VPS **OpenVZ** et **LXC** ne le permettent généralement pas.

## Installation

```bash
git clone https://github.com/hopper-panel/hopper.git
cd hopper
sudo bash install/install.sh
```

Le script pose quatre questions — domaine, serveur web, certificat, compte administrateur — puis
installe Node, Docker, PostgreSQL, Redis, construit le panel, écrit les services systemd, déclare le
node local et configure le vhost. Comptez cinq à dix minutes, l'essentiel étant la construction.

À la fin, il affiche l'adresse du panel et le mot de passe de l'administrateur, **qui n'est plus
récupérable ensuite**.

### Sans interaction

Toutes les réponses peuvent être fournies par l'environnement, ce qui permet d'installer depuis un
outil de déploiement :

```bash
sudo HOPPER_NONINTERACTIVE=1 \
     HOPPER_DOMAIN=panel.example.com \
     HOPPER_WEBSERVER=nginx \
     HOPPER_TLS=yes \
     HOPPER_ADMIN_EMAIL=moi@example.com \
     HOPPER_ADMIN_USERNAME=moi \
     bash install/install.sh
```

| Variable                | Rôle                              | Défaut              |
| ----------------------- | --------------------------------- | ------------------- |
| `HOPPER_DOMAIN`         | Domaine ou IP du panel            | nom d'hôte          |
| `HOPPER_WEBSERVER`      | `nginx`, `apache` ou `aucun`      | `nginx`             |
| `HOPPER_TLS`            | `yes` pour demander un certificat | `oui` si un domaine |
| `HOPPER_ADMIN_PASSWORD` | Mot de passe du compte créé       | généré              |
| `HOPPER_ROOT`           | Répertoire d'installation         | `/opt/hopper`       |
| `HOPPER_PORT`           | Port d'écoute du panel            | `8080`              |
| `HOPPER_DAEMON_PORT`    | Port d'écoute du daemon           | `8443`              |

### Sans serveur web

`HOPPER_WEBSERVER=aucun` fait écouter le panel directement sur `0.0.0.0:8080`, sans proxy ni TLS.
Pratique pour un réseau local ; à éviter sur Internet, où les sessions circuleraient en clair.

## Après l'installation

```bash
hopper doctor
```

La commande vérifie la configuration, la base, Redis, les nodes et Docker. C'est le premier réflexe
devant n'importe quel comportement anormal — voir [la documentation de la CLI](./cli.md).

Ensuite, dans l'interface :

1. **Administration → Nodes → votre node → Allocations** : déclarez les ports que vos serveurs
   pourront utiliser, par exemple la plage `25565-25580`.
2. **Administration → Templates** : le catalogue livré (Paper, Purpur, Vanilla, Fabric, NeoForge,
   Velocity, BungeeCord…) est déjà installé. Resynchronisez après chaque mise à jour de Hopper.
3. **Créer un serveur**.

## Pare-feu

Docker écrit ses propres règles `iptables`, **avant** celles d'ufw : une règle ufw qui semble
fermer un port de conteneur ne ferme rien du tout. Filtrez dans la chaîne `DOCKER-USER` :

```bash
# N'autoriser le port d'un serveur que depuis un réseau donné
iptables -I DOCKER-USER -p tcp --dport 25565 ! -s 203.0.113.0/24 -j DROP
```

Sur Rocky et Alma, `firewalld` est actif et l'installeur y ouvre les ports 80, 443, 8443 et 2022.
Les ports de vos serveurs Minecraft restent à ouvrir.

## Ajouter une seconde machine

Le panel pilote autant de machines que nécessaire. Sur la nouvelle :

1. Dans l'interface : **Administration → Nodes → Créer**. Le panel affiche un `daemon.yml`.
2. Sur la machine hôte : installez Docker et Node 22, copiez le dépôt dans `/opt/hopper`,
   construisez le daemon (`pnpm --filter @hopper/daemon build`), écrivez le `daemon.yml` dans
   `/etc/hopper/daemon.yml` en mode `600`, installez `install/hopperd.service`, puis
   `systemctl enable --now hopperd`.
3. Vérifiez depuis le panel : **Administration** doit afficher le node comme joignable.

Le daemon refuse de démarrer si `/etc/hopper/daemon.yml` est lisible par d'autres que root : il
contient le secret du node et la clé de signature des consoles.

## Désinstallation

```bash
systemctl disable --now hopper-panel hopperd
rm -f /etc/systemd/system/hopper-panel.service /etc/systemd/system/hopperd.service
rm -rf /opt/hopper /etc/hopper /usr/local/bin/hopper
su - postgres -c "dropdb hopper && dropuser hopper"
```

`/var/lib/hopper` contient **les volumes de vos serveurs et vos sauvegardes** : il n'est pas
supprimé par ces commandes, et il vaut mieux le déplacer que l'effacer.
