// Unified ST-style message HTML rendering
//
// Replicates the ST + JS-Slash-Runner rendering path:
//   1. Macro expansion ({{user}}, {{char}}, {{getvar::...}}, etc.)
//   2. Run regex scripts (ST engine.js — two-phase)
//   3. Detect: full HTML doc or code fence with HTML → iframe (JS-Slash-Runner path)
//              everything else → inline ST path
//
// Inline ST path: showdown.makeHtml → encodeStyleTags → DOMPurify → decodeStyleTags → innerHTML

import DOMPurify from 'dompurify';
import showdown from 'showdown';
import { encodeStyleTags, decodeStyleTags } from './stylescape';
import {
  getRegexedString,
  regex_placement,
} from './st-rendering-engine';
import { processMacros, createMacroContext } from './macro-engine';
import type { RegexScript } from './st-regex-executor';
import type { CharacterCard, SessionRuntimeAssets } from '../api/types';
import { getRegexScripts } from './st-regex-scripts';

// ── DOMPurify hooks (matching ST's addDOMPurifyHooks in chats.js:1901-2051) ──

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if ('target' in node) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener');
  }
});

DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName === 'class' && data.attrValue) {
    data.attrValue = data.attrValue
      .split(' ')
      .map(v => {
        if (v.startsWith('fa-') || v.startsWith('note-') || v === 'monospace') {
          return v;
        }
        return 'custom-' + v;
      })
      .join(' ');
  }
});

const PURIFY_CONFIG = {
  ADD_TAGS: ['custom-style'] as string[],
  ALLOW_UNKNOWN_PROTOCOLS: true,
};

// Showdown converter — mirrors ST's messageFormatting markdown step
const showdownConverter = new showdown.Converter({
  simplifiedAutoLink: true,
  excludeTrailingPunctuationFromURLs: true,
  literalMidWordUnderscores: true,
  strikethrough: true,
  tables: true,
  tasklists: true,
  disableForced4SpacesIndentedSublists: true,
  simpleLineBreaks: true,
  openLinksInNewWindow: true,
});

// ── Helpers ──

function stripCodeFence(source: string): string {
  const trimmed = source.trim();
  if (!trimmed.startsWith('```')) return source;
  const firstBreak = trimmed.indexOf('\n');
  if (firstBreak < 0) return source;
  const withoutOpen = trimmed.slice(firstBreak + 1);
  const close = withoutOpen.lastIndexOf('```');
  return close >= 0 ? withoutOpen.slice(0, close) : withoutOpen;
}

function stripTextOnlyCustomTags(source: string): string {
  return source
    .replace(/<StatusPlaceHolderImpl\s*\/>/gi, '')
    .replace(/<UpdateVariable(?:variable)?\b[^>]*>[\s\S]*?<\/UpdateVariable(?:variable)?>/gi, '')
    .replace(/<options\b[^>]*>[\s\S]*?<\/options>/gi, '')
    .replace(/<\/?(?:inner|正文|initvar|user|char)\b[^>]*>/gi, '')
    .replace(/&lt;\/?(?:inner|正文|initvar|user|char)\b[^&]*?&gt;/gi, '');
}

function shouldRenderInlineMarkdown(source: string): boolean {
  const withoutTextTags = stripTextOnlyCustomTags(source);
  return !/<\/?[a-zA-Z][\w:-]*(?:\s[^>]*)?>/.test(withoutTextTags);
}

// ── Unified rendering ──

export interface RenderOutput {
  /** 'iframe' = full HTML app (JS-Slash-Runner path), 'inline' = ST direct DOM path */
  type: 'iframe' | 'inline' | 'mixed';
  /** For iframe: srcdoc HTML document. For inline: purified HTML string. */
  html?: string;
  /** Markdown/plain-text source after macros + ST regex, when it is safe to render as Markdown. */
  markdown?: string;
  /** Segments split by <StatusPlaceHolderImpl/> marker (inline only) */
  segments?: string[];
  /** Markdown/plain-text segments split by <StatusPlaceHolderImpl/> marker. */
  markdownSegments?: string[];
  /** Ordered inline/iframe parts when a message embeds a full HTML app after text. */
  parts?: RenderOutput[];
}

