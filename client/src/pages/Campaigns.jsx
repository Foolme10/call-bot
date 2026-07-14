import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';

const PAGE_SIZE = 25;
const MAX_REDIALS = 3; // must match the backend cap

const STATUS_CLASS = {
  draft: 'badge',
  scheduled: 'badge info',
  running: 'badge ok',
  paused: 'badge warn',
  completed: 'badge done',
  stopped: 'badge',
  failed: 'badge error',
};

// Outcomes a "re-run unreached" can redial, with the call_logs status they map
// to. 'answered' and 'machine' are the reached ones and are never offered.
const RERUN_OUTCOMES = [
  ['busy', 'Busy'],
  ['no_answer', 'No Answer'],
  ['failed', 'Failed'],
  ['congestion', 'Congestion'],
  ['queued', 'Not Dialed'],
];
// SMS only ever produces failed / not-sent outcomes; mirror the server's
// RERUN_UNREACHED for SMS so the dialog can't offer voice-only options.
const RERUN_OUTCOMES_SMS = [
  ['failed', 'Failed'],
  ['queued', 'Not Sent'],
];
const rerunOutcomesFor = (channel) => (channel === 'sms' ? RERUN_OUTCOMES_SMS : RERUN_OUTCOMES);
const RERUN_DEFAULT = RERUN_OUTCOMES.map(([k]) => k);

// Labels for the per-status counts in the detail view. 'queued' reads
// differently depending on whether the campaign can still dial/send it.
function countLabel(key, finished, isSms) {
  const labels = {
    answered: 'Answered',
    no_answer: 'No Answer',
    busy: 'Busy',
    failed: 'Failed',
    congestion: 'Congestion',
    machine: 'Answering Machine',
    sent: 'Sent',
    dialing: isSms ? 'Sending' : 'Dialing',
    queued: finished ? (isSms ? 'Not Sent' : 'Not Dialed') : 'Waiting',
  };
  return labels[key] || key;
}

