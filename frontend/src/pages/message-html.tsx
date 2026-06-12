// Unified ST-style message HTML rendering
//
// Replicates the ST + JS-Slash-Runner rendering path:
//   1. Run regex scripts (ST's engine.js)
//   2. Detect: full HTML doc with <script> → iframe (JS-Slash-Runner path)
//              everything else → inline DOMPurify + style scoping (ST path)
//
// ST path: regex → encodeStyleTags → DOMPurify → decodeStyleTags → innerHTML
// JS-Slash-Runner path: regex → iframe srcdoc (bridge injected)

import DOMPurify from 'dompurify';
import { encodeStyleTags, decodeStyleTags } from './stylescape';
import {
  getRegexedString,
  regex_placement,
} from './st-rendering-engine';
import { processMacros, createMacroContext } from './macro-engine';
import type { RegexScript } from './st-regex-executor';
import type { CharacterCard, SessionRuntimeAssets } from '../api/types';

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

// ── Helpers ──

function toRegexScript(value: unknown): RegexScript | null {
  if (!value || typeof value !== 'object') return null;
  const script = value as Partial<RegexScript>;
  return typeof script.findRegex === 'string' && typeof script.replaceString === 'string'
    ? { ...script, findRegex: script.findRegex, replaceString: script.replaceString }
    : null;
}

function getRegexScripts(card: CharacterCard | null, runtimeAssets?: SessionRuntimeAssets | null): RegexScript[] {
  if (runtimeAssets?.regex_scripts?.length) {
    return runtimeAssets.regex_scripts.map(toRegexScript).filter((script): script is RegexScript => script !== null);
  }
  const scripts = (card?.extensions as Record<string, unknown> | undefined)?.regex_scripts;
  return Array.isArray(scripts) ? scripts.map(toRegexScript).filter((script): script is RegexScript => script !== null) : [];
}

function stripCodeFence(source: string): string {
  const trimmed = source.trim();
  if (!trimmed.startsWith('```')) return source;
  const firstBreak = trimmed.indexOf('\n');
  if (firstBreak < 0) return source;
  const withoutOpen = trimmed.slice(firstBreak + 1);
  const close = withoutOpen.lastIndexOf('```');
  return close >= 0 ? withoutOpen.slice(0, close) : withoutOpen;
}

// ── Unified rendering ──

export interface RenderOutput {
  /** 'iframe' = full HTML app (JS-Slash-Runner path), 'inline' = ST direct DOM path */
  type: 'iframe' | 'inline';
  /** For iframe: srcdoc HTML document. For inline: purified HTML string. */
  html: string;
  /** Segments split by <StatusPlaceHolderImpl/> marker (inline only) */
  segments?: string[];
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
  } = {},
): RenderOutput {
  const { card, runtimeAssets, userName = '{{user}}', charName = '{{char}}' } = options;

  // Normalize content (matching ST's messageFormatting substitutions)
  let processed = processMacros(content, createMacroContext({
    variables: {},
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
  // JS-Slash-Runner path: full HTML document or script-bearing content → iframe
  const isFullHtmlDoc = /^<!DOCTYPE\s+html|<html\b/i.test(processed.trim());
  const hasScript = /<script\b/i.test(processed);

  if (isFullHtmlDoc || hasScript) {
    return {
      type: 'iframe',
      html: processed,
    };
  }

  // Step 3: ST path — encode <style>, DOMPurify, decode <style> with scoping
  const encoded = encodeStyleTags(processed);
  const purified = DOMPurify.sanitize(encoded, PURIFY_CONFIG);
  const decoded = decodeStyleTags(purified, '.mes-text ');

  // Split on <StatusPlaceHolderImpl/> for component injection by the caller
  const marker = '<StatusPlaceHolderImpl/>';
  const segments = decoded.split(marker);

  return {
    type: 'inline',
    html: decoded,
    segments: segments.length > 1 ? segments : undefined,
  };
}
