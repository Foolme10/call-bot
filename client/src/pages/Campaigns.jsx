import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

const PAGE_SIZE = 25;

const STATUS_CLASS = {
  draft: 'badge',
  scheduled: 'badge info',
  running: 'badge ok',
  paused: 'badge warn',
  completed: 'badge done',
  stopped: 'badge',
  failed: 'badge error',
};

const RETRY_OPTS = [
  ['busy', 'Busy'],
  ['no_answer', 'No Answer'],
  ['congestion', 'Congestion'],
  ['failed', 'Failed'],
];

// Labels for the per-status counts in the detail view. 'queued' reads
// differently depending on whether the campaign can still dial it.
function countLabel(key, finished) {
  const labels = {
    answered: 'Answered',
    no_answer: 'No Answer',
    busy: 'Busy',
    failed: 'Failed',
    congestion: 'Congestion',
    machine: 'Answering Machine',
    dialing: 'Dialing',
    queued: finished ? 'Not Dialed' : 'Waiting',
  };
  return labels[key] || key;
}

// A UTC datetime from the API -> value for a <input type="datetime-local">, shown
// in the user's local timezone (and read back the same way on save).
function toLocalInput(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export default function Campaigns() {
  const [campaigns, setCampaigns] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // full edit form for a draft/scheduled campaign
  const [editLists, setEditLists] = useState(null); // { audios, callerIds } for the edit dropdowns
  const [detail, setDetail] = useState(null); // { campaign, counts } for the clicked campaign
  const [rerunFor, setRerunFor] = useState(null); // campaign being re-run
  const [rerunScope, setRerunScope] = useState('all'); // 'all' | 'unreached'

  async function load(p = page) {
    try {
      const d = await api.get(`/campaigns?page=${p}&pageSize=${PAGE_SIZE}`);
      setCampaigns(d.campaigns);
      setTotal(d.total || d.campaigns.length);
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
  }, [page]);

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

  function openRerun(c) {
    setRerunScope('all');
    setRerunFor(c);
  }

  async function doRerun() {
    try {
      await api.post(`/campaigns/${rerunFor.id}/rerun`, { scope: rerunScope });
      setRerunFor(null);
      load();
    } catch (e) {
      alert(e.message);
    }
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

  // Edit: needs the full campaign row (retry settings aren't in the list) plus
  // the audio / caller ID lists for the dropdowns.
  async function openEdit(c) {
    try {
      const [d, cids, auds] = await Promise.all([
        api.get(`/campaigns/${c.id}`),
        api.get('/caller-ids'),
        api.get('/audio'),
      ]);
      const cam = d.campaign;
      setEditLists({
        callerIds: cids.callerIds,
        audios: auds.audio.filter((x) => x.status === 'ready'),
      });
      setEditing({
        id: cam.id,
        name: cam.name,
        audioFileId: cam.audio_file_id || '',
        callerIdId: cam.caller_id_id || '',
        maxAttempts: cam.max_attempts || 1,
        retryDelayMin: cam.retry_delay_min || 0,
        retryOn: String(cam.retry_on || '').split(',').filter(Boolean),
        when: toLocalInput(cam.scheduled_at),
      });
    } catch (e) {
      alert(e.message);
    }
  }

  async function saveEdit() {
    try {
      const body = {
        name: editing.name,
        audioFileId: Number(editing.audioFileId),
        callerIdId: editing.callerIdId ? Number(editing.callerIdId) : null,
        maxAttempts: Number(editing.maxAttempts),
        retryDelayMin: Number(editing.retryDelayMin),
        retryOn: editing.retryOn,
        ...(editing.when
          ? { scheduleType: 'scheduled', scheduledAt: new Date(editing.when).toISOString() }
          : { scheduleType: 'now' }),
      };
      await api.patch(`/campaigns/${editing.id}`, body);
      setEditing(null);
      load();
    } catch (e) {
      alert(e.message);
    }
  }

  function toggleRetryOn(key) {
    setEditing((prev) => ({
      ...prev,
      retryOn: prev.retryOn.includes(key)
        ? prev.retryOn.filter((k) => k !== key)
        : [...prev.retryOn, key],
    }));
  }

  return (
    <div>
      <div className="page-head">
        <h2>Campaigns</h2>
        <Link className="btn primary" to="/campaigns/new">
          + New campaign
        </Link>
      </div>
      {error && <div className="alert error">{error}</div>}
      {loading ? (
        <div className="muted">Loading…</div>
      ) : campaigns.length === 0 ? (
        <div className="empty">No campaigns yet. Create your first one.</div>
      ) : (
        <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
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
                  <strong>{c.name}</strong>
                  <div className="muted small">{c.audio_name || 'No audio'}</div>
                </td>
                <td>
                  <span className={STATUS_CLASS[c.status] || 'badge'}>{c.status}</span>
                </td>
                <td>
                  <span className="muted small">up to</span> {c.cps} calls/sec
                </td>
                <td>
                  {c.completed}/{c.total_contacts}
                  <div className="muted small">{c.answered} answered</div>
                </td>
                <td>{c.caller_number || '—'}</td>
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
                    {['completed', 'stopped', 'failed'].includes(c.status) && (
                      <button className="btn small ok" onClick={() => openRerun(c)}>
                        Re-run
                      </button>
                    )}
                    {['draft', 'scheduled'].includes(c.status) && (
                      <button className="btn small" onClick={() => openEdit(c)}>
                        Edit
                      </button>
                    )}
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
                        <td>{countLabel(k, true)}</td>
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

      {rerunFor && (
        <div className="modal-backdrop" onClick={() => setRerunFor(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Re-run — {rerunFor.name}</h3>
            <p className="muted small">Choose who to dial on this run.</p>
            <label className="pick">
              <input
                type="radio"
                name="rerun-scope"
                checked={rerunScope === 'all'}
                onChange={() => setRerunScope('all')}
              />
              <span>
                <strong>Everyone again</strong>
                <span className="muted small">
                  Dial the whole list from scratch ({rerunFor.total_contacts} numbers). Previous
                  results are cleared.
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
                <strong>Only those not reached</strong>
                <span className="muted small">
                  Skip numbers already answered; re-dial busy, no-answer, failed and congestion.
                </span>
              </span>
            </label>
            <div className="form-actions">
              <button className="btn ghost" onClick={() => setRerunFor(null)}>
                Cancel
              </button>
              <button className="btn primary" onClick={doRerun}>
                Start re-run
              </button>
            </div>
          </div>
        </div>
      )}

      {editing && editLists && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Edit campaign</h3>

            <label>Name</label>
            <input
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />

            <label>Audio message</label>
            <select
              value={editing.audioFileId}
              onChange={(e) => setEditing({ ...editing, audioFileId: e.target.value })}
            >
              {editLists.audios.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>

            <label>Caller ID</label>
            <select
              value={editing.callerIdId}
              onChange={(e) => setEditing({ ...editing, callerIdId: e.target.value })}
            >
              <option value="">None (trunk default)</option>
              {editLists.callerIds.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label ? `${c.label} — ${c.number}` : c.number}
                </option>
              ))}
            </select>

            <label>Attempts per number</label>
            <select
              value={editing.maxAttempts}
              onChange={(e) => setEditing({ ...editing, maxAttempts: e.target.value })}
            >
              <option value={1}>1 — dial once, no retry</option>
              <option value={2}>2 — dial, then 1 retry</option>
              <option value={3}>3 — dial, then 2 retries</option>
              <option value={4}>4 — dial, then 3 retries</option>
            </select>

            {Number(editing.maxAttempts) > 1 && (
              <>
                <label>Wait between attempts (minutes)</label>
                <input
                  type="number"
                  min="0"
                  max="1440"
                  value={editing.retryDelayMin}
                  onChange={(e) => setEditing({ ...editing, retryDelayMin: e.target.value })}
                />

                <label>Retry only when the result was</label>
                <div className="radio-row">
                  {RETRY_OPTS.map(([k, lbl]) => (
                    <label key={k} className="pick">
                      <input
                        type="checkbox"
                        checked={editing.retryOn.includes(k)}
                        onChange={() => toggleRetryOn(k)}
                      />
                      <span>{lbl}</span>
                    </label>
                  ))}
                </div>
                <p className="muted small">Answered calls are never retried.</p>
              </>
            )}

            <label>Run at (leave empty to start manually)</label>
            <input
              type="datetime-local"
              value={editing.when}
              onChange={(e) => setEditing({ ...editing, when: e.target.value })}
            />

            <div className="form-actions">
              <button className="btn ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="btn primary" onClick={saveEdit}>
                Save changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
