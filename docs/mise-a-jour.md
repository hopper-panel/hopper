# Mise à jour

## En une commande

```bash
sudo bash /opt/hopper/install/install.sh
```

Relancer l'installeur sur une installation existante met à jour le code et le schéma de base, et ne
touche ni au `.env`, ni au `daemon.yml`, ni aux vhosts, ni au compte administrateur. Les services
sont redémarrés à la fin.

## À la main

```bash
cd /opt/hopper
git pull
pnpm install --frozen-lockfile
pnpm --filter @hopper/shared build
pnpm --filter @hopper/panel exec prisma generate
pnpm --filter @hopper/panel exec prisma migrate deploy
pnpm --filter @hopper/panel build
pnpm --filter @hopper/web build
pnpm --filter @hopper/daemon build
chown -R hopper:hopper /opt/hopper
systemctl restart hopper-panel hopperd
hopper doctor
```

L'ordre compte : `prisma generate` avant la construction du panel, `migrate deploy` avant le
redémarrage. Un panel qui démarre sur un schéma non migré échoue à la première requête, pas au
lancement — la panne se manifeste alors comme une erreur 500 apparemment sans rapport.

## Interruption de service

Le redémarrage du panel coupe l'interface une poignée de secondes. Le redémarrage du daemon **ne
coupe pas les serveurs** : les conteneurs continuent de tourner, seules les consoles ouvertes se
reconnectent. Un serveur reste donc joignable par ses joueurs pendant toute la mise à jour.

## Avant une montée de version majeure

Sauvegardez ces trois éléments — les trois, pas deux :

```bash
pg_dump -U hopper hopper > hopper-$(date +%F).sql   # la base
cp /opt/hopper/apps/panel/.env  ./env-hopper.bak    # APP_SECRET
cp /etc/hopper/daemon.yml       ./daemon.bak        # jeton du node
```

`APP_SECRET` chiffre les jetons de node, les mots de passe des serveurs SQL et les secrets de double
authentification. **Une base restaurée sans son `.env` d'origine est inexploitable** : le panel
répondra 500 sur la console, sur le test d'un serveur de bases et à toute connexion 2FA. Si cela
vous arrive, `hopper node:token` régénère les secrets des nodes ; les mots de passe SQL, eux, sont
perdus et les bases doivent être redéclarées.

## Retour en arrière

```bash
cd /opt/hopper
git checkout <version-précédente>
pnpm install --frozen-lockfile && pnpm build
systemctl restart hopper-panel hopperd
```

Les migrations Prisma ne se défont pas : revenir à une version antérieure au schéma en place peut
échouer. Restaurez la base au même moment si la version visée précède une migration.
