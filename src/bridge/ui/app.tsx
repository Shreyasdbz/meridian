import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { Layout } from './components/layout.js';
import { ThemeProvider } from './components/theme-provider.js';

export function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Layout />}>
            {/* Phase 7.2: Onboarding wizard routes */}
            {/* Phase 7.3: Chat routes */}
            {/* Phase 7.4: Mission Control routes */}
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}