function renderInlineProcessed(processed: string): RenderOutput {
  // Showdown markdown → HTML (matching ST's messageFormatting step)
  const htmlContent = showdownConverter.makeHtml(processed);
  const encoded = encodeStyleTags(htmlContent);
  const purified = DOMPurify.sanitize(encoded, PURIFY_CONFIG);
  const decoded = decodeStyleTags(purified, '.mes-text ');
  const markdown = shouldRenderInlineMarkdown(processed) ? processed : undefined;

  const marker = '<StatusPlaceHolderImpl/>';
  const segments = decoded.split(marker);
  const markdownSegments = markdown ? markdown.split(marker) : undefined;

  return {
    type: 'inline',
    html: decoded,
    markdown,
    segments: segments.length > 1 ? segments : undefined,
    markdownSegments: markdownSegments && markdownSegments.length > 1 ? markdownSegments : undefined,
  };
}

function splitEmbeddedHtmlDocuments(processed: string): RenderOutput[] | null {
  const htmlDocumentRe = /<!DOCTYPE\s+html[\s\S]*?<\/html>|<html\b[\s\S]*?<\/html>/ig;
  const parts: RenderOutput[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = htmlDocumentRe.exec(processed)) !== null) {
    const before = processed.slice(cursor, match.index);
    if (before.trim()) parts.push(renderInlineProcessed(before));
    parts.push({ type: 'iframe', html: match[0] });
    cursor = match.index + match[0].length;
  }

  if (parts.length === 0) return null;
  const rest = processed.slice(cursor);
  if (rest.trim()) parts.push(renderInlineProcessed(rest));

  if (parts.length === 1 && parts[0].type === 'iframe' && processed.trim() === (parts[0].html || '').trim()) {
    return null;
  }
  return parts;
}

/**
 * Render a message through the full ST + JS-Slash-Runner pipeline.
 *
 * @returns RenderOutput describing how the content should be injected into the DOM.
 */
export function renderMessageHtml(
  content: string,
  options: {
    card?: CharacterCard | null;
    runtimeAssets?: SessionRuntimeAssets | null;
    userName?: string;
    charName?: string;
    variables?: Record<string, unknown>;
  } = {},
): RenderOutput {
  const { card, runtimeAssets, userName = '{{user}}', charName = '{{char}}', variables } = options;

  // Normalize content (matching ST's messageFormatting substitutions)
  let processed = processMacros(content, createMacroContext({
    variables: variables ?? {},
    userName,
    charName,
  }));

  // Step 1: Run regex scripts (ST engine.js — two-phase, matching messageFormatting)
  const scripts = getRegexScripts(card ?? null, runtimeAssets);
  if (scripts.length > 0) {
    const preparedScripts: RegexScript[] = scripts.map(s => {
      if (typeof s.replaceString === 'string' && s.replaceString.trim().startsWith('```')) {
        return { ...s, replaceString: stripCodeFence(s.replaceString) };
      }
      return s;
    });

    // Phase 1: non-markdown
    processed = getRegexedString(
      preparedScripts, processed, regex_placement.AI_OUTPUT,
      { userName, charName, isMarkdown: false },
    );
    // Phase 2: markdown-only (matching ST's messageFormatting with isMarkdown: true)
    processed = getRegexedString(
      preparedScripts, processed, regex_placement.AI_OUTPUT,
      { userName, charName, isMarkdown: true },
    );
  }

  // Step 2: Detect rendering path
  // Aligned with JSR isFrontend.ts: full HTML doc OR code fence with HTML content → iframe
  const trimmedContent = processed.trim();
  const isFullHtmlDoc = /^(?:<!DOCTYPE\s+html\b|<html\b)/i.test(trimmedContent);

  // Code fence with frontend HTML content (matching ST's isFrontend check)
  const codeFenceRe = /```(?:html)?\s*\n?([\s\S]*?)```/gi;
  let hasFrontendFence = false;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = codeFenceRe.exec(processed)) !== null) {
    if (/\b(?:html>|<head[\s>]|<body[\s>])/i.test(fenceMatch[1])) {
      hasFrontendFence = true;
      break;
    }
  }

  const embeddedHtmlParts = isFullHtmlDoc ? null : splitEmbeddedHtmlDocuments(processed);

  if (embeddedHtmlParts) {
    return {
      type: 'mixed',
      parts: embeddedHtmlParts,
    };
  }

  if (isFullHtmlDoc || hasFrontendFence) {
    return {
      type: 'iframe',
      html: processed,
    };
  }

  // Step 3: ST path — encode <style>, DOMPurify, decode <style> with scoping
  return renderInlineProcessed(processed);
}
