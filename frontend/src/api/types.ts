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
  render_mode: RenderMode;
  user_persona: UserPersona;
}

export type RenderMode = 'auto' | 'schema' | 'sandbox' | 'text';

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
  render_mode: 'auto',
  user_persona: { name: '', avatar: '', address: '', background: '', style: '' },
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

export interface StreamEvent {
  event: string;
  data: any;
}

export interface ProviderConfig {
  id: string;
  name: string;
  provider_type: string;
  base_url: string;
  api_key: string;
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
  entries: WorldBookEntry[];
  has_character_card: boolean;
  character_card_id: string | null;
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
