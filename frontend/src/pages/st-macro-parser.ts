// Chevrotain-based CST parser for SillyTavern-compatible macro syntax.
// Follows ST's MacroParser.js grammar faithfully, adapted for TypeScript.

import { CstParser } from 'chevrotain';
import type { CstNode, ILexingError, IRecognitionException } from 'chevrotain';
import { MacroLexer, Tokens } from './st-macro-lexer';

class MacroParserImpl extends CstParser {
  private static _instance: MacroParserImpl;
  static get instance(): MacroParserImpl {
    return MacroParserImpl._instance ?? (MacroParserImpl._instance = new MacroParserImpl());
  }

  // Grammar rules are instance properties assigned in the constructor
  document!: () => CstNode;
  macro!: () => CstNode;
  macroBody!: () => CstNode;
  variableExpr!: () => CstNode;
  variableOperator!: () => CstNode;
  variableValue!: () => CstNode;
  arguments!: () => CstNode;
  argument!: () => CstNode;
  argumentAllowingColons!: () => CstNode;

  private constructor() {
    super(MacroLexer.def, {
      traceInitPerf: false,
      nodeLocationTracking: 'full',
      recoveryEnabled: true,
    });

    const $ = this;

    // Top-level document: (plaintext | macro)*
    $.document = $.RULE('document', () => {
      $.MANY(() => {
        $.OR([
          { ALT: () => $.CONSUME(Tokens.Plaintext, { LABEL: 'plaintext' }) },
          { ALT: () => $.CONSUME(Tokens.PlaintextOpenBrace, { LABEL: 'plaintext' }) },
          { ALT: () => $.SUBRULE($.macro) },
          { ALT: () => $.CONSUME(Tokens.Macro.Start, { LABEL: 'plaintext' }) },
        ]);
      });
    });

    // Macro: MacroStart (variableExpr | macroBody) MacroEnd
    $.macro = $.RULE('macro', () => {
      $.CONSUME(Tokens.Macro.Start);

      // Optional flags before identifier
      $.MANY(() => {
        $.OR1([
          { ALT: () => $.CONSUME(Tokens.Macro.Flags, { LABEL: 'flags' }) },
          { ALT: () => $.CONSUME(Tokens.Macro.FilterFlag, { LABEL: 'flags' }) },
        ]);
      });

      // Branch: variable expression or regular macro
      $.OR([
        { ALT: () => $.SUBRULE($.variableExpr) },
        { ALT: () => $.SUBRULE($.macroBody) },
      ]);

      $.CONSUME(Tokens.Macro.End);
    });

    // Regular macro body: identifier + optional arguments
    $.macroBody = $.RULE('macroBody', () => {
      $.OR2([
        { ALT: () => $.CONSUME(Tokens.Macro.DoubleSlash, { LABEL: 'Macro.identifier' }) },
        { ALT: () => $.CONSUME(Tokens.Macro.Identifier, { LABEL: 'Macro.identifier' }) },
      ]);
      $.OPTION(() => $.SUBRULE($.arguments));
    });

    // Variable expression: . or $ prefix + identifier + optional operator
    $.variableExpr = $.RULE('variableExpr', () => {
      $.OR3([
        { ALT: () => $.CONSUME(Tokens.Var.LocalPrefix, { LABEL: 'Var.scope' }) },
        { ALT: () => $.CONSUME(Tokens.Var.GlobalPrefix, { LABEL: 'Var.scope' }) },
      ]);
      $.CONSUME(Tokens.Var.Identifier, { LABEL: 'Var.identifier' });
      $.OPTION2(() => $.SUBRULE($.variableOperator));
    });

    // Variable operator: ++, --, = value, += value, etc.
    $.variableOperator = $.RULE('variableOperator', () => {
      $.OR4([
        { ALT: () => $.CONSUME(Tokens.Var.Operators.Increment, { LABEL: 'Var.operator' }) },
        { ALT: () => $.CONSUME(Tokens.Var.Operators.Decrement, { LABEL: 'Var.operator' }) },
        {
          ALT: () => {
            $.OR5([
              { ALT: () => $.CONSUME(Tokens.Var.Operators.NullishCoalescingEquals, { LABEL: 'Var.operator' }) },
              { ALT: () => $.CONSUME(Tokens.Var.Operators.NullishCoalescing, { LABEL: 'Var.operator' }) },
              { ALT: () => $.CONSUME(Tokens.Var.Operators.LogicalOrEquals, { LABEL: 'Var.operator' }) },
              { ALT: () => $.CONSUME(Tokens.Var.Operators.LogicalOr, { LABEL: 'Var.operator' }) },
              { ALT: () => $.CONSUME(Tokens.Var.Operators.MinusEquals, { LABEL: 'Var.operator' }) },
              { ALT: () => $.CONSUME(Tokens.Var.Operators.DoubleEquals, { LABEL: 'Var.operator' }) },
              { ALT: () => $.CONSUME(Tokens.Var.Operators.NotEquals, { LABEL: 'Var.operator' }) },
              { ALT: () => $.CONSUME(Tokens.Var.Operators.GreaterThanOrEqual, { LABEL: 'Var.operator' }) },
              { ALT: () => $.CONSUME(Tokens.Var.Operators.GreaterThan, { LABEL: 'Var.operator' }) },
              { ALT: () => $.CONSUME(Tokens.Var.Operators.LessThanOrEqual, { LABEL: 'Var.operator' }) },
              { ALT: () => $.CONSUME(Tokens.Var.Operators.LessThan, { LABEL: 'Var.operator' }) },
              { ALT: () => $.CONSUME(Tokens.Var.Operators.PlusEquals, { LABEL: 'Var.operator' }) },
              { ALT: () => $.CONSUME(Tokens.Var.Operators.Equals, { LABEL: 'Var.operator' }) },
            ]);
            $.SUBRULE($.variableValue, { LABEL: 'Var.value' });
          },
        },
      ]);
    });

    // Variable value: everything after = or += until end
    $.variableValue = $.RULE('variableValue', () => {
      $.MANY2(() => {
        $.OR5([
          { ALT: () => $.SUBRULE($.macro) },
          { ALT: () => $.CONSUME(Tokens.Identifier) },
          { ALT: () => $.CONSUME(Tokens.Unknown) },
        ]);
      });
    });

    // Arguments parsing
    $.arguments = $.RULE('arguments', () => {
      $.OR([
        {
          ALT: () => {
            $.CONSUME(Tokens.Args.DoubleColon, { LABEL: 'separator' });
            $.AT_LEAST_ONE_SEP({
              SEP: Tokens.Args.DoubleColon,
              DEF: () => $.SUBRULE($.argument, { LABEL: 'argument' }),
            });
          },
        },
        {
          ALT: () => {
            $.OPTION(() => {
              $.CONSUME(Tokens.Args.Colon, { LABEL: 'separator' });
            });
            $.SUBRULE($.argumentAllowingColons, { LABEL: 'argument' });
          },
          IGNORE_AMBIGUITIES: true,
        },
      ]);
    });

    const validArgumentTokens = [
      { ALT: () => $.SUBRULE($.macro) },
      { ALT: () => $.CONSUME(Tokens.Identifier) },
      { ALT: () => $.CONSUME(Tokens.Unknown) },
      { ALT: () => $.CONSUME(Tokens.Args.Colon) },
      { ALT: () => $.CONSUME(Tokens.Args.Equals) },
      { ALT: () => $.CONSUME(Tokens.Args.Quote) },
    ];

    $.argument = $.RULE('argument', () => {
      $.MANY(() => {
        $.OR([...validArgumentTokens]);
      });
    });

    $.argumentAllowingColons = $.RULE('argumentAllowingColons', () => {
      $.AT_LEAST_ONE(() => {
        $.OR([
          ...validArgumentTokens,
          { ALT: () => $.CONSUME(Tokens.Args.DoubleColon) },
        ]);
      });
    });

    this.performSelfAnalysis();
  }

  /**
   * Parses input text into a CST.
   */
  parseDocument(input: string): {
    cst: CstNode | null;
    errors: Array<{ message: string } | ILexingError | IRecognitionException>;
    lexingErrors: ILexingError[];
    parserErrors: IRecognitionException[];
  } {
    if (!input) {
      return { cst: null, errors: [{ message: 'Input is empty' }], lexingErrors: [], parserErrors: [] };
    }

    const lexingResult = MacroLexer.tokenize(input);
    this.input = lexingResult.tokens;
    const cst = this.document();

    const errors = [...lexingResult.errors, ...this.errors];
    return { cst, errors, lexingErrors: lexingResult.errors, parserErrors: this.errors };
  }
}

export const MacroParser = MacroParserImpl.instance;
export { MacroParserImpl };
