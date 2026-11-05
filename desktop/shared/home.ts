export interface HomeProfile {
  id: string;
  being_id: string;
  owner_user_id: string;
  display_name: string;
  bio: string;
  provisioning_status: string;
}
export interface HomeMe {
  user: { id: string; status: string };
  username: string | null;
  being: HomeProfile | null;
  storage: { status: string; capacity_bytes: number; error_code: string | null } | null;
  storage_enabled: boolean;
  files_enabled: boolean;
  computer_enabled: boolean;
}
export interface HomeConfig { baseUrl: string; clientId: string }
export interface HomeState extends HomeConfig { signedIn: boolean; loginPending: boolean; warning?: string }
export interface HomeComputer { id: string; status: string; desired_state: string; generation: number }
export interface HomeOperation { id: string; status: string; kind: string; error_code: string | null }
export interface HomeFile { name: string; path: string; type: 'file' | 'directory'; size: number }
export interface HomeAPI {
  state(): Promise<HomeState>;
  configure(config: HomeConfig): Promise<HomeState>;
  login(): Promise<void>;
  cancelLogin(): Promise<void>;
  logout(): Promise<void>;
  me(): Promise<HomeMe>;
  bootstrap(): Promise<HomeProfile>;
  profile(patch: { display_name: string; bio: string }): Promise<HomeProfile>;
  importHeart(): Promise<void>;
  computer(): Promise<HomeComputer | null>;
  computerAction(kind: 'ensure' | 'stop' | 'recreate', key: string): Promise<{ computer: HomeComputer; operation: HomeOperation }>;
  operation(id: string): Promise<HomeOperation>;
  openComputer(): Promise<void>;
  files(path: string): Promise<{ entries: HomeFile[] }>;
  mkdir(path: string): Promise<void>;
  upload(directory: string): Promise<boolean>;
  download(path: string): Promise<boolean>;
}
