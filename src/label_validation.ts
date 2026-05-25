/**
 * Shared validation for attestor labels.
 *
 * Labels surface on the public witness map (tooltip + side panel) where
 * any HTML metachar in a label that reaches Leaflet's bindTooltip string
 * path executes as markup (leaflet-src.js _updateContent sets innerHTML
 * for string content). The render layer escapes, but we reject at every
 * label-accepting entry point as defense in depth — same label value also
 * lands in operator dashboards and structured logs.
 *
 * Rejected: `<`, `>`, `&`, `"`, `'`, and C0 control characters (U+0000
 * through U+001F).
 */

export const LABEL_FORBIDDEN = new RegExp("[<>&\"'\\u0000-\\u001f]");
