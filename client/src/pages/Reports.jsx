import { useEffect, useState } from 'react';
import { api, downloadCsv } from '../api.js';

// The three outcomes that matter on a broadcast report, front and center.
const HEADLINE = [
  { k: 'answered', label: 'Answered', cls: 'ok-text' },
  { k: 'no_answer', label: 'No Answer' },
  { k: 'busy', label: 'Busy' },
];
// The rest — only shown when they actually occurred.
const OTHER = ['machine', 'congestion', 'failed', 'queued', 'dialing'];

// Plain-English meaning of every status, so "failed" and "congestion" aren't a mystery.
const HELP = {
  answered: 'Someone (or their voicemail) picked up and the message was played.',
  no_answer: 'The phone rang but nobody picked up before it timed out.',
  busy: 'The line was engaged — the person was already on another call.',
  congestion:
    'The carrier/network couldn’t complete the call right then — all circuits were busy or a temporary network problem. Often succeeds if you redial it.',
  failed:
    'The call couldn’t be placed at all — usually a wrong, invalid, or blocked number, or the carrier rejected it. Redialing rarely helps these.',
  machine: 'An answering machine / voicemail was detected (only when detection is turned on).',
  queued: 'The campaign was stopped before this number was dialed.',
};
const LEGEND_ORDER = ['answered', 'no_answer', 'busy', 'congestion', 'failed', 'machine'];

export default function Reports() {
  const [campaigns, setCampaigns] = useState([]);
  const [campaignId, setCampaignId] = useState('');
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');

  // Reports are only available for finished campaigns; running ones belong to
  // the Live Monitor.
  useEffect(() => {
    api
      .get('/campaigns?pageSize=200')
      .then((d) =>
        setCampaigns(d.campaigns.filter((c) => ['completed', 'stopped'].includes(c.status)))
      )
      .catch((e) => setError(e.message));
  }, []);

  async function load() {
    if (!campaignId) return;
    try {
      const params = new URLSearchParams({ page, pageSize: 50 });
      if (status) params.set('status', status);
      if (q) params.set('q', q);
      const d = await api.get(`/reports/campaigns/${campaignId}?${params}`);
      setData(d);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    load();
  }, [campaignId, status, page]);

  const labels = data?.labels || {};
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div>
      <div className="page-head">
        <h2>Reports</h2>
        {campaignId && (
          <button
            className="btn"
            onClick={() => downloadCsv(`/reports/campaigns/${campaignId}/export`, `campaign-${campaignId}.csv`)}
          >
            Export CSV
          </button>
        )}
      </div>
      {error && <div className="alert error">{error}</div>}

      <div className="filters">
        <select value={campaignId} onChange={(e) => { setPage(1); setCampaignId(e.target.value); }}>
          <option value="">Select a finished campaign…</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {campaigns.length === 0 && !error && (
          <span className="muted small" style={{ alignSelf: 'center' }}>
            Reports become available once a campaign finishes.
          </span>
        )}
        {data && (
          <>
            <select value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
              <option value="">All statuses</option>
              {Object.entries(labels).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <form onSubmit={(e) => { e.preventDefault(); setPage(1); load(); }}>
              <input placeholder="Search name or number" value={q} onChange={(e) => setQ(e.target.value)} />
            </form>
          </>
        )}
      </div>

      {data && (
        <>
          <div className="summary-cards">
            {HEADLINE.map(({ k, label, cls }) => (
              <div key={k} className="summary-card" title={HELP[k]}>
                <div className={`num ${cls || ''}`}>{data.summary[k] || 0}</div>
                <div className="muted small">{label}</div>
              </div>
            ))}
            {OTHER.filter((k) => data.summary[k]).map((k) => (
              <div key={k} className="summary-card" title={HELP[k] || ''}>
                <div className="num">{data.summary[k]}</div>
                <div className="muted small">{labels[k]}</div>
              </div>
            ))}
          </div>

          <details className="legend">
            <summary>What do these statuses mean?</summary>
            <dl>
              {LEGEND_ORDER.map((k) => (
                <div key={k} className="legend-row">
                  <dt>
                    <span className={`badge ${statusClass(k)}`}>{labels[k] || k}</span>
                  </dt>
                  <dd className="muted small">{HELP[k]}</dd>
                </div>
              ))}
            </dl>
          </details>

          {data.campaign?.rerun_scope && (
            <p className="muted small" style={{ marginBottom: 10 }}>
              ↻ Last run was a <strong>redial</strong> —{' '}
              {data.campaign.rerun_scope === 'all' ? 'all numbers' : 'unreached numbers only'}. Results
              below reflect the most recent run.
            </p>
          )}

          <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Number</th>
                <th>Status</th>
                <th title="How long an answered call stayed on the line hearing the audio">
                  Listen time
                </th>
                <th title="Which attempt this call was answered/finished on, out of the campaign's max">
                  Attempt
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.name || '—'}</td>
                  <td>{r.phone}</td>
                  <td>
                    <span className={`badge ${statusClass(r.status)}`}>{r.statusLabel}</span>
                  </td>
                  <td className="muted small">{listenTime(r)}</td>
                  <td>
                    {r.attempts}
                    {data.campaign?.max_attempts > 1 ? ` / ${data.campaign.max_attempts}` : ''}
                  </td>
                </tr>
              ))}
              {data.rows.length === 0 && (
                <tr>
                  <td colSpan="5" className="muted">
                    No matching calls.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>

          <div className="pager">
            <button className="btn small" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              ← Prev
            </button>
            <span className="muted">
              Page {page} of {totalPages} · {data.total} calls
            </span>
            <button className="btn small" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
              Next →
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function statusClass(s) {
  if (s === 'answered') return 'ok';
  if (s === 'busy' || s === 'no_answer') return 'warn';
  if (s === 'failed' || s === 'congestion') return 'error';
  return '';
}

// Listen time only makes sense for connected calls; format seconds as m:ss.
function listenTime(row) {
  if (row.status !== 'answered' && row.status !== 'machine') return '—';
  const s = Number(row.duration_sec || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
