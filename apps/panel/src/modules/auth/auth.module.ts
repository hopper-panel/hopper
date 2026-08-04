import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import { RateLimiterService } from '../../common/rate-limit/rate-limiter.service.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { ServerPermissionGuard } from './guards/server-permission.guard.js';
import { PasswordService } from './password.service.js';
import { ServerPermissionResolver } from './server-permission.resolver.js';
import { TokenService } from './token.service.js';
import { TotpService } from './totp.service.js';

/**
 * Global : `CryptoService` et `TokenService` sont utilisés par les modules
 * serveurs et nodes (signature des jetons de console, chiffrement des secrets
 * de node). Les redéclarer ailleurs créerait des instances concurrentes avec
 * les mêmes clés dérivées, sans bénéfice.
 *
 * Les deux gardes sont enregistrés en `APP_GUARD` : l'authentification est le
 * comportement par défaut, l'accès anonyme une exception marquée `@Public()`.
 */
@Global()
@Module({
  imports: [AuditModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    TotpService,
    CryptoService,
    RateLimiterService,
    ServerPermissionResolver,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ServerPermissionGuard },
  ],
  exports: [AuthService, TokenService, CryptoService, RateLimiterService, ServerPermissionResolver],
})
export class AuthModule {}
