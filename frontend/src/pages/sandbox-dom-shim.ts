export const SANDBOX_DOM_SHIM_SOURCE = String.raw`
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
      this.items.forEach((item, index) => { this[index] = item; });
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
    trigger(type) { this.items.forEach(el => el?.dispatchEvent && el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))); return this; }
    click(handler) { return typeof handler === 'function' ? this.on('click', handler) : this.trigger('click'); }
    show() { this.items.forEach(el => { if (el?.style) el.style.display = ''; }); return this; }
    hide() { this.items.forEach(el => { if (el?.style) el.style.display = 'none'; }); return this; }
    empty() { this.items.forEach(el => { if (el) el.textContent = ''; }); return this; }
    append(value) { this.items.forEach(el => { if (!el) return; if (typeof value === 'string') el.insertAdjacentHTML('beforeend', value); else if (value instanceof Node) el.appendChild(value.cloneNode(true)); }); return this; }
    slideDown(duration, callback) { this.items.forEach(el => { if (el?.style) el.style.display = ''; if (typeof duration === 'function') duration.call(el); else if (typeof callback === 'function') setTimeout(() => callback.call(el), Number(duration) || 0); }); return this; }
    slideUp(duration, callback) { this.items.forEach(el => { const done = () => { if (el?.style) el.style.display = 'none'; if (typeof callback === 'function') callback.call(el); }; if (typeof duration === 'function') { done(); duration.call(el); } else setTimeout(done, Number(duration) || 0); }); return this; }
    remove() { this.items.forEach(el => el?.remove && el.remove()); return this; }
    width(value) {
      if (value === undefined) {
        const el = this.items[0];
        if (!el) return undefined;
        if (el === window) return window.innerWidth;
        if (el === document) return document.documentElement.scrollWidth;
        return el.getBoundingClientRect().width;
      }
      this.items.forEach(el => { if (el?.style) el.style.width = typeof value === 'number' ? value + 'px' : String(value); });
      return this;
    }
    height(value) {
      if (value === undefined) {
        const el = this.items[0];
        if (!el) return undefined;
        if (el === window) return window.innerHeight;
        if (el === document) return document.documentElement.scrollHeight;
        return el.getBoundingClientRect().height;
      }
      this.items.forEach(el => { if (el?.style) el.style.height = typeof value === 'number' ? value + 'px' : String(value); });
      return this;
    }
    outerHeight(includeMargin) {
      const el = this.items[0];
      if (!el) return undefined;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      let h = rect.height;
      if (includeMargin) {
        h += parseFloat(style.marginTop) || 0;
        h += parseFloat(style.marginBottom) || 0;
      }
      return h;
    }
    outerWidth(includeMargin) {
      const el = this.items[0];
      if (!el) return undefined;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      let w = rect.width;
      if (includeMargin) {
        w += parseFloat(style.marginLeft) || 0;
        w += parseFloat(style.marginRight) || 0;
      }
      return w;
    }
    scrollTop(value) {
      const el = this.items[0];
      if (!el) return undefined;
      if (value === undefined) {
        if (el === window || el === document) return window.pageYOffset || document.documentElement.scrollTop || 0;
        return el.scrollTop || 0;
      }
      this.items.forEach(e => {
        if (e === window || e === document) window.scrollTo(window.pageXOffset, Number(value));
        else e.scrollTop = Number(value);
      });
      return this;
    }
    scrollLeft(value) {
      const el = this.items[0];
      if (!el) return undefined;
      if (value === undefined) {
        if (el === window || el === document) return window.pageXOffset || document.documentElement.scrollLeft || 0;
        return el.scrollLeft || 0;
      }
      this.items.forEach(e => {
        if (e === window || e === document) window.scrollTo(Number(value), window.pageYOffset);
        else e.scrollLeft = Number(value);
      });
      return this;
    }
    offset() {
      const el = this.items[0];
      if (!el) return undefined;
      const rect = el.getBoundingClientRect();
      return { top: rect.top + window.pageYOffset, left: rect.left + window.pageXOffset };
    }
    position() {
      const el = this.items[0];
      if (!el) return undefined;
      const rect = el.getBoundingClientRect();
      const parent = el.offsetParent;
      if (!parent || parent === document.documentElement) return { top: rect.top + window.pageYOffset, left: rect.left + window.pageXOffset };
      const parentRect = parent.getBoundingClientRect();
      return { top: rect.top - parentRect.top - (parseFloat(getComputedStyle(parent).borderTopWidth) || 0), left: rect.left - parentRect.left - (parseFloat(getComputedStyle(parent).borderLeftWidth) || 0) };
    }
    animate(properties, durationOrOptions, callback) {
      const opts = (typeof durationOrOptions === 'object' && durationOrOptions !== null) ? durationOrOptions : {};
      const duration = typeof durationOrOptions === 'number' ? durationOrOptions : (opts.duration ?? 0);
      const completeCb = typeof callback === 'function' ? callback : (typeof opts.complete === 'function' ? opts.complete : null);
      const progressCb = typeof opts.progress === 'function' ? opts.progress : null;
      const fire = () => {
        this.items.forEach(el => {
          if (!el?.style) return;
          for (const [prop, val] of Object.entries(properties)) {
            if (prop === 'scrollTop') { el.scrollTop = parseInt(String(val), 10) || 0; continue; }
            if (prop === 'scrollLeft') { el.scrollLeft = parseInt(String(val), 10) || 0; continue; }
            el.style[prop] = String(val);
          }
        });
        if (progressCb) this.items.forEach(el => progressCb.call(el, null, 1, 0));
        if (completeCb) this.items.forEach(el => completeCb.call(el));
      };
      if (duration > 0) setTimeout(fire, duration); else queueMicrotask(fire);
      const animObj = {
        promise: () => new Promise(resolve => { if (duration > 0) setTimeout(resolve, duration); else queueMicrotask(resolve); }),
        animate: (p, d, c) => { queueMicrotask(() => new MiniQuery(this.items).animate(p, d, c)); return animObj; },
      };
      return animObj;
    }
    [Symbol.iterator]() { return this.items[Symbol.iterator](); }
  }
  window.$ = window.jQuery = (value) => {
    if (typeof value === 'function') {
      const run = () => value.call(document, window.$);
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run, { once: true });
      } else {
        queueMicrotask(run);
      }
      return new MiniQuery(document);
    }
    return new MiniQuery(value);
  };
  window.$.ajax = function(options) {
    if (!options || typeof options !== 'object') return;
    const url = options.url || '';
    console.warn('[sandbox-jquery] $.ajax is not supported in the sandbox environment. Request to ' + url + ' was blocked.');
    if (typeof options.error === 'function') {
      options.error(null, 'error', 'AJAX requests are not supported in the sandbox environment');
    }
    if (typeof options.complete === 'function') {
      options.complete(null, 'error');
    }
  };
  window.$.extend = function(target, ...sources) {
    if (target === true) {
      const actualTarget = sources.shift() || {};
      for (const source of sources) {
        if (source && typeof source === 'object') Object.assign(actualTarget, source);
      }
      return actualTarget;
    }
    for (const source of sources) {
      if (source && typeof source === 'object') Object.assign(target, source);
    }
    return target;
  };
})();
`;

