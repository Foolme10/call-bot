import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

const STATUS_CLASS = {
  draft: 'badge',
  scheduled: 'badge info',
  running: 'badge ok',
  paused: 'badge warn',
  completed: 'badge done',
  stopped: 'badge',
  failed: 'badge error',
};

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
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // { id, name, when } while editing a schedule
  const [rerunFor, setRerunFor] = useState(null); // campaign being re-run
  const [rerunScope, setRerunScope] = useState('all'); // 'all' | 'unreached'

  async function load() {
    try {
      const d = await api.get('/campaigns');
      setCampaigns(d.campaigns);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 5000); // keep counts/status fresh
    return () => clearInterval(t);
  }, []);

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

  async function saveSchedule() {
    try {
      if (editing.when) {
        await api.patch(`/campaigns/${editing.id}/schedule`, {
          scheduleType: 'scheduled',
          scheduledAt: new Date(editing.when).toISOString(),
        });
      } else {
        await api.patch(`/campaigns/${editing.id}/schedule`, { scheduleType: 'now' });
      }
      setEditing(null);
      load();
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
              <tr key={c.id}>
                <td>
                  <strong>{c.name}</strong>
                  <div className="muted small">{c.audio_name || 'No audio'}</div>
                </td>
                <td>
                  <span className={STATUS_CLASS[c.status] || 'badge'}>{c.status}</span>
                </td>
                <td>
                  <span className="muted small">up to</span> {c.max_concurrent} at once
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
                <td className="actions">
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
                    <button
                      className="btn small"
                      onClick={() =>
                        setEditing({
                          id: c.id,
                          name: c.name,
                          when: toLocalInput(c.scheduled_at),
                        })
                      }
                    >
                      Schedule
                    </button>
                  )}
                  {c.status !== 'running' && (
                    <button className="btn small ghost" onClick={() => remove(c.id)}>
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Schedule — {editing.name}</h3>
            <label>Run at (leave empty to run now)</label>
            <input
              type="datetime-local"
              value={editing.when}
              onChange={(e) => setEditing({ ...editing, when: e.target.value })}
            />
            <div className="form-actions">
              <button className="btn ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="btn primary" onClick={saveSchedule}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
