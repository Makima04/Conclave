// Chevrotain CST walker that evaluates the parsed macro tree.
// Walks the CST produced by MacroParser and resolves macros using MacroContext.

import type { CstNode, IToken } from 'chevrotain';
import type { MacroContext, MacroMessage } from './st-macros';
import { buildNamedMacros } from './st-macros';

// ── Helpers ──

/** Extract the image string from the first child matching a label. */
function firstImage(children: Record<string, (IToken | CstNode)[]>, key: string): string | undefined {
  const arr = children[key];
  if (!arr || arr.length === 0) return undefined;
  const node = arr[0];
  return 'image' in node ? (node as IToken).image : undefined;
}

/** Check if a child key exists and has entries. */
function has(children: Record<string, unknown[]>, key: string): boolean {
  return Array.isArray(children[key]) && (children[key] as unknown[]).length > 0;
}

/** Get all child CST nodes for a rule label. */
function subNodes(children: Record<string, (IToken | CstNode)[]>, key: string): CstNode[] {
  return (children[key] ?? []).filter((n): n is CstNode => 'children' in n);
}

/** Get all child tokens for a label. */
function tokens(children: Record<string, (IToken | CstNode)[]>, key: string): IToken[] {
  return (children[key] ?? []).filter((n): n is IToken => 'image' in n);
}

// ── Walker ──

export class MacroCstWalker {
  private context: MacroContext;
  private namedMacros: Map<string, (args: string[], rawContent: string) => string>;
  private rawContent: string;

  constructor(context: MacroContext, rawContent: string = '') {
    this.context = context;
    this.rawContent = rawContent;
    this.namedMacros = buildNamedMacros(context, rawContent);
  }

  /** Entry point: evaluate a document CST node. */
  evaluateDocument(cst: CstNode | null): string {
    if (!cst) return '';
    return this.walkDocument(cst);
  }

  // ── Document ──

  private walkDocument(node: CstNode): string {
    const parts: string[] = [];
    const ch = node.children;

    // Plaintext tokens
    for (const tok of tokens(ch, 'plaintext')) {
      parts.push(tok.image);
    }

    // Macro sub-rules
    for (const macro of subNodes(ch, 'macro')) {
      parts.push(this.walkMacro(macro));
    }

    return parts.join('');
  }

  // ── Macro ──

  private walkMacro(node: CstNode): string {
    const ch = node.children;

    // Collect flags
    const flagTokens = tokens(ch, 'flags');
    const flags = flagTokens.map(t => t.image);
    const isComment = flags.includes('//') || has(ch, 'Macro.DoubleSlash');

    // Variable expression branch
    if (has(ch, 'variableExpr')) {
      const varNode = subNodes(ch, 'variableExpr')[0];
      return this.walkVariableExpr(varNode);
    }

    // Macro body branch
    if (has(ch, 'macroBody')) {
      const bodyNode = subNodes(ch, 'macroBody')[0];
      return this.walkMacroBody(bodyNode, flags, isComment);
    }

    return '';
  }

  // ── Variable expression: {{$var}}, {{$var=value}}, {{$var++}}, {{.var}} ──

  private walkVariableExpr(node: CstNode): string {
    const ch = node.children;

    const scopeToken = tokens(ch, 'Var.scope')[0];
    const idToken = tokens(ch, 'Var.identifier')[0];
    if (!idToken) return '';

    const varName = idToken.image;
    const isGlobal = scopeToken?.image === '$';
    const store = this.context.variables ?? {};

    // No operator → read
    if (!has(ch, 'variableOperator')) {
      return store[varName] ?? '';
    }

    const opNode = subNodes(ch, 'variableOperator')[0];
    return this.walkVariableOperator(opNode, varName, store);
  }

