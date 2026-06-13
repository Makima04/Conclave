// Ported from JSR adjust_viewport.js
// Sets --TH-viewport-height CSS variable on <html> and keeps it in sync via postMessage.
// Original used $('html').css(...); ported to native style.setProperty().

document.documentElement.style.setProperty('--TH-viewport-height', `${window.parent.innerHeight}px`);

window.addEventListener('message', function (event) {
  if (event.data?.type === 'TH_UPDATE_VIEWPORT_HEIGHT') {
    document.documentElement.style.setProperty('--TH-viewport-height', `${window.parent.innerHeight}px`);
  }
});
