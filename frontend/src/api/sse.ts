export type AgentStatusPayload = {
  agent_type: string;
  label: string;
  status: string;
};

export type MessageDeltaPayload = {
  content: string;
};

export type StreamErrorPayload = {
  error: string;
};

export type TurnEndPayload = {
  turn_number: number;
  message_content: string;
};

export type TurnNumberPayload = {
  turn_number: number;
};

export type KnownChatSseMessage =
  | { event: 'agent_status'; data: AgentStatusPayload }
  | { event: 'message_delta'; data: MessageDeltaPayload }
  | { event: 'stream_error'; data: StreamErrorPayload }
  | { event: 'memory_start'; data: TurnNumberPayload }
  | { event: 'memory_error'; data: StreamErrorPayload }
  | { event: 'turn_end'; data: TurnEndPayload }
  | { event: 'turn_ready'; data: TurnNumberPayload };

export type ChatSseMessage =
  | KnownChatSseMessage
  | { event: 'unknown'; name: string; data: unknown };

export type ChatSseHandler = (message: ChatSseMessage) => void | boolean | Promise<void | boolean>;

function parseEventData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

function toSseMessage(event: string, data: string): ChatSseMessage {
  const parsed = parseEventData(data);
  switch (event) {
    case 'agent_status':
    case 'message_delta':
    case 'stream_error':
    case 'memory_start':
    case 'memory_error':
    case 'turn_end':
    case 'turn_ready':
      return { event, data: parsed } as KnownChatSseMessage;
    default:
      return { event: 'unknown', name: event, data: parsed };
  }
}

export async function consumeSseResponse(response: Response, onMessage: ChatSseHandler): Promise<void> {
  if (!response.body) {
    throw new Error('SSE response body is empty');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  async function processLines(lines: string[]): Promise<boolean> {
    let currentEvent = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        const shouldContinue = await onMessage(toSseMessage(currentEvent, line.slice(6)));
        if (shouldContinue === false) return false;
      }
    }
    return true;
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    if (!(await processLines(lines))) {
      await reader.cancel();
      return;
    }
  }

  const remaining = buffer.trim();
  if (remaining) {
    await processLines(remaining.split('\n'));
  }
}
