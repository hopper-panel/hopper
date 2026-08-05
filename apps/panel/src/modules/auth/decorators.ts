import type { Permission } from '@hopper/shared';
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'hopper:public';
export const REQUIRED_ROLE_KEY = 'hopper:role';
export const REQUIRED_SERVER_PERMISSION_KEY = 'hopper:server-permission';

/**
 * Route reachable without authentication.
 *
 * `JwtAuthGuard` is registered globally: anonymous access is therefore an
 * explicit exception, never an oversight. Adding a route without thinking about
 * it leaves it protected by default.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

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
