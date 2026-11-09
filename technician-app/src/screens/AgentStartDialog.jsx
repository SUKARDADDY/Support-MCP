import { useEffect, useRef, useState } from 'react';
import { agentModels, messageOf } from '../api.js';
import { useApp } from '../context.jsx';
import { t } from '../i18n/index.js';

// Hands a job to the relay's built-in agent: what is wrong, which model, and whether it
// keeps going when nobody is watching. Give it a saved PC (it connects itself) or a live session.
// The start goes through the app's startAgentTask, which first quiets any open tab on the same PC.
export function AgentStartDialog({ device = null, sessionId = null, onClose, onStarted }) {
  const { core, account, toast, rememberTask, startAgentTask } = useApp();
  const ref = useRef(null);
  const [text, setText] = useState('');
  const [keep, setKeep] = useState(false);
  const [model, setModel] = useState('');
  const [models, setModels] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return undefined;
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', '');
    return () => {
      if (d.open && typeof d.close === 'function') d.close();
    };
  }, []);

  useEffect(() => {
    let live = true;
    agentModels(core, account.id).then((m) => live && setModels(m)).catch((e) => live && setError(messageOf(e, t('agent.models_failed'))));
    return () => { live = false; };
  }, [core, account.id]);

  async function submit(e) {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = { instructions: text.trim(), keep_working: keep, ...(device ? { device_id: device.id } : { session_id: sessionId }) };
      if (models?.canPick && model) body.model = model;
      const started = await startAgentTask(body);
      rememberTask(started.task_id, body.instructions);
      toast(t('agent.started'));
      onStarted?.(started);
      onClose();
    } catch (err) {
      setError(messageOf(err, t('agent.start_failed')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} aria-labelledby="agent-h" onClose={onClose} onCancel={onClose}>
      <form className="dlg" onSubmit={submit}>
        <h2 id="agent-h">{device ? t('agent.title_device', { name: device.name }) : t('agent.title_session')}</h2>
        <p>{t('agent.text')}</p>
        <div className="form-row">
          <label htmlFor="agent-text">{t('agent.instructions')}</label>
          <textarea id="agent-text" rows={5} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('agent.placeholder')} />
        </div>
        {models?.canPick && models.models.length ? (
          <div className="form-row">
            <label htmlFor="agent-model">{t('agent.model')}</label>
            <select id="agent-model" className="field-select" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">{t('agent.model_default', { model: models.defaultModel ?? '' })}</option>
              {models.models.map((m) => <option key={m.id} value={m.id}>{m.label ?? m.id}</option>)}
            </select>
          </div>
        ) : null}
        <label className="toggle">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
          <span><span className="t-name">{t('agent.keep_working')}</span><span className="t-help">{t('agent.keep_working_help')}</span></span>
        </label>
        {error ? <p className="err" role="alert">{error}</p> : null}
        <div className="acts">
          <button type="button" className="btn btn-sec" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-pri" disabled={!text.trim() || busy}>{t('agent.start')}</button>
        </div>
      </form>
    </dialog>
  );
}
