export interface Session {
  id: string;
  title: string;
  mode: string;
  config: SessionConfig;
  current_turn: number;
  title_source: string;
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
