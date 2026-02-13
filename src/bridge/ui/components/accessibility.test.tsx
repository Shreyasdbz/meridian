// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

import { AccessibilitySection } from '../pages/settings/accessibility-section.js';
import { useSettingsStore, type FontSize } from '../stores/settings-store.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../hooks/use-api.js', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({
    highContrast: false,
    fontSize: 'default',
    reducedMotion: false,
    isLoaded: true,
    isSaving: false,
    saveError: null,
  });
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// AccessibilitySection
// ---------------------------------------------------------------------------

describe('AccessibilitySection', () => {
  describe('high contrast', () => {
    it('should render high contrast toggle switch', () => {
      render(<AccessibilitySection />);
      expect(
        screen.getByRole('switch', { name: /toggle high contrast/i }),
      ).toBeInTheDocument();
    });

    it('should set aria-checked=false when high contrast is off', () => {
      render(<AccessibilitySection />);
      expect(screen.getByRole('switch', { name: /toggle high contrast/i })).toHaveAttribute(
        'aria-checked',
        'false',
      );
    });

    it('should set aria-checked=true when high contrast is on', () => {
      useSettingsStore.setState({ highContrast: true });
      render(<AccessibilitySection />);
      expect(screen.getByRole('switch', { name: /toggle high contrast/i })).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });

    it('should toggle high contrast on click', async () => {
      const user = userEvent.setup();
      render(<AccessibilitySection />);

      await user.click(screen.getByRole('switch', { name: /toggle high contrast/i }));
      expect(useSettingsStore.getState().highContrast).toBe(true);
    });

    it('should show status text for enabled state', () => {
      useSettingsStore.setState({ highContrast: true });
      render(<AccessibilitySection />);
      expect(screen.getByText(/Enhanced contrast/)).toBeInTheDocument();
    });

    it('should show status text for disabled state', () => {
      render(<AccessibilitySection />);
      expect(screen.getByText(/Standard contrast mode/)).toBeInTheDocument();
    });
  });

  describe('font size', () => {
    it('should render font size radio buttons', () => {
      render(<AccessibilitySection />);

      const radioGroup = screen.getByRole('radiogroup', { name: /font size/i });
      expect(radioGroup).toBeInTheDocument();

      expect(screen.getByRole('radio', { name: 'Small' })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'Default' })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'Large' })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'Extra Large' })).toBeInTheDocument();
    });

    it('should mark the current font size as checked', () => {
      render(<AccessibilitySection />);
      expect(screen.getByRole('radio', { name: 'Default' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      expect(screen.getByRole('radio', { name: 'Large' })).toHaveAttribute(
        'aria-checked',
        'false',
      );
    });

    it('should change font size on click', async () => {
      const user = userEvent.setup();
      render(<AccessibilitySection />);

      await user.click(screen.getByRole('radio', { name: 'Large' }));
      expect(useSettingsStore.getState().fontSize).toBe('large');
    });

    it('should persist font size to localStorage', async () => {
      const user = userEvent.setup();
      render(<AccessibilitySection />);

      await user.click(screen.getByRole('radio', { name: 'Extra Large' }));

      const stored = localStorage.getItem('meridian-accessibility');
      expect(stored).toBeTruthy();
      const parsed = JSON.parse(stored ?? '{}') as { fontSize: FontSize };
      expect(parsed.fontSize).toBe('x-large');
    });
  });

  describe('reduced motion', () => {
    it('should render reduced motion toggle switch', () => {
      render(<AccessibilitySection />);
      expect(
        screen.getByRole('switch', { name: /toggle reduced motion/i }),
      ).toBeInTheDocument();
    });

    it('should set aria-checked=false when reduced motion is off', () => {
      render(<AccessibilitySection />);
      expect(screen.getByRole('switch', { name: /toggle reduced motion/i })).toHaveAttribute(
        'aria-checked',
        'false',
      );
    });

    it('should toggle reduced motion on click', async () => {
      const user = userEvent.setup();
      render(<AccessibilitySection />);

      await user.click(screen.getByRole('switch', { name: /toggle reduced motion/i }));
      expect(useSettingsStore.getState().reducedMotion).toBe(true);
    });

    it('should show status text for enabled state', () => {
      useSettingsStore.setState({ reducedMotion: true });
      render(<AccessibilitySection />);
      expect(screen.getByText(/Animations and transitions are minimized/)).toBeInTheDocument();
    });
  });

  describe('section structure', () => {
    it('should have a labeled section', () => {
      render(<AccessibilitySection />);
      const section = document.querySelector('[aria-labelledby="accessibility-heading"]');
      expect(section).toBeTruthy();
    });

    it('should render the heading', () => {
      render(<AccessibilitySection />);
      expect(screen.getByText('Accessibility')).toBeInTheDocument();
    });

    it('should mention WCAG compliance', () => {
      render(<AccessibilitySection />);
      expect(screen.getByText(/WCAG 2.1 AA/)).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// ARIA Attribute Verification (cross-component)
// ---------------------------------------------------------------------------

describe('ARIA attribute verification', () => {
  it('should have focus-visible styles on accessibility switches', () => {
    render(<AccessibilitySection />);
    const switches = screen.getAllByRole('switch');
    for (const sw of switches) {
      // Check that focus-visible ring classes are present
      expect(sw.className).toContain('focus-visible:ring');
    }
  });

  it('should use correct radio group pattern for font size', () => {
    render(<AccessibilitySection />);
    const radioGroup = screen.getByRole('radiogroup');
    const radios = screen.getAllByRole('radio');

    expect(radioGroup).toBeInTheDocument();
    expect(radios.length).toBe(4);

    // Exactly one should be checked
    const checked = radios.filter((r) => r.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Keyboard Navigation
// ---------------------------------------------------------------------------

describe('keyboard navigation', () => {
  it('should allow toggling high contrast with Space key via switch role', async () => {
    const user = userEvent.setup();
    render(<AccessibilitySection />);

    const toggle = screen.getByRole('switch', { name: /toggle high contrast/i });
    toggle.focus();
    await user.keyboard(' ');

    expect(useSettingsStore.getState().highContrast).toBe(true);
  });

  it('should allow toggling reduced motion with Space key via switch role', async () => {
    const user = userEvent.setup();
    render(<AccessibilitySection />);

    const toggle = screen.getByRole('switch', { name: /toggle reduced motion/i });
    toggle.focus();
    await user.keyboard(' ');

    expect(useSettingsStore.getState().reducedMotion).toBe(true);
  });

  it('should allow selecting font size with Enter key', async () => {
    const user = userEvent.setup();
    render(<AccessibilitySection />);

    const largeBtn = screen.getByRole('radio', { name: 'Large' });
    largeBtn.focus();
    await user.keyboard('{Enter}');

    expect(useSettingsStore.getState().fontSize).toBe('large');
  });
});
