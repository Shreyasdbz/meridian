// @meridian/bridge — Configuration routes (Section 6.5)
// Get and update configuration (secrets redacted).
// Includes provider validation endpoint for onboarding (Phase 7.2).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { DatabaseClient, Logger } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfigRouteOptions {
  db: DatabaseClient;
  logger: Logger;
}

interface ConfigRow {
  key: string;
  value: string;
  updated_at: string;
}

type AiProvider = 'anthropic' | 'openai' | 'ollama';

interface ValidateProviderBody {
  provider: AiProvider;
  apiKey?: string;
}

interface ValidateProviderResponse {
  valid: boolean;
  error?: string;
  model?: string;
}

// ---------------------------------------------------------------------------
// Secret-redaction patterns
// ---------------------------------------------------------------------------

const SECRET_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
  /credential/i,
];

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((p) => p.test(key));
}

function redactValue(key: string, value: string): string {
  return isSecretKey(key) ? '***REDACTED***' : value;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function configRoutes(
  server: FastifyInstance,
  options: ConfigRouteOptions,
): void {
  const { db, logger } = options;

  // GET /api/config — Get configuration (secrets redacted)
  server.get('/api/config', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  value: { type: 'string' },
                  updatedAt: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const rows = await db.query<ConfigRow>(
      'meridian',
      'SELECT key, value, updated_at FROM config ORDER BY key',
    );

    const items = rows.map((r) => ({
      key: r.key,
      value: redactValue(r.key, r.value),
      updatedAt: r.updated_at,
    }));

    await reply.send({ items });
  });

  // PUT /api/config — Update configuration
  server.put('/api/config', {
    schema: {
      body: {
        type: 'object',
        required: ['key', 'value'],
        properties: {
          key: { type: 'string', minLength: 1, maxLength: 200 },
          value: { type: 'string', maxLength: 10000 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            value: { type: 'string' },
            updatedAt: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = request.body as { key: string; value: string };
    const now = new Date().toISOString();

    // Upsert: INSERT OR REPLACE
    await db.run(
      'meridian',
      `INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [body.key, body.value, now],
    );

    logger.info('Config updated', { key: body.key, component: 'bridge' });

    await reply.send({
      key: body.key,
      value: redactValue(body.key, body.value),
      updatedAt: now,
    });
  });

  // POST /api/config/validate-provider — Validate an AI provider key (Phase 7.2)
  server.post<{ Body: ValidateProviderBody }>('/api/config/validate-provider', {
    schema: {
      body: {
        type: 'object',
        required: ['provider'],
        properties: {
          provider: { type: 'string', enum: ['anthropic', 'openai', 'ollama'] },
          apiKey: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            valid: { type: 'boolean' },
            error: { type: 'string' },
            model: { type: 'string' },
          },
        },
      },
    },
  }, async (
    request: FastifyRequest<{ Body: ValidateProviderBody }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const { provider, apiKey } = request.body;
    const TIMEOUT_MS = 10_000;

    let result: ValidateProviderResponse;
    try {
      result = await validateProvider(provider, apiKey, TIMEOUT_MS);
    } catch {
      result = { valid: false, error: 'Unexpected validation error' };
    }

    logger.info('Provider validation attempted', {
      provider,
      valid: result.valid,
      component: 'bridge',
    });

    await reply.send(result);
  });
}

// ---------------------------------------------------------------------------
// Provider validation helpers (Phase 7.2)
// ---------------------------------------------------------------------------

const ABORT_TIMEOUT_MSG = 'Validation timed out';

async function validateProvider(
  provider: AiProvider,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<ValidateProviderResponse> {
  switch (provider) {
    case 'anthropic':
      return validateAnthropic(apiKey, timeoutMs);
    case 'openai':
      return validateOpenAI(apiKey, timeoutMs);
    case 'ollama':
      return validateOllama(timeoutMs);
  }
}

async function validateAnthropic(
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<ValidateProviderResponse> {
  if (!apiKey) {
    return { valid: false, error: 'API key is required for Anthropic' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: controller.signal,
    });

    if (response.ok) {
      return { valid: true, model: 'claude-sonnet-4-5-20250929' };
    }

    // 401 = bad key, anything else might still indicate the key works
    if (response.status === 401) {
      return { valid: false, error: 'Invalid API key' };
    }

    // 400 might be from request format but key itself may be valid
    // 429 means key is valid but rate-limited — treat as valid
    if (response.status === 429) {
      return { valid: true, model: 'claude-sonnet-4-5-20250929' };
    }

    const body = await response.text();
    return { valid: false, error: `API returned status ${String(response.status)}: ${body.slice(0, 200)}` };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { valid: false, error: ABORT_TIMEOUT_MSG };
    }
    const message = err instanceof Error ? err.message : 'Connection failed';
    return { valid: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

async function validateOpenAI(
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<ValidateProviderResponse> {
  if (!apiKey) {
    return { valid: false, error: 'API key is required for OpenAI' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);

  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });

    if (response.ok) {
      return { valid: true, model: 'gpt-4o' };
    }

    if (response.status === 401) {
      return { valid: false, error: 'Invalid API key' };
    }

    if (response.status === 429) {
      return { valid: true, model: 'gpt-4o' };
    }

    return { valid: false, error: `API returned status ${String(response.status)}` };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { valid: false, error: ABORT_TIMEOUT_MSG };
    }
    const message = err instanceof Error ? err.message : 'Connection failed';
    return { valid: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

async function validateOllama(timeoutMs: number): Promise<ValidateProviderResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);

  try {
    const response = await fetch('http://localhost:11434/api/tags', {
      method: 'GET',
      signal: controller.signal,
    });

    if (response.ok) {
      const data = await response.json() as { models?: Array<{ name: string }> };
      const firstModel = data.models?.[0]?.name ?? 'local';
      return { valid: true, model: firstModel };
    }

    return { valid: false, error: `Ollama returned status ${String(response.status)}` };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { valid: false, error: ABORT_TIMEOUT_MSG };
    }
    return { valid: false, error: 'Ollama is not running on localhost:11434' };
  } finally {
    clearTimeout(timer);
  }
}
