// Scrolling message thread with auto-scroll to latest message.

import { useEffect, useRef } from 'react';

import type { Message } from '@meridian/shared';

import { MessageBubble } from './message-bubble.js';
import { TaskCard } from './task-card.js';
import { TypingIndicator } from './typing-indicator.js';

interface ActiveTask {
  jobId: string;
  name: string;
  status: string;
  percent?: number;
  step?: string;
}

interface MessageListProps {
  messages: Message[];
  streamingContent: string;
  isStreaming: boolean;
  activeJobStatus?: string;
  activeTasks?: ActiveTask[];
  onViewTaskProgress?: (jobId: string) => void;
}

/**
 * Scrolling message list with auto-scroll to bottom.
 * Includes inline task reference cards for running tasks.
 */
export function MessageList({
  messages,
  streamingContent,
  isStreaming,
  activeJobStatus,
  activeTasks = [],
  onViewTaskProgress,
}: MessageListProps): React.ReactElement {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive or streaming updates
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Only auto-scroll if user is near the bottom (within 100px)
    const isNearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    if (isNearBottom && bottomRef.current?.scrollIntoView) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streamingContent]);

  // Build a streaming message to render inline
  const streamingMessage: Message | null =
    isStreaming && streamingContent
      ? {
          id: '__streaming__',
          conversationId: '',
          role: 'assistant',
          content: streamingContent,
        }
      : null;

  return (
    <div
      ref={containerRef}
      className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
      role="log"
      aria-label="Conversation messages"
    >
      {messages.length === 0 && !isStreaming && (
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <div className="mb-3 rounded-full bg-meridian-500/10 p-3">
            <svg
              className="h-6 w-6 text-meridian-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z"
              />
            </svg>
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Start a conversation with Meridian
          </p>
        </div>
      )}

      {messages.map((message) => (
        <div
          key={message.id}
          className={`flex ${
            message.role === 'user'
              ? 'justify-end'
              : message.role === 'system'
                ? 'justify-center'
                : 'justify-start'
          }`}
        >
          <MessageBubble message={message} />
        </div>
      ))}

      {/* Inline task cards for active tasks */}
      {activeTasks.map((task) => (
        <TaskCard
          key={task.jobId}
          jobId={task.jobId}
          name={task.name}
          status={task.status}
          percent={task.percent}
          step={task.step}
          onViewProgress={onViewTaskProgress}
        />
      ))}

      {/* Streaming message */}
      {streamingMessage && (
        <div className="flex justify-start">
          <MessageBubble message={streamingMessage} isStreaming />
        </div>
      )}

      {/* Typing indicator (shown when processing but not yet streaming) */}
      {activeJobStatus && !isStreaming && (
        <TypingIndicator status={activeJobStatus} />
      )}

      {/* Scroll anchor */}
      <div ref={bottomRef} />
    </div>
  );
}
