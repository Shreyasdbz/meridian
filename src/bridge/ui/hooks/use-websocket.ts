// Singleton WebSocket connection shared across all components.
// Prevents duplicate message delivery when multiple components (ChatPage,
// MissionControl) each subscribe to WebSocket events.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { WSMessage } from '@meridian/shared';

import { useAuthStore } from '../stores/auth-store.js';

import { api } from './use-api.js';

type ConnectionState = 'disconnected' | 'connecting' | 'authenticating' | 'connected';

interface UseWebSocketOptions {
  onMessage?: (message: WSMessage) => void;
  enabled?: boolean;
}

interface UseWebSocketReturn {
  connectionState: ConnectionState;
  send: (message: WSMessage) => void;
}

const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;
const RECONNECT_BACKOFF_FACTOR = 2;
const WS_CLOSE_SESSION_EXPIRED = 4001;

// ---------------------------------------------------------------------------
// Module-level singleton state
// ---------------------------------------------------------------------------

type MessageHandler = (msg: WSMessage) => void;
type StateHandler = (state: ConnectionState) => void;

let sharedWs: WebSocket | null = null;
let sharedState: ConnectionState = 'disconnected';
let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let subscriberCount = 0;
let connecting = false;

const messageHandlers = new Set<MessageHandler>();
const stateHandlers = new Set<StateHandler>();

function setSharedState(state: ConnectionState): void {
  sharedState = state;
  for (const handler of stateHandlers) {
    handler(state);
  }
}

function sendShared(msg: WSMessage): void {
  if (sharedWs?.readyState === WebSocket.OPEN) {
    sharedWs.send(JSON.stringify(msg));
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer || subscriberCount <= 0) return;

  const isAuthenticated = useAuthStore.getState().isAuthenticated;
  if (!isAuthenticated) return;

  const delay = reconnectDelay;
  reconnectDelay = Math.min(delay * RECONNECT_BACKOFF_FACTOR, MAX_RECONNECT_DELAY_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectShared();
  }, delay);
}

async function connectShared(): Promise<void> {
  // Guard against concurrent connect calls and redundant connections
  if (
    connecting ||
    sharedWs?.readyState === WebSocket.OPEN ||
    sharedWs?.readyState === WebSocket.CONNECTING ||
    subscriberCount <= 0
  ) {
    return;
  }

  const isAuthenticated = useAuthStore.getState().isAuthenticated;
  if (!isAuthenticated) return;

  connecting = true;
  setSharedState('connecting');

  try {
    // Step 1: Get a one-time connection token
    const { token } = await api.post<{ token: string }>('/ws/token');

    // Step 2: Open WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
    sharedWs = ws;

    ws.onopen = (): void => {
      setSharedState('authenticating');
      // Step 3: Send the one-time token as the first message
      ws.send(JSON.stringify({ token }));
    };

    ws.onmessage = (event: MessageEvent): void => {
      try {
        const message = JSON.parse(event.data as string) as WSMessage;

        // Handle connected confirmation
        if (message.type === 'connected') {
          setSharedState('connected');
          reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        }

        // Handle ping with pong
        if (message.type === 'ping') {
          sendShared({ type: 'pong' });
          return;
        }

        // Dispatch to all subscribers
        for (const handler of messageHandlers) {
          handler(message);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = (event: CloseEvent): void => {
      sharedWs = null;
      connecting = false;
      setSharedState('disconnected');

      // 4001 = Session Expired (architecture Section 6.5.3)
      if (event.code === WS_CLOSE_SESSION_EXPIRED) {
        useAuthStore.getState().setAuthenticated(false);
        return;
      }

      scheduleReconnect();
    };

    ws.onerror = (): void => {
      // onclose will fire after onerror, triggering reconnect
    };

    connecting = false;
  } catch {
    connecting = false;
    setSharedState('disconnected');
    scheduleReconnect();
  }
}

function disconnectShared(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (sharedWs) {
    sharedWs.close(1000, 'All subscribers disconnected');
    sharedWs = null;
  }
  connecting = false;
  reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  setSharedState('disconnected');
}

// ---------------------------------------------------------------------------
// React hook — multiple components share the singleton connection
// ---------------------------------------------------------------------------

export function useWebSocket(options: UseWebSocketOptions = {}): UseWebSocketReturn {
  const { onMessage, enabled = true } = options;
  const [connectionState, setConnectionState] = useState<ConnectionState>(sharedState);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  // Keep onMessage in a ref so the subscription handler always calls the latest version
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    if (!enabled || !isAuthenticated) return;

    // Create a stable handler that reads from the ref
    const msgHandler: MessageHandler = (msg) => {
      onMessageRef.current?.(msg);
    };

    // Subscribe to the singleton
    subscriberCount++;
    messageHandlers.add(msgHandler);
    stateHandlers.add(setConnectionState);

    // Connect if not already connected
    void connectShared();

    // Sync current state
    setConnectionState(sharedState);

    return () => {
      subscriberCount--;
      messageHandlers.delete(msgHandler);
      stateHandlers.delete(setConnectionState);

      if (subscriberCount <= 0) {
        subscriberCount = 0;
        disconnectShared();
      }
    };
  }, [enabled, isAuthenticated]);

  const send = useCallback((message: WSMessage): void => {
    sendShared(message);
  }, []);

  return { connectionState, send };
}
