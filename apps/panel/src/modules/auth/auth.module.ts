import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import { RateLimiterService } from '../../common/rate-limit/rate-limiter.service.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { PasskeyController } from './passkey.controller.js';
import { PasskeyService } from './passkey.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { ServerPermissionGuard } from './guards/server-permission.guard.js';
import { PasswordService } from './password.service.js';
import { ServerPermissionResolver } from './server-permission.resolver.js';
import { TokenService } from './token.service.js';
import { TotpService } from './totp.service.js';

/**
 * Global: `CryptoService` and `TokenService` are used by the servers and nodes
 * modules (signing console tokens, encrypting node secrets). Redeclaring them
 * elsewhere would create competing instances with the same derived keys, for no
 * benefit.
 *
 * Both guards are registered as `APP_GUARD`: authentication is the default
 * behaviour, anonymous access an exception marked `@Public()`.
 */
@Global()
@Module({
  imports: [AuditModule],
  controllers: [AuthController, PasskeyController],
  providers: [
    AuthService,
    PasskeyService,
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
