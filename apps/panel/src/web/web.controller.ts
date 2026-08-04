import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Get, Inject, NotFoundException, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../modules/auth/decorators.js';
import { WEB_ROOT_TOKEN, isApiPath } from './web-assets.js';

/**
 * Fallback for the client-routed application.
 *
 * `@fastify/static` serves the files actually present; everything else lands
 * here. A React application resolves its own routes, so reloading
 * `/servers/abc` has to return `index.html` rather than a 404.
 *
 * Fastify's router prefers static routes to a catch-all: the API controllers
 * therefore keep priority, and only URLs matching nothing land here.
 */
@Controller()
export class WebController {
  constructor(@Inject(WEB_ROOT_TOKEN) private readonly webRoot: string) {}

  @Public()
  // An anonymous wildcard, not `*path`: Fastify's router requires the star to
  // be the last character of the route. The named form, valid in Express, makes
  // startup fail.
  @Get('*')
  fallback(@Req() request: FastifyRequest, @Res() reply: FastifyReply): void {
    const pathname = request.url.split('?')[0] ?? '';

    // An unknown route under `/api` has to stay a 404: returning HTML to a
    // client expecting JSON turns a URL typo into an incomprehensible
    // failure.
    if (isApiPath(pathname)) {
      throw new NotFoundException(`Route ${request.method} ${pathname} introuvable.`);
    }

    const indexPath = join(this.webRoot, 'index.html');

    if (!existsSync(indexPath)) {
      throw new NotFoundException('The interface has not been built.');
    }

    void reply
      .status(200)
      .header('content-type', 'text/html; charset=utf-8')
      // `index.html` references digest-stamped files: caching it would load the
      // old application after an update.
      .header('cache-control', 'no-cache, must-revalidate')
      .send(createReadStream(indexPath));
  }
}
