// Chat text input with Cmd+Enter to send and Markdown support.

import { useCallback, useEffect, useRef } from 'react';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
  placeholder?: string;
}

/**
 * Auto-growing textarea input for chat messages.
 * - Cmd+Enter (Mac) / Ctrl+Enter (other) to send
 * - `/` shortcut focuses the input when pressed outside
 * - Auto-grows up to 8 lines
 */
export function ChatInput({
  value,
  onChange,
  onSend,
  disabled = false,
  placeholder = 'Message Meridian...',
}: ChatInputProps): React.ReactElement {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // Max ~8 lines (each ~24px)
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  // Handle Cmd+Enter to send
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!disabled && value.trim()) {
          onSend();
        }
      }
    },
    [disabled, value, onSend],
  );

  // Listen for focus-chat-input events from Layout shortcuts and Command Palette
  useEffect(() => {
    const handleFocusEvent = (): void => {
      textareaRef.current?.focus();
    };

    window.addEventListener('meridian:focus-chat-input', handleFocusEvent);
    return () => {
      window.removeEventListener('meridian:focus-chat-input', handleFocusEvent);
    };
  }, []);

  const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);
  const sendShortcutLabel = isMac ? '\u2318\u21A9' : 'Ctrl+\u21A9';

  return (
    <div className="border-t border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-end gap-2">
        <div className="relative flex-1">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => { onChange(e.target.value); }}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            className="w-full resize-none rounded-xl border border-gray-300 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-500 focus:border-meridian-500 focus:outline-none focus:ring-1 focus:ring-meridian-500 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-400 dark:focus:border-meridian-400 dark:focus:ring-meridian-400"
            aria-label="Message input"
            data-testid="chat-input"
          />
        </div>
        <button
          onClick={onSend}
          disabled={disabled || !value.trim()}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-meridian-500 text-white transition-colors hover:bg-meridian-600 disabled:opacity-40 disabled:hover:bg-meridian-500"
          aria-label="Send message"
          data-testid="send-button"
          title={`Send (${sendShortcutLabel})`}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"
            />
          </svg>
        </button>
      </div>
      <div className="mt-1 flex items-center justify-between px-1">
        <span className="text-[10px] text-gray-400 dark:text-gray-500">
          Markdown supported
        </span>
        <span className="text-[10px] text-gray-400 dark:text-gray-500">
          {sendShortcutLabel} to send
        </span>
      </div>
    </div>
  );
}
