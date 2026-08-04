import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { DatabaseHostsController } from './database-hosts.controller.js';
import { DatabasesController } from './databases.controller.js';
import { DatabasesService } from './databases.service.js';
import { MysqlClientService } from './mysql-client.service.js';

/**
 * Per-server databases.
 *
 * The **hosts** — the MySQL servers the databases are created on — are
 * administered separately: declaring a host means handing the panel an account
 * with every right on that SQL server, which is not a Minecraft server user's
 * business.
 */
@Module({
  // `CryptoService` comes from `AuthModule`, which is global.
  imports: [AuditModule],
  controllers: [DatabasesController, DatabaseHostsController],
  providers: [DatabasesService, MysqlClientService],
})
export class DatabasesModule {}
