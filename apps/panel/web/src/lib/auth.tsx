import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, type CurrentUser } from './api';

interface LoginInput {
  identifier: string;
  password: string;
  totpCode?: string;
}

type LoginResponse =
  { status: 'authenticated'; user: CurrentUser } | { status: 'two-factor-required' };

interface AuthContextValue {
  user: CurrentUser | null;
  isLoading: boolean;
  login: (input: LoginInput) => Promise<LoginResponse>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: async () => {
      try {
        return await api.get<CurrentUser>('/api/auth/me');
      } catch (error) {
        // Pas de session : ce n'est pas une panne, c'est l'état normal d'un
        // visiteur non connecté. Retourner null évite d'afficher une erreur.
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          return null;
        }
        throw error;
      }
    },
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  const loginMutation = useMutation({
    mutationFn: (input: LoginInput) => api.post<LoginResponse>('/api/auth/login', input),
    onSuccess: (result) => {
      if (result.status === 'authenticated') {
        queryClient.setQueryData(['auth', 'me'], result.user);
      }
    },
  });

  const logoutMutation = useMutation({
    mutationFn: () => api.post<void>('/api/auth/logout', {}),
    onSettled: () => {
      // Le cache est vidé même si l'appel échoue : rester sur une interface
      // peuplée alors qu'on croit être déconnecté est pire qu'une erreur.
      queryClient.clear();
    },
  });

  const value = useMemo<AuthContextValue>(
    () => ({
      user: data ?? null,
      isLoading,
      login: (input) => loginMutation.mutateAsync(input),
      logout: async () => {
        await logoutMutation.mutateAsync();
      },
    }),
    [data, isLoading, loginMutation, logoutMutation],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Le fournisseur et son hook restent dans le même fichier : les séparer
 * éloignerait le contexte de son unique consommateur sans rien gagner. Le
 * rafraîchissement à chaud de ce module force un rechargement complet, ce qui
 * est sans conséquence — il ne change quasiment jamais.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used inside an AuthProvider.');
  }

  return context;
}
