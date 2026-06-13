// Ported from JSR predefine.js — ST-iframe bootstrap (no jQuery required)
// Inherits lodash, TavernHelper, and event helpers from the host window.

window._ = window.parent._;

const iframeId = window.frameElement?.id || window.name;
if (iframeId) {
  // Cache the iframe id in case frameElement disappears (e.g., Firefox removing srcdoc iframes on navigation)
  // and also put it on window.name so it survives DOM removal.
  window.__TH_IFRAME_ID = iframeId;
  if (!window.name) {
    window.name = iframeId;
  }
}

let result = _(window);
result = result.merge(_.pick(window.parent, ['TavernHelper', 'YAML', 'showdown', 'toastr', 'z']));
result = result.merge(_.omit(_.get(window.parent, 'TavernHelper'), '_bind'));
result = result.merge(
  ...Object.entries(_.get(window.parent, 'TavernHelper')._bind).map(([key, value]) => ({
    [key.replace('_', '')]: value.bind(window),
  })),
);
result.value();

Object.defineProperty(window, 'SillyTavern', {
  get: () => {
    const SillyTavern = _.get(window.parent, 'SillyTavern');
    const getContext = () => {
      return { ...SillyTavern.getContext(), writeExtensionField: _th_impl.writeExtensionField };
    };
    return { ...getContext(), getContext };
  },
});

if (_.has(window.parent, 'Mvu')) {
  Object.defineProperty(window, 'Mvu', {
    get: () => _.get(window.parent, 'Mvu'),
    set: () => {},
    configurable: true,
  });
}

// Clean up all event listeners when the iframe is hidden/unloaded.
// Original used $(window).on('pagehide', ...) — ported to native addEventListener
// because the script iframe has no jQuery loaded at this point.
window.addEventListener('pagehide', () => {
  eventClearAll();
});
