// @meridian/bridge/ui — public API

// Stores
export { useUIStore } from './stores/ui-store.js';
export { useAuthStore } from './stores/auth-store.js';
export { useConversationStore } from './stores/conversation-store.js';
export { useJobStore } from './stores/job-store.js';
export { useSettingsStore } from './stores/settings-store.js';

// Hooks
export { api, ApiRequestError } from './hooks/use-api.js';
export { useWebSocket } from './hooks/use-websocket.js';

// Components
export { Button } from './components/button.js';
export { Input } from './components/input.js';
export { Dialog } from './components/dialog.js';
export { ToastContainer } from './components/toast.js';
export { Badge } from './components/badge.js';
export { Spinner } from './components/spinner.js';
export { Card, CardHeader } from './components/card.js';
export { ThemeProvider } from './components/theme-provider.js';
export { Layout } from './components/layout.js';
export { ErrorDisplay } from './components/error-display/index.js';
export { CommandPalette } from './components/command-palette/index.js';

// Vocabulary
export {
  getStatusLabel,
  getComponentLabel,
  getTermLabel,
  getGearLabel,
} from './lib/vocabulary.js';

// Pages
export { OnboardingWizard } from './pages/onboarding/index.js';
export { LoginPage } from './pages/login.js';
export { ChatPage } from './pages/chat/index.js';
export { MissionControl } from './pages/mission-control/index.js';
export { SettingsPage } from './pages/settings/index.js';
