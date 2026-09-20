import type { ReactNode } from 'react';

// providers.tsx — composition root for cross-cutting providers.
// Zustand stores need no context provider; this stays as the extension point
// (theme, error boundary, future router) without adding ceremony today.
export function AppProviders({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
