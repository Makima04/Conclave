export interface Session {
  id: string;
  title: string;
  mode: string;
  config: SessionConfig;
  current_turn: number;
  title_source: string;
  status: string;
  world_pack_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionConfig {
  max_context_turns: number;
  stream: boolean;
  temperature: number;
  top_p: number;
  max_tokens: number;
  frequency_penalty: number;
  presence_penalty: number;
  system_prompt: string;
  // Multi-agent config
  master_model: string;
  sub_agent_model: string;
  cooldown_turns: number;
  user_auto_mode: string;
  max_active_agents: number;
  parser_enabled: boolean;
  compression_model: string;
  variable_tool_model: string;
  render_mode: RenderMode;
  user_persona: UserPersona;
  user_setting_merge_strategy: UserSettingMergeStrategy;
  active_preset_id?: string;
}

export type RenderMode = 'auto' | 'schema' | 'sandbox' | 'text';
export type UserSettingMergeStrategy = 'user_overrides_worldbook' | 'worldbook_overrides_user';

export interface UserPersona {
  name: string;
  avatar: string;
  address: string;
  background: string;
  style: string;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  max_context_turns: 20,
  stream: true,
  temperature: 0.8,
  top_p: 1.0,
  max_tokens: 2048,
  frequency_penalty: 0,
  presence_penalty: 0,
  system_prompt: '',
  // Multi-agent defaults (must match backend defaults in routes/sessions.rs)
  master_model: '',
  sub_agent_model: '',
  cooldown_turns: 10,
  user_auto_mode: 'ask',
  max_active_agents: 8,
  parser_enabled: true,
  compression_model: '',
  variable_tool_model: '',
  render_mode: 'auto',
  user_persona: { name: '', avatar: '', address: '', background: '', style: '' },
  user_setting_merge_strategy: 'user_overrides_worldbook',
};

export interface Message {
  id: string;
  session_id: string;
  turn_number: number;
  role: string;
  content: string;
  variants: string;
  variant_index: number;
  created_at: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  provider_type: string;
  base_url: string;
  api_key_set: boolean;
  model: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

export interface WorldBook {
  id: string;
  name: string;
  description: string;
  original_format: string;
  entry_count: number;
  has_character_card: boolean;
  character_card_name?: string;
  character_card_avatar?: string;
  created_at: string;
  updated_at: string;
}

export interface WorldBookDetail {
  id: string;
  name: string;
  description: string;
  original_format: string;
  source_data: string;
  parse_status: string;
  single_agent_parse_status: string;
  entries: WorldBookEntry[];
  parsed_entries: ParsedWorldBookEntry[];
  single_agent_parsed_entries: ParsedWorldBookEntry[];
  has_character_card: boolean;
  character_card_id: string | null;
  character_card_name?: string;
  character_card_avatar?: string;
  created_at: string;
  updated_at: string;
}

export interface WorldBookEntry {
  id: string;
  world_book_id: string;
  keys: string[];
  content: string;
  comment: string;
  constant: boolean;
  priority: number;
  enabled: boolean;
  position: string;
  selective: boolean;
  secondary_keys: string[];
  selective_logic: number;
  created_at: string;
  updated_at: string;
}

export interface CharacterCard {
  id: string;
  world_book_id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  avatar: string;
  creator: string;
  character_version: string;
  tags: string[];
  alternate_greetings: string[];
  system_prompt: string;
  post_history_instructions: string;
  creator_notes: string;
  mes_example: string;
  extensions: any;
  spec: string;
  conclave_package?: ConclaveCardPackage | null;
  import_report?: ImportReport | null;
  created_at: string;
  updated_at: string;
}

export interface ParsedWorldBookEntry {
  keys: string[];
  content: string;
  comment: string;
  constant: boolean;
  priority: number;
  enabled: boolean;
  category: string;
  visibility: string;
  reason: string;
}

// --- Presets ---

export interface Preset {
  id: string;
  session_id: string | null;
  name: string;
  source_format: string;
  module_count: number;
  parse_status: string;
  created_at: string;
  updated_at: string;
}

export interface PresetDetail {
  id: string;
  session_id: string | null;
  name: string;
  source_format: string;
  model_params: Record<string, any>;
  parse_status: string;
  modules: PresetModule[];
  created_at: string;
  updated_at: string;
}

export interface PresetModule {
  id: string;
  preset_id: string;
  identifier: string;
  name: string;
  role: string;
  content: string;
  target_agents: string[];
  enabled: boolean;
  injection_order: number;
  classification: string;
  reason: string;
}

// ─── Card Import Normalization Types ───

export type SourceFormat = 'png_ccv3' | 'png_chara' | 'json_v2' | 'json_v3';

export type DiagnosticLevel = 'info' | 'warn' | 'error';

export type ImportStatus = 'success' | 'warning' | 'fallback' | 'blocked';

export type StageStatus = 'success' | 'warning' | 'error' | 'skipped';

export type RuleStatus = 'matched' | 'skipped' | 'failed';

export type UiType = 'schema' | 'html_app' | 'html_fragment' | 'text' | 'raw_preview';

export type ActionKind = 'start' | 'load_save' | 'set_message' | 'set_variable' | 'open_panel' | 'form_submit' | 'unknown';

export type ActionSource = 'html' | 'js' | 'regex';

export type VariableTypeEnum = 'string' | 'number' | 'boolean' | 'object' | 'array';

export type ApiClassification = 'platform_native' | 'browser_shim' | 'unsupported' | 'dangerous';

export type ResourceKind = 'image' | 'audio' | 'video' | 'css_url' | 'js_static' | 'font';

export interface SourceLocation {
  file: string;
  offset: number;
  excerpt: string;
}

export interface DiagnosticSource {
  kind: string;
  script_name?: string;
  field?: string;
  offset?: number;
  selector?: string;
  excerpt?: string;
}

export interface RegexDiagnostic {
  level: DiagnosticLevel;
  message: string;
  script_index?: number;
}

export interface StageResult {
  id: string;
  name: string;
  status: StageStatus;
  message?: string;
  started_at?: string;
  finished_at?: string;
}

export interface RuleTrace {
  rule_id: string;
  stage: string;
  status: RuleStatus;
  confidence: number;
  input_ref?: string;
  output_ref?: string;
  diagnostics: string[];
}

export interface ImportDiagnostic {
  id: string;
  stage: string;
  level: DiagnosticLevel;
  code: string;
  message: string;
  source?: DiagnosticSource;
  impact?: string;
  suggestion?: string;
  rule_id?: string;
}

export interface PackageManifest {
  pack_type: string;
  id: string;
  name: string;
  version: string;
  source: string;
  source_hash: string;
  importer_version: string;
}

export interface Greeting {
  id: string;
  label: string;
  content: string;
}

export interface PackageUi {
  type: UiType;
  html?: string;
  css: string[];
  js: string[];
  entry?: string;
  assets: string[];
}

export interface VariableDeclaration {
  path: string;
  type: VariableTypeEnum;
  default_value?: unknown;
  label?: string;
  source: string;
}

export interface ActionDeclaration {
  id: string;
  label: string;
  kind: ActionKind;
  selector?: string;
  source: ActionSource;
}

export interface CompatibilityReport {
  required_apis: string[];
  unsupported_apis: string[];
  warnings: string[];
}

export interface ConclaveCardPackage {
  manifest: PackageManifest;
  greetings: Greeting[];
  ui: PackageUi;
  variables: VariableDeclaration[];
  actions: ActionDeclaration[];
  compatibility: CompatibilityReport;
}

export interface ImportReport {
  id: string;
  status: ImportStatus;
  source: string;
  source_hash: string;
  stages: StageResult[];
  rule_traces: RuleTrace[];
  diagnostics: ImportDiagnostic[];
  fallback?: string;
}

export interface ImportDraftResponse {
  import_id: string;
  package_draft: ConclaveCardPackage;
  import_report: ImportReport;
}

export interface ConfirmImportRequest {
  degrade_to_schema?: boolean;
  user_notes?: string;
  world_book_id?: string;
}

export interface LlmAssistRequest {
  type: 'explain_actions' | 'label_variables' | 'suggest_action_kind' | 'summarize_unsupported';
  params?: Record<string, unknown>;
}

export interface LlmAssistResponse {
  type: string;
  result: unknown;
}

export interface RawPreviewResponse {
  html: string;
}

export interface FailureSampleRequest {
  user_notes?: string;
}
