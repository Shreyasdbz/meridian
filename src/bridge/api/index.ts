// @meridian/bridge/api — public API

// Server
export { createServer } from './server.js';
export type { CreateServerOptions } from './server.js';
export { containsCredentials, filterCredentials, detectSystemPromptLeakage } from './server.js';

// Auth
export { AuthService, authRoutes } from './auth.js';
export type { AuthServiceOptions } from './auth.js';

// Middleware
export { authMiddleware, csrfMiddleware } from './middleware.js';
export type { AuthMiddlewareOptions, CsrfMiddlewareOptions } from './middleware.js';

// WebSocket
export { websocketRoutes } from './websocket.js';
export type { WebSocketOptions, WebSocketManager } from './websocket.js';

// Routes
export {
  healthRoutes,
  conversationRoutes,
  messageRoutes,
  jobRoutes,
  gearRoutes,
  configRoutes,
  memoryRoutes,
  auditRoutes,
  secretRoutes,
} from './routes/index.js';
export type {
  HealthRouteOptions,
  ConversationRouteOptions,
  MessageRouteOptions,
  JobRouteOptions,
  GearRouteOptions,
  ConfigRouteOptions,
  MemoryRouteOptions,
  AuditRouteOptions,
  AuditLogReader,
  QueryAuditOptions,
  SecretRouteOptions,
} from './routes/index.js';
