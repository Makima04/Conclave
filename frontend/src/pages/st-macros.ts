// SillyTavern-compatible macro system for browser-side rendering.
// Implements the most commonly used ST macros without external dependencies.

import { MacroLexer } from './st-macro-lexer';
import { MacroParser } from './st-macro-parser';
import { MacroCstWalker } from './st-macro-walker';

/** Context provided to processMacros for macro resolution. */
export interface MacroContext {
  userName: string;
  charName: string;
  /** Mutable variable store shared across macro evaluations. */
  variables?: Record<string, string>;
  /** Chat messages ordered oldest-first. */
  messages?: MacroMessage[];
  /** Current user input text (for {{input}}). */
  currentInput?: string;
}

export interface MacroMessage {
  text: string;
  isUser: boolean;
  isSystem?: boolean;
  /** ISO-8601 timestamp or parseable date string. */
  timestamp?: string;
}

// ── Dice roller (no external deps) ──

interface DiceResult {
  total: number;
  rolls: number[];
  modifier: number;
}

/**
 * Parse and roll a dice formula like "3d20", "2d6+4", "d8-1".
 * Returns null on invalid input.
 */
function rollDice(formula: string): DiceResult | null {
  const trimmed = formula.trim();
  // Pure number => treat as 1d<number>
  if (/^\d+$/.test(trimmed)) {
    const sides = parseInt(trimmed, 10);
    if (sides < 1) return null;
    const val = Math.floor(Math.random() * sides) + 1;
    return { total: val, rolls: [val], modifier: 0 };
  }

  const m = trimmed.match(/^(\d*)d(\d+)\s*([+-]\s*\d+)?$/i);
  if (!m) return null;

  const count = Math.max(1, parseInt(m[1] || '1', 10));
  const sides = parseInt(m[2], 10);
  const modifier = m[3] ? parseInt(m[3].replace(/\s/g, ''), 10) : 0;

  if (sides < 1 || count > 1000) return null;

  const rolls: number[] = [];
  for (let i = 0; i < count; i++) {
    rolls.push(Math.floor(Math.random() * sides) + 1);
  }

  const sum = rolls.reduce((a, b) => a + b, 0);
  return { total: sum + modifier, rolls, modifier };
}

