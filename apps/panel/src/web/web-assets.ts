import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/**
 * Serving the web interface from the panel itself.
 *
 * In development, Vite serves the front on its own port and provides hot
 * reloading; the panel then exposes the API only. In production there is no
 * Vite any more, and without this module the panel answered 404 on `/`: the API
 * worked, but there simply was no interface.
 *
 * Serving the front from the same process also avoids a second origin, and with
 * it all the CORS and cross-site cookies that come along.
 */

/** Jeton d'injection du chemin absolu de l'interface construite. */
export const WEB_ROOT_TOKEN = 'WEB_ROOT_PATH';

/**
 * Resolves `WEB_ROOT` into an absolute path.
 *
 * A relative path is read from the process's working directory — `apps/panel`
 * for the systemd unit — and not from where the compiled code sits, which is
 * not a piece of configuration.
 */
export function resolveWebRoot(configured: string, cwd: string): string {
  return resolve(cwd, configured);
}

/**
 * True if the requested path belongs to the API rather than the interface.
 *
 * The SPA fallback must never apply to the API: an unknown route under `/api`
 * has to stay a 404, otherwise a client would receive HTML where it expects
 * JSON and would report an incomprehensible failure.
 */
export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/**
 * Cache policy for a static file.
 *
 * Vite stamps a digest into the names of the files in `assets/`: their content
 * never changes under a given name, so they are immutable. `index.html` in
 * contrast references those names and has to be revalidated every time, failing
 * which a browser would keep loading the old application after an update.
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
 * Wires up static file serving, if the front has been built.
 *
 * A missing build is not fatal: the panel stays usable as a pure API, which is
 * exactly the situation in development. It is reported all the same, because in
 * production it is a deployment mistake.
 *
 * The fallback to `index.html` is not set here but by `WebController`: Nest
 * installs its own 404 handler on the Fastify instance, and adding a second
 * makes startup fail.
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
    // Without this option the plugin registers its own catch-all `/*` route,
    // which would conflict with `WebController`'s. At `false` it only registers
    // the files actually present — which is enough for a frozen build.
    wildcard: false,
    // The plugin would otherwise lay its own `public, max-age=0` on top, and
    // the digest-stamped files would be revalidated on every page load.
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
