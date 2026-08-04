import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from './config/environment.js';
import { ActivityModule } from './modules/activity/activity.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AllocationsModule } from './modules/allocations/allocations.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BackupsModule } from './modules/backups/backups.module.js';
import { DatabasesModule } from './modules/databases/databases.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { NodesModule } from './modules/nodes/nodes.module.js';
import { RemoteModule } from './modules/remote/remote.module.js';
import { SchedulesModule } from './modules/schedules/schedules.module.js';
import { ServersModule } from './modules/servers/servers.module.js';
import { SettingsModule } from './modules/settings/settings.module.js';
import { StartupModule } from './modules/startup/startup.module.js';
import { SubusersModule } from './modules/subusers/subusers.module.js';
import { TemplatesModule } from './modules/templates/templates.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { WebModule } from './web/web.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnvironment,
      // `.env.example` n'est jamais chargé : il ne contient que des valeurs de
      // démonstration et masquerait une variable réellement manquante.
      envFilePath: ['.env'],
    }),
    PrismaModule,
    AuditModule,
    AuthModule,
    UsersModule,
    NodesModule,
    TemplatesModule,
    ServersModule,
    BackupsModule,
    SchedulesModule,
    SubusersModule,
    AllocationsModule,
    StartupModule,
    SettingsModule,
    DatabasesModule,
    ActivityModule,
    RemoteModule,
    HealthModule,
    // En dernier : sa route générique sert de repli à l'interface et ne doit
    // être atteinte qu'une fois toutes les routes d'API écartées.
    WebModule,
  ],
})
export class AppModule {}
