import type { CharacterCard, SessionRuntimeAssets } from '../api/types';
import type { RegexScript } from './st-regex-executor';
import { regexFromString, regex_placement } from './st-rendering-engine';

const KNOWN_OPENING_TRIGGER_PATTERN = String.raw`(?:^|\n)\s*(?:\[attachment\]|\[开局\]|【GameStart】|【游戏开始】)\s*`;

export const HTML_APP_TRIGGER_RE = new RegExp(KNOWN_OPENING_TRIGGER_PATTERN, 'i');

const HTML_APP_TRIGGER_GLOBAL_RE = new RegExp(KNOWN_OPENING_TRIGGER_PATTERN, 'gi');

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

function isHtmlAppReplacement(source: string): boolean {
  const stripped = stripCodeFence(source).trim();
  return /^<!DOCTYPE\s+html\b|^<html\b/i.test(stripped) || /<script\b/i.test(stripped);
}

function runsOnAiOutput(script: RegexScript): boolean {
  if (script.disabled || script.promptOnly) return false;
  if (!Array.isArray(script.placement) || script.placement.length === 0) return true;
  return script.placement.some(value => Number(value) === regex_placement.AI_OUTPUT);
}

function regexMatches(script: RegexScript, content: string): boolean {
  if (!script.findRegex || !content) return false;
  const regex = regexFromString(script.findRegex);
  if (!regex) return false;
  regex.lastIndex = 0;
  return regex.test(content);
}

function openingHtmlAppScripts(card: CharacterCard | null, runtimeAssets?: SessionRuntimeAssets | null): RegexScript[] {
  const firstMessage = card?.first_mes?.trim();
  if (!firstMessage) return [];
  return getRegexScripts(card, runtimeAssets).filter(script =>
    runsOnAiOutput(script)
    && typeof script.replaceString === 'string'
    && isHtmlAppReplacement(script.replaceString)
    && regexMatches(script, firstMessage)
  );
}

function isConclaveHtmlApp(card: CharacterCard | null): boolean {
  return card?.conclave_package?.ui?.type === 'html_app'
    && Boolean(String(card.conclave_package?.ui?.html || '').trim());
}

export function hasOpeningHtmlApp(card: CharacterCard | null, runtimeAssets?: SessionRuntimeAssets | null): boolean {
  return isConclaveHtmlApp(card) || openingHtmlAppScripts(card, runtimeAssets).length > 0;
}

export function contentHasOpeningHtmlAppTrigger(card: CharacterCard | null, content: string, runtimeAssets?: SessionRuntimeAssets | null): boolean {
  const text = content.trim();
  if (!text) return false;
  if (HTML_APP_TRIGGER_RE.test(text)) return true;
  return openingHtmlAppScripts(card, runtimeAssets).some(script => regexMatches(script, text));
}

export function openingHtmlAppTrigger(card: CharacterCard | null, runtimeAssets?: SessionRuntimeAssets | null): string | null {
  const firstMessage = card?.first_mes?.trim();
  if (firstMessage && openingHtmlAppScripts(card, runtimeAssets).length > 0) return firstMessage;
  if (isConclaveHtmlApp(card)) return '【GameStart】';
  return null;
}

export function getOpeningHtmlAppHostContent(card: CharacterCard | null, runtimeAssets?: SessionRuntimeAssets | null): string | null {
  const firstMessage = card?.first_mes?.trim();
  if (firstMessage && openingHtmlAppScripts(card, runtimeAssets).length > 0) return firstMessage;
  const html = card?.conclave_package?.ui?.html;
  return typeof html === 'string' && html.trim() ? html : null;
}

export function prepareOpeningHtmlAppContent(card: CharacterCard | null, content: string, runtimeAssets?: SessionRuntimeAssets | null): string {
  const trimmed = content.trim();
  if (!trimmed || !hasOpeningHtmlApp(card, runtimeAssets) || contentHasOpeningHtmlAppTrigger(card, trimmed, runtimeAssets)) {
    return content;
  }
  const trigger = openingHtmlAppTrigger(card, runtimeAssets);
  return trigger ? `${trigger}\n${trimmed}` : content;
}

export function stripKnownOpeningHtmlTriggers(content: string): string {
  return content.replace(HTML_APP_TRIGGER_GLOBAL_RE, '\n');
}
