// router.tsx — view router without a dependency.
// The app is a single conversational surface; secondary surfaces
// (settings / memory) are overlays owned by App state.

export type Route = 'home';

export function resolveRoute(path: string): Route {
  void path;
  return 'home';
}
