# Sécuriser son instance

La [politique de sécurité](../SECURITY.md) décrit le modèle de menace du projet et la façon de
signaler une faille. Ce document-ci s'adresse à celui qui **exploite** une instance : ce qu'il faut
régler, sauvegarder et surveiller.

## Les six points qui comptent

### 1. `APP_SECRET` — le sauvegarder, ne jamais le changer

Il chiffre les jetons de node, les mots de passe des serveurs SQL et les secrets de double
authentification. Le remplacer rend tout cela illisible d'un coup : console en erreur 500, serveurs
de bases inutilisables, connexions 2FA impossibles.

Sauvegardez `apps/panel/.env` **avec** la base, et non séparément. Un dump SQL sans son secret ne
restaure qu'une moitié d'instance.

### 2. Le panel derrière TLS

Sans HTTPS, le cookie de session circule en clair : le voler suffit à prendre la main sur tous les
serveurs de son propriétaire. L'installeur pose un certificat Let's Encrypt quand un domaine est
fourni ; `hopper doctor` avertit tant que ce n'est pas le cas.

### 3. `/etc/hopper/daemon.yml` en 0600

Il contient le secret du node et la clé de signature des consoles. Quiconque le lit peut piloter tous
les serveurs de la machine. Le daemon **refuse de démarrer** si d'autres utilisateurs peuvent le
lire — c'est voulu, ne contournez pas la vérification.

### 4. Le pare-feu, dans `DOCKER-USER`

Docker écrit ses règles `iptables` avant celles d'ufw. Une règle ufw qui semble fermer le port d'un
conteneur ne ferme rien :

```bash
iptables -I DOCKER-USER -p tcp --dport 25565 ! -s 203.0.113.0/24 -j DROP
```

N'exposez à l'extérieur que le panel (80/443), le daemon (8443), le SFTP (2022) et les ports de jeu.
La base de données et Redis n'ont aucune raison d'être joignables.

### 5. La double authentification pour les administrateurs

Un compte administrateur peut créer un serveur, donc exécuter du code sur l'hôte. **Mon compte →
Double authentification** ; elle protège aussi le SFTP, qui partage les identifiants.

### 6. Les sauvegardes, hors de la machine

Une sauvegarde sur le même disque que les données ne protège que des erreurs humaines. Pointez
`system.backupDirectory` du daemon vers un autre disque, ou utilisez le pilote S3 (MinIO, Backblaze,
Wasabi) qui les envoie ailleurs.

## Ce que Hopper protège déjà

Vous n'avez rien à régler pour ce qui suit — c'est le comportement par défaut :

- **Conteneurs sans privilège** : `cap_drop: ALL`, `no-new-privileges`, limite de pids, jamais de
  `--privileged`, et le socket Docker n'est jamais monté dans un conteneur de serveur.
- **Prison de chemins** sur toutes les opérations de fichiers et le SFTP : chemin résolu par
  `realpath`, refus des symlinks qui sortent du volume, protection zip-slip à la décompression.
- **Jetons de node en deux parties** : identifiant public, secret haché en base, rotation par
  `hopper node:token`.
- **JWT de console de courte durée**, portant les permissions du porteur, vérifiés par le daemon —
  qui vérifie aussi l'origine de la connexion WebSocket.
- **Commandes de démarrage en gabarit**, jamais de concaténation passée à un shell.
- **Journal d'audit** de toutes les actions sensibles, consultable par serveur.
- **Limitation de débit** sur l'authentification, la 2FA et le SFTP.

## Après un incident

Si vous soupçonnez un vol d'identifiants :

```bash
hopper user:password --username <compte>   # ferme aussi toutes ses sessions
hopper node:token --node <node>            # invalide le jeton du daemon
systemctl restart hopperd
```

Puis relisez le journal d'activité de chaque serveur touché — il porte l'adresse IP et l'auteur de
chaque action — et changez les mots de passe des bases de données créées depuis le panel.
