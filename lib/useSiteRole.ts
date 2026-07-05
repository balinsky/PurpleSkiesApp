import { useEffect, useState } from 'react';
import { supabase } from './supabase';

export type SiteRole = 'owner' | 'manager' | 'collector' | 'viewer';

// Module-level cache — cleared on app restart / sign-out
const cache = new Map<string, SiteRole>();

export function clearSiteRoleCache() {
  cache.clear();
}

export function useSiteRole(siteId: string): SiteRole | null {
  const [role, setRole] = useState<SiteRole | null>(cache.get(siteId) ?? null);

  useEffect(() => {
    if (cache.has(siteId)) { setRole(cache.get(siteId)!); return; }
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: site } = await supabase.from('sites').select('owner_id').eq('id', siteId).single();
      if (site?.owner_id === user.id) {
        cache.set(siteId, 'owner'); setRole('owner'); return;
      }
      const { data: member } = await supabase
        .from('site_members').select('role').eq('site_id', siteId).eq('user_id', user.id).maybeSingle();
      const r = (member?.role as SiteRole) ?? 'viewer';
      cache.set(siteId, r); setRole(r);
    })();
  }, [siteId]);

  return role;
}
