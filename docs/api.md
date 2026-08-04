# API et notifications

## Clés d'API

**Mon compte → Clés d'API**. Une clé emprunte les accès de son propriétaire :
elle ne donne jamais accès à un serveur qu'il ne pourrait pas ouvrir lui-même.
Le jeton n'est affiché **qu'une fois**, à la création.

```bash
curl -H "Authorization: Bearer hpk_xxxxxxxxxxxxxxxx.yyyy…" \
     https://panel.example.com/api/servers
```

Trois portées, à cumuler :

| Portée  | Ce qu'elle autorise                                                   |
| ------- | --------------------------------------------------------------------- |
| `read`  | Les requêtes `GET` — consulter serveurs, fichiers, sauvegardes        |
| `write` | Les requêtes qui agissent — démarrer, écrire un fichier, sauvegarder  |
| `admin` | Les routes `/api/admin/*`, et seulement pour un compte administrateur |

Une clé de lecture ne peut pas éteindre un serveur : c'est le point de ces
portées. Le rôle du compte est revérifié à chaque requête, si bien qu'une
rétrogradation prend effet sans avoir à révoquer les clés une à une.

Une clé peut être restreinte à des adresses IP sources et recevoir une date
d'expiration. La liste d'adresses vide n'impose aucune restriction.

Quelques routes utiles :

```
GET    /api/servers                       liste des serveurs accessibles
GET    /api/servers/:uuid                 détail d'un serveur
POST   /api/servers/:uuid/power           {"action":"start|stop|restart|kill"}
GET    /api/servers/:uuid/files/list?path=/
POST   /api/servers/:uuid/backups         déclenche une sauvegarde
GET    /api/servers/:uuid/webhooks        notifications sortantes
```

La console, elle, ne s'ouvre pas avec une clé d'API : elle utilise un jeton de
très courte durée délivré par `GET /api/servers/:uuid/console`, que le
navigateur présente directement au daemon.

## Notifications sortantes

**Onglet Notifications** d'un serveur. Le panel appelle l'adresse de votre choix
à chaque événement souscrit : démarrage, arrêt, arrêt subi, sauvegarde et
installation.

L'adresse est vérifiée avant enregistrement **et avant chaque envoi** : celles
qui mènent à un réseau interne — boucle locale, adresses privées, service de
métadonnées du cloud — sont refusées. Sans ce contrôle, un sous-utilisateur
pourrait se faire livrer par le panel le contenu de votre réseau.

### Discord

Collez l'URL d'un webhook de salon : le message est mis en forme, coloré selon
la gravité et lié au serveur dans le panel. Rien d'autre à configurer.

### Autre destinataire

Le corps est un JSON stable :

```json
{
  "event": "server.crashed",
  "occurredAt": "2026-08-04T12:00:00.000Z",
  "server": {
    "uuid": "1b32d12d-…",
    "name": "Survie",
    "address": "jeu.example.com:25565",
    "url": "https://panel.example.com/server/1b32d12d-…"
  },
  "details": { "Cause": "tué par le noyau, mémoire insuffisante" }
}
```

Chaque requête porte `X-Hopper-Event` et `X-Hopper-Signature`, un HMAC-SHA256 du
corps. **Vérifiez-la** : l'URL d'un webhook finit toujours par circuler, et sans
signature n'importe qui pourrait fabriquer de fausses alertes. Le secret se
consulte depuis l'interface.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
const received = request.headers['x-hopper-signature'];

// Comparaison à temps constant : `===` s'arrête au premier octet différent.
const valid =
  expected.length === received.length &&
  timingSafeEqual(Buffer.from(expected), Buffer.from(received));
```

Une adresse qui échoue vingt fois d'affilée est mise en pause plutôt que
réessayée sans fin ; l'interface montre le dernier code de réponse et la
réactive d'un clic.
