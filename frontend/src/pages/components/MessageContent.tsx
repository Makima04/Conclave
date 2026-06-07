// MessageContent — core routing component for card content rendering
// Extracted from Chat.tsx GROUP 24

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CharacterCard } from '../../api/types';
import type { SandboxCardAction } from '../card-schema-types';
import { CodeBlock } from './CodeBlock';
import { CustomStatusRenderer } from './CustomStatusRenderer';
import { CoverMenuRenderer } from './CoverMenuRenderer';
import { PlatformGameStartRenderer } from './PlatformGameStartRenderer';
import { SandboxHtmlRenderer } from './SandboxHtmlRenderer';
import { PlatformPackageRenderer } from './PlatformPackageRenderer';
import {
  cleanCardDisplayText,
  getSandboxHtmlForContent,
  hasComplexCardUi,
  removeUiTriggers,
  renderCardFormattedContent,
} from '../card-content';
import {
  buildCoverMenuSchema,
  buildPlatformCardSchema,
  buildStatusSchema,
} from '../card-schema-builders';

export function MessageContent({
  content,
  card,
  variables,
  onSandboxAction,
  renderMode = 'auto',
}: {
  content: string;
  card: CharacterCard | null;
  variables: any;
  onSandboxAction?: (action: SandboxCardAction) => void;
  renderMode?: 'auto' | 'schema' | 'sandbox' | 'text';
}) {
  // Text mode: always plain formatted content
  if (renderMode === 'text') {
    return <>{renderCardFormattedContent(card, content)}</>;
  }

  const schema = buildStatusSchema(card);
  const marker = '<StatusPlaceHolderImpl/>';
  const contentHasStatusMarker = content.includes(marker);
  const statusContent = contentHasStatusMarker ? content : `${content.trim()}\n\n${marker}`;

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
          {renderCardFormattedContent(card, content)}
        </>
      );
    }
    return <>{renderCardFormattedContent(card, content)}</>;
  }

  // Sandbox mode: render the author's original UI first. Platform schema is only
  // a fallback when the card cannot provide runnable HTML for this message.
  if (renderMode === 'sandbox') {
    const sandboxHtml = getSandboxHtmlForContent(card, statusContent);
    if (sandboxHtml) {
      const contentWithoutTrigger = cleanCardDisplayText(removeUiTriggers(card, statusContent));
      return (
        <>
          <SandboxHtmlRenderer html={sandboxHtml} variables={variables || {}} onAction={onSandboxAction} />
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
    return <>{renderCardFormattedContent(card, content)}</>;
  }

  // Auto mode (default): ConclaveCardPackage first, then ST regex sandbox,
  // then status/platform/cover/text fallback.

  // 0. Prefer ConclaveCardPackage if the card was imported with one
  if (card?.conclave_package?.ui) {
    return (
      <PlatformPackageRenderer
        pkg={card.conclave_package}
        variables={variables}
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
        <SandboxHtmlRenderer html={autoSandboxHtml} variables={variables || {}} onAction={onSandboxAction} />
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
        {contentWithoutTrigger && (
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: CodeBlock }}>{contentWithoutTrigger}</ReactMarkdown>
        )}
      </>
    );
  }

  return (
    <>
      {renderCardFormattedContent(card, content)}
    </>
  );
}
