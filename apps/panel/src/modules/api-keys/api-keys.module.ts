import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ApiKeysController } from './api-keys.controller.js';
import { ApiKeysService } from './api-keys.service.js';

/**
 * Clés d'API.
 *
 * Global : le garde d'authentification, enregistré une fois pour toute
 * l'application, doit pouvoir s'injecter le service sans que chaque module ait
 * à importer celui-ci.
 */
@Global()
@Module({
  imports: [AuditModule],
  controllers: [ApiKeysController],
  providers: [ApiKeysService],
  exports: [ApiKeysService],
})
export class ApiKeysModule {}
