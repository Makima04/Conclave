// Card content processing pipeline
// Extracted from Chat.tsx GROUP 6 + GROUP 7 + GROUP 8 + GROUP 9 + GROUP 25

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CharacterCard } from '../api/types';
import { CodeBlock } from './components/CodeBlock';
import { executeStRegexScripts, parseFindRegex } from './st-regex-executor';

// --- GROUP 6: Character card inspection functions ---

export function getStatusReplaceString(card: CharacterCard | null): string {
  const scripts = card?.extensions?.regex_scripts;
  if (!Array.isArray(scripts)) return '';
  const script = scripts.find((item: any) =>
    !item?.disabled
      && item?.findRegex === '<StatusPlaceHolderImpl/>'
      && typeof item?.replaceString === 'string'
      && item.replaceString.includes('status-card')
  );
  return script?.replaceString || '';
}

export function hasStatusRenderer(card: CharacterCard | null): boolean {
  return Boolean(getStatusReplaceString(card));
}

export function stripCodeFence(source: string): string {
  const trimmed = source.trim();
  if (!trimmed.startsWith('```')) return source;
  const firstBreak = trimmed.indexOf('\n');
  if (firstBreak < 0) return source;
  const withoutOpen = trimmed.slice(firstBreak + 1);
  const close = withoutOpen.lastIndexOf('```');
  return close >= 0 ? withoutOpen.slice(0, close) : withoutOpen;
}

export function getRegexScripts(card: CharacterCard | null): any[] {
  const scripts = card?.extensions?.regex_scripts;
  return Array.isArray(scripts) ? scripts : [];
}

export function getUiReplaceStringForContent(card: CharacterCard | null, content: string): string {
  const scripts = getRegexScripts(card);
  const script = scripts.find((item: any) => {
    if (item?.disabled || typeof item?.findRegex !== 'string' || typeof item?.replaceString !== 'string' || !item.replaceString.length) return false;
    const parsed = parseFindRegex(item.findRegex);
    if (parsed) {
      parsed.lastIndex = 0;
      return parsed.test(content);
    }
    return false;
  });
  return script?.replaceString || '';
}

export function isComplexCardUiSource(source: string): boolean {
  return source.length > 3000
    || /<html\b|<head\b|<body\b|<style\b/i.test(source)
    || /<script\b/i.test(source)
    || /\b(?:cx-launcher|view-container|TavernHelper|jquery|audio|music)\b/i.test(source);
}

export function hasComplexCardUi(card: CharacterCard | null): boolean {
  return getRegexScripts(card).some((item: any) =>
    !item?.disabled
      && typeof item?.replaceString === 'string'
      && item.replaceString.length > 0
      && isComplexCardUiSource(stripCodeFence(item.replaceString))
  );
}

export function isGameStartCard(card: CharacterCard | null): boolean {
  if (!card) return false;
  const firstMes = (card.first_mes || '').trim();
  return firstMes === '【GameStart】'
    || getRegexScripts(card).some((item: any) =>
      !item?.disabled
        && typeof item?.findRegex === 'string'
        && item.findRegex.includes('GameStart')
        && typeof item?.replaceString === 'string'
        && isComplexCardUiSource(stripCodeFence(item.replaceString))
    );
}

// --- GROUP 7: HTML sanitization & serialization ---

export function getSandboxHtmlForContent(card: CharacterCard | null, content: string): string {
  const result = executeStRegexScripts(card, content);
  if (!result.matched || !result.html) return '';
  return sanitizeSandboxHtml(result.html, { allowScripts: true });
}

