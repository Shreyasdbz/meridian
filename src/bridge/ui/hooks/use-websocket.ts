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

export function useWebSocket(options: UseWebSocketOptions = {}): UseWebSocketReturn {
  const { onMessage, enabled = true } = options;
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY_MS);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  // Use refs for values that async callbacks need to read at call time
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isAuthenticatedRef = useRef(isAuthenticated);
  isAuthenticatedRef.current = isAuthenticated;

  const send = useCallback((message: WSMessage): void => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  const scheduleReconnect = useCallback((connectFn: () => Promise<void>): void => {
    if (!enabledRef.current || !isAuthenticatedRef.current) return;

    const delay = reconnectDelayRef.current;
    reconnectDelayRef.current = Math.min(delay * RECONNECT_BACKOFF_FACTOR, MAX_RECONNECT_DELAY_MS);
    reconnectTimerRef.current = setTimeout(() => {
      void connectFn();
    }, delay);
  }, []);

  const connect = useCallback(async (): Promise<void> => {
    // Don't connect if already connected or not enabled
    if (
      wsRef.current?.readyState === WebSocket.OPEN ||
      !enabledRef.current ||
      !isAuthenticatedRef.current
    ) {
      return;
    }

    setConnectionState('connecting');

    try {
      // Step 1: Get a one-time connection token
      const { token } = await api.post<{ token: string }>('/ws/token');

      // Step 2: Open WebSocket
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
      wsRef.current = ws;

      ws.onopen = (): void => {
        setConnectionState('authenticating');
        // Step 3: Send the one-time token as the first message
        ws.send(JSON.stringify({ token }));
      };

      ws.onmessage = (event: MessageEvent): void => {
        try {
          const message = JSON.parse(event.data as string) as WSMessage;

          // Handle connected confirmation
          if (message.type === 'connected') {
            setConnectionState('connected');
            reconnectDelayRef.current = INITIAL_RECONNECT_DELAY_MS;
          }

          // Handle ping with pong
          if (message.type === 'ping') {
            send({ type: 'pong' });
            return;
          }

          // Forward to handler
          onMessageRef.current?.(message);
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = (event: CloseEvent): void => {
        wsRef.current = null;
        setConnectionState('disconnected');

        // 4001 = Session Expired (architecture Section 6.5.3).
        // Mark unauthenticated and do not reconnect.
        if (event.code === WS_CLOSE_SESSION_EXPIRED) {
          useAuthStore.getState().setAuthenticated(false);
          return;
        }

        scheduleReconnect(connect);
      };

      ws.onerror = (): void => {
        // onclose will fire after onerror, triggering reconnect
      };
    } catch {
      setConnectionState('disconnected');
      scheduleReconnect(connect);
    }
  }, [send, scheduleReconnect]);

  useEffect(() => {
    if (enabled && isAuthenticated) {
      void connect();
    }

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close(1000, 'Component unmounted');
        wsRef.current = null;
      }
    };
  }, [enabled, isAuthenticated, connect]);

  return { connectionState, send };
}
