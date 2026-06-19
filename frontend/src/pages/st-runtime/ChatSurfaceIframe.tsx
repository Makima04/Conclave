// ChatSurfaceIframe — bounded render surface for ST host.
//
// Replaces the direct ConclaveCardHtml renderer + hidden StScriptIframeHost.
//
// WHY this exists: card tavern_helper_scripts (e.g. MVU's bundle.js) used to run
// in hidden iframes that bridged the HOST's jQuery (`window.$ = window.parent.$`
// via parent_jquery.js). So MVU's `$('body').append(...)` wrote to the HOST
// document.body — full-screen status layers escaped over the whole ST host page
// (covering header/sidebar/input) and broke scrolling.
//
// FIX: render the card message HTML + tavern_helper_scripts together inside ONE
// iframe that loads its OWN CDN jQuery (does NOT bridge the parent's). Now MVU's
// `$('body')` resolves to the iframe's own body → its full-screen UI is contained
// inside this iframe, which fills only the render region. Header/sidebar/input stay
// on the host page, outside the iframe.
//
// MVU still reads canonical state: predefine.js merges `window.parent.TavernHelper`
// (jQuery-independent functions reading store.chatVariables) into the iframe, so
// `getVariables()` keeps working.
//
// Stability: the srcdoc (CDN libs + MVU) is rebuilt only on `cardKey` change.
// Message/streaming content is pushed incrementally via postMessage so we never
// reload CDN + MVU per token.

import React, { useEffect, useMemo, useRef } from 'react';
import { replaceVhInContent } from './iframe-doc';
import { predefine_url } from './iframe-scripts/script_url';
import { ZOD_V4_COMPAT_SCRIPT } from './zod-compat-script';
import type { TavernHelperScript } from './tavern-helper-scripts';

interface ChatSurfaceIframeProps {
  /** Changes only on card/session switch; rebuilds the iframe document. */
  cardKey: string;
  /** Rendered message HTML to show inside the chat surface. */
  messagesHtml: string;
  /** tavern_helper_scripts (MVU etc.) to run inside this document. */
  tavernHelperScripts: TavernHelperScript[];
  /** Streaming message HTML, or null when not streaming. */
  streamingHtml: string | null;
  /**
   * How many recent turns (user+assistant pairs) to keep visible before the
   * older messages collapse into an "expand history" button. 0 disables
   * collapsing. The iframe auto-scrolls to the latest message on every reload.
   */
  collapseThreshold?: number;
}

// CDN libraries (cdnjs) — same set as iframe-doc.ts ST_CDN_LIBS. Kept local so this
// component owns its own contained document without depending on unexported consts.
const CDN = {
  fontAwesomeCss: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  tailwindCss: 'https://cdnjs.cloudflare.com/ajax/libs/tailwindcss/2.2.19/tailwind.min.css',
  jqueryUiCss: 'https://cdnjs.cloudflare.com/ajax/libs/jqueryui/1.13.2/themes/base/theme.min.css',
  jquery: 'https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js',
  jqueryUi: 'https://cdnjs.cloudflare.com/ajax/libs/jqueryui/1.13.2/jquery-ui.min.js',
  jqueryUiTouchPunch: 'https://cdnjs.cloudflare.com/ajax/libs/jquery-ui-touch-punch/0.2.3/jquery.ui.touch-punch.min.js',
  vue2: 'https://cdnjs.cloudflare.com/ajax/libs/vue/2.7.16/vue.runtime.global.prod.min.js',
  vueRouter2: 'https://cdnjs.cloudflare.com/ajax/libs/vue-router/3.6.5/vue-router.min.js',
  scriptVue: 'https://cdnjs.cloudflare.com/ajax/libs/vue/3.5.13/vue.global.prod.min.js',
  scriptVueRouter: 'https://cdnjs.cloudflare.com/ajax/libs/vue-router/4.5.0/vue-router.global.prod.min.js',
  zod: 'https://cdn.jsdelivr.net/npm/zod@3.23.8/lib/index.umd.js',
} as const;

