import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';

const tabs = [
  { to: '/campaigns', label: 'Campaigns' },
  { to: '/library', label: 'Library' },
  { to: '/reports', label: 'Reports' },
  { to: '/monitor', label: 'Live Monitor' },
  { to: '/delivery', label: 'Delivery Reports' },
  { to: '/credits', label: 'Credits', admin: true },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const [balance, setBalance] = useState(null); // regular user's SMS credit balance

  // Show the SMS credit balance in the header. Admins manage the pool on the
  // Credits page, so the badge is for regular users; refresh it periodically.
  useEffect(() => {
    if (!user || user.role === 'admin') return undefined;
    const load = () => api.get('/credits/me').then((d) => setBalance(d.balance)).catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [user]);

  const visibleTabs = tabs.filter((t) => !t.admin || user?.role === 'admin');

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">📣 Herald</div>
        <nav className="tabs">
          {visibleTabs.map((t) => (
            <NavLink key={t.to} to={t.to} className={({ isActive }) => (isActive ? 'active' : '')}>
              {t.label}
            </NavLink>
          ))}
        </nav>
        <div className="user">
          {user?.role !== 'admin' && balance != null && (
            <span className="badge info" title="Your SMS credit balance">
              💬 {Number(balance).toLocaleString()} credits
            </span>
          )}
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
