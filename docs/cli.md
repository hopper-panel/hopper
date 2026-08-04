# Ligne de commande

`hopper` est installé dans `/usr/local/bin` par l'installeur. En développement, la même chose
s'obtient depuis `apps/panel` avec `pnpm cli <commande>`.

La commande lit le `.env` du panel : elle agit donc sur la même base et avec les mêmes règles que
l'interface — un mot de passe trop court est refusé ici aussi.

## `hopper doctor`

Diagnostic complet de l'installation. Sa sortie distingue trois niveaux : `✓` conforme, `!`
avertissement — cela fonctionne mais mordra plus tard —, `✗` panne. Le code de retour vaut 1 dès
qu'un `✗` apparaît, ce qui permet de l'enchaîner dans un script.

Ce qu'il vérifie :

- **Système** : version de Node, présence du contrôleur mémoire de cgroup v2 — sans lui, les limites
  de RAM posées sur les conteneurs ne sont pas appliquées.
- **Configuration** : `APP_SECRET` laissé à sa valeur d'exemple, URL publique en `localhost` alors
  que le panel est en production, absence de TLS.
- **Base de données** : connexion, **migrations en attente**, présence d'au moins un administrateur.
- **Redis** : joignable, ou absent — auquel cas la limitation de débit repart de zéro à chaque
  redémarrage.
- **Nodes** : chaque node est interrogé pour de vrai. Un node déclaré n'est pas un node joignable.
- **Hôte Docker** : socket accessible et version du moteur, si la machine héberge un daemon.

## `hopper user:create`

```bash
hopper user:create --email moi@example.com --username julien --admin
```

Crée un compte. Sans `--password`, un mot de passe est généré et affiché **une seule fois**.
`--admin` donne le rôle administrateur.

## `hopper user:password`

```bash
hopper user:password --username julien
```

Change le mot de passe et **ferme toutes les sessions** du compte : c'est la commande à lancer quand
on soupçonne un vol d'identifiants. Le SFTP utilisant les mêmes identifiants, il suit aussitôt.

## `hopper node:create`

```bash
hopper node:create --name paris-1 --fqdn node1.example.com --output /etc/hopper/daemon.yml
```

Déclare un node et écrit sa configuration. Sans `--output`, le `daemon.yml` est écrit sur la sortie
standard, ce qui permet de le rediriger ou de le copier vers une autre machine.

Options : `--scheme http|https` (défaut `https`), `--port` (8443), `--sftp-port` (2022),
`--memory` et `--disk` en octets — `0` signifiant « pas de limite déclarée ».

## `hopper node:token`

```bash
hopper node:token --node paris-1 --output /etc/hopper/daemon.yml
systemctl restart hopperd
```

Renouvelle le jeton d'un node et régénère son `daemon.yml`. C'est la commande de secours : elle
rétablit un node dont la configuration a été perdue, ou dont les secrets ne sont plus déchiffrables
parce que `APP_SECRET` a changé.

**Le jeton précédent cesse immédiatement d'être valable.** Le node reste injoignable depuis le panel
tant que le fichier n'est pas en place et le service redémarré ; les serveurs déjà lancés, eux,
continuent de tourner — c'est le lien de contrôle qui est coupé, pas les conteneurs.

Sans `--node`, la commande refuse d'agir s'il existe plusieurs nodes plutôt que d'en choisir un :
faire tourner le jeton de la mauvaise machine coupe une production, et l'erreur ne se voit qu'au
redémarrage suivant.
