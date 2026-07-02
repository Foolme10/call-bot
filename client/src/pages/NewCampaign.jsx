import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';

const guess = (cols, re) => cols.find((c) => re.test(c)) || '';

// A UTC datetime from the API -> value for <input type="datetime-local">.
function toLocalInput(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

const RETRY_OUTCOMES = [
  { v: 'busy', label: 'Busy' },
  { v: 'no_answer', label: 'No answer' },
  { v: 'failed', label: 'Failed' },
  { v: 'congestion', label: 'Congestion' },
];

export default function NewCampaign() {
  const navigate = useNavigate();
  const { id } = useParams();
  const editMode = Boolean(id); // /campaigns/:id/edit reuses this form to edit
  const [existingContacts, setExistingContacts] = useState(null); // list size when editing
  const [name, setName] = useState('');
  const [callerIds, setCallerIds] = useState([]);
  const [audios, setAudios] = useState([]);
  const [pacing, setPacing] = useState(null); // { maxConcurrent, maxCps }
  const [callerIdId, setCallerIdId] = useState('');
  const [audioFileId, setAudioFileId] = useState('');
  const [maxAttempts, setMaxAttempts] = useState(1);
  const [retryDelayMin, setRetryDelayMin] = useState(5);
  const [retryOn, setRetryOn] = useState(['busy', 'no_answer', 'congestion', 'failed']);
  const [scheduleType, setScheduleType] = useState('now');
  const [scheduledAt, setScheduledAt] = useState('');

  const toggleRetryOn = (v) =>
    setRetryOn((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]));

  // Contact upload state
  const [preview, setPreview] = useState(null); // { uploadId, columns, sample, totalRows }
  const [nameColumn, setNameColumn] = useState('');
  const [numberColumn, setNumberColumn] = useState('');
  const [uploading, setUploading] = useState(false);
  const [estimate, setEstimate] = useState(null); // auto-pace preview for this list size

  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get('/caller-ids'),
      api.get('/audio'),
      api.get('/campaigns/meta/pacing'),
    ])
      .then(([c, a, p]) => {
        setCallerIds(c.callerIds);
        setAudios(a.audio.filter((x) => x.status === 'ready'));
        setPacing(p);
      })
      .catch((e) => setError(e.message));
  }, []);

  // Edit mode: load the campaign and prefill the form. The contact list can't
  // be changed here (create a new campaign for a different list).
  useEffect(() => {
    if (!editMode) return;
    api
      .get(`/campaigns/${id}`)
      .then(({ campaign: cam }) => {
        setName(cam.name || '');
        setAudioFileId(cam.audio_file_id ? String(cam.audio_file_id) : '');
        setCallerIdId(cam.caller_id_id ? String(cam.caller_id_id) : '');
        setMaxAttempts(cam.max_attempts || 1);
        setRetryDelayMin(cam.retry_delay_min || 5);
        setRetryOn(String(cam.retry_on || '').split(',').filter(Boolean));
        setScheduleType(cam.schedule_type === 'scheduled' ? 'scheduled' : 'now');
        setScheduledAt(toLocalInput(cam.scheduled_at));
        setExistingContacts(cam.total_contacts);
        api
          .get(`/campaigns/meta/pace?count=${cam.total_contacts}`)
          .then(setEstimate)
          .catch(() => {});
      })
      .catch((e) => setError(e.message));
  }, [editMode, id]);

  async function onFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      const d = await api.postForm('/contacts/preview', form);
      setPreview(d);
      setNameColumn(guess(d.columns, /name/i));
      setNumberColumn(guess(d.columns, /phone|number|mobile|cell|contact|msisdn|tel/i));
      // Preview the dial pace + estimated finish time for a list this size.
      api
        .get(`/campaigns/meta/pace?count=${d.totalRows}`)
        .then(setEstimate)
        .catch(() => setEstimate(null));
    } catch (err) {
      setError(err.message);
      setPreview(null);
      setEstimate(null);
    } finally {
      setUploading(false);
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    if (!audioFileId) return setError('Choose an audio recording to play.');
    if (scheduleType === 'scheduled' && !scheduledAt)
      return setError('Pick a date and time for the scheduled campaign.');
    if (!editMode) {
      if (!preview) return setError('Upload a contact list first.');
      if (!numberColumn) return setError('Choose which column holds the phone number.');
    }

    setBusy(true);
    try {
      if (editMode) {
        const body = {
          name,
          callerIdId: callerIdId ? Number(callerIdId) : null,
          audioFileId: Number(audioFileId),
          maxAttempts: Number(maxAttempts),
          ...(Number(maxAttempts) > 1
            ? { retryDelayMin: Number(retryDelayMin), retryOn }
            : {}),
          ...(scheduleType === 'scheduled'
            ? { scheduleType: 'scheduled', scheduledAt: new Date(scheduledAt).toISOString() }
            : { scheduleType: 'now' }),
        };
        await api.patch(`/campaigns/${id}`, body);
        navigate('/campaigns');
        return;
      }

      const body = {
        name,
        callerIdId: callerIdId ? Number(callerIdId) : null,
        audioFileId: Number(audioFileId),
        scheduleType,
        scheduledAt:
          scheduleType === 'scheduled' ? new Date(scheduledAt).toISOString() : undefined,
        maxAttempts: Number(maxAttempts),
        ...(Number(maxAttempts) > 1
          ? { retryDelayMin: Number(retryDelayMin), retryOn }
          : {}),
        contacts: { uploadId: preview.uploadId, nameColumn, numberColumn },
      };
      const d = await api.post('/campaigns', body);
      const s = d.contactsSummary;
      let msg = `Campaign created with ${s.valid} contacts`;
      if (s.invalid) msg += ` (${s.invalid} rows skipped — invalid numbers)`;
      if (d.pace)
        msg += `\nDialing at up to ${d.pace.cps} calls/sec (~${d.pace.estMinutes} min to finish).`;
      if (d.warning) msg += `\n\n${d.warning}`;
      alert(msg);
      navigate(scheduleType === 'now' ? '/monitor' : '/campaigns');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="form-page">
      <div className="page-head">
        <h2>{editMode ? 'Campaign settings' : 'New campaign'}</h2>
      </div>
      {error && <div className="alert error" style={{ whiteSpace: 'pre-wrap' }}>{error}</div>}

      <section className="card">
        <h3>1. Campaign name</h3>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. June promo" required />
      </section>

      <section className="card">
        <h3>2. Contact list</h3>
        {editMode ? (
          <p className="muted small">
            {existingContacts != null ? (
              <>
                <strong>{Number(existingContacts).toLocaleString()}</strong> numbers. The contact
                list can’t be changed — create a new campaign to dial a different list.
              </>
            ) : (
              'Loading…'
            )}
          </p>
        ) : (
        <>
        <p className="muted small">
          Upload a CSV or Excel file. Extra columns are fine — you’ll pick which ones to use.
        </p>
        <input type="file" accept=".csv,.xlsx,.xls,.txt" onChange={onFile} />
        {uploading && <p className="muted">Reading file…</p>}
        {preview && (
          <div className="mapping">
            <p className="muted small">
              {preview.totalRows} rows in <strong>{preview.originalName}</strong>
            </p>
            <div className="row">
              <div>
                <label>Name column (optional)</label>
                <select value={nameColumn} onChange={(e) => setNameColumn(e.target.value)}>
                  <option value="">— none —</option>
                  {preview.columns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Phone number column *</label>
                <select value={numberColumn} onChange={(e) => setNumberColumn(e.target.value)}>
                  <option value="">— choose —</option>
                  {preview.columns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="table-wrap">
            <table className="table mini">
              <thead>
                <tr>
                  {preview.columns.map((c) => (
                    <th key={c} className={c === numberColumn ? 'hl' : c === nameColumn ? 'hl2' : ''}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.sample.map((r, i) => (
                  <tr key={i}>
                    {preview.columns.map((c) => (
                      <td key={c}>{String(r[c] ?? '')}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        )}
        </>
        )}
      </section>

      <section className="card">
        <h3>3. Audio & Caller ID</h3>
        <div className="row">
          <div>
            <label>Audio recording *</label>
            <select value={audioFileId} onChange={(e) => setAudioFileId(e.target.value)}>
              <option value="">— choose —</option>
              {audios.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.duration_sec ? ` (${a.duration_sec}s)` : ''}
                </option>
              ))}
            </select>
            {audios.length === 0 && (
              <p className="muted small">No recordings yet — add one on the “Audio & Caller IDs” tab.</p>
            )}
          </div>
          <div>
            <label>Caller ID</label>
            <select value={callerIdId} onChange={(e) => setCallerIdId(e.target.value)}>
              <option value="">— trunk default —</option>
              {callerIds.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} ({c.number})
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <section className="card">
        <h3>4. Dialing speed</h3>
        <p className="muted small">
          Speed is set automatically from your list size so the campaign finishes in a reasonable
          time, and never goes above your trunk’s capacity
          {pacing ? ` (up to ${pacing.maxCps} calls/sec)` : ''}. Nothing to configure.
        </p>
        {estimate && (preview || (editMode && existingContacts != null)) && (
          <div className="pace-preview">
            <div>
              <strong>
                {Number(preview ? preview.totalRows : existingContacts).toLocaleString()}
              </strong>{' '}
              numbers → up to <strong>{estimate.cps}</strong> calls/sec
            </div>
            <div className="muted small">
              Estimated time to finish: about {estimate.estMinutes} minute
              {estimate.estMinutes === 1 ? '' : 's'}.
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <h3>5. Retries</h3>
        <p className="muted small">
          Re-dial numbers that didn’t connect. Answered calls are never retried.
        </p>
        <div className="row">
          <div>
            <label>Attempts per number</label>
            <select value={maxAttempts} onChange={(e) => setMaxAttempts(Number(e.target.value))}>
              <option value={1}>1 — dial once, no retry</option>
              <option value={2}>2 — dial, then 1 retry</option>
              <option value={3}>3 — dial, then 2 retries</option>
              <option value={4}>4 — dial, then 3 retries</option>
            </select>
          </div>
          {maxAttempts > 1 && (
            <div>
              <label>Wait between attempts (minutes)</label>
              <input
                type="number"
                min="0"
                max="1440"
                value={retryDelayMin}
                onChange={(e) => setRetryDelayMin(e.target.value)}
              />
            </div>
          )}
        </div>
        {maxAttempts > 1 && (
          <>
            <label>Retry when the outcome is…</label>
            <div className="radio-row">
              {RETRY_OUTCOMES.map((o) => (
                <label key={o.v}>
                  <input
                    type="checkbox"
                    checked={retryOn.includes(o.v)}
                    onChange={() => toggleRetryOn(o.v)}
                  />{' '}
                  {o.label}
                </label>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="card">
        <h3>6. When to run</h3>
        <div className="radio-row">
          <label>
            <input
              type="radio"
              checked={scheduleType === 'now'}
              onChange={() => setScheduleType('now')}
            />{' '}
            Run now
          </label>
          <label>
            <input
              type="radio"
              checked={scheduleType === 'scheduled'}
              onChange={() => setScheduleType('scheduled')}
            />{' '}
            Schedule for later
          </label>
        </div>
        {scheduleType === 'scheduled' && (
          <input
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
          />
        )}
      </section>

      <div className="form-actions">
        <button type="button" className="btn ghost" onClick={() => navigate('/campaigns')}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy}>
          {busy
            ? 'Saving…'
            : editMode
            ? 'Save changes'
            : scheduleType === 'now'
            ? 'Create & start'
            : 'Create & schedule'}
        </button>
      </div>
    </form>
  );
}
