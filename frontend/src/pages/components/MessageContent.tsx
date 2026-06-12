// MessageContent — core routing component for card content rendering
// v4: Uses unified ST + JS-Slash-Runner rendering pipeline (renderMessageHtml)
//     – Full HTML docs / <script> → iframe (JS-Slash-Runner path)
//     – Everything else → DOMPurify + style scoping + inline DOM (ST path)

import React from 'react';
import type { CharacterCard, SessionRuntimeAssets } from '../../api/types';
import type { SandboxCardAction } from '../card-schema-types';
import { CustomStatusRenderer } from './CustomStatusRenderer';
import { IframeHtmlRuntimeHost } from './IframeHtmlRuntimeHost';
import { renderCardIframeHtml } from '../card-content';
import { buildStatusSchema } from '../card-schema-builders';
import { renderMessageHtml } from '../message-html';

type SandboxRuntimeContext = Record<string, any>;

/** Fast string hash (djb2) for keying iframes — avoids re-render when content is identical. */
function simpleHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

export const MessageContent = React.memo(function MessageContent({
  content,
  card,
  runtimeAssets,
  variables,
  runtime,
  onSandboxAction,
  renderMode = 'auto',
  userName = '你',
  sessionId,
  worldBookId,
  onMessagesChanged,
}: {
  content: string;
  card: CharacterCard | null;
  runtimeAssets?: SessionRuntimeAssets | null;
  variables: unknown;
  runtime?: SandboxRuntimeContext;
  onSandboxAction?: (action: SandboxCardAction) => void;
  renderMode?: 'auto' | 'schema' | 'sandbox' | 'text';
  userName?: string;
  sessionId?: string;
  worldBookId?: string;
  onMessagesChanged?: () => void;
}) {
  const charName = card?.name || '{{char}}';

  // Text mode: skip all HTML processing — clean plain text only
  if (renderMode === 'text') {
    const cleaned = content
      .replace(/{{user}}/g, userName)
      .replace(/{{char}}/g, charName);
    return <>{cleaned.trim() === 'false' ? null : cleaned}</>;
  }

  // Unified ST + JS-Slash-Runner rendering
  const output = renderMessageHtml(content, { card, runtimeAssets, userName, charName });

  // JS-Slash-Runner path: full HTML doc → iframe
  if (output.type === 'iframe') {
    const iframeHtml = renderCardIframeHtml(
      output.html,
      (variables as Record<string, unknown>) || {},
      userName,
      charName,
      sessionId,
      worldBookId,
      card,
      runtime,
      runtimeAssets,
    );
    return (
      <IframeHtmlRuntimeHost
        key={simpleHash(iframeHtml)}
        documentHtml={iframeHtml}
        variables={(variables as Record<string, unknown>) || {}}
        runtime={runtime}
        sessionId={sessionId}
        worldBookId={worldBookId}
        onAction={onSandboxAction}
        onMessagesChanged={onMessagesChanged}
      />
    );
  }

  // ST path: inline HTML with DOMPurify + style scoping
  const schema = buildStatusSchema(card);
  const segments = output.segments;

  if (segments && segments.length > 1) {
    // Has <StatusPlaceHolderImpl/> marker → split around it
    return (
      <>
        {segments.map((segment, index) => (
          <React.Fragment key={index}>
            <div
              className="mes-text"
              dangerouslySetInnerHTML={{ __html: segment }}
            />
            {index < segments.length - 1 && schema && (
              <CustomStatusRenderer schema={schema} variables={(variables as Record<string, unknown>) || {}} />
            )}
          </React.Fragment>
        ))}
      </>
    );
  }

  // No marker: render entire content as one block
  return (
    <div
      className="mes-text"
      dangerouslySetInnerHTML={{ __html: output.html }}
    />
  );
});
