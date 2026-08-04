import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply } from 'fastify';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import type { Environment } from '../../config/environment.js';
import {
  changePasswordSchema,
  disableTwoFactorSchema,
  loginSchema,
  passwordSetupSchema,
  refreshSchema,
  totpCodeSchema,
  type ChangePasswordDto,
  type DisableTwoFactorDto,
  type LoginDto,
  type RefreshDto,
  type TotpCodeDto,
} from './auth.dto.js';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service.js';
import { AuthService, type RequestContext } from './auth.service.js';
import { Public } from './decorators.js';
import { CurrentUser, type AuthenticatedRequest, type RequestUser } from './request-user.js';
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS } from './token.service.js';

const ACCESS_COOKIE = 'hopper_access';
const REFRESH_COOKIE = 'hopper_refresh';

@Controller('api/auth')
export class AuthController {
  private readonly secureCookies: boolean;

  constructor(
    private readonly auth: AuthService,
    private readonly settings: InstanceSettingsService,
    config: ConfigService<Environment, true>,
  ) {
    // `Secure` would break signing in during development on http://localhost.
    this.secureCookies = config.get('APP_URL', { infer: true }).startsWith('https://');
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const result = await this.auth.login(
      body.identifier,
      body.password,
      body.totpCode,
      this.contextOf(request),
    );

    if (result.status === 'two-factor-required') {
      return { status: 'two-factor-required' };
    }

    this.setAuthCookies(reply, result.accessToken, result.refreshToken);

    return {
      status: 'authenticated',
      user: result.user,
      // Returned in the body too, for non-browser clients (CLI,
      // scripts). The web interface itself relies on cookies only.
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body(new ZodValidationPipe(refreshSchema)) body: RefreshDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const token = body.refreshToken ?? request.cookies?.[REFRESH_COOKIE];

    if (!token) {
      throw new UnauthorizedException('No refresh token supplied.');
    }

    const result = await this.auth.refresh(token, this.contextOf(request));
    this.setAuthCookies(reply, result.accessToken, result.refreshToken);

    return {
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Body(new ZodValidationPipe(refreshSchema)) body: RefreshDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const token = body.refreshToken ?? request.cookies?.[REFRESH_COOKIE];

    if (token) {
      await this.auth.logout(token, this.contextOf(request));
    }

    // Cookies are cleared even without a valid token: a client in an
    // inconsistent state must always be able to get back to a clean one.
    this.clearAuthCookies(reply);
  }

  @Get('me')
  async me(@CurrentUser() user: RequestUser): Promise<Record<string, unknown>> {
    const settings = await this.settings.all();
    const account = await this.auth.describeAccount(user.id);

    return {
      uuid: user.uuid,
      username: user.username,
      email: user.email,
      role: user.role,
      panelName: settings.panelName,
      twoFactorEnabled: account.twoFactorEnabled,
      /**
       * The interface uses it to bar access until the second factor is on.
       * The requirement cannot be enforced at sign-in: one has to be signed in
       * to turn a second factor on.
       */
      mustEnableTwoFactor:
        !account.twoFactorEnabled &&
        (settings.twoFactorRequirement === 'all' ||
          (settings.twoFactorRequirement === 'admins' && user.role === 'ADMIN')),
    };
  }

  /**
   * Choosing the initial password, from the link received by email.
   *
   * Public out of necessity: its bearer has no password yet, so no session.
   * The signed token stands in for authentication.
   */
  @Post('password-setup')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  async setupPassword(
    @Body(new ZodValidationPipe(passwordSetupSchema)) body: { token: string; password: string },
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.auth.setPasswordFromToken(body.token, body.password, this.contextOf(request));
  }

  @Post('password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(
    @Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePasswordDto,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.auth.changePassword(
      user.id,
      body.currentPassword,
      body.newPassword,
      this.contextOf(request),
    );

    // Every session was just revoked, this one included.
    this.clearAuthCookies(reply);
  }

  @Post('2fa/setup')
  @HttpCode(HttpStatus.OK)
  async beginTwoFactor(@CurrentUser() user: RequestUser): Promise<Record<string, unknown>> {
    return this.auth.beginTwoFactorSetup(user.id);
  }

  @Post('2fa/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmTwoFactor(
    @Body(new ZodValidationPipe(totpCodeSchema)) body: TotpCodeDto,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    return this.auth.confirmTwoFactorSetup(user.id, body.code, this.contextOf(request));
  }

  @Post('2fa/disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  async disableTwoFactor(
    @Body(new ZodValidationPipe(disableTwoFactorSchema)) body: DisableTwoFactorDto,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.auth.disableTwoFactor(user.id, body.password, this.contextOf(request));
  }

  // -------------------------------------------------------------------------

  private contextOf(request: AuthenticatedRequest): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  /**
   * The refresh token is restricted to `/api/auth`: it has no reason to be
   * sent with every API call, and limiting its path shrinks the surface in case
   * of an XSS flaw or an over-talkative proxy log.
   */
  private setAuthCookies(reply: FastifyReply, accessToken: string, refreshToken: string): void {
    reply.setCookie(ACCESS_COOKIE, accessToken, {
      httpOnly: true,
      secure: this.secureCookies,
      sameSite: 'lax',
      path: '/',
      maxAge: ACCESS_TOKEN_TTL_SECONDS,
    });

    reply.setCookie(REFRESH_COOKIE, refreshToken, {
      httpOnly: true,
      secure: this.secureCookies,
      sameSite: 'lax',
      path: '/api/auth',
      maxAge: REFRESH_TOKEN_TTL_SECONDS,
    });
  }

  private clearAuthCookies(reply: FastifyReply): void {
    reply.clearCookie(ACCESS_COOKIE, { path: '/' });
    reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
  }
}
