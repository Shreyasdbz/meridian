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
