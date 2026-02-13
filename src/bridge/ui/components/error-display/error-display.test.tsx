// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { ErrorDisplay, type SideEffect } from './error-display.js';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_PROPS = {
  message: 'Could not write to the file because it is read-only.',
};

const SIDE_EFFECTS: SideEffect[] = [
  { description: 'Created file report.txt', rollbackAvailable: true },
  { description: 'Fetched data from API', rollbackAvailable: false },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ErrorDisplay', () => {
  describe('rendering', () => {
    it('should render the error message', () => {
      render(<ErrorDisplay {...DEFAULT_PROPS} />);
      expect(screen.getByText(DEFAULT_PROPS.message)).toBeInTheDocument();
    });

    it('should render "Something went wrong" heading', () => {
      render(<ErrorDisplay {...DEFAULT_PROPS} />);
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });

    it('should render the error code when provided', () => {
      render(<ErrorDisplay {...DEFAULT_PROPS} code="EPERM" />);
      expect(screen.getByText(/EPERM/)).toBeInTheDocument();
    });

    it('should not render error code when not provided', () => {
      render(<ErrorDisplay {...DEFAULT_PROPS} />);
      expect(screen.queryByText(/Error code/)).not.toBeInTheDocument();
    });

    it('should have role="alert" for accessibility', () => {
      render(<ErrorDisplay {...DEFAULT_PROPS} />);
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    it('should render the suggestion text when provided', () => {
      render(
        <ErrorDisplay
          {...DEFAULT_PROPS}
          suggestion="Try a different file path."
        />,
      );
      expect(screen.getByText('Try a different file path.')).toBeInTheDocument();
    });
  });

  describe('expandable details', () => {
    it('should render "See Details" button when details are provided', () => {
      render(
        <ErrorDisplay {...DEFAULT_PROPS} details="Error: EPERM write denied" />,
      );
      expect(screen.getByText('See Details')).toBeInTheDocument();
    });

    it('should not render "See Details" button when no details', () => {
      render(<ErrorDisplay {...DEFAULT_PROPS} />);
      expect(screen.queryByText('See Details')).not.toBeInTheDocument();
    });

    it('should expand technical details on click', async () => {
      const user = userEvent.setup();
      render(
        <ErrorDisplay
          {...DEFAULT_PROPS}
          details="Error: EPERM write denied at /foo/bar"
        />,
      );

      const toggle = screen.getByText('See Details');
      expect(
        screen.queryByText('Error: EPERM write denied at /foo/bar'),
      ).not.toBeInTheDocument();

      await user.click(toggle);
      expect(
        screen.getByText('Error: EPERM write denied at /foo/bar'),
      ).toBeInTheDocument();
    });

    it('should collapse details on second click', async () => {
      const user = userEvent.setup();
      render(
        <ErrorDisplay {...DEFAULT_PROPS} details="stack trace here" />,
      );

      const toggle = screen.getByText('See Details');
      await user.click(toggle);
      expect(screen.getByText('stack trace here')).toBeInTheDocument();

      await user.click(toggle);
      expect(screen.queryByText('stack trace here')).not.toBeInTheDocument();
    });

    it('should set aria-expanded correctly', async () => {
      const user = userEvent.setup();
      render(
        <ErrorDisplay {...DEFAULT_PROPS} details="detail text" />,
      );

      const toggle = screen.getByText('See Details');
      expect(toggle).toHaveAttribute('aria-expanded', 'false');

      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
    });
  });

  describe('side-effect disclosure', () => {
    it('should render side-effects when provided', () => {
      render(<ErrorDisplay {...DEFAULT_PROPS} sideEffects={SIDE_EFFECTS} />);

      expect(screen.getByText('Created file report.txt')).toBeInTheDocument();
      expect(screen.getByText('Fetched data from API')).toBeInTheDocument();
    });

    it('should show header text explaining prior actions', () => {
      render(<ErrorDisplay {...DEFAULT_PROPS} sideEffects={SIDE_EFFECTS} />);

      expect(
        screen.getByText(
          'Before this error, the following actions were completed:',
        ),
      ).toBeInTheDocument();
    });

    it('should indicate which side-effects can be rolled back', () => {
      render(<ErrorDisplay {...DEFAULT_PROPS} sideEffects={SIDE_EFFECTS} />);

      expect(screen.getByText('Can undo')).toBeInTheDocument();
    });

    it('should not render side-effect section when empty', () => {
      render(<ErrorDisplay {...DEFAULT_PROPS} sideEffects={[]} />);

      expect(
        screen.queryByText(
          'Before this error, the following actions were completed:',
        ),
      ).not.toBeInTheDocument();
    });

    it('should render rollback button when rollback is available', () => {
      const onRollback = vi.fn();
      render(
        <ErrorDisplay
          {...DEFAULT_PROPS}
          sideEffects={SIDE_EFFECTS}
          onRollback={onRollback}
        />,
      );

      expect(
        screen.getByRole('button', { name: /Undo completed actions/i }),
      ).toBeInTheDocument();
    });

    it('should call onRollback when rollback button is clicked', async () => {
      const user = userEvent.setup();
      const onRollback = vi.fn();
      render(
        <ErrorDisplay
          {...DEFAULT_PROPS}
          sideEffects={SIDE_EFFECTS}
          onRollback={onRollback}
        />,
      );

      await user.click(
        screen.getByRole('button', { name: /Undo completed actions/i }),
      );
      expect(onRollback).toHaveBeenCalledOnce();
    });

    it('should show "Rolling back..." when isRollingBack is true', () => {
      render(
        <ErrorDisplay
          {...DEFAULT_PROPS}
          sideEffects={SIDE_EFFECTS}
          onRollback={vi.fn()}
          isRollingBack={true}
        />,
      );

      expect(
        screen.getByRole('button', { name: /Rolling back/i }),
      ).toBeInTheDocument();
    });

    it('should disable rollback button when rolling back', () => {
      render(
        <ErrorDisplay
          {...DEFAULT_PROPS}
          sideEffects={SIDE_EFFECTS}
          onRollback={vi.fn()}
          isRollingBack={true}
        />,
      );

      expect(
        screen.getByRole('button', { name: /Rolling back/i }),
      ).toBeDisabled();
    });

    it('should not show rollback button when no side-effects have rollback', () => {
      const noRollbackEffects: SideEffect[] = [
        { description: 'Sent email', rollbackAvailable: false },
      ];
      render(
        <ErrorDisplay
          {...DEFAULT_PROPS}
          sideEffects={noRollbackEffects}
          onRollback={vi.fn()}
        />,
      );

      expect(
        screen.queryByRole('button', { name: /Undo/i }),
      ).not.toBeInTheDocument();
    });
  });

  describe('action buttons', () => {
    it('should render retry button when onRetry is provided', () => {
      render(
        <ErrorDisplay {...DEFAULT_PROPS} onRetry={vi.fn()} />,
      );
      expect(
        screen.getByRole('button', { name: /Try a different approach/i }),
      ).toBeInTheDocument();
    });

    it('should call onRetry when retry button is clicked', async () => {
      const user = userEvent.setup();
      const onRetry = vi.fn();
      render(<ErrorDisplay {...DEFAULT_PROPS} onRetry={onRetry} />);

      await user.click(
        screen.getByRole('button', { name: /Try a different approach/i }),
      );
      expect(onRetry).toHaveBeenCalledOnce();
    });

    it('should render dismiss button when onDismiss is provided', () => {
      render(
        <ErrorDisplay {...DEFAULT_PROPS} onDismiss={vi.fn()} />,
      );
      expect(
        screen.getByRole('button', { name: /Dismiss/i }),
      ).toBeInTheDocument();
    });

    it('should call onDismiss when dismiss button is clicked', async () => {
      const user = userEvent.setup();
      const onDismiss = vi.fn();
      render(<ErrorDisplay {...DEFAULT_PROPS} onDismiss={onDismiss} />);

      await user.click(
        screen.getByRole('button', { name: /Dismiss/i }),
      );
      expect(onDismiss).toHaveBeenCalledOnce();
    });
  });
});