  private walkVariableOperator(node: CstNode, varName: string, store: Record<string, string>): string {
    const ch = node.children;
    const opToken = tokens(ch, 'Var.operator')[0];
    if (!opToken) return store[varName] ?? '';

    const op = opToken.image;
    const current = store[varName] ?? '';
    const currentNum = Number(current);

    // ++ / -- (no value needed)
    if (op === '++') {
      const next = isNaN(currentNum) ? 1 : currentNum + 1;
      store[varName] = String(next);
      return String(next);
    }
    if (op === '--') {
      const next = isNaN(currentNum) ? -1 : currentNum - 1;
      store[varName] = String(next);
      return String(next);
    }

    // Operators with value
    const value = has(ch, 'variableValue')
      ? this.walkVariableValue(subNodes(ch, 'variableValue')[0])
      : '';
    const valueNum = Number(value);

    switch (op) {
      case '=':
        store[varName] = value;
        return value;
      case '+=':
        if (!isNaN(currentNum) && !isNaN(valueNum)) {
          store[varName] = String(currentNum + valueNum);
        } else {
          store[varName] = current + value;
        }
        return store[varName];
      case '-=':
        store[varName] = String((isNaN(currentNum) ? 0 : currentNum) - (isNaN(valueNum) ? 0 : valueNum));
        return store[varName];
      case '??=':
        if (current === '' || current === undefined || current === null) {
          store[varName] = value;
        }
        return store[varName];
      case '||=':
        if (!current || current === 'false' || current === '0') {
          store[varName] = value;
        }
        return store[varName];
      case '==':
        return String(current === value);
      case '!=':
        return String(current !== value);
      case '>=':
        return !isNaN(currentNum) && !isNaN(valueNum) ? String(currentNum >= valueNum) : String(current >= value);
      case '>':
        return !isNaN(currentNum) && !isNaN(valueNum) ? String(currentNum > valueNum) : String(current > value);
      case '<=':
        return !isNaN(currentNum) && !isNaN(valueNum) ? String(currentNum <= valueNum) : String(current <= value);
      case '<':
        return !isNaN(currentNum) && !isNaN(valueNum) ? String(currentNum < valueNum) : String(current < value);
      case '||':
        return current || value;
      case '??':
        return current ?? value;
      default:
        return current;
    }
  }

  private walkVariableValue(node: CstNode): string {
    const ch = node.children;
    const parts: string[] = [];

    for (const macro of subNodes(ch, 'macro')) {
      parts.push(this.walkMacro(macro));
    }
    for (const tok of tokens(ch, 'Identifier')) {
      parts.push(tok.image);
    }
    for (const tok of tokens(ch, 'Unknown')) {
      parts.push(tok.image);
    }

    return parts.join('').trim();
  }

  // ── Macro body: identifier + arguments ──

  private walkMacroBody(node: CstNode, flags: string[], isComment: boolean): string {
    const ch = node.children;

    // Comment: {{// ...}} → empty
    if (isComment) return '';

    const idToken = tokens(ch, 'Macro.identifier')[0];
    if (!idToken) return '';

    const macroName = idToken.image.toLowerCase();

    // Parse arguments
    const args: string[] = [];
    if (has(ch, 'arguments')) {
      const argsNode = subNodes(ch, 'arguments')[0];
      args.push(...this.walkArguments(argsNode));
    }

    // Look up and evaluate
    const handler = this.namedMacros.get(macroName);
    if (handler) {
      try {
        return handler(args, this.rawContent);
      } catch {
        return '';
      }
    }

    // If macro name matches a variable key, return its value
    const varValue = this.context.variables?.[macroName];
    if (varValue !== undefined) return varValue;

    // Unknown macro → return empty (don't leak the raw macro text)
    return '';
  }

  private walkArguments(node: CstNode): string[] {
    const ch = node.children;
    const result: string[] = [];

    for (const arg of subNodes(ch, 'argument')) {
      result.push(this.walkArgument(arg));
    }
    // Also handle argumentAllowingColons (first alternative without double-colon separator)
    for (const arg of subNodes(ch, 'argumentAllowingColons')) {
      result.push(this.walkArgument(arg));
    }

    return result;
  }

  private walkArgument(node: CstNode): string {
    const ch = node.children;
    const parts: string[] = [];

    for (const macro of subNodes(ch, 'macro')) {
      parts.push(this.walkMacro(macro));
    }
    for (const tok of tokens(ch, 'Identifier')) {
      parts.push(tok.image);
    }
    for (const tok of tokens(ch, 'Unknown')) {
      parts.push(tok.image);
    }
    for (const tok of tokens(ch, 'Args.Colon')) {
      parts.push(tok.image);
    }
    for (const tok of tokens(ch, 'Args.Equals')) {
      parts.push(tok.image);
    }
    for (const tok of tokens(ch, 'Args.Quote')) {
      parts.push(tok.image);
    }

    return parts.join('');
  }
}
