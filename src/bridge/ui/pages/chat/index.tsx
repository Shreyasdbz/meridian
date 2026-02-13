// Chat page container (Phase 7.3)
// Orchestrates conversation sidebar, message list, input, and WebSocket streaming.

import { useCallback, useEffect, useRef } from 'react';

import type { Conversation, Message, WSMessage } from '@meridian/shared';

import { api } from '../../hooks/use-api.js';
import { useWebSocket } from '../../hooks/use-websocket.js';
import { useConversationStore } from '../../stores/conversation-store.js';
import { useUIStore } from '../../stores/ui-store.js';

import { ChatInput } from './chat-input.js';
import { ConversationSidebar } from './conversation-sidebar.js';
import { MessageList } from './message-list.js';

const AUTO_NEW_CONVERSATION_MS = 30 * 60 * 1000; // 30 minutes

interface ConversationsResponse {
  conversations: Conversation[];
  total: number;
}

interface ConversationWithMessages {
  id: string;
  title: string;
  status: string;
  messages: Message[];
}

/**
 * Main chat page composing sidebar, message thread, and input.
 * Manages WebSocket streaming and conversation lifecycle.
 */
export function ChatPage(): React.ReactElement {
  const conversations = useConversationStore((s) => s.conversations);
  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const messages = useConversationStore((s) => s.messages);
  const isStreaming = useConversationStore((s) => s.isStreaming);
  const streamingContent = useConversationStore((s) => s.streamingContent);
  const inputValue = useConversationStore((s) => s.inputValue);
  const isLoading = useConversationStore((s) => s.isLoading);

  const setConversations = useConversationStore((s) => s.setConversations);
  const setActiveConversationId = useConversationStore((s) => s.setActiveConversationId);
  const setMessages = useConversationStore((s) => s.setMessages);
  const addMessage = useConversationStore((s) => s.addMessage);
  const setStreaming = useConversationStore((s) => s.setStreaming);
  const appendStreamingContent = useConversationStore((s) => s.appendStreamingContent);
  const clearStreamingContent = useConversationStore((s) => s.clearStreamingContent);
  const setInputValue = useConversationStore((s) => s.setInputValue);
  const setLoading = useConversationStore((s) => s.setLoading);

  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setActiveView = useUIStore((s) => s.setActiveView);

  // Track last activity for auto-new-conversation
  const lastActivityRef = useRef(Date.now());
  const activeJobStatusRef = useRef<string | null>(null);

  // --- WebSocket message handler ---
  const handleWSMessage = useCallback(
    (msg: WSMessage) => {
      switch (msg.type) {
        case 'chunk': {
          if (!isStreaming) setStreaming(true);
          appendStreamingContent(msg.content);
          if (msg.done) {
            // Streaming complete — add the full message
            const fullContent = useConversationStore.getState().streamingContent;
            addMessage({
              id: crypto.randomUUID(),
              conversationId: activeConversationId ?? '',
              role: 'assistant',
              content: fullContent,
              jobId: msg.jobId,
            });
            clearStreamingContent();
            setStreaming(false);
          }
          break;
        }
        case 'status': {
          activeJobStatusRef.current = msg.status;
          break;
        }
        case 'error': {
          if (msg.jobId) {
            addMessage({
              id: crypto.randomUUID(),
              conversationId: activeConversationId ?? '',
              role: 'system',
              content: `Error: ${msg.message}`,
              jobId: msg.jobId,
            });
          }
          setStreaming(false);
          clearStreamingContent();
          break;
        }
        case 'result': {
          activeJobStatusRef.current = null;
          break;
        }
        default:
          break;
      }
    },
    [
      activeConversationId,
      isStreaming,
      addMessage,
      appendStreamingContent,
      clearStreamingContent,
      setStreaming,
    ],
  );

  useWebSocket({ onMessage: handleWSMessage, enabled: true });

  // --- Load conversations on mount ---
  useEffect(() => {
    const loadConversations = async (): Promise<void> => {
      setLoading(true);
      try {
        const data = await api.get<ConversationsResponse>('/conversations');
        setConversations(data.conversations);

        // Auto-select first conversation if none active
        const first = data.conversations[0];
        if (!activeConversationId && first) {
          setActiveConversationId(first.id);
        }
      } catch {
        // Failed to load — will show empty state
      } finally {
        setLoading(false);
      }
    };

    void loadConversations();
  }, []);
  // --- Load messages when active conversation changes ---
  useEffect(() => {
    if (!activeConversationId) return;

    const loadMessages = async (): Promise<void> => {
      try {
        const data = await api.get<ConversationWithMessages>(
          `/conversations/${activeConversationId}`,
        );
        setMessages(data.messages);
      } catch {
        setMessages([]);
      }
    };

    void loadMessages();
  }, [activeConversationId, setMessages]);

  // --- Auto-create new conversation after 30 min inactivity ---
  useEffect(() => {
    const interval = setInterval(() => {
      const elapsed = Date.now() - lastActivityRef.current;
      if (elapsed >= AUTO_NEW_CONVERSATION_MS && messages.length > 0) {
        void handleCreateConversation();
      }
    }, 60_000); // Check every minute

    return () => { clearInterval(interval); };
  }, [messages.length]);
  // --- Handlers ---

  const handleCreateConversation = useCallback(async (): Promise<void> => {
    try {
      const conv = await api.post<Conversation>('/conversations', {
        title: 'New conversation',
      });
      setConversations([conv, ...conversations]);
      setActiveConversationId(conv.id);
    } catch {
      // Failed to create
    }
  }, [conversations, setConversations, setActiveConversationId]);

  const handleSelectConversation = useCallback(
    (id: string) => {
      setActiveConversationId(id);
      lastActivityRef.current = Date.now();
    },
    [setActiveConversationId],
  );

  const handleArchiveConversation = useCallback(
    async (id: string): Promise<void> => {
      try {
        await api.put(`/conversations/${id}/archive`);
        setConversations(conversations.filter((c) => c.id !== id));
        if (activeConversationId === id) {
          const remaining = conversations.filter((c) => c.id !== id);
          setActiveConversationId(remaining[0]?.id ?? null);
        }
      } catch {
        // Failed to archive
      }
    },
    [conversations, activeConversationId, setConversations, setActiveConversationId],
  );

  const handleSend = useCallback(async (): Promise<void> => {
    const content = inputValue.trim();
    if (!content) return;

    lastActivityRef.current = Date.now();

    // If no active conversation, create one first
    let conversationId = activeConversationId;
    if (!conversationId) {
      try {
        const conv = await api.post<Conversation>('/conversations', {
          title: content.slice(0, 60),
        });
        setConversations([conv, ...conversations]);
        setActiveConversationId(conv.id);
        conversationId = conv.id;
      } catch {
        return;
      }
    }

    // Add user message optimistically
    const userMessage: Message = {
      id: crypto.randomUUID(),
      conversationId,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    };
    addMessage(userMessage);
    setInputValue('');

    // Send to API (creates a job via Axis)
    try {
      await api.post('/messages', {
        conversationId,
        content,
      });
    } catch {
      addMessage({
        id: crypto.randomUUID(),
        conversationId,
        role: 'system',
        content: 'Failed to send message. Please try again.',
      });
    }
  }, [
    inputValue,
    activeConversationId,
    conversations,
    addMessage,
    setInputValue,
    setConversations,
    setActiveConversationId,
  ]);

  const handleViewTaskProgress = useCallback(
    (_jobId: string) => {
      setActiveView('mission-control');
    },
    [setActiveView],
  );

  return (
    <div className="flex h-full" data-testid="chat-page">
      {/* Sidebar */}
      {sidebarOpen && (
        <ConversationSidebar
          conversations={conversations}
          activeConversationId={activeConversationId}
          isLoading={isLoading}
          onSelect={handleSelectConversation}
          onCreate={() => { void handleCreateConversation(); }}
          onArchive={(id) => { void handleArchiveConversation(id); }}
        />
      )}

      {/* Main chat area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <MessageList
          messages={messages}
          streamingContent={streamingContent}
          isStreaming={isStreaming}
          activeJobStatus={activeJobStatusRef.current ?? undefined}
          onViewTaskProgress={handleViewTaskProgress}
        />
        <ChatInput
          value={inputValue}
          onChange={setInputValue}
          onSend={() => { void handleSend(); }}
          disabled={isStreaming}
        />
      </div>
    </div>
  );
}
