import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Get, Inject, NotFoundException, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../modules/auth/decorators.js';
import { WEB_ROOT_TOKEN, isApiPath } from './web-assets.js';

/**
 * Repli de l'application à routage côté client.
 *
 * `@fastify/static` sert les fichiers réellement présents ; tout le reste
 * arrive ici. Une application React résout ses propres routes, donc recharger
 * `/servers/abc` doit rendre `index.html` plutôt qu'une 404.
 *
 * Le routeur de Fastify préfère les routes statiques à une route générique :
 * les contrôleurs de l'API gardent donc la priorité, et seules les URL qui ne
 * correspondent à rien atterrissent ici.
 */
@Controller()
export class WebController {
  constructor(@Inject(WEB_ROOT_TOKEN) private readonly webRoot: string) {}

  @Public()
  // Joker anonyme, et non `*path` : le routeur de Fastify exige que l'étoile
  // soit le dernier caractère de la route. La forme nommée, valable côté
  // Express, fait échouer le démarrage.
  @Get('*')
  fallback(@Req() request: FastifyRequest, @Res() reply: FastifyReply): void {
    const pathname = request.url.split('?')[0] ?? '';

    // Une route inconnue sous `/api` doit rester une 404 : renvoyer du HTML à
    // un client qui attend du JSON transforme une faute de frappe d'URL en
    // panne incompréhensible.
    if (isApiPath(pathname)) {
      throw new NotFoundException(`Route ${request.method} ${pathname} introuvable.`);
    }

    const indexPath = join(this.webRoot, 'index.html');

    if (!existsSync(indexPath)) {
      throw new NotFoundException("L'interface n'a pas été construite.");
    }

    void reply
      .status(200)
      .header('content-type', 'text/html; charset=utf-8')
      // `index.html` référence des fichiers empreintés : le mettre en cache
      // ferait charger l'ancienne application après une mise à jour.
      .header('cache-control', 'no-cache, must-revalidate')
      .send(createReadStream(indexPath));
  }
}
