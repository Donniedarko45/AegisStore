import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Loading } from './components/ui';
import { useMe } from './hooks';
import { AuditPage } from './pages/Audit';
import { AuthPage } from './pages/Auth';
import { BucketDetailPage } from './pages/BucketDetail';
import { BucketsPage } from './pages/Buckets';
import { DashboardPage } from './pages/Dashboard';
import { NodesPage } from './pages/Nodes';
import { SettingsPage } from './pages/Settings';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { data: me, isLoading } = useMe();
  const loc = useLocation();
  if (isLoading) return <Loading />;
  if (!me) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="buckets" element={<BucketsPage />} />
        <Route path="buckets/:bucket" element={<BucketDetailPage />} />
        <Route path="nodes" element={<NodesPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
