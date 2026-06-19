import type { CharacterCard, Message } from '../../api/types';

/**
 * Pure helpers shared by chat surfaces (StHost page + the new /chat page).
 * Migrated from pages/StHost.tsx so both pages render identically.
 */

export function sortMessages(messages: Message[]): Message[] {
  return [...messages].sort((first, second) => {
    if (first.turn_number !== second.turn_number) {
      return first.turn_number - second.turn_number;
    }
    return new Date(first.created_at).getTime() - new Date(second.created_at).getTime();
  });
}

export function parsedGreetings(card: CharacterCard | null): string[] {
  if (!card) return [];
  return [card.first_mes, ...(card.alternate_greetings ?? [])].filter(
    item => typeof item === 'string' && item.trim().length > 0,
  );
}

export function resolveOpeningIndex(card: CharacterCard | null, messages: Message[]): number {
  const greetings = parsedGreetings(card);
  if (greetings.length === 0) return 0;
  const opening = messages.find(message => message.turn_number === 0 && message.role === 'assistant');
  if (!opening) return 0;
  const index = greetings.findIndex(item => item.trim() === opening.content.trim());
  return index >= 0 ? index : 0;
}

export function messageFingerprint(messages: Message[]): string {
  return messages.map(message => `${message.id}:${message.variant_index}:${message.content.length}`).join('|');
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => HTML_ESCAPES[ch] ?? ch);
}

/**
 * One chat-surface message as HTML. Uses cx-* classes defined inside the
 * ChatSurfaceIframe srcdoc stylesheet. `bodyHtml` for assistant messages is
 * already-rendered card markup (from backend); user messages are an escaped
 * cx-plain box.
 */
export function messageHtml(name: string, bodyHtml: string, isUser: boolean): string {
  const cls = isUser ? 'cx-msg cx-msg-user' : 'cx-msg cx-msg-assistant';
  return `<div class="${cls}"><div class="cx-msg-role">${escapeHtml(name)}</div><div class="cx-msg-body">${bodyHtml}</div></div>`;
}
