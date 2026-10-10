import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// The Content Security Policy of the built app: what a page may load. Scripts
// only from this site, so an injected <script> or inline handler does not
// run; styles and fonts also from Google Fonts; requests only to this site
// and to the API when it lives on another address (VITE_API_BASE).
//
// It is written into the built index.html as a <meta> tag, so it applies
// wherever the files are hosted, including a plain static host that sets no
// headers. It is the same policy the server sends as a header when it serves
// the client itself (server/src/middleware/securityHeaders.js; a test compares
// the two). Only production builds get it: the dev server needs inline
// scripts for hot reloading.
function contentSecurityPolicy(apiBase) {
  let apiOrigin = ''
  try {
    apiOrigin = apiBase ? new URL(apiBase).origin : ''
  } catch {
    // a relative VITE_API_BASE ("/api"): same site, nothing to add
  }
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    `connect-src 'self'${apiOrigin ? ` ${apiOrigin}` : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
  return {
    name: 'mindatlas-csp',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' },
    ],
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  return {
    plugins: [react(), contentSecurityPolicy(env.VITE_API_BASE)],
    build: {
      // Fonts (the formula fonts, KaTeX) are always separate files, never
      // inlined as data: addresses, which the policy above does not allow.
      assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf|eot)$/i.test(file) ? false : undefined),
    },
    server: {
      port: 5173,
      host: true,
    },
  }
})
