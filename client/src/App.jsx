import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Campaigns from './pages/Campaigns.jsx';
import NewCampaign from './pages/NewCampaign.jsx';
import Library from './pages/Library.jsx';
import Reports from './pages/Reports.jsx';
import Monitor from './pages/Monitor.jsx';

function Protected({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="center muted">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <Protected>
            <Layout />
          </Protected>
        }
      >
        <Route index element={<Navigate to="/campaigns" replace />} />
        <Route path="campaigns" element={<Campaigns />} />
        <Route path="campaigns/new" element={<NewCampaign />} />
        <Route path="campaigns/:id/edit" element={<NewCampaign />} />
        <Route path="library" element={<Library />} />
        <Route path="reports" element={<Reports />} />
        <Route path="monitor" element={<Monitor />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
