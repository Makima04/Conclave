/**
 * Sandbox style isolation — prevents `<style>` tags inside sandbox HTML from
 * leaking CSS rules into the host page or other messages.
 *
 * Approach mirrors SillyTavern's `encodeStyleTags` / `decodeStyleTags`:
 *   1. Before storing sandbox HTML, `encodeStyleTags` replaces every
 *      `<style>` block with a `<custom-style>` holding URI-encoded CSS.
 *   2. When building the iframe document, `decodeStyleTags` restores
 *      `<style>` blocks but prefixes every CSS selector with a
 *      message-scoped class (e.g. `.sandbox-msg-42`).
 *
 * Uses a regex-based CSS parser instead of the `css` npm package to avoid
 * an extra runtime dependency.  Handles the common cases: simple rules,
 * `@media`, `@keyframes`, nested at-rules, and pseudo-class selectors.
 */

// ---------------------------------------------------------------------------
// Encode: <style> → <custom-style> with URI-encoded CSS
// ---------------------------------------------------------------------------

/**
 * Find every `<style>...</style>` block in `html`, URI-encode the CSS body,
 * and replace the block with `<custom-style data-encoded="true">`.
 *
 * Call this **before** persisting or further processing sandbox HTML.
 */
export function encodeStyleTags(html: string): string {
  const styleRegex = /<style>([\s\S]*?)<\/style>/gim;
  return html.replace(styleRegex, (_match, cssBody: string) => {
    return `<custom-style data-encoded="true">${encodeURIComponent(cssBody)}</custom-style>`;
  });
}

// ---------------------------------------------------------------------------
// Decode: restore <style> blocks with scoped selectors
// ---------------------------------------------------------------------------

/**
 * Find every `<custom-style data-encoded="true">` block in `html`,
 * URI-decode the CSS, prefix all selectors with `scopeSelector`, strip
 * `@import` / `@charset` rules, and emit a normal `<style scoped>` tag.
 *
 * Also handles any remaining inline `<style>` blocks that were **not**
 * encoded (directly prefix their selectors).
 *
 * @param html  The sandbox document HTML.
 * @param scopeSelector  A CSS class to scope into, e.g. `.sandbox-msg-42`.
 */
export function decodeStyleTags(html: string, scopeSelector: string): string {
  // Step 1: decode <custom-style data-encoded="true"> blocks
  const customStyleRegex = /<custom-style\s+data-encoded="true">([\s\S]*?)<\/custom-style>/gim;
  let result = html.replace(customStyleRegex, (_match, encoded: string) => {
    try {
      const decoded = decodeURIComponent(encoded).replace(/<br\/>/gi, '');
      const scoped = prefixCssSelectors(decoded, scopeSelector);
      return `<style scoped>${scoped}</style>`;
    } catch {
      return `<!-- CSS decode error -->`;
    }
  });

  // Step 2: handle any leftover inline <style> blocks that weren't encoded
  const inlineStyleRegex = /<style(?!\s+scoped)([\s\S]*?)<\/style>/gim;
  result = result.replace(inlineStyleRegex, (_match, cssBody: string) => {
    const scoped = prefixCssSelectors(cssBody, scopeSelector);
    return `<style scoped>${scoped}</style>`;
  });

  return result;
}

// ---------------------------------------------------------------------------
// Low-level CSS selector prefixing (regex-based, no `css` npm dependency)
// ---------------------------------------------------------------------------

/**
 * Prefix every CSS selector in `cssText` with `scopeSelector`.
 *
 * - `.hp { color: red }` → `.scopeSelector .hp { color: red }`
 * - `#main { ... }`      → `.scopeSelector #main { ... }`
 * - `body { ... }`       → `.scopeSelector body { ... }`
 * - `@import`, `@charset` rules are stripped.
 * - `@media`, `@keyframes`, etc. are preserved; selectors inside them are
 *   also prefixed.
 */
