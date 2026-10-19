declare const __APP_VERSION__: string;

/** The site's version, 1.<changes since early access began>; set at build time (see vite.config.ts). */
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0";
