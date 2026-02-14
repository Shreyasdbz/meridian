// @meridian/bridge — Voice transcription route (Phase 11.3)
// Accepts audio file uploads and delegates transcription to a configurable
// Whisper endpoint (Ollama local or external Whisper API).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { VoiceTranscriptionResult } from '@meridian/shared';
import {
  MAX_VOICE_UPLOAD_BYTES,
  VOICE_TRANSCRIPTION_TIMEOUT_MS,
} from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VoiceRouteOptions {
  /** Whisper API endpoint (default: http://localhost:11434) */
  whisperEndpoint?: string;
  logger?: VoiceRouteLogger;
}

export interface VoiceRouteLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_WHISPER_ENDPOINT = 'http://localhost:11434';

const ALLOWED_MIME_TYPES = new Set([
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
]);

const ALLOWED_EXTENSIONS = new Set([
  '.wav',
  '.mp3',
  '.webm',
  '.ogg',
  '.m4a',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate the MIME type of an uploaded audio file.
 * Checks both the declared MIME type and the file extension.
 */
function isValidAudioFile(
  mimeType: string | undefined,
  filename: string | undefined,
): boolean {
  if (mimeType && ALLOWED_MIME_TYPES.has(mimeType)) {
    return true;
  }

  if (filename) {
    const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
    if (ALLOWED_EXTENSIONS.has(ext)) {
      return true;
    }
  }

  return false;
}

/**
 * Send the audio buffer to the Whisper endpoint for transcription.
 */
async function transcribeAudio(
  audioBuffer: Buffer,
  endpoint: string,
  filename: string,
  signal: AbortSignal,
): Promise<VoiceTranscriptionResult> {
  // Build multipart/form-data manually to avoid external deps
  const boundary = `----MeridianVoice${Date.now()}`;
  const filenameClean = filename.replace(/[^a-zA-Z0-9._-]/g, '_');

  // Determine content type from extension
  const ext = filenameClean.slice(filenameClean.lastIndexOf('.')).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.webm': 'audio/webm',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
  };
  const contentType = mimeMap[ext] ?? 'application/octet-stream';

  // Build the multipart body
  const preamble = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filenameClean}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`,
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([preamble, audioBuffer, epilogue]);

  const startTime = Date.now();

  // Try Ollama-compatible whisper endpoint first
  const url = endpoint.includes('/v1/audio')
    ? endpoint
    : `${endpoint}/v1/audio/transcriptions`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
    signal,
  });

  const durationMs = Date.now() - startTime;

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(
      `Transcription service returned ${String(response.status)}: ${errorText.slice(0, 200)}`,
    );
  }

  const result = await response.json() as {
    text?: string;
    confidence?: number;
    language?: string;
  };

  return {
    text: result.text?.trim() ?? '',
    confidence: typeof result.confidence === 'number' ? result.confidence : 0.9,
    durationMs,
    language: result.language,
  };
}

// ---------------------------------------------------------------------------
// Minimal multipart parser (avoids adding @fastify/multipart dependency)
// ---------------------------------------------------------------------------

interface MultipartFile {
  filename: string | undefined;
  mimeType: string | undefined;
  data: Buffer;
}

function parseMultipartFile(
  body: Buffer,
  boundary: string,
): MultipartFile | null {
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const doubleCRLF = Buffer.from('\r\n\r\n');

  // Find the first boundary
  let start = body.indexOf(boundaryBuf);
  if (start === -1) return null;

  // Move past the boundary line
  start += boundaryBuf.length;

  // Find the end boundary
  const end = body.indexOf(boundaryBuf, start);
  if (end === -1) return null;

  // Extract this part (between first and second boundary)
  const part = body.subarray(start, end);

  // Find headers/body separator
  const headerEnd = part.indexOf(doubleCRLF);
  if (headerEnd === -1) return null;

  // Parse headers
  const headerStr = part.subarray(0, headerEnd).toString('utf-8');
  const dataStart = headerEnd + doubleCRLF.length;

  // Remove trailing \r\n before next boundary
  let dataEnd = part.length;
  if (part[dataEnd - 2] === 0x0d && part[dataEnd - 1] === 0x0a) {
    dataEnd -= 2;
  }

  const data = part.subarray(dataStart, dataEnd);

  // Extract filename from Content-Disposition
  const filenameMatch = headerStr.match(/filename="([^"]+)"/);
  const filename = filenameMatch ? filenameMatch[1] : undefined;

  // Extract Content-Type
  const typeMatch = headerStr.match(/Content-Type:\s*(\S+)/i);
  const mimeType = typeMatch ? typeMatch[1] : undefined;

  return { filename, mimeType, data };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerVoiceRoutes(
  app: FastifyInstance,
  options: VoiceRouteOptions,
): void {
  const endpoint = options.whisperEndpoint ?? DEFAULT_WHISPER_ENDPOINT;
  const logger = options.logger;

  // Register content type parser for multipart/form-data to receive raw buffer.
  // This avoids the need for @fastify/multipart while still handling file uploads.
  app.addContentTypeParser(
    'multipart/form-data',
    { bodyLimit: MAX_VOICE_UPLOAD_BYTES + 4096 }, // extra room for multipart headers
    (_request, payload, done) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;

      payload.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_VOICE_UPLOAD_BYTES + 4096) {
          done(new Error('VOICE_UPLOAD_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });

      payload.on('end', () => {
        done(null, Buffer.concat(chunks));
      });

      payload.on('error', (err: Error) => {
        done(err);
      });
    },
  );

  // POST /api/voice/transcribe — Transcribe audio to text
  app.post('/api/voice/transcribe', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            confidence: { type: 'number' },
            durationMs: { type: 'number' },
            language: { type: 'string' },
          },
          required: ['text', 'confidence', 'durationMs'],
        },
        400: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
        413: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
        503: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const contentType = request.headers['content-type'] ?? '';

    if (!contentType.includes('multipart/form-data')) {
      await reply.status(400).send({
        error: 'Expected multipart/form-data with an audio file',
      });
      return;
    }

    // Parse multipart boundary
    const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
    if (!boundaryMatch) {
      await reply.status(400).send({
        error: 'Missing multipart boundary',
      });
      return;
    }

    // Get the raw body from the content type parser
    const rawBody = request.body as Buffer;
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      await reply.status(400).send({
        error: 'No audio file found in request body',
      });
      return;
    }

    // Check size limit
    if (rawBody.length > MAX_VOICE_UPLOAD_BYTES + 4096) {
      await reply.status(413).send({
        error: `File exceeds maximum size of ${String(MAX_VOICE_UPLOAD_BYTES)} bytes`,
      });
      return;
    }

    // Extract file from multipart data
    const parsed = parseMultipartFile(rawBody, boundaryMatch[1] as string);
    if (!parsed) {
      await reply.status(400).send({
        error: 'No audio file found in request body',
      });
      return;
    }

    // Validate file type
    if (!isValidAudioFile(parsed.mimeType, parsed.filename)) {
      await reply.status(400).send({
        error: 'Unsupported audio format. Supported: wav, mp3, webm, ogg, m4a',
      });
      return;
    }

    // Validate file size
    if (parsed.data.length > MAX_VOICE_UPLOAD_BYTES) {
      await reply.status(413).send({
        error: `File exceeds maximum size of ${String(MAX_VOICE_UPLOAD_BYTES)} bytes`,
      });
      return;
    }

    if (parsed.data.length === 0) {
      await reply.status(400).send({
        error: 'Audio file is empty',
      });
      return;
    }

    // Transcribe
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, VOICE_TRANSCRIPTION_TIMEOUT_MS);

    try {
      logger?.info('Starting voice transcription', {
        component: 'bridge',
        fileSize: parsed.data.length,
        filename: parsed.filename,
      });

      const result = await transcribeAudio(
        parsed.data,
        endpoint,
        parsed.filename ?? 'audio.wav',
        controller.signal,
      );

      logger?.info('Voice transcription completed', {
        component: 'bridge',
        durationMs: result.durationMs,
        textLength: result.text.length,
      });

      await reply.send(result);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        logger?.warn('Voice transcription timed out', { component: 'bridge' });
        await reply.status(503).send({
          error: 'Transcription service timed out',
        });
        return;
      }

      const message = err instanceof Error ? err.message : 'Transcription failed';
      logger?.error('Voice transcription failed', {
        component: 'bridge',
        error: message,
      });

      // Check if it's a connection error (service unavailable)
      if (
        message.includes('ECONNREFUSED') ||
        message.includes('fetch failed') ||
        message.includes('network')
      ) {
        await reply.status(503).send({
          error: 'Transcription service is not available',
        });
        return;
      }

      await reply.status(503).send({
        error: `Transcription failed: ${message}`,
      });
    } finally {
      clearTimeout(timer);
    }
  });
}
