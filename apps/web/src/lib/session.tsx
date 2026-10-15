'use client';

import type { MeResponse, PermissionKey } from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext } from 'react';
import { api } from './api';

export const ME_KEY = ['me'] as const;

export function useMeQuery() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: () => api<MeResponse>('/auth/me'),
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

const MeContext = createContext<MeResponse | null>(null);

export function MeProvider({ me, children }: { me: MeResponse; children: ReactNode }) {
  return <MeContext.Provider value={me}>{children}</MeContext.Provider>;
}

/** The signed-in user inside the dashboard shell (always present there). */
export function useMe(): MeResponse {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe() used outside the dashboard shell');
  return me;
}

/**
 * UI hint only: hides controls the user can't use. The API enforces every permission itself,
 * so nothing here is a security boundary.
 */
export function useCan() {
  const me = useMe();
  return (perm: PermissionKey) => me.permissions.some((p) => p.key === perm);
}

/** UI mirror of the backend's Access.coversTeam / coversDepartment (hint only). */
export function useCovers() {
  const me = useMe();
  const scope = (perm: PermissionKey) => me.permissions.find((p) => p.key === perm)?.scope;
  return {
    team(perm: PermissionKey, team: { id: string; departmentId: string | null }): boolean {
      const s = scope(perm);
      if (!s) return false;
      if (s.all) return true;
      return (
        s.teamIds.includes(team.id) ||
        (team.departmentId !== null && s.departmentIds.includes(team.departmentId))
      );
    },
    department(perm: PermissionKey, departmentId: string | null): boolean {
      const s = scope(perm);
      if (!s) return false;
      if (s.all) return true;
      return departmentId !== null && s.departmentIds.includes(departmentId);
    },
  };
}
