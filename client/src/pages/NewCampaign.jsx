import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, fetchMediaUrl } from '../api.js';

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

// Fill {name}/{amount} the same way the server does — for the live preview.
// Single-pass so a value containing a token isn't re-expanded.
function renderTemplate(template, { name, amount }) {
  const values = {
    name: name == null ? '' : String(name),
    amount: amount == null ? '' : String(amount),
  };
  return String(template || '').replace(/\{\s*(name|amount)\s*\}/gi, (_m, key) => values[key.toLowerCase()]);
}

// Rough SMS segment estimate. Unicode (non-GSM) messages pack fewer chars.
function smsSegments(text) {
  const len = text.length;
  if (len === 0) return { len, segments: 0, unicode: false };
  const unicode = /[^\x00-\x7F]/.test(text);
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  const segments = len <= single ? 1 : Math.ceil(len / multi);
  return { len, segments, unicode };
}

export default function NewCampaign() {
  const navigate = useNavigate();
  const { id } = useParams();
  const editMode = Boolean(id); // /campaigns/:id/edit reuses this form to edit
  const [readOnly, setReadOnly] = useState(false); // live campaign: view settings, no edits
  const [campaignStatus, setCampaignStatus] = useState('');
  const [channel, setChannel] = useState('voice'); // 'voice' | 'sms' — fixed once created
  const [audioPreviewUrl, setAudioPreviewUrl] = useState(''); // object URL for the selected audio
  const [meta, setMeta] = useState({ audioName: '', callerLabel: '', callerNumber: '', messageTemplate: '' });
  const [existingContacts, setExistingContacts] = useState(null); // list size when editing
  const [name, setName] = useState('');
  const [callerIds, setCallerIds] = useState([]);
  const [audios, setAudios] = useState([]);
  const [pacing, setPacing] = useState(null); // { maxConcurrent, maxCps, sms }
  const [callerIdId, setCallerIdId] = useState('');
  const [audioFileId, setAudioFileId] = useState('');
  const [messageTemplate, setMessageTemplate] = useState('');
  const [maxAttempts, setMaxAttempts] = useState(1);
  const [retryDelayMin, setRetryDelayMin] = useState(5);
  const [retryOn, setRetryOn] = useState(['busy', 'no_answer', 'congestion', 'failed']);
  const [scheduleType, setScheduleType] = useState('now');
  const [scheduledAt, setScheduledAt] = useState('');
  const messageRef = useRef(null);

  const isSms = channel === 'sms';

  const toggleRetryOn = (v) =>
    setRetryOn((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]));

  // Contact upload state
  const [preview, setPreview] = useState(null); // { uploadId, columns, sample, totalRows }
  const [nameColumn, setNameColumn] = useState('');
  const [numberColumn, setNumberColumn] = useState('');
  const [amountColumn, setAmountColumn] = useState('');
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
        setChannel(cam.channel === 'sms' ? 'sms' : 'voice');
        setName(cam.name || '');
        setAudioFileId(cam.audio_file_id ? String(cam.audio_file_id) : '');
        setCallerIdId(cam.caller_id_id ? String(cam.caller_id_id) : '');
        setMessageTemplate(cam.message_template || '');
        setMaxAttempts(cam.max_attempts || 1);
        setRetryDelayMin(cam.retry_delay_min || 5);
        setRetryOn(String(cam.retry_on || '').split(',').filter(Boolean));
        setScheduleType(cam.schedule_type === 'scheduled' ? 'scheduled' : 'now');
        setScheduledAt(toLocalInput(cam.scheduled_at));
        setExistingContacts(cam.total_contacts);
        setCampaignStatus(cam.status);
        setMeta({
          audioName: cam.audio_name || '',
          callerLabel: cam.caller_label || '',
          callerNumber: cam.caller_number || '',
          messageTemplate: cam.message_template || '',
        });
        // Only campaigns that haven't started can be edited; everything else is
        // view-only (matches the backend, which rejects edits once it's live).
        setReadOnly(!['draft', 'scheduled'].includes(cam.status));
        const ch = cam.channel === 'sms' ? 'sms' : 'voice';
        api
          .get(`/campaigns/meta/pace?count=${cam.total_contacts}&channel=${ch}`)
          .then(setEstimate)
          .catch(() => {});
      })
      .catch((e) => setError(e.message));
  }, [editMode, id]);

  // Load a playable URL for the currently-selected audio so it can be previewed.
  useEffect(() => {
    if (!audioFileId || isSms) {
      setAudioPreviewUrl('');
      return undefined;
    }
    let url;
    let cancelled = false;
    fetchMediaUrl(`/audio/${audioFileId}/play`)
      .then((u) => {
        if (cancelled) {
          URL.revokeObjectURL(u);
          return;
        }
        url = u;
        setAudioPreviewUrl(u);
      })
      .catch(() => setAudioPreviewUrl(''));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [audioFileId, isSms]);

  // Re-fetch the pace estimate when the channel changes (voice vs SMS pace differ).
  useEffect(() => {
    const count = preview ? preview.totalRows : editMode ? existingContacts : null;
    if (count == null) return;
    api
      .get(`/campaigns/meta/pace?count=${count}&channel=${channel}`)
      .then(setEstimate)
      .catch(() => {});
  }, [channel]); // eslint-disable-line react-hooks/exhaustive-deps

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
      setAmountColumn(guess(d.columns, /amount|amt|due|balance|owe|sum|value|price|total/i));
      // Preview the send pace + estimated finish time for a list this size.
      api
        .get(`/campaigns/meta/pace?count=${d.totalRows}&channel=${channel}`)
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

  // Insert a {variable} at the message cursor position.
  function insertVar(token) {
    const el = messageRef.current;
    if (!el) {
      setMessageTemplate((m) => m + token);
      return;
    }
    const start = el.selectionStart ?? messageTemplate.length;
    const end = el.selectionEnd ?? messageTemplate.length;
    const next = messageTemplate.slice(0, start) + token + messageTemplate.slice(end);
    setMessageTemplate(next);
    // Restore focus + caret just after the inserted token.
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    if (readOnly) return; // live campaign — nothing to save
    if (isSms) {
      if (!messageTemplate.trim()) return setError('Write the SMS message to send.');
    } else if (!audioFileId) {
      return setError('Choose an audio recording to play.');
    }
    if (scheduleType === 'scheduled' && !scheduledAt)
      return setError('Pick a date and time for the scheduled campaign.');
    if (!editMode) {
      if (!preview) return setError('Upload a contact list first.');
      if (!numberColumn) return setError('Choose which column holds the phone number.');
    }

    // For SMS, only "failed" is a meaningful retry trigger (transient gateway
    // errors); the server ignores permanent rejects.
    const retrySettings =
      Number(maxAttempts) > 1
        ? { retryDelayMin: Number(retryDelayMin), retryOn: isSms ? ['failed'] : retryOn }
        : {};

    setBusy(true);
    try {
      if (editMode) {
        const body = {
          name,
          maxAttempts: Number(maxAttempts),
          ...retrySettings,
          ...(isSms
            ? { messageTemplate }
            : { callerIdId: callerIdId ? Number(callerIdId) : null, audioFileId: Number(audioFileId) }),
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
        channel,
        scheduleType,
        scheduledAt:
          scheduleType === 'scheduled' ? new Date(scheduledAt).toISOString() : undefined,
        maxAttempts: Number(maxAttempts),
        ...retrySettings,
        ...(isSms
          ? { messageTemplate }
          : { callerIdId: callerIdId ? Number(callerIdId) : null, audioFileId: Number(audioFileId) }),
        contacts: {
          uploadId: preview.uploadId,
          nameColumn,
          numberColumn,
          ...(isSms && amountColumn ? { amountColumn } : {}),
        },
      };
      const d = await api.post('/campaigns', body);
      const s = d.contactsSummary;
      const noun = isSms ? 'recipients' : 'contacts';
      let msg = `Campaign created with ${s.valid} ${noun}`;
      if (s.invalid) msg += ` (${s.invalid} rows skipped — invalid numbers)`;
      if (d.pace) {
        const verb = isSms ? 'messages' : 'calls';
        msg += `\nSending at up to ${d.pace.cps} ${verb}/sec (~${d.pace.estMinutes} min to finish).`;
      }
      if (d.warning) msg += `\n\n${d.warning}`;
      alert(msg);
      navigate(scheduleType === 'now' ? '/monitor' : '/campaigns');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Live message preview using the first uploaded row (or example values).
  const sampleRow = preview && preview.sample && preview.sample[0];
  const previewName = sampleRow && nameColumn ? sampleRow[nameColumn] : 'Alex';
  const previewAmount = sampleRow && amountColumn ? sampleRow[amountColumn] : '100';
  const previewText = renderTemplate(messageTemplate, { name: previewName, amount: previewAmount });
  const seg = smsSegments(messageTemplate);
  const smsConfigured = !pacing || !pacing.sms || pacing.sms.configured !== false;

  return (
    <form onSubmit={onSubmit} className="form-page">
      <div className="page-head">
        <h2>
          {editMode
            ? readOnly
              ? 'Campaign settings (read-only)'
              : 'Campaign settings'
            : 'New campaign'}
        </h2>
      </div>
      {error && <div className="alert error" style={{ whiteSpace: 'pre-wrap' }}>{error}</div>}
      {readOnly && (
        <div className="alert" style={{ background: 'rgba(210,153,34,.12)', color: '#e3b341', border: '1px solid rgba(210,153,34,.3)' }}>
          This campaign is <strong>{campaignStatus === 'running' ? 'live' : campaignStatus}</strong> —
          settings are read-only. Only a scheduled campaign that hasn’t started yet can be edited.
        </div>
      )}

      <fieldset disabled={readOnly} style={{ border: 'none', margin: 0, padding: 0, minWidth: 0 }}>
      {/* Channel: fixed once a campaign exists; a toggle only when creating. */}
      <section className="card">
        <h3>Broadcast type</h3>
        {editMode ? (
          <p className="muted small">
            This is a <strong>{isSms ? 'SMS' : 'Voice'}</strong> campaign. The type can’t be changed —
            create a new campaign to use the other channel.
          </p>
        ) : (
          <div className="channel-toggle radio-row">
            <label>
              <input type="radio" checked={!isSms} onChange={() => setChannel('voice')} /> 📞 Voice call
            </label>
            <label>
              <input type="radio" checked={isSms} onChange={() => setChannel('sms')} /> 💬 SMS
            </label>
          </div>
        )}
        {isSms && !smsConfigured && (
          <p className="muted small" style={{ color: '#e3b341' }}>
            Heads up: the SMS gateway isn’t configured on the server yet (SMS_AUTH_KEY). You can build
            the campaign, but it won’t send until that’s set.
          </p>
        )}
      </section>

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
                <strong>{Number(existingContacts).toLocaleString()}</strong>{' '}
                {isSms ? 'recipients' : 'numbers'}. The contact list can’t be changed — create a new
                campaign to use a different list.
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
                <label>Name column {isSms ? '(for {name})' : '(optional)'}</label>
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
              {isSms && (
                <div>
                  <label>Amount column (for {'{amount}'})</label>
                  <select value={amountColumn} onChange={(e) => setAmountColumn(e.target.value)}>
                    <option value="">— none —</option>
                    {preview.columns.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className="table-wrap">
            <table className="table mini">
              <thead>
                <tr>
                  {preview.columns.map((c) => (
                    <th
                      key={c}
                      className={
                        c === numberColumn
                          ? 'hl'
                          : c === nameColumn || (isSms && c === amountColumn)
                          ? 'hl2'
                          : ''
                      }
                    >
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

      {isSms ? (
        <section className="card">
          <h3>3. Message</h3>
          <p className="muted small">
            Write the SMS. Insert variables to personalize each message — they’re filled from the
            contact list per recipient.
          </p>
          {!readOnly && (
            <div className="radio-row" style={{ marginBottom: 8 }}>
              <button type="button" className="btn small ghost" onClick={() => insertVar('{name}')}>
                + Insert {'{name}'}
              </button>
              <button type="button" className="btn small ghost" onClick={() => insertVar('{amount}')}>
                + Insert {'{amount}'}
              </button>
            </div>
          )}
          {readOnly ? (
            <textarea value={meta.messageTemplate || ''} readOnly rows={4} />
          ) : (
            <textarea
              ref={messageRef}
              value={messageTemplate}
              onChange={(e) => setMessageTemplate(e.target.value)}
              rows={4}
              maxLength={1600}
              placeholder="e.g. Hi {name}, your outstanding amount is RM{amount}. Please settle by Friday."
            />
          )}
          <div className="muted small" style={{ marginTop: 6 }}>
            {seg.len} characters · ~{seg.segments} SMS segment{seg.segments === 1 ? '' : 's'}
            {seg.unicode ? ' · contains non-GSM characters (shorter segments)' : ''}
          </div>
          {messageTemplate.trim() && (
            <div className="pace-preview" style={{ marginTop: 10 }}>
              <div className="muted small" style={{ marginBottom: 4 }}>
                Preview {sampleRow ? '(first row of your list)' : '(example values)'}:
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{previewText}</div>
            </div>
          )}
        </section>
      ) : (
        <section className="card">
          <h3>3. Audio & Caller ID</h3>
          <div className="row">
            <div>
              <label>Audio recording *</label>
              {readOnly ? (
                <input value={meta.audioName || '—'} readOnly />
              ) : (
                <>
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
                </>
              )}
              {audioPreviewUrl && (
                <audio
                  controls
                  src={audioPreviewUrl}
                  style={{ display: 'block', marginTop: 8, height: 36, width: '100%' }}
                />
              )}
            </div>
            <div>
              <label>Caller ID</label>
              {readOnly ? (
                <input
                  value={meta.callerNumber ? `${meta.callerLabel || ''} (${meta.callerNumber})`.trim() : 'Trunk default'}
                  readOnly
                />
              ) : (
                <select value={callerIdId} onChange={(e) => setCallerIdId(e.target.value)}>
                  <option value="">— trunk default —</option>
                  {callerIds.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label} ({c.number})
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
        </section>
      )}

      <section className="card">
        <h3>4. {isSms ? 'Sending speed' : 'Dialing speed'}</h3>
        <p className="muted small">
          Speed is set automatically from your list size so the campaign finishes in a reasonable
          time, and never goes above the {isSms ? 'gateway' : 'trunk'}’s capacity
          {isSms
            ? pacing && pacing.sms
              ? ` (up to ${pacing.sms.maxCps} messages/sec)`
              : ''
            : pacing
            ? ` (up to ${pacing.maxCps} calls/sec)`
            : ''}
          . Nothing to configure.
        </p>
        {estimate && (preview || (editMode && existingContacts != null)) && (
          <div className="pace-preview">
            <div>
              <strong>
                {Number(preview ? preview.totalRows : existingContacts).toLocaleString()}
              </strong>{' '}
              {isSms ? 'recipients' : 'numbers'} → up to <strong>{estimate.cps}</strong>{' '}
              {isSms ? 'messages/sec' : 'calls/sec'}
            </div>
            <div className="muted small">
              Estimated time to finish: about{' '}
              {estimate.estMinutes +
                (Number(maxAttempts) > 1
                  ? (Number(maxAttempts) - 1) * Number(retryDelayMin || 0)
                  : 0)}{' '}
              minutes
              {Number(maxAttempts) > 1
                ? ` (includes up to ${Number(maxAttempts) - 1} retry round${
                    maxAttempts - 1 === 1 ? '' : 's'
                  })`
                : ''}
              .
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <h3>5. Retries</h3>
        <p className="muted small">
          {isSms
            ? 'Re-send to numbers the gateway couldn’t accept due to a temporary error. Permanent rejects (bad number, no credit) are never retried.'
            : 'Re-dial numbers that didn’t connect. Answered calls are never retried.'}
        </p>
        <div className="row">
          <div>
            <label>Attempts per number</label>
            <select value={maxAttempts} onChange={(e) => setMaxAttempts(Number(e.target.value))}>
              <option value={1}>1 — {isSms ? 'send once, no retry' : 'dial once, no retry'}</option>
              <option value={2}>2 — {isSms ? 'send, then 1 retry' : 'dial, then 1 retry'}</option>
              <option value={3}>3 — {isSms ? 'send, then 2 retries' : 'dial, then 2 retries'}</option>
              <option value={4}>4 — {isSms ? 'send, then 3 retries' : 'dial, then 3 retries'}</option>
              <option value={5}>5 — {isSms ? 'send, then 4 retries' : 'dial, then 4 retries'}</option>
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
        {maxAttempts > 1 && !isSms && (
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
      </fieldset>

      <div className="form-actions">
        <button type="button" className="btn ghost" onClick={() => navigate('/campaigns')}>
          {readOnly ? 'Back' : 'Cancel'}
        </button>
        {!readOnly && (
          <button className="btn primary" disabled={busy}>
            {busy
              ? 'Saving…'
              : editMode
              ? 'Save changes'
              : scheduleType === 'now'
              ? 'Create & start'
              : 'Create & schedule'}
          </button>
        )}
      </div>
    </form>
  );
}
