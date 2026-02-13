// @meridian/bridge — Metrics endpoint (Section 12.2)
// Exposes internal metrics in Prometheus exposition format (opt-in).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Interface for the metrics collector (avoids bridge → axis dependency). */
export interface MetricsProvider {
  collect(): Promise<string>;
}

export interface MetricsRouteOptions {
  metricsProvider: MetricsProvider;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function metricsRoutes(
  server: FastifyInstance,
  options: MetricsRouteOptions,
): void {
  const { metricsProvider } = options;

  // GET /api/metrics — Prometheus exposition format
  server.get('/api/metrics', async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = await metricsProvider.collect();

    await reply
      .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(body);
  });
}
