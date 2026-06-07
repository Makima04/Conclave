// Universal SillyTavern regex_scripts executor
// Runs all non-disabled regex_scripts from a character card against content,
// producing a single HTML string for sandbox rendering.

export interface RegexScript {
  findRegex: string;
  replaceString: string;
  disabled?: boolean;
  promptOnly?: boolean;
  markdownOnly?: boolean;
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

type FindMatcher = {
  regex: RegExp;
  mode: 'regex' | 'literal';
};

/**
 * Parse a findRegex string into a RegExp.
 * - `/pattern/flags` form  -> RegExp with extracted pattern and flags
 * - Anything else          -> SillyTavern-style regex source with 'g' flag
 *
 * Returns null if the pattern is syntactically invalid.
 */
export function parseFindRegex(findRegex: string): RegExp | null {
  return parseFindMatcher(findRegex)?.regex ?? null;
}

function parseFindMatcher(findRegex: string): FindMatcher | null {
  if (typeof findRegex !== 'string' || !findRegex) return null;

  // /pattern/flags form
  if (findRegex.startsWith('/')) {
    const lastSlash = findRegex.lastIndexOf('/');
    if (lastSlash > 0) {
      const pattern = findRegex.slice(1, lastSlash);
      const rawFlags = findRegex.slice(lastSlash + 1);
      // Keep only valid JS regex flags
      const flags = rawFlags.replace(/[^dgimsuvy]/g, '');
      // Ensure global so replace works across all occurrences
      const finalFlags = flags.includes('g') ? flags : `${flags}g`;
      try {
        return { regex: new RegExp(pattern, finalFlags), mode: 'regex' };
      } catch {
        return null;
      }
    }
  }

  // SillyTavern stores most findRegex values as raw regex sources, not JS
  // literal strings. For example "\\[开局\\]" must match "[开局]".
  try {
    return { regex: new RegExp(findRegex, 'g'), mode: 'regex' };
  } catch {
    // Some older/local cards use plain strings with regex-special characters.
    // Keep them usable by falling back to an escaped literal matcher.
    try {
      const escaped = findRegex.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return { regex: new RegExp(escaped, 'g'), mode: 'literal' };
    } catch {
      return null;
    }
  }
}

/**
 * Strip markdown code fences from a string.
 * Handles ```html ... ``` and plain ``` ... ```.
 */
function stripCodeFences(source: string): string {
  const trimmed = source.trim();
  if (!trimmed.startsWith('```')) return source;
  const firstBreak = trimmed.indexOf('\n');
  if (firstBreak < 0) return source;
  const withoutOpen = trimmed.slice(firstBreak + 1);
  const close = withoutOpen.lastIndexOf('```');
  return close >= 0 ? withoutOpen.slice(0, close) : withoutOpen;
}

/**
 * Basic macro substitution: {{user}}, {{char}}, and common variants.
 */
function substituteMacros(
  text: string,
  userName: string,
  charName: string,
): string {
  return text
    .replace(/\{\{user\}\}/gi, userName)
    .replace(/\{\{char\}\}/gi, charName)
    .replace(/<user>/gi, userName)
    .replace(/<\/user>/gi, '')
    .replace(/<char>/gi, charName)
    .replace(/<\/char>/gi, '');
}

/**
 * Check whether a replaceString contains "complex" HTML that should go
 * through the sandbox iframe rather than inline rendering.
 */
function isComplexHtml(source: string): boolean {
  if (source.length > 3000) return true;
  if (/<html\b|<style\b|<script\b/i.test(source)) return true;
  return false;
}

/**
 * Execute all non-disabled regex_scripts from a card against the given content.
 *
 * Returns the concatenated (and macro-substituted) replacement HTML,
 * along with diagnostics for any scripts that failed to parse.
 */
export function executeStRegexScripts(
  card: { extensions?: { regex_scripts?: RegexScript[] } } | null,
  content: string,
  options: { userName?: string; charName?: string } = {},
): StRegexResult {
  const diagnostics: StRegexDiagnostic[] = [];
  const scripts = card?.extensions?.regex_scripts;
  if (!Array.isArray(scripts) || scripts.length === 0) {
    return { html: '', matched: false, diagnostics };
  }

  const userName = options.userName ?? '{{user}}';
  const charName = options.charName ?? '{{char}}';

  let output = content;
  let anyMatched = false;

  for (const script of scripts) {
    // Skip disabled or scripts not meant for display
    if (script?.disabled) continue;
    if (typeof script.findRegex !== 'string' || typeof script.replaceString !== 'string') continue;
    if (!script.findRegex || !script.replaceString) continue;

    const matcher = parseFindMatcher(script.findRegex);
    if (!matcher) {
      diagnostics.push({
        level: 'warn',
        message: `Invalid regex pattern: ${script.findRegex.slice(0, 120)}`,
      });
      continue;
    }
    const { regex } = matcher;

    // Reset lastIndex for safety (in case the regex was reused)
    regex.lastIndex = 0;

    const cleaned = stripCodeFences(script.replaceString);
    const macroed = substituteMacros(cleaned, userName, charName);

    if (regex.test(output)) {
      anyMatched = true;
      // Reset lastIndex again after test()
      regex.lastIndex = 0;
      output = output.replace(regex, macroed);
    } else if (isComplexHtml(macroed)) {
      diagnostics.push({
        level: 'info',
        message: `Skipped complex UI script because findRegex did not match: ${script.findRegex.slice(0, 120)}`,
      });
    }
  }

  // The final output may contain the original text plus injected HTML.
  // We only return it as sandbox HTML if something actually matched/produced complex output.
  if (!anyMatched) {
    return { html: '', matched: false, diagnostics };
  }

  return {
    html: output,
    matched: true,
    diagnostics,
  };
}
