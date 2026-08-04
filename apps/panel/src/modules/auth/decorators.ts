import type { Permission } from '@hopper/shared';
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'hopper:public';
export const REQUIRED_ROLE_KEY = 'hopper:role';
export const REQUIRED_SERVER_PERMISSION_KEY = 'hopper:server-permission';

/**
 * Route accessible sans authentification.
 *
 * `JwtAuthGuard` est enregistré globalement : l'accès anonyme est donc une
 * exception explicite, jamais un oubli. Ajouter une route sans y penser la rend
 * protégée par défaut.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/** Réserve la route aux administrateurs du panel. */
export const AdminOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_ROLE_KEY, 'ADMIN');

/**
 * Exige une permission sur le serveur désigné par le paramètre de route
 * `:serverId` (son UUID). Active `ServerPermissionGuard`, qui résout le serveur
 * et les permissions effectives de l'appelant.
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