const ORIGIN = typeof window !== 'undefined' ? window.location.origin : '*';

function stripCodeFences(raw: string): string {
  return raw.replace(/^\s*```[^\n]*\n([\s\S]*)\n```\s*$/, '$1').trim();
}

// Inline script installed inside the iframe: bridges nothing to the parent except
// TavernHelper (via predefine.js, loaded separately). Listens for host postMessages
// that push message/streaming content and drive the viewport-height CSS variable.
const INLINE_BRIDGE = `<script>
(function () {
  // DOMContentLoaded shim for post-load-injected card scripts.
  //
  // Card scripts (e.g. the 状态栏美化 status-bar regex) gate init on
  //   document.addEventListener('DOMContentLoaded', initFn)
  // but they ship inside message HTML, which is pushed via cx_set_messages →
  // setHtml() AFTER the document already finished loading. So their
  // DOMContentLoaded registration never fires and init silently no-ops
  // (status bar renders its shell but values stay blank — no error either).
  //
  // srcdoc scripts (predefine / GLOBAL_HOIST / MVU modules) run DURING parse,
  // when readyState is still 'loading', so they register normally and fire on
  // the real DOMContentLoaded. This override only short-circuits registrations
  // made AFTER DOMContentLoaded has fired — i.e. exactly the late-injected card
  // scripts — so MVU etc. are unaffected and never double-init.
  var domReadyFired = document.readyState !== 'loading';
  document.addEventListener('DOMContentLoaded', function () { domReadyFired = true; }, true);
  var origAddEventListener = document.addEventListener.bind(document);
  document.addEventListener = function (type, listener, opts) {
    if (type === 'DOMContentLoaded' && domReadyFired) {
      var fn = typeof listener === 'function' ? listener : (listener && listener.handleEvent);
      if (fn) { try { fn.call(document, new Event('DOMContentLoaded')); } catch (e) { console.error('[cx:dom-ready-shim]', e); } }
      return;
    }
    return origAddEventListener(type, listener, opts);
  };

  function setHtml(id, html) {
    var el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = html;
    // innerHTML does NOT execute <script> tags. Re-create them so they run.
    // 同层卡 (same-layer cards) ship a full HTML doc with an embedded Vue app
    // mounted on #app; without this the app never mounts and you only see the
    // card's static CSS (e.g. the checkerboard background), with no interaction.
    var scripts = el.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) {
      var old = scripts[i];
      var next = document.createElement('script');
      for (var j = 0; j < old.attributes.length; j++) {
        var attr = old.attributes[j];
        next.setAttribute(attr.name, attr.value);
      }
      next.textContent = old.textContent;
      old.parentNode.replaceChild(next, old);
    }
  }

  // Scroll the chat surface to the latest message. The iframe <body> is the
  // scroll container (body{overflow-y:auto;height:100%}); in that setup the
  // scroll lives on <body>, not the viewport <html>, so set both and let the
  // real one take. Called after every content push so reloads and new turns
  // land at the bottom.
  function scrollToBottom() {
    var h = document.documentElement.scrollHeight || document.body.scrollHeight;
    document.documentElement.scrollTop = h;
    document.body.scrollTop = h;
  }

  // Collapse messages older than the most recent \`keepTurns\` turns behind an
  // "expand history" button. A "turn" is counted from the tail on each user
  // message (.cx-msg-user) boundary, so user+assistant pairs form one turn and
  // odd trailing messages stay visible. Collapsed by default; re-runs on every
  // message push (reload / new turn) to keep the recent window fresh.
  function applyCollapse(root, keepTurns) {
    if (!root) return;
    // Remove any previous collapse scaffolding FIRST so msgs reflects the real
    // message set (the wrap is not a .cx-msg, but restoring order before reading
    // keeps things simple).
    var prev = root.querySelector('.cx-history-wrap');
    if (prev) {
      var collapsed = prev.querySelector('.cx-history-collapsed');
      if (collapsed) {
        while (collapsed.firstChild) root.insertBefore(collapsed.firstChild, prev);
      }
      prev.parentNode.removeChild(prev);
    }
    if (!keepTurns || keepTurns <= 0) return;
    var msgs = Array.prototype.slice.call(root.children).filter(function (c) {
      return c.classList && c.classList.contains('cx-msg');
    });
    // Index into msgs[] such that msgs[cut] is the first message to KEEP. Walk
    // from the tail counting user-msg boundaries (turns). If the conversation has
    // FEWER than keepTurns turns we never reach the threshold — nothing older to
    // hide, so leave everything visible (default cut = msgs.length = no collapse).
    var turns = 0;
    var cut = msgs.length;
    for (var i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].classList.contains('cx-msg-user')) {
        turns++;
        if (turns >= keepTurns) { cut = i; break; }
      }
    }
    // If the conversation has fewer than keepTurns turns the loop never breaks,
    // so cut stays at msgs.length. Bail out and keep everything visible — this
    // is the "default = no collapse" path the comment above describes. Without it
    // the whole chat gets folded away behind the toggle early in a conversation.
    if (cut >= msgs.length) return;
    // Never collapse the very first message — always keep the opening visible.
    if (cut <= 1) return;
    var oldMsgs = msgs.slice(0, cut);
    var wrap = document.createElement('div');
    wrap.className = 'cx-history-wrap';
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'cx-history-toggle';
    toggle.textContent = '↑ 展开历史消息（' + oldMsgs.length + ' 条）';
    var box = document.createElement('div');
    box.className = 'cx-history-collapsed';
    box.style.display = 'none';
    wrap.appendChild(toggle);
    wrap.appendChild(box);
    // ORDER MATTERS: insertBefore must run while oldMsgs[0] is STILL a child of
    // root. Moving the messages into the (detached) box first would detach
    // oldMsgs[0], making insertBefore(oldMsgs[0]) throw NotFoundError and leak
    // every collapsed message into a detached node → empty root.
    root.insertBefore(wrap, oldMsgs[0]);
    for (var k = 0; k < oldMsgs.length; k++) box.appendChild(oldMsgs[k]);
    toggle.addEventListener('click', function () {
      var open = box.style.display === 'none';
      box.style.display = open ? '' : 'none';
      toggle.textContent = open
        ? '↓ 收起历史消息'
        : '↑ 展开历史消息（' + oldMsgs.length + ' 条）';
      scrollToBottom();
    });
  }

  var currentKeepTurns = 10;
  window.addEventListener('message', function (event) {
    if (!event.source || event.source !== window.parent) return;
    var data = event.data || {};
    if (data.type === 'cx_set_messages') {
      setHtml('cx-chat-root', String(data.html || ''));
      if (typeof data.keepTurns === 'number') currentKeepTurns = data.keepTurns;
      applyCollapse(document.getElementById('cx-chat-root'), currentKeepTurns);
      scrollToBottom();
    } else if (data.type === 'cx_set_streaming') {
      var s = document.getElementById('cx-streaming-msg');
      if (!s) return;
      if (data.html == null) {
        s.style.display = 'none';
        s.innerHTML = '';
      } else {
        s.innerHTML = String(data.html);
        s.style.display = '';
      }
      scrollToBottom();
    } else if (data.type === 'cx_update_viewport') {
      var h = Number(data.height);
      if (h > 0) {
        document.documentElement.style.setProperty('--TH-viewport-height', h + 'px');
      }
    }
  });
  // Tell the host we're ready to receive content.
  window.parent.postMessage({ type: 'cx_ready' }, ${JSON.stringify(ORIGIN)});
})();
<\/script>`;

