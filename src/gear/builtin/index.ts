// @meridian/gear/builtin — builtin Gear plugins

// File Manager — file operations within the workspace (Phase 5.4)
export { execute as fileManagerExecute } from './file-manager/index.js';

// Web Fetch — HTTPS page and JSON API fetching (Phase 5.5)
export { execute as webFetchExecute } from './web-fetch/index.js';

// Shell — shell command execution with special hardening (Phase 5.6)
export { execute as shellExecute } from './shell/index.js';

// Web Search — DuckDuckGo web search (Phase 9.3)
export { execute as webSearchExecute } from './web-search/index.js';

// Scheduler — cron schedule management (Phase 9.3)
export { execute as schedulerExecute } from './scheduler/index.js';

// Notification — user notification sending (Phase 9.3)
export { execute as notificationExecute } from './notification/index.js';
