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
      return handleApi(request, env);
    }

    return env.ASSETS.fetch(request);
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
