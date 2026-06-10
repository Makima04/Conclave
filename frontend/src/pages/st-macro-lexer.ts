// Chevrotain-based multi-mode lexer for SillyTavern-compatible macro syntax.
// Follows ST's MacroLexer.js pattern faithfully, adapted for TypeScript.

import { createToken, Lexer } from 'chevrotain';
import type { TokenType, IMultiModeLexerDefinition } from 'chevrotain';

// ── Token pattern constants ──

/** Regex for lexer token matching (no anchors). */
const IDENTIFIER_LEXER_PATTERN = /[a-zA-Z][\w-_]*/;

/**
 * Pattern for valid variable shorthand identifiers.
 * Must start with a letter, optionally followed by word chars/hyphens,
 * but must end with a word character (not a hyphen).
 */
const VARIABLE_IDENTIFIER_PATTERN = /[a-zA-Z](?:[\w\-_]*[\w])?/;

// ── Lexer modes ──

const modes = Object.freeze({
  plaintext: 'plaintext_mode',
  macro_def: 'macro_def_mode',
  macro_identifier_end: 'macro_identifier_end_mode',
  macro_args: 'macro_args_mode',
  macro_filter_modifier: 'macro_filter_modifier_mode',
  macro_filter_modifier_end: 'macro_filter_modifier_end_mode',
  var_identifier: 'var_identifier_mode',
  var_after_identifier: 'var_after_identifier_mode',
  var_value: 'var_value_mode',
});

// ── Token definitions ──