export function prefixCssSelectors(cssText: string, scopeSelector: string): string {
  if (!cssText || !scopeSelector) return cssText;

  let output = '';
  let pos = 0;
  const len = cssText.length;

  while (pos < len) {
    // Skip whitespace
    while (pos < len && /\s/.test(cssText[pos])) {
      output += cssText[pos];
      pos++;
    }
    if (pos >= len) break;

    // Detect at-rules
    if (cssText[pos] === '@') {
      const atKeywordMatch = cssText.slice(pos).match(/^@([\w-]+)/);
      if (!atKeywordMatch) {
        output += cssText[pos];
        pos++;
        continue;
      }
      const keyword = atKeywordMatch[1].toLowerCase();

      // Strip @import and @charset
      if (keyword === 'import' || keyword === 'charset') {
        const semiPos = cssText.indexOf(';', pos);
        pos = semiPos === -1 ? len : semiPos + 1;
        continue;
      }

      // @media / @supports / @container — recurse into block
      if (keyword === 'media' || keyword === 'supports' || keyword === 'container') {
        const blockStart = cssText.indexOf('{', pos);
        if (blockStart === -1) {
          // Malformed: emit rest as-is
          output += cssText.slice(pos);
          break;
        }
        const preBlock = cssText.slice(pos, blockStart + 1);
        output += preBlock;
        pos = blockStart + 1;

        // Find matching closing brace (accounting for nesting)
        const inner = extractBalancedBlock(cssText, pos);
        output += prefixCssSelectors(inner, scopeSelector);
        pos += inner.length;
        // consume the closing '}'
        if (pos < len && cssText[pos] === '}') {
          output += '}';
          pos++;
        }
        continue;
      }

      // @keyframes / @font-face / @page / @layer — pass through
      // (for @keyframes, the keyframe selectors like 0%, 100%, from, to
      // should NOT be prefixed)
      if (keyword === 'keyframes' || keyword === 'font-face' || keyword === 'page' || keyword === 'layer') {
        const blockStart = cssText.indexOf('{', pos);
        if (blockStart === -1) {
          output += cssText.slice(pos);
          break;
        }
        // Emit the at-rule header + its entire block unchanged
        const inner = extractBalancedBlock(cssText, blockStart + 1);
        output += cssText.slice(pos, blockStart + 1) + inner;
        pos = blockStart + 1 + inner.length;
        if (pos < len && cssText[pos] === '}') {
          output += '}';
          pos++;
        }
        continue;
      }

      // Unknown at-rule: skip to next semicolon or block
      const semiPos = cssText.indexOf(';', pos);
      const bracePos = cssText.indexOf('{', pos);
      if (semiPos !== -1 && (bracePos === -1 || semiPos < bracePos)) {
        output += cssText.slice(pos, semiPos + 1);
        pos = semiPos + 1;
      } else if (bracePos !== -1) {
        const inner = extractBalancedBlock(cssText, bracePos + 1);
        output += cssText.slice(pos, bracePos + 1) + inner;
        pos = bracePos + 1 + inner.length;
        if (pos < len && cssText[pos] === '}') {
          output += '}';
          pos++;
        }
      } else {
        output += cssText.slice(pos);
        break;
      }
      continue;
    }

    // Regular rule: selectors { declarations }
    const bracePos = cssText.indexOf('{', pos);
    if (bracePos === -1) {
      // No more rules
      output += cssText.slice(pos);
      break;
    }

    const selectorPart = cssText.slice(pos, bracePos);
    const prefixed = prefixSelectorBlock(selectorPart, scopeSelector);
    output += prefixed + '{';
    pos = bracePos + 1;

    // Extract declaration block
    const inner = extractBalancedBlock(cssText, pos);
    output += inner;
    pos += inner.length;
    if (pos < len && cssText[pos] === '}') {
      output += '}';
      pos++;
    }
  }

  return output;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract content inside `{ ... }` starting at `pos` (pos is right after
 * the opening brace).  Handles nested braces.  Returns the inner content
 * WITHOUT the closing brace; the caller is responsible for consuming `}`.
 */
function extractBalancedBlock(css: string, pos: number): string {
  let depth = 1;
  const start = pos;
  while (pos < css.length && depth > 0) {
    if (css[pos] === '{') depth++;
    else if (css[pos] === '}') {
      depth--;
      if (depth === 0) break;
    }
    pos++;
  }
  return css.slice(start, pos);
}

/**
 * Prefix a comma-separated selector list with `scopeSelector`.
 */
function prefixSelectorBlock(selectorText: string, scopeSelector: string): string {
  // Split by comma, but respect parenthetical groups
  const selectors = splitSelectors(selectorText);
  return selectors
    .map(sel => {
      const trimmed = sel.trim();
      if (!trimmed) return trimmed;
      return `${scopeSelector} ${trimmed}`;
    })
    .join(', ');
}

/**
 * Split a selector list by top-level commas (not commas inside parentheses).
 */
function splitSelectors(text: string): string[] {
  const result: string[] = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      result.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) result.push(current);
  return result;
}
