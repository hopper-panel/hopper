import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import type { Environment } from '../../config/environment.js';
import { PasskeyService, type PasskeySummary } from './passkey.service.js';
import { Public } from './decorators.js';
import { CurrentUser, type AuthenticatedRequest, type RequestUser } from './request-user.js';
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS } from './token.service.js';

/**
 * The two ceremonies, and the list.
 *
 * `begin` and `finish` are separate calls because WebAuthn is two round trips:
 * the server picks a challenge, the authenticator signs it, the server checks
 * the signature it asked for. Merging them would mean trusting the browser to
 * supply the challenge, and a challenge chosen by the client is a signature
 * over whatever the client wanted signed.
 *
 * The authenticator's payloads are deliberately not validated field by field
 * here. `@simplewebauthn/server` parses and verifies them, and a second schema
 * guessing at the same structure would reject valid authenticators the day the
 * specification grows a field.
 */

const registerSchema = z.object({
  name: z.string().trim().min(1).max(60),
  response: z.record(z.string(), z.unknown()),
});

const authenticateSchema = z.object({
  response: z.record(z.string(), z.unknown()),
});

const renameSchema = z.object({
  name: z.string().trim().min(1).max(60),
});

const ACCESS_COOKIE = 'hopper_access';
const REFRESH_COOKIE = 'hopper_refresh';

@Controller('api/auth/passkeys')
export class PasskeyController {
  private readonly secureCookies: boolean;

  constructor(
    private readonly passkeys: PasskeyService,
    config: ConfigService<Environment, true>,
  ) {
    this.secureCookies = config.get('APP_URL', { infer: true }).startsWith('https://');
  }

  // -------------------------------------------------------------------------
  // Signing in
  // -------------------------------------------------------------------------

  @Public()
  @Post('authenticate/begin')
  @HttpCode(HttpStatus.OK)
  async beginAuthentication(
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    return this.passkeys.beginAuthentication(this.contextOf(request));
  }

  @Public()
  @Post('authenticate/finish')
  @HttpCode(HttpStatus.OK)
  async finishAuthentication(
    @Body(new ZodValidationPipe(authenticateSchema)) body: { response: Record<string, unknown> },
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const result = await this.passkeys.finishAuthentication(
      body.response as never,
      this.contextOf(request),
    );

    if (result.status !== 'authenticated') {
      // `completeVerifiedLogin` never asks for a second factor — the
      // authenticator already did. Kept as a guard so a later change to that
      // method cannot quietly drop the step here.
      return { status: result.status };
    }

    this.setAuthCookies(reply, result.accessToken, result.refreshToken);

    return {
      status: 'authenticated',
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  // -------------------------------------------------------------------------
  // Managing one's own
  // -------------------------------------------------------------------------

  @Get()
  async list(@CurrentUser() user: RequestUser): Promise<PasskeySummary[]> {
    return this.passkeys.list(user.id);
  }

  @Post('register/begin')
  @HttpCode(HttpStatus.OK)
  async beginRegistration(@CurrentUser() user: RequestUser): Promise<Record<string, unknown>> {
    return this.passkeys.beginRegistration(user.id);
  }

  @Post('register/finish')
  @HttpCode(HttpStatus.CREATED)
  async finishRegistration(
    @Body(new ZodValidationPipe(registerSchema))
    body: { name: string; response: Record<string, unknown> },
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<PasskeySummary> {
    return this.passkeys.finishRegistration(
      user.id,
      body.response as never,
      body.name,
      this.contextOf(request),
    );
  }

  @Patch(':id')
  async rename(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(renameSchema)) body: { name: string },
    @CurrentUser() user: RequestUser,
  ): Promise<PasskeySummary> {
    return this.passkeys.rename(user.id, Number(id), body.name);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.passkeys.remove(user.id, Number(id), this.contextOf(request));
  }

  // -------------------------------------------------------------------------

  private contextOf(request: AuthenticatedRequest): { ip: string; userAgent?: string } {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  /** Identical to the password flow's: one session shape, one place it is set. */
  private setAuthCookies(reply: FastifyReply, accessToken: string, refreshToken: string): void {
    reply.setCookie(ACCESS_COOKIE, accessToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.secureCookies,
      path: '/',
      maxAge: ACCESS_TOKEN_TTL_SECONDS,
    });

    reply.setCookie(REFRESH_COOKIE, refreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.secureCookies,
      path: '/api/auth',
      maxAge: REFRESH_TOKEN_TTL_SECONDS,
    });
  }
}
