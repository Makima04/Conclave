export const SANDBOX_INPUT_RUNTIME_SOURCE = String.raw`
  const readFieldValue = (field) => {
    if (!field) return '';
    const value = field.isContentEditable
      ? field.innerText || field.textContent
      : field.value || field.textContent;
    return String(value || '').replace(/\\r\\n/g, '\\n').trim().slice(0, 8000);
  };
  const isTextField = (element) => {
    if (!element) return false;
    const tag = String(element.tagName || '').toLowerCase();
    if (tag === 'textarea') return true;
    if (element.isContentEditable) return true;
    if (tag !== 'input') return false;
    const type = String(element.getAttribute('type') || 'text').toLowerCase();
    return ['text', 'search', 'url', 'email', 'tel', 'password', ''].includes(type);
  };
  const isExplicitChatSubmitControl = (target) => {
    if (!target || !target.getAttribute) return false;
    const id = safeText(target.getAttribute('id')).toLowerCase();
    const dataAction = safeText(target.getAttribute('data-action')).toLowerCase();
    const marker = safeText(target.getAttribute('data-xrp-submit-chat')).toLowerCase();
    return id === 'send_but'
      || id === 'send_textarea'
      || marker === 'true'
      || dataAction === 'submittext'
      || dataAction === 'submit-text'
      || dataAction === 'submit-free-start';
  };
  const looksLikeChatSubmitControl = (target) => {
    if (!target || !target.getAttribute) return false;
    if (isExplicitChatSubmitControl(target)) return true;
    const text = safeText(target.innerText || target.textContent || target.value);
    const aria = safeText(target.getAttribute('aria-label') || target.getAttribute('title'));
    const dataAction = safeText(target.getAttribute('data-action'));
    const className = safeText(target.className);
    const haystack = [text, aria, dataAction, className].join(' ').toLowerCase();
    return /(?:send|submit|continue|generate|record|发送|提交|继续|书写|续写|记录|开始剧情)/i.test(haystack);
  };
  const findNearestTextField = (target) => {
    if (!target) return null;
    const direct = isTextField(target) && !target.dataset?.xrpStInputProxy ? target : null;
    if (direct) return direct;
    const active = document.activeElement;
    if (isTextField(active) && !active.dataset?.xrpStInputProxy && readFieldValue(active)) return active;
    const containers = [
      target.closest && target.closest('form'),
      target.closest && target.closest('[data-action]'),
      target.closest && target.closest('section,article,main,aside,div'),
      document,
    ].filter(Boolean);
    for (const container of containers) {
      const fields = Array.from(container.querySelectorAll('textarea,input,[contenteditable="true"]'))
        .filter(field => isTextField(field) && !field.dataset?.xrpStInputProxy);
      const withValue = fields.find(field => readFieldValue(field));
      if (withValue) return withValue;
      if (fields[0]) return fields[0];
    }
    return null;
  };
  const postTextSubmit = (target, source) => {
    const field = findNearestTextField(target);
    const message = readFieldValue(field);
    if (!message) return false;
    const requestGenerationId = makeGenerationId();
    post({
      type: 'card-sandbox-action',
      action: 'submitText',
      payload: {
        message,
        source,
        sourceMessageId: getRuntimeMessageId(),
        generationId: requestGenerationId,
        clear: true,
        label: safeText(target?.innerText || target?.textContent || target?.value),
      },
    });
    postDiagnostic('submitText', { source, length: message.length, label: safeText(target?.innerText || target?.textContent || target?.value), generationId: requestGenerationId });
    if (field && field.value !== undefined) {
      field.value = '';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (field && field.isContentEditable) {
      field.textContent = '';
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  };
  const ensureSillyTavernInputProxy = () => {
    if (!document.getElementById('send_textarea')) {
      const textarea = document.createElement('textarea');
      textarea.id = 'send_textarea';
      textarea.setAttribute('aria-hidden', 'true');
      textarea.hidden = true;
      textarea.dataset.xrpStInputProxy = 'true';
      textarea.style.cssText = 'display:none!important;position:absolute!important;left:-10000px!important;top:auto!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important;';
      textarea.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
        if (postTextSubmit(textarea, 'st-send-textarea-enter')) event.preventDefault();
      });
      (document.body || document.documentElement).appendChild(textarea);
    }
    if (!document.getElementById('send_but')) {
      const button = document.createElement('button');
      button.id = 'send_but';
      button.type = 'button';
      button.setAttribute('aria-hidden', 'true');
      button.hidden = true;
      button.dataset.xrpStInputProxy = 'true';
      button.textContent = 'Send';
      button.style.cssText = 'display:none!important;position:absolute!important;left:-10000px!important;top:auto!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important;';
      button.addEventListener('click', () => postTextSubmit(button, 'st-send-button'));
      (document.body || document.documentElement).appendChild(button);
    }
    if (document.body) {
      document.querySelectorAll('[data-xrp-st-input-proxy]').forEach((element) => {
        if (element.parentElement !== document.body) document.body.appendChild(element);
      });
    }
  };
  const inferSharedSaveIdFromElement = (control) => {
    const directSaveElement = control && control.closest ? control.closest('[data-save-id]') : null;
    const directSaveId = safeText(directSaveElement?.getAttribute && directSaveElement.getAttribute('data-save-id'));
    if (directSaveId) return directSaveId;
    const saveIds = Object.keys(sharedSaveSessionById);
    if (!control || !saveIds.length) return '';
    let element = control;
    for (let depth = 0; element && depth < 8; depth += 1, element = element.parentElement) {
      const nestedSaveElements = element.querySelectorAll ? Array.from(element.querySelectorAll('[data-save-id]')) : [];
      if (nestedSaveElements.length === 1) {
        const nestedSaveId = safeText(nestedSaveElements[0]?.getAttribute && nestedSaveElements[0].getAttribute('data-save-id'));
        if (nestedSaveId) return nestedSaveId;
      }
      const text = safeText(element.innerText || element.textContent);
      if (!text || text.length > 2500) continue;
      const ranked = saveIds
        .map((saveId) => {
          const meta = sharedSaveIndex[saveId] || {};
          const payload = sharedSavePayloads[saveId] || {};
          const chatLog = Array.isArray(payload.chatLog) ? payload.chatLog : [];
          const preview = safeText(meta.preview);
          const label = safeText(meta.label);
          const playerName = safeText(meta.playerProfile?.name);
          const characterName = safeText(meta.characterName);
          const messageCount = Number(meta.messageCount || chatLog.length || 0);
          let score = 0;
          if (preview && text.includes(preview.slice(0, Math.min(60, preview.length)))) score += 8;
          if (label && text.includes(label)) score += 3;
          if (playerName && text.includes(playerName)) score += 2;
          if (characterName && text.includes(characterName)) score += 1;
          if (messageCount && text.includes(String(messageCount)) && /条记录|條記錄|records?/i.test(text)) score += 3;
          return { saveId, score };
        })
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score);
      if (ranked.length && (ranked.length === 1 || ranked[0].score > ranked[1].score)) return ranked[0].saveId;
    }
    return '';
  };
  const bindChatInputInteractions = () => {
    document.addEventListener('click', (event) => {
      const target = event.target && event.target.closest ? event.target.closest('button,a,[role="button"],[data-action]') : null;
      if (!target) return;
      const dataAction = safeText(target.getAttribute && target.getAttribute('data-action'));
      const targetId = safeText(target.id);
      const controlText = safeText(target.innerText || target.textContent || target.value);
      if (
        targetId === 'cm-btn-select'
        || /(?:选定此缘|踏入苍玄|自由开局|听凭天意)/.test(controlText)
      ) {
        postDiagnostic('opening-control-click', {
          id: targetId,
          text: controlText.slice(0, 80),
          dataId: safeText(target.getAttribute && target.getAttribute('data-id')),
          datasetId: safeText(target.dataset?.id),
          hasGetChatMessages: typeof window.getChatMessages === 'function',
          hasBareGetChatMessages: (() => { try { return typeof getChatMessages === 'function'; } catch { return false; } })(),
          hasSetChatMessages: typeof window.setChatMessages === 'function',
          hasSetChatMessage: typeof window.setChatMessage === 'function',
        });
      }
      const saveId = inferSharedSaveIdFromElement(target);
      if (dataAction === 'load-save' && saveId && sharedSaveSessionById[saveId]) {
        post({
          type: 'card-sandbox-action',
          action: 'loadSaveSession',
          payload: { saveId, sessionId: sharedSaveSessionById[saveId] },
        });
        if (!debugTelemetry) return;
      }
      const controlLabel = safeText(target.getAttribute && (target.getAttribute('aria-label') || target.getAttribute('title')));
      const looksLikeDeleteSave = saveId && sharedSaveSessionById[saveId] && /(?:delete|remove|删除|刪除|×|✕)/i.test([dataAction, controlText, controlLabel].join(' '));
      if (looksLikeDeleteSave) {
        post({
          type: 'card-sandbox-action',
          action: 'deleteSaveSession',
          payload: { saveId, sessionId: sharedSaveSessionById[saveId] },
        });
        if (!debugTelemetry) return;
      }
      if (looksLikeChatSubmitControl(target) && postTextSubmit(target, 'click')) {
        return;
      }
      if (!debugTelemetry) return;
      post({
        type: 'card-sandbox-action',
        action: 'uiClick',
        payload: {
          text: safeText(target.innerText || target.textContent || target.value),
          id: safeText(target.id),
          className: safeText(target.className),
          dataAction,
          value: safeText(target.value),
        },
      });
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
      if (!isTextField(event.target)) return;
      const target = event.target;
      if (postTextSubmit(target, isExplicitChatSubmitControl(target) ? 'enter' : 'text-enter')) {
        event.preventDefault();
      }
    });
    document.addEventListener('submit', (event) => {
      const target = event.target;
      event.preventDefault();
      if (!looksLikeChatSubmitControl(target)) return;
      const data = {};
      try {
        new FormData(target).forEach((value, key) => { data[key] = String(value).slice(0, 1000); });
      } catch {}
      data.sourceMessageId = getRuntimeMessageId();
      data.__xrpSubmitChat = true;
      post({ type: 'card-sandbox-action', action: 'formSubmit', payload: data });
    });
  };
`;
