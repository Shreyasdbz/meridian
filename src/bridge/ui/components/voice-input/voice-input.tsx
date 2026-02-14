// Voice input component with recording state indicator (Phase 11.3).
// Uses MediaRecorder API for recording and sends audio to /api/voice/transcribe.

import { useCallback, useRef, useState } from 'react';

import { useAuthStore } from '../../stores/auth-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type VoiceState = 'idle' | 'recording' | 'transcribing';

interface VoiceInputProps {
  onTranscription: (text: string) => void;
  disabled?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VoiceInput({
  onTranscription,
  disabled = false,
}: VoiceInputProps): React.ReactElement {
  const [state, setState] = useState<VoiceState>('idle');
  const [error, setError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const startRecording = useCallback(async () => {
    setError(null);

    // Check for MediaRecorder support
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- MediaRecorder may not exist in all browsers
    if (!navigator.mediaDevices) {
      setError('Voice input is not supported in this browser');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Prefer webm, fall back to what's available
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : MediaRecorder.isTypeSupported('audio/mp4')
            ? 'audio/mp4'
            : '';

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        // Stop all tracks to release the microphone
        stream.getTracks().forEach((track) => { track.stop(); });

        const blob = new Blob(chunksRef.current, {
          type: mimeType || 'audio/webm',
        });
        chunksRef.current = [];

        if (blob.size === 0) {
          setState('idle');
          setError('No audio recorded');
          return;
        }

        void transcribe(blob);
      };

      recorder.start();
      setState('recording');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to access microphone';
      if (message.includes('NotAllowedError') || message.includes('Permission denied')) {
        setError('Microphone access denied. Please allow microphone access.');
      } else {
        setError(message);
      }
    }
  }, []);

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
      setState('transcribing');
    }
  }, []);

  const transcribe = async (blob: Blob): Promise<void> => {
    setState('transcribing');
    setError(null);

    try {
      const csrfToken = useAuthStore.getState().csrfToken;

      // Build multipart form data
      const formData = new FormData();
      const extension = blob.type.includes('mp4') ? 'm4a' : 'webm';
      formData.append('file', blob, `recording.${extension}`);

      const headers: Record<string, string> = {};
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch('/api/voice/transcribe', {
        method: 'POST',
        headers,
        body: formData,
        credentials: 'same-origin',
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: 'Transcription failed' })) as {
          error?: string;
        };
        throw new Error(body.error ?? `Transcription failed (${String(response.status)})`);
      }

      const result = await response.json() as { text: string };

      if (result.text && result.text.trim().length > 0) {
        onTranscription(result.text.trim());
      } else {
        setError('No speech detected');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Transcription failed';
      setError(message);
    } finally {
      setState('idle');
    }
  };

  const handleClick = useCallback(() => {
    if (state === 'idle') {
      void startRecording();
    } else if (state === 'recording') {
      stopRecording();
    }
    // Do nothing if transcribing
  }, [state, startRecording, stopRecording]);

  const isActive = state === 'recording';
  const isTranscribing = state === 'transcribing';
  const isDisabled = disabled || isTranscribing;

  return (
    <div className="relative inline-flex flex-col items-center">
      <button
        type="button"
        onClick={handleClick}
        disabled={isDisabled}
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors ${
          isActive
            ? 'bg-red-500 text-white hover:bg-red-600'
            : isTranscribing
              ? 'bg-gray-300 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700'
        } disabled:opacity-40`}
        aria-label={
          isActive
            ? 'Stop recording'
            : isTranscribing
              ? 'Transcribing audio...'
              : 'Start voice input'
        }
        data-testid="voice-input-button"
        title={
          isActive
            ? 'Click to stop recording'
            : isTranscribing
              ? 'Transcribing...'
              : 'Voice input'
        }
      >
        {isTranscribing ? (
          /* Loading spinner */
          <svg
            className="h-4 w-4 animate-spin"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        ) : isActive ? (
          /* Pulsing recording indicator */
          <div className="relative flex items-center justify-center">
            <div className="absolute h-6 w-6 animate-ping rounded-full bg-red-400 opacity-40" />
            <svg
              className="relative h-4 w-4"
              fill="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </div>
        ) : (
          /* Microphone icon */
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4M12 15a3 3 0 003-3V5a3 3 0 00-6 0v7a3 3 0 003 3z"
            />
          </svg>
        )}
      </button>

      {/* Error message */}
      {error && (
        <div
          className="absolute -bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-red-100 px-2 py-0.5 text-[10px] text-red-700 dark:bg-red-900/50 dark:text-red-300"
          role="alert"
          data-testid="voice-input-error"
        >
          {error}
        </div>
      )}
    </div>
  );
}
