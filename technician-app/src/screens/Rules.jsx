import { Fragment, useEffect, useId, useMemo, useState } from 'react';
import { fetchCustomers, fetchRules, messageOf, removeOverride, saveRules } from '../api.js';
import { useApp } from '../context.jsx';
import { formatDateTime } from '../format.js';
import { useLoad } from '../hooks.js';
import { t } from '../i18n/index.js';
import { ACTIONS, DAYS, FOLDER_MAX, HOUR_VALUES, LIST_MAX, PROGRAM_MAX, VALUES, changedFields, effective, hoursSummary, isDriveRoot, problemWith, teamDoc, timeZones } from '../rules.js';
import { CodeDialog } from './CodeDialog.jsx';

const clone = (v) => JSON.parse(JSON.stringify(v));
const TEAM = '';

// The team's rules for what anyone, person or AI, may do to a saved PC, and each customer's own rules over them. Everyone
// who can see PCs reads them; only people with rules.manage edit, and every save (and every removal of an override) asks
// for a fresh code from their authenticator. A customer's document holds only the fields it changes: every other field
// says "Same as team" and shows the value in force. Names of programs and folders are the team's own text.
export function Rules() {
  const { core, account, can, toast, isShown } = useApp();
  const manage = can('rules.manage');
  const { data, error, loading, reload } = useLoad(async () => {
    const [rules, customers] = await Promise.all([fetchRules(core, account.id), fetchCustomers(core, account.id).catch(() => [])]);
    return { rules, customers };
  }, [core, account.id]);
  const [scope, setScope] = useState(TEAM);
  const [draft, setDraft] = useState(null);
  const [dialog, setDialog] = useState(null); // 'save' or 'remove'
  const [problem, setProblem] = useState(null);
  const [notice, setNotice] = useState(null);

  const customer = scope ? data?.customers.find((c) => c.id === scope) ?? null : null;
  // A customer that is gone since the list was read: back to the team.
  useEffect(() => { if (data && scope && !customer) setScope(TEAM); }, [data, scope, customer]);
  const team = data ? teamDoc(data.rules.team.doc) : null;
  const row = data ? (scope ? data.rules.overrides.get(scope) ?? { rev: 0, doc: {} } : data.rules.team) : null;
  const source = useMemo(() => (data ? (scope ? row.doc : teamDoc(row.doc)) : null), [data, scope]); // eslint-disable-line react-hooks/exhaustive-deps
  // The draft starts again from what was read: when the rules are read, and when another scope is picked.
  useEffect(() => { if (source) { setDraft(clone(source)); setProblem(null); } }, [source]);

  if (loading && !data) return <Page><p className="hint" role="status">{t('common.loading')}</p></Page>;
  if (error && !data) {
    return <Page><div role="alert"><p className="err">{messageOf(error, t('rules.load_failed'))}</p><button type="button" className="btn btn-sec" onClick={reload}>{t('common.try_again')}</button></div></Page>;
  }
  if (!data || !draft) return <Page />;

  const defaultZone = data.rules.defaultTimeZone;
  const isCustomer = scope !== TEAM;
  const merged = isCustomer ? { ...team, ...draft } : draft;
  const inForce = effective(team, isCustomer ? draft : null, defaultZone);
  const dirty = changedFields(source, draft).length > 0;
  const hasOverride = isCustomer && data.rules.overrides.has(scope);

  // One field of the draft. In a customer's document a field that is absent is the team's.
  const own = (field) => !isCustomer || Object.hasOwn(draft, field);
  const set = (field, value) => { setDraft((d) => ({ ...d, [field]: value })); setProblem(null); };
  const sameAsTeam = (field, on) => {
    setProblem(null);
    setDraft((d) => {
      const next = { ...d };
      if (on) delete next[field];
      else next[field] = clone(team[field]);
      return next;
    });
  };

  function review() {
    const p = problemWith(draft, merged);
    if (p) { setProblem(t(p.key, p.vars)); return; }
    setProblem(null);
    setDialog('save');
  }

  // A refusal that means the rules moved under the person: read them again and say so. Anything else goes back to the dialog.
  async function guarded(owner, call, done) {
    try {
      await call();
    } catch (e) {
      if (e?.code === 'stale' || (e?.code === 'not_found' && isCustomer)) {
        if (isShown(owner)) { setNotice(e.code === 'stale' ? t('rules.stale') : t('rules.customer_gone')); reload(); }
        return;
      }
      throw e;
    }
    // Told, and read again, only while the team that was saved for is the one shown.
    if (isShown(owner)) { toast(done); setNotice(null); reload(); }
  }
  const confirmSave = (code) => {
    const owner = account.id;
    return guarded(owner, () => saveRules(core, owner, isCustomer ? scope : null, draft, row.rev, code), t('rules.saved'));
  };
  const confirmRemove = (code) => {
    const owner = account.id;
    return guarded(owner, () => removeOverride(core, owner, scope, row.rev, code), t('rules.override_removed', { name: customer?.name ?? '' }));
  };

  const pick = (id) => { setScope(id); setNotice(null); };
  const who = row.updatedBy ? t('rules.saved_by', { who: row.updatedBy, when: formatDateTime(row.updatedAt) }) : null;

  return (
    <Page>
      <p className="hint">{t('rules.hint')}</p>
      {!manage ? <p className="hint">{t('rules.read_only')}</p> : null}
      {notice ? <p className="err" role="alert">{notice}</p> : null}

      <div className="form-row">
        <label htmlFor="rules-scope">{t('rules.scope')}</label>
        <select id="rules-scope" className="field-select" value={scope} disabled={dirty} onChange={(e) => pick(e.target.value)}>
          <option value={TEAM}>{t('rules.scope_team')}</option>
          {data.customers.map((c) => <option key={c.id} value={c.id}>{data.rules.overrides.has(c.id) ? t('rules.scope_has_override', { name: c.name }) : c.name}</option>)}
        </select>
        <span className="help">{dirty ? t('rules.scope_locked') : isCustomer ? t('rules.scope_customer_help', { name: customer?.name ?? '' }) : t('rules.scope_team_help')}</span>
      </div>
      {who ? <p className="fine">{who}</p> : null}

      <fieldset className="rules-form" disabled={!manage}>
        <Field name="time_zone" title={t('rules.zone_title')} help={t('rules.zone_help', { zone: defaultZone })} customer={isCustomer} own={own('time_zone')} onOwn={sameAsTeam} teamText={team.time_zone ?? t('rules.zone_default', { zone: defaultZone })}>
          <ZoneEditor value={draft.time_zone ?? ''} defaultZone={defaultZone} onChange={(v) => set('time_zone', v === '' ? null : v)} />
        </Field>

        <Field name="hours" title={t('rules.hours_title')} help={t('rules.hours_help')} customer={isCustomer} own={own('hours')} onOwn={sameAsTeam} teamText={hoursSummary(team.hours)}>
          <HoursEditor hours={draft.hours} onChange={(h) => set('hours', h)} />
        </Field>

        <section className="panel" aria-labelledby="rules-actions">
          <h2 id="rules-actions">{t('rules.actions_title')}</h2>
          <p className="hint">{t('rules.actions_hint')}</p>
          {ACTIONS.map((a) => (
            <Field key={a} name={a} title={t(`rules.action_${a}`)} help={t(`rules.action_${a}_help`)} customer={isCustomer} own={own(a)} onOwn={sameAsTeam} teamText={t(`rules.value_${effective(team, null, defaultZone)[a]}`)} bare>
              <select aria-label={t(`rules.action_${a}`)} className="field-select" value={draft[a] ?? team[a]} onChange={(e) => set(a, e.target.value)}>
                {VALUES.map((v) => <option key={v} value={v} disabled={HOUR_VALUES.includes(v) && !merged.hours}>{t(`rules.value_${v}`)}</option>)}
              </select>
              {!merged.hours && HOUR_VALUES.includes(draft[a] ?? team[a]) ? <span className="help">{t('rules.hours_first')}</span> : null}
            </Field>
          ))}
        </section>

        <Field name="protected_programs" title={t('rules.programs_title')} help={t('rules.programs_help')} customer={isCustomer} own={own('protected_programs')} onOwn={sameAsTeam} teamText={team.protected_programs.join(', ') || t('rules.none')}>
          <ListEditor key={scope} name="programs" items={draft.protected_programs ?? []} max={PROGRAM_MAX} placeholder={t('rules.programs_placeholder')} onChange={(l) => set('protected_programs', l)} />
        </Field>

        <Field name="protected_folders" title={t('rules.folders_title')} help={t('rules.folders_help')} customer={isCustomer} own={own('protected_folders')} onOwn={sameAsTeam} teamText={team.protected_folders.join(', ') || t('rules.none')}>
          <ListEditor key={scope} name="folders" items={draft.protected_folders ?? []} max={FOLDER_MAX} placeholder={t('rules.folders_placeholder')} folders onChange={(l) => set('protected_folders', l)} />
        </Field>
      </fieldset>

      {isCustomer ? (
        <section className="panel" aria-labelledby="rules-force">
          <h2 id="rules-force">{t('rules.in_force', { name: customer?.name ?? '' })}</h2>
          <dl className="facts rules-facts">
            <dt>{t('rules.zone_title')}</dt><dd>{inForce.time_zone}</dd>
            <dt>{t('rules.hours_title')}</dt><dd>{hoursSummary(inForce.hours)}</dd>
            {ACTIONS.map((a) => <Fragment key={a}><dt>{t(`rules.action_${a}`)}</dt><dd>{t(`rules.value_${inForce[a]}`)}</dd></Fragment>)}
            <dt>{t('rules.programs_title')}</dt><dd>{inForce.protected_programs.join(', ') || t('rules.none')}</dd>
            <dt>{t('rules.folders_title')}</dt><dd>{inForce.protected_folders.join(', ') || t('rules.none')}</dd>
          </dl>
        </section>
      ) : null}

      {problem ? <p className="err" role="alert">{problem}</p> : null}
      {manage ? (
        <div className="rules-bar">
          <button type="button" className="btn btn-pri" disabled={!dirty} onClick={review}>{t('rules.save')}</button>
          <button type="button" className="btn btn-sec" disabled={!dirty} onClick={() => { setDraft(clone(source)); setProblem(null); }}>{t('rules.discard')}</button>
          {hasOverride ? <button type="button" className="btn btn-end" onClick={() => setDialog('remove')}>{t('rules.remove_override')}</button> : null}
        </div>
      ) : null}

      {dialog === 'save' ? (
        <CodeDialog title={t('rules.save_title')} text={isCustomer ? t('rules.save_text_customer', { name: customer?.name ?? '' }) : t('rules.save_text_team')} confirmLabel={t('rules.save')} onConfirm={confirmSave} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'remove' ? (
        <CodeDialog title={t('rules.remove_title', { name: customer?.name ?? '' })} text={t('rules.remove_text', { name: customer?.name ?? '' })} confirmLabel={t('rules.remove_override')} onConfirm={confirmRemove} onClose={() => setDialog(null)} />
      ) : null}
    </Page>
  );
}

function Page({ children = null }) {
  return (
    <div className="page">
      <div className="page-in">
        <h1 tabIndex={-1}>{t('rules.title')}</h1>
        {children}
      </div>
    </div>
  );
}

// One field. On a customer's rules it can say "Same as team", which leaves the field out of the customer's document and shows the
// team's value; otherwise the editor is shown. `bare` is a field inside a panel that has its own heading.
function Field({ name, title, help, customer, own, onOwn, teamText, children, bare = false }) {
  const body = (
    <>
      {customer ? (
        <label className="toggle same">
          <input type="checkbox" checked={!own} onChange={(e) => onOwn(name, e.target.checked)} />
          <span><span className="t-name">{t('rules.same_as_team')}</span></span>
        </label>
      ) : null}
      {own ? children : <p className="hint team-value">{t('rules.team_value', { value: teamText })}</p>}
    </>
  );
  if (bare) {
    return (
      <fieldset className="rfield" data-field={name}>
        <legend>{title}</legend>
        <p className="help">{help}</p>
        {body}
      </fieldset>
    );
  }
  return (
    <fieldset className="panel rfield" data-field={name}>
      <legend>{title}</legend>
      <p className="hint">{help}</p>
      {body}
    </fieldset>
  );
}

function ZoneEditor({ value, defaultZone, onChange }) {
  const id = useId();
  return (
    <div className="form-row">
      <label htmlFor={`${id}-zone`} className="sr">{t('rules.zone_title')}</label>
      <input id={`${id}-zone`} type="text" list={`${id}-zones`} placeholder={t('rules.zone_default', { zone: defaultZone })} autoComplete="off" spellCheck={false} value={value} onChange={(e) => onChange(e.target.value.trim())} />
      <datalist id={`${id}-zones`}>{timeZones().map((z) => <option key={z} value={z} />)}</datalist>
    </div>
  );
}

function HoursEditor({ hours, onChange }) {
  const change = (day, span) => {
    const next = { ...(hours ?? {}) };
    if (span) next[day] = span;
    else delete next[day];
    onChange(Object.keys(next).length ? next : null);
  };
  return (
    <div className="hours">
      {DAYS.map((day) => {
        const span = hours?.[day] ?? null;
        const name = t(`day.${day}`);
        return (
          <div className="hours-row" key={day} data-day={day}>
            <span className="hours-day">{name}</span>
            <label className="hours-closed">
              <input type="checkbox" checked={!span} aria-label={t('rules.day_closed', { day: name })} onChange={(e) => change(day, e.target.checked ? null : ['08:00', '18:00'])} />
              {t('rules.closed')}
            </label>
            {span ? (
              <>
                <input type="text" inputMode="numeric" maxLength={5} placeholder="08:00" aria-label={t('rules.day_from', { day: name })} value={span[0]} onChange={(e) => change(day, [e.target.value.trim(), span[1]])} />
                <span aria-hidden="true">{t('rules.to')}</span>
                <input type="text" inputMode="numeric" maxLength={5} placeholder="18:00" aria-label={t('rules.day_to', { day: name })} value={span[1]} onChange={(e) => change(day, [span[0], e.target.value.trim()])} />
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// A list of names or folders: each can be removed, and one is added at a time. The relay checks the lists again on a save.
function ListEditor({ name, items, max, placeholder, folders = false, onChange }) {
  const id = useId();
  const [text, setText] = useState('');
  const [error, setError] = useState(null);

  function add() {
    const v = text.trim();
    if (!v) return;
    if (items.length >= LIST_MAX) { setError(t('rules.err_list_long', { max: LIST_MAX })); return; }
    if (v.length > max) { setError(t('rules.err_item_long', { max })); return; }
    if (folders && !/^[A-Za-z]:[\\/]/.test(v)) { setError(t('rules.err_folder', { path: v })); return; }
    if (folders && isDriveRoot(v)) { setError(t('rules.err_folder_root', { path: v })); return; }
    if (items.some((x) => x.toLowerCase() === v.toLowerCase())) { setError(t('rules.err_duplicate')); return; }
    setError(null);
    setText('');
    onChange([...items, v]);
  }

  return (
    <div className="rlist" data-list={name}>
      {items.length === 0 ? <p className="hint">{t('rules.none')}</p> : (
        <ul>
          {items.map((item) => (
            <li key={item}>
              <span className="rl-item">{item}</span>
              <button type="button" className="btn btn-sec btn-xs" aria-label={t('rules.remove_item', { item })} onClick={() => onChange(items.filter((x) => x !== item))}>{t('rules.remove')}</button>
            </li>
          ))}
        </ul>
      )}
      <div className="rl-add">
        <label htmlFor={`${id}-add`} className="sr">{t(folders ? 'rules.folders_add' : 'rules.programs_add')}</label>
        <input id={`${id}-add`} type="text" placeholder={placeholder} autoComplete="off" spellCheck={false} maxLength={max + 40} value={text} onChange={(e) => { setText(e.target.value); setError(null); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <button type="button" className="btn btn-sec btn-sm" onClick={add} disabled={!text.trim()}>{t('rules.add')}</button>
      </div>
      {error ? <p className="err" role="alert">{error}</p> : null}
    </div>
  );
}
