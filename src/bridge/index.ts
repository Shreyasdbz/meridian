// @meridian/bridge — public API

export {
  createServer,
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
  AuthServiceOptions,
  AuthMiddlewareOptions,
  CsrfMiddlewareOptions,
} from './api/index.js';