export default function Campaigns() {
  const navigate = useNavigate();
  const [campaigns, setCampaigns] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null); // { campaign, counts } for the clicked campaign
  const [rerunFor, setRerunFor] = useState(null); // { ...campaign, counts } being re-run
  const [rerunScope, setRerunScope] = useState('all'); // 'all' | 'unreached'
  const [rerunStatuses, setRerunStatuses] = useState(RERUN_DEFAULT); // chosen outcomes for 'unreached'
  const [isAdmin, setIsAdmin] = useState(false); // support super-user: sees all users' campaigns
  const [filter, setFilter] = useState('all'); // all | active | scheduled | completed

  async function load(p = page) {
    try {
      const params = new URLSearchParams({ page: p, pageSize: PAGE_SIZE });
      if (filter !== 'all') params.set('status', filter);
      const d = await api.get(`/campaigns?${params}`);
      setCampaigns(d.campaigns);
      setTotal(d.total || d.campaigns.length);
      setIsAdmin(!!d.isAdmin);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(page);
    const t = setInterval(() => load(page), 5000); // keep counts/status fresh
    return () => clearInterval(t);
  }, [page, filter]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  async function control(id, action) {
    try {
      await api.post(`/campaigns/${id}/${action}`);
      load();
    } catch (e) {
      alert(e.message);
    }
  }

  async function remove(id) {
    if (!confirm('Delete this campaign and its call logs?')) return;
    try {
      await api.del(`/campaigns/${id}`);
      load();
    } catch (e) {
      alert(e.message);
    }
  }

  // Open the re-run dialog: fetch per-status counts so we can show how many
  // numbers each choice will dial.
  async function openRerun(c) {
    setRerunScope('all');
    setRerunStatuses(rerunOutcomesFor(c.channel).map(([k]) => k));
    setRerunFor(c); // show immediately; counts fill in when the fetch returns
    try {
      const d = await api.get(`/campaigns/${c.id}`);
      setRerunFor({ ...c, counts: d.counts });
    } catch (_e) {
      /* keep the dialog open without counts */
    }
  }

  async function doRerun() {
    try {
      const body = { scope: rerunScope };
      if (rerunScope === 'unreached') body.statuses = rerunStatuses;
      await api.post(`/campaigns/${rerunFor.id}/rerun`, body);
      setRerunFor(null);
      load();
    } catch (e) {
      alert(e.message);
    }
  }

  function toggleRerunStatus(key) {
    setRerunStatuses((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  }

  // Click on a row: fetch the campaign's per-status counts and show a summary.
  async function openDetail(c) {
    try {
      const d = await api.get(`/campaigns/${c.id}`);
      setDetail(d);
    } catch (e) {
      alert(e.message);
    }
  }

  return (
    <div>
      <div className="page-head">
        <h2>Campaigns</h2>
        <Link className="btn primary" to="/campaigns/new">
          + New campaign
        </Link>
      </div>

      <div className="filters">
        {[
          ['all', 'All'],
          ['active', 'Active'],
          ['scheduled', 'Scheduled'],
          ['completed', 'Completed'],
        ].map(([k, label]) => (
          <button
            key={k}
            className={`btn small ${filter === k ? 'primary' : 'ghost'}`}
            onClick={() => {
              setPage(1);
              setFilter(k);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <div className="alert error">{error}</div>}
      {loading ? (
        <div className="muted">Loading…</div>
      ) : campaigns.length === 0 ? (
        <div className="empty">
          {filter === 'all' ? 'No campaigns yet. Create your first one.' : `No ${filter} campaigns.`}
        </div>
      ) : (
        <div className={`table-wrap${isAdmin ? ' wide-admin' : ''}`}>
        <table className={`table${isAdmin ? ' table-tight' : ''}`}>
          <thead>
            <tr>
              <th>Name</th>
              {isAdmin && <th>Owner</th>}
              <th>Status</th>
              <th>Pace</th>
              <th>Progress</th>
              <th>Caller ID</th>
              <th>Schedule</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.id} className="clickable" onClick={() => openDetail(c)}>
                <td>
                  <strong>{c.name}</strong>{' '}
                  <span className={`badge ${c.channel === 'sms' ? 'info' : ''}`} style={{ fontSize: '.7em' }}>
                    {c.channel === 'sms' ? '💬 SMS' : '📞 Voice'}
                  </span>
                  <div className="muted small">
                    {c.channel === 'sms' ? 'SMS blast' : c.audio_name || 'No audio'}
                  </div>
                </td>
                {isAdmin && (
                  <td className="muted small">
                    <span className="cell-ellip" title={c.owner || ''}>{c.owner || '—'}</span>
                  </td>
                )}
                <td>
                  <span className={STATUS_CLASS[c.status] || 'badge'}>{c.status}</span>
                  {c.rerun_scope && (
                    <div className="muted small" style={{ marginTop: 4 }}>
                      ↻ {['running', 'paused'].includes(c.status) ? 'Redialing' : 'Redialed'}{' '}
                      {c.rerun_scope === 'all' ? 'all numbers' : 'unreached'}
                    </div>
                  )}
                </td>
                <td>
                  <span className="muted small">up to</span> {c.cps}{' '}
                  {c.channel === 'sms' ? 'msgs/sec' : 'calls/sec'}
                </td>
                <td>
                  {c.completed}/{c.run_total || c.total_contacts}
                  <div className="muted small">
                    {c.channel === 'sms' ? `${c.sent || 0} sent` : `${c.answered} answered`}
                  </div>
                </td>
                <td>{c.channel === 'sms' ? '—' : c.caller_number || '—'}</td>
                <td>
                  {c.schedule_type === 'scheduled'
                    ? new Date(c.scheduled_at).toLocaleString()
                    : 'Run now'}
                </td>
                <td className="actions-cell" onClick={(e) => e.stopPropagation()}>
                  <div className="actions">
                    {['draft', 'paused', 'scheduled', 'stopped'].includes(c.status) && (
                      <button className="btn small ok" onClick={() => control(c.id, 'start')}>
                        Start
                      </button>
                    )}
                    {c.status === 'running' && (
                      <button className="btn small warn" onClick={() => control(c.id, 'pause')}>
                        Pause
                      </button>
                    )}
                    {['running', 'paused'].includes(c.status) && (
                      <button className="btn small" onClick={() => control(c.id, 'stop')}>
                        Stop
                      </button>
                    )}
                    {['completed', 'stopped', 'failed'].includes(c.status) &&
                      (c.redial_count >= MAX_REDIALS ? (
                        <span
                          className="muted small"
                          title="Create a new campaign to dial these numbers again"
                        >
                          Redial limit reached
                        </span>
                      ) : (
                        <button className="btn small ok" onClick={() => openRerun(c)}>
                          Redial{c.redial_count > 0 ? ` (${c.redial_count}/${MAX_REDIALS})` : ''}
                        </button>
                      ))}
                    <button
                      className="btn small"
                      onClick={() => navigate(`/campaigns/${c.id}/edit`)}
                    >
                      Inspect
                    </button>
                    {c.status !== 'running' && (
                      <button className="btn small ghost" onClick={() => remove(c.id)}>
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {!loading && total > PAGE_SIZE && (
        <div className="pager">
          <button className="btn small" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            ← Prev
          </button>
          <span className="muted">
            Page {page} of {totalPages} · {total} campaigns
          </span>
          <button
            className="btn small"
            disabled={page >= totalPages}
            onClick={() => setPage(page + 1)}
          >
            Next →
          </button>
        </div>
      )}

      {detail && (
        <div className="modal-backdrop" onClick={() => setDetail(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{detail.campaign.name}</h3>
            <p>
              <span className={STATUS_CLASS[detail.campaign.status] || 'badge'}>
                {detail.campaign.status}
              </span>
            </p>

            {['running', 'paused'].includes(detail.campaign.status) ? (
              <>
                <p className="muted">
                  This campaign is in progress
                  {detail.campaign.status === 'paused' ? ' (paused)' : ''}. Results will be
                  available in Reports once it finishes.
                </p>
                <p>
                  <Link className="btn" to="/monitor" onClick={() => setDetail(null)}>
                    Watch in Live Monitor
                  </Link>
                </p>
              </>
            ) : ['completed', 'stopped'].includes(detail.campaign.status) ? (
              <>
                <table className="table">
                  <tbody>
                    {Object.entries(detail.counts).map(([k, n]) => (
                      <tr key={k}>
                        <td>{countLabel(k, true, detail.campaign.channel === 'sms')}</td>
                        <td>
                          <strong>{n}</strong>
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td>Total numbers</td>
                      <td>
                        <strong>{detail.campaign.total_contacts}</strong>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p className="muted small">
                  {detail.campaign.started_at &&
                    `Started ${new Date(detail.campaign.started_at).toLocaleString()}`}
                  {detail.campaign.completed_at &&
                    ` · Finished ${new Date(detail.campaign.completed_at).toLocaleString()}`}
                </p>
                <p>
                  <Link className="btn" to="/reports" onClick={() => setDetail(null)}>
                    Open full report
                  </Link>
                </p>
              </>
            ) : (
              <p className="muted">
                {detail.campaign.total_contacts} numbers ·{' '}
                {detail.campaign.schedule_type === 'scheduled' && detail.campaign.scheduled_at
                  ? `Scheduled for ${new Date(detail.campaign.scheduled_at).toLocaleString()}`
                  : 'Starts when you press Start'}
              </p>
            )}

            <div className="form-actions">
              <button className="btn ghost" onClick={() => setDetail(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {rerunFor && (() => {
        const rerunIsSms = rerunFor.channel === 'sms';
        const noun = rerunIsSms ? 'recipients' : 'numbers';
        return (
        <div className="modal-backdrop" onClick={() => setRerunFor(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{rerunIsSms ? 'Resend' : 'Redial'} — {rerunFor.name}</h3>
            <p className="muted small">Choose who to {rerunIsSms ? 'resend to' : 'redial'}.</p>
            <label className="pick">
              <input
                type="radio"
                name="rerun-scope"
                checked={rerunScope === 'all'}
                onChange={() => setRerunScope('all')}
              />
              <span>
                <strong>{rerunIsSms ? 'Resend to everyone' : 'Redial everyone'}</strong>
                <span className="muted small">
                  {rerunIsSms ? 'Send to' : 'Dial'} the whole list again ({Number(rerunFor.total_contacts).toLocaleString()}{' '}
                  {noun}). Previous results are cleared.
                </span>
              </span>
            </label>
            <label className="pick">
              <input
                type="radio"
                name="rerun-scope"
                checked={rerunScope === 'unreached'}
                onChange={() => setRerunScope('unreached')}
              />
              <span>
                <strong>{rerunIsSms ? 'Resend only those not sent' : 'Redial only those not reached'}</strong>
                <span className="muted small">
                  {rerunIsSms
                    ? 'Skip messages already sent; resend the outcomes you pick below.'
                    : 'Skip numbers already answered; redial the outcomes you pick below.'}
                </span>
              </span>
            </label>

            {rerunScope === 'unreached' && (
              <div className="rerun-breakdown">
                {rerunFor.counts ? (
                  <>
                    {rerunOutcomesFor(rerunFor.channel).map(([k, lbl]) => {
                      const cnt = Number(rerunFor.counts[k] || 0);
                      return (
                        <label key={k} className="pick" style={{ opacity: cnt ? 1 : 0.5 }}>
                          <input
                            type="checkbox"
                            checked={rerunStatuses.includes(k)}
                            disabled={!cnt}
                            onChange={() => toggleRerunStatus(k)}
                          />
                          <span>
                            {lbl} <span className="muted small">({cnt.toLocaleString()})</span>
                          </span>
                        </label>
                      );
                    })}
                    <p className="muted small" style={{ marginTop: 8 }}>
                      <strong>
                        {rerunStatuses
                          .reduce((sum, k) => sum + Number(rerunFor.counts[k] || 0), 0)
                          .toLocaleString()}
                      </strong>{' '}
                      {noun} will be {rerunIsSms ? 'sent' : 'dialed'}.
                    </p>
                  </>
                ) : (
                  <p className="muted small">Loading breakdown…</p>
                )}
              </div>
            )}

            <div className="form-actions">
              <button className="btn ghost" onClick={() => setRerunFor(null)}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={doRerun}
                disabled={
                  rerunScope === 'unreached' &&
                  (!rerunFor.counts ||
                    rerunStatuses.reduce((s, k) => s + Number(rerunFor.counts[k] || 0), 0) === 0)
                }
              >
                {rerunIsSms ? 'Start resend' : 'Start redial'}
              </button>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}