// ── Date/time helpers ──

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function getTimeHHMM(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function getISODate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function getWeekday(d: Date): string {
  return WEEKDAYS[d.getDay()];
}

/**
 * Format a localized date similar to moment().format('LL').
 * Uses Intl for locale-aware formatting, falling back to ISO.
 */
function getLocalizedDate(d: Date): string {
  try {
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return getISODate(d);
  }
}

/**
 * Format a localized time similar to moment().format('LT').
 * Uses Intl for locale-aware formatting, falling back to HH:MM.
 */
function getLocalizedTime(d: Date): string {
  try {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return getTimeHHMM(d);
  }
}

// ── Random/pick helpers ──

/**
 * Parse a macro argument list. Supports both comma-separated and
 * double-colon-separated lists, matching ST behavior.
 * Escaped commas (\,) are preserved as literal commas.
 */
function parseMacroList(listString: string): string[] {
  if (listString.includes('::')) {
    return listString.split('::');
  }
  return listString
    .replace(/\\,/g, '\x00COMMA\x00')
    .split(',')
    .map(item => item.trim().replace(/\x00COMMA\x00/g, ','));
}

/**
 * Simple string hash for deterministic picks (djb2).
 */
function stringHash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Seeded PRNG (mulberry32) for deterministic pick behavior.
 */
function seededRandom(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Word count helper ──

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

// ── Idle duration helper ──

function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days !== 1 ? 's' : ''}`;
}

function getIdleDuration(messages?: MacroMessage[]): string {
  if (!messages || messages.length === 0) return 'just now';
  // Find last non-system message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.isSystem) continue;
    if (msg.timestamp) {
      const lastTime = new Date(msg.timestamp).getTime();
      if (!isNaN(lastTime)) {
        return formatDuration(Date.now() - lastTime);
      }
    }
    break;
  }
  return 'just now';
}

// ── Macro definition ──

type MacroEntry = {
  regex: RegExp;
  replace: (match: string, ...args: string[]) => string;
};

/**
 * Build the ordered list of macro replacements for the given context.
 * Pre-env macros run first, then env (user/char/variables), then post-env.
 */
function buildMacros(context: MacroContext, rawContent: string): MacroEntry[] {
  const { userName, charName, variables, messages, currentInput } = context;

  // Pre-env macros (run before variable substitution)
  const preEnvMacros: MacroEntry[] = [
    // Legacy non-curly macros
    { regex: /<USER>/gi, replace: () => userName },
    { regex: /<BOT>/gi, replace: () => charName },
    { regex: /<CHAR>/gi, replace: () => charName },

    // Variable macros (mutate the variables map)
    { regex: /\{\{setvar::([^:]+)::([^}]*)\}\}/gi, replace: (_m, name, value) => {
      if (variables) variables[name.trim()] = value;
      return '';
    }},
    { regex: /\{\{addvar::([^:]+)::([^}]+)\}\}/gi, replace: (_m, name, value) => {
      if (!variables) return '';
      const key = name.trim();
      const current = variables[key] ?? '';
      const currentNum = Number(current);
      const addNum = Number(value);
      if (!isNaN(currentNum) && !isNaN(addNum)) {
        variables[key] = String(currentNum + addNum);
      } else {
        variables[key] = current + value;
      }
      return '';
    }},
    { regex: /\{\{incvar::([^}]+)\}\}/gi, replace: (_m, name) => {
      if (!variables) return '';
      const key = name.trim();
      const current = Number(variables[key] ?? '0');
      variables[key] = String(isNaN(current) ? 1 : current + 1);
      return variables[key];
    }},
    { regex: /\{\{decvar::([^}]+)\}\}/gi, replace: (_m, name) => {
      if (!variables) return '';
      const key = name.trim();
      const current = Number(variables[key] ?? '0');
      variables[key] = String(isNaN(current) ? -1 : current - 1);
      return variables[key];
    }},

    // Dice roll
    { regex: /\{\{roll[ : ]([^}]+)\}\}/gi, replace: (_m, formula) => {
      const result = rollDice(formula);
      return result ? String(result.total) : '';
    }},

    // Newline and trim
    { regex: /\{\{newline\}\}/gi, replace: () => '\n' },
    { regex: /(?:\r?\n)*\{\{trim\}\}(?:\r?\n)*/gi, replace: () => '' },
    { regex: /\{\{noop\}\}/gi, replace: () => '' },

    // Comment blocks (ST uses {{// comment}})
    { regex: /\{\{\/\/([\s\S]*?)\}\}/gm, replace: () => '' },
  ];

  // Post-env macros (run after variable substitution)
  const postEnvMacros: MacroEntry[] = [
    // Time/date macros
    { regex: /\{\{time\}\}/gi, replace: () => getLocalizedTime(new Date()) },
    { regex: /\{\{date\}\}/gi, replace: () => getLocalizedDate(new Date()) },
    { regex: /\{\{weekday\}\}/gi, replace: () => getWeekday(new Date()) },
    { regex: /\{\{isotime\}\}/gi, replace: () => getTimeHHMM(new Date()) },
    { regex: /\{\{isodate\}\}/gi, replace: () => getISODate(new Date()) },

    // Random/pick
    { regex: /\{\{random\s?::?([^}]+)\}\}/gi, replace: (_m, listString) => {
      const list = parseMacroList(listString);
      if (list.length === 0) return '';
      return list[Math.floor(Math.random() * list.length)];
    }},
    { regex: /\{\{pick\s?::?([^}]+)\}\}/gi, replace: (_m, listString, offset) => {
      const list = parseMacroList(listString);
      if (list.length === 0) return '';
      const seed = stringHash(`${rawContent}-${offset}`);
      const rng = seededRandom(seed);
      return list[Math.floor(rng() * list.length)];
    }},

    // Variable getters
    { regex: /\{\{getvar::([^}]+)\}\}/gi, replace: (_m, name) => {
      return variables?.[name.trim()] ?? '';
    }},
    { regex: /\{\{getglobalvar::([^}]+)\}\}/gi, replace: (_m, name) => {
      return variables?.[name.trim()] ?? '';
    }},

    // Message macros
    { regex: /\{\{lastMessage\}\}/gi, replace: () => {
      if (!messages || messages.length === 0) return '';
      return messages[messages.length - 1]?.text ?? '';
    }},
    { regex: /\{\{lastUserMessage\}\}/gi, replace: () => {
      if (!messages) return '';
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].isUser && !messages[i].isSystem) return messages[i].text;
      }
      return '';
    }},
    { regex: /\{\{lastCharMessage\}\}/gi, replace: () => {
      if (!messages) return '';
      for (let i = messages.length - 1; i >= 0; i--) {
        if (!messages[i].isUser && !messages[i].isSystem) return messages[i].text;
      }
      return '';
    }},
    { regex: /\{\{previousMessage\}\}/gi, replace: () => {
      if (!messages || messages.length < 2) return '';
      return messages[messages.length - 2]?.text ?? '';
    }},
    { regex: /\{\{firstIncludedMessage\}\}/gi, replace: () => {
      if (!messages || messages.length === 0) return '';
      return messages[0]?.text ?? '';
    }},

    // Idle duration
    { regex: /\{\{idle_duration\}\}/gi, replace: () => getIdleDuration(messages) },

    // Word count
    { regex: /\{\{wordcount::last\}\}/gi, replace: () => {
      if (!messages || messages.length === 0) return '0';
      return String(countWords(messages[messages.length - 1]?.text ?? ''));
    }},
    { regex: /\{\{wordcount\}\}/gi, replace: () => {
      return String(countWords(rawContent));
    }},

    // Input
    { regex: /\{\{input\}\}/gi, replace: () => currentInput ?? '' },
  ];

  // Build env macros from variables
  const envMacros: MacroEntry[] = [];
  if (variables) {
    for (const varName of Object.keys(variables)) {
      const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      envMacros.push({
        regex: new RegExp(`\\{\\{${escaped}\\}\\}`, 'gi'),
        replace: () => variables[varName] ?? '',
      });
    }
  }

  // Build env macros from user/char
  envMacros.push(
    { regex: /\{\{user\}\}/gi, replace: () => userName },
    { regex: /\{\{char\}\}/gi, replace: () => charName },
  );

  return [...preEnvMacros, ...envMacros, ...postEnvMacros];
}

const MAX_MACRO_DEPTH = 5;

/**
 * Build a named macro map for the Chevrotain CST walker.
 * Keys are lowercased macro names, values are (args, rawContent) => string handlers.
 */
export function buildNamedMacros(
  context: MacroContext,
  rawContent: string,
): Map<string, (args: string[], rawContent: string) => string> {
  const { userName, charName, variables, messages, currentInput } = context;
  const map = new Map<string, (args: string[], rawContent: string) => string>();

  // User/char
  map.set('user', () => userName);
  map.set('char', () => charName);

  // Variable macros
  map.set('setvar', (args) => {
    if (variables && args.length >= 2) variables[args[0].trim()] = args[1];
    return '';
  });
  map.set('addvar', (args) => {
    if (!variables || args.length < 2) return '';
    const key = args[0].trim();
    const cur = Number(variables[key] ?? '0');
    const add = Number(args[1]);
    variables[key] = !isNaN(cur) && !isNaN(add) ? String(cur + add) : (variables[key] ?? '') + args[1];
    return '';
  });
  map.set('incvar', (args) => {
    if (!variables || args.length < 1) return '';
    const key = args[0].trim();
    const cur = Number(variables[key] ?? '0');
    variables[key] = String(isNaN(cur) ? 1 : cur + 1);
    return variables[key];
  });
  map.set('decvar', (args) => {
    if (!variables || args.length < 1) return '';
    const key = args[0].trim();
    const cur = Number(variables[key] ?? '0');
    variables[key] = String(isNaN(cur) ? -1 : cur - 1);
    return variables[key];
  });
  map.set('getvar', (args) => variables?.[args[0]?.trim()] ?? '');
  map.set('getglobalvar', (args) => variables?.[args[0]?.trim()] ?? '');

  // Dice
  map.set('roll', (args) => {
    const result = rollDice(args.join('::'));
    return result ? String(result.total) : '';
  });

  // Static
  map.set('newline', () => '\n');
  map.set('trim', () => '');
  map.set('noop', () => '');

  // Time/date
  map.set('time', () => getLocalizedTime(new Date()));
  map.set('date', () => getLocalizedDate(new Date()));
  map.set('weekday', () => getWeekday(new Date()));
  map.set('isotime', () => getTimeHHMM(new Date()));
  map.set('isodate', () => getISODate(new Date()));

  // Random/pick
  map.set('random', (args) => {
    const list = args.length === 1 ? parseMacroList(args[0]) : args;
    return list.length > 0 ? list[Math.floor(Math.random() * list.length)] : '';
  });
  map.set('pick', (args) => {
    const list = args.length === 1 ? parseMacroList(args[0]) : args;
    if (list.length === 0) return '';
    const seed = stringHash(rawContent);
    const rng = seededRandom(seed);
    return list[Math.floor(rng() * list.length)];
  });

  // Messages
  map.set('lastmessage', () => {
    if (!messages || messages.length === 0) return '';
    return messages[messages.length - 1]?.text ?? '';
  });
  map.set('lastusermessage', () => {
    if (!messages) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].isUser && !messages[i].isSystem) return messages[i].text;
    }
    return '';
  });
  map.set('lastcharmessage', () => {
    if (!messages) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
      if (!messages[i].isUser && !messages[i].isSystem) return messages[i].text;
    }
    return '';
  });
  map.set('previousmessage', () => {
    if (!messages || messages.length < 2) return '';
    return messages[messages.length - 2]?.text ?? '';
  });
  map.set('firstincludedmessage', () => {
    if (!messages || messages.length === 0) return '';
    return messages[0]?.text ?? '';
  });

  // Misc
  map.set('idle_duration', () => getIdleDuration(messages));
  map.set('wordcount', (args) => {
    if (args[0]?.toLowerCase() === 'last') {
      if (!messages || messages.length === 0) return '0';
      return String(countWords(messages[messages.length - 1]?.text ?? ''));
    }
    return String(countWords(rawContent));
  });
  map.set('input', () => currentInput ?? '');

  // Variable keys from context (direct variable access by name)
  if (variables) {
    for (const varName of Object.keys(variables)) {
      const key = varName.toLowerCase();
      if (!map.has(key)) {
        map.set(key, () => variables[varName] ?? '');
      }
    }
  }

  return map;
}

/**
 * Process SillyTavern-compatible macros using the Chevrotain CST pipeline.
 *
 * Supports nested macros, variable expressions ({{$var}}, {{$var++}}, {{$var=value}}),
 * conditionals, comments, and all registered named macros.
 * Falls back to regex-based processing on parse errors.
 *
 * @param text - The input text containing {{macro}} patterns.
 * @param context - Provides userName, charName, variables, messages, etc.
 * @returns The text with all recognized macros expanded.
 */
export function processMacros(text: string, context: MacroContext): string {
  if (!text) return '';

  try {
    const lexResult = MacroLexer.tokenize(text);
    if (lexResult.errors.length > 0) {
      return processMacrosRegex(text, context);
    }

    MacroParser.input = lexResult.tokens;
    const cst = MacroParser.document();
    if (MacroParser.errors.length > 0) {
      return processMacrosRegex(text, context);
    }

    // Re-lex+parse for nested macros up to MAX_MACRO_DEPTH passes
    let content = text;
    for (let depth = 0; depth < MAX_MACRO_DEPTH; depth++) {
      const prev = content;
      const lr = MacroLexer.tokenize(content);
      if (lr.errors.length > 0) break;
      MacroParser.input = lr.tokens;
      const cstNode = MacroParser.document();
      if (MacroParser.errors.length > 0) break;

      const walker = new MacroCstWalker(context, content);
      content = walker.evaluateDocument(cstNode);
      if (content === prev) break;
    }

    return content;
  } catch {
    // If Chevrotain throws (missing module, etc.), fall back to regex
    return processMacrosRegex(text, context);
  }
}

/**
 * Regex-based macro processing (original implementation).
 * Kept as a fallback for malformed input that fails Chevrotain lexing/parsing.
 */
export function processMacrosRegex(text: string, context: MacroContext): string {
  if (!text) return '';
  let content = text;

  for (let depth = 0; depth < MAX_MACRO_DEPTH; depth++) {
    const prev = content;
    const macros = buildMacros(context, content);

    for (const macro of macros) {
      if (!content) break;
      // Short-circuit if no curly braces remain (skip non-curly legacy macros)
      if (!macro.regex.source.startsWith('<') && !content.includes('{{')) break;

      try {
        content = content.replace(macro.regex, (...args) => macro.replace(...args));
      } catch {
        // macro threw; skip silently like ST does
      }
    }

    // Stop if no further macro patterns remain
    if (content === prev) break;
  }

  return content;
}
