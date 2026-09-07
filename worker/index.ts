/**
 * Worker entry.
 *
 * `/api/*` goes to the router. Everything else is a static asset, with the
 * assets binding falling back to index.html for unknown paths so the SPA can
 * own client-side routing.
 *
 * The `scheduled` export is the notification cron. It runs every minute and
 * almost always does nothing — which is the design: the alternative to a cheap
 * tick that usually returns immediately is a per-notification timer, and
 * nothing in a Worker can hold one.
 */

import type { Env } from './db';
import { runScheduledNotifications } from './notify';
import { handleApi } from './routes';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return secure(await handleApi(request, env), true);
    }

    const asset = await env.ASSETS.fetch(request);
    return secure(await indexPublicDemo(asset, /^\/demo\/?$/.test(url.pathname)), false);
  },

  /**
   * The notification tick.
   *
   * Everything inside is caught. A scheduled handler that rejects is retried by
   * the platform, and the one thing this feature must never do is deliver the
   * same notification twice — so a failure here becomes a log line and the next
   * tick tries again a minute later, which is the same recovery a retry would
   * have given without the risk.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runScheduledNotifications(env).catch((error: unknown) => {
        console.error('scheduled notification run failed', {
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }),
    );
  },
} satisfies ExportedHandler<Env>;

async function indexPublicDemo(response: Response, isPublicDemo: boolean): Promise<Response> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!isPublicDemo || !contentType.includes('text/html')) return response;

  const headers = new Headers(response.headers);
  for (const name of ['content-length', 'content-encoding', 'etag', 'last-modified']) {
    headers.delete(name);
  }
  const html = (await response.text()).replace(
    '<meta name="robots" content="noindex, nofollow" />',
    '<meta name="robots" content="index, follow, max-image-preview:large" />',
  );
  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function secure(response: Response, api: boolean): Response {
  const secured = new Response(response.body, response);
  secured.headers.set('X-Content-Type-Options', 'nosniff');
  secured.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  secured.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  secured.headers.set('X-Frame-Options', 'DENY');
  secured.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  secured.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  );
  if (api) secured.headers.set('Cache-Control', 'no-store');
  return secured;
}
