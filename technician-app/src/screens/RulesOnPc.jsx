import { fetchCustomerRules, fetchRules } from '../api.js';
import { useApp } from '../context.jsx';
import { useLoad } from '../hooks.js';
import { t } from '../i18n/index.js';
import { ACTIONS, effective, hoursSummary } from '../rules.js';

// What the team's rules allow on one saved PC, read only: the team's rules with its customer's own rules over them, as
// the relay works them out (for a PC under a customer) or from the team's document (for a PC with no customer). The
// relay holds every action to them, and so does the PC. Program and folder names are the team's own text.
export function RulesOnPc({ device }) {
  const { core, account, places, go } = useApp();
  const place = device.siteId ? places.get(device.siteId) ?? null : null;
  // A PC under a site waits until the sites are known: its customer's rules differ from the team's.
  const known = !device.siteId || !!place;
  const customerId = place?.customerId ?? null;
  const { data, error, loading, reload } = useLoad(async () => {
    if (!known) return null;
    if (customerId) {
      const r = await fetchCustomerRules(core, account.id, customerId);
      // The customer is named only when it has rules of its own: a customer with none has the team's.
      return { rules: r.effective, overridden: Object.keys(r.doc ?? {}).length > 0 };
    }
    const r = await fetchRules(core, account.id);
    return { rules: effective(r.team.doc, null, r.defaultTimeZone), overridden: false };
  }, [core, account.id, known, customerId]);
  if (!known) return null;
  const rules = data?.rules;

  return (
    <section className="rules-pc" aria-labelledby={`rules-pc-${device.id}`}>
      <h3 id={`rules-pc-${device.id}`}>{t('rules.pc_title')}</h3>
      {error && !data ? (
        <p className="hint" role="alert">{t('rules.pc_failed')} <button type="button" className="linkish" onClick={reload}>{t('common.try_again')}</button></p>
      ) : !data ? (
        <p className="hint" role="status">{loading ? t('common.loading') : null}</p>
      ) : (
        <>
          <p className="fine">{data.overridden && place?.customer ? t('rules.pc_hint_customer', { name: place.customer }) : t('rules.pc_hint_team')}</p>
          <dl className="facts rules-facts">
            {ACTIONS.map((a) => <div className="rules-row" key={a}><dt>{t(`rules.action_${a}`)}</dt><dd>{t(`rules.value_${rules[a]}`)}</dd></div>)}
            <div className="rules-row"><dt>{t('rules.hours_title')}</dt><dd>{hoursSummary(rules.hours)}{rules.hours ? ` (${rules.time_zone})` : ''}</dd></div>
            <div className="rules-row"><dt>{t('rules.programs_title')}</dt><dd>{(rules.protected_programs ?? []).join(', ') || t('rules.none')}</dd></div>
            <div className="rules-row"><dt>{t('rules.folders_title')}</dt><dd>{(rules.protected_folders ?? []).join(', ') || t('rules.none')}</dd></div>
          </dl>
          <button type="button" className="linkish" onClick={() => go('rules')}>{t('rules.pc_open')}</button>
        </>
      )}
    </section>
  );
}
