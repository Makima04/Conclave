// Pure-regex macro engine (v3)
// Replaces the old Chevrotain-based parser for macro expansion in card HTML.
// Handles: {{user}}, {{char}}, {{getvar::name}}, {{get::name}}, {{variable::name}},
//          {{getglobalvar::name}}, {{random::a::b}}, {{roll::NdM}}, {{date}}, {{time}}

export interface MacroContext {
  variables: Record<string, unknown>;
  globalVariables?: Record<string, unknown>;
  userName: string;
  charName: string;
}

export function createMacroContext(options: {
  variables: Record<string, unknown>;
  globalVariables?: Record<string, unknown>;
  userName: string;
  charName: string;
}): MacroContext {
  return {
    variables: options.variables ?? {},
    globalVariables: options.globalVariables ?? {},
    userName: options.userName ?? '{{user}}',
    charName: options.charName ?? '{{char}}',
  };
}

/** Parse a value as integer, return fallback if NaN. */
function parseIntSafe(value: string, fallback: number): number {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

/**
 * Process macros in HTML content using pure regex replacement.
 */
export function processMacros(html: string, ctx: MacroContext): string {
  let result = html;

  // {{user}}
  result = result.replace(/\{\{user\}\}/gi, ctx.userName);
  // {{char}}
  result = result.replace(/\{\{char\}\}/gi, ctx.charName);

  // {{getvar::name}} or {{get::name}} — expand from chat variables
  result = result.replace(/\{\{(?:getvar|get)::([^}]+)\}\}/gi, (_match, varName: string) => {
    const key = varName.trim();
    if (key in ctx.variables) {
      const val = ctx.variables[key];
      return val != null ? String(val) : '';
    }
    return _match;
  });

  // {{getglobalvar::name}} — expand from global variables
  result = result.replace(/\{\{getglobalvar::([^}]+)\}\}/gi, (_match, varName: string) => {
    const key = varName.trim();
    if (ctx.globalVariables && key in ctx.globalVariables) {
      const val = ctx.globalVariables[key];
      return val != null ? String(val) : '';
    }
    return _match;
  });

  // {{random::a::b}} — random integer between a and b (inclusive)
  result = result.replace(/\{\{random::(-?\d+)::(-?\d+)\}\}/gi, (_match, a: string, b: string) => {
    const lo = parseIntSafe(a, 0);
    const hi = parseIntSafe(b, 0);
    const min = Math.min(lo, hi);
    const max = Math.max(lo, hi);
    return String(Math.floor(Math.random() * (max - min + 1)) + min);
  });

  // {{roll::NdM}} — dice roll: N dice with M sides
  result = result.replace(/\{\{roll::(\d+)d(\d+)\}\}/gi, (_match, nStr: string, mStr: string) => {
    const n = parseIntSafe(nStr, 1);
    const m = parseIntSafe(mStr, 6);
    let total = 0;
    for (let i = 0; i < Math.min(n, 100); i++) {
      total += Math.floor(Math.random() * m) + 1;
    }
    return String(total);
  });

  // {{date}} — current date (YYYY-MM-DD)
  result = result.replace(/\{\{date\}\}/gi, () => {
    return new Date().toISOString().slice(0, 10);
  });

  // {{time}} — current time (HH:MM)
  result = result.replace(/\{\{time\}\}/gi, () => {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  });

  return result;
}
