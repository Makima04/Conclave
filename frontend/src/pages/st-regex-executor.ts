// SillyTavern-compatible regex_scripts executor.

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
}

type FindMatcher = {
  regex: RegExp;
  mode: 'regex' | 'literal';
};

/**
 * Parse a findRegex string into a RegExp using SillyTavern's regexFromString
 * behavior. ST does not force a global flag; cards opt into /g themselves.
 */
export function parseFindRegex(findRegex: string): RegExp | null {
  return parseFindMatcher(findRegex)?.regex ?? null;
}

function parseFindMatcher(findRegex: string): FindMatcher | null {
  if (typeof findRegex !== 'string' || !findRegex) return null;

  try {
    const match = findRegex.match(/(\/?)(.+)\1([a-z]*)/i);
    if (!match) return { regex: new RegExp(findRegex), mode: 'regex' };

    const flags = match[3] || '';
    if (flags && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(flags)) {
      return { regex: new RegExp(findRegex), mode: 'regex' };
    }

    return { regex: new RegExp(match[2], flags), mode: 'regex' };
  } catch {
    return null;
  }
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

  const matcher = parseFindMatcher(script.findRegex);
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
