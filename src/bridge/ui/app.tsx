import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { Layout } from './components/layout.js';
import { Spinner } from './components/spinner.js';
import { ThemeProvider } from './components/theme-provider.js';
import { api } from './hooks/use-api.js';
import { LoginPage } from './pages/login.js';
import { OnboardingWizard } from './pages/onboarding/index.js';
import { useAuthStore } from './stores/auth-store.js';
import { useConversationStore } from './stores/conversation-store.js';

export function App() {
  const isLoading = useAuthStore((s) => s.isLoading);
  const isSetupComplete = useAuthStore((s) => s.isSetupComplete);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const setSetupComplete = useAuthStore((s) => s.setSetupComplete);
  const setAuthenticated = useAuthStore((s) => s.setAuthenticated);
  const setCsrfToken = useAuthStore((s) => s.setCsrfToken);
  const setLoading = useAuthStore((s) => s.setLoading);

  useEffect(() => {
    const checkStatus = async (): Promise<void> => {
      try {
        // 1. Check if setup is complete
        const status = await api.get<{ setupComplete: boolean }>('/auth/status');
        setSetupComplete(status.setupComplete);

        if (status.setupComplete) {
          // 2. Try to validate existing session
          try {
            const session = await api.get<{
              sessionId: string;
              csrfToken: string;
            }>('/auth/session');
            setCsrfToken(session.csrfToken);
            setAuthenticated(true);
          } catch {
            // No valid session — user will see login page
            setAuthenticated(false);
          }
        }
      } catch {
        // Can't reach server — default to not set up
        setSetupComplete(false);
      } finally {
        setLoading(false);
      }
    };

    void checkStatus();
  }, [setSetupComplete, setAuthenticated, setCsrfToken, setLoading]);

  const handleOnboardingComplete = (starterPrompt?: string): void => {
    if (starterPrompt) {
      useConversationStore.getState().setInputValue(starterPrompt);
    }
  };

  return (
    <ThemeProvider>
      {isLoading ? (
        <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
          <Spinner size="lg" label="Loading Meridian..." />
        </div>
      ) : !isSetupComplete ? (
        <OnboardingWizard onComplete={handleOnboardingComplete} />
      ) : !isAuthenticated ? (
        <LoginPage />
      ) : (
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Layout />}>
              {/* Phase 7.3: Chat routes */}
              {/* Phase 7.4: Mission Control routes */}
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      )}
    </ThemeProvider>
  );
}
