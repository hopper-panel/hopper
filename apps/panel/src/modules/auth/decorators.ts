import type { Permission } from '@hopper/shared';
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'hopper:public';
export const REQUIRED_ROLE_KEY = 'hopper:role';
export const REQUIRED_SERVER_PERMISSION_KEY = 'hopper:server-permission';
export const IS_APPLICATION_API_KEY = 'hopper:application-api';

/**
 * Route reachable without authentication.
 *
 * `JwtAuthGuard` is registered globally: anonymous access is therefore an
 * explicit exception, never an oversight. Adding a route without thinking about
 * it leaves it protected by default.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Route of the application API: reachable **only** by an application key.
 *
 * The exclusion runs both ways, and that is the whole value of the decorator.
 * An application key opens nothing but these routes, so a credential sitting in
 * a billing server's configuration file cannot read a customer's files if it
 * leaks. And these routes refuse a session or a personal key, so an operator
 * cannot end up half-integrated — driving provisioning from a browser session
 * that expires, or from a key that dies with its owner's account, and
 * discovering the difference the day it stops.
 */
export const ApplicationApi = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_APPLICATION_API_KEY, true);

/** Reserves the route for panel administrators. */
export const AdminOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_ROLE_KEY, 'ADMIN');

/**
 * Requires a permission on the server designated by the `:serverId` route
 * parameter (its UUID). Activates `ServerPermissionGuard`, which resolves the
 * server and the caller's effective permissions.
 *
 * @example
 * ```ts
 * @Post(':serverId/power')
 * @RequireServerPermission(PERMISSIONS.CONTROL_START)
 * start(@CurrentServer() server: RequestServer) {}
 * ```
 */
export const RequireServerPermission = (...permissions: Permission[]): MethodDecorator =>
  SetMetadata(REQUIRED_SERVER_PERMISSION_KEY, permissions);