const Tokens = Object.freeze({
  /** Plaintext: any character that is not the first '{' of '{{' */
  Plaintext: createToken({ name: 'Plaintext', pattern: /(?:[^{]|\{(?!\{))+/u, line_breaks: true }),
  /** Single literal '{' immediately before '{{' */
  PlaintextOpenBrace: createToken({ name: 'Plaintext.OpenBrace', pattern: /\{(?=\{\{)/ }),

  Macro: {
    Start: createToken({ name: 'Macro.Start', pattern: /\{\{/ }),
    /** Closing block flag `/` and other flags */
    Flags: createToken({ name: 'Macro.Flag', pattern: /[!?~#/]/ }),
    /** Filter flag `>` - changes pipe behavior */
    FilterFlag: createToken({ name: 'Macro.FilterFlag', pattern: />/ }),
    /** Double-slash for comments: `{{// comment}}` */
    DoubleSlash: createToken({ name: 'Macro.DoubleSlash', pattern: /\/\// }),
    /** Macro identifier (name) */
    Identifier: createToken({ name: 'Macro.Identifier', pattern: IDENTIFIER_LEXER_PATTERN }),
    /** End-of-identifier lookahead (whitespace, colon, pipe, or closing braces) */
    EndOfIdentifier: createToken({ name: 'Macro.EndOfIdentifier', pattern: /(?:\s+|(?=:{1,2})|(?=[|}]))/, group: Lexer.SKIPPED }),
    /** Lookahead for closing braces */
    BeforeEnd: createToken({ name: 'Macro.BeforeEnd', pattern: /(?=\}\})/, group: Lexer.SKIPPED }),
    End: createToken({ name: 'Macro.End', pattern: /\}\}/ }),
  },

  Args: {
    DoubleColon: createToken({ name: 'Args.DoubleColon', pattern: /::/ }),
    Colon: createToken({ name: 'Args.Colon', pattern: /:/ }),
    Equals: createToken({ name: 'Args.Equals', pattern: /=/ }),
    Quote: createToken({ name: 'Args.Quote', pattern: /"/ }),
  },

  Filter: {
    EscapedPipe: createToken({ name: 'Filter.EscapedPipe', pattern: /\\\|/ }),
    Pipe: createToken({ name: 'Filter.Pipe', pattern: /\|/ }),
    Identifier: createToken({ name: 'Filter.Identifier', pattern: IDENTIFIER_LEXER_PATTERN }),
    EndOfIdentifier: createToken({ name: 'Filter.EndOfIdentifier', pattern: /(?:\s+|(?=:{1,2})|(?=[|}]))/, group: Lexer.SKIPPED }),
  },

  Identifier: createToken({ name: 'Identifier', pattern: IDENTIFIER_LEXER_PATTERN }),
  WhiteSpace: createToken({ name: 'WhiteSpace', pattern: /\s+/, group: Lexer.SKIPPED }),

  Var: {
    LocalPrefix: createToken({ name: 'Var.LocalPrefix', pattern: /\./ }),
    GlobalPrefix: createToken({ name: 'Var.GlobalPrefix', pattern: /\$/ }),
    Identifier: createToken({ name: 'Var.Identifier', pattern: VARIABLE_IDENTIFIER_PATTERN }),
    Operators: {
      Increment: createToken({ name: 'Var.Increment', pattern: /\+\+/ }),
      Decrement: createToken({ name: 'Var.Decrement', pattern: /--/ }),
      NullishCoalescingEquals: createToken({ name: 'Var.NullishCoalescingEquals', pattern: /\?\?=/ }),
      NullishCoalescing: createToken({ name: 'Var.NullishCoalescing', pattern: /\?\?/ }),
      LogicalOrEquals: createToken({ name: 'Var.LogicalOrEquals', pattern: /\|\|=/ }),
      LogicalOr: createToken({ name: 'Var.LogicalOr', pattern: /\|\|/ }),
      MinusEquals: createToken({ name: 'Var.MinusEquals', pattern: /-=/ }),
      DoubleEquals: createToken({ name: 'Var.DoubleEquals', pattern: /==/ }),
      NotEquals: createToken({ name: 'Var.NotEquals', pattern: /!=/ }),
      GreaterThanOrEqual: createToken({ name: 'Var.GreaterThanOrEqual', pattern: />=/ }),
      GreaterThan: createToken({ name: 'Var.GreaterThan', pattern: />/ }),
      LessThanOrEqual: createToken({ name: 'Var.LessThanOrEqual', pattern: /<=/ }),
      LessThan: createToken({ name: 'Var.LessThan', pattern: /</ }),
      PlusEquals: createToken({ name: 'Var.PlusEquals', pattern: /\+=/ }),
      Equals: createToken({ name: 'Var.Equals', pattern: /=/ }),
    },
  },

  /** Single unknown character (not `}}`) - allows other tokens to match later */
  Unknown: createToken({ name: 'Unknown', pattern: /([^}]|\}(?!\}))/ }),

  /** Capture-all rest between `}}` and `{{` */
  Text: createToken({ name: 'Text', pattern: /.+(?=\}\}|\{\{)/, line_breaks: true }),

  /**
   * Fallback token to pop the current mode when no other token matches.
   * Always the last token in each mode's list.
   */
  ModePopper: createToken({ name: 'ModePopper', pattern: () => [''], line_breaks: false, group: Lexer.SKIPPED }),
});

// ── Mode transition helpers ──

/** Saves all token definitions that are marked as entering modes */
const enterModesMap = new Map<string, string>();

/**
 * Marks a token to push a lexer mode when matched.
 * Optionally also marks it to pop another mode.
 */
function enter(token: TokenType, mode: string, { andExits }: { andExits?: string } = {}): TokenType {
  if (!token) throw new Error('Token must not be undefined');
  if (enterModesMap.has(token.name) && enterModesMap.get(token.name) !== mode) {
    throw new Error(`Token ${token.name} already enters mode ${enterModesMap.get(token.name)}. Cannot enter ${mode}.`);
  }
  if (andExits) exits(token, andExits);
  (token as any).PUSH_MODE = mode;
  enterModesMap.set(token.name, mode);
  return token;
}

/**
 * Marks a token to pop the current lexer mode when matched.
 */
function exits(token: TokenType, _mode?: string): TokenType {
  if (!token) throw new Error('Token must not be undefined');
  (token as any).POP_MODE = true;
  return token;
}

/**
 * Marks a token as used in a mode without entering/exiting.
 * Validates it's not already marked to enter a mode.
 */
function using(token: TokenType): TokenType {
  if (!token) throw new Error('Token must not be undefined');
  if (enterModesMap.has(token.name)) {
    throw new Error(`Token ${token.name} is already marked to enter a mode (${enterModesMap.get(token.name)}).`);
  }
  return token;
}

// ── Lexer definition (multi-mode) ──

const Def: IMultiModeLexerDefinition = {
  modes: {
    [modes.plaintext]: [
      using(Tokens.Plaintext),
      using(Tokens.PlaintextOpenBrace),
      enter(Tokens.Macro.Start, modes.macro_def),
    ],

    [modes.macro_def]: [
      exits(Tokens.Macro.End, modes.macro_def),

      // Double-slash for comments - must come before single flags
      enter(Tokens.Macro.DoubleSlash, modes.macro_args),

      // Variable shorthand prefixes
      enter(Tokens.Var.LocalPrefix, modes.var_identifier),
      enter(Tokens.Var.GlobalPrefix, modes.var_identifier),

      using(Tokens.Macro.Flags),
      using(Tokens.Macro.FilterFlag),
      using(Tokens.WhiteSpace),

      // Macro identifier enters identifier-end mode
      enter(Tokens.Macro.Identifier, modes.macro_identifier_end),

      // Fallback exit
      exits(Tokens.ModePopper, modes.macro_def),
    ],

    [modes.macro_identifier_end]: [
      exits(Tokens.Macro.BeforeEnd, modes.macro_identifier_end),
      enter(Tokens.Macro.EndOfIdentifier, modes.macro_args, { andExits: modes.macro_identifier_end }),
    ],

    [modes.macro_args]: [
      // Nested macros
      enter(Tokens.Macro.Start, modes.macro_def),

      using(Tokens.Filter.EscapedPipe),
      enter(Tokens.Filter.Pipe, modes.macro_filter_modifier),

      using(Tokens.Args.DoubleColon),
      using(Tokens.Args.Colon),
      using(Tokens.Args.Equals),
      using(Tokens.Args.Quote),
      using(Tokens.Identifier),
      using(Tokens.WhiteSpace),
      using(Tokens.Unknown),

      // Fallback exit
      exits(Tokens.ModePopper, modes.macro_args),
    ],

    [modes.macro_filter_modifier]: [
      using(Tokens.WhiteSpace),
      enter(Tokens.Filter.Identifier, modes.macro_filter_modifier_end, { andExits: modes.macro_filter_modifier }),
    ],

    [modes.macro_filter_modifier_end]: [
      exits(Tokens.Macro.BeforeEnd, modes.macro_identifier_end),
      exits(Tokens.Filter.EndOfIdentifier, modes.macro_filter_modifier),
    ],

    // After `.` or `$`, expect a variable identifier
    [modes.var_identifier]: [
      using(Tokens.WhiteSpace),
      enter(Tokens.Var.Identifier, modes.var_after_identifier, { andExits: modes.var_identifier }),
      exits(Tokens.ModePopper, modes.var_identifier),
    ],

    // After variable identifier, look for operators or end
    [modes.var_after_identifier]: [
      using(Tokens.WhiteSpace),
      using(Tokens.Var.Operators.Increment),
      using(Tokens.Var.Operators.Decrement),
      enter(Tokens.Var.Operators.NullishCoalescingEquals, modes.var_value, { andExits: modes.var_after_identifier }),
      enter(Tokens.Var.Operators.NullishCoalescing, modes.var_value, { andExits: modes.var_after_identifier }),
      enter(Tokens.Var.Operators.LogicalOrEquals, modes.var_value, { andExits: modes.var_after_identifier }),
      enter(Tokens.Var.Operators.LogicalOr, modes.var_value, { andExits: modes.var_after_identifier }),
      enter(Tokens.Var.Operators.MinusEquals, modes.var_value, { andExits: modes.var_after_identifier }),
      enter(Tokens.Var.Operators.DoubleEquals, modes.var_value, { andExits: modes.var_after_identifier }),
      enter(Tokens.Var.Operators.NotEquals, modes.var_value, { andExits: modes.var_after_identifier }),
      enter(Tokens.Var.Operators.GreaterThanOrEqual, modes.var_value, { andExits: modes.var_after_identifier }),
      enter(Tokens.Var.Operators.GreaterThan, modes.var_value, { andExits: modes.var_after_identifier }),
      enter(Tokens.Var.Operators.LessThanOrEqual, modes.var_value, { andExits: modes.var_after_identifier }),
      enter(Tokens.Var.Operators.LessThan, modes.var_value, { andExits: modes.var_after_identifier }),
      enter(Tokens.Var.Operators.PlusEquals, modes.var_value, { andExits: modes.var_after_identifier }),
      enter(Tokens.Var.Operators.Equals, modes.var_value, { andExits: modes.var_after_identifier }),
      exits(Tokens.Macro.BeforeEnd, modes.var_after_identifier),
      exits(Tokens.ModePopper, modes.var_after_identifier),
    ],

    // After `=` or `+=`, capture the value (can contain nested macros)
    [modes.var_value]: [
      enter(Tokens.Macro.Start, modes.macro_def),
      using(Tokens.Identifier),
      using(Tokens.WhiteSpace),
      using(Tokens.Unknown),
      exits(Tokens.ModePopper, modes.var_value),
    ],
  },
  defaultMode: modes.plaintext,
};

// ── Lexer singleton ──

class MacroLexerImpl extends Lexer {
  private static _instance: MacroLexerImpl;
  static get instance(): MacroLexerImpl {
    return MacroLexerImpl._instance ?? (MacroLexerImpl._instance = new MacroLexerImpl());
  }

  static readonly tokens = Tokens;
  static readonly def = Def;
  readonly tokens = Tokens;
  readonly def = MacroLexerImpl.def;

  private constructor() {
    super(MacroLexerImpl.def, { traceInitPerf: false });
  }

  test(input: string) {
    const result = this.tokenize(input);
    return {
      errors: result.errors,
      groups: result.groups,
      tokens: result.tokens.map(({ tokenType, ...rest }) => ({ type: tokenType.name, ...rest, tokenType })),
    };
  }
}

export const MacroLexer = MacroLexerImpl.instance;
export { Tokens, Def, MacroLexerImpl };
export type { modes as MacroLexerModes };
