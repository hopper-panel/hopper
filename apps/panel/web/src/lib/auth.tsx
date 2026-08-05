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
  /**
   * A passkey login lands here already signed in.
   *
   * The ceremony happens in the page — it needs the browser API and a user
   * gesture — and hands back the user the server recognised. This exists so
   * the session cache is filled in the one place that owns it, rather than
   * every caller remembering to.
   */
  adopt: (user: CurrentUser) => void;
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
        // No session: this is not an outage, it is the normal state of a
        // signed-out visitor. Returning null avoids showing an error.
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
      // The cache is cleared even if the call fails: staying on a populated
      // interface while believing one is signed out is worse than an error.
      queryClient.clear();
    },
  });

  const value = useMemo<AuthContextValue>(
    () => ({
      user: data ?? null,
      isLoading,
      login: (input) => loginMutation.mutateAsync(input),
      adopt: (authenticated) => queryClient.setQueryData(['auth', 'me'], authenticated),
      logout: async () => {
        await logoutMutation.mutateAsync();
      },
    }),
    [data, isLoading, loginMutation, logoutMutation, queryClient],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * The provider and its hook stay in the same file: separating them would move
 * the context away from its only consumer for no gain. Hot-reloading this
 * module forces a full reload, which is of no consequence — it hardly ever
 * changes.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used inside an AuthProvider.');
  }

  return context;
}
