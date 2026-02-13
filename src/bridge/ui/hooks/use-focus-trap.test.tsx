// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, it, expect, afterEach } from 'vitest';

import { useFocusTrap } from './use-focus-trap.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function FocusTrapHarness({ initialActive = true }: { initialActive?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(initialActive);

  useFocusTrap(containerRef, active);

  return (
    <div>
      <button data-testid="outside-button">Outside</button>
      <div ref={containerRef} data-testid="trap-container">
        <button data-testid="first-button">First</button>
        <input data-testid="middle-input" />
        <button data-testid="last-button">Last</button>
      </div>
      <button
        data-testid="toggle-trap"
        onClick={() => { setActive(!active); }}
      >
        Toggle
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useFocusTrap', () => {
  it('should focus the first focusable element when activated', async () => {
    render(<FocusTrapHarness />);

    // Wait for async initial focus
    await new Promise((r) => { setTimeout(r, 10); });

    const firstButton = document.querySelector('[data-testid="first-button"]') as HTMLElement;
    expect(document.activeElement).toBe(firstButton);
  });

  it('should wrap focus from last to first on Tab', async () => {
    const user = userEvent.setup();
    render(<FocusTrapHarness />);

    await new Promise((r) => { setTimeout(r, 10); });

    const lastButton = document.querySelector('[data-testid="last-button"]') as HTMLElement;
    lastButton.focus();

    await user.tab();

    const firstButton = document.querySelector('[data-testid="first-button"]') as HTMLElement;
    expect(document.activeElement).toBe(firstButton);
  });

  it('should wrap focus from first to last on Shift+Tab', async () => {
    const user = userEvent.setup();
    render(<FocusTrapHarness />);

    await new Promise((r) => { setTimeout(r, 10); });

    const firstButton = document.querySelector('[data-testid="first-button"]') as HTMLElement;
    firstButton.focus();

    await user.tab({ shift: true });

    const lastButton = document.querySelector('[data-testid="last-button"]') as HTMLElement;
    expect(document.activeElement).toBe(lastButton);
  });

  it('should allow normal Tab navigation within the trap', async () => {
    const user = userEvent.setup();
    render(<FocusTrapHarness />);

    await new Promise((r) => { setTimeout(r, 10); });

    // Should start at first button
    const firstButton = document.querySelector('[data-testid="first-button"]') as HTMLElement;
    expect(document.activeElement).toBe(firstButton);

    // Tab to middle input
    await user.tab();
    const middleInput = document.querySelector('[data-testid="middle-input"]') as HTMLElement;
    expect(document.activeElement).toBe(middleInput);

    // Tab to last button
    await user.tab();
    const lastButton = document.querySelector('[data-testid="last-button"]') as HTMLElement;
    expect(document.activeElement).toBe(lastButton);
  });
});
