'use strict';

// Content Security Policy tuned for the CDN-based front-end. Bootstrap and the
// React/Babel runtime are loaded from jsDelivr/unpkg and fonts from Google
// Fonts. Babel-in-the-browser compiles the .jsx files and re-injects the result
// as inline <script> tags, so it needs both 'unsafe-eval' (to compile) and
// 'unsafe-inline' (to run the compiled output); Bootstrap component styling
// needs inline styles. connect-src also allows jsDelivr so the browser can
// fetch the Bootstrap CSS source map. The policy is intentionally permissive
// enough to keep the dashboard working while still constraining script/style/
// connect origins to known hosts.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net",
  "img-src 'self' data: https:",
  "connect-src 'self' https://cdn.jsdelivr.net ws: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
].join('; ');

/**
 * Sets a baseline of security response headers on every response. Kept
 * dependency-free (no helmet) so there is no extra runtime dependency or
 * lockfile churn. HSTS is only emitted in production, where the app is served
 * over HTTPS behind a TLS-terminating proxy.
 *
 * @returns {import('express').RequestHandler} -> The header middleware.
 */
function securityHeaders() {
  const isProd = process.env.NODE_ENV === 'production';
  return function setSecurityHeaders(_req, res, next) {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-DNS-Prefetch-Control', 'off');
    res.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    if (isProd) {
      res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    next();
  };
}

module.exports = { securityHeaders };
