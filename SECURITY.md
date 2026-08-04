# Politique de sécurité

Hopper exécute du code arbitraire (les serveurs Minecraft et leurs plugins), expose un système de
fichiers via HTTP et SFTP, et pilote le démon Docker de la machine hôte. Une faille ici ne se limite
pas à un serveur de jeu : elle peut donner un accès root à l'hôte.

## Signaler une vulnérabilité

**N'ouvrez pas d'issue publique.**

Utilisez l'onglet **Security → Report a vulnerability** du dépôt GitHub (GitHub Security Advisories),
ou écrivez à `security@hopperpanel.io`.

Merci d'inclure :

- une description de la faille et de son impact ;
- les étapes de reproduction, ou un proof of concept ;
- la version de Hopper, l'OS et la version de Docker concernés.

Engagements :

|                                    |                                            |
| ---------------------------------- | ------------------------------------------ |
| Accusé de réception                | sous 48 h                                  |
| Première évaluation                | sous 7 jours                               |
| Correctif pour une faille critique | sous 14 jours                              |
| Divulgation                        | coordonnée, après publication du correctif |

Les personnes qui signalent une faille sont créditées dans l'avis de sécurité, sauf demande contraire.

## Périmètre

Sont dans le périmètre :

- **Évasion de chemin** dans le gestionnaire de fichiers ou le SFTP (traversée, symlinks, zip-slip) ;
- **Évasion de conteneur** ou élévation de privilèges vers l'hôte ;
- **Contournement d'authentification** ou d'autorisation, y compris entre sous-utilisateurs ;
- **Injection de commandes** via les variables de démarrage ou les templates ;
- **Forge de jeton** : jetons de node, JWT de console, URL de téléchargement signées ;
- **SSRF** depuis le panel vers un daemon ou une adresse interne ;
- Exposition de secrets dans les logs, les réponses d'API ou l'interface.

Sont hors périmètre :

- les problèmes qui exigent un accès administrateur déjà légitime au panel ;
- l'auto-DoS par un opérateur sur sa propre instance ;
- les vulnérabilités des serveurs Minecraft ou des plugins eux-mêmes ;
- les mauvaises configurations documentées comme telles (ex. exposer le daemon en HTTP nu).

## Modèle de menace

Hopper part du principe que **l'utilisateur d'un serveur est hostile**. Un opérateur de serveur peut
uploader n'importe quel plugin, exécuter n'importe quelle commande dans sa console et écrire
n'importe quel fichier dans son volume. Les garde-fous suivants ne sont donc pas négociables :

1. **Jail de chemins.** Toute opération sur les fichiers passe par une abstraction unique qui résout
   le chemin réel et refuse tout ce qui sort du volume du serveur, symlinks compris.
2. **Durcissement des conteneurs.** Jamais de `--privileged`, capabilities droppées,
   `no-new-privileges`, limite de PID, et le socket Docker n'est jamais monté dans un conteneur de
   serveur.
3. **Jetons en deux parties.** Les jetons de node et les clés d'API sont stockés hashés ; seul
   l'identifiant public est en clair, et ils sont révocables.
4. **JWT de console de courte durée**, portant les permissions, vérifié par le daemon à chaque
   connexion.
5. **Pas de shell.** Les commandes de démarrage sont des gabarits à variables validées, jamais une
   concaténation de chaînes passée à un interpréteur.

## Versions supportées

Le projet étant en pré-alpha, seule la branche `main` reçoit des correctifs de sécurité. Cette
section sera mise à jour à la sortie de la 1.0.
