import type { CharacterCard, SessionRuntimeAssets } from '../api/types';
import { createMacroContext, processMacros } from './macro-engine';
import {
  getRegexedString,
  regex_placement,
} from './st-rendering-engine';
import type { RegexScript } from './st-regex-executor';
import { getRegexScripts } from './st-regex-scripts';

const STATUS_PLACEHOLDER = '<StatusPlaceHolderImpl/>';

interface RenderConclaveCardMessageOptions {
  card: CharacterCard | null;
  runtimeAssets?: SessionRuntimeAssets | null;
  variables?: Record<string, unknown>;
  userName?: string;
}

function hasStatusVariablePayload(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('<initvar') || lower.includes('<updatevariable');
}

function hasTavernHelperScripts(card: CharacterCard | null, runtimeAssets?: SessionRuntimeAssets | null): boolean {
  if (Array.isArray(runtimeAssets?.tavern_helper_scripts) && runtimeAssets!.tavern_helper_scripts.length > 0) {
    return true;
  }

  const extensions = card?.extensions as Record<string, unknown> | undefined;
  const tavernHelper = extensions?.tavern_helper as Record<string, unknown> | undefined;
  return (
    Array.isArray(tavernHelper?.scripts) && tavernHelper!.scripts.length > 0
  ) || (
    Array.isArray(extensions?.TavernHelper_scripts) && extensions!.TavernHelper_scripts.length > 0
  );
}

function appendStatusPlaceholderIfNeeded(
  card: CharacterCard | null,
  message: string,
  scripts: RegexScript[],
  runtimeAssets?: SessionRuntimeAssets | null,
): string {
  if (message.includes(STATUS_PLACEHOLDER) || hasTavernHelperScripts(card, runtimeAssets)) {
    return message;
  }

  if (!hasStatusVariablePayload(message)) {
    return message;
  }

  const hasStatusbarRegex = scripts.some(script => (
    !script.disabled
    && Boolean(script.markdownOnly)
    && script.findRegex.trim() === STATUS_PLACEHOLDER
    && script.replaceString.trim().length > 0
  ));

  return hasStatusbarRegex ? `${message}\n${STATUS_PLACEHOLDER}` : message;
}

function normalizeScriptsForConclavePipeline(scripts: RegexScript[]): RegexScript[] {
  return scripts.map(script => ({
    ...script,
    placement: Array.isArray(script.placement) ? script.placement : [regex_placement.AI_OUTPUT],
  }));
}

function stripMarkdownFences(source: string): string {
  const trimmed = source.trim();
  const outerFence = trimmed.match(/^```(?:html)?\s*\n?([\s\S]*?)\n?```$/i);
  if (outerFence) return outerFence[1];
  return source;
}

export function renderConclaveCardMessage(
  content: string,
  options: RenderConclaveCardMessageOptions,
): string {
  const userName = options.userName || '你';
  const charName = options.card?.name || '{{char}}';
  const variables = options.variables || {};
  const scripts = normalizeScriptsForConclavePipeline(getRegexScripts(options.card, options.runtimeAssets));
  const source = appendStatusPlaceholderIfNeeded(options.card, content, scripts, options.runtimeAssets);

  let rendered = source;
  try {
    rendered = processMacros(source, createMacroContext({ variables, userName, charName }));
  } catch {
    rendered = source
      .replace(/{{user}}/gi, userName)
      .replace(/{{char}}/gi, charName);
  }

  rendered = getRegexedString(
    scripts,
    rendered,
    regex_placement.AI_OUTPUT,
    { userName, charName, isMarkdown: false },
  );
  rendered = getRegexedString(
    scripts,
    rendered,
    regex_placement.AI_OUTPUT,
    { userName, charName, isMarkdown: true },
  );

  return stripMarkdownFences(rendered);
}
