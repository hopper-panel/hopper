import type { Permission } from '@hopper/shared';
import { useOutletContext } from 'react-router-dom';
import type { ServerSummary } from './api';
import type { ConsoleController } from './use-console';

/**
 * Contexte partagé par tous les onglets d'un serveur.
 *
 * Fourni par `ServerLayout`, qui charge le serveur, ses permissions et la
 * console **une seule fois**. Auparavant chaque page refaisait ces requêtes
 * pour son propre compte : changer d'onglet rouvrait un WebSocket et
 * réinterrogeait l'API pour des données identiques.
 */
export interface ServerContext {
  server: ServerSummary;
  permissions: Permission[];
  controller: ConsoleController;
  /**
   * L'appelant dispose-t-il de cette permission ?
   *
   * Les permissions viennent de l'API et non du WebSocket : les fichiers et les
   * sauvegardes doivent rester utilisables même quand la console est
   * injoignable.
   */
  can: (permission: Permission) => boolean;
}

export function useServerContext(): ServerContext {
  return useOutletContext<ServerContext>();
}
