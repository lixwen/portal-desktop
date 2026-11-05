export interface HomeKitHostState {
  phase: 'unconfigured' | 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
  connectedNativeExecutors?: number;
  message: string; targetId?: string; generation?: number;
}
