// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { TOTPSection } from './totp-section.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockDelete = vi.fn();

vi.mock('../../hooks/use-api.js', () => ({
  api: {
    get: (...args: unknown[]) => mockGet(...args) as unknown,
    post: (...args: unknown[]) => mockPost(...args) as unknown,
    delete: (...args: unknown[]) => mockDelete(...args) as unknown,
  },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TOTPSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('should render loading state initially', () => {
    mockGet.mockReturnValue(new Promise(() => {})); // Never resolves
    render(<TOTPSection />);

    expect(screen.getByText('Loading TOTP status...')).toBeDefined();
  });

  it('should show enable button when TOTP is disabled', async () => {
    mockGet.mockResolvedValue({ enabled: false });
    render(<TOTPSection />);

    await waitFor(() => {
      expect(screen.getByTestId('totp-enable-button')).toBeDefined();
    });

    expect(screen.getByText('Enable Two-Factor Authentication')).toBeDefined();
  });

  it('should show enabled status when TOTP is active', async () => {
    mockGet.mockResolvedValue({ enabled: true });
    render(<TOTPSection />);

    await waitFor(() => {
      expect(screen.getByTestId('totp-enabled')).toBeDefined();
    });

    expect(screen.getByText('Two-factor authentication is enabled.')).toBeDefined();
  });

  it('should show setup data after clicking enable', async () => {
    mockGet.mockResolvedValue({ enabled: false });
    mockPost.mockResolvedValue({
      otpauthUri: 'otpauth://totp/Meridian:user?secret=ABCDEFGH&issuer=Meridian',
      secret: 'ABCDEFGH',
      backupCodes: ['11111111', '22222222', '33333333', '44444444', '55555555',
                     '66666666', '77777777', '88888888', '99999999', 'aaaaaaaa'],
    });

    render(<TOTPSection />);

    await waitFor(() => {
      expect(screen.getByTestId('totp-enable-button')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('totp-enable-button'));

    await waitFor(() => {
      expect(screen.getByTestId('totp-setup')).toBeDefined();
    });

    expect(screen.getByTestId('totp-secret').textContent).toBe('ABCDEFGH');
    expect(screen.getByTestId('totp-uri').textContent).toContain('otpauth://');
  });

  it('should proceed to verify step after clicking continue', async () => {
    mockGet.mockResolvedValue({ enabled: false });
    mockPost.mockResolvedValue({
      otpauthUri: 'otpauth://totp/test',
      secret: 'ABCDEFGH',
      backupCodes: ['11111111', '22222222', '33333333', '44444444', '55555555',
                     '66666666', '77777777', '88888888', '99999999', 'aaaaaaaa'],
    });

    render(<TOTPSection />);

    await waitFor(() => {
      expect(screen.getByTestId('totp-enable-button')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('totp-enable-button'));

    await waitFor(() => {
      expect(screen.getByTestId('totp-proceed-verify')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('totp-proceed-verify'));

    await waitFor(() => {
      expect(screen.getByTestId('totp-verify')).toBeDefined();
    });

    expect(screen.getByTestId('totp-verify-input')).toBeDefined();
    expect(screen.getByTestId('totp-verify-button')).toBeDefined();
  });

  it('should show backup codes after successful verification', async () => {
    mockGet.mockResolvedValue({ enabled: false });

    const backupCodes = ['11111111', '22222222', '33333333', '44444444', '55555555',
                          '66666666', '77777777', '88888888', '99999999', 'aaaaaaaa'];

    // First call is setup, second is verify
    mockPost
      .mockResolvedValueOnce({
        otpauthUri: 'otpauth://totp/test',
        secret: 'ABCDEFGH',
        backupCodes,
      })
      .mockResolvedValueOnce({ enabled: true });

    render(<TOTPSection />);

    await waitFor(() => {
      expect(screen.getByTestId('totp-enable-button')).toBeDefined();
    });

    // Setup
    fireEvent.click(screen.getByTestId('totp-enable-button'));

    await waitFor(() => {
      expect(screen.getByTestId('totp-proceed-verify')).toBeDefined();
    });

    // Go to verify
    fireEvent.click(screen.getByTestId('totp-proceed-verify'));

    await waitFor(() => {
      expect(screen.getByTestId('totp-verify-input')).toBeDefined();
    });

    // Enter token
    const input = screen.getByTestId('totp-verify-input');
    fireEvent.change(input, { target: { value: '123456' } });

    // Verify
    fireEvent.click(screen.getByTestId('totp-verify-button'));

    await waitFor(() => {
      expect(screen.getByTestId('totp-backup-codes')).toBeDefined();
    });

    // Check backup codes are displayed
    expect(screen.getByTestId('backup-code-0').textContent).toBe('11111111');
    expect(screen.getByTestId('backup-code-9').textContent).toBe('aaaaaaaa');
  });

  it('should show error on verification failure', async () => {
    mockGet.mockResolvedValue({ enabled: false });
    mockPost
      .mockResolvedValueOnce({
        otpauthUri: 'otpauth://totp/test',
        secret: 'ABCDEFGH',
        backupCodes: Array(10).fill('abcdef01'),
      })
      .mockRejectedValueOnce(new Error('Invalid TOTP token'));

    render(<TOTPSection />);

    await waitFor(() => {
      expect(screen.getByTestId('totp-enable-button')).toBeDefined();
    });

    // Setup
    fireEvent.click(screen.getByTestId('totp-enable-button'));

    await waitFor(() => {
      expect(screen.getByTestId('totp-proceed-verify')).toBeDefined();
    });

    // Go to verify
    fireEvent.click(screen.getByTestId('totp-proceed-verify'));

    await waitFor(() => {
      expect(screen.getByTestId('totp-verify-input')).toBeDefined();
    });

    // Enter token
    const input = screen.getByTestId('totp-verify-input');
    fireEvent.change(input, { target: { value: '000000' } });

    // Verify
    fireEvent.click(screen.getByTestId('totp-verify-button'));

    await waitFor(() => {
      expect(screen.getByTestId('totp-error')).toBeDefined();
    });

    expect(screen.getByTestId('totp-error').textContent).toContain('Invalid TOTP token');
  });

  it('should require 6 digits to enable verify button', async () => {
    mockGet.mockResolvedValue({ enabled: false });
    mockPost.mockResolvedValueOnce({
      otpauthUri: 'otpauth://totp/test',
      secret: 'ABCDEFGH',
      backupCodes: Array(10).fill('abcdef01'),
    });

    render(<TOTPSection />);

    await waitFor(() => {
      expect(screen.getByTestId('totp-enable-button')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('totp-enable-button'));

    await waitFor(() => {
      expect(screen.getByTestId('totp-proceed-verify')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('totp-proceed-verify'));

    await waitFor(() => {
      expect(screen.getByTestId('totp-verify-button')).toBeDefined();
    });

    // Button should be disabled without input
    const verifyButton = screen.getByTestId('totp-verify-button');
    expect(verifyButton.hasAttribute('disabled')).toBe(true);

    // Enter only 3 digits
    const input = screen.getByTestId('totp-verify-input');
    fireEvent.change(input, { target: { value: '123' } });
    expect(verifyButton.hasAttribute('disabled')).toBe(true);

    // Enter 6 digits
    fireEvent.change(input, { target: { value: '123456' } });
    expect(verifyButton.hasAttribute('disabled')).toBe(false);
  });

  it('should strip non-numeric characters from verify input', async () => {
    mockGet.mockResolvedValue({ enabled: false });
    mockPost.mockResolvedValueOnce({
      otpauthUri: 'otpauth://totp/test',
      secret: 'ABCDEFGH',
      backupCodes: Array(10).fill('abcdef01'),
    });

    render(<TOTPSection />);

    await waitFor(() => {
      expect(screen.getByTestId('totp-enable-button')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('totp-enable-button'));

    await waitFor(() => {
      expect(screen.getByTestId('totp-proceed-verify')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('totp-proceed-verify'));

    await waitFor(() => {
      expect(screen.getByTestId('totp-verify-input')).toBeDefined();
    });

    const input = screen.getByTestId('totp-verify-input');
    fireEvent.change(input, { target: { value: '12ab34' } });
    expect((input as HTMLInputElement).value).toBe('1234');
  });

  it('should display Two-Factor Authentication title', async () => {
    mockGet.mockResolvedValue({ enabled: false });
    render(<TOTPSection />);

    await waitFor(() => {
      expect(screen.getByText('Two-Factor Authentication')).toBeDefined();
    });
  });
});
