// adjust_iframe_height.js — self-contained iframe height adjuster
//
// Runs inside a same-origin blob-URL iframe. Measures body.scrollHeight
// and sets frameElement.style.height directly (no postMessage needed).
//
// THREE triggers for reliable height tracking:
//   1. Immediate measurement at script parse time (catches static content)
//   2. ResizeObserver on body + html (catches dynamic resizing)
//   3. MutationObserver on body (catches DOM changes from card scripts)
//
// Delayed re-measurements at 300ms/1s/3s for async card script rendering.

(function () {
  'use strict';

  function measureAndApply() {
    try {
      if (!frameElement) return;
      var body = document.body;
      var html = document.documentElement;
      if (!body) return;
      var height = Math.max(
        body.scrollHeight,
        body.offsetHeight,
        html.scrollHeight,
        html.offsetHeight,
        200
      );
      frameElement.style.height = height + 'px';
    } catch (_) {
      // frameElement not accessible (cross-origin or detached)
    }
  }

  function startObserving() {
    // ResizeObserver — fires when body or html size changes
    if (typeof ResizeObserver !== 'undefined') {
      var ro = new ResizeObserver(measureAndApply);
      if (document.body) ro.observe(document.body);
      if (document.documentElement) ro.observe(document.documentElement);
    }

    // MutationObserver — fires on childList, subtree, and characterData changes
    if (document.body && typeof MutationObserver !== 'undefined') {
      var mo = new MutationObserver(measureAndApply);
      mo.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
  }

  // Immediate measurement at parse time (catches static content already laid out)
  measureAndApply();

  // Start observers as soon as possible
  if (document.readyState === 'loading') {
    // DOM not ready yet — wait for DOMContentLoaded (much earlier than 'load')
    document.addEventListener('DOMContentLoaded', function () {
      measureAndApply();
      startObserving();
    });
  } else {
    // DOM already interactive/complete — start immediately
    startObserving();
  }

  // Also listen for load as a final catch-all (for images/resources that affect height)
  window.addEventListener('load', measureAndApply);

  // Delayed re-measurements for async card script rendering
  setTimeout(measureAndApply, 300);
  setTimeout(measureAndApply, 1000);
  setTimeout(measureAndApply, 3000);
})();
