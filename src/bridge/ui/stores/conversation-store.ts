import { create } from 'zustand';

import type { Conversation, Message } from '@meridian/shared';

interface ConversationState {
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: Message[];
  isStreaming: boolean;
  streamingContent: string;
  inputValue: string;
  isLoading: boolean;
}

interface ConversationActions {
  setConversations: (conversations: Conversation[]) => void;
  setActiveConversationId: (id: string | null) => void;
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  setStreaming: (streaming: boolean) => void;
  appendStreamingContent: (content: string) => void;
  clearStreamingContent: () => void;
  setInputValue: (value: string) => void;
  setLoading: (loading: boolean) => void;
}

type ConversationStore = ConversationState & ConversationActions;

export const useConversationStore = create<ConversationStore>((set) => ({
  conversations: [],
  activeConversationId: null,
  messages: [],
  isStreaming: false,
  streamingContent: '',
  inputValue: '',
  isLoading: false,

  setConversations: (conversations) => {
    set({ conversations });
  },

  setActiveConversationId: (id) => {
    set({ activeConversationId: id, messages: [], streamingContent: '' });
  },

  setMessages: (messages) => {
    set({ messages });
  },

  addMessage: (message) => {
    set((state) => ({ messages: [...state.messages, message] }));
  },

  setStreaming: (streaming) => {
    set({ isStreaming: streaming });
  },

  appendStreamingContent: (content) => {
    set((state) => ({ streamingContent: state.streamingContent + content }));
  },

  clearStreamingContent: () => {
    set({ streamingContent: '' });
  },

  setInputValue: (value) => {
    set({ inputValue: value });
  },

  setLoading: (loading) => {
    set({ isLoading: loading });
  },
}));
