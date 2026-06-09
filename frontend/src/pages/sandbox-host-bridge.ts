export const SANDBOX_HOST_BRIDGE_SOURCE = String.raw`
  const pendingHostRequests = new Map();
  const makeHostRequestId = () => 'xrp-host-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  const requestHost = (action, payload = {}) => {
    const requestId = makeHostRequestId();
    post({
      type: 'card-sandbox-action',
      action,
      requestId,
      payload,
    });
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingHostRequests.delete(requestId);
        reject(new Error('Host bridge timeout'));
      }, 20000);
      pendingHostRequests.set(requestId, { resolve, reject, timeoutId });
    });
  };
  const applyRuntimeResponse = (data = {}) => {
    if (data?.type !== 'xrp-runtime-response') return;
    const requestId = String(data.requestId || '');
    if (!requestId) return;
    const pending = pendingHostRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    pendingHostRequests.delete(requestId);
    if (data.ok === false) {
      pending.reject(new Error(String(data.error || 'Host bridge failed')));
      return;
    }
    pending.resolve(data.payload ?? null);
  };
  window.addEventListener('message', (event) => {
    applyRuntimeResponse(event.data || {});
  });
  if (directRuntimeBridge && typeof directRuntimeBridge.messageEventName === 'string') {
    window.addEventListener(directRuntimeBridge.messageEventName, (event) => {
      applyRuntimeResponse(event.detail || {});
    });
  }
`;
