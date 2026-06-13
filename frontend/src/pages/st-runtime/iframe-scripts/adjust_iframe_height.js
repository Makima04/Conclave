// Ported from JSR adjust_iframe_height.js
// Observes body resize and sets frameElement.style.height to match content.
// Enhanced: MutationObserver to catch dynamic content changes from card scripts.

(function () {
  function measureAndApply() {
    try {
      const body = window.document.body;
      const html = window.document.documentElement;
      if (!body || !html) return;

      // 取 body.scrollHeight 和 html.scrollHeight 的较大值（某些卡片内容在 html 上）
      const height = Math.max(body.scrollHeight, html.scrollHeight);
      if (!Number.isFinite(height) || height <= 0) return;

      frameElement.style.height = `${height}px`;
    } catch {
      // frameElement 不可用（跨域等情况）
    }
  }

  function startObserving() {
    const body = document.body;
    if (!body) return;

    // ResizeObserver：元素尺寸变化时触发
    const ro = new ResizeObserver(() => measureAndApply());
    ro.observe(body);
    // 也 observe html（有些卡片在 html 上设 min-height）
    ro.observe(document.documentElement);

    // MutationObserver：DOM 子树变化时触发（卡片 JS 动态插入内容）
    const mo = new MutationObserver(() => measureAndApply());
    mo.observe(body, { childList: true, subtree: true, characterData: true });

    // 初始测量 + 延迟重测（覆盖卡片 JS 异步渲染场景）
    measureAndApply();
    setTimeout(measureAndApply, 300);
    setTimeout(measureAndApply, 1000);
    setTimeout(measureAndApply, 3000);
  }

  // load 事件触发后开始监听
  if (document.readyState === 'complete') {
    startObserving();
  } else {
    window.addEventListener('load', startObserving);
  }
})();
