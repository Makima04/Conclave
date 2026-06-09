// MessageContent — core routing component for card content rendering
// Extracted from Chat.tsx GROUP 24

import React from 'react';
import type { CharacterCard } from '../../api/types';
import type { SandboxCardAction } from '../card-schema-types';
import type { SandboxRuntimeContext } from '../sandbox-document';
import { CustomStatusRenderer } from './CustomStatusRenderer';
import { SandboxHtmlRenderer } from './SandboxHtmlRenderer';
import { TavernHelperRuntimeHost } from './TavernHelperRuntimeHost';
import { MessageHtmlAppRenderer } from './MessageHtmlAppRenderer';
import {
  cleanCardDisplayText,
  getSandboxHtmlForContent,
  getTavernHelperScripts,
  removeUiTriggers,
  renderCardFormattedContent,
} from '../card-content';
import { buildStatusSchema } from '../card-schema-builders';

function hasHtmlAppUi(card: CharacterCard | null): boolean {
  return card?.conclave_package?.ui?.type === 'html_app'
    && Boolean(String(card.conclave_package?.ui?.html || '').trim());
}

function isHtmlAppTriggerContent(content: string): boolean {
  return /(?:^|\n)\s*(?:\[attachment\]|\[开局\]|【GameStart】|【游戏开始】)\s*(?:\n|$)/i.test(content);
}

function isOpeningPreviewRuntime(runtime?: SandboxRuntimeContext): boolean {
  const current = runtime?.currentMessage;
  const id = String(runtime?.currentMessageId ?? current?.message_id ?? current?.id ?? '');
  return id === 'opening-preview';
}

function shouldRenderHtmlApp(card: CharacterCard | null, content: string, runtime?: SandboxRuntimeContext): boolean {
  return hasHtmlAppUi(card) && (isOpeningPreviewRuntime(runtime) || isHtmlAppTriggerContent(content));
}

function removeHtmlAppTriggers(content: string): string {
  return content
    .replace(/(?:^|\n)\s*(?:\[attachment\]|\[开局\]|【GameStart】|【游戏开始】)\s*(?=\n|$)/gi, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const MessageContent = React.memo(function MessageContent({
  content,
  card,
  variables,
  runtime,
  onSandboxAction,
  renderMode = 'auto',
}: {
  content: string;
  card: CharacterCard | null;
  variables: any;
  runtime?: SandboxRuntimeContext;
  onSandboxAction?: (action: SandboxCardAction) => void;
  renderMode?: 'auto' | 'schema' | 'sandbox' | 'text';
}) {
  const marker = '<StatusPlaceHolderImpl/>';
  const contentHasStatusMarker = content.includes(marker);
  const renderHtmlApp = shouldRenderHtmlApp(card, content, runtime);
  const htmlAppCard = renderHtmlApp ? card : null;
  const displayContent = renderHtmlApp ? removeHtmlAppTriggers(content) : content;
  const tavernHelperScripts = React.useMemo(() => getTavernHelperScripts(card), [card?.id, card?.extensions]);
  const renderCleanText = (value: string) => {
    if (value.trim() === 'false') return null;
    const cleaned = cleanCardDisplayText(value);
    return cleaned ? renderCardFormattedContent(card, value) : null;
  };
  const renderTavernHelperStatusParts = () => {
    const parts = content.split(marker);
    return (
      <>
        {parts.map((part, index) => (
          <React.Fragment key={index}>
            {renderCleanText(part)}
            {index < parts.length - 1 && tavernHelperScripts.length > 0 && (
              <TavernHelperRuntimeHost
                scripts={tavernHelperScripts}
                variables={variables || {}}
                runtime={runtime}
                onAction={onSandboxAction}
              />
            )}
          </React.Fragment>
        ))}
      </>
    );
  };

  // Text mode: always plain formatted content
  if (renderMode === 'text') {
    return <>{renderCleanText(displayContent)}</>;
  }

  const schema = buildStatusSchema(card);
  const statusContent = contentHasStatusMarker ? displayContent : `${displayContent.trim()}\n\n${marker}`;

  if (contentHasStatusMarker && tavernHelperScripts.length > 0 && renderMode === 'sandbox') {
    return renderTavernHelperStatusParts();
  }

  // Schema mode is explicit only. Auto/Sandbox no longer downgrade to platform renderers.
  if (renderMode === 'schema') {
    if (schema) {
      const parts = statusContent.split(marker);
      return (
        <>
          {parts.map((part, index) => (
            <React.Fragment key={index}>
              {cleanCardDisplayText(part).trim() && renderCardFormattedContent(card, part)}
              {index < parts.length - 1 && <CustomStatusRenderer schema={schema} variables={variables || {}} />}
            </React.Fragment>
          ))}
        </>
      );
    }
    return <>{renderCleanText(displayContent)}</>;
  }

  // Sandbox mode: render the author's original ST regex UI. No platform fallback.
  if (renderMode === 'sandbox') {
    if (htmlAppCard) {
      return (
        <>
          <MessageHtmlAppRenderer
            card={htmlAppCard}
            variables={variables || {}}
            runtime={runtime}
            onAction={onSandboxAction}
          />
          {renderCleanText(displayContent)}
        </>
      );
    }
    const sandboxHtml = getSandboxHtmlForContent(card, statusContent);
    if (sandboxHtml) {
      const contentWithoutTrigger = removeUiTriggers(card, statusContent);
      return (
        <>
          <SandboxHtmlRenderer html={sandboxHtml} variables={variables || {}} runtime={runtime} onAction={onSandboxAction} />
          {cleanCardDisplayText(contentWithoutTrigger) && renderCardFormattedContent(card, contentWithoutTrigger)}
        </>
      );
    }
    return <>{renderCleanText(displayContent)}</>;
  }

  // Auto mode (default): ST regex/sandbox first; otherwise ST-style text only.
  if (htmlAppCard) {
    return (
      <>
        <MessageHtmlAppRenderer
          card={htmlAppCard}
          variables={variables || {}}
          runtime={runtime}
          onAction={onSandboxAction}
        />
        {renderCleanText(displayContent)}
      </>
    );
  }

  const autoSandboxHtml = getSandboxHtmlForContent(card, statusContent);
  if (autoSandboxHtml) {
    const contentWithoutTrigger = removeUiTriggers(card, statusContent);
    return (
      <>
        <SandboxHtmlRenderer html={autoSandboxHtml} variables={variables || {}} runtime={runtime} onAction={onSandboxAction} />
        {cleanCardDisplayText(contentWithoutTrigger) && renderCardFormattedContent(card, contentWithoutTrigger)}
      </>
    );
  }

  return (
    <>
      {renderCleanText(displayContent)}
    </>
  );
});
