import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { DatabaseHostsController } from './database-hosts.controller.js';
import { DatabasesController } from './databases.controller.js';
import { DatabasesService } from './databases.service.js';
import { MysqlClientService } from './mysql-client.service.js';

/**
 * Bases de données par serveur.
 *
 * Les **hosts** — les serveurs MySQL sur lesquels les bases sont créées — sont
 * administrés séparément : déclarer un host revient à confier au panel un
 * compte qui a tous les droits sur ce serveur SQL, ce qui n'est pas du ressort
 * de l'utilisateur d'un serveur Minecraft.
 */
@Module({
  // `CryptoService` vient d'`AuthModule`, qui est global.
  imports: [AuditModule],
  controllers: [DatabasesController, DatabaseHostsController],
  providers: [DatabasesService, MysqlClientService],
})
export class DatabasesModule {}
