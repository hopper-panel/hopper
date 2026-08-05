import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from './config/environment.js';
import { ActivityModule } from './modules/activity/activity.module.js';
import { ApiKeysModule } from './modules/api-keys/api-keys.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AllocationsModule } from './modules/allocations/allocations.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BackupsModule } from './modules/backups/backups.module.js';
import { DatabasesModule } from './modules/databases/databases.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { InstanceSettingsModule } from './modules/instance-settings/instance-settings.module.js';
import { NodesModule } from './modules/nodes/nodes.module.js';
import { RemoteModule } from './modules/remote/remote.module.js';
import { SchedulesModule } from './modules/schedules/schedules.module.js';
import { ServersModule } from './modules/servers/servers.module.js';
import { SettingsModule } from './modules/settings/settings.module.js';
import { StartupModule } from './modules/startup/startup.module.js';
import { SubusersModule } from './modules/subusers/subusers.module.js';
import { TemplatesModule } from './modules/templates/templates.module.js';
import { UpdatesModule } from './modules/updates/updates.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { WebhooksModule } from './modules/webhooks/webhooks.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { WebModule } from './web/web.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnvironment,
      // `.env.example` is never loaded: it holds demonstration values only and
      // would mask a genuinely missing variable.
      envFilePath: ['.env'],
    }),
    PrismaModule,
    AuditModule,
    AuthModule,
    ApiKeysModule,
    InstanceSettingsModule,
    UsersModule,
    NodesModule,
    TemplatesModule,
    UpdatesModule,
    ServersModule,
    BackupsModule,
    SchedulesModule,
    SubusersModule,
    AllocationsModule,
    StartupModule,
    SettingsModule,
    DatabasesModule,
    ActivityModule,
    WebhooksModule,
    RemoteModule,
    HealthModule,
    // Last: its catch-all route is the interface's fallback and must only be
    // reached once every API route has been ruled out.
    WebModule,
  ],
})
export class AppModule {}
