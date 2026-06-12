import type { CharacterCard, SessionRuntimeAssets } from '../api/types';
import type { RegexScript } from './st-regex-executor';

export function toRegexScript(value: unknown): RegexScript | null {
  if (!value || typeof value !== 'object') return null;
  const script = value as Partial<RegexScript>;
  return typeof script.findRegex === 'string' && typeof script.replaceString === 'string'
    ? { ...script, findRegex: script.findRegex, replaceString: script.replaceString }
    : null;
}

function regexScriptKey(script: RegexScript): string {
  return [
    script.scriptName || '',
    script.findRegex,
    script.replaceString,
    script.markdownOnly ? 'md' : '',
    script.promptOnly ? 'prompt' : '',
    Array.isArray(script.placement) ? script.placement.join(',') : '',
  ].join('\x1f');
}

export function getRegexScripts(card: CharacterCard | null, runtimeAssets?: SessionRuntimeAssets | null): RegexScript[] {
  const runtimeScripts = (runtimeAssets?.regex_scripts || [])
    .map(toRegexScript)
    .filter((script): script is RegexScript => script !== null);
  const cardScriptsRaw = (card?.extensions as Record<string, unknown> | undefined)?.regex_scripts;
  const cardScripts = Array.isArray(cardScriptsRaw)
    ? cardScriptsRaw.map(toRegexScript).filter((script): script is RegexScript => script !== null)
    : [];

  if (runtimeScripts.length === 0) return cardScripts;
  if (cardScripts.length === 0) return runtimeScripts;

  const seen = new Set<string>();
  const merged: RegexScript[] = [];
  for (const script of [...runtimeScripts, ...cardScripts]) {
    const key = regexScriptKey(script);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(script);
  }
  return merged;
}
