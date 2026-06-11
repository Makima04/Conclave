// Pure-regex macro engine (v3)
// Replaces the old Chevrotain-based parser for macro expansion in card HTML.
// Handles: {{user}}, {{char}}, {{getvar::name}}, {{get::name}}, {{variable::name}}

export interface MacroContext {
  variables: Record<string, unknown>;
  userName: string;
  charName: string;
}

export function createMacroContext(options: {
  variables: Record<string, unknown>;
  userName: string;
  charName: string;
}): MacroContext {
  return {
    variables: options.variables ?? {},
    userName: options.userName ?? '{{user}}',
    charName: options.charName ?? '{{char}}',
  };
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

  // {{getvar::name}} or {{get::name}} — expand from variables
  result = result.replace(/\{\{(?:getvar|get)::([^}]+)\}\}/gi, (_match, varName: string) => {
    const key = varName.trim();
    if (key in ctx.variables) {
      const val = ctx.variables[key];
      return val != null ? String(val) : '';
    }
    return _match;
  });

  return result;
}
