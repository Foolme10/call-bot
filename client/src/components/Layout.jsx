import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth.jsx';

const tabs = [
  { to: '/campaigns', label: 'Campaigns' },
  { to: '/library', label: 'Audio & Caller IDs' },
  { to: '/reports', label: 'Reports' },
  { to: '/monitor', label: 'Live Monitor' },
];

export default function Layout() {
  const { user, logout } = useAuth();
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">📞 call-bot</div>
        <nav className="tabs">
          {tabs.map((t) => (
            <NavLink key={t.to} to={t.to} className={({ isActive }) => (isActive ? 'active' : '')}>
              {t.label}
            </NavLink>
          ))}
        </nav>
        <div className="user">
          <span className="muted">{user?.fullName || user?.username}</span>
          <button className="btn ghost" onClick={logout}>
            Log out
          </button>
        </div>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
