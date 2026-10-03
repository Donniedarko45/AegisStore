import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from './components/app/shell';
import { Spinner } from './components/ui/spinner';
import { LiveConnection } from './lib/live';
import { useMe } from './lib/queries';
import { lazy, Suspense } from 'react';

// Route-level code splitting: each page (and its chart libraries) loads on first visit.
const named = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, key: K) => lazy(() => load().then((m) => ({ default: m[key] })));
const OverviewPage = named(() => import('./pages/overview'), 'OverviewPage');
const AnalyticsPage = named(() => import('./pages/analytics'), 'AnalyticsPage');
const BucketsPage = named(() => import('./pages/buckets'), 'BucketsPage');
const BucketPage = named(() => import('./pages/bucket'), 'BucketPage');
const NodesPage = named(() => import('./pages/nodes'), 'NodesPage');
const ActivityPage = named(() => import('./pages/activity'), 'ActivityPage');
const UsersPage = named(() => import('./pages/users'), 'UsersPage');
const SecurityPage = named(() => import('./pages/security'), 'SecurityPage');
const LabPage = named(() => import('./pages/lab'), 'LabPage');
const SettingsPage = named(() => import('./pages/settings'), 'SettingsPage');
const NotFound = named(() => import('./pages/not-found'), 'NotFound');
const AuthPage = lazy(() => import('./pages/auth').then((m) => ({ default: m.AuthPage })));

const PageFallback = () => (
  <div className="grid min-h-[40vh] place-items-center text-fg-3">
    <Spinner className="size-5" />
  </div>
);

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { data: me, isLoading } = useMe();
  const loc = useLocation();
  if (isLoading)
    return (
      <div className="grid min-h-dvh place-items-center text-fg-2">
        <Spinner className="size-5" />
      </div>
    );
  if (!me) return <Navigate to="/login" state={{ from: loc.pathname + loc.search }} replace />;
  return <>{children}</>;
}

function AdminOnly({ children }: { children: React.ReactNode }) {
  const { data: me } = useMe();
  if (me && me.role !== 'ADMIN') return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function App() {
  const me = useMe().data;
  return (
    <>
      <LiveConnection enabled={!!me} />
      <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
        <Route
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route index element={<OverviewPage />} />
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="buckets" element={<BucketsPage />} />
          <Route path="buckets/:bucket" element={<BucketPage />} />
          <Route path="nodes" element={<NodesPage />} />
          <Route path="audit" element={<ActivityPage />} />
          <Route path="activity" element={<Navigate to="/audit" replace />} />
          <Route path="security" element={<AdminOnly><SecurityPage /></AdminOnly>} />
          <Route path="lab" element={<AdminOnly><LabPage /></AdminOnly>} />
          <Route path="users" element={<UsersPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="settings/:section" element={<SettingsPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
      </Suspense>
    </>
  );
}
