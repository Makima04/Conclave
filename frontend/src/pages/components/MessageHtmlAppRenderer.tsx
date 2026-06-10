import React, { useMemo } from 'react';
import type { CharacterCard } from '../../api/types';
import type { SandboxCardAction } from '../card-schema-types';
import { buildSandboxDocument } from '../sandbox-document';
import type { SandboxRuntimeContext } from '../sandbox-runtime-types';
import { IframeHtmlRuntimeHost } from './IframeHtmlRuntimeHost';

interface MessageHtmlAppRendererProps {
  card: CharacterCard;
  variables: Record<string, unknown>;
  runtime?: SandboxRuntimeContext;
  onAction?: (action: SandboxCardAction) => void;
}

const ALLOWED_ACTIONS = new Set([
  'applyGreeting',
  'applyOpeningSwipe',
  'readVariables',
  'writeVariables',
  'openStatusPanel',
  'submitFreeStart',
  'submitText',
  'diagnostic',
  'uiClick',
  'formSubmit',
  'setChatMessage',
  'setChatMessages',
  'triggerSlash',
  'setVariables',
  'missingApi',
  'runtimeError',
  'resourceRequest',
  'sandboxResize',
  'loadSaveSession',
  'deleteSaveSession',
]);

function runtimeKey(runtime?: SandboxRuntimeContext): string {
  const current = runtime?.currentMessage;
  const messageId = runtime?.currentMessageId ?? current?.message_id ?? current?.id ?? 'preview';
  const swipeId = current?.swipe_id ?? 0;
  return `${messageId}:${swipeId}`;
}

export function MessageHtmlAppRenderer({
  card,
  variables,
  runtime,
  onAction,
}: MessageHtmlAppRendererProps) {
  const html = String(card.conclave_package?.ui?.html || '').trim();
  const mountKey = `${card.id}:${runtimeKey(runtime)}`;
  const documentHtml = useMemo(
    () => buildSandboxDocument(html, variables || {}, runtime),
    [html, mountKey, runtime?.sessionId],
  );

  if (!html) return null;

  return (
    <section className="message-html-app-runtime" aria-label="消息级角色卡界面">
      <IframeHtmlRuntimeHost
        key={mountKey}
        className="message-html-app-runtime-frame"
        documentHtml={documentHtml}
        variables={variables || {}}
        runtime={runtime}
        allowedActions={ALLOWED_ACTIONS}
        fillAvailableHeight
        onAction={onAction}
      />
    </section>
  );
}
