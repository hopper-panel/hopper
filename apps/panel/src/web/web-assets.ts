import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/**
 * Service de l'interface web par le panel lui-même.
 *
 * En développement, Vite sert le front sur son propre port et procure le
 * rechargement à chaud ; le panel n'expose alors que l'API. En production il n'y
 * a plus de Vite, et sans ce module le panel répondait 404 sur `/` : l'API
 * fonctionnait, mais il n'y avait tout simplement pas d'interface.
 *
 * Servir le front depuis le même processus évite en prime une seconde origine,
 * donc tout le CORS et les cookies inter-sites qui vont avec.
 */

/** Jeton d'injection du chemin absolu de l'interface construite. */
export const WEB_ROOT_TOKEN = 'WEB_ROOT_PATH';

/**
 * Résout `WEB_ROOT` en chemin absolu.
 *
 * Un chemin relatif est interprété depuis le répertoire de travail du
 * processus — `apps/panel` pour l'unité systemd — et non depuis la position du
 * code compilé, qui n'est pas une donnée de configuration.
 */
export function resolveWebRoot(configured: string, cwd: string): string {
  return resolve(cwd, configured);
}

/**
 * Vrai si le chemin demandé relève de l'API plutôt que de l'interface.
 *
 * Le repli SPA ne doit jamais s'appliquer à l'API : une route inconnue sous
 * `/api` doit rester une 404, sans quoi un client recevrait du HTML là où il
 * attend du JSON et signalerait une panne incompréhensible.
 */
export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/**
 * Politique de cache d'un fichier statique.
 *
 * Vite appose une empreinte au nom des fichiers de `assets/` : leur contenu ne
 * change jamais sous un même nom, ils sont donc immuables. `index.html`, lui,
 * référence ces noms et doit être revalidé à chaque fois, faute de quoi un
 * navigateur continuerait de charger l'ancienne application après une mise à
 * jour.
 */
export function cacheControlFor(pathname: string): string {
  return pathname.startsWith('/assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache, must-revalidate';
}

export interface WebAssetsResult {
  served: boolean;
  root: string;
}

/**
 * Branche le service des fichiers statiques, s'ils ont été construits.
 *
 * L'absence de build n'est pas fatale : le panel reste utilisable en API pure,
 * ce qui est exactement la situation en développement. Elle est en revanche
 * signalée, car en production c'est une erreur de déploiement.
 *
 * Le repli vers `index.html` n'est pas posé ici mais par `WebController` :
 * Nest installe son propre gestionnaire 404 sur l'instance Fastify, et en
 * poser un second fait échouer le démarrage.
 */
export async function registerWebAssets(
  app: NestFastifyApplication,
  options: { webRoot: string; cwd?: string },
): Promise<WebAssetsResult> {
  const root = resolveWebRoot(options.webRoot, options.cwd ?? process.cwd());

  if (!existsSync(join(root, 'index.html'))) {
    return { served: false, root };
  }

  const { default: fastifyStatic } = await import('@fastify/static');

  await app.getHttpAdapter().getInstance().register(fastifyStatic, {
    root,
    // Sans cette option, le greffon pose sa propre route générique `/*`, qui
    // entrerait en conflit avec celle de `WebController`. À `false`, il
    // n'enregistre que les fichiers réellement présents — ce qui suffit pour
    // un build figé.
    wildcard: false,
    // Le greffon poserait sinon son propre `public, max-age=0` par-dessus, et
    // les fichiers empreintés seraient revalidés à chaque chargement de page.
    cacheControl: false,
    setHeaders,
  });

  return { served: true, root };
}

function setHeaders(response: { setHeader: (name: string, value: string) => void }, path: string) {
  const normalized = path.replace(/\\/g, '/');
  const assetsAt = normalized.lastIndexOf('/assets/');
  response.setHeader('cache-control', cacheControlFor(assetsAt === -1 ? '/' : '/assets/'));
}
