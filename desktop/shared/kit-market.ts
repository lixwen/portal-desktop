export interface KitMarket { id: string; label: string; authority: 'operator-configured'; }
export interface KitMarketSelection { marketId: string; releaseId: string; profile?: string }
export interface KitMarketPreview {
  ticket: string; marketId: string; releaseId: string; kitId: string; version: string; profile: string;
  profiles: string[]; canInstall: boolean; blockedReason?: string; digest: string;
  permissions: unknown; components: { name: string; executor: string; eligible: boolean; reason?: string; preview?: unknown }[];
  skills: number; installationId: string;
}
export interface KitMarketInstallation { marketId: string; id: string; kitId: string; version: string; enabled: boolean; removed: boolean; revision: number; pendingPhase?: string }
export interface KitMarketAPI {
  pendingMarketRelease(): Promise<KitMarketSelection | null>;
  kitMarkets(): Promise<KitMarket[]>;
  previewMarketRelease(selection: KitMarketSelection): Promise<KitMarketPreview | { profiles: string[] }>;
  confirmMarketRelease(ticket: string): Promise<{ installed: boolean; installationId?: string }>;
  marketInstallations(): Promise<KitMarketInstallation[]>;
  recoverMarket(marketId: string): Promise<boolean>;
  manageMarketInstallation(marketId: string, installationId: string, action: 'enable' | 'disable' | 'uninstall'): Promise<boolean>;
}