export function sanitizeSandboxHtml(source: string, options: { allowScripts?: boolean } = {}): string {
  const base = source
    .replace(/javascript:/gi, '')
    .replace(/<link\b[^>]*href=["'][^"']*code\.jquery[^"']*["'][^>]*>/gi, '');
  const withoutDangerousAttrs = options.allowScripts
    ? base
    : base.replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  if (options.allowScripts) {
    return withoutDangerousAttrs;
  }
  return withoutDangerousAttrs.replace(/<script\b[\s\S]*?<\/script>/gi, '');
}

export function sanitizeHtmlFragment(source: string): string {
  return sanitizeSandboxHtml(source)
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object\b[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[\s\S]*?>/gi, '');
}

export function serializeSandboxData(value: any): string {
  return JSON.stringify(value ?? {})
    .replace(/</g, '\\u003C')
    .replace(new RegExp(' ', 'g'), '\\u2028')
    .replace(new RegExp(' ', 'g'), '\\u2029');
}

// --- GROUP 8: Regex script application ---

function parseRegexLiteral(source: string): RegExp | null {
  if (!source.startsWith('/')) return null;
  const lastSlash = source.lastIndexOf('/');
  if (lastSlash <= 0) return null;
  const pattern = source.slice(1, lastSlash);
  const flags = source.slice(lastSlash + 1).replace(/[^dgimsuvy]/g, '');
  try {
    return new RegExp(pattern, flags.includes('g') ? flags : `${flags}g`);
  } catch {
    return null;
  }
}

export function applyCardDisplayRegexScripts(card: CharacterCard | null, content: string): string {
  let output = content;
  for (const script of getRegexScripts(card)) {
    if (script?.disabled || script?.promptOnly || !script?.markdownOnly) continue;
    if (typeof script.findRegex !== 'string' || typeof script.replaceString !== 'string') continue;
    if (!script.replaceString || /<script\b/i.test(script.replaceString)) continue;
    if (script.findRegex === '<StatusPlaceHolderImpl/>' || script.findRegex.includes('GameStart')) continue;
    if (script.findRegex.includes('UpdateVariable')) continue;

    const replacement = sanitizeHtmlFragment(script.replaceString);
    const regex = parseFindRegex(script.findRegex);
    if (regex) {
      regex.lastIndex = 0;
      output = output.replace(regex, replacement);
    }
  }
  return output;
}

// --- GROUP 25: Text cleaning & inline decorator utilities ---

export function cleanCardDisplayText(content: string): string {
  return content
    .replace(/<StatusPlaceHolderImpl\/>/g, '')
    .replace(/<UpdateVariable(?:variable)?\b[^>]*>[\s\S]*?<\/UpdateVariable(?:variable)?>/gi, '')
    .replace(/<\/?正文>/g, '')
    .replace(/{{user}}/g, '你')
    .replace(/{{char}}/g, '')
    .replace(/<user>/g, '你')
    .replace(/<\/user>/g, '')
    .replace(/<char>/g, '')
    .replace(/<\/char>/g, '')
    .replace(/<\/?initvar>/gi, '')
    .replace(/<inner>([\s\S]*?)<\/inner>/gi, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function removeUiTriggers(card: CharacterCard | null, content: string): string {
  let output = content;
  for (const script of getRegexScripts(card)) {
    if (script?.disabled || typeof script.findRegex !== 'string') continue;
    const regex = parseFindRegex(script.findRegex);
    if (regex) {
      regex.lastIndex = 0;
      output = output.replace(regex, '');
    }
  }
  return output;
}

export function renderInlineDecorators(content: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  const innerRegex = /<inner>([\s\S]*?)<\/inner>/gi;
  const source = content
    .replace(/<UpdateVariable(?:variable)?\b[^>]*>[\s\S]*?<\/UpdateVariable(?:variable)?>/gi, '')
    .replace(/<\/?正文>/g, '')
    .replace(/{{user}}/g, '你')
    .replace(/{{char}}/g, '')
    .replace(/<user>/g, '你')
    .replace(/<\/user>/g, '')
    .replace(/<char>/g, '')
    .replace(/<\/char>/g, '')
    .replace(/<\/?initvar>/gi, '');
  let match: RegExpExecArray | null;
  while ((match = innerRegex.exec(source)) !== null) {
    const before = source.slice(cursor, match.index);
    if (before.trim()) {
      parts.push(<ReactMarkdown key={`md-${cursor}`} remarkPlugins={[remarkGfm]} components={{ code: CodeBlock }}>{before}</ReactMarkdown>);
    }
    parts.push(<div key={`inner-${match.index}`} className="schema-inner-thought">{cleanCardDisplayText(match[1])}</div>);
    cursor = match.index + match[0].length;
  }
  const rest = source.slice(cursor);
  if (rest.trim() || parts.length === 0) {
    parts.push(<ReactMarkdown key={`md-rest-${cursor}`} remarkPlugins={[remarkGfm]} components={{ code: CodeBlock }}>{rest}</ReactMarkdown>);
  }
  return parts;
}

// --- GROUP 9: Content rendering ---

export function renderCardFormattedContent(card: CharacterCard | null, content: string): React.ReactNode {
  const normalized = content
    .replace(/<\/?正文>/g, '')
    .replace(/{{user}}/g, '你')
    .replace(/{{char}}/g, '')
    .replace(/<user>/g, '你')
    .replace(/<\/user>/g, '')
    .replace(/<char>/g, '')
    .replace(/<\/char>/g, '')
    .replace(/<\/?initvar>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const formatted = applyCardDisplayRegexScripts(card, normalized)
    .replace(/<UpdateVariable(?:variable)?\b[^>]*>[\s\S]*?<\/UpdateVariable(?:variable)?>/gi, '')
    .trim();

  if (/<(?:style|div|span|details|summary|img)\b/i.test(formatted)) {
    return <div className="card-regex-html" dangerouslySetInnerHTML={{ __html: sanitizeHtmlFragment(formatted) }} />;
  }
  return renderInlineDecorators(formatted);
}
