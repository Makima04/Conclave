import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import * as api from '../api/client';
import type { CharacterCard, Message, RenderMode, SessionConfig, UserPersona, UserSettingMergeStrategy } from '../api/types';
import { DEFAULT_SESSION_CONFIG } from '../api/types';
import {
  loadGlobalSessionDefaults,
  loadUserPersonaPresets,
  normalizeRenderMode,
  normalizeSessionConfig,
  saveGlobalSessionDefaults,
  type UserPersonaPreset,
} from '../settings/sessionDefaults';

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || '');
  const codeStr = String(children).replace(/\n$/, '');

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(codeStr);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (match) {
    return (
      <div className="code-block-container">
        <SyntaxHighlighter style={oneDark} language={match[1]} PreTag="div" customStyle={{ margin: '8px 0', borderRadius: '6px', fontSize: '13px', overflow: 'auto' }}>
          {codeStr}
        </SyntaxHighlighter>
        <button className="code-copy-float" onClick={handleCopy}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
    );
  }
  return <code className={className}>{children}</code>;
}

function getPathValue(source: any, path: string): any {
  if (!source || !path) return undefined;
  return path.split('.').reduce((current, part) => {
    if (current == null || typeof current !== 'object') return undefined;
    return current[part];
  }, source);
}

function parsePrimaryValue(value: any): string {
  if (Array.isArray(value)) return parsePrimaryValue(value[0]);
  if (value == null) return 'N/A';
  return String(value).split(' | ')[0].trim() || 'N/A';
}

function parsePercent(value: any, min = 0, max = 100): number {
  const raw = parseFloat(parsePrimaryValue(value).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(raw)) return 0;
  if (max <= min) return 0;
  return Math.max(0, Math.min(100, ((raw - min) / (max - min)) * 100));
}

type UiTheme = {
  cardBg: string;
  textPrimary: string;
  textSecondary: string;
  accentMain: string;
  accentRed: string;
  accentBlue: string;
  accentGreen: string;
  gold: string;
  borderGlow: string;
  shadow: string;
};

type UiWidget =
  | { type: 'thoughts'; leftLabel: string; leftPath: string; rightLabel: string; rightPath: string }
  | { type: 'progress'; label: string; path: string; color?: string; min?: number; max?: number }
  | { type: 'facts'; items: Array<{ label: string; path: string }> }
  | { type: 'table'; title: string; rows: string[][] };

type UiSection = {
  title: string;
  widgets: UiWidget[];
};

type UiSchema = {
  title: string;
  datePaths: string[];
  theme: UiTheme;
  sections: UiSection[];
};

type CoverMenuSchema = {
  title: string;
  subtitle: string;
  background?: string;
  buttons: string[];
  theme: UiTheme;
};

type PlatformOpeningCharacter = {
  id: number;
  name: string;
  sect: string;
  title: string;
  front: string;
  avatar: string;
  desc: string;
};

type PlatformLocation = {
  id: string;
  name: string;
  tag: string;
  desc: string;
};

type PlatformLayout = {
  shellMaxWidth: number;
  stageMinHeight: number;
  mainCardWidth: number;
  mainCardMinWidth: number;
  mainCardTop: number;
  mainCardHeight: number;
  sideCardScale: number;
  sideCardOffset: number;
  sideCardOpacity: number;
  backgroundDim: number;
};

type PlatformCardSchema = {
  type: 'game_start';
  title: string;
  subtitle: string;
  background?: string;
  introHtml: string;
  characters: PlatformOpeningCharacter[];
  locations: PlatformLocation[];
  theme: UiTheme;
  layout: PlatformLayout;
};

const DEFAULT_STATUS_THEME: UiTheme = {
  cardBg: '#15101C',
  textPrimary: '#F1E9F4',
  textSecondary: '#A89BAD',
  accentMain: '#B51635',
  accentRed: '#C92546',
  accentBlue: '#6B5E78',
  accentGreen: '#5B8A5E',
  gold: '#B89A5B',
  borderGlow: 'rgba(61, 46, 79, 0.5)',
  shadow: '0 15px 40px rgba(0, 0, 0, 0.45)',
};

const DEFAULT_PLATFORM_LAYOUT: PlatformLayout = {
  shellMaxWidth: 760,
  stageMinHeight: 300,
  mainCardWidth: 280,
  mainCardMinWidth: 180,
  mainCardTop: 3,
  mainCardHeight: 94,
  sideCardScale: 0.72,
  sideCardOffset: 42,
  sideCardOpacity: 0.45,
  backgroundDim: 0.78,
};

function getStatusReplaceString(card: CharacterCard | null): string {
  const scripts = card?.extensions?.regex_scripts;
  if (!Array.isArray(scripts)) return '';
  const script = scripts.find((item: any) =>
    !item?.disabled
      && item?.findRegex === '<StatusPlaceHolderImpl/>'
      && typeof item?.replaceString === 'string'
      && item.replaceString.includes('status-card')
  );
  return script?.replaceString || '';
}

function hasStatusRenderer(card: CharacterCard | null): boolean {
  return Boolean(getStatusReplaceString(card));
}

function stripCodeFence(source: string): string {
  const trimmed = source.trim();
  if (!trimmed.startsWith('```')) return source;
  const firstBreak = trimmed.indexOf('\n');
  if (firstBreak < 0) return source;
  const withoutOpen = trimmed.slice(firstBreak + 1);
  const close = withoutOpen.lastIndexOf('```');
  return close >= 0 ? withoutOpen.slice(0, close) : withoutOpen;
}

function getRegexScripts(card: CharacterCard | null): any[] {
  const scripts = card?.extensions?.regex_scripts;
  return Array.isArray(scripts) ? scripts : [];
}

function getUiReplaceStringForContent(card: CharacterCard | null, content: string): string {
  const scripts = getRegexScripts(card);
  const script = scripts.find((item: any) =>
    !item?.disabled
      && typeof item?.findRegex === 'string'
      && typeof item?.replaceString === 'string'
      && item.replaceString.length > 0
      && !item.findRegex.startsWith('/')
      && content.includes(item.findRegex)
  );
  return script?.replaceString || '';
}

function isComplexCardUiSource(source: string): boolean {
  return source.length > 3000
    || /<html\b|<head\b|<body\b|<style\b/i.test(source)
    || /<script\b/i.test(source)
    || /\b(?:cx-launcher|view-container|TavernHelper|jquery|audio|music)\b/i.test(source);
}

function hasComplexCardUi(card: CharacterCard | null): boolean {
  return getRegexScripts(card).some((item: any) =>
    !item?.disabled
      && typeof item?.replaceString === 'string'
      && item.replaceString.length > 0
      && isComplexCardUiSource(stripCodeFence(item.replaceString))
  );
}

function isGameStartCard(card: CharacterCard | null): boolean {
  if (!card) return false;
  const firstMes = (card.first_mes || '').trim();
  return firstMes === '【GameStart】'
    || getRegexScripts(card).some((item: any) =>
      !item?.disabled
        && typeof item?.findRegex === 'string'
        && item.findRegex.includes('GameStart')
        && typeof item?.replaceString === 'string'
        && isComplexCardUiSource(stripCodeFence(item.replaceString))
    );
}

function getSandboxHtmlForContent(card: CharacterCard | null, content: string): string {
  const source = stripCodeFence(getUiReplaceStringForContent(card, content)).trim();
  const complex = isComplexCardUiSource(source);
  if (!source || !complex || !/<(?:!doctype|html|head|body|style|div|img|button)\b/i.test(source)) {
    return '';
  }
  return sanitizeSandboxHtml(source, { allowScripts: true });
}

