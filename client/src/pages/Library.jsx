import { useEffect, useRef, useState } from 'react';
import { api, fetchMediaUrl } from '../api.js';
import SmsNotice from '../components/SmsNotice.jsx';
import { findNonLatin, smsSegments, renderTemplate } from '../smsText.js';

export default function Library() {
  const [audio, setAudio] = useState([]);
  const [callerIds, setCallerIds] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [error, setError] = useState('');
  const [players, setPlayers] = useState({}); // audioId -> object URL for preview

  // audio upload form
  const [audioName, setAudioName] = useState('');
  const [audioFile, setAudioFile] = useState(null);
  const [uploadingAudio, setUploadingAudio] = useState(false);

  // caller id form
  const [label, setLabel] = useState('');
  const [number, setNumber] = useState('');

  // SMS template form (also reused to edit an existing one)
  const [tplName, setTplName] = useState('');
  const [tplBody, setTplBody] = useState('');
  const [editingTpl, setEditingTpl] = useState(null); // id being edited, or null
  const [smsMeta, setSmsMeta] = useState({ prepend: '', prefixChars: 0, maxSegments: 1 }); // for the segment counter
  const tplBodyRef = useRef(null); // for inserting {name}/{amount} at the cursor

  async function load() {
    try {
      const [a, c, t] = await Promise.all([
        api.get('/audio'),
        api.get('/caller-ids'),
        api.get('/sms-templates'),
      ]);
      setAudio(a.audio);
      setCallerIds(c.callerIds);
      setTemplates(t.templates || []);
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    load();
    // Prepend / gateway-label sizing so the template counter matches what's sent.
    api
      .get('/campaigns/meta/pacing')
      .then((p) =>
        setSmsMeta({
          prepend: (p.sms && p.sms.prepend) || '',
          prefixChars: (p.sms && p.sms.prefixChars) || 0,
          maxSegments: (p.sms && p.sms.maxSegments) || 1,
        })
      )
      .catch(() => {});
  }, []);

  async function uploadAudio(e) {
    e.preventDefault();
    if (!audioFile) return setError('Choose an audio file.');
    setUploadingAudio(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', audioFile);
      form.append('name', audioName || audioFile.name);
      await api.postForm('/audio', form);
      setAudioName('');
      setAudioFile(null);
      e.target.reset();
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploadingAudio(false);
    }
  }

  async function addCallerId(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/caller-ids', { label, number });
      setLabel('');
      setNumber('');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function preview(id) {
    if (players[id]) return; // already loaded
    try {
      const url = await fetchMediaUrl(`/audio/${id}/play`);
      setPlayers((p) => ({ ...p, [id]: url }));
    } catch (e) {
      alert(e.message);
    }
  }

  async function delAudio(id) {
    if (!confirm('Delete this recording?')) return;
    await api.del(`/audio/${id}`).then(load).catch((e) => alert(e.message));
  }
  async function delCallerId(id) {
    if (!confirm('Delete this caller ID?')) return;
    await api.del(`/caller-ids/${id}`).then(load).catch((e) => alert(e.message));
  }

  // Insert a {variable} at the message cursor position (same as the composer).
  function insertTplVar(token) {
    const el = tplBodyRef.current;
    if (!el) {
      setTplBody((b) => b + token);
      return;
    }
    const start = el.selectionStart ?? tplBody.length;
    const end = el.selectionEnd ?? tplBody.length;
    const next = tplBody.slice(0, start) + token + tplBody.slice(end);
    setTplBody(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  async function saveTemplate(e) {
    e.preventDefault();
    setError('');
    if (!tplName.trim() || !tplBody.trim()) return setError('A template needs a name and message text.');
    const bad = findNonLatin(tplBody);
    if (bad.length)
      return setError(
        `Remove non-Latin characters from the message (${bad.join(' ')}). Templates must use plain Latin (English) characters only.`
      );
    if (tplTooLong)
      return setError(
        tplMaxSegments === 1
          ? `Template is too long: it needs ${tplSeg.segments} SMS segments (${tplSeg.totalLen} characters incl. the prefix), but only 1 segment (160 characters) is allowed. Please shorten it.`
          : `Template is too long: it needs ${tplSeg.segments} SMS segments, but the limit is ${tplMaxSegments}. Please shorten it.`
      );
    try {
      if (editingTpl) {
        await api.patch(`/sms-templates/${editingTpl}`, { name: tplName, body: tplBody });
      } else {
        await api.post('/sms-templates', { name: tplName, body: tplBody });
      }
      setTplName('');
      setTplBody('');
      setEditingTpl(null);
      load();
    } catch (err) {
      setError(err.message);
    }
  }
  function editTemplate(t) {
    setEditingTpl(t.id);
    setTplName(t.name);
    setTplBody(t.body);
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }
  function cancelEditTemplate() {
    setEditingTpl(null);
    setTplName('');
    setTplBody('');
  }
  async function delTemplate(id) {
    if (!confirm('Delete this SMS template?')) return;
    if (editingTpl === id) cancelEditTemplate();
    await api.del(`/sms-templates/${id}`).then(load).catch((e) => alert(e.message));
  }

  const tplReserved = (smsMeta.prepend ? smsMeta.prepend.length : 0) + (smsMeta.prefixChars || 0);
  const tplSeg = smsSegments(tplBody, tplReserved);
  const tplMaxSegments = smsMeta.maxSegments || 1;
  const tplTooLong = tplBody.length > 0 && tplSeg.segments > tplMaxSegments;

  return (
    <div>
      <div className="page-head">
        <h2>Library — Audio, Caller IDs & SMS Templates</h2>
      </div>
      {error && <div className="alert error">{error}</div>}

      <div className="two-col">
        <section className="card">
          <h3>Audio recordings</h3>
          <p className="muted small">
            Upload MP3 or WAV. Files are converted automatically for the dialer. These appear in the
            campaign “Audio recording” dropdown.
          </p>
          <form onSubmit={uploadAudio} className="inline-form">
            <input
              placeholder="Label (e.g. Promo message)"
              value={audioName}
              onChange={(e) => setAudioName(e.target.value)}
            />
            <input type="file" accept=".mp3,.wav,.m4a,.ogg,.aac,.flac" onChange={(e) => setAudioFile(e.target.files[0])} />
            <button className="btn primary" disabled={uploadingAudio}>
              {uploadingAudio ? 'Uploading…' : 'Upload'}
            </button>
          </form>
          <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Duration</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {audio.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.name}
                    {players[a.id] && (
                      <audio
                        controls
                        autoPlay
                        src={players[a.id]}
                        style={{ display: 'block', marginTop: 6, height: 34, maxWidth: 240 }}
                      />
                    )}
                  </td>
                  <td>{a.duration_sec ? `${a.duration_sec}s` : '—'}</td>
                  <td>
                    <span className={`badge ${a.status === 'ready' ? 'ok' : 'warn'}`}>{a.status}</span>
                  </td>
                  <td className="actions-cell">
                    <div className="actions">
                      {a.status === 'ready' && !players[a.id] && (
                        <button className="btn small" onClick={() => preview(a.id)}>
                          ▶ Preview
                        </button>
                      )}
                      <button className="btn small ghost" onClick={() => delAudio(a.id)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {audio.length === 0 && (
                <tr>
                  <td colSpan="4" className="muted">
                    No recordings yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        </section>

        <section className="card">
          <h3>Caller IDs</h3>
          <p className="muted small">
            The number shown to recipients. It must be a number your SIP trunk allows you to present.
          </p>
          <form onSubmit={addCallerId} className="inline-form">
            <input placeholder="Label" value={label} onChange={(e) => setLabel(e.target.value)} required />
            <input placeholder="Number (e.g. 18005551234)" value={number} onChange={(e) => setNumber(e.target.value)} required />
            <button className="btn primary">Add</button>
          </form>
          <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Label</th>
                <th>Number</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {callerIds.map((c) => (
                <tr key={c.id}>
                  <td>{c.label}</td>
                  <td>{c.number}</td>
                  <td>
                    <button className="btn small ghost" onClick={() => delCallerId(c.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {callerIds.length === 0 && (
                <tr>
                  <td colSpan="3" className="muted">
                    No caller IDs yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        </section>
      </div>

      <section className="card">
        <h3>SMS message templates</h3>
        <p className="muted small">
          Reusable SMS messages. Use <code>{'{name}'}</code> / <code>{'{amount}'}</code> to personalize
          per recipient. Saved templates appear in the “Load a saved template” dropdown when you
          compose an SMS campaign.
        </p>
        <SmsNotice />
        <form onSubmit={saveTemplate} style={{ marginBottom: 16 }}>
          <label>Template name</label>
          <input
            placeholder="e.g. Payment reminder"
            value={tplName}
            onChange={(e) => setTplName(e.target.value)}
          />
          <label style={{ marginTop: 8 }}>Message</label>
          <div className="radio-row" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn small ghost" onClick={() => insertTplVar('{name}')}>
              + Insert {'{name}'}
            </button>
            <button type="button" className="btn small ghost" onClick={() => insertTplVar('{amount}')}>
              + Insert {'{amount}'}
            </button>
          </div>
          <textarea
            ref={tplBodyRef}
            rows={3}
            maxLength={1600}
            placeholder="Hi {name}, your outstanding amount is RM{amount}. Please settle by Friday."
            value={tplBody}
            onChange={(e) => setTplBody(e.target.value)}
          />
          <div className="muted small" style={{ marginTop: 6 }}>
            {tplSeg.bodyLen} characters
            {tplReserved > 0 ? ` + ${tplReserved} prepended = ${tplSeg.totalLen}` : ''} · ~
            <span style={tplTooLong ? { color: '#ff7b72', fontWeight: 700 } : undefined}>
              {tplSeg.segments} SMS segment{tplSeg.segments === 1 ? '' : 's'}
            </span>{' '}
            (max {tplMaxSegments})
            {tplSeg.unicode ? ' · contains non-GSM characters (shorter segments)' : ''}
          </div>
          {tplReserved > 0 && (
            <div className="muted small">
              Includes {smsMeta.prepend ? `“${smsMeta.prepend.trimEnd()}”` : ''}
              {smsMeta.prepend && smsMeta.prefixChars > 0 ? ' + ' : ''}
              {smsMeta.prefixChars > 0 ? `sender label (${smsMeta.prefixChars} chars)` : ''} prepended
              to every message.
            </div>
          )}
          {findNonLatin(tplBody).length > 0 && (
            <div className="alert error" style={{ marginTop: 8 }}>
              ⚠ Remove these non-Latin characters:{' '}
              <strong>{findNonLatin(tplBody).join(' ')}</strong>. Templates must use plain Latin
              (English) characters only.
            </div>
          )}
          {tplTooLong && (
            <div className="alert error" style={{ marginTop: 8 }}>
              ⚠ Template is too long — it needs <strong>{tplSeg.segments} SMS segments</strong> (
              {tplSeg.totalLen} characters incl. the prefix), but the limit is{' '}
              <strong>{tplMaxSegments === 1 ? '1 segment (160 characters)' : `${tplMaxSegments} segments`}</strong>.
              Shorten it to save.
            </div>
          )}
          {tplBody.trim() && (
            <div className="pace-preview" style={{ marginTop: 10 }}>
              <div className="muted small" style={{ marginBottom: 4 }}>
                Preview (example values):
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>
                {smsMeta.prepend + renderTemplate(tplBody, { name: 'Alex', amount: '100' })}
              </div>
            </div>
          )}
          <div className="form-actions" style={{ marginTop: 10 }}>
            {editingTpl && (
              <button type="button" className="btn ghost" onClick={cancelEditTemplate}>
                Cancel
              </button>
            )}
            <button className="btn primary" disabled={findNonLatin(tplBody).length > 0 || tplTooLong}>
              {editingTpl ? 'Save changes' : 'Add template'}
            </button>
          </div>
        </form>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Message</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id}>
                  <td><strong>{t.name}</strong></td>
                  <td className="muted small" style={{ whiteSpace: 'pre-wrap', maxWidth: 460 }}>
                    {t.body}
                  </td>
                  <td className="actions-cell">
                    <div className="actions">
                      <button className="btn small" onClick={() => editTemplate(t)}>
                        Edit
                      </button>
                      <button className="btn small ghost" onClick={() => delTemplate(t.id)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {templates.length === 0 && (
                <tr>
                  <td colSpan="3" className="muted">
                    No templates yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
