// Iframe document constructor for message-level and script-resident iframes.
// Ported from JS-Slash-Runner panel/render/iframe.ts (createSrcContent / replaceVhInContent).
//
// M2: createMessageSrcContent — full CDN + runtime script shell for message iframes.
// M3: createScriptSrcContent — minimal shell for script-resident iframes (CDN libs inherited from parent).

import {
  predefine_url,
  adjust_viewport_url,
  adjust_iframe_height_url,
  parent_jquery_url,
} from './iframe-scripts/script_url';

// ── CDN library URLs (cdnjs, matching card-content.tsx conventions) ──
// JSR uses jsdelivr; we use cdnjs to avoid ad-blocker interference.
// jQuery UI + touch-punch added (JSR has them, previous implementation omitted them).
// Tailwind is CSS-only (JSR uses local JS, but message iframes only need the stylesheet).

const ST_CDN_LIBS = {
  fontAwesomeCss: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  tailwindCss: 'https://cdnjs.cloudflare.com/ajax/libs/tailwindcss/2.2.19/tailwind.min.css',
  jquery: 'https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js',
  jqueryUi: 'https://cdnjs.cloudflare.com/ajax/libs/jqueryui/1.13.2/jquery-ui.min.js',
  jqueryUiCss: 'https://cdnjs.cloudflare.com/ajax/libs/jqueryui/1.13.2/themes/base/theme.min.css',
  jqueryUiTouchPunch: 'https://cdnjs.cloudflare.com/ajax/libs/jquery-ui-touch-punch/0.2.3/jquery.ui.touch-punch.min.js',
  vue: 'https://cdnjs.cloudflare.com/ajax/libs/vue/2.7.16/vue.runtime.global.prod.min.js',
  vueRouter: 'https://cdnjs.cloudflare.com/ajax/libs/vue-router/3.6.5/vue-router.global.prod.min.js',
} as const;

// ── Narrow vh → CSS-variable replacement (JSR pattern) ──
// Only targets min-height (not width, max-height, padding, etc.) to avoid
// breaking card styles. Four match forms:
//   1. CSS declaration block: min-height: ...vh
//   2. Inline style attribute: style="min-height: ...vh"
//   3. JS property assignment: .style.minHeight = "...vh"
//   4. JS setProperty call: setProperty('min-height', "...vh")
//
// Conversion rules:
//   100vh → var(--TH-viewport-height)
//   50vh  → calc(var(--TH-viewport-height) * 0.5)
//   Nvh   → calc(var(--TH-viewport-height) * N/100)

