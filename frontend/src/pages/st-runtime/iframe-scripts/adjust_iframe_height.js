// Ported from JSR adjust_iframe_height.js
// Observes body resize and sets frameElement.style.height to match content.
// Depends on lodash `_.throttle` being available on window (injected by predefine.js).

(function () {
  let scheduled = false;

  function measureAndPost() {
    scheduled = false;
    try {
      const doc = window.document;
      const body = doc.body;
      const html = doc.documentElement;
      if (!body || !html) {
        return;
      }

      let height = 0;
      height = body.scrollHeight;

      if (!Number.isFinite(height) || height <= 0) {
        return;
      }

      frameElement.style.height = `${height}px`;
    } catch {
      //
    }
  }
  const throttledMeasureAndPost = _.throttle(measureAndPost, 500);

  function postIframeHeight() {
    if (scheduled) {
      return;
    }
    scheduled = true;

    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(measureAndPost);
    } else {
      throttledMeasureAndPost();
    }
  }

  function observeHeightChange() {
    const body = document.body;
    if (!body) {
      return;
    }

    const resize_observer = new ResizeObserver(entries => {
      postIframeHeight();
    });
    resize_observer.observe(body);
  }

  // Original used $(() => { ... }) for DOMContentLoaded.
  // Ported to native addEventListener because the script iframe has no jQuery.
  window.addEventListener('load', () => {
    postIframeHeight();
    observeHeightChange();
  });
})();
