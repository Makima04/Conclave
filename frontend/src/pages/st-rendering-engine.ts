// ST-compatible regex rendering engine
// Faithful port of SillyTavern's scripts/extensions/regex/engine.js
// Core functions: runRegexScript, getRegexedString
// No global state — all inputs are explicit parameters

import { processMacros, type MacroContext } from './macro-engine';
import type { RegexScript } from './st-regex-executor';

// ── Enums ──

/**
 * Where the regex script should be applied.
 */
export const regex_placement = {
  /** @deprecated MD Display is deprecated. Do not use. */
  MD_DISPLAY: 0,
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  // 4 - sendAs (legacy)
  WORLD_INFO: 5,
  REASONING: 6,
} as const;

/**
 * How to substitute parameters in the find regex.
 */
export const substitute_find_regex = {
  NONE: 0,
  RAW: 1,
  ESCAPED: 2,
} as const;

// ── Helpers ──

/**
 * Substitute macros ({{user}}, {{char}}, etc.) using our macro engine.
 */
function substituteParams(text: string, userName: string, charName: string): string {
  const ctx: MacroContext = { variables: {}, userName, charName };
  return processMacros(text, ctx);
}

/**
 * Escape special regex characters in macro-expanded values so they are
 * treated as literals when injected into a regex pattern.
 * Port of ST's sanitizeRegexMacro (engine.js:304-324).
 */
function sanitizeRegexMacro(x: string): string {
  if (!x || typeof x !== 'string') return x;
  return x.replace(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gs, (s) => {
    switch (s) {
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '\t': return '\\t';
      case '\v': return '\\v';
      case '\f': return '\\f';
      case '\0': return '\\0';
      default:   return '\\' + s;
    }
  });
}

// ── regexFromString ──
// Port of ST's utils.js:1388-1403

/**
 * Parse a regex string like `/pattern/flags` into a RegExp.
 * Returns undefined if the pattern is invalid.
 */
export function regexFromString(input: string): RegExp | undefined {
  try {
    // Parse input
    const m = input.match(/(\/?)(.+)\1([a-z]*)/i);
    if (!m) return undefined;

    // Invalid flags
    if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3])) {
      return RegExp(input);
    }

    // Create the regular expression
    return new RegExp(m[2], m[3]);
  } catch {
    return undefined;
  }
}

// ── RegexProvider (LRU cache) ──
// Port of ST's RegexProvider class (engine.js:40-90)

/**
 * Manages the compiled regex cache with LRU eviction.
 */
export class RegexProvider {
  #cache = new Map<string, RegExp>();
  #maxSize = 1000;

  /**
   * Gets a regex instance by its string representation.
   * Returns null if the pattern cannot be parsed.
   */
  get(regexString: string): RegExp | null {
    const isCached = this.#cache.has(regexString);
    const regex = isCached
      ? this.#cache.get(regexString)
      : regexFromString(regexString);

    if (!regex) {
      return null;
    }

    if (isCached) {
      // LRU: Move to end by re-inserting
      this.#cache.delete(regexString);
      this.#cache.set(regexString, regex);
    } else {
      // Evict oldest if at capacity
      if (this.#cache.size >= this.#maxSize) {
        const firstKey = this.#cache.keys().next().value;
        if (firstKey !== undefined) {
          this.#cache.delete(firstKey);
        }
      }
      this.#cache.set(regexString, regex);
    }

    // Reset lastIndex for global/sticky regexes
    if (regex.global || regex.sticky) {
      regex.lastIndex = 0;
    }

    return regex;
  }

  /**
   * Clears the entire cache.
   */
  clear(): void {
    this.#cache.clear();
  }
}

/** Singleton regex provider instance. */
export const regexProvider = new RegexProvider();

// ── filterString ──
// Port of ST's filterString (engine.js:457-465)

/**
 * Remove trim strings from a regex match value.
 */
function filterString(
  rawString: string,
  trimStrings: string[],
  userName: string,
  charName: string,
): string {
  let finalString = rawString;
  trimStrings.forEach((trimString) => {
    const subTrimString = substituteParams(trimString, userName, charName);
    finalString = finalString.split(subTrimString).join('');
  });
  return finalString;
}

// ── runRegexScript ──
// Port of ST's runRegexScript (engine.js:391-448)

/**
 * Run a single regex script on the given string.
 * Returns the modified string, or the original if the script is disabled/invalid.
 */
