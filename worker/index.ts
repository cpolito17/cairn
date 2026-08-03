/**
 * Worker entry.
 *
 * `/api/*` goes to the router. Everything else is a static asset, with the
 * assets binding falling back to index.html for unknown paths so the SPA can
 * own client-side routing.
 */

import type { Env } from './db';
import { handleApi } from './routes';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(request, env);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
