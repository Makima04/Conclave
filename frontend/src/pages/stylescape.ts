// CSS style tag scoping for card messages
// Port of ST's encodeStyleTags / decodeStyleTags from
// public/scripts/chats.js:536-626
//
// Flow: <style>CSS</style> → <custom-style>uri(CSS)</custom-style>
//        → DOMPurify passes it through → <style>scopedCSS</style>
//
// Uses @adobe/css-tools to parse CSS AST and scope selectors,
// matching ST's behavior: prefix selectors with ".mes-text " and
// add "custom-" prefix to all class names.

import { parse, stringify } from '@adobe/css-tools';

const STYLE_ENCODE_REGEX = /<style>(.+?)<\/style>/gims;
const STYLE_DECODE_REGEX = /<custom-style>(.+?)<\/custom-style>/gms;

/**
 * Encode <style> tags into <custom-style> wrappers so DOMPurify
 * doesn't strip them. CSS content is URI-encoded.
 */
export function encodeStyleTags(html: string): string {
  return html.replace(STYLE_ENCODE_REGEX, (_substring: string, css: string) => {
    return `<custom-style>${encodeURIComponent(css)}</custom-style>`;
  });
}

/**
 * Decode <custom-style> back to <style> with scoped selectors.
 */
export function decodeStyleTags(html: string, prefix = '.mes-text '): string {
  return html.replace(STYLE_DECODE_REGEX, (_substring: string, encoded: string) => {
    try {
      const css = decodeURIComponent(encoded).replace(/<br\/>/g, '');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ast: any = parse(css);
      const sheet = ast?.stylesheet;
      if (sheet) {
        sanitizeRuleSet(sheet, prefix);
      }
      return `<style>${stringify(ast)}</style>`;
    } catch (err) {
      return `CSS ERROR: ${err}`;
    }
  });
}

// ── CSS AST sanitization ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sanitizeRuleSet(ruleSet: any, prefix: string): void {
  if (Array.isArray(ruleSet.selectors) || Array.isArray(ruleSet.declarations)) {
    sanitizeRule(ruleSet, prefix);
  }

  if (Array.isArray(ruleSet.rules)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ruleSet.rules = ruleSet.rules.filter((rule: any) => rule.type !== 'import');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const mediaRule of ruleSet.rules) {
      sanitizeRuleSet(mediaRule, prefix);
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sanitizeRule(rule: any, prefix: string): void {
  if (Array.isArray(rule.selectors)) {
    for (let i = 0; i < rule.selectors.length; i++) {
      const selector = rule.selectors[i];
      if (selector) {
        rule.selectors[i] = prefix + sanitizeSelector(String(selector));
      }
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (Array.isArray(rule.declarations) && rule.declarations.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rule.declarations = rule.declarations.filter((d: any) => !String(d.value).includes('://'));
  }
}

function sanitizeSelector(selector: string): string {
  const pseudoClasses = ['has', 'not', 'where', 'is', 'matches', 'any'];
  const pseudoRegex = new RegExp(`:(${pseudoClasses.join('|')})\\(([^)]+)\\)`, 'g');

  selector = selector.replace(pseudoRegex, (_substring: string, pseudoClass: string, content: string) => {
    const sanitizedContent = sanitizeSimpleSelector(content);
    return `:${pseudoClass}(${sanitizedContent})`;
  });

  return sanitizeSimpleSelector(selector);
}

function sanitizeSimpleSelector(selector: string): string {
  return selector
    .split(/\s+/)
    .map(part => {
      return part.replace(/\.([\w-]+)/g, (_substring: string, className: string) => {
        if (className.startsWith('custom-')) return _substring;
        return `.custom-${className}`;
      });
    })
    .join(' ');
}
