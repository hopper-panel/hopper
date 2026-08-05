import type { Permission } from '@hopper/shared';
import { useOutletContext } from 'react-router-dom';
import type { ServerSummary } from './api';
import type { ConsoleController } from './use-console';

/**
 * Context shared by all of a server's tabs.
 *
 * Provided by `ServerLayout`, which loads the server, its permissions and the
 * console **once**. Each page used to redo those requests on its own account:
 * switching tabs reopened a WebSocket and requeried the API for identical data.
 */
export interface ServerContext {
  server: ServerSummary;
  permissions: Permission[];
  controller: ConsoleController;
  /**
   * Does the caller hold this permission?
   *
   * The permissions come from the API and not from the WebSocket: the files and
   * the backups have to stay usable even when the console is unreachable.
   */
  can: (permission: Permission) => boolean;
}

export function useServerContext(): ServerContext {
  return useOutletContext<ServerContext>();
}
