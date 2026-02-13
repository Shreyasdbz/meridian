// Individual message bubble with role-based styling and rich formatting.

import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { memo, useMemo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { Message } from '@meridian/shared';

import { PrivacyIndicator } from './privacy-indicator.js';

// Register commonly-used languages for syntax highlighting
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', shell);
hljs.registerLanguage('json', json);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('css', css);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);

interface MessageBubbleProps {
  message: Message;
  isStreaming?: boolean;
}

const ROLE_STYLES: Record<string, string> = {
  user:
    'bg-meridian-500 text-white self-end rounded-br-sm',
  assistant:
    'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100 self-start rounded-bl-sm',
  system:
    'bg-amber-50 text-amber-900 dark:bg-amber-900/20 dark:text-amber-200 self-center text-center border border-amber-200 dark:border-amber-800',
};

const ROLE_LABELS: Record<string, string> = {
  user: 'You',
  assistant: 'Meridian',
  system: 'System',
};

/**
 * A single message bubble with role-based visual styling and
 * rich Markdown rendering for assistant/system messages.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  isStreaming = false,
}: MessageBubbleProps): React.ReactElement {
  const roleStyle = ROLE_STYLES[message.role] ?? ROLE_STYLES.assistant;
  const roleLabel = ROLE_LABELS[message.role] ?? message.role;

  // Extract privacy metadata if present
  const isExternal = message.metadata
    ? Boolean(message.metadata.isExternal)
    : message.role === 'assistant';
  const providerName = message.metadata?.providerName as string | undefined;

  // User messages are plain text; assistant/system get Markdown rendering
  const shouldRenderMarkdown = message.role !== 'user';

  const formattedTime = useMemo(() => {
    if (!message.createdAt) return null;
    try {
      const date = new Date(message.createdAt);
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    } catch {
      return null;
    }
  }, [message.createdAt]);

  return (
    <div
      className={`flex max-w-[85%] flex-col gap-1 rounded-2xl px-4 py-2.5 ${roleStyle}`}
      data-testid={`message-${message.role}`}
      data-message-id={message.id}
    >
      {/* Role label for assistant and system messages */}
      {message.role !== 'user' && (
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium opacity-70">{roleLabel}</span>
          {message.role === 'assistant' && (
            <PrivacyIndicator isExternal={isExternal} providerName={providerName} />
          )}
        </div>
      )}

      {/* Message content */}
      <div className={shouldRenderMarkdown ? 'prose-chat' : ''}>
        {shouldRenderMarkdown ? (
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              // Code blocks with syntax highlighting
              code({ className, children, ...props }) {
                const match = /language-(\w+)/.exec(className ?? '');
                const lang = match?.[1];
                const isBlock = Boolean(match);
                if (isBlock) {
                  const rawText = Array.isArray(children)
                    ? children.map((c) => (typeof c === 'string' ? c : '')).join('')
                    : typeof children === 'string' ? children : '';
                  const code = rawText.replace(/\n$/, '');
                  let highlighted: string;
                  try {
                    highlighted = lang && hljs.getLanguage(lang)
                      ? hljs.highlight(code, { language: lang }).value
                      : hljs.highlightAuto(code).value;
                  } catch {
                    highlighted = code;
                  }
                  return (
                    <div className="my-2 overflow-hidden rounded-md">
                      {lang && (
                        <div className="bg-gray-700 px-3 py-1 text-xs text-gray-300 dark:bg-gray-900">
                          {lang}
                        </div>
                      )}
                      <pre className="overflow-x-auto bg-gray-800 p-3 text-sm text-gray-100 dark:bg-gray-950">
                        <code
                          className={`hljs ${className ?? ''}`}
                          dangerouslySetInnerHTML={{ __html: highlighted }}
                        />
                      </pre>
                    </div>
                  );
                }
                return (
                  <code
                    className="rounded bg-black/10 px-1 py-0.5 text-[0.875em] dark:bg-white/10"
                    {...props}
                  >
                    {children}
                  </code>
                );
              },
              // Tables with horizontal scroll
              table({ children }) {
                return (
                  <div className="my-2 overflow-x-auto">
                    <table className="min-w-full border-collapse text-sm">{children}</table>
                  </div>
                );
              },
              th({ children }) {
                return (
                  <th className="border-b border-gray-300 px-3 py-1.5 text-left font-semibold dark:border-gray-600">
                    {children}
                  </th>
                );
              },
              td({ children }) {
                return (
                  <td className="border-b border-gray-200 px-3 py-1.5 dark:border-gray-700">
                    {children}
                  </td>
                );
              },
              // Links open in new tab
              a({ href, children }) {
                return (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-meridian-600 underline hover:text-meridian-700 dark:text-meridian-400 dark:hover:text-meridian-300"
                  >
                    {children}
                  </a>
                );
              },
              // Images with max width
              img({ src, alt }) {
                return (
                  <img
                    src={src}
                    alt={alt ?? ''}
                    className="my-2 max-w-full rounded-lg"
                    loading="lazy"
                  />
                );
              },
            }}
          >
            {message.content}
          </Markdown>
        ) : (
          <span className="whitespace-pre-wrap break-words">{message.content}</span>
        )}

        {/* Streaming cursor */}
        {isStreaming && (
          <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-current" aria-hidden="true" />
        )}
      </div>

      {/* Timestamp */}
      {formattedTime && (
        <span className="mt-0.5 text-[10px] opacity-50">{formattedTime}</span>
      )}
    </div>
  );
});
