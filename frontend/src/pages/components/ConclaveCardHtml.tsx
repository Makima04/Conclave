import React, { useEffect, useRef } from 'react';

interface ConclaveCardHtmlProps {
  html: string;
  cardKey: string;
  className?: string;
}

interface ExtractedHtmlParts {
  headNodes: Node[];
  bodyHtml: string;
  scripts: Array<{
    src: string;
    type: string;
    content: string;
  }>;
}

type ConclaveWindow = Window & typeof globalThis & {
  __conclaveCreateScopedLocalStorage?: (namespace: string) => Storage;
  __conclaveCreateScopedIndexedDB?: (namespace: string) => IDBFactory;
};

type DomReadyTarget = (Window | Document) & {
  __conclaveDomReadyCompatInstalled?: boolean;
};

let domContentLoadedFired = document.readyState !== 'loading';
document.addEventListener('DOMContentLoaded', () => {
  domContentLoadedFired = true;
}, { once: true });

function installClassicGlobalIdentifier(name: string, initializerExpression: string) {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return;

  const script = document.createElement('script');
  script.textContent = `
    if (typeof ${name} === 'undefined') {
      var ${name} = window.${name} || (window.${name} = ${initializerExpression});
    } else if (!window.${name}) {
      window.${name} = ${name};
    }
  `;
  document.head.appendChild(script);
  script.remove();
}

function installBundledCardGlobalCompatibility() {
  installClassicGlobalIdentifier('Vue', '{}');
}

function scopedLocalStorageKeys(prefix: string): string[] {
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

function createScopedLocalStorage(namespace: string): Storage {
  const prefix = `${namespace}localStorage:`;
  const storage = {
    get length() {
      return scopedLocalStorageKeys(prefix).length;
    },
    key(index: number) {
      return scopedLocalStorageKeys(prefix)[Number(index)]?.slice(prefix.length) ?? null;
    },
    getItem(key: string) {
      return window.localStorage.getItem(prefix + String(key));
    },
    setItem(key: string, value: string) {
      window.localStorage.setItem(prefix + String(key), String(value));
    },
    removeItem(key: string) {
      window.localStorage.removeItem(prefix + String(key));
    },
    clear() {
      scopedLocalStorageKeys(prefix).forEach(key => window.localStorage.removeItem(key));
    },
  };

  return new Proxy(storage, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      if (typeof property === 'string') return target.getItem(property);
      return undefined;
    },
    set(target, property, value) {
      if (typeof property !== 'string') return false;
      target.setItem(property, String(value));
      return true;
    },
    deleteProperty(target, property) {
      if (typeof property !== 'string') return false;
      target.removeItem(property);
      return true;
    },
  }) as Storage;
}

function createScopedIndexedDB(namespace: string): IDBFactory {
  const prefix = `${namespace}indexedDB:`;
  return {
    ...window.indexedDB,
    open(name: string, version?: number) {
      return window.indexedDB.open(prefix + String(name), version);
    },
    deleteDatabase(name: string) {
      return window.indexedDB.deleteDatabase(prefix + String(name));
    },
    cmp(first: unknown, second: unknown) {
      return window.indexedDB.cmp(first as IDBValidKey, second as IDBValidKey);
    },
    databases: window.indexedDB.databases
      ? () => window.indexedDB.databases()
      : undefined,
  } as IDBFactory;
}

function installCardStorageCompatibility() {
  const hostWindow = window as ConclaveWindow;
  hostWindow.__conclaveCreateScopedLocalStorage = createScopedLocalStorage;
  hostWindow.__conclaveCreateScopedIndexedDB = createScopedIndexedDB;
}

function dispatchLateDomReadyListener(target: Window | Document, listener: EventListenerOrEventListenerObject) {
  const event = new Event('DOMContentLoaded');
  try {
    if (typeof listener === 'function') {
      listener.call(target, event);
    } else {
      listener.handleEvent(event);
    }
  } catch (error) {
    window.setTimeout(() => {
      throw error;
    }, 0);
  }
}

function installDomReadyCompatibility() {
  [document, window].forEach(target => {
    const compatibleTarget = target as DomReadyTarget;
    if (compatibleTarget.__conclaveDomReadyCompatInstalled) return;

    const originalAddEventListener = target.addEventListener.bind(target);
    Object.defineProperty(compatibleTarget, '__conclaveDomReadyCompatInstalled', { value: true });

    target.addEventListener = function addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (!listener) return undefined;
      const result = originalAddEventListener(type, listener, options);
      if (
        type === 'DOMContentLoaded'
        && (domContentLoadedFired || document.readyState === 'complete')
      ) {
        window.setTimeout(() => dispatchLateDomReadyListener(target, listener), 0);
      }
      return result;
    } as typeof target.addEventListener;
  });
}

