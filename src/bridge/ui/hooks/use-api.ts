import { useAuthStore } from '../stores/auth-store.js';

const BASE_URL = '/api';

interface ApiError {
  status: number;
  error: string;
}

class ApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrfToken = useAuthStore.getState().csrfToken;

  const headers: Record<string, string> = {
    ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers as Record<string, string> | undefined),
  };

  // Attach CSRF token for state-changing requests
  if (csrfToken && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(options.method ?? '')) {
    headers['X-CSRF-Token'] = csrfToken;
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
    credentials: 'same-origin',
  });

  if (!response.ok) {
    let errorMessage = `Request failed with status ${String(response.status)}`;
    try {
      const body = (await response.json()) as ApiError;
      if (body.error) {
        errorMessage = body.error;
      }
    } catch {
      // Use default error message
    }

    // If unauthorized, update auth state
    if (response.status === 401) {
      useAuthStore.getState().setAuthenticated(false);
    }

    throw new ApiRequestError(response.status, errorMessage);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export const api = {
  get<T>(path: string): Promise<T> {
    return request<T>(path, { method: 'GET' });
  },

  post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  },

  put<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, {
      method: 'PUT',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  },

  delete<T>(path: string): Promise<T> {
    return request<T>(path, { method: 'DELETE' });
  },
};

export { ApiRequestError };
