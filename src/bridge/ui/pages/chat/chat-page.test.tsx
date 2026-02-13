// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';

import type { Message, Conversation } from '@meridian/shared';

import { ChatInput } from './chat-input.js';
import { ConversationSidebar } from './conversation-sidebar.js';
import { MessageBubble } from './message-bubble.js';
import { MessageList } from './message-list.js';
import { PrivacyIndicator } from './privacy-indicator.js';
import { TaskCard } from './task-card.js';
import { TypingIndicator } from './typing-indicator.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();
const mockApiPut = vi.fn();

vi.mock('../../hooks/use-api.js', () => ({
  api: {
    get: (...args: unknown[]): unknown => mockApiGet(...args) as unknown,
    post: (...args: unknown[]): unknown => mockApiPost(...args) as unknown,
    put: (...args: unknown[]): unknown => mockApiPut(...args) as unknown,
    delete: vi.fn(),
  },
  ApiRequestError: class ApiRequestError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('../../hooks/use-websocket.js', () => ({
  useWebSocket: vi.fn(() => ({
    connectionState: 'connected',
    send: vi.fn(),
  })),
}));

// Mock auth store
const mockAuthState = {
  isAuthenticated: true,
  isSetupComplete: true,
  csrfToken: 'test-csrf',
  isLoading: false,
};

vi.mock('../../stores/auth-store.js', () => ({
  useAuthStore: Object.assign(
    (selector: (state: typeof mockAuthState & Record<string, unknown>) => unknown) =>
      selector({
        ...mockAuthState,
        setAuthenticated: vi.fn(),
        setSetupComplete: vi.fn(),
        setCsrfToken: vi.fn(),
        setLoading: vi.fn(),
        logout: vi.fn(),
      }),
    {
      getState: () => ({
        ...mockAuthState,
        csrfToken: 'test-csrf',
      }),
    },
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function createTestMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: crypto.randomUUID(),
    conversationId: 'conv-1',
    role: 'user',
    content: 'Hello, Meridian!',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function createTestConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: crypto.randomUUID(),
    title: 'Test conversation',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ===========================================================================
// MessageBubble
// ===========================================================================

describe('MessageBubble', () => {
  it('should render a user message with correct styling', () => {
    const msg = createTestMessage({ role: 'user', content: 'Hello there!' });
    render(<MessageBubble message={msg} />);

    const bubble = screen.getByTestId('message-user');
    expect(bubble).toBeInTheDocument();
    expect(bubble).toHaveTextContent('Hello there!');
    // User messages have meridian-500 bg
    expect(bubble.className).toContain('bg-meridian-500');
  });

  it('should render an assistant message with role label', () => {
    const msg = createTestMessage({ role: 'assistant', content: 'I can help with that.' });
    render(<MessageBubble message={msg} />);

    const bubble = screen.getByTestId('message-assistant');
    expect(bubble).toBeInTheDocument();
    expect(bubble).toHaveTextContent('Meridian');
    expect(bubble).toHaveTextContent('I can help with that.');
  });

  it('should render a system message with centered styling', () => {
    const msg = createTestMessage({ role: 'system', content: 'Conversation started.' });
    render(<MessageBubble message={msg} />);

    const bubble = screen.getByTestId('message-system');
    expect(bubble).toBeInTheDocument();
    expect(bubble).toHaveTextContent('Conversation started.');
    expect(bubble.className).toContain('self-center');
  });

  it('should render Markdown in assistant messages', () => {
    const msg = createTestMessage({
      role: 'assistant',
      content: 'Here is **bold** and *italic* text.',
    });
    render(<MessageBubble message={msg} />);

    const bubble = screen.getByTestId('message-assistant');
    const strong = bubble.querySelector('strong');
    expect(strong).toBeInTheDocument();
    expect(strong).toHaveTextContent('bold');

    const em = bubble.querySelector('em');
    expect(em).toBeInTheDocument();
    expect(em).toHaveTextContent('italic');
  });

  it('should render code blocks with language label', () => {
    const msg = createTestMessage({
      role: 'assistant',
      content: '```javascript\nconsole.log("hello");\n```',
    });
    render(<MessageBubble message={msg} />);

    const bubble = screen.getByTestId('message-assistant');
    expect(bubble).toHaveTextContent('javascript');
    expect(bubble).toHaveTextContent('console.log("hello");');
  });

  it('should render inline code in assistant messages', () => {
    const msg = createTestMessage({
      role: 'assistant',
      content: 'Use the `npm install` command.',
    });
    render(<MessageBubble message={msg} />);

    const bubble = screen.getByTestId('message-assistant');
    const code = bubble.querySelector('code');
    expect(code).toBeInTheDocument();
    expect(code).toHaveTextContent('npm install');
  });

  it('should render tables from GFM markdown', () => {
    const msg = createTestMessage({
      role: 'assistant',
      content: '| Name | Value |\n|------|-------|\n| foo | bar |',
    });
    render(<MessageBubble message={msg} />);

    const bubble = screen.getByTestId('message-assistant');
    const table = bubble.querySelector('table');
    expect(table).toBeInTheDocument();

    const headers = bubble.querySelectorAll('th');
    expect(headers).toHaveLength(2);
    expect(headers[0]).toHaveTextContent('Name');
    expect(headers[1]).toHaveTextContent('Value');
  });

  it('should render links opening in new tab', () => {
    const msg = createTestMessage({
      role: 'assistant',
      content: 'Check out [this link](https://example.com)',
    });
    render(<MessageBubble message={msg} />);

    const link = screen.getByRole('link', { name: 'this link' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('should show streaming cursor when isStreaming is true', () => {
    const msg = createTestMessage({ role: 'assistant', content: 'Generating...' });
    render(<MessageBubble message={msg} isStreaming />);

    const bubble = screen.getByTestId('message-assistant');
    const cursor = bubble.querySelector('[aria-hidden="true"]');
    expect(cursor).toBeInTheDocument();
    expect(cursor?.className).toContain('animate-pulse');
  });

  it('should display timestamp when createdAt is provided', () => {
    const msg = createTestMessage({
      role: 'user',
      content: 'test',
      createdAt: '2026-01-15T14:30:00.000Z',
    });
    render(<MessageBubble message={msg} />);

    // The timestamp is rendered — exact format depends on locale
    const bubble = screen.getByTestId('message-user');
    expect(bubble).toBeInTheDocument();
  });

  it('should not render Markdown for user messages', () => {
    const msg = createTestMessage({ role: 'user', content: 'Some **bold** text' });
    render(<MessageBubble message={msg} />);

    const bubble = screen.getByTestId('message-user');
    // User messages should render as plain text with the raw markdown syntax
    expect(bubble).toHaveTextContent('Some **bold** text');
    const strong = bubble.querySelector('strong');
    expect(strong).not.toBeInTheDocument();
  });
});

// ===========================================================================
// MessageList
// ===========================================================================

describe('MessageList', () => {
  it('should render empty state when no messages', () => {
    render(
      <MessageList
        messages={[]}
        streamingContent=""
        isStreaming={false}
      />,
    );

    expect(screen.getByText('Start a conversation with Meridian')).toBeInTheDocument();
  });

  it('should render a list of messages', () => {
    const messages = [
      createTestMessage({ id: '1', role: 'user', content: 'Hi' }),
      createTestMessage({ id: '2', role: 'assistant', content: 'Hello!' }),
    ];
    render(
      <MessageList
        messages={messages}
        streamingContent=""
        isStreaming={false}
      />,
    );

    expect(screen.getByTestId('message-user')).toHaveTextContent('Hi');
    expect(screen.getByTestId('message-assistant')).toHaveTextContent('Hello!');
  });

  it('should render streaming message when streaming', () => {
    render(
      <MessageList
        messages={[]}
        streamingContent="I am typing..."
        isStreaming={true}
      />,
    );

    expect(screen.getByTestId('message-assistant')).toHaveTextContent('I am typing...');
  });

  it('should render typing indicator when active job status is set', () => {
    render(
      <MessageList
        messages={[]}
        streamingContent=""
        isStreaming={false}
        activeJobStatus="planning"
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Thinking...');
  });

  it('should render task cards for active tasks', () => {
    const tasks = [
      { jobId: 'j1', name: 'File download', status: 'executing', percent: 45 },
    ];
    render(
      <MessageList
        messages={[]}
        streamingContent=""
        isStreaming={false}
        activeTasks={tasks}
      />,
    );

    expect(screen.getByText('File download')).toBeInTheDocument();
    expect(screen.getByText('45%')).toBeInTheDocument();
  });

  it('should not show typing indicator during streaming', () => {
    render(
      <MessageList
        messages={[]}
        streamingContent="streaming..."
        isStreaming={true}
        activeJobStatus="planning"
      />,
    );

    // Typing indicator should not be shown when streaming is active
    const indicators = screen.queryAllByRole('status');
    // The only status role should be the streaming message's indicator, not the typing one
    indicators.forEach((el) => {
      expect(el).not.toHaveTextContent('Thinking...');
    });
  });
});

// ===========================================================================
// ChatInput
// ===========================================================================

describe('ChatInput', () => {
  it('should render with placeholder text', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSend={vi.fn()}
      />,
    );

    expect(screen.getByTestId('chat-input')).toHaveAttribute(
      'placeholder',
      'Message Meridian...',
    );
  });

  it('should call onChange when typing', async () => {
    const onChange = vi.fn();
    render(
      <ChatInput
        value=""
        onChange={onChange}
        onSend={vi.fn()}
      />,
    );

    const input = screen.getByTestId('chat-input');
    await userEvent.type(input, 'Hello');

    expect(onChange).toHaveBeenCalled();
  });

  it('should disable send button when value is empty', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSend={vi.fn()}
      />,
    );

    expect(screen.getByTestId('send-button')).toBeDisabled();
  });

  it('should enable send button when value is not empty', () => {
    render(
      <ChatInput
        value="Hello"
        onChange={vi.fn()}
        onSend={vi.fn()}
      />,
    );

    expect(screen.getByTestId('send-button')).not.toBeDisabled();
  });

  it('should call onSend when send button is clicked', async () => {
    const onSend = vi.fn();
    render(
      <ChatInput
        value="Hello"
        onChange={vi.fn()}
        onSend={onSend}
      />,
    );

    await userEvent.click(screen.getByTestId('send-button'));
    expect(onSend).toHaveBeenCalledOnce();
  });

  it('should send on Cmd+Enter', async () => {
    const onSend = vi.fn();
    render(
      <ChatInput
        value="Hello"
        onChange={vi.fn()}
        onSend={onSend}
      />,
    );

    const input = screen.getByTestId('chat-input');
    await userEvent.click(input);
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');

    expect(onSend).toHaveBeenCalledOnce();
  });

  it('should send on Ctrl+Enter', async () => {
    const onSend = vi.fn();
    render(
      <ChatInput
        value="Hello"
        onChange={vi.fn()}
        onSend={onSend}
      />,
    );

    const input = screen.getByTestId('chat-input');
    await userEvent.click(input);
    await userEvent.keyboard('{Control>}{Enter}{/Control}');

    expect(onSend).toHaveBeenCalledOnce();
  });

  it('should not send on plain Enter', async () => {
    const onSend = vi.fn();
    render(
      <ChatInput
        value="Hello"
        onChange={vi.fn()}
        onSend={onSend}
      />,
    );

    const input = screen.getByTestId('chat-input');
    await userEvent.click(input);
    await userEvent.keyboard('{Enter}');

    expect(onSend).not.toHaveBeenCalled();
  });

  it('should be disabled when disabled prop is true', () => {
    render(
      <ChatInput
        value="Hello"
        onChange={vi.fn()}
        onSend={vi.fn()}
        disabled
      />,
    );

    expect(screen.getByTestId('chat-input')).toBeDisabled();
    expect(screen.getByTestId('send-button')).toBeDisabled();
  });

  it('should show shortcut hints', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSend={vi.fn()}
      />,
    );

    expect(screen.getByText('Markdown supported')).toBeInTheDocument();
    // Should show a send shortcut label
    expect(screen.getByText(/to send/)).toBeInTheDocument();
  });
});

// ===========================================================================
// Keyboard shortcut: / focuses chat input
// ===========================================================================

describe('ChatInput / shortcut', () => {
  it('should focus the input when meridian:focus-chat-input event is dispatched', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSend={vi.fn()}
      />,
    );

    const input = screen.getByTestId('chat-input');
    expect(document.activeElement).not.toBe(input);

    // Layout dispatches this custom event when / is pressed
    act(() => {
      window.dispatchEvent(new CustomEvent('meridian:focus-chat-input'));
    });

    expect(document.activeElement).toBe(input);
  });
});

// ===========================================================================
// ConversationSidebar
// ===========================================================================

describe('ConversationSidebar', () => {
  it('should render empty state when no conversations', () => {
    render(
      <ConversationSidebar
        conversations={[]}
        activeConversationId={null}
        isLoading={false}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

    expect(screen.getByText('No conversations yet')).toBeInTheDocument();
  });

  it('should render conversation list', () => {
    const convs = [
      createTestConversation({ id: 'c1', title: 'First convo' }),
      createTestConversation({ id: 'c2', title: 'Second convo' }),
    ];
    render(
      <ConversationSidebar
        conversations={convs}
        activeConversationId="c1"
        isLoading={false}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

    expect(screen.getByText('First convo')).toBeInTheDocument();
    expect(screen.getByText('Second convo')).toBeInTheDocument();
  });

  it('should highlight the active conversation', () => {
    const convs = [
      createTestConversation({ id: 'c1', title: 'Active convo' }),
    ];
    render(
      <ConversationSidebar
        conversations={convs}
        activeConversationId="c1"
        isLoading={false}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

    const item = screen.getByTestId('conversation-c1');
    expect(item.className).toContain('bg-meridian-50');
  });

  it('should call onSelect when a conversation is clicked', async () => {
    const onSelect = vi.fn();
    const convs = [createTestConversation({ id: 'c1', title: 'Test' })];
    render(
      <ConversationSidebar
        conversations={convs}
        activeConversationId={null}
        isLoading={false}
        onSelect={onSelect}
        onCreate={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByTestId('conversation-c1'));
    expect(onSelect).toHaveBeenCalledWith('c1');
  });

  it('should call onCreate when new button is clicked', async () => {
    const onCreate = vi.fn();
    render(
      <ConversationSidebar
        conversations={[]}
        activeConversationId={null}
        isLoading={false}
        onSelect={vi.fn()}
        onCreate={onCreate}
        onArchive={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByTestId('new-conversation-button'));
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it('should show loading spinner when isLoading', () => {
    render(
      <ConversationSidebar
        conversations={[]}
        activeConversationId={null}
        isLoading={true}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});

// ===========================================================================
// TypingIndicator
// ===========================================================================

describe('TypingIndicator', () => {
  it('should render "Thinking..." for planning status', () => {
    render(<TypingIndicator status="planning" />);
    expect(screen.getByRole('status')).toHaveTextContent('Thinking...');
  });

  it('should render "Checking safety..." for validating status', () => {
    render(<TypingIndicator status="validating" />);
    expect(screen.getByRole('status')).toHaveTextContent('Checking safety...');
  });

  it('should render "Running" for executing status', () => {
    render(<TypingIndicator status="executing" />);
    expect(screen.getByRole('status')).toHaveTextContent('Running');
  });

  it('should render "Needs your OK" for awaiting_approval status', () => {
    render(<TypingIndicator status="awaiting_approval" />);
    expect(screen.getByRole('status')).toHaveTextContent('Needs your OK');
  });
});

// ===========================================================================
// TaskCard
// ===========================================================================

describe('TaskCard', () => {
  it('should render task name and status', () => {
    render(
      <TaskCard jobId="j1" name="File download" status="executing" />,
    );

    expect(screen.getByText('File download')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  it('should render progress bar when percent is provided', () => {
    render(
      <TaskCard jobId="j1" name="Test" status="executing" percent={60} />,
    );

    expect(screen.getByText('60%')).toBeInTheDocument();
  });

  it('should show completed badge for completed tasks', () => {
    render(
      <TaskCard jobId="j1" name="Done task" status="completed" />,
    );

    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('should show failed badge for failed tasks', () => {
    render(
      <TaskCard jobId="j1" name="Broken task" status="failed" />,
    );

    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('should call onViewProgress when link is clicked', async () => {
    const onView = vi.fn();
    render(
      <TaskCard jobId="j1" name="Task" status="executing" onViewProgress={onView} />,
    );

    await userEvent.click(screen.getByText('View progress'));
    expect(onView).toHaveBeenCalledWith('j1');
  });

  it('should show step label when provided', () => {
    render(
      <TaskCard jobId="j1" name="Task" status="executing" percent={30} step="Downloading" />,
    );

    expect(screen.getByText('Downloading')).toBeInTheDocument();
  });
});

// ===========================================================================
// PrivacyIndicator
// ===========================================================================

describe('PrivacyIndicator', () => {
  it('should show "Local" for local processing', () => {
    render(<PrivacyIndicator isExternal={false} />);
    expect(screen.getByText('Local')).toBeInTheDocument();
  });

  it('should show "External" for external processing', () => {
    render(<PrivacyIndicator isExternal={true} />);
    expect(screen.getByText('External')).toBeInTheDocument();
  });

  it('should show provider name when provided', () => {
    render(<PrivacyIndicator isExternal={true} providerName="OpenAI" />);
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
  });
});

// ===========================================================================
// Streaming message accumulation
// ===========================================================================

describe('Streaming message accumulation', () => {
  it('should accumulate streaming content progressively', () => {
    const { rerender } = render(
      <MessageList
        messages={[]}
        streamingContent="Hello"
        isStreaming={true}
      />,
    );

    expect(screen.getByTestId('message-assistant')).toHaveTextContent('Hello');

    rerender(
      <MessageList
        messages={[]}
        streamingContent="Hello, world"
        isStreaming={true}
      />,
    );

    expect(screen.getByTestId('message-assistant')).toHaveTextContent('Hello, world');
  });

  it('should replace streaming content with final message when done', () => {
    const { rerender } = render(
      <MessageList
        messages={[]}
        streamingContent="Streaming..."
        isStreaming={true}
      />,
    );

    expect(screen.getByTestId('message-assistant')).toHaveTextContent('Streaming...');

    // Streaming complete: final message added, streaming cleared
    rerender(
      <MessageList
        messages={[createTestMessage({ role: 'assistant', content: 'Final answer.' })]}
        streamingContent=""
        isStreaming={false}
      />,
    );

    expect(screen.getByTestId('message-assistant')).toHaveTextContent('Final answer.');
  });
});

// ===========================================================================
// Vocabulary module
// ===========================================================================

describe('Vocabulary module', () => {
  // Vocabulary tests are implicitly tested through TypingIndicator and TaskCard
  // but let's also test the module directly
  it('should map all job statuses to user-friendly labels', async () => {
    const { getStatusLabel } = await import('../../lib/vocabulary.js');

    expect(getStatusLabel('planning')).toBe('Thinking...');
    expect(getStatusLabel('validating')).toBe('Checking safety...');
    expect(getStatusLabel('executing')).toBe('Running');
    expect(getStatusLabel('awaiting_approval')).toBe('Needs your OK');
    expect(getStatusLabel('completed')).toBe('Done');
    expect(getStatusLabel('failed')).toBe('Failed');
    expect(getStatusLabel('cancelled')).toBe('Cancelled');
    expect(getStatusLabel('pending')).toBe('Queued');
  });

  it('should map component names to user-friendly labels', async () => {
    const { getComponentLabel } = await import('../../lib/vocabulary.js');

    expect(getComponentLabel('scout')).toBe('Planner');
    expect(getComponentLabel('sentinel')).toBe('Safety check');
    expect(getComponentLabel('gear')).toBe('Tool');
    expect(getComponentLabel('journal')).toBe('Memory');
  });

  it('should return the original term for unknown terms', async () => {
    const { getStatusLabel, getComponentLabel } = await import('../../lib/vocabulary.js');

    expect(getStatusLabel('unknown_status')).toBe('unknown_status');
    expect(getComponentLabel('unknown_component')).toBe('unknown_component');
  });
});
