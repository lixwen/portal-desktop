import type { KitMarketSelection } from './kit-market';
/** A release link is a selection hint only; never a Root or configuration. */
export function parseKitInstallLink(raw: unknown): KitMarketSelection | null {
  if (typeof raw !== 'string' || raw.length > 512) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'portal-kit:' || url.hostname !== 'install' || !['', '/'].includes(url.pathname) || url.username || url.password || url.port || url.hash || [...url.searchParams.keys()].some(k => !['market', 'release'].includes(k)) || url.searchParams.getAll('market').length !== 1 || url.searchParams.getAll('release').length !== 1) return null;
    const marketId = url.searchParams.get('market')!, releaseId = url.searchParams.get('release')!;
    if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(marketId) || ['.', '..'].includes(marketId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(releaseId)) return null;
    return { marketId, releaseId };
  } catch { return null; }
}
