import adjustViewport from './adjust_viewport.js?raw';
import adjustIframeHeight from './adjust_iframe_height.js?raw';
import parentJquery from './parent_jquery.js?raw';
import predefine from './predefine.js?raw';

function createObjectURL(code: string): string {
  return URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
}

// Created at module level, never revoked (host process outlives all iframes).
export const adjust_viewport_url = createObjectURL(adjustViewport);
export const adjust_iframe_height_url = createObjectURL(adjustIframeHeight);
export const parent_jquery_url = createObjectURL(parentJquery);
export const predefine_url = createObjectURL(predefine);
