import 'reflect-metadata';

import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import type { Environment } from './config/environment.js';
import { PANEL_VERSION } from './version.js';
import { registerWebAssets } from './web/web-assets.js';

/**
 * Byte sizes are stored as `BigInt` — a PostgreSQL `integer` tops out at 2.1 GB,
 * which is enough for neither a node's RAM nor a disk. `JSON.stringify` refuses
 * BigInt, which would produce a 500 on any response containing a server. The
 * values handled (bytes of a disk, of a RAM) stay far below 2^53, so the
 * conversion to `number` is exact.
 */
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function toJSON(this: bigint) {
  return Number(this);
};

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      trustProxy: true,
      genReqId: () => crypto.randomUUID(),
    }),
    { bufferLogs: true },
  );

  const config = app.get(ConfigService<Environment, true>);
  const logger = new Logger('Bootstrap');

  const appUrl = config.get('APP_URL', { infer: true });
  const isProduction = config.get('NODE_ENV', { infer: true }) === 'production';

  // The file-upload relay passes the request body on to the daemon as is.
  // Without this parser, Fastify would try to parse a binary — and refuse with
  // a 415 before ever reaching the controller.
  app
    .getHttpAdapter()
    .getInstance()
    .addContentTypeParser('application/octet-stream', (_request, _payload, done) => {
      done(null, undefined);
    });

  const appSecret: string = config.get('APP_SECRET', { infer: true });
  await app.register(fastifyCookie, { secret: appSecret });

  await app.register(fastifyHelmet, {
    // Off in development: the default policy would break Vite's hot reload.
    contentSecurityPolicy: isProduction
      ? {
          useDefaults: true,
          directives: {
            // The console and the statistics open a WebSocket **to the
            // daemon**, not to the panel — that is what keeps the panel from
            // being a bottleneck. That daemon lives on another host and
            // another port, so on another origin: the default `'self'` would
            // block the console without a single message on the server side.
            // Since nodes are declared at runtime, their origins cannot be
            // enumerated here.
            'connect-src': ["'self'", 'ws:', 'wss:'],
            // Vite emits no inline script; the default value is enough and
            // forbids injection.
            'script-src': ["'self'"],
            // `upgrade-insecure-requests` also rewrites `ws://` into `wss://`.
            // On a panel served over HTTP — an internal install, or before the
            // reverse proxy is in place — that would cut the console off in
            // favour of encryption the daemon does not offer yet. The directive
            // only makes sense if the panel itself is on HTTPS.
            ...(appUrl.startsWith('https://') ? {} : { 'upgrade-insecure-requests': null }),
          },
        }
      : false,
    crossOriginEmbedderPolicy: false,
  });

  // The development front runs on a different port from the API. In
  // production, the interface is served by the panel itself: no third-party
  // origin needs to reach the API with cookies.
  await app.register(fastifyCors, {
    origin: isProduction ? [appUrl] : [appUrl, 'http://localhost:5173'],
    credentials: true,
  });

  // No global ValidationPipe: validation goes through the shared package's Zod
  // schemas, via ZodValidationPipe declared route by route.
  app.enableShutdownHooks();

  const web = await registerWebAssets(app, {
    webRoot: config.get('WEB_ROOT', { infer: true }),
  });

  const host = config.get('HOST', { infer: true });
  const port = config.get('PORT', { infer: true });

  await app.listen({ host, port });

  logger.log(`Hopper Panel ${PANEL_VERSION} listening on http://${host}:${port}`);

  if (web.served) {
    logger.log(`Interface served from ${web.root}`);
  } else if (isProduction) {
    // In production this is a deployment mistake: the API answers, but the
    // browser receives nothing. Saying so plainly saves a search through the
    // reverse proxy.
    logger.error(
      `Interface not found in ${web.root} — run "pnpm build"; ` +
        `the panel will answer as an API only.`,
    );
  } else {
    logger.log('Interface not built: in development, Vite serves it.');
  }
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`\n✖ The panel failed to start:\n${String(error)}\n\n`);
  process.exit(1);
});
