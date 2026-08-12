import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

// Delivery reports (DLR): whether each accepted SMS actually reached the
// handset. "Sent" (in Reports) only means the gateway accepted it; here it
// resolves to Delivered / Failed, or stays Pending until the carrier reports.
const DLR_LABEL = { delivered: 'Delivered', pending: 'Pending', failed: 'Failed' };
const DLR_CLASS = { delivered: 'ok', pending: 'info', failed: 'error' };
const DLR_HELP = {
  delivered: 'The carrier confirmed the message reached the recipient’s handset.',
  pending: 'Accepted by the gateway; the carrier hasn’t reported a final result yet.',
  failed: 'The carrier could not deliver it (unreachable, barred, expired, or rejected).',
};

function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t.includes('T') ? t : t.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return t;
  return d.toLocaleString();
}

export default function DeliveryReports() {
  const [campaigns, setCampaigns] = useState([]);
  const [campaignId, setCampaignId] = useState('');
  const [data, setData] = useState(null);
  const [state, setState] = useState(''); // '' | delivered | pending | failed
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState('');
  const pollRef = useRef(null);

  // Only SMS campaigns that have actually started sending have DLRs to show.
  useEffect(() => {
    api
      .get('/campaigns?pageSize=200')
      .then((d) =>
        setCampaigns(
          d.campaigns.filter(
            (c) => c.channel === 'sms' && ['running', 'paused', 'completed', 'stopped'].includes(c.status)
          )
        )
      )
      .catch((e) => setError(e.message));
  }, []);

  async function load() {
    if (!campaignId) return;
    try {
      const params = new URLSearchParams({ page, pageSize: 50 });
      if (state) params.set('state', state);
      if (q) params.set('q', q);
      const d = await api.get(`/reports/campaigns/${campaignId}/dlr?${params}`);
      setData(d);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, state, page]);

  // While anything is still pending, refresh the view periodically so the
  // background poller's updates show up without a manual reload.
  useEffect(() => {
    clearInterval(pollRef.current);
    if (!campaignId || !data) return undefined;
    const pending = data.summary?.pending || 0;
    if (pending <= 0) return undefined;
    pollRef.current = setInterval(load, 15000);
    return () => clearInterval(pollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, data?.summary?.pending, state, page, q]);

  async function refreshNow() {
    if (!campaignId) return;
    setRefreshing(true);
    setNote('');
    try {
      const r = await api.post(`/reports/campaigns/${campaignId}/dlr/refresh`);
      setNote(
        r.checked === 0
          ? 'All messages already have a final delivery status.'
          : `Checked ${r.checked} message${r.checked === 1 ? '' : 's'} · ${r.updated} update${r.updated === 1 ? '' : 's'} from the gateway.`
      );
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setRefreshing(false);
    }
  }

  const s = data?.summary;
  const deliveryRate = s && s.sent > 0 ? Math.round((s.delivered / s.sent) * 100) : 0;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div>
      <div className="page-head">
        <h2>Delivery Reports</h2>
        {campaignId && (
          <button className="btn" onClick={refreshNow} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : '↻ Refresh now'}
          </button>
        )}
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="filters">
        <select value={campaignId} onChange={(e) => { setPage(1); setState(''); setData(null); setNote(''); setCampaignId(e.target.value); }}>
          <option value="">Select an SMS campaign…</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {campaigns.length === 0 && (
          <span className="muted small" style={{ alignSelf: 'center' }}>
            No SMS campaigns have been sent yet.
          </span>
        )}
      </div>

      {!campaignId ? (
        <div className="empty">
          Pick an SMS campaign to see whether each message reached the handset.
        </div>
      ) : !data ? (
        <div className="empty">Loading…</div>
      ) : (
        <>
          <p className="muted small" style={{ margin: '2px 0 12px' }}>
            “Sent” means the gateway accepted the message. Delivery reports below show whether it
            actually reached the recipient — updated automatically
            {data.pollSeconds > 0 ? ` (every ${Math.round(data.pollSeconds / 60) || 1} min)` : ''} as the
            carrier reports back.
          </p>

          <div className="summary-cards">
            <div className="summary-card">
              <div className="num">{s.sent.toLocaleString()}</div>
              <div className="muted small">Accepted (sent)</div>
            </div>
            <div className="summary-card hl">
              <div className="num ok-text">{s.delivered.toLocaleString()}</div>
              <div className="muted small">Delivered</div>
            </div>
            <div className="summary-card">
              <div className="num">{deliveryRate}%</div>
              <div className="muted small">Delivery rate</div>
            </div>
            <div className="summary-card">
              <div className="num">{s.pending.toLocaleString()}</div>
              <div className="muted small">Pending</div>
            </div>
            <div className="summary-card">
              <div className="num">{s.failed.toLocaleString()}</div>
              <div className="muted small">Failed</div>
            </div>
            {s.credits > 0 && (
              <div className="summary-card">
                <div className="num">{s.credits.toLocaleString()}</div>
                <div className="muted small">Credits used</div>
              </div>
            )}
          </div>

          {note && <div className="alert info" style={{ marginTop: 10 }}>{note}</div>}

          <div className="filters" style={{ marginTop: 12 }}>
            <select value={state} onChange={(e) => { setPage(1); setState(e.target.value); }}>
              <option value="">All statuses</option>
              <option value="delivered">Delivered</option>
              <option value="pending">Pending</option>
              <option value="failed">Failed</option>
            </select>
            <input
              placeholder="Search name or number…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { setPage(1); load(); } }}
            />
            <button className="btn" onClick={() => { setPage(1); load(); }}>Search</button>
          </div>

          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Number</th>
                  <th>Delivery</th>
                  <th>Detail</th>
                  <th>Message ID</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name || '—'}</td>
                    <td>{r.phone}</td>
                    <td>
                      <span className={`badge ${DLR_CLASS[r.dlr_status] || ''}`} title={DLR_HELP[r.dlr_status] || ''}>
                        {DLR_LABEL[r.dlr_status] || r.dlr_status}
                      </span>
                    </td>
                    <td className="muted small">{r.dlr_detail || (r.dlr_status === 'pending' ? 'Awaiting carrier report' : '—')}</td>
                    <td className="muted small">
                      <span className="cell-ellip" title={r.provider_msgid || ''}>{r.provider_msgid || '—'}</span>
                    </td>
                    <td className="muted small">{fmtTime(r.dlr_updated_at)}</td>
                  </tr>
                ))}
                {data.rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">No messages match this filter.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="pager">
              <button className="btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Prev
              </button>
              <span className="muted small">Page {page} of {totalPages}</span>
              <button className="btn" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