function sanitizeSandboxHtml(source: string, options: { allowScripts?: boolean } = {}): string {
  const base = source
    .replace(/javascript:/gi, '')
    .replace(/<link\b[^>]*href=["'][^"']*code\.jquery[^"']*["'][^>]*>/gi, '');
  const withoutDangerousAttrs = options.allowScripts
    ? base
    : base.replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  if (options.allowScripts) {
    return withoutDangerousAttrs;
  }
  return withoutDangerousAttrs.replace(/<script\b[\s\S]*?<\/script>/gi, '');
}

function sanitizeHtmlFragment(source: string): string {
  return sanitizeSandboxHtml(source)
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object\b[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[\s\S]*?>/gi, '');
}

function parseRegexLiteral(source: string): RegExp | null {
  if (!source.startsWith('/')) return null;
  const lastSlash = source.lastIndexOf('/');
  if (lastSlash <= 0) return null;
  const pattern = source.slice(1, lastSlash);
  const flags = source.slice(lastSlash + 1).replace(/[^dgimsuvy]/g, '');
  try {
    return new RegExp(pattern, flags.includes('g') ? flags : `${flags}g`);
  } catch {
    return null;
  }
}

function applyCardDisplayRegexScripts(card: CharacterCard | null, content: string): string {
  let output = content;
  for (const script of getRegexScripts(card)) {
    if (script?.disabled || script?.promptOnly || !script?.markdownOnly) continue;
    if (typeof script.findRegex !== 'string' || typeof script.replaceString !== 'string') continue;
    if (!script.replaceString || /<script\b/i.test(script.replaceString)) continue;
    if (script.findRegex === '<StatusPlaceHolderImpl/>' || script.findRegex.includes('GameStart')) continue;
    if (script.findRegex.includes('UpdateVariable')) continue;

    const replacement = sanitizeHtmlFragment(script.replaceString);
    const regex = parseRegexLiteral(script.findRegex);
    if (regex) {
      output = output.replace(regex, replacement);
    } else {
      output = output.split(script.findRegex).join(replacement);
    }
  }
  return output;
}

function renderCardFormattedContent(card: CharacterCard | null, content: string): React.ReactNode {
  const normalized = content
    .replace(/<\/?正文>/g, '')
    .replace(/{{user}}/g, '你')
    .replace(/{{char}}/g, '')
    .replace(/<user>/g, '你')
    .replace(/<\/user>/g, '')
    .replace(/<char>/g, '')
    .replace(/<\/char>/g, '')
    .replace(/<\/?initvar>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const formatted = applyCardDisplayRegexScripts(card, normalized)
    .replace(/<UpdateVariable(?:variable)?\b[^>]*>[\s\S]*?<\/UpdateVariable(?:variable)?>/gi, '')
    .trim();

  if (/<(?:style|div|span|details|summary|img)\b/i.test(formatted)) {
    return <div className="card-regex-html" dangerouslySetInnerHTML={{ __html: sanitizeHtmlFragment(formatted) }} />;
  }
  return renderInlineDecorators(formatted);
}

function buildSandboxDocument(innerHtml: string): string {
  const body = /<html[\s\S]*?>[\s\S]*<\/html>/i.test(innerHtml)
    ? innerHtml
    : `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${innerHtml}</body></html>`;

  const shim = `
<script>
(() => {
  const toArray = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (value instanceof Element || value === document || value === window) return [value];
    if (value instanceof MiniQuery) return value.items;
    if (typeof value.length === 'number') return Array.from(value);
    return [value];
  };
  const parseDataValue = (value) => {
    if (value == null) return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null') return null;
    if (value !== '' && !Number.isNaN(Number(value)) && String(Number(value)) === value) return Number(value);
    if (/^[\\[{]/.test(value)) {
      try { return JSON.parse(value); } catch {}
    }
    return value;
  };
  class MiniQuery {
    constructor(value) {
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
          const template = document.createElement('template');
          template.innerHTML = trimmed;
          this.items = Array.from(template.content.childNodes).filter(node => node.nodeType === Node.ELEMENT_NODE);
        } else {
          try {
            this.items = Array.from(document.querySelectorAll(value));
          } catch {
            this.items = [];
          }
        }
      } else this.items = toArray(value);
      this.length = this.items.length;
    }
    on(type, selectorOrHandler, maybeHandler) {
      const delegated = typeof selectorOrHandler === 'string';
      const selector = delegated ? selectorOrHandler : '';
      const handler = delegated ? maybeHandler : selectorOrHandler;
      if (typeof handler !== 'function') return this;
      this.items.forEach(el => el && el.addEventListener && el.addEventListener(type, function(event) {
        if (!delegated) return handler.call(this, event);
        const target = event.target && event.target.closest ? event.target.closest(selector) : null;
        if (target && el.contains && el.contains(target)) handler.call(target, event);
      }));
      return this;
    }
    each(handler) { if (typeof handler === 'function') this.items.forEach((el, index) => handler.call(el, index, el)); return this; }
    addClass(name) { this.items.forEach(el => el.classList && el.classList.add(...String(name).split(/\\s+/).filter(Boolean))); return this; }
    removeClass(name) { this.items.forEach(el => el.classList && el.classList.remove(...String(name).split(/\\s+/).filter(Boolean))); return this; }
    toggleClass(name) { this.items.forEach(el => el.classList && el.classList.toggle(name)); return this; }
    hasClass(name) { return Boolean(this.items[0]?.classList?.contains(name)); }
    closest(selector) { return new MiniQuery(this.items.map(el => el?.closest ? el.closest(selector) : null).filter(Boolean)); }
    find(selector) { return new MiniQuery(this.items.flatMap(el => el?.querySelectorAll ? Array.from(el.querySelectorAll(selector)) : [])); }
    data(name, value) {
      const key = String(name).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (value === undefined) return parseDataValue(this.items[0]?.dataset?.[key]);
      this.items.forEach(el => { if (el?.dataset) el.dataset[key] = String(value); });
      return this;
    }
    attr(name, value) { if (value === undefined) return this.items[0]?.getAttribute?.(name); this.items.forEach(el => el?.setAttribute?.(name, value)); return this; }
    prop(name, value) { if (value === undefined) return this.items[0]?.[name]; this.items.forEach(el => { if (el) el[name] = value; }); return this; }
    val(value) { if (value === undefined) return this.items[0]?.value; this.items.forEach(el => { if ('value' in el) el.value = value; }); return this; }
    text(value) { if (value === undefined) return this.items.map(el => el.textContent || '').join(''); this.items.forEach(el => { el.textContent = value; }); return this; }
    html(value) { if (value === undefined) return this.items[0]?.innerHTML || ''; this.items.forEach(el => { el.innerHTML = value; }); return this; }
    css(name, value) { if (value === undefined && typeof name === 'string') return getComputedStyle(this.items[0]).getPropertyValue(name); this.items.forEach(el => { if (!el?.style) return; if (typeof name === 'object') Object.assign(el.style, name); else el.style[name] = value; }); return this; }
    focus() { this.items[0]?.focus && this.items[0].focus(); return this; }
    show() { this.items.forEach(el => { if (el?.style) el.style.display = ''; }); return this; }
    hide() { this.items.forEach(el => { if (el?.style) el.style.display = 'none'; }); return this; }
    append(value) { this.items.forEach(el => { if (!el) return; if (typeof value === 'string') el.insertAdjacentHTML('beforeend', value); else if (value instanceof Node) el.appendChild(value.cloneNode(true)); }); return this; }
    slideDown(duration, callback) { this.items.forEach(el => { if (el?.style) el.style.display = ''; if (typeof duration === 'function') duration.call(el); else if (typeof callback === 'function') setTimeout(() => callback.call(el), Number(duration) || 0); }); return this; }
    slideUp(duration, callback) { this.items.forEach(el => { const done = () => { if (el?.style) el.style.display = 'none'; if (typeof callback === 'function') callback.call(el); }; if (typeof duration === 'function') { done(); duration.call(el); } else setTimeout(done, Number(duration) || 0); }); return this; }
    remove() { this.items.forEach(el => el?.remove && el.remove()); return this; }
    [Symbol.iterator]() { return this.items[Symbol.iterator](); }
  }
  window.$ = window.jQuery = (value) => new MiniQuery(value);
})();
</script>`;

  const bridge = `
<style>
html,body{margin:0;min-height:100%;background:transparent;overflow:auto;}
img,video{max-width:100%;height:auto;}
</style>
<script>
(() => {
  const post = (message) => parent.postMessage(message, '*');
  const safeText = (value) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
  const notify = () => post({ type: 'sandbox-resize', height: Math.min(1800, Math.max(360, document.documentElement.scrollHeight || document.body.scrollHeight || 0)) });
  window.__XRPBridge = Object.freeze({
    applyGreeting: (index) => post({ type: 'card-sandbox-action', action: 'applyGreeting', payload: { index: Number(index) } }),
    readVariables: (paths) => post({ type: 'card-sandbox-action', action: 'readVariables', payload: { paths: Array.isArray(paths) ? paths.slice(0, 50) : [] } }),
    writeVariables: (changes) => post({ type: 'card-sandbox-action', action: 'writeVariables', payload: { changes: changes && typeof changes === 'object' ? changes : {} } }),
    openStatusPanel: () => post({ type: 'card-sandbox-action', action: 'openStatusPanel', payload: {} }),
    submitFreeStart: (payload) => post({ type: 'card-sandbox-action', action: 'submitFreeStart', payload: payload && typeof payload === 'object' ? payload : {} }),
  });
  window.getChatMessages = async () => [{ message_id: 0, swipes: [] }];
  window.setChatMessage = (message, messageId, options) => {
    const swipeId = Number(options?.swipe_id);
    post({ type: 'card-sandbox-action', action: 'setChatMessage', payload: { message: String(message || '').slice(0, 8000), swipeId: Number.isFinite(swipeId) ? swipeId : undefined } });
  };
  window.setChatMessages = async (messages) => {
    const first = Array.isArray(messages) ? messages[0] : null;
    const swipeId = Number(first?.swipe_id);
    if (Number.isFinite(swipeId)) {
      post({ type: 'card-sandbox-action', action: 'applyOpeningSwipe', payload: { swipeId } });
      return;
    }
    if (first?.message) {
      post({ type: 'card-sandbox-action', action: 'setChatMessage', payload: { message: String(first.message).slice(0, 8000) } });
    }
  };
  window.triggerSlash = (command) => post({ type: 'card-sandbox-action', action: 'triggerSlash', payload: { command: String(command || '').slice(0, 2000) } });
  document.addEventListener('click', (event) => {
    const target = event.target && event.target.closest ? event.target.closest('button,a,[role="button"],[data-action]') : null;
    if (!target) return;
    post({
      type: 'card-sandbox-action',
      action: 'uiClick',
      payload: {
        text: safeText(target.innerText || target.textContent || target.value),
        id: safeText(target.id),
        className: safeText(target.className),
        dataAction: safeText(target.getAttribute && target.getAttribute('data-action')),
        value: safeText(target.value),
      },
    });
  }, true);
  document.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = {};
    try {
      new FormData(event.target).forEach((value, key) => { data[key] = String(value).slice(0, 1000); });
    } catch {}
    post({ type: 'card-sandbox-action', action: 'formSubmit', payload: data });
  }, true);
  new ResizeObserver(notify).observe(document.documentElement);
  window.addEventListener('load', notify);
  setTimeout(notify, 80);
  setTimeout(notify, 500);
})();
</script>`;

  const injected = `${shim}${bridge}`;
  if (/<\/head>/i.test(body)) {
    return body.replace(/<\/head>/i, `${injected}</head>`);
  }
  if (/<script\b/i.test(body)) {
    return body.replace(/<script\b/i, `${injected}<script`);
  }
  if (/<\/body>/i.test(body)) {
    return body.replace(/<\/body>/i, `${injected}</body>`);
  }
  return `${injected}${body}`;
}

function extractCssVar(source: string, name: string, fallback: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*:\\s*([^;]+);`));
  return match?.[1]?.trim() || fallback;
}

function extractFirst(source: string, pattern: RegExp, fallback: string): string {
  return source.match(pattern)?.[1]?.trim() || fallback;
}

function extractInlineStyleValue(source: string, name: string, fallback: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*:\\s*([^;"]+)`, 'i'));
  return match?.[1]?.trim() || fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function firstDefined(...values: unknown[]): unknown {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

function getPlatformLayoutConfig(card: CharacterCard | null): any {
  const extensions = card?.extensions;
  if (!extensions || typeof extensions !== 'object') return {};
  return extensions.platform_ui?.carousel
    || extensions.platform_ui?.layout
    || extensions.xrp_platform_ui?.carousel
    || extensions.xrp_platform_ui?.layout
    || extensions.ui_layout?.carousel
    || {};
}

function buildPlatformLayout(card: CharacterCard | null, source: string): PlatformLayout {
  const config = getPlatformLayoutConfig(card);
  const css = (name: string) => extractCssVar(source, name, '');

  return {
    shellMaxWidth: clampNumber(firstDefined(config.shellMaxWidth, config.shell_max_width, css('--xrp-shell-max-width')), 560, 1100, DEFAULT_PLATFORM_LAYOUT.shellMaxWidth),
    stageMinHeight: clampNumber(firstDefined(config.stageMinHeight, config.stage_min_height, css('--xrp-stage-min-height')), 220, 620, DEFAULT_PLATFORM_LAYOUT.stageMinHeight),
    mainCardWidth: clampNumber(firstDefined(config.mainCardWidth, config.main_card_width, css('--xrp-main-card-width')), 180, 420, DEFAULT_PLATFORM_LAYOUT.mainCardWidth),
    mainCardMinWidth: clampNumber(firstDefined(config.mainCardMinWidth, config.main_card_min_width, css('--xrp-main-card-min-width')), 128, 260, DEFAULT_PLATFORM_LAYOUT.mainCardMinWidth),
    mainCardTop: clampNumber(firstDefined(config.mainCardTop, config.main_card_top, css('--xrp-main-card-top')), 0, 12, DEFAULT_PLATFORM_LAYOUT.mainCardTop),
    mainCardHeight: clampNumber(firstDefined(config.mainCardHeight, config.main_card_height, css('--xrp-main-card-height')), 68, 100, DEFAULT_PLATFORM_LAYOUT.mainCardHeight),
    sideCardScale: clampNumber(firstDefined(config.sideCardScale, config.side_card_scale, css('--xrp-side-card-scale')), 0.48, 0.9, DEFAULT_PLATFORM_LAYOUT.sideCardScale),
    sideCardOffset: clampNumber(firstDefined(config.sideCardOffset, config.side_card_offset, css('--xrp-side-card-offset')), 28, 72, DEFAULT_PLATFORM_LAYOUT.sideCardOffset),
    sideCardOpacity: clampNumber(firstDefined(config.sideCardOpacity, config.side_card_opacity, css('--xrp-side-card-opacity')), 0.12, 0.7, DEFAULT_PLATFORM_LAYOUT.sideCardOpacity),
    backgroundDim: clampNumber(firstDefined(config.backgroundDim, config.background_dim, css('--xrp-background-dim')), 0.45, 0.92, DEFAULT_PLATFORM_LAYOUT.backgroundDim),
  };
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(text: string): string {
  return decodeHtmlEntities(text.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function buildCoverMenuSchema(card: CharacterCard | null, content: string): CoverMenuSchema | null {
  const source = stripCodeFence(getUiReplaceStringForContent(card, content));
  if (!source) return null;

  const title = stripTags(
    extractFirst(source, /<(?:h1|h2|div|span)[^>]*(?:title|cx-title|main-title)[^>]*>([\s\S]*?)<\/(?:h1|h2|div|span)>/i, '')
  ) || card?.name || '角色卡';
  const subtitle = stripTags(
    extractFirst(source, /<(?:p|div|span)[^>]*(?:subtitle|sub-title|tagline)[^>]*>([\s\S]*?)<\/(?:p|div|span)>/i, '')
  );
  const background = extractFirst(source, /<img[^>]+(?:class="[^"]*(?:base-bg|bg|cover)[^"]*"[^>]+)?src=["']([^"']+)["']/i, '');
  const buttonMatches = Array.from(source.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gi))
    .map(match => stripTags(match[1]))
    .filter(Boolean);
  const fallbackButtons = Array.from(source.matchAll(/<(?:div|a)[^>]+class=["'][^"']*(?:nav|btn|button|menu-item)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|a)>/gi))
    .map(match => stripTags(match[1]))
    .filter(Boolean);
  const buttons = Array.from(new Set((buttonMatches.length ? buttonMatches : fallbackButtons).slice(0, 8)));

  if (!background && buttons.length === 0 && !source.includes('cx-launcher')) {
    return null;
  }

  return {
    title,
    subtitle,
    background: background || undefined,
    buttons,
    theme: {
      cardBg: extractCssVar(source, '--cx-bg-base', '#15101C'),
      textPrimary: extractCssVar(source, '--cx-text-title', '#F1E9F4'),
      textSecondary: extractCssVar(source, '--cx-text-body', '#A89BAD'),
      accentMain: extractCssVar(source, '--cx-gold-main', '#B51635'),
      accentRed: extractCssVar(source, '--cx-danger', '#C92546'),
      accentBlue: '#6B5E78',
      accentGreen: '#5B8A5E',
      gold: extractCssVar(source, '--cx-gold-light', '#B89A5B'),
      borderGlow: extractCssVar(source, '--cx-glass-border', 'rgba(61, 46, 79, 0.5)'),
      shadow: extractInlineStyleValue(source, 'box-shadow', '0 18px 45px rgba(0, 0, 0, 0.55)'),
    },
  };
}

function extractScriptArray(source: string, variableName: string): any[] {
  const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const marker = source.match(new RegExp(`const\\s+${escaped}\\s*=\\s*\\[`));
  if (!marker || marker.index == null) return [];
  const start = marker.index + marker[0].lastIndexOf('[');
  let depth = 0;
  let inString: string | null = null;
  let escapedChar = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escapedChar) {
        escapedChar = false;
      } else if (char === '\\') {
        escapedChar = true;
      } else if (char === inString) {
        inString = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = char;
      continue;
    }
    if (char === '[') depth += 1;
    if (char === ']') depth -= 1;
    if (depth === 0) {
      const literal = source.slice(start, i + 1);
      try {
        return Function(`"use strict"; return (${literal});`)();
      } catch {
        return [];
      }
    }
  }
  return [];
}

function buildPlatformCardSchema(card: CharacterCard | null, content: string): PlatformCardSchema | null {
  if (!card || !content.includes('【GameStart】')) return null;
  const source = stripCodeFence(getUiReplaceStringForContent(card, content));
  if (!source || !source.includes('cx-launcher') || !source.includes('characters = [')) return null;

  const characters = extractScriptArray(source, 'characters')
    .map((item: any) => ({
      id: Number(item.id),
      name: String(item.name || ''),
      sect: String(item.sect || ''),
      title: String(item.title || ''),
      front: String(item.front || ''),
      avatar: String(item.avatar || ''),
      desc: stripTags(String(item.desc || '')),
    }))
    .filter((item: PlatformOpeningCharacter) => Number.isFinite(item.id) && item.name && item.front);

  if (characters.length === 0) return null;

  const locations = extractScriptArray(source, 'locations')
    .map((item: any) => ({
      id: String(item.id || ''),
      name: String(item.name || ''),
      tag: String(item.tag || ''),
      desc: String(item.desc || ''),
    }))
    .filter((item: PlatformLocation) => item.id && item.name);

  const background = extractFirst(source, /<img[^>]+class=["'][^"']*cx-base-bg-img[^"']*["'][^>]+src=["']([^"']+)["']/i, '')
    || extractFirst(source, /<img[^>]+src=["']([^"']+)["'][^>]+class=["'][^"']*cx-base-bg-img[^"']*["']/i, '');
  const title = stripTags(extractFirst(source, /<h1[^>]*>([\s\S]*?)<\/h1>/i, '')) || card.name;
  const subtitle = stripTags(extractFirst(source, /<div[^>]+class=["'][^"']*home-subtitle[^"']*["'][^>]*>([\s\S]*?)<\/div>/i, ''))
    || stripTags(extractFirst(source, /<p[^>]+class=["'][^"']*subtitle[^"']*["'][^>]*>([\s\S]*?)<\/p>/i, ''));
  const introHtml = sanitizeHtmlFragment(extractFirst(source, /<div[^>]+id=["']intro-view["'][\s\S]*?<div[^>]+class=["'][^"']*scroll-content[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i, ''));

  return {
    type: 'game_start',
    title,
    subtitle,
    background: background || undefined,
    introHtml,
    characters,
    locations,
    theme: {
      cardBg: extractCssVar(source, '--cx-bg-base', DEFAULT_STATUS_THEME.cardBg),
      textPrimary: extractCssVar(source, '--cx-text-title', DEFAULT_STATUS_THEME.textPrimary),
      textSecondary: extractCssVar(source, '--cx-text-body', DEFAULT_STATUS_THEME.textSecondary),
      accentMain: extractCssVar(source, '--cx-gold-main', DEFAULT_STATUS_THEME.accentMain),
      accentRed: extractCssVar(source, '--cx-danger', DEFAULT_STATUS_THEME.accentRed),
      accentBlue: '#0F172A',
      accentGreen: '#3F6F52',
      gold: extractCssVar(source, '--cx-gold-light', DEFAULT_STATUS_THEME.gold),
      borderGlow: extractCssVar(source, '--cx-glass-border', DEFAULT_STATUS_THEME.borderGlow),
      shadow: '0 18px 45px rgba(0, 0, 0, 0.55)',
    },
    layout: buildPlatformLayout(card, source),
  };
}

function buildStatusSchema(card: CharacterCard | null): UiSchema | null {
  const source = getStatusReplaceString(card);
  if (!source) return null;

  const theme: UiTheme = {
    cardBg: extractCssVar(source, '--card-bg', DEFAULT_STATUS_THEME.cardBg),
    textPrimary: extractCssVar(source, '--text-primary', DEFAULT_STATUS_THEME.textPrimary),
    textSecondary: extractCssVar(source, '--text-secondary', DEFAULT_STATUS_THEME.textSecondary),
    accentMain: extractCssVar(source, '--accent-main', DEFAULT_STATUS_THEME.accentMain),
    accentRed: extractCssVar(source, '--accent-red', DEFAULT_STATUS_THEME.accentRed),
    accentBlue: extractCssVar(source, '--accent-blue', DEFAULT_STATUS_THEME.accentBlue),
    accentGreen: extractCssVar(source, '--accent-green', DEFAULT_STATUS_THEME.accentGreen),
    gold: extractCssVar(source, '--gold-highlight', DEFAULT_STATUS_THEME.gold),
    borderGlow: extractCssVar(source, '--border-glow', DEFAULT_STATUS_THEME.borderGlow),
    shadow: extractCssVar(source, '--card-shadow', DEFAULT_STATUS_THEME.shadow),
  };

  const title = extractFirst(source, /<h2>([^<]+)<\/h2>/, '状态');
  const sectionTitles = Array.from(source.matchAll(/<div class=\\"section-header\\"[^>]*><span>([^<]+)<\/span>/g))
    .map(match => match[1])
    .filter(Boolean);
  const [
    thoughtsTitle = '当前状态',
    spiritTitle = '数值',
    traitsTitle = '特质',
    bodyTitle = '身体',
    curriculumTitle = '日程',
    skillsTitle = '成长',
    factsTitle = '境遇',
  ] = sectionTitles;

  return {
    title,
    datePaths: ['世界.当前日期', '世界.当前星期', '世界.当前时间'],
    theme,
    sections: [
      {
        title: thoughtsTitle,
        widgets: [{
          type: 'thoughts',
          leftLabel: '她的想法',
          leftPath: '时幼微.当前所想',
          rightLabel: '我的心声',
          rightPath: '<user>.内心想法',
        }],
      },
      {
        title: spiritTitle,
        widgets: [
          { type: 'progress', label: '调教值', path: '<user>.精神状态数值.调教值', color: theme.accentMain },
          { type: 'progress', label: '反抗意志', path: '<user>.精神状态数值.反抗意志', color: theme.accentBlue },
          { type: 'progress', label: '爱意值', path: '<user>.精神状态数值.爱意值', color: theme.accentRed },
          { type: 'progress', label: '记忆扭曲', path: '<user>.精神状态数值.记忆扭曲度', color: '#6A5ACD' },
        ],
      },
      {
        title: traitsTitle,
        widgets: ['暴露癖', '拘束倾向', '受虐快感', '媚主本能', '雌性自觉'].map(name => ({
          type: 'progress',
          label: `${name} Lv.{${name}}`,
          path: `<user>.特质.${name}.觉醒进度`,
          color: theme.accentGreen,
        })),
      },
      {
        title: bodyTitle,
        widgets: [
          { type: 'progress', label: '开发总览', path: '<user>.身体开发.开发总览.身体开发度', color: theme.accentGreen },
          { type: 'progress', label: '乳头', path: '<user>.身体开发.性感带.乳头.开发度', color: '#FFB6C1' },
          { type: 'progress', label: '口穴', path: '<user>.身体开发.性感带.口穴.开发度', color: '#FFC0CB' },
          { type: 'progress', label: '小穴', path: '<user>.身体开发.性感带.小穴.开发度', color: '#FF69B4' },
          { type: 'progress', label: '子宫', path: '<user>.身体开发.性感带.子宫.开发度', color: '#D8BFD8' },
          { type: 'progress', label: '后庭', path: '<user>.身体开发.性感带.肛门.开发度', color: '#CD5C5C' },
          { type: 'progress', label: '皮肤', path: '<user>.身体开发.性感带.皮肤.开发度', color: '#F5DEB3' },
        ],
      },
      {
        title: curriculumTitle,
        widgets: [{
          type: 'table',
          title: '本周课程安排',
          rows: [
            ['周一', '规矩认知课', '肉体屈从训练'],
            ['周二', '过往罪孽审视', '感官遮断训练'],
            ['周三', '身体数据采集', '痛觉阈值标定'],
            ['周四', '羞耻心剥离', '隐私剥夺训练'],
            ['周五', '屈辱姿态定型', '服从性动作模仿'],
            ['周六', '绝对力量展示', ''],
            ['周日', '静态拘束放置', ''],
          ],
        }],
      },
      {
        title: skillsTitle,
        widgets: [{ type: 'facts', items: [{ label: '成长之路', path: '<user>.成长之路' }] }],
      },
      {
        title: factsTitle,
        widgets: [{
          type: 'facts',
          items: [
            { label: '称号', path: '<user>.称号' },
            { label: '位置', path: '<user>.当前位置' },
            { label: '衣装', path: '<user>.当前服饰' },
            { label: '奖励点数', path: '<user>.资源.奖励点数' },
            { label: '惩罚点数', path: '<user>.资源.惩罚点数' },
          ],
        }],
      },
    ],
  };
}

function StatusMetric({ label, value, color = '#C8A2C8' }: { label: string; value: any; color?: string }) {
  return (
    <div className="schema-metric">
      <div className="schema-metric-row">
        <span>{label}</span>
        <strong>{parsePrimaryValue(value)}</strong>
      </div>
      <div className="schema-bar">
        <div className="schema-bar-fill" style={{ width: `${parsePercent(value)}%`, background: color }} />
      </div>
    </div>
  );
}

function formatSchemaLabel(label: string, variables: any): string {
  return label.replace(/\{([^}]+)\}/g, (_, name) => {
    return parsePrimaryValue(getPathValue(variables, `<user>.特质.${name}.等级`));
  });
}

function SchemaWidget({ widget, variables }: { widget: UiWidget; variables: any }) {
  if (widget.type === 'thoughts') {
    return (
      <div className="schema-thought-grid">
        <div>
          <span>{widget.leftLabel}</span>
          <p>{parsePrimaryValue(getPathValue(variables, widget.leftPath))}</p>
        </div>
        <div>
          <span>{widget.rightLabel}</span>
          <p>{parsePrimaryValue(getPathValue(variables, widget.rightPath))}</p>
        </div>
      </div>
    );
  }

  if (widget.type === 'progress') {
    return (
      <StatusMetric
        label={formatSchemaLabel(widget.label, variables)}
        value={getPathValue(variables, widget.path)}
        color={widget.color}
      />
    );
  }

  if (widget.type === 'facts') {
    return (
      <div className="schema-facts">
        {widget.items.map(item => (
          <span key={`${item.label}-${item.path}`}>{item.label}：{parsePrimaryValue(getPathValue(variables, item.path))}</span>
        ))}
      </div>
    );
  }

  if (widget.type === 'table') {
    return (
      <div className="schema-table-wrap">
        <table className="schema-table">
          <thead>
            <tr><th>日期</th><th>上午</th><th>下午</th></tr>
          </thead>
          <tbody>
            {widget.rows.map(row => (
              <tr key={row.join('-')}>
                <td>{row[0]}</td><td>{row[1]}</td><td>{row[2] || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return null;
}

function CustomStatusRenderer({ schema, variables }: { schema: UiSchema | null; variables: any }) {
  if (!schema) return null;

  const worldDate = schema.datePaths
    .map(path => parsePrimaryValue(getPathValue(variables, path)))
    .filter(v => v !== 'N/A')
    .join(' ');
  const initialized = Boolean(getPathValue(variables, '<user>.精神状态数值') || getPathValue(variables, '<user>.身体开发') || getPathValue(variables, '世界.当前日期'));
  const style = {
    '--schema-card-bg': schema.theme.cardBg,
    '--schema-text-primary': schema.theme.textPrimary,
    '--schema-text-secondary': schema.theme.textSecondary,
    '--schema-accent-main': schema.theme.accentMain,
    '--schema-gold': schema.theme.gold,
    '--schema-border-glow': schema.theme.borderGlow,
    '--schema-shadow': schema.theme.shadow,
  } as React.CSSProperties;

  return (
    <details className="schema-status-shell" open={initialized} style={style}>
      <summary>
        <span>{schema.title}</span>
        <small>{worldDate || '状态未初始化'}</small>
      </summary>
      <div className="schema-status-card">
        {!initialized && (
          <div className="schema-empty-state">
            状态变量还没有完整初始化。继续发送开场白或下一轮回复后，这里会显示角色卡状态。
          </div>
        )}

        {schema.sections.map(section => (
          <div className="schema-section" key={section.title}>
            <div className="schema-section-title">{section.title}</div>
            <div className="schema-grid">
              {section.widgets.map((widget, index) => (
                <SchemaWidget key={`${section.title}-${index}`} widget={widget} variables={variables} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

function CoverMenuRenderer({ schema }: { schema: CoverMenuSchema }) {
  const style = {
    '--cover-bg': schema.theme.cardBg,
    '--cover-text': schema.theme.textPrimary,
    '--cover-muted': schema.theme.textSecondary,
    '--cover-accent': schema.theme.accentMain,
    '--cover-gold': schema.theme.gold,
    '--cover-border': schema.theme.borderGlow,
    '--cover-shadow': schema.theme.shadow,
  } as React.CSSProperties;

  return (
    <div className="schema-cover-menu" style={style}>
      {schema.background && <img className="schema-cover-bg" src={schema.background} alt={schema.title} />}
      <div className="schema-cover-overlay" />
      <div className="schema-cover-content">
        <div className="schema-cover-title">{schema.title}</div>
        {schema.subtitle && <div className="schema-cover-subtitle">{schema.subtitle}</div>}
        {schema.buttons.length > 0 && (
          <div className="schema-cover-buttons">
            {schema.buttons.map(label => (
              <button key={label} type="button" className="schema-cover-button">{label}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PlatformGameStartRenderer({
  schema,
  onAction,
}: {
  schema: PlatformCardSchema;
  onAction?: (action: SandboxCardAction) => void;
}) {
  const [view, setView] = useState<'home' | 'intro' | 'map' | 'carousel'>('home');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedLocation, setSelectedLocation] = useState<PlatformLocation | null>(null);
  const [showFreeStart, setShowFreeStart] = useState(false);
  const selected = schema.characters[selectedIndex] || schema.characters[0];
  const style = {
    '--platform-card-bg': schema.theme.cardBg,
    '--platform-card-text': schema.theme.textPrimary,
    '--platform-card-muted': schema.theme.textSecondary,
    '--platform-card-accent': schema.theme.accentMain,
    '--platform-card-gold': schema.theme.gold,
    '--platform-card-border': schema.theme.borderGlow,
    '--platform-card-shadow': schema.theme.shadow,
    '--platform-shell-max-width': `${schema.layout.shellMaxWidth}px`,
    '--platform-stage-min-height': `${schema.layout.stageMinHeight}px`,
    '--platform-main-card-width': `${schema.layout.mainCardWidth}px`,
    '--platform-main-card-min-width': `${schema.layout.mainCardMinWidth}px`,
    '--platform-main-card-top': `${schema.layout.mainCardTop}%`,
    '--platform-main-card-height': `${schema.layout.mainCardHeight}%`,
    '--platform-side-card-scale': schema.layout.sideCardScale,
    '--platform-side-card-offset': `${schema.layout.sideCardOffset}%`,
    '--platform-side-card-opacity': schema.layout.sideCardOpacity,
    '--platform-background-dim': schema.layout.backgroundDim,
  } as React.CSSProperties;

  function selectCharacter(id: number) {
    onAction?.({ action: 'applyOpeningSwipe', payload: { swipeId: id } });
  }

  function randomize() {
    setSelectedIndex(Math.floor(Math.random() * schema.characters.length));
  }

  return (
    <div className="platform-card-shell" style={style}>
      {schema.background && <img className="platform-card-bg" src={schema.background} alt={schema.title} />}
      <div className="platform-card-overlay" />
      <div className="platform-card-ui">
        {view !== 'home' && (
          <button className="platform-icon-btn platform-close-btn" type="button" onClick={() => setView('home')} title="关闭">x</button>
        )}

        {view === 'home' && (
          <div className="platform-home">
            <div>
              <div className="platform-title">{schema.title}</div>
              {schema.subtitle && <div className="platform-subtitle">{schema.subtitle}</div>}
            </div>
            <div className="platform-menu">
              <button type="button" onClick={() => setView('intro')}>天道卷首</button>
              <button type="button" onClick={() => setView('map')}>苍玄地志</button>
              <button type="button" onClick={() => setView('carousel')}>因果轮盘</button>
            </div>
          </div>
        )}

        {view === 'intro' && (
          <div className="platform-scroll-panel">
            <div className="platform-panel-title">天道卷首</div>
            {schema.introHtml ? (
              <div className="platform-rich-text" dangerouslySetInnerHTML={{ __html: schema.introHtml }} />
            ) : (
              <p>大道五十，天衍四九。</p>
            )}
          </div>
        )}

        {view === 'map' && (
          <div className="platform-map-view">
            <div className="platform-panel-title">苍玄地志</div>
            <div className="platform-location-grid">
              {schema.locations.map(location => (
                <button key={location.id} type="button" className="platform-location-card" onClick={() => setSelectedLocation(location)}>
                  <strong>{location.name}</strong>
                  <span>{location.tag}</span>
                </button>
              ))}
            </div>
            {selectedLocation && (
              <div className="platform-modal-backdrop" onClick={() => setSelectedLocation(null)}>
                <div className="platform-modal" onClick={event => event.stopPropagation()}>
                  <button className="platform-icon-btn" type="button" onClick={() => setSelectedLocation(null)} title="关闭">x</button>
                  <h3>{selectedLocation.name}</h3>
                  <small>{selectedLocation.tag}</small>
                  <div className="platform-rich-text" dangerouslySetInnerHTML={{ __html: sanitizeHtmlFragment(selectedLocation.desc) }} />
                </div>
              </div>
            )}
          </div>
        )}

        {view === 'carousel' && selected && (
          <div className="platform-carousel-view">
            <button className="platform-icon-btn platform-nav-btn prev" type="button" onClick={() => setSelectedIndex((selectedIndex - 1 + schema.characters.length) % schema.characters.length)} title="上一个">‹</button>
            <div className="platform-carousel-strip">
              {schema.characters.map((character, index) => {
                const offset = index - selectedIndex;
                const wrapped = Math.abs(offset) > schema.characters.length / 2
                  ? offset - Math.sign(offset) * schema.characters.length
                  : offset;
                return (
                  <button
                    key={character.id}
                    type="button"
                    className={`platform-character-card ${index === selectedIndex ? 'active' : ''}`}
                    style={{
                      transform: `translateX(calc(${wrapped} * var(--platform-side-card-offset, 42%))) scale(${index === selectedIndex ? 1 : 'var(--platform-side-card-scale, 0.72)'})`,
                      opacity: Math.abs(wrapped) > 2 ? 0 : index === selectedIndex ? 1 : 'var(--platform-side-card-opacity, 0.45)',
                      zIndex: 20 - Math.abs(wrapped),
                    }}
                    onClick={() => index === selectedIndex ? selectCharacter(character.id) : setSelectedIndex(index)}
                  >
                    <img src={character.front} alt={character.name} />
                    <span>{character.name}</span>
                    <small>{character.title}</small>
                  </button>
                );
              })}
            </div>
            <button className="platform-icon-btn platform-nav-btn next" type="button" onClick={() => setSelectedIndex((selectedIndex + 1) % schema.characters.length)} title="下一个">›</button>
            <div className="platform-character-detail">
              {selected.avatar && <img src={selected.avatar} alt={selected.name} />}
              <h3>{selected.name}</h3>
              <div>{selected.sect} · {selected.title}</div>
              <p>{selected.desc}</p>
              <button type="button" className="platform-primary-btn" onClick={() => selectCharacter(selected.id)}>选定此缘</button>
            </div>
            <div className="platform-carousel-actions">
              <button type="button" onClick={randomize}>听凭天意</button>
              <button type="button" onClick={() => setShowFreeStart(true)}>自由开局</button>
            </div>
            {showFreeStart && (
              <div className="platform-modal-backdrop" onClick={() => setShowFreeStart(false)}>
                <div className="platform-modal" onClick={event => event.stopPropagation()}>
                  <button className="platform-icon-btn" type="button" onClick={() => setShowFreeStart(false)} title="关闭">x</button>
                  <h3>自由开局</h3>
                  <p>自由开局表单保留在原始沙盒模式中。平台 Schema 模式当前先覆盖轮盘开局。</p>
                  <button type="button" className="platform-primary-btn" onClick={() => setShowFreeStart(false)}>返回</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

type SandboxCardAction = {
  action: string;
  payload: any;
};

function SandboxHtmlRenderer({ html, onAction }: { html: string; onAction?: (action: SandboxCardAction) => void }) {
  const [height, setHeight] = useState(640);
  const frameIdRef = useRef(`sandbox-${Math.random().toString(36).slice(2)}`);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const documentHtml = React.useMemo(() => buildSandboxDocument(html), [html]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      if (event.data?.type === 'sandbox-resize') {
        const next = Number(event.data.height);
        if (Number.isFinite(next)) {
          setHeight(Math.max(360, Math.min(1800, next)));
        }
      }
      if (event.data?.type === 'card-sandbox-action' && typeof event.data.action === 'string') {
        const allowed = new Set(['applyGreeting', 'applyOpeningSwipe', 'readVariables', 'writeVariables', 'openStatusPanel', 'submitFreeStart', 'uiClick', 'formSubmit', 'setChatMessage', 'triggerSlash']);
        if (allowed.has(event.data.action)) {
          onAction?.({ action: event.data.action, payload: event.data.payload || {} });
        }
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onAction]);

  return (
    <div className="sandbox-renderer-shell" data-sandbox-id={frameIdRef.current}>
      <iframe
        className="sandbox-renderer-frame"
        title="角色卡 UI"
        sandbox="allow-scripts"
        ref={iframeRef}
        referrerPolicy="no-referrer"
        loading="lazy"
        style={{ height }}
        srcDoc={documentHtml}
      />
    </div>
  );
}

function MessageContent({
  content,
  card,
  variables,
  onSandboxAction,
  renderMode = 'auto',
}: {
  content: string;
  card: CharacterCard | null;
  variables: any;
  onSandboxAction?: (action: SandboxCardAction) => void;
  renderMode?: 'auto' | 'schema' | 'sandbox' | 'text';
}) {
  // Text mode: always plain formatted content
  if (renderMode === 'text') {
    return <>{renderCardFormattedContent(card, content)}</>;
  }

  const schema = buildStatusSchema(card);
  const marker = '<StatusPlaceHolderImpl/>';

  // Schema mode: status + platform + cover, but NO sandbox iframe
  if (renderMode === 'schema') {
    if (schema && content.includes(marker)) {
      const parts = content.split(marker);
      return (
        <>
          {parts.map((part, index) => (
            <React.Fragment key={index}>
              {cleanCardDisplayText(part).trim() && renderCardFormattedContent(card, part)}
              {index < parts.length - 1 && <CustomStatusRenderer schema={schema} variables={variables || {}} />}
            </React.Fragment>
          ))}
        </>
      );
    }
    const platformSchema = buildPlatformCardSchema(card, content);
    if (platformSchema) {
      const contentWithoutTrigger = cleanCardDisplayText(removeUiTriggers(card, content));
      return (
        <>
          <PlatformGameStartRenderer schema={platformSchema} onAction={onSandboxAction} />
          {contentWithoutTrigger && renderCardFormattedContent(card, contentWithoutTrigger)}
        </>
      );
    }
    const coverSchema = buildCoverMenuSchema(card, content);
    if (coverSchema) {
      const contentWithoutTrigger = cleanCardDisplayText(removeUiTriggers(card, content));
      return (
        <>
          <CoverMenuRenderer schema={coverSchema} />
          {contentWithoutTrigger && <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: CodeBlock }}>{contentWithoutTrigger}</ReactMarkdown>}
        </>
      );
    }
    // If complex UI detected but schema mode, show hint
    if (hasComplexCardUi(card)) {
      return (
        <>
          <div style={{ padding: '12px', color: '#A89BAD', fontSize: '13px', border: '1px dashed #3D2E4F', borderRadius: '8px', marginBottom: '8px' }}>
            Schema 模式下不渲染此角色卡的沙盒 UI。切换到 Auto 或 Sandbox 模式查看。
          </div>
          {renderCardFormattedContent(card, content)}
        </>
      );
    }
    return <>{renderCardFormattedContent(card, content)}</>;
  }

  // Sandbox mode: render the author's original UI first. Platform schema is only
  // a fallback when the card cannot provide runnable HTML for this message.
  if (renderMode === 'sandbox') {
    const sandboxHtml = getSandboxHtmlForContent(card, content);
    if (sandboxHtml) {
      const contentWithoutTrigger = cleanCardDisplayText(removeUiTriggers(card, content));
      return (
        <>
          <SandboxHtmlRenderer html={sandboxHtml} onAction={onSandboxAction} />
          {contentWithoutTrigger && renderCardFormattedContent(card, contentWithoutTrigger)}
        </>
      );
    }
    const platformSchema = buildPlatformCardSchema(card, content);
    if (platformSchema) {
      const contentWithoutTrigger = cleanCardDisplayText(removeUiTriggers(card, content));
      return (
        <>
          <PlatformGameStartRenderer schema={platformSchema} onAction={onSandboxAction} />
          {contentWithoutTrigger && renderCardFormattedContent(card, contentWithoutTrigger)}
        </>
      );
    }
    const coverSchema = buildCoverMenuSchema(card, content);
    if (coverSchema) {
      const contentWithoutTrigger = cleanCardDisplayText(removeUiTriggers(card, content));
      return (
        <>
          <CoverMenuRenderer schema={coverSchema} />
          {contentWithoutTrigger && <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: CodeBlock }}>{contentWithoutTrigger}</ReactMarkdown>}
        </>
      );
    }
    return <>{renderCardFormattedContent(card, content)}</>;
  }

  // Auto mode (default): status first, then author sandbox, then platform schema, then cover/text.
  // Status card takes priority over sandbox — the status-bar regex_script
  // contains <style>/<div>/<script> and would otherwise be mis-routed into
  // the iframe sandbox where SillyTavern globals (getChatMessages etc.) don't exist.
  if (schema && content.includes(marker)) {
    const parts = content.split(marker);
    return (
      <>
        {parts.map((part, index) => (
          <React.Fragment key={index}>
            {cleanCardDisplayText(part).trim() && (
              renderCardFormattedContent(card, part)
            )}
            {index < parts.length - 1 && (
              <CustomStatusRenderer schema={schema} variables={variables || {}} />
            )}
          </React.Fragment>
        ))}
      </>
    );
  }

  const sandboxHtml = getSandboxHtmlForContent(card, content);
  if (sandboxHtml) {
    const contentWithoutTrigger = cleanCardDisplayText(removeUiTriggers(card, content));
    return (
      <>
        <SandboxHtmlRenderer html={sandboxHtml} onAction={onSandboxAction} />
        {contentWithoutTrigger && renderCardFormattedContent(card, contentWithoutTrigger)}
      </>
    );
  }

  const platformSchema = buildPlatformCardSchema(card, content);
  if (platformSchema) {
    const contentWithoutTrigger = cleanCardDisplayText(removeUiTriggers(card, content));
    return (
      <>
        <PlatformGameStartRenderer schema={platformSchema} onAction={onSandboxAction} />
        {contentWithoutTrigger && renderCardFormattedContent(card, contentWithoutTrigger)}
      </>
    );
  }

  const coverSchema = buildCoverMenuSchema(card, content);
  if (coverSchema) {
    const contentWithoutTrigger = cleanCardDisplayText(removeUiTriggers(card, content));
    return (
      <>
        <CoverMenuRenderer schema={coverSchema} />
        {contentWithoutTrigger && (
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: CodeBlock }}>{contentWithoutTrigger}</ReactMarkdown>
        )}
      </>
    );
  }

  return (
    <>
      {renderCardFormattedContent(card, content)}
    </>
  );
}

function cleanCardDisplayText(content: string): string {
  return content
    .replace(/<StatusPlaceHolderImpl\/>/g, '')
    .replace(/<UpdateVariable(?:variable)?\b[^>]*>[\s\S]*?<\/UpdateVariable(?:variable)?>/gi, '')
    .replace(/<\/?正文>/g, '')
    .replace(/{{user}}/g, '你')
    .replace(/{{char}}/g, '')
    .replace(/<user>/g, '你')
    .replace(/<\/user>/g, '')
    .replace(/<char>/g, '')
    .replace(/<\/char>/g, '')
    .replace(/<\/?initvar>/gi, '')
    .replace(/<inner>([\s\S]*?)<\/inner>/gi, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function removeUiTriggers(card: CharacterCard | null, content: string): string {
  let output = content;
  for (const script of getRegexScripts(card)) {
    if (!script?.disabled && typeof script.findRegex === 'string' && !script.findRegex.startsWith('/')) {
      output = output.split(script.findRegex).join('');
    }
  }
  return output;
}

function renderInlineDecorators(content: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  const innerRegex = /<inner>([\s\S]*?)<\/inner>/gi;
  const source = content
    .replace(/<UpdateVariable(?:variable)?\b[^>]*>[\s\S]*?<\/UpdateVariable(?:variable)?>/gi, '')
    .replace(/<\/?正文>/g, '')
    .replace(/{{user}}/g, '你')
    .replace(/{{char}}/g, '')
    .replace(/<user>/g, '你')
    .replace(/<\/user>/g, '')
    .replace(/<char>/g, '')
    .replace(/<\/char>/g, '')
    .replace(/<\/?initvar>/gi, '');
  let match: RegExpExecArray | null;
  while ((match = innerRegex.exec(source)) !== null) {
    const before = source.slice(cursor, match.index);
    if (before.trim()) {
      parts.push(<ReactMarkdown key={`md-${cursor}`} remarkPlugins={[remarkGfm]} components={{ code: CodeBlock }}>{before}</ReactMarkdown>);
    }
    parts.push(<div key={`inner-${match.index}`} className="schema-inner-thought">{cleanCardDisplayText(match[1])}</div>);
    cursor = match.index + match[0].length;
  }
  const rest = source.slice(cursor);
  if (rest.trim() || parts.length === 0) {
    parts.push(<ReactMarkdown key={`md-rest-${cursor}`} remarkPlugins={[remarkGfm]} components={{ code: CodeBlock }}>{rest}</ReactMarkdown>);
  }
  return parts;
}

export default function Chat() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [sessionTitle, setSessionTitle] = useState('');
  const [config, setConfig] = useState<SessionConfig>({ ...DEFAULT_SESSION_CONFIG });
  const [configDirty, setConfigDirty] = useState(false);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [regenerateErrors, setRegenerateErrors] = useState<Record<string, string>>({});
  const [rawViewIds, setRawViewIds] = useState<Set<string>>(new Set());
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState('');
  const [recovering, setRecovering] = useState(false);
  const [failedContent, setFailedContent] = useState<string | null>(null);
  const [agentStatuses, setAgentStatuses] = useState<Array<{agent_type: string, label: string, status: string}>>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [memoryPending, setMemoryPending] = useState(false);
  const [sessionState, setSessionState] = useState<any>({});
  const [characterCard, setCharacterCard] = useState<CharacterCard | null>(null);
  const [selectedGreetingIndex, setSelectedGreetingIndex] = useState(-1);
  const [showVariableDebug, setShowVariableDebug] = useState(false);
  // Inspector panel
  const [inspectorOpen, setInspectorOpen] = useState(window.innerWidth > 900);
  const [inspectorTab, setInspectorTab] = useState<'params' | 'agents' | 'render' | 'user' | 'debug'>('params');
  const [paramsEditing, setParamsEditing] = useState(false);
  const [userEditing, setUserEditing] = useState(false);
  const [renderMode, setRenderMode] = useState<RenderMode>('auto');
  const [sandboxActionLog, setSandboxActionLog] = useState<Array<{time: number, action: string, payload: any}>>([]);
  const [userPersona, setUserPersona] = useState<UserPersona>({ name: '', avatar: '', address: '', background: '', style: '' });
  const [userPresets, setUserPresets] = useState<UserPersonaPreset[]>([]);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamTextRef = useRef('');
  const recoveringRef = useRef(false);
  const streamingRef = useRef(false);
  const memoryPendingRef = useRef(false);
  const recoverAbortRef = useRef<AbortController | null>(null);
  const initialMsgCountRef = useRef(0);
  const streamHadErrorRef = useRef(false);
  const inputLocked = streaming || recovering || memoryPending;
  const cardHasStatusRenderer = hasStatusRenderer(characterCard);
  const cardHasComplexUi = hasComplexCardUi(characterCard);
  const cardHasGameStart = isGameStartCard(characterCard);
  const debugPlatformSchema = buildPlatformCardSchema(characterCard, characterCard?.first_mes || '【GameStart】');
  const flatVariables = React.useMemo(
    () => flattenVariables(sessionState?.variables || {}),
    [sessionState?.variables],
  );

  function pendingKey() {
    return `pending_${sessionId}`;
  }

  function setPending(turnNumber: number) {
    localStorage.setItem(pendingKey(), JSON.stringify({ turnNumber, sentAt: Date.now() }));
  }

  function clearPending() {
    localStorage.removeItem(pendingKey());
  }

  function setMemoryBusy(value: boolean) {
    memoryPendingRef.current = value;
    setMemoryPending(value);
  }

  function getPending(): { turnNumber: number; sentAt: number } | null {
    try {
      const raw = localStorage.getItem(pendingKey());
      if (!raw) return null;
      const data = JSON.parse(raw);
      // Expire after 10 minutes
      if (Date.now() - data.sentAt > 10 * 60 * 1000) {
        clearPending();
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  async function startRecovery(initialMsgCount: number) {
    if (!getPending()) return;
    setRecovering(true);
    recoveringRef.current = true;
    initialMsgCountRef.current = initialMsgCount;

    const controller = new AbortController();
    recoverAbortRef.current = controller;

    try {
      const res = await api.reconnectStream(sessionId!, controller.signal);

      if (res.status === 404) {
        // No active turn — check if it already completed
        const data = await api.listMessages(sessionId!);
        if (data.items.length > initialMsgCount) {
          setMessages(data.items);
        }
        clearPending();
        stopRecovery();
        return;
      }

      if (!res.ok || !res.body) {
        stopRecovery();
        return;
      }

      // SSE stream connected — receive real-time agent_status + message_delta
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let currentEvent = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            const data = line.slice(6);
            try {
              const parsed = JSON.parse(data);
              if (currentEvent === 'agent_status') {
                if (parsed.status === 'working') {
                  setAgentStatuses(prev => [...prev.filter(s => s.agent_type !== parsed.agent_type), parsed]);
                } else {
                  setAgentStatuses(prev => prev.filter(s => s.agent_type !== parsed.agent_type));
                }
              }
              if (currentEvent === 'message_delta' && parsed.content) {
                setAgentStatuses([]);
                setStreamText(prev => {
                  const next = prev + parsed.content;
                  streamTextRef.current = next;
                  return next;
                });
              }
              if (currentEvent === 'stream_error') {
                setStreamError(parsed.error || '生成出现错误');
              }
              if (currentEvent === 'turn_end') {
                // Reload final messages
                const data = await api.listMessages(sessionId!);
                setMessages(data.items);
                setStreamText('');
                streamTextRef.current = '';
                setMemoryBusy(true);
              }
              if (currentEvent === 'memory_start') {
                setMemoryBusy(true);
              }
              if (currentEvent === 'memory_error') {
                setStreamError(parsed.error || '记忆整理失败，已允许继续');
              }
              if (currentEvent === 'turn_ready') {
                setMemoryBusy(false);
                clearPending();
                stopRecovery();
                return;
              }
            } catch { /* ignore parse errors */ }
          }
        }
      }

      // Stream closed without turn_end — turn likely finished, reload
      if (recoveringRef.current) {
        const data = await api.listMessages(sessionId!);
        if (data.items.length > initialMsgCountRef.current) {
          setMessages(data.items);
        }
        if (streamTextRef.current) {
          setStreamText('');
          streamTextRef.current = '';
        }
        clearPending();
        stopRecovery();
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        console.error('Recovery reconnect failed:', err);
        stopRecovery();
      }
    }
  }

  function stopRecovery() {
    recoverAbortRef.current?.abort();
    recoverAbortRef.current = null;
    setRecovering(false);
    recoveringRef.current = false;
    setMemoryBusy(false);
    setAgentStatuses([]);
    setStreamError(null);
  }

  useEffect(() => {
    if (!sessionId) return;
    loadMessages().then((loadedMessages) => {
      const pending = getPending();
      if (pending) {
        const msgCount = loadedMessages?.length ?? 0;
        startRecovery(msgCount);
      }
    });
    loadSession();
    loadSessionState();
    setUserPresets(loadUserPersonaPresets());
    return () => {
      stopRecovery();
    };
  }, [sessionId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamText]);

  async function loadSession() {
    try {
      const session = await api.getSession(sessionId!);
      setSessionTitle(session.title || '未命名会话');
      if (session.world_pack_id) {
        loadCharacterCard(session.world_pack_id);
      } else {
        setCharacterCard(null);
      }
      if (session.config) {
        const nextConfig = normalizeSessionConfig(session.config);
        setConfig(nextConfig);
        setRenderMode(nextConfig.render_mode);
        setUserPersona(nextConfig.user_persona);
        setConfigDirty(false);
      }
    } catch (err) {
      console.error('Failed to load session:', err);
    }
  }

  async function loadCharacterCard(worldBookId: string) {
    try {
      const card = await api.getWorldBookCharacterCard(worldBookId);
      setCharacterCard(card);
      setSelectedGreetingIndex(-1);
    } catch (err) {
      setCharacterCard(null);
      setSelectedGreetingIndex(-1);
      console.error('Failed to load character card:', err);
    }
  }

  async function loadMessages(): Promise<Message[] | undefined> {
    try {
      const data = await api.listMessages(sessionId!);
      setMessages(data.items);
      return data.items;
    } catch (err) {
      console.error('Failed to load messages:', err);
      return undefined;
    }
  }

  async function loadSessionState() {
    try {
      const value = await api.getSessionState(sessionId!);
      setSessionState(value || {});
    } catch (err) {
      console.error('Failed to load session state:', err);
    }
  }

  async function persistConfig(nextConfig: SessionConfig) {
    try {
      const updated = await api.updateSession(sessionId!, { config: normalizeSessionConfig(nextConfig) });
      const savedConfig = normalizeSessionConfig(updated.config);
      setConfig(savedConfig);
    setRenderMode(savedConfig.render_mode);
    setUserPersona(savedConfig.user_persona);
      setConfigDirty(false);
    } catch (err) {
      console.error('Failed to save config:', err);
    }
  }

  async function saveConfig() {
    await persistConfig({
      ...config,
      render_mode: renderMode,
      user_persona: userPersona,
    });
  }

  function updateConfig<K extends keyof SessionConfig>(key: K, value: SessionConfig[K]) {
    setConfig(prev => ({ ...prev, [key]: value }));
    setConfigDirty(true);
  }

  function updateRenderMode(value: RenderMode) {
    setRenderMode(normalizeRenderMode(value));
    setConfigDirty(true);
  }

  function updateUserPersona(key: keyof UserPersona, value: string) {
    setUserPersona(prev => ({ ...prev, [key]: value }));
    setConfigDirty(true);
  }

  function updateUserSettingMergeStrategy(value: UserSettingMergeStrategy) {
    updateConfig('user_setting_merge_strategy', value);
  }

  async function applyUserPersonaPreset(value: string) {
    if (!value) return;
    const persona = value === 'global'
      ? loadGlobalSessionDefaults().user_persona
      : userPresets.find(p => p.id === value)?.persona;
    if (!persona) return;

    const nextConfig = normalizeSessionConfig({
      ...config,
      render_mode: renderMode,
      user_persona: persona,
    });
    setUserPersona(persona);
    setConfig(nextConfig);
    setConfigDirty(true);
    await persistConfig(nextConfig);
  }

  async function applyGlobalDefaultsToSession() {
    const nextConfig = loadGlobalSessionDefaults();
    setConfig(nextConfig);
    setRenderMode(nextConfig.render_mode);
    setUserPersona(nextConfig.user_persona);
    try {
      const updated = await api.updateSession(sessionId!, { config: nextConfig });
      const savedConfig = normalizeSessionConfig(updated.config);
      setConfig(savedConfig);
      setRenderMode(savedConfig.render_mode);
      setUserPersona(savedConfig.user_persona);
      setConfigDirty(false);
    } catch (err) {
      console.error('Failed to apply global defaults:', err);
    }
  }

  function saveCurrentSessionAsGlobalDefaults() {
    saveGlobalSessionDefaults({
      ...config,
      render_mode: renderMode,
      user_persona: userPersona,
    });
  }

  async function handleSend(overrideContent?: string) {
    const content = overrideContent ?? input.trim();
    if (!content || streaming || recovering || memoryPending) return;
    setFailedContent(null);
    setStreamError(null);
    streamHadErrorRef.current = false;
    setMemoryBusy(false);

    if (configDirty) {
      await saveConfig();
    }

    const userMsg: Message = {
      id: `temp-${Date.now()}`,
      session_id: sessionId!,
      turn_number: messages.length + 1,
      role: 'user',
      content,
      variants: '[]',
      variant_index: -1,
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setStreaming(true);
    streamingRef.current = true;
    setStreamText('');
    streamTextRef.current = '';
    stopRecovery();
    setPending(messages.length + 1);

    abortRef.current = api.sendMessageStream(
      sessionId!,
      content,
      (event, data) => {
        if (event === 'agent_status') {
          if (data.status === 'working') {
            setAgentStatuses(prev => [...prev.filter(s => s.agent_type !== data.agent_type), data]);
          } else {
            setAgentStatuses(prev => prev.filter(s => s.agent_type !== data.agent_type));
          }
        }
        if (event === 'message_delta' && data.content) {
          setAgentStatuses([]);
          setStreamError(null);
          streamHadErrorRef.current = false;
          setStreamText(prev => {
            const next = prev + data.content;
            streamTextRef.current = next;
            return next;
          });
        }
        if (event === 'stream_error') {
          streamHadErrorRef.current = true;
          setStreamError(data.error || '生成出现错误，正在重试...');
        }
        if (event === 'memory_start') {
          setMemoryBusy(true);
        }
        if (event === 'memory_error') {
          setStreamError(data.error || '记忆整理失败，已允许继续');
        }
        if (event === 'turn_end') {
          if (streamHadErrorRef.current) return;
          setAgentStatuses([]);
          setStreamError(null);
          const content = streamTextRef.current || data.message_content;
          const assistantMsg: Message = {
            id: `assistant-${Date.now()}`,
            session_id: sessionId!,
            turn_number: data.turn_number,
            role: 'assistant',
            content,
            variants: '[]',
            variant_index: -1,
            created_at: new Date().toISOString(),
          };
          setMessages(prev => [...prev, assistantMsg]);
          setStreamText('');
          streamTextRef.current = '';
          setMemoryBusy(true);
          // Refresh session title after first turn (auto-generated title via background LLM call)
          if (data.turn_number === 1) {
            (async () => {
              for (let i = 0; i < 10; i++) {
                await new Promise(r => setTimeout(r, 2000));
                try {
                  const s = await api.getSession(sessionId!);
                  if (s.title) {
                    setSessionTitle(s.title);
                    return;
                  }
                } catch {}
              }
            })();
          }
        }
        if (event === 'turn_ready') {
          setAgentStatuses([]);
          setMemoryBusy(false);
          setStreaming(false);
          streamingRef.current = false;
          clearPending();
          loadSessionState();
        }
      },
      (error) => {
        console.error('Stream error:', error);
        setStreaming(false);
        streamingRef.current = false;
        setMemoryBusy(false);
        setStreamText('');
        setAgentStatuses([]);
        clearPending();
        setFailedContent(content);
      },
      () => {
        // Always clear streaming state — safety net for when backend fails silently
        const wasStreaming = streamingRef.current;
        streamingRef.current = false;
        setStreaming(false);
        setMemoryBusy(false);
        setAgentStatuses([]);

        if (wasStreaming) {
          clearPending();
        }

        if (streamHadErrorRef.current) {
          setFailedContent(content);
          setStreamText('');
          streamTextRef.current = '';
          streamHadErrorRef.current = false;
          return;
        }

        // Only show final assistant content after backend confirmation.
        if (streamTextRef.current) {
          void loadMessages();
          setStreamText('');
          streamTextRef.current = '';
        }
      },
      config.stream,
    );
  }

  async function handleApplyGreeting() {
    const greeting = selectedGreetingText();
    await applyOpeningContent(greeting, '应用开场白失败');
  }

  async function applyOpeningContent(greeting: string, errorMessage: string) {
    const content = cardHasStatusRenderer && !greeting.includes('<StatusPlaceHolderImpl/>')
      ? `${greeting.trim()}\n\n<StatusPlaceHolderImpl/>`
      : greeting;
    if (!content || inputLocked || !sessionId) return;
    try {
      const opening = await api.applyOpeningMessage(sessionId, content);
      setMessages(prev => {
        const withoutOpening = prev.filter(msg => !(msg.turn_number === 0 && msg.role === 'assistant'));
        return [opening, ...withoutOpening].sort((a, b) => {
          if (a.turn_number !== b.turn_number) return a.turn_number - b.turn_number;
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        });
      });
      loadSessionState();
      setStreamError(null);
    } catch (err) {
      setStreamError(err instanceof Error ? err.message : errorMessage);
    }
  }

  async function applyOpeningSwipe(swipeId: number) {
    if (!characterCard) return;
    const index = swipeId - 1;
    const greeting = index >= 0
      ? characterCard.alternate_greetings[index]
      : characterCard.first_mes;
    if (!greeting) {
      setStreamError(`找不到开场白 swipe ${swipeId}`);
      return;
    }
    setSelectedGreetingIndex(index);
    await applyOpeningContent(greeting, '切换开场白失败');
  }

  function handleSandboxAction(event: SandboxCardAction) {
    // Log sandbox actions for debug tab
    setSandboxActionLog(prev => [{ time: Date.now(), action: event.action, payload: event.payload }, ...prev].slice(0, 20));
    if (event.action === 'openStatusPanel') {
      setShowVariableDebug(true);
      return;
    }
    if (event.action === 'applyGreeting') {
      const index = Number(event.payload?.index);
      if (Number.isInteger(index)) {
        setSelectedGreetingIndex(index);
      }
      return;
    }
    if (event.action === 'applyOpeningSwipe') {
      const swipeId = Number(event.payload?.swipeId);
      if (Number.isInteger(swipeId)) {
        applyOpeningSwipe(swipeId);
      }
      return;
    }
    if (event.action === 'submitFreeStart' || event.action === 'formSubmit') {
      const values = event.payload && typeof event.payload === 'object'
        ? Object.entries(event.payload)
            .filter(([, value]) => String(value ?? '').trim())
            .map(([key, value]) => `${key}: ${String(value).trim()}`)
        : [];
      if (values.length > 0) {
        setInput(prev => prev || values.join('\n'));
      }
      return;
    }
    if (event.action === 'setChatMessage') {
      const message = String(event.payload?.message || '').trim();
      const swipeId = Number(event.payload?.swipeId);
      if (Number.isInteger(swipeId)) {
        applyOpeningSwipe(swipeId);
        return;
      }
      if (message) {
        setInput(message);
      }
      return;
    }
    if (event.action === 'triggerSlash') {
      console.debug('Card sandbox slash command:', event.payload);
      return;
    }
    if (event.action === 'uiClick') {
      console.debug('Card sandbox click:', event.payload);
    }
  }

  async function handleRetry() {
    if (!failedContent || streaming || memoryPending) return;
    // Remove the failed user message (last user message with matching content)
    setMessages(prev => {
      const idx = [...prev].reverse().findIndex(m => m.role === 'user' && m.content === failedContent);
      if (idx === -1) return prev;
      const realIdx = prev.length - 1 - idx;
      return prev.filter((_, i) => i !== realIdx);
    });
    setInput('');
    handleSend(failedContent);
  }

  async function handleRegenerate(msgId: string) {
    if (streaming || memoryPending || regeneratingId) return;
    setRegeneratingId(msgId);
    setRegenerateErrors(prev => {
      const next = { ...prev };
      delete next[msgId];
      return next;
    });
    try {
      const result = await api.regenerateMessage(sessionId!, msgId);
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, content: result.content, variants: result.variants, variant_index: -1 } : m
      ));
    } catch (err) {
      console.error('Regenerate failed:', err);
      setRegenerateErrors(prev => ({
        ...prev,
        [msgId]: err instanceof Error ? err.message : '重新生成失败',
      }));
    } finally {
      setRegeneratingId(null);
    }
  }

  async function handleSwitchVariant(msgId: string, index: number) {
    if (streaming || memoryPending || regeneratingId) return;
    try {
      const result = await api.switchVariant(sessionId!, msgId, index);
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, content: result.content, variants: result.variants, variant_index: result.variant_index } : m
      ));
    } catch (err) {
      console.error('Switch variant failed:', err);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function getVariants(msg: Message): string[] {
    try { return JSON.parse(msg.variants || '[]'); } catch { return []; }
  }

  function toggleRawView(msgId: string) {
    setRawViewIds(prev => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId);
      else next.add(msgId);
      return next;
    });
  }

  function handleCopyMsg(msgId: string, content: string) {
    navigator.clipboard.writeText(content);
    setCopiedMsgId(msgId);
    setTimeout(() => setCopiedMsgId(null), 1500);
  }

  function flattenVariables(value: any, prefix = ''): Array<{ key: string; value: any }> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return [];
    }

    const rows: Array<{ key: string; value: any }> = [];
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        rows.push(...flattenVariables(child, path));
      } else {
        rows.push({ key: path, value: child });
      }
    }
    return rows;
  }

  function formatVariableValue(value: any): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value == null) return 'null';
    return JSON.stringify(value);
  }

  function shortText(value: string, max = 180): string {
    const text = value.trim();
    if (text.length <= max) return text;
    return `${text.slice(0, max)}...`;
  }

  function selectedGreetingText(): string {
    if (!characterCard) return '';
    if (selectedGreetingIndex >= 0) {
      return characterCard.alternate_greetings[selectedGreetingIndex] || '';
    }
    return characterCard.first_mes || '';
  }

  function greetingLabel(text: string, fallback: string): string {
    const boldTitle = text.match(/\*\*([^*]+)\*\*/)?.[1];
    if (boldTitle) return boldTitle;
    const triggerLine = text.split(/\r?\n/).map(line => line.trim()).find(line =>
      /^【[^】]{1,40}】$/.test(line)
    );
    if (triggerLine) return triggerLine;
    const cleaned = cleanCardDisplayText(text)
      .replace(/<inner>[\s\S]*?<\/inner>/gi, '')
      .trim();
    const titleLine = cleaned.split(/\r?\n/).map(line => line.trim()).find(line =>
      line
        && !line.startsWith('<')
        && !line.startsWith('{{')
        && !line.startsWith('（')
        && line.length <= 64
        && /(?:开场|方向|GameStart|卷首|地志|轮盘)/i.test(line)
    );
    if (titleLine) return shortText(titleLine, 42);
    const dialogueLine = cleaned.match(/【([^】]{1,24})】\s*[：:]/)?.[1];
    if (dialogueLine) return `${fallback} · ${dialogueLine}`;
    const settingLine = cleaned.split(/\r?\n/).map(line => line.trim()).find(line =>
      line && !line.startsWith('<') && !line.startsWith('{{') && line.length <= 42
    );
    if (settingLine) return shortText(settingLine, 42);
    const firstLine = cleaned.split(/\r?\n/).map(line => line.trim()).find(Boolean);
    return firstLine ? shortText(firstLine, 42) : fallback;
  }

  function handleEdit(msgId: string, content: string) {
    setEditingId(msgId);
    setEditContent(content);
  }

  async function handleSaveEdit(msgId: string) {
    const content = editContent.trim();
    if (!content) return;
    try {
      const result = await api.editMessage(sessionId!, msgId, content);
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, content: result.content, variants: result.variants, variant_index: result.variant_index } : m
      ));
    } catch (err) {
      console.error('Edit failed:', err);
    }
    setEditingId(null);
    setEditContent('');
  }

  function handleCancelEdit() {
    setEditingId(null);
    setEditContent('');
  }

  async function handleDelete(msgId: string) {
    if (!confirm('确定删除这条消息？')) return;
    try {
      await api.deleteMessage(sessionId!, msgId);
      setMessages(prev => prev.filter(m => m.id !== msgId));
    } catch (err) {
      console.error('Delete failed:', err);
    }
  }

  function startRename() {
    setTitleInput(sessionTitle);
    setEditingTitle(true);
    setTimeout(() => titleInputRef.current?.select(), 0);
  }

  async function commitRename() {
    const newTitle = titleInput.trim();
    setEditingTitle(false);
    if (newTitle && newTitle !== sessionTitle) {
      setSessionTitle(newTitle);
      try {
        await api.updateSession(sessionId!, { title: newTitle });
      } catch (err) {
        console.error('Failed to rename session:', err);
      }
    }
  }

  return (
    <div className={`chat-layout${inspectorOpen ? ' inspector-open' : ''}`}>
    <div className="chat-main">
    <div className="chat">
      <div className="chat-header">
        <button className="back-btn" onClick={() => navigate('/')}>返回</button>
        <div className="header-user-entry" onClick={() => { setInspectorTab('user'); setInspectorOpen(true); }}>
          {userPersona.name || '默认用户'}
        </div>
        {editingTitle ? (
          <input
            ref={titleInputRef}
            className="title-edit-input"
            value={titleInput}
            onChange={e => setTitleInput(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditingTitle(false); }}
            autoFocus
          />
        ) : (
          <h2 className="title-clickable" onClick={startRename} title="点击重命名">{sessionTitle || '未命名会话'}</h2>
        )}
        <div className="header-spacer" />
        <button
          className={`config-toggle ${inspectorOpen ? 'active' : ''}`}
          onClick={() => setInspectorOpen(!inspectorOpen)}
        >
          ☰
        </button>
      </div>

      {characterCard && (
        <div className="chat-card-panel">
          <div className="chat-card-avatar">
            {characterCard.avatar && characterCard.avatar !== 'none'
              ? <img src={characterCard.avatar} alt={characterCard.name} />
              : <span>{characterCard.name.charAt(0)}</span>
            }
          </div>
          <div className="chat-card-main">
            <div className="chat-card-header">
              <div>
                <div className="chat-card-name">{characterCard.name}</div>
                {(characterCard.creator || characterCard.character_version) && (
                  <div className="chat-card-meta">
                    {[characterCard.creator, characterCard.character_version && `v${characterCard.character_version}`]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                )}
              </div>
              {(characterCard.first_mes || characterCard.alternate_greetings.length > 0) && (
                <div className="chat-card-greeting-controls">
                  {characterCard.alternate_greetings.length > 0 && (
                    <select
                      className="chat-card-greeting-select"
                      value={selectedGreetingIndex}
                      onChange={e => setSelectedGreetingIndex(Number(e.target.value))}
                      disabled={inputLocked}
                    >
                      {characterCard.first_mes && (
                        <option value={-1}>{greetingLabel(characterCard.first_mes, '主开场白')}</option>
                      )}
                      {characterCard.alternate_greetings.map((greeting, index) => (
                        <option key={index} value={index}>
                          {greetingLabel(greeting, `可选开场白 ${index + 1}`)}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    className="chat-card-greeting-btn"
                    disabled={inputLocked || !selectedGreetingText()}
                    onClick={handleApplyGreeting}
                  >
                    {cardHasGameStart && selectedGreetingIndex === -1 ? '打开角色卡首页' : '应用开场白'}
                  </button>
                </div>
              )}
            </div>
            {characterCard.tags.length > 0 && (
              <div className="chat-card-tags">
                {characterCard.tags.slice(0, 8).map((tag, index) => (
                  <span key={`${tag}-${index}`}>{tag}</span>
                ))}
              </div>
            )}
            {!cardHasComplexUi && (characterCard.description || characterCard.personality || characterCard.scenario) && (
              <div className="chat-card-summary">
                {characterCard.description && <p>{shortText(characterCard.description)}</p>}
                {characterCard.personality && <p>{shortText(characterCard.personality)}</p>}
                {characterCard.scenario && <p>{shortText(characterCard.scenario)}</p>}
              </div>
            )}
          </div>
        </div>
      )}

      {sessionState?.variables && !cardHasStatusRenderer && flatVariables.length > 0 && (
        <details
          className={`status-panel ${cardHasComplexUi ? 'debug' : ''}`}
          open={!cardHasComplexUi || showVariableDebug}
          onToggle={(event) => {
            if (cardHasComplexUi) setShowVariableDebug(event.currentTarget.open);
          }}
        >
          <summary className="status-panel-header">
            <span>{cardHasComplexUi ? `变量调试 (${flatVariables.length})` : '状态变量'}</span>
            <button className="status-refresh-btn" onClick={(event) => { event.preventDefault(); loadSessionState(); }}>刷新</button>
          </summary>
          {(!cardHasComplexUi || showVariableDebug) && (
            <div className="status-grid">
              {flatVariables.slice(0, cardHasComplexUi ? 12 : 24).map(item => (
                <div className="status-var" key={item.key}>
                  <span className="status-var-key">{item.key}</span>
                  <span className="status-var-value">{formatVariableValue(item.value)}</span>
                </div>
              ))}
            </div>
          )}
        </details>
      )}

      <div className="messages">
        {messages.map(msg => {
          const isRaw = rawViewIds.has(msg.id);
          const isEditing = editingId === msg.id;
          const roleLabel = msg.role === 'user'
            ? '你'
            : msg.turn_number === 0 && characterCard
              ? characterCard.name
              : '助手';
          return (
            <div key={msg.id} className={`message ${msg.role}`}>
              <div className="message-role">{roleLabel}</div>
              {isEditing ? (
                <div className="edit-area">
                  <textarea
                    className="edit-textarea"
                    value={editContent}
                    onChange={e => setEditContent(e.target.value)}
                    rows={4}
                    autoFocus
                  />
                  <div className="edit-actions">
                    <button className="action-btn" onClick={() => handleSaveEdit(msg.id)}>保存</button>
                    <button className="action-btn" onClick={handleCancelEdit}>取消</button>
                  </div>
                </div>
              ) : (
                <div className="message-content">
                  {msg.role === 'assistant' ? (
                    isRaw ? (
                      <pre className="msg-raw">{msg.content}</pre>
                    ) : (
                      <MessageContent
                        content={msg.content}
                        card={characterCard}
                        variables={sessionState?.variables || {}}
                        onSandboxAction={handleSandboxAction}
                        renderMode={renderMode}
                      />
                    )
                  ) : (
                    cleanCardDisplayText(msg.content)
                  )}
                </div>
              )}
              {!isEditing && msg.role === 'user' && (
                <div className="message-actions">
                  {failedContent === msg.content && (
                    <span className="send-failed-badge">发送失败</span>
                  )}
                  <button
                    className="action-btn"
                    onClick={() => handleEdit(msg.id, msg.content)}
                    title="编辑"
                  >
                    编辑
                  </button>
                  {failedContent === msg.content && (
                    <button
                      className="action-btn retry-btn"
                      onClick={handleRetry}
                      disabled={inputLocked}
                      title="重新发送"
                    >
                      重新发送
                    </button>
                  )}
                  <button
                    className="action-btn delete-btn"
                    onClick={() => handleDelete(msg.id)}
                    title="删除"
                  >
                    删除
                  </button>
                </div>
              )}
              {!isEditing && msg.role === 'assistant' && (() => {
                const variants = getVariants(msg);
                const total = variants.length + 1;
                const activeIndex = msg.variant_index;
                const displayPos = activeIndex === -1 ? total : activeIndex + 1;
                return (
                  <div className="message-actions">
                    {regenerateErrors[msg.id] && (
                      <span className="send-failed-badge">{regenerateErrors[msg.id]}</span>
                    )}
                    <button
                      className="action-btn"
                      onClick={() => toggleRawView(msg.id)}
                      title={isRaw ? '预览' : '源码'}
                    >
                      {isRaw ? '预览' : '源码'}
                    </button>
                    <button
                      className="action-btn"
                      onClick={() => handleCopyMsg(msg.id, msg.content)}
                      title="复制"
                    >
                      {copiedMsgId === msg.id ? '已复制' : '复制'}
                    </button>
                    <button
                      className="action-btn regenerate-btn"
                      onClick={() => handleRegenerate(msg.id)}
                      disabled={!!regeneratingId || inputLocked}
                      title="重新生成"
                    >
                      {regeneratingId === msg.id ? '生成中...' : '重新生成'}
                    </button>
                    <button
                      className="action-btn"
                      onClick={() => handleEdit(msg.id, msg.content)}
                      disabled={!!regeneratingId || inputLocked}
                      title="编辑"
                    >
                      编辑
                    </button>
                    <button
                      className="action-btn delete-btn"
                      onClick={() => handleDelete(msg.id)}
                      disabled={!!regeneratingId || inputLocked}
                      title="删除"
                    >
                      删除
                    </button>
                    {total > 1 && (
                      <div className="variant-nav">
                        <button
                          className="action-btn variant-btn"
                          onClick={() => handleSwitchVariant(msg.id, activeIndex === -1 ? variants.length - 1 : activeIndex - 1)}
                          disabled={activeIndex === 0 || !!regeneratingId || inputLocked}
                          title="上一个版本"
                        >
                          {'<'}
                        </button>
                        <span className="variant-count">{displayPos} / {total}</span>
                        <button
                          className="action-btn variant-btn"
                          onClick={() => handleSwitchVariant(msg.id, activeIndex >= variants.length - 1 ? -1 : activeIndex + 1)}
                          disabled={activeIndex === -1 || !!regeneratingId || inputLocked}
                          title="下一个版本"
                        >
                          {'>'}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          );
        })}
        {agentStatuses.length > 0 && (
          <div className="message assistant streaming">
            <div className="message-role">进度</div>
            <div className="message-content agent-status-list">
              {agentStatuses.map((s, i) => (
                <div key={`${s.agent_type}-${i}`} className="agent-status-item">
                  <span className="agent-status-dot" />
                  <span>{s.label} 正在工作中...</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {streamError && streaming && (
          <div className="message assistant streaming">
            <div className="message-role">助手</div>
            <div className="message-content">
              <span className="stream-error-indicator">{streamError}</span>
            </div>
          </div>
        )}
        {streamText && (
          <div className="message assistant streaming">
            <div className="message-role">助手</div>
            <div className="message-content">
              <MessageContent
                content={streamText}
                card={characterCard}
                variables={sessionState?.variables || {}}
                onSandboxAction={handleSandboxAction}
                renderMode={renderMode}
              />
            </div>
          </div>
        )}
        {memoryPending && (
          <div className="message assistant streaming">
            <div className="message-role">进度</div>
            <div className="message-content">
              <span className="recovering-indicator">正在整理记忆...</span>
            </div>
          </div>
        )}
        {(streaming || recovering) && !streamText && agentStatuses.length === 0 && !streamError && !memoryPending && (
          <div className="message assistant streaming">
            <div className="message-role">助手</div>
            <div className="message-content">
              <span className="recovering-indicator">正在处理中...</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="input-area">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={memoryPending ? '正在整理记忆...' : recovering ? '等待后端响应中...' : '输入消息...'}
          rows={3}
          disabled={inputLocked}
        />
        <button onClick={() => handleSend()} disabled={inputLocked || !input.trim()}>
          {memoryPending ? '整理中...' : streaming ? '发送中...' : recovering ? '等待中...' : '发送'}
        </button>
      </div>
    </div>
    </div>{/* .chat-main */}

    {/* Narrow-screen backdrop */}
    {inspectorOpen && <div className="inspector-backdrop" onClick={() => setInspectorOpen(false)} />}

    <nav className="inspector-rail" aria-label="工作区工具栏">
      {([
        ['params', '参数', '参'],
        ['agents', 'Agents', 'Ag'],
        ['render', '渲染', '渲'],
        ['user', 'User', '人'],
        ['debug', '调试', '试'],
      ] as const).map(([key, label, icon]) => (
        <button
          key={key}
          className={`inspector-rail-btn${inspectorTab === key ? ' active' : ''}`}
          title={label}
          onClick={() => {
            setInspectorTab(key);
            setInspectorOpen(current => inspectorTab === key ? !current : true);
          }}
        >
          <span>{icon}</span>
          <small>{label}</small>
        </button>
      ))}
    </nav>

    <aside className={`inspector${inspectorOpen ? ' inspector--open' : ''}`}>
      <div className="inspector-titlebar">
        <strong>{({ params: '参数', agents: 'Agents', render: '渲染', user: 'User', debug: '调试' } as const)[inspectorTab]}</strong>
        <button type="button" onClick={() => setInspectorOpen(false)} title="关闭">×</button>
      </div>
      <div className="inspector-content">

        {/* ===== 参数 Tab ===== */}
        {inspectorTab === 'params' && (
          <>
            <div className="inspector-section">
              <div className="inspector-section-title">会话覆盖</div>
              <p className="inspector-hint">本页设置只影响当前会话；新会话会复制首页全局默认。</p>
              <div className="inspector-action-stack">
                <button className="inspector-btn primary" onClick={saveConfig} disabled={!configDirty}>保存当前会话设置</button>
                <button className="inspector-btn" onClick={applyGlobalDefaultsToSession}>恢复全局默认</button>
                <button className="inspector-btn" onClick={saveCurrentSessionAsGlobalDefaults}>保存为全局模板</button>
              </div>
            </div>
            <div className="inspector-section">
              <div className="inspector-section-title">模型参数</div>
              {!paramsEditing ? (
                <>
                  <div className="inspector-summary-grid">
                    <div className="summary-metric"><span>Temp</span><strong>{config.temperature}</strong></div>
                    <div className="summary-metric"><span>Top P</span><strong>{config.top_p}</strong></div>
                    <div className="summary-metric"><span>Token</span><strong>{config.max_tokens}</strong></div>
                    <div className="summary-metric"><span>上下文</span><strong>{config.max_context_turns}</strong></div>
                  </div>
                  <div className="debug-row"><span className="debug-key">流式输出</span><span className="debug-value">{config.stream ? '开启' : '关闭'}</span></div>
                  <div className="debug-row"><span className="debug-key">系统提示词</span><span className="debug-value">{config.system_prompt?.trim() ? '已自定义' : '默认'}</span></div>
                  <button className="inspector-btn primary full-width" onClick={() => setParamsEditing(true)}>编辑参数</button>
                </>
              ) : (
                <>
                  <div className="config-grid">
                    <div className="config-field"><label>上下文轮数</label><input type="number" value={config.max_context_turns} onChange={e => updateConfig('max_context_turns', Number(e.target.value))} min={1} max={200} /></div>
                    <div className="config-field"><label>Temperature</label><input type="number" value={config.temperature} onChange={e => updateConfig('temperature', Number(e.target.value))} min={0} max={2} step={0.1} /></div>
                    <div className="config-field"><label>Top P</label><input type="number" value={config.top_p} onChange={e => updateConfig('top_p', Number(e.target.value))} min={0} max={1} step={0.05} /></div>
                    <div className="config-field"><label>最大 Token</label><input type="number" value={config.max_tokens} onChange={e => updateConfig('max_tokens', Number(e.target.value))} min={1} max={128000} /></div>
                    <div className="config-field"><label>频率惩罚</label><input type="number" value={config.frequency_penalty} onChange={e => updateConfig('frequency_penalty', Number(e.target.value))} min={-2} max={2} step={0.1} /></div>
                    <div className="config-field"><label>存在惩罚</label><input type="number" value={config.presence_penalty} onChange={e => updateConfig('presence_penalty', Number(e.target.value))} min={-2} max={2} step={0.1} /></div>
                  </div>
                  <div className="config-field"><label>流式输出</label><button type="button" className={`toggle-btn ${config.stream ? 'on' : 'off'}`} onClick={() => updateConfig('stream', !config.stream)}>{config.stream ? '开启' : '关闭'}</button></div>
                </>
              )}
            </div>
            {paramsEditing && (
              <>
                <div className="inspector-section">
                  <div className="inspector-section-title">系统提示词</div>
                  <div className="config-field"><textarea value={config.system_prompt} onChange={e => updateConfig('system_prompt', e.target.value)} placeholder="留空使用默认提示词" rows={4} /></div>
                </div>
                <div className="config-actions">
                  {configDirty && <span className="config-dirty">未保存</span>}
                  <button className="inspector-btn primary" onClick={() => { saveConfig(); setParamsEditing(false); }} disabled={!configDirty}>保存</button>
                  <button className="inspector-btn" onClick={() => setParamsEditing(false)}>完成</button>
                  <button className="inspector-btn" onClick={() => { setConfig({ ...DEFAULT_SESSION_CONFIG }); setConfigDirty(true); }}>恢复默认</button>
                </div>
              </>
            )}
          </>
        )}

        {/* ===== Agents Tab ===== */}
        {inspectorTab === 'agents' && (
          <div className="inspector-section">
            <div className="inspector-section-title">Agent 管理</div>
            <p style={{ fontSize: '13px', color: 'var(--text-3)', marginBottom: '12px' }}>管理此会话的多 Agent 角色、调度策略和状态。</p>
            <button className="inspector-btn primary" onClick={() => navigate(`/chat/${sessionId}/agents`)}>打开 Agent 管理</button>
          </div>
        )}

        {/* ===== 渲染 Tab ===== */}
        {inspectorTab === 'render' && (
          <>
            <div className="inspector-section">
              <div className="inspector-section-title">渲染模式</div>
              <div className="render-mode-group">
                {([['auto','Auto','作者原始 UI 优先，失败走平台兜底'],['schema','Schema','只用平台 Schema，不执行原始 JS'],['sandbox','Sandbox','优先执行作者原始沙盒 UI'],['text','Text','纯文本，无 UI 渲染']] as const).map(([mode, label, desc]) => (
                  <label key={mode} className={`render-mode-option${renderMode === mode ? ' selected' : ''}`}>
                    <input type="radio" name="renderMode" value={mode} checked={renderMode === mode} onChange={() => updateRenderMode(mode)} />
                    <div><div className="render-mode-label">{label}</div><div className="render-mode-desc">{desc}</div></div>
                  </label>
                ))}
              </div>
            </div>
            <div className="inspector-section">
              <div className="inspector-section-title">角色卡检测</div>
              <div className="debug-row"><span className="debug-key">状态栏 Renderer</span><span className="debug-value">{cardHasStatusRenderer ? '✓' : '—'}</span></div>
              <div className="debug-row"><span className="debug-key">复杂角色卡 UI</span><span className="debug-value">{cardHasComplexUi ? '✓' : '—'}</span></div>
              <div className="debug-row"><span className="debug-key">GameStart</span><span className="debug-value">{cardHasGameStart ? '✓' : '—'}</span></div>
            </div>
            {debugPlatformSchema && (
              <div className="inspector-section">
                <div className="inspector-section-title">平台布局</div>
                <div className="debug-row"><span className="debug-key">主卡宽度</span><span className="debug-value">{debugPlatformSchema.layout.mainCardWidth}px</span></div>
                <div className="debug-row"><span className="debug-key">舞台高度</span><span className="debug-value">{debugPlatformSchema.layout.stageMinHeight}px</span></div>
                <div className="debug-row"><span className="debug-key">侧卡缩放</span><span className="debug-value">{debugPlatformSchema.layout.sideCardScale}</span></div>
                <div className="debug-row"><span className="debug-key">背景压暗</span><span className="debug-value">{debugPlatformSchema.layout.backgroundDim}</span></div>
              </div>
            )}
          </>
        )}

        {/* ===== User Tab ===== */}
        {inspectorTab === 'user' && (
          <div className="inspector-section">
            <div className="inspector-section-title">User Persona</div>
            {!userEditing ? (
              <>
                <div className="inspector-field">
                  <label>套用 User 配置</label>
                  <select value="" onChange={e => applyUserPersonaPreset(e.target.value)}>
                    <option value="">选择后套用到当前会话</option>
                    <option value="global">全局默认 User</option>
                    {userPresets.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
                  </select>
                </div>
                <div className="user-summary-card">
                  <div className="user-summary-avatar">
                    {userPersona.avatar ? <img src={userPersona.avatar} alt={userPersona.name || 'User'} /> : <span>{(userPersona.name || '用').charAt(0)}</span>}
                  </div>
                  <div>
                    <strong>{userPersona.name || '默认用户'}</strong>
                    <span>{userPersona.address || '未设置称呼'}</span>
                  </div>
                </div>
                <div className="debug-row"><span className="debug-key">背景</span><span className="debug-value">{userPersona.background.trim() ? shortText(userPersona.background, 18) : '未设置'}</span></div>
                <div className="debug-row"><span className="debug-key">风格</span><span className="debug-value">{userPersona.style.trim() ? shortText(userPersona.style, 18) : '未设置'}</span></div>
                <div className="debug-row"><span className="debug-key">覆盖策略</span><span className="debug-value">{config.user_setting_merge_strategy === 'worldbook_overrides_user' ? '世界书优先' : '用户优先'}</span></div>
                <button className="inspector-btn primary full-width" onClick={() => setUserEditing(true)}>编辑 User</button>
              </>
            ) : (
              <>
                <div className="inspector-field">
                  <label>套用 User 配置</label>
                  <select value="" onChange={e => applyUserPersonaPreset(e.target.value)}>
                    <option value="">选择后填入下方表单</option>
                    <option value="global">全局默认 User</option>
                    {userPresets.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
                  </select>
                </div>
                <div className="inspector-field"><label>名称</label><input type="text" value={userPersona.name} onChange={e => updateUserPersona('name', e.target.value)} placeholder="你的名字" /></div>
                <div className="inspector-field"><label>头像 URL</label><input type="url" value={userPersona.avatar} onChange={e => updateUserPersona('avatar', e.target.value)} placeholder="https://..." /></div>
                <div className="inspector-field"><label>称呼</label><input type="text" value={userPersona.address} onChange={e => updateUserPersona('address', e.target.value)} placeholder="角色如何称呼你" /></div>
                <div className="inspector-field"><label>背景 / 设定</label><textarea value={userPersona.background} onChange={e => updateUserPersona('background', e.target.value)} placeholder="用户角色的背景设定" rows={3} /></div>
                <div className="inspector-field"><label>默认扮演风格</label><textarea value={userPersona.style} onChange={e => updateUserPersona('style', e.target.value)} placeholder="写作/扮演的风格偏好" rows={3} /></div>
                <div className="inspector-field">
                  <label>User 与世界书冲突时</label>
                  <select value={config.user_setting_merge_strategy} onChange={e => updateUserSettingMergeStrategy(e.target.value as UserSettingMergeStrategy)}>
                    <option value="user_overrides_worldbook">用户设定优先</option>
                    <option value="worldbook_overrides_user">世界书设定优先</option>
                  </select>
                </div>
                <button className="inspector-btn primary full-width" onClick={() => { saveConfig(); setUserEditing(false); }}>保存会话 User</button>
              </>
            )}
          </div>
        )}

        {/* ===== 调试 Tab ===== */}
        {inspectorTab === 'debug' && (
          <>
            <div className="inspector-section">
              <div className="inspector-section-title">会话状态</div>
              <div className="debug-row"><span className="debug-key">渲染模式</span><span className="debug-value">{renderMode}</span></div>
              <div className="debug-row"><span className="debug-key">消息数量</span><span className="debug-value">{messages.length}</span></div>
              <div className="debug-row"><span className="debug-key">变量数量</span><span className="debug-value">{flatVariables.length}</span></div>
              <div className="debug-row"><span className="debug-key">会话状态</span><span className="debug-value">{streaming ? '流式传输中' : recovering ? '恢复中' : memoryPending ? '记忆整理中' : '空闲'}</span></div>
            </div>
            <div className="inspector-section">
              <div className="inspector-section-title">角色卡</div>
              <div className="debug-row"><span className="debug-key">状态栏</span><span className="debug-value">{cardHasStatusRenderer ? '是' : '否'}</span></div>
              <div className="debug-row"><span className="debug-key">复杂 UI</span><span className="debug-value">{cardHasComplexUi ? '是' : '否'}</span></div>
              <div className="debug-row"><span className="debug-key">GameStart</span><span className="debug-value">{cardHasGameStart ? '是' : '否'}</span></div>
            </div>
            {sandboxActionLog.length > 0 && (
              <div className="inspector-section">
                <div className="inspector-section-title">Sandbox Actions ({sandboxActionLog.length})</div>
                <div className="sandbox-log">
                  {sandboxActionLog.map((entry, i) => (
                    <div key={i} className="sandbox-log-entry"><span className="log-action">{entry.action}</span>{entry.payload && Object.keys(entry.payload).length > 0 && <span> {JSON.stringify(entry.payload).slice(0, 80)}</span>}</div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

      </div>
    </aside>
    </div>
  );
}
