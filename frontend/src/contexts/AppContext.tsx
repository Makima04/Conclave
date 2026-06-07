import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import * as api from '../api/client';
import type { ProviderConfig } from '../api/types';

interface AppState {
  providers: ProviderConfig[];
  providersLoading: boolean;
  providersError: string | null;
  refreshProviders: () => Promise<void>;
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshProviders = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api.listProviders();
      setProviders(data.items || []);
      setError(null);
    } catch (e: any) {
      setError(e.message || 'Failed to load providers');
      console.error('[AppContext] Failed to load providers:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshProviders();
  }, [refreshProviders]);

  return (
    <AppContext.Provider value={{
      providers,
      providersLoading: loading,
      providersError: error,
      refreshProviders,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppContext must be used within AppProvider');
  return ctx;
}

// Convenience hook -- just providers, with loading state
export function useProviders() {
  const { providers, providersLoading, providersError, refreshProviders } = useAppContext();
  return { providers, loading: providersLoading, error: providersError, refresh: refreshProviders };
}
