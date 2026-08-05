import { useEffect, useState } from 'react';
import { api, fetchMediaUrl } from '../api.js';
import SmsNotice from '../components/SmsNotice.jsx';

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

  async function saveTemplate(e) {
    e.preventDefault();
    setError('');
    if (!tplName.trim() || !tplBody.trim()) return setError('A template needs a name and message text.');
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
          <textarea
            rows={3}
            maxLength={1600}
            placeholder="Hi {name}, your outstanding amount is RM{amount}. Please settle by Friday."
            value={tplBody}
            onChange={(e) => setTplBody(e.target.value)}
          />
          <div className="form-actions" style={{ marginTop: 10 }}>
            {editingTpl && (
              <button type="button" className="btn ghost" onClick={cancelEditTemplate}>
                Cancel
              </button>
            )}
            <button className="btn primary">
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
