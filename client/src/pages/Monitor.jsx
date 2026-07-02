import { useEffect, useRef, useState } from 'react';
import { api, getToken } from '../api.js';

// Plain-English meaning of each outcome — surfaced as tooltips so operators
// aren't left guessing what "congestion" or "failed" means.
const HELP = {
  answered: 'Someone (or their voicemail) picked up and heard the message.',
  no_answer: 'Rang but nobody picked up before it timed out.',
  busy: 'The line was engaged — already on another call.',
  congestion:
    'The carrier could not route the call right then (all circuits busy or a temporary network problem). Often works on a retry.',
  failed:
    'The call could not be placed at all — usually a wrong/invalid/blocked number or a carrier rejection.',
  machine: 'An answering machine / voicemail was detected (only when detection is on).',
};

const RESULT_LABEL = {
  answered: 'Answered',
  busy: 'Busy',
  no_answer: 'No Answer',
  failed: 'Failed',
  congestion: 'Congestion',
  machine: 'Machine',
};

const TERMINAL = ['answered', 'busy', 'no_answer', 'failed', 'congestion', 'machine'];

function mmss(ms) {
  if (!ms || ms < 0) return '0:00';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function Monitor() {
  const [campaigns, setCampaigns] = useState([]);
  const [campaignId, setCampaignId] = useState('');
  const [counts, setCounts] = useState({});
  const [campaignStatus, setCampaignStatus] = useState('');
  const [active, setActive] = useState({}); // callLogId -> { name, phone, status, at } (in progress)
  const [log, setLog] = useState([]); // completed results, newest first
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(Date.now());

  const wsRef = useRef(null);
  const reconnectRef = useRef(null);
  const activeRef = useRef({}); // mirror of `active` for name/phone lookup in the WS handler
  const seenAnswered = useRef(new Set()); // so an answered call is logged once, not twice

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  // Campaign list for the dropdown.
  useEffect(() => {
    const load = () => api.get('/campaigns').then((d) => setCampaigns(d.campaigns)).catch(() => {});
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

  // Ticking clock so "on the line" durations update every second.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Snapshot poll: authoritative counts + the true in-progress set. Reconciling
  // `active` against this is what keeps finished calls from piling up.
  useEffect(() => {
    if (!campaignId) return undefined;
    let live = true;
    const snap = async () => {
      try {
        const d = await api.get(`/campaigns/${campaignId}/monitor`);
        if (!live) return;
        setCounts(d.counts);
        setCampaignStatus(d.status);
        setActive((prev) => {
          const next = {};
          for (const r of d.active || []) {
            const was = prev[r.callLogId];
            next[r.callLogId] = was
              ? { ...was, status: r.status }
              : {
                  callLogId: r.callLogId,
                  name: r.name,
                  phone: r.phone,
                  status: r.status,
                  at: r.answer_time || r.dial_start,
                };
          }
          // Keep just-dialed rows the snapshot hasn't caught up to yet (~one poll).
          const cutoff = Date.now() - 4000;
          for (const [id, v] of Object.entries(prev)) {
            if (!next[id] && new Date(v.at).getTime() > cutoff) next[id] = v;
          }
          return next;
        });
      } catch (_e) {}
    };
    snap();
    const t = setInterval(snap, 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [campaignId]);

  // WebSocket feed: instant call events layered on top of the snapshot.
  useEffect(() => {
    if (!campaignId) return undefined;
    setActive({});
    setLog([]);
    seenAnswered.current = new Set();
    let closed = false;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws/monitor?token=${getToken()}`);
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        ws.send(JSON.stringify({ type: 'subscribe', campaignId: Number(campaignId) }));
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) reconnectRef.current = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === 'campaign') {
          setCampaignStatus(m.status);
          return;
        }
        if (m.type !== 'call') return;

        const id = m.callLogId;
        const known = activeRef.current[id] || {};
        const name = m.name ?? known.name;
        const phone = m.phone ?? known.phone;

        if (m.status === 'dialing' || m.status === 'answered') {
          setActive((prev) => ({
            ...prev,
            [id]: { callLogId: id, name: m.name ?? prev[id]?.name, phone: m.phone ?? prev[id]?.phone, status: m.status, at: m.at },
          }));
          if (m.status === 'answered' && !seenAnswered.current.has(id)) {
            seenAnswered.current.add(id);
            setLog((prev) => [{ callLogId: id, name, phone, status: 'answered', at: m.at }, ...prev].slice(0, 80));
          }
        } else {
          // A terminal outcome: leave the live list, enter the results log.
          setActive((prev) => {
            if (!prev[id]) return prev;
            const nx = { ...prev };
            delete nx[id];
            return nx;
          });
          setLog((prev) =>
            [{ callLogId: id, name, phone, status: m.status, at: m.at, retrying: m.retrying }, ...prev].slice(0, 80)
          );
        }
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(reconnectRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [campaignId]);

  // Derived metrics from the snapshot counts.
  const n = (k) => Number(counts[k] || 0);
  const total = Object.values(counts).reduce((a, b) => a + Number(b), 0);
  const done = TERMINAL.reduce((a, k) => a + n(k), 0);
  const answered = n('answered');
  const answerRate = done > 0 ? Math.round((answered / done) * 100) : 0;
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;

  const live = Object.values(active).sort((a, b) => (a.at < b.at ? 1 : -1));
  const selected = campaigns.find((c) => String(c.id) === String(campaignId));

  return (
    <div>
      <div className="page-head">
        <h2>Live Monitor</h2>
        <span className={`badge ${connected ? 'ok' : 'warn'}`}>
          {connected ? '● Live' : 'Reconnecting…'}
        </span>
      </div>

      <div className="filters">
        <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
          <option value="">Select a campaign…</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} — {c.status}
            </option>
          ))}
        </select>
        {campaignStatus && (
          <span className={`badge ${campaignStatus === 'running' ? 'ok' : 'info'}`}>
            {campaignStatus}
          </span>
        )}
        {selected && (
          <span className="muted small" style={{ alignSelf: 'center' }}>
            up to {selected.max_concurrent} lines
          </span>
        )}
      </div>

      {!campaignId ? (
        <div className="empty">Select a campaign to watch it dial in real time.</div>
      ) : (
        <>
          <div className="progress">
            <div className="progress-fill" style={{ width: `${progress}%` }} />
            <span className="progress-label">
              {done} / {total} dialed · {progress}%
            </span>
          </div>

          <div className="summary-cards">
            <div className="summary-card hl">
              <div className="num">{live.length}</div>
              <div className="muted small">On the line now</div>
            </div>
            <div className="summary-card">
              <div className="num ok-text">{answered}</div>
              <div className="muted small">Answered</div>
            </div>
            <div className="summary-card">
              <div className="num">{answerRate}%</div>
              <div className="muted small">Answer rate</div>
            </div>
            <div className="summary-card">
              <div className="num">{n('busy')}</div>
              <div className="muted small">Busy</div>
            </div>
            <div className="summary-card">
              <div className="num">{n('no_answer')}</div>
              <div className="muted small">No answer</div>
            </div>
            <div className="summary-card" title={`${HELP.failed}\n\n${HELP.congestion}`}>
              <div className="num">{n('failed') + n('congestion')}</div>
              <div className="muted small">Couldn’t connect</div>
            </div>
            <div className="summary-card">
              <div className="num">{n('queued')}</div>
              <div className="muted small">Remaining</div>
            </div>
          </div>

          <div className="monitor-cols">
            {/* Live: only calls that are actually up right now. */}
            <section className="card">
              <h3>
                On the line now <span className="muted small">({live.length})</span>
              </h3>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Number</th>
                      <th>Name</th>
                      <th>State</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {live.map((c) => (
                      <tr key={c.callLogId}>
                        <td>{c.phone || '—'}</td>
                        <td>{c.name || '—'}</td>
                        <td>
                          <span className={`badge ${c.status === 'answered' ? 'ok' : 'info'}`}>
                            {c.status === 'answered' ? 'On call' : 'Ringing…'}
                          </span>
                        </td>
                        <td className="muted small">{mmss(now - new Date(c.at).getTime())}</td>
                      </tr>
                    ))}
                    {live.length === 0 && (
                      <tr>
                        <td colSpan="4" className="muted">
                          No calls in progress.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Results: a proper chronological log of finished calls, newest first. */}
            <section className="card">
              <h3>
                Recent results <span className="muted small">(newest first)</span>
              </h3>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Number</th>
                      <th>Name</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {log.map((c, i) => (
                      <tr key={`${c.callLogId}-${c.at}-${i}`}>
                        <td className="muted small">
                          {c.at ? new Date(c.at).toLocaleTimeString() : ''}
                        </td>
                        <td>{c.phone || '—'}</td>
                        <td>{c.name || '—'}</td>
                        <td>
                          <span className={`badge ${resultClass(c.status)}`} title={HELP[c.status] || ''}>
                            {RESULT_LABEL[c.status] || c.status}
                          </span>
                          {c.retrying && <span className="muted small"> · retrying</span>}
                        </td>
                      </tr>
                    ))}
                    {log.length === 0 && (
                      <tr>
                        <td colSpan="4" className="muted">
                          Waiting for the first result…
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function resultClass(s) {
  if (s === 'answered') return 'ok';
  if (s === 'busy' || s === 'no_answer') return 'warn';
  if (s === 'failed' || s === 'congestion') return 'error';
  return '';
}
