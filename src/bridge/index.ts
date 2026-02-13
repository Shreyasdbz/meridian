// @meridian/bridge — public API

export {
  createServer,
  createBridgeServer,
  AuthService,
  authRoutes,
  authMiddleware,
  csrfMiddleware,
  containsCredentials,
  filterCredentials,
  detectSystemPromptLeakage,
} from './api/index.js';

export type {
  CreateServerOptions,
  BridgeServer,
  AxisAdapter,
  AuthServiceOptions,
  AuthMiddlewareOptions,
  CsrfMiddlewareOptions,
} from './api/index.js';