export function runRegexScript(
  script: RegexScript,
  rawString: string,
  options?: { userName?: string; charName?: string },
): string {
  const userName = options?.userName ?? '{{user}}';
  const charName = options?.charName ?? '{{char}}';

  let newString = rawString;
  if (!script || !!script.disabled || !script.findRegex || !rawString) {
    return newString;
  }

  const getRegexString = (): string => {
    switch (Number(script.substituteRegex)) {
      case substitute_find_regex.NONE:
        return script.findRegex;
      case substitute_find_regex.RAW:
        // substituteParamsExtended(text, {}) — expand macros, no sanitization
        return substituteParams(script.findRegex, userName, charName);
      case substitute_find_regex.ESCAPED:
        // substituteParamsExtended(text, {}, sanitizeRegexMacro) — expand then escape
        return sanitizeRegexMacro(substituteParams(script.findRegex, userName, charName));
      default:
        console.warn(`runRegexScript: Unknown substituteRegex value ${script.substituteRegex}. Using raw regex.`);
        return script.findRegex;
    }
  };

  const regexString = getRegexString();
  const findRegex = regexProvider.get(regexString);

  // The user skill issued. Return with nothing.
  if (!findRegex) {
    return newString;
  }

  // Run replacement. Currently does not support the Overlay strategy.
  newString = rawString.replace(findRegex, function (this: unknown, ...args: unknown[]) {
    // args: [match, p1, p2, ..., offset, string, groups?]
    const match = args[0] as string;
    const replaceString = script.replaceString.replace(/{{match}}/gi, '$0');

    const replaceWithGroups = replaceString.replace(/\$(\d+)|\$<([^>]+)>/g, (_: string, num: string, groupName: string) => {
      let resolved: string | undefined;

      if (num) {
        // Handle numbered capture groups ($1, $2, etc.)
        resolved = args[Number(num)] as string | undefined;
      } else if (groupName) {
        // Handle named capture groups ($<name>)
        const groups = args[args.length - 1];
        resolved = groups && typeof groups === 'object' ? (groups as Record<string, string>)[groupName] : undefined;
      }

      // No match found — return the empty string
      if (!resolved) {
        return '';
      }

      // Remove trim strings from the match
      const filteredMatch = filterString(resolved, script.trimStrings ?? [], userName, charName);
      return filteredMatch;
    });

    // Substitute at the end
    return substituteParams(replaceWithGroups, userName, charName);
  });

  return newString;
}

// ── getRegexedString ──
// Port of ST's getRegexedString (engine.js:334-381)

/**
 * Parent function to fetch a regexed version of a raw string.
 * Iterates over all provided scripts and applies matching ones in order.
 */
export function getRegexedString(
  scripts: RegexScript[],
  rawString: string,
  placement: number,
  options?: {
    userName?: string;
    charName?: string;
    isMarkdown?: boolean;
    isPrompt?: boolean;
    isEdit?: boolean;
    depth?: number;
  },
): string {
  const userName = options?.userName ?? '{{user}}';
  const charName = options?.charName ?? '{{char}}';
  const isMarkdown = options?.isMarkdown;
  const isPrompt = options?.isPrompt;
  const isEdit = options?.isEdit;
  const depth = options?.depth;

  // WTF have you passed me?
  if (typeof rawString !== 'string') {
    console.warn('getRegexedString: rawString is not a string. Returning empty string.');
    return '';
  }

  let finalString = rawString;
  if (!rawString || placement === undefined) {
    return finalString;
  }

  scripts.forEach((script) => {
    if (
      // Script applies to Markdown and input is Markdown
      (script.markdownOnly && isMarkdown) ||
      // Script applies to Generate and input is Generate
      (script.promptOnly && isPrompt) ||
      // Script applies to all cases when neither "only"s are true, but there's no need
      // to do it when `isMarkdown`, the as source (chat history) should already be
      // changed beforehand
      (!script.markdownOnly && !script.promptOnly && !isMarkdown && !isPrompt)
    ) {
      if (isEdit && !script.runOnEdit) {
        console.debug(`getRegexedString: Skipping script ${script.scriptName ?? '(unnamed)'} because it does not run on edit`);
        return;
      }

      // Check if the depth is within the min/max depth
      if (typeof depth === 'number') {
        if (!isNaN(script.minDepth as number) && script.minDepth !== null && script.minDepth! >= -1 && depth < script.minDepth!) {
          console.debug(`getRegexedString: Skipping script ${script.scriptName ?? '(unnamed)'} because depth ${depth} is less than minDepth ${script.minDepth}`);
          return;
        }

        if (!isNaN(script.maxDepth as number) && script.maxDepth !== null && script.maxDepth! >= 0 && depth > script.maxDepth!) {
          console.debug(`getRegexedString: Skipping script ${script.scriptName ?? '(unnamed)'} because depth ${depth} is greater than maxDepth ${script.maxDepth}`);
          return;
        }
      }

      if (script.placement?.includes(placement)) {
        finalString = runRegexScript(script, finalString, { userName, charName });
      }
    }
  });

  return finalString;
}
