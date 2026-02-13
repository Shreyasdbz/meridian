import { useEffect, useRef, type RefObject } from 'react';

/**
 * Traps keyboard focus within a container element.
 * When active, Tab and Shift+Tab cycle through focusable elements
 * inside the container. Focus is restored to the previously-focused
 * element when the trap is deactivated.
 *
 * Section 5.5.14 — Focus management for dialogs and modals.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;

    // Store the currently focused element for restoration
    previousFocusRef.current = document.activeElement as HTMLElement | null;

    const container = containerRef.current;
    if (!container) return;

    // Focus the first focusable element inside the container
    const focusFirst = (): void => {
      const focusable = getFocusableElements(container);
      if (focusable.length > 0) {
        focusable[0]?.focus();
      } else {
        // If no focusable children, focus the container itself
        container.setAttribute('tabindex', '-1');
        container.focus();
      }
    };

    // Small delay to allow DOM to settle (e.g. dialog opening animation)
    const initialFocusTimer = setTimeout(focusFirst, 0);

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;

      const focusable = getFocusableElements(container);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        // Shift+Tab: if focus is on the first element, wrap to last
        if (document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        // Tab: if focus is on the last element, wrap to first
        if (document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      clearTimeout(initialFocusTimer);
      document.removeEventListener('keydown', handleKeyDown);

      // Restore focus to the previously focused element (if still in DOM)
      if (
        previousFocusRef.current &&
        typeof previousFocusRef.current.focus === 'function' &&
        document.contains(previousFocusRef.current)
      ) {
        previousFocusRef.current.focus();
      }
    };
  }, [active, containerRef]);
}

/**
 * Returns all focusable elements within a container, in DOM order.
 */
function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(', ');

  return Array.from(container.querySelectorAll<HTMLElement>(selector));
}
