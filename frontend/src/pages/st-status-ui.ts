import type { CharacterCard, SessionRuntimeAssets } from '../api/types';
import type { RegexScript } from './st-regex-executor';
import { regexFromString, regex_placement } from './st-rendering-engine';
import { getRegexScripts } from './st-regex-scripts';

export const STATUS_PLACEHOLDER = '<StatusPlaceHolderImpl/>';

function stripCodeFence(source: string): string {
  const trimmed = source.trim();
  if (!trimmed.startsWith('```')) return source;
  const firstBreak = trimmed.indexOf('\n');
  if (firstBreak < 0) return source;
  const withoutOpen = trimmed.slice(firstBreak + 1);
  const close = withoutOpen.lastIndexOf('```');
  return close >= 0 ? withoutOpen.slice(0, close) : withoutOpen;
}

function isHtmlStatusReplacement(source: string): boolean {
  const stripped = stripCodeFence(source).trim();
  return /^<!DOCTYPE\s+html\b|^<html\b/i.test(stripped) || /<script\b/i.test(stripped);
}

function runsOnAiOutputDisplay(script: RegexScript): boolean {
  if (script.disabled || script.promptOnly) return false;
  if (!Array.isArray(script.placement) || script.placement.length === 0) return true;
  return script.placement.some(value => Number(value) === regex_placement.AI_OUTPUT);
}

function regexMatchesStatusPlaceholder(script: RegexScript): boolean {
  if (!script.findRegex) return false;
  const regex = regexFromString(script.findRegex);
  if (!regex) return false;
  regex.lastIndex = 0;
  const matched = regex.test(STATUS_PLACEHOLDER);
  regex.lastIndex = 0;
  return matched;
}

export function hasRegexStatusRenderer(card: CharacterCard | null, runtimeAssets?: SessionRuntimeAssets | null): boolean {
  return getRegexScripts(card, runtimeAssets).some(script =>
    runsOnAiOutputDisplay(script)
    && regexMatchesStatusPlaceholder(script)
    && isHtmlStatusReplacement(script.replaceString)
  );
}

export function hasStatusRenderer(card: CharacterCard | null, runtimeAssets?: SessionRuntimeAssets | null): boolean {
  const extensions = card?.extensions as Record<string, unknown> | undefined;
  return (
    (typeof extensions?.status_replace_string === 'string' && Boolean(extensions.status_replace_string.trim()))
    || hasRegexStatusRenderer(card, runtimeAssets)
  );
}

export function hasStatusPlaceholder(content: string): boolean {
  return /<StatusPlaceHolderImpl\s*\/>/i.test(content);
}

export function closeDanglingBodyTag(content: string): string {
  const lastOpen = content.search(/<正文\b[^>]*>/i);
  if (lastOpen < 0 || /<\/正文>/i.test(content.slice(lastOpen))) return content;
  return `${content.trimEnd()}\n</正文>`;
}

export function ensureStatusPlaceholder(content: string, card: CharacterCard | null, runtimeAssets?: SessionRuntimeAssets | null): string {
  if (!hasStatusRenderer(card, runtimeAssets) || hasStatusPlaceholder(content)) return content;
  const trimmed = closeDanglingBodyTag(content).trimEnd();
  return trimmed ? `${trimmed}\n\n${STATUS_PLACEHOLDER}` : STATUS_PLACEHOLDER;
}

export function ensureRegexStatusPlaceholder(content: string, card: CharacterCard | null, runtimeAssets?: SessionRuntimeAssets | null): string {
  if (!hasRegexStatusRenderer(card, runtimeAssets) || hasStatusPlaceholder(content)) return content;
  const trimmed = closeDanglingBodyTag(content).trimEnd();
  return trimmed ? `${trimmed}\n\n${STATUS_PLACEHOLDER}` : STATUS_PLACEHOLDER;
}