function extractHtmlParts(htmlContent: string): ExtractedHtmlParts {
  const parsed = new DOMParser().parseFromString(htmlContent || '', 'text/html');
  const scriptNodes = Array.from(parsed.querySelectorAll('script'));
  const scripts = scriptNodes.map(script => ({
    src: script.getAttribute('src') || '',
    type: script.getAttribute('type') || '',
    content: script.textContent || '',
  }));

  scriptNodes.forEach(script => script.remove());

  return {
    headNodes: Array.from(parsed.head.childNodes).map(node => node.cloneNode(true)),
    bodyHtml: parsed.body.innerHTML || htmlContent || '',
    scripts,
  };
}

function installHeadNodes(headNodes: Node[]): Element[] {
  if (!headNodes.length) return [];

  document.querySelectorAll('[data-conclave-card-head="true"]').forEach(node => node.remove());

  const installed: Element[] = [];
  headNodes.forEach(node => {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (element.tagName === 'SCRIPT') return;
    if (
      element.tagName === 'LINK'
      && /font-?awesome/i.test(element.getAttribute('href') || '')
    ) {
      return;
    }
    element.setAttribute('data-conclave-card-head', 'true');
    document.head.appendChild(element);
    installed.push(element);
  });

  return installed;
}

function cardScriptContentWithCompatibilityPrelude(
  scriptPart: ExtractedHtmlParts['scripts'][number],
  cardKey: string,
): string {
  const content = scriptPart.content || '';
  if (!String(scriptPart.type || '').includes('module') || !/\b(?:localStorage|indexedDB)\b/.test(content)) {
    return content;
  }

  const namespace = JSON.stringify(`conclave:card:${cardKey}:`);
  return `
    const localStorage = window.__conclaveCreateScopedLocalStorage(${namespace});
    const indexedDB = window.__conclaveCreateScopedIndexedDB(${namespace});
    const BroadcastChannel = window.BroadcastChannel
      ? class ConclaveScopedBroadcastChannel extends window.BroadcastChannel {
        constructor(name) {
          super(${namespace} + 'BroadcastChannel:' + String(name));
        }
      }
      : undefined;
    ${content}
  `;
}

function executeScripts(
  scripts: ExtractedHtmlParts['scripts'],
  cardKey: string,
): HTMLScriptElement[] {
  const installed: HTMLScriptElement[] = [];
  scripts.forEach(scriptPart => {
    if (scriptPart.src && /jquery/i.test(scriptPart.src)) return;

    const script = document.createElement('script');
    script.dataset.conclaveCardScript = 'true';
    script.dataset.conclaveCardKey = cardKey;
    if (scriptPart.type) script.type = scriptPart.type;
    if (scriptPart.src) {
      script.src = scriptPart.src;
    } else {
      script.textContent = cardScriptContentWithCompatibilityPrelude(scriptPart, cardKey);
    }
    document.body.appendChild(script);
    installed.push(script);
  });
  return installed;
}

function isInsideRenderTarget(node: Node, target: HTMLElement): boolean {
  return node === target || target.contains(node) || node.contains(target);
}

function renderCardHtml(htmlContent: string, target: HTMLElement, cardKey: string) {
  const artifacts = new Set<Node>();
  const observer = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
      mutation.addedNodes.forEach(node => {
        if (node.nodeType !== Node.ELEMENT_NODE || isInsideRenderTarget(node, target)) return;
        artifacts.add(node);
      });
    });
  });

  observer.observe(document.head, { childList: true });
  observer.observe(document.body, { childList: true });

  const { headNodes, bodyHtml, scripts } = extractHtmlParts(htmlContent);
  const installedHeadNodes = installHeadNodes(headNodes);
  target.innerHTML = bodyHtml;
  const installedScripts = executeScripts(scripts, cardKey);

  return () => {
    observer.disconnect();
    installedScripts.forEach(node => node.remove());
    installedHeadNodes.forEach(node => node.remove());
    artifacts.forEach(node => {
      if (node.isConnected) node.parentNode?.removeChild(node);
    });
    target.innerHTML = '';
  };
}

installBundledCardGlobalCompatibility();
installCardStorageCompatibility();
installDomReadyCompatibility();

export function ConclaveCardHtml({ html, cardKey, className }: ConclaveCardHtmlProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const target = ref.current;
    if (!target) return undefined;
    return renderCardHtml(html, target, cardKey);
  }, [html, cardKey]);

  return <div ref={ref} className={className} />;
}
