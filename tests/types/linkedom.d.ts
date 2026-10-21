/**
 * The single LinkeDOM public API used by the DOM fixtures. Its documented return
 * type matches the package entrypoint; the input is restricted to fixture HTML.
 * Internal declarations claim complete DOM implementations that the package
 * deliberately does not provide: https://github.com/WebReflection/linkedom/issues/87.
 * Keep this boundary explicit instead of disabling declaration checks globally.
 */
export function parseHTML(html: string): Window & typeof globalThis;
