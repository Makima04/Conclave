// Card content processing pipeline
// Extracted from Chat.tsx GROUP 6 + GROUP 7 + GROUP 8 + GROUP 9 + GROUP 25

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CharacterCard } from '../api/types';
import { CodeBlock } from './components/CodeBlock';
import {
  executeStRegexScripts,
  expandStRegexReplacement,
  parseFindRegex,
  shouldRunStRegexScript,
  stRegexPlacement,
  type RegexScript,
} from './st-regex-executor';

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

export function getTavernHelperScripts(card: CharacterCard | null): Array<{ name: string; content: string }> {
  const scripts = card?.extensions?.tavern_helper?.scripts;
  if (!Array.isArray(scripts)) return [];
  return scripts.flatMap((script: any) => {
    const disabled = script?.disabled === true || script?.enabled === false;
    const content = typeof script?.content === 'string'
      ? script.content
      : typeof script?.script === 'string'
        ? script.script
        : '';
    if (disabled || !content.trim()) return [];
    return [{
      name: String(script?.name || script?.script_name || script?.scriptName || 'TavernHelper Script'),
      content,
    }];
  });
}

export function hasTavernHelperScripts(card: CharacterCard | null): boolean {
  return getTavernHelperScripts(card).length > 0;
}

export function isComplexCardUiSource(source: string): boolean {
  return source.length > 3000
    || /<html\b|<head\b|<body\b|<style\b/i.test(source)
    || /<script\b/i.test(source)
    || /\b(?:cx-launcher|view-container|TavernHelper|jquery|audio|music)\b/i.test(source);
}

function isSandboxUiSource(source: string): boolean {
  return /<!doctype\b|<html\b|<head\b|<body\b|<script\b/i.test(source)
    || /\b(?:cx-launcher|view-container|TavernHelper|jquery|audio|music)\b/i.test(source);
}

function getSandboxRegexScripts(card: CharacterCard | null): any[] {
  return getRegexScripts(card).filter((item: any) => {
    if (item?.disabled || typeof item?.replaceString !== 'string') return false;
    return isSandboxUiSource(stripCodeFence(item.replaceString));
  });
}

// --- GROUP 7: HTML sanitization & serialization ---

export function getSandboxHtmlForContent(card: CharacterCard | null, content: string): string {
  const sandboxScripts = getSandboxRegexScripts(card);
  if (sandboxScripts.length === 0) return '';
  const result = executeStRegexScripts(
    { extensions: { regex_scripts: sandboxScripts } },
    content,
  );
  if (!result.matched || !result.html) return '';
  return sanitizeSandboxHtml(result.html, { allowScripts: true });
}

