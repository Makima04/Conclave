import type { SandboxVariableContract } from './sandbox-variable-bridge';

export interface SandboxRuntimeMessage {
  id: string | number;
  message_id: string | number;
  swipe_id?: number;
  swipes?: string[];
  role?: string;
  name?: string;
  message?: string;
  content?: string;
  created_at?: string;
  send_date?: string;
  turn_number?: number;
  is_user?: boolean;
  is_system?: boolean;
  data?: Record<string, unknown>;
  variables?: Record<string, unknown>;
}

export interface SandboxSharedSave {
  saveId: string;
  sessionId: string;
  runId?: string;
  meta: Record<string, unknown>;
  payload?: Record<string, unknown>;
}

export interface SandboxRuntimeSubmission {
  status: 'idle' | 'pending' | 'streaming' | 'finalizing' | 'error' | 'done';
  sourceMessageId?: string | number | null;
  generationId?: string | number | null;
  userMessage?: string;
  assistantMessage?: string;
  error?: string | null;
  updatedAt?: number;
}

export interface SandboxRuntimeContext {
  sessionId?: string | null;
  messages?: SandboxRuntimeMessage[];
  currentMessage?: SandboxRuntimeMessage | null;
  currentMessageId?: string | number | null;
  sharedSaves?: SandboxSharedSave[];
  submission?: SandboxRuntimeSubmission | null;
  variableContract?: SandboxVariableContract | null;
  rendered?: boolean;
  /** Platform state snapshot for sandbox card runtime. */
  platformState?: Record<string, unknown> | null;
  /** Writable platform state paths for sandbox card runtime. */
  writableState?: Record<string, unknown> | null;
}

