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
 * Les tailles en octets sont stockées en `BigInt` — un `integer` PostgreSQL
 * plafonne à 2,1 Go, ce qui ne suffit ni pour la RAM d'un node ni pour un
 * disque. `JSON.stringify` refuse les BigInt, ce qui produirait une 500 sur
 * toute réponse contenant un serveur. Les valeurs manipulées (octets d'un
 * disque, d'une RAM) restent très en dessous de 2^53, donc la conversion en
 * `number` est exacte.
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

  // Le relais d'envoi de fichier retransmet le corps de la requête tel quel
  // vers le daemon. Sans ce parseur, Fastify tenterait d'analyser un binaire —
  // et refuserait en 415 avant même d'atteindre le contrôleur.
  app
    .getHttpAdapter()
    .getInstance()
    .addContentTypeParser('application/octet-stream', (_request, _payload, done) => {
      done(null, undefined);
    });

  const appSecret: string = config.get('APP_SECRET', { infer: true });
  await app.register(fastifyCookie, { secret: appSecret });

  await app.register(fastifyHelmet, {
    // Désactivée en développement : la politique par défaut casserait le
    // rechargement à chaud de Vite.
    contentSecurityPolicy: isProduction
      ? {
          useDefaults: true,
          directives: {
            // La console et les statistiques ouvrent un WebSocket **vers le
            // daemon**, pas vers le panel — c'est ce qui évite d'en faire un
            // goulot d'étranglement. Ce daemon vit sur un autre hôte et un
            // autre port, donc sur une autre origine : la valeur par défaut
            // `'self'` bloquerait la console sans le moindre message côté
            // serveur. Les nodes étant déclarés à l'exécution, leurs origines
            // ne peuvent pas être énumérées ici.
            'connect-src': ["'self'", 'ws:', 'wss:'],
            // Vite n'émet pas de script en ligne ; la valeur par défaut suffit
            // et interdit l'injection.
            'script-src': ["'self'"],
            // `upgrade-insecure-requests` réécrit aussi `ws://` en `wss://`.
            // Sur un panel servi en HTTP — installation interne, ou avant la
            // mise en place du reverse proxy — cela couperait la console au
            // profit d'un chiffrement que le daemon n'offre pas encore. La
            // directive n'a de sens que si le panel est lui-même en HTTPS.
            ...(appUrl.startsWith('https://') ? {} : { 'upgrade-insecure-requests': null }),
          },
        }
      : false,
    crossOriginEmbedderPolicy: false,
  });

  // Le front de développement tourne sur un autre port que l'API. En
  // production, l'interface est servie par le panel lui-même : aucune origine
  // tierce n'a besoin d'accéder à l'API avec des cookies.
  await app.register(fastifyCors, {
    origin: isProduction ? [appUrl] : [appUrl, 'http://localhost:5173'],
    credentials: true,
  });

  // Pas de ValidationPipe global : la validation passe par les schémas Zod du
  // paquet partagé, via ZodValidationPipe déclaré route par route.
  app.enableShutdownHooks();

  const web = await registerWebAssets(app, {
    webRoot: config.get('WEB_ROOT', { infer: true }),
  });

  const host = config.get('HOST', { infer: true });
  const port = config.get('PORT', { infer: true });

  await app.listen({ host, port });

  logger.log(`Hopper Panel ${PANEL_VERSION} à l'écoute sur http://${host}:${port}`);

  if (web.served) {
    logger.log(`Interface servie depuis ${web.root}`);
  } else if (isProduction) {
    // En production, c'est une erreur de déploiement : l'API répond, mais le
    // navigateur ne reçoit rien. Le dire clairement évite de chercher du côté
    // du reverse proxy.
    logger.error(
      `Interface introuvable dans ${web.root} — lancez « pnpm build » ; ` +
        `le panel ne répondra qu'en API.`,
    );
  } else {
    logger.log("Interface non construite : en développement, c'est Vite qui la sert.");
  }
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`\n✖ Échec du démarrage du panel :\n${String(error)}\n\n`);
  process.exit(1);
});
