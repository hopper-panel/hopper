# Templates de serveurs

Un template décrit **ce qu'un serveur installe et exécute** : son image Docker, son script
d'installation, sa commande de démarrage et les variables que l'utilisateur peut régler. C'est
l'équivalent des « eggs » de Pterodactyl, et l'importeur les accepte tels quels.

Le catalogue livré couvre Vanilla, Paper, Purpur, Folia, Fabric, Forge, NeoForge, Velocity,
BungeeCord et Bedrock. **Administration → Templates → Resynchroniser** le réinstalle après une mise
à jour de Hopper ; un template modifié à la main est signalé « modifié » et n'est pas écrasé.

## Importer un egg Pterodactyl

Depuis **Administration → Templates**, envoyez le fichier JSON de l'egg. L'importeur traduit les
champs, conserve les variables et leurs règles de validation, et retient l'UUID de l'egg d'origine
pour ne pas l'importer deux fois.

Deux différences à connaître :

- Les images Docker de l'egg sont conservées telles quelles. Un egg qui référence
  `ghcr.io/pterodactyl/yolks:java_21` continuera de l'utiliser — l'image publique existe, rien à
  faire, mais vous dépendez alors de son dépôt.
- Les scripts d'installation d'un egg s'exécutent dans un conteneur jetable monté sur
  `/mnt/server`, exactement comme chez Pterodactyl.

## Écrire un template

Les templates livrés sont du TypeScript dans `packages/templates/src/catalog/`. Un template minimal :

```ts
{
  key: 'mon-serveur',            // identifiant stable : sert de clé de mise à jour
  group: TEMPLATE_GROUPS.JAVA,
  name: 'Mon serveur',
  description: 'Ce que ce template installe.',

  dockerImages: JAVA_IMAGES,     // la première est proposée par défaut
  startup: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}',
  stopCommand: 'command:stop',   // ou `signal:SIGTERM`
  startupDetection: BUKKIT_STARTUP_DETECTION,

  configFiles: [SERVER_PROPERTIES_CONFIG],
  installScript: '…',            // bash, exécuté dans un conteneur jetable

  variables: [
    {
      name: 'Version de Minecraft',
      envVariable: 'MINECRAFT_VERSION',
      defaultValue: '1.21.4',
      userEditable: true,
      rules: 'required|string|max:20',
    },
  ],
}
```

### La commande de démarrage

`startup` est un **gabarit à variables**, jamais une chaîne passée à un shell. Les `{{VARIABLE}}`
sont remplacées par des valeurs validées, puis la commande est découpée en arguments. Un utilisateur
qui saisirait `server.jar; rm -rf /` dans une variable obtiendrait un argument inutilisable, pas une
seconde commande.

Trois variables sont fournies par Hopper :

| Variable            | Valeur                                                         |
| ------------------- | -------------------------------------------------------------- |
| `{{SERVER_MEMORY}}` | Budget de tas, en Mio — **inférieur** à la limite du conteneur |
| `{{SERVER_IP}}`     | IP de l'allocation principale                                  |
| `{{SERVER_PORT}}`   | Port de l'allocation principale                                |

`SERVER_MEMORY` n'est pas la limite du conteneur : la JVM consomme au-delà de son tas — métaspace,
piles de threads, tampons directs — et le cache de pages du noyau est compté dans la limite du
cgroup. Hopper réserve donc une marge, faute de quoi un serveur d'1 Gio est tué par le noyau avant
d'avoir fini de démarrer.

### Les règles de validation

`rules` suit la syntaxe de Laravel, pour rester compatible avec les eggs :
`required|string|max:20`, `nullable|integer|min:1|max:65535`, `required|in:true,false`.

Une variable `userEditable` entre dans la commande de démarrage : c'est une entrée utilisateur qui
influe sur ce que la JVM exécute. Le défaut est donc « non modifiable », et chaque exception doit
être un choix conscient — avec des règles assez étroites pour n'accepter que ce qui a un sens.

### La détection du démarrage

`startupDetection` est une expression régulière cherchée dans la sortie du serveur. Tant qu'elle
n'apparaît pas, le serveur reste `starting` ; il passe `running` à la première correspondance. Pour
un serveur Bukkit, c'est la ligne `Done (12.345s)! For help, type "help"`.

Sans elle, le serveur est déclaré `running` dès que le conteneur tourne — donc bien avant d'accepter
un joueur.

### Le script d'installation

Il s'exécute dans un conteneur éphémère (`debian:bookworm-slim` par défaut), avec le volume du
serveur monté sur `/mnt/server`. Ses journaux sont diffusés dans la console pendant l'installation.

Trois règles apprises à la relecture des scripts existants :

1. `set -euo pipefail` en tête. Sans lui, un téléchargement en échec laisse un volume à moitié rempli
   et une installation déclarée réussie.
2. `curl --fail` toujours. L'API v2 de PaperMC, depuis son arrêt, répond « 200 » avec un corps
   d'erreur : sans `--fail`, on obtient un `.jar` de zéro octet et un serveur qui refuse de démarrer
   sans rien expliquer.
3. Vérifier ce qui a été téléchargé — taille non nulle, somme de contrôle quand l'API en publie une.

## Fichiers de configuration

`configFiles` décrit les fichiers que Hopper patche au démarrage, pour que le serveur écoute bien sur
l'allocation qui lui a été attribuée. `SERVER_PROPERTIES_CONFIG` s'occupe de `server-ip`,
`server-port` et `query.port` dans `server.properties`.

Sans cela, un joueur qui modifie `server-port` dans l'éditeur de fichiers rendrait son serveur
injoignable — et l'allocation affichée par le panel serait un mensonge.