// Mirrors createScriptSrcContent's error reporter (iframe-doc.ts:202) so MVU/card
// errors surface in the PARENT console instead of being swallowed by the iframe.
// Without this, a thrown Vue/MVU init looks identical to "only grid background".
const ERROR_REPORTER = `<script>
(() => {
  const report = (kind, message, source, line, column) => {
    try {
      window.parent.console.error('[chat-surface iframe]', window.name || 'unknown', kind, message || '', source || '', line || '', column || '');
    } catch (_) {}
  };
  window.addEventListener('error', event => {
    report('error', event.message, event.filename, event.lineno, event.colno);
  });
  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    report('unhandledrejection', reason && (reason.stack || reason.message || String(reason)));
  });
})();
<\/script>`;

// Mirrors createScriptSrcContent's global hoist block (iframe-doc.ts:226-250).
// MVU's bundle.js (an ES module) references these as BARE identifiers. predefine.js
// merges most onto window, but this classic-script hoist guarantees they exist as
// real global properties by the time the module runs (and matches the working MVU
// host setup). Running AFTER predefine.js means window.TavernHelper etc. are set.
const GLOBAL_HOIST = `<script>
var $ = window.$;
var jQuery = window.jQuery;
var Vue = window.Vue;
var VueRouter = window.VueRouter;
var Zod = window.Zod;
var z = window.z || window.Zod;
var TavernHelper = window.TavernHelper;
var SillyTavern = window.SillyTavern;
var getVariables = window.getVariables;
var getAllVariables = window.getAllVariables;
var getChatMessages = window.getChatMessages;
var setChatMessage = window.setChatMessage;
var setChatMessages = window.setChatMessages;
var eventOn = window.eventOn;
var eventEmit = window.eventEmit;
var tavern_events = window.tavern_events;
var waitGlobalInitialized = window.waitGlobalInitialized;
var initializeGlobal = window.initializeGlobal;
var getScriptId = window.getScriptId;
var getCurrentMessageId = window.getCurrentMessageId;
var getLastMessageId = window.getLastMessageId;
var triggerSlash = window.triggerSlash;
var toastr = window.toastr;
<\/script>`;

