// SillyTavern-compatible regex_scripts executor.

import { processMacros, type MacroContext } from './st-macros.ts';

export { type MacroContext } from './st-macros.ts';

export interface RegexScript {
  findRegex: string;
  replaceString: string;
  disabled?: boolean;
  promptOnly?: boolean;
  markdownOnly?: boolean;
  placement?: number[];
  trimStrings?: string[];
  substituteRegex?: number | string | null;
  minDepth?: number | null;
  maxDepth?: number | null;
  runOnEdit?: boolean;
}

export interface StRegexDiagnostic {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface StRegexResult {
  html: string;
  matched: boolean;
  diagnostics: StRegexDiagnostic[];
}

export const stRegexPlacement = {
  MD_DISPLAY: 0,
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  WORLD_INFO: 5,
  REASONING: 6,
} as const;

export interface StRegexExecutionOptions {
  userName?: string;
  charName?: string;
  placement?: number;
  isMarkdown?: boolean;
  isPrompt?: boolean;
  isEdit?: boolean;
  depth?: number;
  /** When provided, macros in findRegex patterns are expanded before compiling. */
  macroContext?: MacroContext;
}

type FindMatcher = {
  regex: RegExp;
  mode: 'regex' | 'literal';
};

// ── Regex LRU cache (P1-5) ──

const REGEX_CACHE_MAX = 1000;
const regexCache = new Map<string, RegExp>();

/**
 * Get a compiled RegExp from the cache, or compile and cache it.
 * Uses an LRU-like eviction: when the cache is full, the oldest entry is removed.
 */
export function getCachedRegex(pattern: string, flags: string): RegExp | null {
  const key = `${flags}/${pattern}`;
  const cached = regexCache.get(key);
  if (cached) {
    // Move to end (most recently used) by re-inserting
    regexCache.delete(key);
    regexCache.set(key, cached);
    return cached;
  }
  try {
    const regex = new RegExp(pattern, flags);
    if (regexCache.size >= REGEX_CACHE_MAX) {
      const firstKey = regexCache.keys().next().value;
      if (firstKey !== undefined) regexCache.delete(firstKey);
    }
    regexCache.set(key, regex);
    return regex;
  } catch {
    return null;
  }
}

/**
 * Clear the regex cache. Useful for testing or when patterns change globally.
 */
export function clearRegexCache(): void {
  regexCache.clear();
}

/**
 * Parse a findRegex string into a RegExp using SillyTavern's regexFromString
 * behavior. ST does not force a global flag; cards opt into /g themselves.
 *
 * When macroContext is provided, {{macro}} patterns in the findRegex string
 * are expanded before compiling (P1-2). If compilation fails, a literal-string
 * fallback is attempted (P1-3). Compiled RegExp objects are LRU-cached (P1-5).
 */
export function parseFindRegex(findRegex: string, macroContext?: MacroContext): RegExp | null {
  return parseFindMatcher(findRegex, macroContext)?.regex ?? null;
}

function parseFindMatcher(findRegex: string, macroContext?: MacroContext): FindMatcher | null {
  if (typeof findRegex !== 'string' || !findRegex) return null;

  // P1-2: Expand macros in the findRegex pattern before compiling
  let expanded = findRegex;
  if (macroContext) {
    try {
      expanded = processMacros(findRegex, macroContext);
    } catch {
      // macro expansion failed; fall through with original string
    }
  }

  try {
    const match = expanded.match(/(\/?)(.+)\1([a-z]*)/i);
    if (!match) {
      // P1-5: Use cache; P1-3: fallback to literal on failure
      const cached = getCachedRegex(expanded, '');
      if (cached) return { regex: cached, mode: 'regex' };
      return tryLiteralFallback(expanded, '');
    }

    const flags = match[3] || '';
    if (flags && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(flags)) {
      const cached = getCachedRegex(expanded, '');
      if (cached) return { regex: cached, mode: 'regex' };
      return tryLiteralFallback(expanded, '');
    }

    // P1-5: Use cache for the parsed pattern
    const cached = getCachedRegex(match[2], flags);
    if (cached) return { regex: cached, mode: 'regex' };

    // P1-3: Regex compilation failed — try literal-string fallback
    return tryLiteralFallback(match[2], flags);
  } catch {
    return null;
  }
}

/**
 * P1-3: Escape the pattern as a literal string and retry compilation.
 * Mirrors the Rust backend's regex::escape() fallback behavior.
 */
function tryLiteralFallback(pattern: string, flags: string): FindMatcher | null {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cached = getCachedRegex(escaped, flags);
  if (cached) return { regex: cached, mode: 'literal' };
  return null;
}

/**
 * Strip markdown code fences from a string.
 * Handles ```html ... ``` and plain ``` ... ```.
 */
export function stripCodeFences(source: string): string {
  const trimmed = source.trim();
  if (!trimmed.startsWith('```')) return source;
  const firstBreak = trimmed.indexOf('\n');
  if (firstBreak < 0) return source;
  const withoutOpen = trimmed.slice(firstBreak + 1);
  const close = withoutOpen.lastIndexOf('```');
  return close >= 0 ? withoutOpen.slice(0, close) : withoutOpen;
}

/**
 * Basic ST macro subset used in browser-side rendering.
 * Variable/state macros intentionally remain handled by our platform bridge.
 */
export function substituteStMacros(text: string, userName: string, charName: string): string {
  return text
    .replace(/\{\{user\}\}/gi, userName)
    .replace(/\{\{char\}\}/gi, charName)
    .replace(/<user>/gi, userName)
    .replace(/<\/user>/gi, '')
    .replace(/<char>/gi, charName)
    .replace(/<\/char>/gi, '');
}

function isComplexHtml(source: string): boolean {
  return source.length > 3000 || /<html\b|<style\b|<script\b/i.test(source);
}

function scriptHasPlacement(script: RegexScript, placement: number): boolean {
  return !Array.isArray(script.placement) || script.placement.includes(placement);
}

function scriptAppliesToPhase(script: RegexScript, options: StRegexExecutionOptions): boolean {
  const isMarkdown = options.isMarkdown ?? false;
  const isPrompt = options.isPrompt ?? false;
  return Boolean(
    (script.markdownOnly && isMarkdown)
      || (script.promptOnly && isPrompt)
      || (!script.markdownOnly && !script.promptOnly && !isMarkdown && !isPrompt),
  );
}

function scriptDepthAllowed(script: RegexScript, depth?: number): boolean {
  if (typeof depth !== 'number') return true;
  if (typeof script.minDepth === 'number' && script.minDepth >= -1 && depth < script.minDepth) return false;
  if (typeof script.maxDepth === 'number' && script.maxDepth >= 0 && depth > script.maxDepth) return false;
  return true;
}

export function shouldRunStRegexScript(script: RegexScript, options: StRegexExecutionOptions = {}): boolean {
  const placement = options.placement ?? stRegexPlacement.AI_OUTPUT;
  if (script?.disabled) return false;
  if (!scriptHasPlacement(script, placement)) return false;
  if (options.isEdit && script.runOnEdit === false) return false;
  if (!scriptDepthAllowed(script, options.depth)) return false;
  return scriptAppliesToPhase(script, options);
}

function filterString(rawString: string, trimStrings: string[] | undefined, options: StRegexExecutionOptions): string {
  let finalString = rawString;
  if (!Array.isArray(trimStrings)) return finalString;

  const userName = options.userName ?? '{{user}}';
  const charName = options.charName ?? '{{char}}';
  for (const trimString of trimStrings) {
    if (typeof trimString !== 'string' || !trimString) continue;
    const substituted = substituteStMacros(trimString, userName, charName);
    finalString = finalString.split(substituted).join('');
  }
  return finalString;
}

export function expandStRegexReplacement(
  script: RegexScript,
  args: unknown[],
  options: StRegexExecutionOptions = {},
): string {
  const userName = options.userName ?? '{{user}}';
  const charName = options.charName ?? '{{char}}';
  const groupsCandidate = args[args.length - 1];
  const namedGroups = groupsCandidate && typeof groupsCandidate === 'object' && !Array.isArray(groupsCandidate)
    ? groupsCandidate as Record<string, unknown>
    : null;

  const replacement = stripCodeFences(script.replaceString).replace(/{{match}}/gi, '$0');
  const replaceWithGroups = replacement.replace(/\$(\d+)|\$<([^>]+)>/g, (_token, num: string | undefined, groupName: string | undefined) => {
    let matchValue: unknown;
    if (num) {
      matchValue = args[Number(num)];
    } else if (groupName && namedGroups) {
      matchValue = namedGroups[groupName];
    }

    if (!matchValue) return '';
    return filterString(String(matchValue), script.trimStrings, options);
  });

  return substituteStMacros(replaceWithGroups, userName, charName);
}

export function runStRegexScript(
  script: RegexScript,
  rawString: string,
  options: StRegexExecutionOptions = {},
): { output: string; matched: boolean; diagnostic?: StRegexDiagnostic } {
  if (!script || script.disabled || !script.findRegex || !rawString) {
    return { output: rawString, matched: false };
  }

  const matcher = parseFindMatcher(script.findRegex, options.macroContext);
  if (!matcher) {
    return {
      output: rawString,
      matched: false,
      diagnostic: {
        level: 'warn',
        message: `Invalid regex pattern: ${script.findRegex.slice(0, 120)}`,
      },
    };
  }

  const regex = matcher.regex;
  regex.lastIndex = 0;
  let matched = false;
  const output = rawString.replace(regex, (...args: unknown[]) => {
    matched = true;
    return expandStRegexReplacement(script, args, options);
  });
  regex.lastIndex = 0;

  if (!matched && isComplexHtml(stripCodeFences(script.replaceString))) {
    return {
      output,
      matched,
      diagnostic: {
        level: 'info',
        message: `Skipped complex UI script because findRegex did not match: ${script.findRegex.slice(0, 120)}`,
      },
    };
  }

  return { output, matched };
}

function defaultExecutionPhases(options: StRegexExecutionOptions): StRegexExecutionOptions[] {
  if (typeof options.isMarkdown === 'boolean' || typeof options.isPrompt === 'boolean') {
    return [options];
  }
  return [
    { ...options, isMarkdown: false, isPrompt: false },
    { ...options, isMarkdown: true, isPrompt: false },
  ];
}

/**
 * Execute regex_scripts against content. By default this runs the two display
 * phases most relevant to chat rendering: normal AI_OUTPUT scripts, then
 * markdownOnly AI_OUTPUT scripts, mirroring SillyTavern's messageFormatting.
 */
export function executeStRegexScripts(
  card: { extensions?: { regex_scripts?: RegexScript[] } } | null,
  content: string,
  options: StRegexExecutionOptions = {},
): StRegexResult {
  const diagnostics: StRegexDiagnostic[] = [];
  const scripts = card?.extensions?.regex_scripts;
  if (!Array.isArray(scripts) || scripts.length === 0) {
    return { html: '', matched: false, diagnostics };
  }

  let output = content;
  let anyMatched = false;

  for (const phase of defaultExecutionPhases(options)) {
    for (const script of scripts) {
      if (typeof script?.findRegex !== 'string' || typeof script.replaceString !== 'string') continue;
      if (!script.findRegex || !script.replaceString) continue;
      if (!shouldRunStRegexScript(script, phase)) continue;

      const result = runStRegexScript(script, output, phase);
      output = result.output;
      anyMatched = anyMatched || result.matched;
      if (result.diagnostic) diagnostics.push(result.diagnostic);
    }
  }

  if (!anyMatched) {
    return { html: '', matched: false, diagnostics };
  }

  return {
    html: output,
    matched: true,
    diagnostics,
  };
}
