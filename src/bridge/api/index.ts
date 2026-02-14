// @meridian/bridge/api — public API

// Server
export { createServer, createBridgeServer } from './server.js';
export type { CreateServerOptions, BridgeServer, AxisAdapter } from './server.js';
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
  gearBriefRoutes,
  configRoutes,
  memoryRoutes,
  auditRoutes,
  secretRoutes,
  metricsRoutes,
  registerVoiceRoutes,
  registerTOTPRoutes,
  isTOTPEnabled,
  validateTOTPToken,
} from './routes/index.js';
export type {
  HealthRouteOptions,
  ComponentHealth,
  ConversationRouteOptions,
  MessageRouteOptions,
  JobRouteOptions,
  GearRouteOptions,
  GearBriefRouteOptions,
  ConfigRouteOptions,
  MemoryRouteOptions,
  AuditRouteOptions,
  AuditLogReader,
  QueryAuditOptions,
  SecretRouteOptions,
  MetricsRouteOptions,
  MetricsProvider,
  VoiceRouteOptions,
  VoiceRouteLogger,
  TOTPRouteOptions,
  TOTPRouteLogger,
} from './routes/index.js';
