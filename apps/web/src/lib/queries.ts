import { useQuery } from '@tanstack/react-query';
import { ApiError, http, type DashboardSummary, type NodeDto, type SystemInfo, type UserDto } from './api';
import { useLive } from './live';

/** Fallback polling: slow while the live stream is connected, faster when it is not. */
export function usePollInterval(fast = 5000, slow = 30_000) {
  const status = useLive((s) => s.status);
  return status === 'live' ? slow : fast;
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return (await http.get<{ user: UserDto }>('/api/auth/me')).user;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useNodes() {
  const refetchInterval = usePollInterval();
  return useQuery({ queryKey: ['nodes'], queryFn: () => http.get<{ items: NodeDto[] }>('/api/nodes'), refetchInterval });
}

export function useDashboard() {
  const refetchInterval = usePollInterval();
  return useQuery({ queryKey: ['dashboard'], queryFn: () => http.get<DashboardSummary>('/api/dashboard/summary'), refetchInterval });
}

export function useSystem() {
  return useQuery({ queryKey: ['system'], queryFn: () => http.get<SystemInfo>('/api/system'), staleTime: 60_000 });
}
