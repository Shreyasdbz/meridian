// Session management section.

import { Button } from '../../components/button.js';
import { Card, CardHeader } from '../../components/card.js';
import { api } from '../../hooks/use-api.js';
import { useAuthStore } from '../../stores/auth-store.js';

export function SessionSection(): React.ReactElement {
  const logout = useAuthStore((s) => s.logout);

  const handleLogout = async (): Promise<void> => {
    try {
      await api.post('/auth/logout');
    } catch {
      // Proceed with client-side logout even if server call fails
    }
    logout();
  };

  return (
    <Card>
      <CardHeader
        title="Session"
        description="Manage your current session."
      />
      <div className="mt-4">
        <Button
          variant="danger"
          size="sm"
          onClick={() => { void handleLogout(); }}
        >
          Log out
        </Button>
      </div>
    </Card>
  );
}