export function sanitizeSandboxHtml(source: string, options: { allowScripts?: boolean } = {}): string {
  const base = source
    .replace(/(href|src)\s*=\s*["']javascript:/gi, '$1="javascript:void(0);')
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

type DisplayPart = {
  type: 'text' | 'html';
  content: string;
};

const DISPLAY_HTML_OPEN = '\uE000XRP_HTML_';
const DISPLAY_HTML_CLOSE = '_XRP_HTML\uE001';

function applyCardDisplayRegexScriptsToParts(card: CharacterCard | null, content: string, userName = '{{user}}', charName = '{{char}}'): DisplayPart[] {
  const htmlParts: string[] = [];
  let output = content;

  for (const script of getRegexScripts(card) as RegexScript[]) {
    if (typeof script.findRegex !== 'string' || typeof script.replaceString !== 'string') continue;
    if (!script.replaceString || /<script\b/i.test(script.replaceString)) continue;
    if (script.findRegex === '<StatusPlaceHolderImpl/>' || script.findRegex.includes('GameStart')) continue;
    if (isSandboxUiSource(stripCodeFence(script.replaceString))) continue;
    if (script.findRegex.includes('UpdateVariable')) continue;
    if (!shouldRunStRegexScript(script, {
      placement: stRegexPlacement.AI_OUTPUT,
      isMarkdown: false,
    })) continue;

    const replacementScript = { ...script, replaceString: sanitizeHtmlFragment(script.replaceString) };
    const regex = parseFindRegex(script.findRegex);
    if (!regex) continue;

    regex.lastIndex = 0;
    output = output.replace(regex, (...args: unknown[]) => {
      const expanded = expandStRegexReplacement(replacementScript, args, {
        placement: stRegexPlacement.AI_OUTPUT,
        isMarkdown: false,
        userName,
        charName,
      });
      const index = htmlParts.push(expanded) - 1;
      return `${DISPLAY_HTML_OPEN}${index}${DISPLAY_HTML_CLOSE}`;
    });
    regex.lastIndex = 0;
  }

  const parts: DisplayPart[] = [];
  const markerRegex = new RegExp(`${DISPLAY_HTML_OPEN}(\\d+)${DISPLAY_HTML_CLOSE}`, 'g');
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = markerRegex.exec(output)) !== null) {
    const before = output.slice(cursor, match.index);
    if (before.trim()) parts.push({ type: 'text', content: before });
    const html = htmlParts[Number(match[1])];
    if (html?.trim()) parts.push({ type: 'html', content: html });
    cursor = match.index + match[0].length;
  }
  const rest = output.slice(cursor);
  if (rest.trim() || parts.length === 0) parts.push({ type: 'text', content: rest });
  return parts;
}

// --- GROUP 25: Text cleaning & inline decorator utilities ---

export function cleanCardDisplayText(content: string, userName = '你', charName = ''): string {
  return content
    .replace(/<StatusPlaceHolderImpl\/>/g, '')
    .replace(/<UpdateVariable(?:variable)?\b[^>]*>[\s\S]*?<\/UpdateVariable(?:variable)?>/gi, '')
    .replace(/<options\b[^>]*>[\s\S]*?<\/options>/gi, '')
    .replace(/<\/?正文>/g, '')
    .replace(/{{user}}/g, userName)
    .replace(/{{char}}/g, charName)
    .replace(/<user>/g, userName)
    .replace(/<\/user>/g, '')
    .replace(/<char>/g, charName)
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

export function renderInlineDecorators(content: string, userName = '你', charName = ''): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  const innerRegex = /<inner>([\s\S]*?)<\/inner>/gi;
  const source = content
    .replace(/<StatusPlaceHolderImpl\/>/g, '')
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
  let match: RegExpExecArray | null;
  while ((match = innerRegex.exec(source)) !== null) {
    const before = source.slice(cursor, match.index);
    if (before.trim()) {
      parts.push(<ReactMarkdown key={`md-${cursor}`} remarkPlugins={[remarkGfm]} components={{ code: CodeBlock }}>{before}</ReactMarkdown>);
    }
    parts.push(<div key={`inner-${match.index}`} className="schema-inner-thought">{cleanCardDisplayText(match[1], userName, charName)}</div>);
    cursor = match.index + match[0].length;
  }
  const rest = source.slice(cursor);
  if (rest.trim() || parts.length === 0) {
    parts.push(<ReactMarkdown key={`md-rest-${cursor}`} remarkPlugins={[remarkGfm]} components={{ code: CodeBlock }}>{rest}</ReactMarkdown>);
  }
  return parts;
}

// --- GROUP 9: Content rendering ---

export function renderCardFormattedContent(card: CharacterCard | null, content: string, userName = '你', charName = ''): React.ReactNode {
  const normalized = content
    .replace(/<StatusPlaceHolderImpl\/>/g, '')
    .replace(/<\/?正文>/g, '')
    .replace(/<options\b[^>]*>[\s\S]*?<\/options>/gi, '')
    .replace(/{{user}}/g, userName)
    .replace(/{{char}}/g, charName)
    .replace(/<user>/g, userName)
    .replace(/<\/user>/g, '')
    .replace(/<char>/g, charName)
    .replace(/<\/char>/g, '')
    .replace(/<\/?initvar>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const cleaned = normalized
    .replace(/<UpdateVariable(?:variable)?\b[^>]*>[\s\S]*?<\/UpdateVariable(?:variable)?>/gi, '')
    .trim();
  const parts = applyCardDisplayRegexScriptsToParts(card, cleaned, userName, charName);

  return parts.map((part, index) => part.type === 'html' ? (
    <div
      key={`html-${index}`}
      className="card-regex-html"
      dangerouslySetInnerHTML={{ __html: part.content }}
    />
  ) : (
    <React.Fragment key={`text-${index}`}>{renderInlineDecorators(part.content, userName, charName)}</React.Fragment>
  ));
}
