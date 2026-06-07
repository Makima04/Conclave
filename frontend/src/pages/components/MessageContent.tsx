// MessageContent — core routing component for card content rendering
// Extracted from Chat.tsx GROUP 24

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CharacterCard } from '../../api/types';
import type { SandboxCardAction } from '../card-schema-types';
import type { SandboxRuntimeContext } from '../sandbox-document';
import { CodeBlock } from './CodeBlock';
import { CustomStatusRenderer } from './CustomStatusRenderer';
import { CoverMenuRenderer } from './CoverMenuRenderer';
import { PlatformGameStartRenderer } from './PlatformGameStartRenderer';
import { SandboxHtmlRenderer } from './SandboxHtmlRenderer';
import { PlatformPackageRenderer } from './PlatformPackageRenderer';
import { TavernHelperRuntimeHost } from './TavernHelperRuntimeHost';
import {
  cleanCardDisplayText,
  getSandboxHtmlForContent,
  getTavernHelperScripts,
  hasComplexCardUi,
  removeUiTriggers,
  renderCardFormattedContent,
} from '../card-content';
import {
  buildCoverMenuSchema,
  buildPlatformCardSchema,
  buildStatusSchema,
} from '../card-schema-builders';

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
  const renderCleanText = (value: string) => {
    const cleaned = cleanCardDisplayText(value);
    return cleaned ? renderCardFormattedContent(card, cleaned) : null;
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
    return <>{renderCleanText(content)}</>;
  }

  const schema = buildStatusSchema(card);
  const statusContent = contentHasStatusMarker ? content : `${content.trim()}\n\n${marker}`;

  if (contentHasStatusMarker && tavernHelperScripts.length > 0 && renderMode !== 'schema') {
    return renderTavernHelperStatusParts();
  }

  // Schema mode: status + platform + cover, but NO sandbox iframe
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
    const platformSchema = buildPlatformCardSchema(card, content);
    if (platformSchema) {
      const contentWithoutTrigger = cleanCardDisplayText(removeUiTriggers(card, content));
      return (
        <>
          <PlatformGameStartRenderer schema={platformSchema} onAction={onSandboxAction} />
          {contentWithoutTrigger && renderCardFormattedContent(card, contentWithoutTrigger)}
        </>
      );
    }
    const coverSchema = buildCoverMenuSchema(card, content);
    if (coverSchema) {
      const contentWithoutTrigger = cleanCardDisplayText(removeUiTriggers(card, content));
      return (
        <>
          <CoverMenuRenderer schema={coverSchema} />
          {contentWithoutTrigger && <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: CodeBlock }}>{contentWithoutTrigger}</ReactMarkdown>}
        </>
      );
    }
    // If complex UI detected but schema mode, show hint
    if (hasComplexCardUi(card)) {
      return (
        <>
          <div style={{ padding: '12px', color: '#A89BAD', fontSize: '13px', border: '1px dashed #3D2E4F', borderRadius: '8px', marginBottom: '8px' }}>
            Schema 模式下不渲染此角色卡的沙盒 UI。切换到 Auto 或 Sandbox 模式查看。
          </div>
          {renderCleanText(content)}
        </>
      );
    }
    return <>{renderCleanText(content)}</>;
  }

  // Sandbox mode: render the author's original UI first. Platform schema is only
  // a fallback when the card cannot provide runnable HTML for this message.
  if (renderMode === 'sandbox') {
    const sandboxHtml = getSandboxHtmlForContent(card, statusContent);
    if (sandboxHtml) {
      const contentWithoutTrigger = cleanCardDisplayText(removeUiTriggers(card, statusContent));
      return (
        <>
          <SandboxHtmlRenderer html={sandboxHtml} variables={variables || {}} runtime={runtime} onAction={onSandboxAction} />
          {contentWithoutTrigger && renderCardFormattedContent(card, contentWithoutTrigger)}
        </>
      );
    }
    const platformSchema = buildPlatformCardSchema(card, content);
    if (platformSchema) {
      const contentWithoutTrigger = cleanCardDisplayText(removeUiTriggers(card, content));
      return (
        <>
          <PlatformGameStartRenderer schema={platformSchema} onAction={onSandboxAction} />
          {contentWithoutTrigger && renderCardFormattedContent(card, contentWithoutTrigger)}
        </>
      );
    }
    const coverSchema = buildCoverMenuSchema(card, content);
    if (coverSchema) {
      const contentWithoutTrigger = cleanCardDisplayText(removeUiTriggers(card, content));
      return (
        <>
          <CoverMenuRenderer schema={coverSchema} />
          {contentWithoutTrigger && <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: CodeBlock }}>{contentWithoutTrigger}</ReactMarkdown>}
        </>
      );
    }
    return <>{renderCleanText(content)}</>;
  }

  // Auto mode (default): message-specific renderers first. The imported
  // package UI is the card's launcher/home surface, so only use it when the
  // current message is itself a GameStart/platform message.
  const platformSchema = buildPlatformCardSchema(card, content);

  // 0. Prefer ConclaveCardPackage for the card launcher/home message.
  if (card?.conclave_package?.ui && platformSchema) {
    return (
      <PlatformPackageRenderer
        pkg={card.conclave_package}
        variables={variables}
        runtime={runtime}
        onAction={onSandboxAction ? (actionId, payload) => onSandboxAction({ action: actionId, payload }) : undefined}
      />
    );
  }

  // 1. Try sandbox via ST regex executor
  const autoSandboxHtml = getSandboxHtmlForContent(card, statusContent);
  if (autoSandboxHtml) {
    const contentWithoutTrigger = cleanCardDisplayText(removeUiTriggers(card, statusContent));
    return (
      <>
        <SandboxHtmlRenderer html={autoSandboxHtml} variables={variables || {}} runtime={runtime} onAction={onSandboxAction} />
        {contentWithoutTrigger && renderCardFormattedContent(card, contentWithoutTrigger)}
      </>
    );
  }

  // 2. Fall back to status schema
  if (schema) {
    const parts = statusContent.split(marker);
    return (
      <>
        {parts.map((part, index) => (
          <React.Fragment key={index}>
            {cleanCardDisplayText(part).trim() && (
              renderCardFormattedContent(card, part)
            )}
            {index < parts.length - 1 && (
              <CustomStatusRenderer schema={schema} variables={variables || {}} />
            )}
          </React.Fragment>
        ))}
      </>
    );
  }

  if (platformSchema) {
    const contentWithoutTrigger = cleanCardDisplayText(removeUiTriggers(card, content));
    return (
      <>
        <PlatformGameStartRenderer schema={platformSchema} onAction={onSandboxAction} />
        {contentWithoutTrigger && renderCardFormattedContent(card, contentWithoutTrigger)}
      </>
    );
  }

  const coverSchema = buildCoverMenuSchema(card, content);
  if (coverSchema) {
    const contentWithoutTrigger = cleanCardDisplayText(removeUiTriggers(card, content));
    return (
      <>
        <CoverMenuRenderer schema={coverSchema} />
        {contentWithoutTrigger && (
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: CodeBlock }}>{contentWithoutTrigger}</ReactMarkdown>
        )}
      </>
    );
  }

  return (
    <>
      {renderCleanText(content)}
    </>
  );
});
