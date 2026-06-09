// MessageContent — core routing component for card content rendering
// Extracted from Chat.tsx GROUP 24

import React from 'react';
import type { CharacterCard } from '../../api/types';
import type { SandboxCardAction } from '../card-schema-types';
import type { SandboxRuntimeContext } from '../sandbox-runtime-types';
import { CustomStatusRenderer } from './CustomStatusRenderer';
import { SandboxHtmlRenderer } from './SandboxHtmlRenderer';
import { TavernHelperRuntimeHost } from './TavernHelperRuntimeHost';
import { MessageHtmlAppRenderer } from './MessageHtmlAppRenderer';
import {
  cleanCardDisplayText,
  getTavernHelperScripts,
  renderCardFormattedContent,
} from '../card-content';
import { buildStatusSchema } from '../card-schema-builders';
import {
  resolveCardRenderPlan,
  resolveTavernHelperStatusMode,
  shouldRenderCleanText,
} from '../card-runtime-resolver';

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
  const tavernHelperScripts = React.useMemo(() => getTavernHelperScripts(card), [card?.id, card?.extensions]);
  const renderPlan = React.useMemo(
    () => resolveCardRenderPlan({ card, content, runtime, renderMode }),
    [card, content, runtime, renderMode],
  );
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
    return <>{renderCleanText(renderPlan.displayContent)}</>;
  }

  const schema = buildStatusSchema(card);
  const statusContent = contentHasStatusMarker
    ? renderPlan.displayContent
    : `${renderPlan.displayContent.trim()}\n\n${marker}`;

  if (resolveTavernHelperStatusMode(card, content, renderMode)) {
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
    return <>{renderCleanText(renderPlan.displayContent)}</>;
  }

  if (renderPlan.kind === 'html_app' && card) {
    return (
      <>
        <MessageHtmlAppRenderer
          card={card}
          variables={variables || {}}
          runtime={runtime}
          onAction={onSandboxAction}
        />
        {renderCleanText(renderPlan.displayContent)}
      </>
    );
  }

  if (renderPlan.kind === 'sandbox_html') {
    return (
      <>
        <SandboxHtmlRenderer html={renderPlan.runtimeHtml} variables={variables || {}} runtime={runtime} onAction={onSandboxAction} />
        {shouldRenderCleanText(renderPlan.displayContent) && renderCardFormattedContent(card, renderPlan.displayContent)}
      </>
    );
  }

  return (
    <>
      {renderCleanText(renderPlan.displayContent)}
    </>
  );
});