export function replaceVhInContent(content: string): string {
  // Quick-check: skip processing if no min-height + vh pattern exists.
  const hasCssMinVh = /min-height\s*:\s*[^;{}]*\d+(?:\.\d+)?vh/gi.test(content);
  const hasInlineStyleVh = /style\s*=\s*(["'])[\s\S]*?min-height\s*:\s*[^;]*?\d+(?:\.\d+)?vh[\s\S]*?\1/gi.test(
    content,
  );
  const hasJsVh =
    /(\.style\.minHeight\s*=\s*(["']))([\s\S]*?vh)(\2)/gi.test(content) ||
    /(setProperty\s*\(\s*(["'])min-height\2\s*,\s*(["']))([\s\S]*?vh)(\3\s*\))/gi.test(content);

  if (!hasCssMinVh && !hasInlineStyleVh && !hasJsVh) {
    return content;
  }

  const convertVhToVariable = (value: string): string =>
    value.replace(/(\d+(?:\.\d+)?)vh\b/gi, (_match, digits: string) => {
      const parsed = parseFloat(digits);
      if (!isFinite(parsed)) return _match;
      const VARIABLE_EXPRESSION = `var(--TH-viewport-height)`;
      if (parsed === 100) return VARIABLE_EXPRESSION;
      return `calc(${VARIABLE_EXPRESSION} * ${parsed / 100})`;
    });

  // 1) CSS declaration block: `min-height: ...vh`
  content = content.replace(
    /(min-height\s*:\s*)([^;{}]*?\d+(?:\.\d+)?vh)(?=\s*[;}])/gi,
    (_match, prefix: string, value: string) => {
      return `${prefix}${convertVhToVariable(value)}`;
    },
  );

  // 2) Inline style attribute: `style="min-height: ...vh"`
  content = content.replace(
    /(style\s*=\s*(["']))([^"'"]*?)(\2)/gi,
    (match, prefix: string, _quote: string, styleContent: string, suffix: string) => {
      if (!/min-height\s*:\s*[^;]*vh/i.test(styleContent)) return match;
      const replaced = styleContent.replace(
        /(min-height\s*:\s*)([^;]*?\d+(?:\.\d+)?vh)/gi,
        (_m: string, p1: string, p2: string) => {
          return `${p1}${convertVhToVariable(p2)}`;
        },
      );
      return `${prefix}${replaced}${suffix}`;
    },
  );

  // 3) JS property assignment: `.style.minHeight = "...vh"`
  content = content.replace(
    /(\.style\.minHeight\s*=\s*(["']))([\s\S]*?)(\2)/gi,
    (match, prefix: string, _q: string, val: string, suffix: string) => {
      if (!/\b\d+(?:\.\d+)?vh\b/i.test(val)) return match;
      const converted = convertVhToVariable(val);
      return `${prefix}${converted}${suffix}`;
    },
  );

  // 4) JS setProperty call: `setProperty('min-height', "...vh")`
  content = content.replace(
    /(setProperty\s*\(\s*(["'])min-height\2\s*,\s*(["']))([\s\S]*?)(\3\s*\))/gi,
    (match, prefix: string, _q1: string, _q2: string, val: string, suffix: string) => {
      if (!/\b\d+(?:\.\d+)?vh\b/i.test(val)) return match;
      const converted = convertVhToVariable(val);
      return `${prefix}${converted}${suffix}`;
    },
  );

  return content;
}

// ── Message-level iframe srcdoc ──
// Full CDN + runtime script shell. Matches JSR createSrcContent order exactly.
// Differences from card-content.tsx buildIframeDocument:
//   - No bridge script (postMessage RPC shim) — predefine.js reads TavernHelper from parent directly
//   - No headBridge (Zod stub / waitGlobalInitialized stub) — predefine.js provides these
//   - No VH_REPLACEMENT_SCRIPT inline — adjust_viewport.js handles this
//   - No tavern_helper.scripts injection — M3 handles script injection in script-resident iframe
//   - Adds jQuery UI + touch-punch (JSR has them, previous implementation omitted them)

export function createMessageSrcContent(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<base href="${window.location.origin}"/>
<style>
*,*::before,*::after{box-sizing:border-box;}
html,body{margin:0!important;padding:0;overflow:hidden!important;max-width:100%!important;}
</style>
<link rel="stylesheet" href="${ST_CDN_LIBS.fontAwesomeCss}"/>
<link rel="stylesheet" href="${ST_CDN_LIBS.tailwindCss}"/>
<script src="${ST_CDN_LIBS.jquery}"></script>
<script src="${ST_CDN_LIBS.jqueryUi}"></script>
<link rel="stylesheet" href="${ST_CDN_LIBS.jqueryUiCss}"/>
<script src="${ST_CDN_LIBS.jqueryUiTouchPunch}"></script>
<script src="${ST_CDN_LIBS.vue}"></script>
<script src="${ST_CDN_LIBS.vueRouter}"></script>
<script src="${predefine_url}"></script>
<script src="${adjust_viewport_url}"></script>
<script src="${adjust_iframe_height_url}"></script>
</head>
<body>
${replaceVhInContent(bodyHtml)}
</body>
</html>`;
}

// ── Script-resident iframe srcdoc (M3, reserved for M2) ──
// Minimal shell: no CDN libs (jQuery/Vue/FontAwesome inherited from parent),
// only parent_jquery.js (window.$ = window.parent.$) + predefine.js.

export function createScriptSrcContent(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<base href="${window.location.origin}"/>
<style>*,*::before,*::after{box-sizing:border-box;}html,body{margin:0;padding:0;overflow:hidden;}</style>
<script src="${parent_jquery_url}"></script>
<script src="${predefine_url}"></script>
</head><body>${bodyHtml}</body>
</html>`;
}