// Diagnostics: forward the iframe's console.* to the parent console, and report a
// DOM/global-state snapshot ~1.2s after load. MVU/card failures are often silent
// (caught internally, or a CDN module that never loads under Edge tracking-prevention)
// so they never reach window.onerror. Forwarding console surfaces them; the snapshot
// tells us whether MVU mounted, whether message HTML was injected, and the viewport var.
const DIAG_SCRIPT = `<script>
(function () {
  function safe(v) {
    try {
      if (v instanceof Error) return v.stack || v.message;
      if (typeof v === 'string') return v;
      return JSON.stringify(v, function (_k, o) { return typeof o === 'bigint' ? String(o) : o; });
    } catch (e) { return String(v); }
  }
  ['log','info','warn','error','debug'].forEach(function (level) {
    var orig = console[level] ? console[level].bind(console) : null;
    console[level] = function () {
      var args = Array.prototype.slice.call(arguments).map(safe);
      try { window.parent.postMessage({ type: 'cx_console', level: level, args: args }, '*'); } catch (_) {}
      if (orig) orig.apply(console, arguments);
    };
  });
  function report() {
    var root = document.getElementById('cx-chat-root');
    var ext = document.getElementById('extensions_settings2');
    var snap = {
      name: window.name,
      frameElementNull: window.frameElement == null,
      docReady: document.readyState,
      chatRootHtmlLen: root ? root.innerHTML.length : -1,
      chatRootChildCount: root ? root.children.length : -1,
      chatRootPreview: root ? root.innerHTML.replace(/<[^>]*>/g, '').slice(0, 160) : '',
      extChildren: ext ? ext.children.length : -1,
      bodyChildCount: document.body.children.length,
      bodyChildren: Array.prototype.slice.call(document.body.children, 0, 16).map(function (c) {
        return c.tagName + (c.id ? '#' + c.id : '') + (c.className ? '.' + String(c.className).slice(0, 24) : '');
      }),
      typeofVue: typeof window.Vue,
      typeofMvu: typeof window.Mvu,
      typeofTavernHelper: typeof window.TavernHelper,
      typeofZod: typeof window.Zod,
      viewportVar: getComputedStyle(document.documentElement).getPropertyValue('--TH-viewport-height').trim(),
      bodyBg: getComputedStyle(document.body).backgroundColor,
    };
    try { window.parent.postMessage({ type: 'cx_diag', snap: snap }, '*'); } catch (_) {}
  }
  window.addEventListener('load', function () { setTimeout(report, 1200); });
  window.addEventListener('message', function (event) {
    if (event.source === window.parent && event.data && event.data.type === 'cx_diag_request') report();
  });
})();
<\/script>`;

