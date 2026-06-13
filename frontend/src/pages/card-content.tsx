// Card content processing pipeline
// Extracted from Chat.tsx GROUP 6 + GROUP 8 + GROUP 9 + GROUP 25
// v3 ST-engine: uses st-rendering-engine.ts for regex script execution

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CharacterCard, SessionRuntimeAssets } from '../api/types';
import { CodeBlock } from './components/CodeBlock';
import { StMessageIframe } from './st-runtime/StMessageIframe';
import { createMessageSrcContent } from './st-runtime/iframe-doc';
import type { RegexScript } from './st-regex-executor';
import { getRegexedString, regex_placement } from './st-rendering-engine';
import { processMacros, createMacroContext } from './macro-engine';
import { buildStatusSchema } from './card-schema-builders';

// ── ST-standard library versions (mirrors JS-Slash-Runner injection) ──

const ST_CDN_LIBS = {
  // JS-Slash-Runner also uses Font Awesome 6 + Tailwind + jQuery + Vue + Zod in its iframe
  fontAwesomeCss: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.2/css/all.min.css',
  tailwindCss: 'https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css',
  jquery: 'https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js',
  vue: 'https://cdnjs.cloudflare.com/ajax/libs/vue/2.7.14/vue.min.js',
};

// ── TavernHelper script helpers ──

interface TavernHelperScript {
  type?: string;
  enabled?: boolean;
  name?: string;
  id?: string;
  content?: string;
}

/**
 * Extract tavern_helper.scripts from a CharacterCard's extensions.
 * These are ES module imports or inline scripts that create UI elements
 * like floating buttons, status bars, CG galleries, etc.
 */
export function getTavernHelperScripts(card: CharacterCard | null): TavernHelperScript[] {
  const ext = card?.extensions as Record<string, unknown> | undefined;
  const th = ext?.tavern_helper as Record<string, unknown> | undefined;
  const scripts = th?.scripts;
  if (!Array.isArray(scripts)) return [];
  return scripts.filter((s: TavernHelperScript) => s.enabled !== false);
}

/**
 * Build `<script>` tags for tavern_helper scripts to inject into the iframe <head>.
 * - Scripts whose content is an `import '...'` statement → `<script type="module">`
 * - Scripts whose content is inline JS → `<script defer>`
 * - If content is empty/absent, skip (external scripts loaded via src are not supported)
 */
export function buildTavernHelperScriptTags(card: CharacterCard | null): string {
  return buildTavernHelperScriptTagsFromScripts(getTavernHelperScripts(card));
}

