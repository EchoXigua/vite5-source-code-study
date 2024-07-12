



// This file will be built for both ESM and CJS. Avoid relying on other modules as possible.

// copy from constants.ts
const CSS_LANGS_RE =
  // eslint-disable-next-line regexp/no-unused-capturing-group
  /\.(css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/
export const isCSSRequest = (request: string): boolean =>
  CSS_LANGS_RE.test(request)