function buildSrcDoc(scripts: TavernHelperScript[]): string {
  // Each helper script runs as its own ES module so one throwing doesn't silence
  // the others. MVU's content is already `import '...bundle.js'`.
  const moduleScripts = scripts
    .map(script => {
      const body = stripCodeFences(script.content);
      if (!body) return '';
      return `<script type="module">
${body}
<\/script>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<base href="${typeof window !== 'undefined' ? window.location.origin : ''}/">
${ERROR_REPORTER}
<style>
*,*::before,*::after{box-sizing:border-box;}
html,body{margin:0;padding:0;height:100%;}
body{overflow-y:auto;background:#0f1117;color:#e5e7eb;font:15px/1.7 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
#extensions_settings2{display:none;}
#cx-streaming-msg{display:none;}
.cx-msg{width:min(980px,100%);margin:0 auto 14px;display:flex;flex-direction:column;gap:6px;padding:0 14px;}
.cx-msg-role{color:#94a3b8;font-size:12px;font-weight:650;}
.cx-msg-body{color:#e5e7eb;overflow-wrap:anywhere;}
.cx-msg-user{align-items:flex-end;}
.cx-msg-user .cx-msg-role,.cx-msg-user .cx-msg-body{width:fit-content;max-width:min(760px,88vw);}
.cx-plain{padding:9px 12px;border:1px solid rgba(147,197,253,0.18);border-radius:6px;background:#1e3a5f;color:#dbeafe;white-space:pre-wrap;overflow-wrap:anywhere;}
img,video,canvas,iframe{max-width:100%;}
.cx-history-wrap{width:min(980px,100%);margin:0 auto 14px;padding:0 14px;}
.cx-history-toggle{width:100%;background:#1d212b;border:1px solid #2b303d;color:#c7ccd6;padding:7px 10px;border-radius:6px;cursor:pointer;font-size:12px;text-align:center;}
.cx-history-toggle:hover{background:#232733;color:#e5e7eb;}
</style>
<link rel="stylesheet" href="${CDN.fontAwesomeCss}"/>
<link rel="stylesheet" href="${CDN.tailwindCss}"/>
<link rel="stylesheet" href="${CDN.jqueryUiCss}"/>
<script src="${CDN.jquery}"><\/script>
<script src="${CDN.jqueryUi}"><\/script>
<script src="${CDN.jqueryUiTouchPunch}"><\/script>
<script src="${CDN.vue2}"><\/script>
<script src="${CDN.vueRouter2}"><\/script>
<script src="${CDN.scriptVue}"><\/script>
<script src="${CDN.scriptVueRouter}"><\/script>
<script src="${CDN.zod}"><\/script>
<script>${ZOD_V4_COMPAT_SCRIPT}<\/script>
<script src="${predefine_url}"><\/script>
${INLINE_BRIDGE}
${DIAG_SCRIPT}
</head>
<body>
<div id="extensions_settings2" aria-hidden="true"></div>
<div id="cx-chat-root"></div>
<div id="cx-streaming-msg" class="cx-msg cx-msg-assistant"></div>
${GLOBAL_HOIST}
${moduleScripts}
</body>
</html>`;
}

export const ChatSurfaceIframe: React.FC<ChatSurfaceIframeProps> = ({
  cardKey,
  messagesHtml,
  tavernHelperScripts,
  streamingHtml,
  collapseThreshold = 10,
}) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const readyRef = useRef(false);

  // Latest content kept in refs so the message listener always reads fresh values
  // without re-binding.
  const messagesRef = useRef(messagesHtml);
  const streamingRef = useRef(streamingHtml);
  const keepTurnsRef = useRef(collapseThreshold);
  messagesRef.current = messagesHtml;
  streamingRef.current = streamingHtml;
  keepTurnsRef.current = collapseThreshold;

  const srcDoc = useMemo(() => buildSrcDoc(tavernHelperScripts), [tavernHelperScripts]);

  // Name the iframe in the JSR `TH-script--` convention so TavernHelper's identity
  // helpers work. In a srcdoc iframe, `window.frameElement` can be null (Edge
  // tracking-prevention / srcdoc parse timing — predefine.js notes this behavior),
  // so _getIframeName falls back to window.name — which the `name` attribute sets.
  // Without it, MVU's getScriptId() throws at init and its Vue app never mounts,
  // leaving only the card's static CSS (grid background) with no interaction.
  // The `TH-script--` prefix also satisfies _getScriptId's `startsWith` check.
  const iframeName = useMemo(
    () => `TH-script--0--chat-surface--${cardKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
    [cardKey],
  );

  const post = (payload: Record<string, unknown>) => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(payload, ORIGIN);
  };

  // Drive --TH-viewport-height from the wrapper's real height (bounded to the
  // render region), NOT window.parent.innerHeight. MVU's 100vh then resolves to
  // this region's height so fixed layers stay inside the iframe.
  const sendViewport = () => {
    const el = wrapperRef.current;
    if (!el) return;
    post({ type: 'cx_update_viewport', height: el.clientHeight });
  };

  const flushContent = () => {
    post({ type: 'cx_set_messages', html: replaceVhInContent(messagesRef.current), keepTurns: keepTurnsRef.current });
    post({ type: 'cx_set_streaming', html: streamingRef.current == null ? null : replaceVhInContent(streamingRef.current) });
  };

  // When the iframe signals readiness, push current content + viewport height.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data;
      if (data?.type === 'cx_ready') {
        readyRef.current = true;
        flushContent();
        sendViewport();
      } else if (data?.type === 'cx_console') {
        const fn = (console as any)[data.level] || console.log;
        fn(`[cx:${data.level}]`, ...(Array.isArray(data.args) ? data.args : []));
      } else if (data?.type === 'cx_diag') {
        console.info('[cx-diag]', data.snap);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push message updates incrementally (no srcdoc rebuild). Re-runs on
  // collapseThreshold too so adjusting the history window re-collapses live.
  useEffect(() => {
    if (!readyRef.current) return;
    post({ type: 'cx_set_messages', html: replaceVhInContent(messagesHtml), keepTurns: collapseThreshold });
  }, [messagesHtml, collapseThreshold]);

  useEffect(() => {
    if (!readyRef.current) return;
    post({ type: 'cx_set_streaming', html: streamingHtml == null ? null : replaceVhInContent(streamingHtml) });
  }, [streamingHtml]);

  // Reset readiness when the document is rebuilt (card switch).
  useEffect(() => {
    readyRef.current = false;
  }, [cardKey]);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => sendViewport());
    observer.observe(el);
    window.addEventListener('resize', sendViewport);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', sendViewport);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="st-host-chat-surface" ref={wrapperRef}>
      <iframe
        ref={iframeRef}
        name={iframeName}
        id={iframeName}
        title={`chat-surface-${cardKey}`}
        srcDoc={srcDoc}
        className="st-host-chat-surface-iframe"
      />
    </div>
  );
};
