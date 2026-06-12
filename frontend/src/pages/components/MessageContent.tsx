// MessageContent — core routing component for card content rendering
// v4: Uses unified ST + JS-Slash-Runner rendering pipeline (renderMessageHtml)
//     – Full HTML docs / <script> → iframe (JS-Slash-Runner path)
//     – Everything else → DOMPurify + style scoping + inline DOM (ST path)

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CharacterCard, SessionRuntimeAssets } from '../../api/types';
import type { SandboxCardAction } from '../card-schema-types';
import { CodeBlock } from './CodeBlock';
import { CustomStatusRenderer } from './CustomStatusRenderer';
import { IframeHtmlRuntimeHost } from './IframeHtmlRuntimeHost';
import { cleanCardDisplayText, renderCardIframeHtml } from '../card-content';
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

function renderMarkdownDecorators(
  content: string,
  userName: string,
  charName: string,
): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  const source = content
    .replace(/&lt;(\/?inner)&gt;/gi, '<$1>')
    .replace(/&lt;\/?正文&gt;/gi, '')
    .replace(/<UpdateVariable(?:variable)?\b[^>]*>[\s\S]*?<\/UpdateVariable(?:variable)?>/gi, '')
    .replace(/<options\b[^>]*>[\s\S]*?<\/options>/gi, '')
    .replace(/<\/?正文>/g, '')
    .replace(/{{user}}/g, userName)
    .replace(/{{char}}/g, charName)
    .replace(/<user>/g, userName)
    .replace(/<\/user>/g, '')
    .replace(/<char>/g, charName)
    .replace(/<\/char>/g, '')
    .replace(/<\/?initvar>/gi, '');
  const preserveLineBreaks = (value: string) => value
    .split(/(\n{2,})/g)
    .map(part => /^\n{2,}$/.test(part) ? part : part.replace(/\n/g, '  \n'))
    .join('');
  const innerRegex = /<inner>([\s\S]*?)<\/inner>/gi;
  let match: RegExpExecArray | null;

  while ((match = innerRegex.exec(source)) !== null) {
    const before = source.slice(cursor, match.index);
    if (before.trim()) {
      parts.push(
        <ReactMarkdown key={`md-${cursor}`} remarkPlugins={[remarkGfm]} components={{ code: CodeBlock }}>
          {preserveLineBreaks(before)}
        </ReactMarkdown>,
      );
    }
    parts.push(
      <div key={`inner-${match.index}`} className="schema-inner-thought">
        {cleanCardDisplayText(match[1], userName, charName)}
      </div>,
    );
    cursor = match.index + match[0].length;
  }

  const rest = source.slice(cursor);
  if (rest.trim() || parts.length === 0) {
    parts.push(
      <ReactMarkdown key={`md-rest-${cursor}`} remarkPlugins={[remarkGfm]} components={{ code: CodeBlock }}>
        {preserveLineBreaks(rest)}
      </ReactMarkdown>,
    );
  }
  return parts;
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
  const schema = buildStatusSchema(card);

  function renderIframeOutput(html: string, key?: React.Key): React.ReactNode {
    const iframeHtml = renderCardIframeHtml(
      html,
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
        key={key ?? simpleHash(iframeHtml)}
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

  function renderInlineOutput(inlineOutput: typeof output, keyPrefix = 'inline'): React.ReactNode {
    const markdownSegments = inlineOutput.markdownSegments;
    const segments = inlineOutput.segments;

    if (markdownSegments && markdownSegments.length > 1) {
      return (
        <React.Fragment key={keyPrefix}>
          {markdownSegments.map((segment, index) => (
            <React.Fragment key={`${keyPrefix}-md-${index}`}>
              <div className="mes-text">
                {renderMarkdownDecorators(segment, userName, charName)}
              </div>
              {index < markdownSegments.length - 1 && schema && (
                <CustomStatusRenderer schema={schema} variables={(variables as Record<string, unknown>) || {}} />
              )}
            </React.Fragment>
          ))}
        </React.Fragment>
      );
    }

    if (inlineOutput.markdown) {
      return (
        <div key={keyPrefix} className="mes-text">
          {renderMarkdownDecorators(inlineOutput.markdown, userName, charName)}
        </div>
      );
    }

    if (segments && segments.length > 1) {
      return (
        <React.Fragment key={keyPrefix}>
          {segments.map((segment, index) => (
            <React.Fragment key={`${keyPrefix}-html-${index}`}>
              <div
                className="mes-text"
                dangerouslySetInnerHTML={{ __html: segment }}
              />
              {index < segments.length - 1 && schema && (
                <CustomStatusRenderer schema={schema} variables={(variables as Record<string, unknown>) || {}} />
              )}
            </React.Fragment>
          ))}
        </React.Fragment>
      );
    }

    return (
      <div
        key={keyPrefix}
        className="mes-text"
        dangerouslySetInnerHTML={{ __html: inlineOutput.html || '' }}
      />
    );
  }

  if (output.type === 'mixed') {
    return (
      <>
        {(output.parts || []).map((part, index) => (
          part.type === 'iframe'
            ? renderIframeOutput(part.html || '', `mixed-iframe-${index}-${simpleHash(part.html || '')}`)
            : renderInlineOutput(part, `mixed-inline-${index}`)
        ))}
      </>
    );
  }

  // JS-Slash-Runner path: full HTML doc → iframe
  if (output.type === 'iframe') {
    return renderIframeOutput(output.html || '');
  }

  // ST path: inline HTML with DOMPurify + style scoping
  return renderInlineOutput(output);
});
