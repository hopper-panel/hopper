import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Environment } from '../config/environment.js';
import { WEB_ROOT_TOKEN, resolveWebRoot } from './web-assets.js';
import { WebController } from './web.controller.js';

/**
 * Sert l'interface construite.
 *
 * Déclaré en dernier dans `AppModule` : sa route générique ne doit être
 * consultée qu'après les contrôleurs de l'API.
 */
@Module({
  controllers: [WebController],
  providers: [
    {
      provide: WEB_ROOT_TOKEN,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Environment, true>) =>
        resolveWebRoot(config.get('WEB_ROOT', { infer: true }), process.cwd()),
    },
  ],
})
export class WebModule {}