export function buildTavernHelperScriptTagsFromScripts(scripts: TavernHelperScript[]): string {
  if (scripts.length === 0) return '';

  // Unique per-build nonce to bust ES module import cache.
  // When iframe is rebuilt (greeting switch), the new Blob URL is in a
  // different origin-like context, but the browser still caches ES modules
  // by their URL. Without a cache buster, import 'https://cdn/.../index.js'
  // returns the already-evaluated module and its side effects (creating the
  // floating "灵" button etc.) never re-execute.
  const cacheBuster = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  return scripts
      .map((s, i) => {
        const content = (s.content || '').trim();
        if (!content) return '';

        // ES module import statement → type="module"
        if (/^import\s/.test(content) || /^export\s/.test(content)) {
          // Add cache-busting query param to import URL to force re-evaluation
          // of module side effects when iframe is rebuilt.
          const rewritten = content.replace(
            /(import\s+[^"']*["'])([^"']+)(["'])/g,
            (_m, prefix, url, suffix) => {
              const sep = url.includes('?') ? '&' : '?';
              return String(prefix) + String(url) + sep + '_xrp_cb=' + cacheBuster + String(suffix);
            },
          );
          return `<script type="module" id="th-script-${i}">${rewritten}</script>`;
        }

        // Regular inline script
        return `<script defer id="th-script-${i}">${content}</script>`;
      })
      .filter(Boolean)
      .join('\n');
}

// ── CDN URL rewriting — some CDNs (bootcdn.net) are commonly blocked by
// browser ad-blockers. Rewrite to alternative CDNs that are less likely
// to be blocked.

function rewriteCdnUrls(html: string): string {
  return html
    // Font Awesome: bootcdn.net → cdnjs.cloudflare.com
    .replace(
      /https?:\/\/cdn\.bootcdn\.net\/ajax\/libs\/font-awesome\//g,
      'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/',
    )
    // Generic bootcdn → cdnjs mapping for common libs
    .replace(
      /https?:\/\/cdn\.bootcdn\.net\/ajax\/libs\//g,
      'https://cdnjs.cloudflare.com/ajax/libs/',
    );
}

// ── vh→CSS-variable replacement ──
// JS-Slash-Runner replaces `vh` with `--TH-viewport-height` so cards
// using `100vh` don't overflow the iframe viewport.

/**
 * Replace vh units in CSS with calc() expressions using --TH-viewport-height.
 * Covers: style attributes, <style> blocks, and inline style properties.
 * e.g. `height: 100vh` → `height: calc(100 * var(--TH-viewport-height) / 100)`
 */
export function replaceViewportUnits(html: string): string {
  return html.replace(/(\d+(?:\.\d+)?)vh/g, 'calc($1 * var(--TH-viewport-height) / 100)');
}

const VH_REPLACEMENT_SCRIPT = `
(function() {
  'use strict';
  var style = document.createElement('style');
  style.id = 'xrp-vh-fix';
  style.textContent = ':root { --TH-viewport-height: ' + window.innerHeight + 'px; }';
  document.head.appendChild(style);
  window.addEventListener('resize', function() {
    var s = document.getElementById('xrp-vh-fix');
    if (s) s.textContent = ':root { --TH-viewport-height: ' + window.innerHeight + 'px; }';
  });
})();
`.trim();

/**
 * Build the head bridge script for iframe compatibility.
 * This runs BEFORE the card body HTML (including its inline <script> tags),
 * ensuring global APIs like waitGlobalInitialized, z (Zod), and
 * updateTavernRegexesWith are available when card scripts execute.
 *
 * Mirrors the predefine.js + function/global.ts pattern from JS-Slash-Runner.
 */
function buildHeadBridgeScript(): string {
  return `
(function() {
  'use strict';

  // ── Zod shim (inline) ──
  // Card scripts use Zod via global 'z'. CDN builds are unreliable across
  // providers (cdnjs lacks Zod, jsdelivr paths differ between versions), so we
  // inline a minimal API surface that covers the subset card MVU schemas need:
  //   z.object(), z.string(), z.number(), z.enum(), z.record(), z.array()
  //   .prefault(), .describe(), .transform(), z.coerce.number()
  (function() {
    function ZodType(def) { this._def = def || {}; }
    ZodType.prototype.prefault = function(v) { this._def.defaultValue = v; return this; };
    ZodType.prototype.describe = function(d) { this._def.description = d; return this; };
    ZodType.prototype.transform = function(fn) {
      var inner = this;
      function Transformed() { this._inner = inner; this._fn = fn; }
      Transformed.prototype.prefault = function(v) {
        // Apply transform to default value if set
        try { this._inner._def.defaultValue = fn(v); } catch(e) {}
        return this;
      };
      Transformed.prototype.describe = function(d) { return this; };
      Transformed.prototype._isZodTransform = true;
      return new Transformed();
    };

    // Helper: walk a shape and set defaults on leaf types, handling
    // Transformed wrappers (which have ._inner instead of ._def).
    function setDefaultOnType(t, val) {
      if (!t) return;
      if (t._isZodTransform) {
        // Transformed wraps another type — apply transform, then set on inner
        try { val = t._fn(val); } catch(e) {}
        setDefaultOnType(t._inner, val);
        return;
      }
      if (t._def) { t._def.defaultValue = val; }
    }

    function ZodObject(shape) { ZodType.call(this); this._shape = shape || {}; }
    ZodObject.prototype = Object.create(ZodType.prototype);
    ZodObject.prototype.prefault = function(v) {
      if (v && typeof v === 'object') {
        for (var k in v) {
          if (this._shape[k]) {
            setDefaultOnType(this._shape[k], v[k]);
          }
        }
      }
      return this;
    };

    function ZodString() { ZodType.call(this); }
    ZodString.prototype = Object.create(ZodType.prototype);

    function ZodNumber() { ZodType.call(this); }
    ZodNumber.prototype = Object.create(ZodType.prototype);

    function ZodBoolean() { ZodType.call(this); }
    ZodBoolean.prototype = Object.create(ZodType.prototype);

    function ZodEnum(values) { ZodType.call(this); this._values = values; }
    ZodEnum.prototype = Object.create(ZodType.prototype);

    function ZodRecord(keyType, valueType) { ZodType.call(this); this._keyType = keyType; this._valueType = valueType; }
    ZodRecord.prototype = Object.create(ZodType.prototype);
    ZodRecord.prototype.prefault = function(v) {
      if (v && typeof v === 'object') { this._def.defaultValue = v; }
      return this;
    };

    function ZodArray(itemType) { ZodType.call(this); this._itemType = itemType; }
    ZodArray.prototype = Object.create(ZodType.prototype);
    ZodArray.prototype.prefault = function(v) { this._def.defaultValue = v; return this; };

    // Optional / nullable wrappers (no-op at runtime — just pass through)
    function ZodOptional(inner) { ZodType.call(this); this._inner = inner; this._isOptional = true; }
    ZodOptional.prototype = Object.create(ZodType.prototype);
    ZodOptional.prototype.prefault = function(v) { setDefaultOnType(this._inner, v); return this; };
    ZodOptional.prototype.describe = function(d) { return this; };

    function ZodNullable(inner) { ZodType.call(this); this._inner = inner; this._isNullable = true; }
    ZodNullable.prototype = Object.create(ZodType.prototype);
    ZodNullable.prototype.prefault = function(v) { if (v != null) setDefaultOnType(this._inner, v); return this; };
    ZodNullable.prototype.describe = function(d) { return this; };

    window.z = {
      object: function(shape) { return new ZodObject(shape); },
      string: function() { return new ZodString(); },
      number: function() { return new ZodNumber(); },
      boolean: function() { return new ZodBoolean(); },
      enum: function(values) { return new ZodEnum(values); },
      record: function(k, v) { return new ZodRecord(k, v); },
      array: function(item) { return new ZodArray(item); },
      coerce: {
        number: function() { return new ZodNumber(); },
        string: function() { return new ZodString(); },
        boolean: function() { return new ZodBoolean(); }
      }
    };

    // Augment ZodObject / ZodString / ZodNumber / ZodBoolean / ZodArray with
    // .optional() / .nullable() so card schemas that use them don't crash.
    function addOptionalNullable(proto) {
      proto.optional = function() { return new ZodOptional(this); };
      proto.nullable = function() { return new ZodNullable(this); };
    }
    addOptionalNullable(ZodObject.prototype);
    addOptionalNullable(ZodString.prototype);
    addOptionalNullable(ZodNumber.prototype);
    addOptionalNullable(ZodBoolean.prototype);
    addOptionalNullable(ZodArray.prototype);
    addOptionalNullable(ZodEnum.prototype);
    addOptionalNullable(ZodRecord.prototype);
  })();

  // ── Minimal event system for global initialization signaling ──
  var _headEvents = {};
  function headEmit(name) {
    var list = _headEvents[name];
    if (list) { for (var i = 0; i < list.length; i++) { try { list[i](); } catch(e) {} } }
  }
  function headOn(name, fn) {
    if (!_headEvents[name]) _headEvents[name] = [];
    _headEvents[name].push(fn);
  }
  function headOnce(name, fn) {
    var wrapper = function() { headOff(name, wrapper); fn.apply(null, arguments); };
    headOn(name, wrapper);
  }
  function headOff(name, fn) {
    var list = _headEvents[name];
    if (list) { var i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }
  }

  // ── initializeGlobal / waitGlobalInitialized (synchronous stubs) ──
  window.initializeGlobal = function(name) {
    if (!window[name]) { window[name] = {}; }
    headEmit('global_' + name + '_initialized');
  };
  window.waitGlobalInitialized = function(name) {
    if (window[name] && Object.keys(window[name]).length > 0) {
      return Promise.resolve();
    }
    return new Promise(function(resolve) {
      headOnce('global_' + name + '_initialized', resolve);
    });
  };

  // ── updateTavernRegexesWith — no-op shim ──
  window.updateTavernRegexesWith = function(updater, option) {
    if (typeof updater !== 'function') return Promise.resolve([]);
    try {
      var result = updater([]);
      return Promise.resolve(result || []);
    } catch(e) {
      console.warn('[bridge] updateTavernRegexesWith updater error:', e);
      return Promise.resolve([]);
    }
  };
  window._updateTavernRegexesWith = window.updateTavernRegexesWith;

  // ── underscore-prefixed variants (JS-Slash-Runner internal use) ──
  window._waitGlobalInitialized = window.waitGlobalInitialized;
  window._initializeGlobal = window.initializeGlobal;
})();
`.trim();
}

/**
 * Build the standard ST/JS-Slash-Runner iframe document shell.
 * Injects jQuery, Vue 2, Tailwind CSS, Font Awesome, and viewport-height
 * CSS variable — matching what JS-Slash-Runner provides.
 *
 * Also injects any tavern_helper scripts from the card's extensions.
 */
export function buildIframeDocument(
  bodyHtml: string,
  bridgeScript: string,
  options?: {
    /** Additional <link> or <script> tags to inject into <head>. */
    headExtras?: string;
    /** Character card to extract tavern_helper scripts from. */
    card?: CharacterCard | null;
    /** Effective ST runtime assets for this session. */
    runtimeAssets?: SessionRuntimeAssets | null;
    /** Initial ST-like runtime snapshot for scripts that run before body bridge. */
    runtime?: Record<string, unknown> | null;
  },
): string {
  const { headExtras = '', card = null, runtimeAssets = null } = options || {};
  const runtimeScripts = runtimeAssets?.tavern_helper_scripts as TavernHelperScript[] | undefined;
  const thScriptTags = runtimeScripts && runtimeScripts.length > 0
    ? buildTavernHelperScriptTagsFromScripts(runtimeScripts)
    : buildTavernHelperScriptTags(card);
  const headBridge = buildHeadBridgeScript();
  const runtimeBootstrap = `<script>window.__XRP_INITIAL_RUNTIME=null;</script>`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${ST_CDN_LIBS.fontAwesomeCss}">
<link rel="stylesheet" href="${ST_CDN_LIBS.tailwindCss}">
<!-- Head bridge before CDN + card scripts: must exist before card JS runs -->
${runtimeBootstrap}
<script>${headBridge}</script>
<script src="${ST_CDN_LIBS.jquery}"></script>
<script src="${ST_CDN_LIBS.vue}"></script>
	<!-- thScriptTags execute as inline scripts — need z (in headBridge), $, Vue all ready -->
${thScriptTags}
${headExtras}
<style>html,body{margin:0;padding:0;overflow-x:hidden;overflow-y:auto}</style>
</head>
<body>${replaceViewportUnits(bodyHtml)}
<script>${VH_REPLACEMENT_SCRIPT}</script>
<script>${bridgeScript}</script>
</body>
</html>`;
}

export function injectBridgeIntoIframeDocument(
  documentHtml: string,
  bridgeScript: string,
  options?: {
    card?: CharacterCard | null;
    runtimeAssets?: SessionRuntimeAssets | null;
  },
): string {
  const { card = null, runtimeAssets = null } = options || {};
  const runtimeScripts = runtimeAssets?.tavern_helper_scripts as TavernHelperScript[] | undefined;
  const thScriptTags = runtimeScripts && runtimeScripts.length > 0
    ? buildTavernHelperScriptTagsFromScripts(runtimeScripts)
    : buildTavernHelperScriptTags(card);
  const libCss = `<link rel="stylesheet" href="${ST_CDN_LIBS.fontAwesomeCss}">
<link rel="stylesheet" href="${ST_CDN_LIBS.tailwindCss}">`;
  const headJs = `<script>window.__XRP_INITIAL_RUNTIME=null;</script>
<script>${buildHeadBridgeScript()}</script>`;
  const libJs = `<script src="${ST_CDN_LIBS.jquery}"></script>
<script src="${ST_CDN_LIBS.vue}"></script>
${thScriptTags}
<script>${VH_REPLACEMENT_SCRIPT}</script>
<script>${bridgeScript}</script>`;

  let injected = replaceViewportUnits(documentHtml);
  if (/<head[^>]*>/i.test(injected)) {
    injected = injected.replace(/(<head[^>]*>)/i, `$1\n${headJs}`);
  } else {
    injected = injected.replace(/<html[^>]*>/i, match => `${match}\n<head>${headJs}</head>`);
  }
  if (/<\/head>/i.test(injected)) {
    injected = injected.replace(/<\/head>/i, `${libCss}</head>`);
  }
  if (/<\/body>/i.test(injected)) {
    injected = injected.replace(/<\/body>/i, `${libJs}</body>`);
  } else {
    injected += libJs;
  }
  return injected;
}

// --- GROUP 6: Character card inspection utilities ---

export function stripCodeFence(source: string): string {
  const trimmed = source.trim();
  if (!trimmed.startsWith('```')) return source;
  const firstBreak = trimmed.indexOf('\n');
  if (firstBreak < 0) return source;
  const withoutOpen = trimmed.slice(firstBreak + 1);
  const close = withoutOpen.lastIndexOf('```');
  return close >= 0 ? withoutOpen.slice(0, close) : withoutOpen;
}

export function getRegexScripts(card: CharacterCard | null): RegexScript[] {
  const scripts = (card?.extensions as Record<string, any> | undefined)?.regex_scripts;
  return Array.isArray(scripts) ? scripts : [];
}

// --- GROUP 8: Regex script application (v3 ST engine) ---

type DisplayPart = {
  type: 'text' | 'html';
  content: string;
};

const HTML_BLOCK_OPEN = '\x00XRP_BLK_';
const HTML_BLOCK_CLOSE = '_XRP_BLK\x00';

function applyCardDisplayRegexScriptsToParts(
  card: CharacterCard | null,
  content: string,
  userName: string = '{{user}}',
  charName: string = '{{char}}',
): DisplayPart[] {
  const scripts = getRegexScripts(card);
  if (scripts.length === 0) {
    return [{ type: 'text', content }];
  }

  // Pre-process: strip code fences from replacement strings.
  // Many ST cards (e.g. 苍玄界) wrap HTML replacements in ```html...```
  // which would render as code blocks instead of HTML.
  const preparedScripts: RegexScript[] = scripts.map(s => {
    if (typeof s.replaceString === 'string' && s.replaceString.trim().startsWith('```')) {
      return { ...s, replaceString: stripCodeFence(s.replaceString) };
    }
    return s;
  });

  // Phase 1: non-markdown scripts on raw content
  let output = getRegexedString(
    preparedScripts, content, regex_placement.AI_OUTPUT,
    { userName, charName, isMarkdown: false },
  );

  // Phase 2: markdown-only scripts (matching ST's messageFormatting)
  output = getRegexedString(
    preparedScripts, output, regex_placement.AI_OUTPUT,
    { userName, charName, isMarkdown: true },
  );

  // Extract HTML blocks from the result.
  // After regex processing, HTML documents may be embedded inline.
  // We detect and extract them using markers so they can be rendered
  // in iframes rather than being parsed as markdown.
  const htmlBlocks: string[] = [];

  const extractRegex = /<!DOCTYPE\s+html[\s\S]*?<\/html>|<html[\s\S]*?<\/html>/i;
  let match: RegExpExecArray | null;
  while ((match = extractRegex.exec(output)) !== null) {
    const index = htmlBlocks.push(match[0]) - 1;
    output = output.slice(0, match.index) +
      `${HTML_BLOCK_OPEN}${index}${HTML_BLOCK_CLOSE}` +
      output.slice(match.index + match[0].length);
    // Reset regex to search from after the replacement
    const newCursor = match.index + HTML_BLOCK_OPEN.length + String(index).length + HTML_BLOCK_CLOSE.length;
    extractRegex.lastIndex = newCursor;
  }

  // Split on markers
  const markerRegex = new RegExp(
    `${HTML_BLOCK_OPEN.replace(/\x00/g, '\\x00')}(\\d+)${HTML_BLOCK_CLOSE.replace(/\x00/g, '\\x00')}`,
    'g',
  );
  const parts: DisplayPart[] = [];
  let cursor = 0;
  while ((match = markerRegex.exec(output)) !== null) {
    const before = output.slice(cursor, match.index);
    if (before.trim()) parts.push({ type: 'text', content: before });
    const html = htmlBlocks[Number(match[1])];
    if (html?.trim()) parts.push({ type: 'html', content: html });
    cursor = match.index + match[0].length;
  }
  const rest = output.slice(cursor);
  if (rest.trim() || parts.length === 0) parts.push({ type: 'text', content: rest });
  return parts;
}

// --- GROUP 25: Text cleaning & inline decorator utilities ---

export function cleanCardDisplayText(
  content: string,
  userName: string = '你',
  charName: string = '{{char}}',
): string {
  return content
    .replace(/<StatusPlaceHolderImpl\/>/g, '')
    .replace(/<UpdateVariable(?:variable)?\b[^>]*>[\s\S]*?<\/UpdateVariable(?:variable)?>/gi, '')
    .replace(/<options\b[^>]*>[\s\S]*?<\/options>/gi, '')
    .replace(/<\/?正文>/g, '')
    .replace(/{{user}}/g, userName)
    .replace(/{{char}}/g, charName)
    .replace(/<user>/g, userName)
    .replace(/<\/user>/g, '')
    .replace(/<char>/g, charName)
    .replace(/<\/char>/g, '')
    .replace(/<\/?initvar>/gi, '')
    .replace(/<inner>([\s\S]*?)<\/inner>/gi, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function renderInlineDecorators(
  content: string,
  userName: string = '你',
  charName: string = '{{char}}',
): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  const innerRegex = /<inner>([\s\S]*?)<\/inner>/gi;
  const source = content
    .replace(/<UpdateVariable(?:variable)?\b[^>]*>[\s\S]*?<\/UpdateVariable(?:variable)?>/gi, '')
    .replace(/<options\b[^>]*>[\s\S]*?<\/options>/gi, '')
    .replace(/<\/?正文>/g, '')
    .replace(/{{user}}/g, userName)
    .replace(/{{char}}/g, charName)
    .replace(/<user>/g, userName)
    .replace(/<\/user>/g, '')
    .replace(/<char>/g, charName)
    .replace(/<\/char>/g, '')
    .replace(/<\/?initvar>/gi, '');
  let match: RegExpExecArray | null;
  while ((match = innerRegex.exec(source)) !== null) {
    const before = source.slice(cursor, match.index);
    if (before.trim()) {
      parts.push(<ReactMarkdown key={`md-${cursor}`} remarkPlugins={[remarkGfm]} components={{ code: CodeBlock }}>{before}</ReactMarkdown>);
    }
    parts.push(<div key={`inner-${match.index}`} className="schema-inner-thought">{cleanCardDisplayText(match[1], userName, charName)}</div>);
    cursor = match.index + match[0].length;
  }
  const rest = source.slice(cursor);
  if (rest.trim() || parts.length === 0) {
    parts.push(<ReactMarkdown key={`md-rest-${cursor}`} remarkPlugins={[remarkGfm]} components={{ code: CodeBlock }}>{rest}</ReactMarkdown>);
  }
  return parts;
}

// --- GROUP 9: Content rendering ---

export function renderCardFormattedContent(
  card: CharacterCard | null,
  content: string,
  userName: string = '你',
  charName: string = '{{char}}',
  sessionId?: string,
  worldBookId?: string,
  onMessagesChanged?: () => void,
  runtime?: Record<string, unknown> | null,
): React.ReactNode {
  const normalized = content
    .replace(/<\/?正文>/g, '')
    .replace(/<options\b[^>]*>[\s\S]*?<\/options>/gi, '')
    .replace(/{{user}}/g, userName)
    .replace(/{{char}}/g, charName)
    .replace(/<user>/g, userName)
    .replace(/<\/user>/g, '')
    .replace(/<char>/g, charName)
    .replace(/<\/char>/g, '')
    .replace(/<\/?initvar>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const cleaned = normalized
    .replace(/<UpdateVariable(?:variable)?\b[^>]*>[\s\S]*?<\/UpdateVariable(?:variable)?>/gi, '')
    .trim();
  const parts = applyCardDisplayRegexScriptsToParts(card, cleaned, userName, charName);

  return parts.map((part, index) => {
    if (part.type === 'html') {
      const trimmedContent = part.content.trim();
      const isFullHtmlDoc = /^(?:<!DOCTYPE\s+html\b|<html\b)/i.test(trimmedContent);
      const hasScript = /<script\b/i.test(trimmedContent);

      if (isFullHtmlDoc || hasScript) {
        // Full HTML documents and fragments with scripts → same-origin iframe
        const macroCtx = createMacroContext({
          variables: {} as Record<string, unknown>,
          userName,
          charName,
        });
        const processed = processMacros(trimmedContent, macroCtx);
        const srcdoc = createMessageSrcContent(processed);

        return (
          <StMessageIframe
            key={`html-iframe-${index}`}
            srcdoc={srcdoc}
            iframeName={`TH-message-0-${index}`}
            className="card-regex-html"
          />
        );
      }
      // HTML fragments without scripts: render inline
      return (
        <div
          key={`html-${index}`}
          className="card-regex-html"
          dangerouslySetInnerHTML={{ __html: trimmedContent }}
        />
      );
    }
    return (
      <React.Fragment key={`text-${index}`}>{renderInlineDecorators(part.content)}</React.Fragment>
    );
  });
}

// --- v3: Iframe HTML rendering ---

export function renderCardIframeHtml(
  html: string,
  variables: Record<string, unknown>,
  userName: string,
  charName: string,
  sessionId?: string,
  worldBookId?: string,
  card?: CharacterCard | null,
  runtime?: Record<string, unknown> | null,
  runtimeAssets?: SessionRuntimeAssets | null,
): string {
  const macroContext = createMacroContext({ variables, userName, charName });
  const processed = processMacros(html, macroContext);
  return createMessageSrcContent(processed);
}
