import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

// Admin-only credit management: top up the company pool, allocate credits into
// user wallets, and reclaim unused ones. The pool reflects credits you've
// bought from the SMS gateway; users spend their wallet when they send SMS.
export default function Credits() {
  const { user } = useAuth();
  const [pool, setPool] = useState(0);
  const [users, setUsers] = useState([]);
  const [txns, setTxns] = useState([]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [topupAmount, setTopupAmount] = useState('');
  const [modal, setModal] = useState(null); // { user, kind: 'allocate'|'deallocate' }
  const [modalAmount, setModalAmount] = useState('');
  const [modalNote, setModalNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [ov, tx] = await Promise.all([
        api.get('/credits/overview'),
        api.get('/credits/transactions?limit=100'),
      ]);
      setPool(ov.pool);
      setUsers(ov.users);
      setTxns(tx.transactions);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    load();
  }, []);

  if (user?.role !== 'admin') {
    return <div className="empty">This page is for administrators only.</div>;
  }

  async function doTopup(e) {
    e.preventDefault();
    const amount = parseInt(topupAmount, 10);
    if (!amount || amount <= 0) return setError('Enter a positive number of credits to add.');
    setBusy(true);
    try {
      await api.post('/credits/topup', { amount, note: note || undefined });
      setTopupAmount('');
      setNote('');
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function doAllocate(e) {
    e.preventDefault();
    const amount = parseInt(modalAmount, 10);
    if (!amount || amount <= 0) return setError('Enter a positive number of credits.');
    setBusy(true);
    try {
      const path = modal.kind === 'allocate' ? '/credits/allocate' : '/credits/deallocate';
      await api.post(path, { userId: modal.user.id, amount, note: modalNote || undefined });
      setModal(null);
      setModalAmount('');
      setModalNote('');
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const fmt = (n) => Number(n || 0).toLocaleString();
  const kindLabel = {
    topup: 'Top-up',
    allocate: 'Allocated',
    deallocate: 'Reclaimed',
    spend: 'Spent',
    refund: 'Refund',
  };
  const kindClass = {
    topup: 'ok',
    allocate: 'info',
    deallocate: 'warn',
    spend: '',
    refund: 'info',
  };

  return (
    <div>
      <div className="page-head">
        <h2>SMS Credits</h2>
      </div>
      {error && <div className="alert error">{error}</div>}

      <div className="summary-cards" style={{ marginBottom: 16 }}>
        <div className="summary-card hl">
          <div className="num">{fmt(pool)}</div>
          <div className="muted small">Company pool (available to allocate)</div>
        </div>
        <div className="summary-card">
          <div className="num">{fmt(users.filter((u) => u.role === 'user').reduce((a, u) => a + Number(u.credit_balance), 0))}</div>
          <div className="muted small">Allocated to users</div>
        </div>
      </div>

      <section className="card" style={{ marginBottom: 16 }}>
        <h3>Top up the pool</h3>
        <p className="muted small">
          Enter how many credits you’ve bought from the SMS gateway to add them to the pool, then
          allocate them to users below.
        </p>
        <form onSubmit={doTopup} className="row" style={{ alignItems: 'flex-end', gap: 12 }}>
          <div>
            <label>Credits to add</label>
            <input
              type="number"
              min="1"
              value={topupAmount}
              onChange={(e) => setTopupAmount(e.target.value)}
              placeholder="e.g. 100000"
            />
          </div>
          <div style={{ flex: 1 }}>
            <label>Note (optional)</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. nxsip invoice #123" />
          </div>
          <button className="btn primary" disabled={busy}>
            Add to pool
          </button>
        </form>
      </section>

      <section className="card" style={{ marginBottom: 16 }}>
        <h3>User wallets</h3>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Balance</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.full_name || u.username}<div className="muted small">{u.username}</div></td>
                  <td>
                    <span className={`badge ${u.role === 'admin' ? 'info' : ''}`}>{u.role}</span>
                  </td>
                  <td>{u.role === 'admin' ? <span className="muted small">— (not gated)</span> : <strong>{fmt(u.credit_balance)}</strong>}</td>
                  <td style={{ textAlign: 'right' }}>
                    {u.role === 'user' && (
                      <>
                        <button className="btn small" onClick={() => { setModal({ user: u, kind: 'allocate' }); setModalAmount(''); setModalNote(''); setError(''); }}>
                          Allocate
                        </button>{' '}
                        <button className="btn small ghost" disabled={Number(u.credit_balance) <= 0} onClick={() => { setModal({ user: u, kind: 'deallocate' }); setModalAmount(''); setModalNote(''); setError(''); }}>
                          Reclaim
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr><td colSpan={4} className="muted">No users yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h3>History</h3>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>User</th>
                <th>Credits</th>
                <th>By</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {txns.map((t) => (
                <tr key={t.id}>
                  <td className="muted small">{new Date(t.created_at.replace(' ', 'T') + 'Z').toLocaleString()}</td>
                  <td><span className={`badge ${kindClass[t.kind] || ''}`}>{kindLabel[t.kind] || t.kind}</span></td>
                  <td>{t.user || <span className="muted small">— pool —</span>}</td>
                  <td>{fmt(t.amount)}</td>
                  <td className="muted small">{t.actor || '—'}</td>
                  <td className="muted small">{t.note || ''}</td>
                </tr>
              ))}
              {txns.length === 0 && (
                <tr><td colSpan={6} className="muted">No transactions yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {modal && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={doAllocate}>
            <h3>
              {modal.kind === 'allocate' ? 'Allocate credits to' : 'Reclaim credits from'}{' '}
              {modal.user.full_name || modal.user.username}
            </h3>
            <p className="muted small">
              Current balance: <strong>{fmt(modal.user.credit_balance)}</strong>
              {modal.kind === 'allocate' ? ` · Pool: ${fmt(pool)}` : ''}
            </p>
            <label>Credits</label>
            <input type="number" min="1" autoFocus value={modalAmount} onChange={(e) => setModalAmount(e.target.value)} />
            <label>Note (optional)</label>
            <input value={modalNote} onChange={(e) => setModalNote(e.target.value)} />
            <div className="form-actions" style={{ marginTop: 12 }}>
              <button type="button" className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn primary" disabled={busy}>
                {modal.kind === 'allocate' ? 'Allocate' : 'Reclaim'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
