// Kept as a redirect for existing tooling. Native ESM config lives in vite.config.mjs.
module.exports = async () => (await import('./vite.config.mjs')).default;
