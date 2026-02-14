// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { VoiceInput } from './voice-input.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the auth store
vi.mock('../../stores/auth-store.js', () => ({
  useAuthStore: {
    getState: () => ({
      csrfToken: 'test-csrf-token',
    }),
  },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VoiceInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('should render the voice input button', () => {
    const onTranscription = vi.fn();
    render(<VoiceInput onTranscription={onTranscription} />);

    const button = screen.getByTestId('voice-input-button');
    expect(button).toBeDefined();
    expect(button.getAttribute('aria-label')).toBe('Start voice input');
  });

  it('should be disabled when disabled prop is true', () => {
    const onTranscription = vi.fn();
    render(<VoiceInput onTranscription={onTranscription} disabled />);

    const button = screen.getByTestId('voice-input-button');
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('should show microphone icon in idle state', () => {
    const onTranscription = vi.fn();
    render(<VoiceInput onTranscription={onTranscription} />);

    const button = screen.getByTestId('voice-input-button');
    // The button should contain an SVG (microphone icon)
    const svg = button.querySelector('svg');
    expect(svg).toBeDefined();
  });

  it('should show error when MediaRecorder is not supported', async () => {
    // Mock navigator.mediaDevices as undefined
    const original = navigator.mediaDevices;
    Object.defineProperty(navigator, 'mediaDevices', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    const onTranscription = vi.fn();
    render(<VoiceInput onTranscription={onTranscription} />);

    const button = screen.getByTestId('voice-input-button');
    fireEvent.click(button);

    // Should show error
    const error = await screen.findByTestId('voice-input-error');
    expect(error).toBeDefined();
    expect(error.textContent).toContain('not supported');

    // Restore
    Object.defineProperty(navigator, 'mediaDevices', {
      value: original,
      writable: true,
      configurable: true,
    });
  });

  it('should have correct title attribute for idle state', () => {
    const onTranscription = vi.fn();
    render(<VoiceInput onTranscription={onTranscription} />);

    const button = screen.getByTestId('voice-input-button');
    expect(button.getAttribute('title')).toBe('Voice input');
  });
});
