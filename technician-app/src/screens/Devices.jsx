import { useState } from 'react';
import { Icon, Thread } from '../components/Icon.jsx';
import { useApp } from '../context.jsx';
import { FILTERS, deviceStatus, filterCounts, filterDevices, placeLabel, sortDevices } from '../devices.js';
import { t } from '../i18n/index.js';
import { DeviceDetail } from './DeviceDetail.jsx';

// The saved PCs: a list with search and filters on the left, the selected PC on the right.
export function Devices() {
  const app = useApp();
  const { devices, places, devicesState, selectedId, select, conns, accounts, account, setActive, go, openLink } = app;
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const counts = filterCounts(devices);
  const shown = sortDevices(filterDevices(devices, places, query, filter));
  const selected = devices.find((d) => d.id === selectedId) ?? null;
  const onlineCount = counts.online;
  const signedIn = accounts.filter((a) => a.signed_in);

  let rows;
  if (devicesState.loading && !devices.length) {
    rows = <li className="empty" role="status"><p>{t('devices.loading')}</p></li>;
  } else if (devicesState.error && !devices.length) {
    rows = (
      <li className="empty" role="alert">
        <h2>{t('devices.load_failed')}</h2>
        <p>{devicesState.error.message}</p>
        <button type="button" className="btn btn-sec" onClick={app.reloadDevices}>{t('common.try_again')}</button>
      </li>
    );
  } else if (!devices.length) {
    rows = (
      <li className="empty">
        <h2>{t('devices.empty_title')}</h2>
        <p>{t('devices.empty_text')}</p>
        <div className="stack">
          <button type="button" className="btn btn-pri" onClick={() => go('add')}><Icon name="plus" />{t('nav.add')}</button>
          <button type="button" className="btn btn-sec" onClick={openLink}><Icon name="link" />{t('devices.send_link')}</button>
        </div>
      </li>
    );
  } else if (!shown.length) {
    rows = (
      <li className="empty">
        <h2>{t('devices.no_matches_title')}</h2>
        <p>{query ? t('devices.no_matches_query', { query }) : t('devices.no_matches_filter')}</p>
        <button type="button" className="btn btn-sec" onClick={() => { setQuery(''); setFilter('all'); }}>{t('devices.show_all')}</button>
      </li>
    );
  } else {
    rows = shown.map((d) => {
      const st = deviceStatus(d, conns[d.id]);
      const place = placeLabel(d, places);
      return (
        <li key={d.id}>
          <button type="button" className="row" data-device={d.id} aria-current={selectedId === d.id} onClick={() => select(d.id)}>
            <Thread kind={st.mark} />
            <span className="nm">{d.name}</span>
            {d.status === 'pending'
              ? <span className="mode">{t('devices.needs_approval')}</span>
              : <span className="mode"><Icon name={d.access === 'any' ? 'key' : 'bell'} />{t(`access.${d.access}.label`)}</span>}
            <span className="st">
              <b className={st.tone}>{t(`status.${st.word}`)}</b>
              {place ? <><span aria-hidden="true">·</span><span className="site">{place}</span></> : null}
            </span>
          </button>
        </li>
      );
    });
  }

  return (
    <div className="split">
      <section className="list" aria-label={t('devices.list_label')}>
        <div className="list-head">
          <h1>{t('devices.title')} <small>{devices.length ? t('devices.online_of', { online: onlineCount, total: devices.length }) : ''}</small></h1>
          {signedIn.length > 1 ? (
            <label className="sr-label">
              <span className="sr">{t('devices.team')}</span>
              <select className="field-select" value={account?.id ?? ''} onChange={(e) => setActive(e.target.value)} aria-label={t('devices.team')}>
                {signedIn.map((a) => <option key={a.id} value={a.id}>{a.team_name || a.team}</option>)}
              </select>
            </label>
          ) : null}
          {devices.length ? (
            <>
              <div className="search">
                <Icon name="search" />
                <label className="sr" htmlFor="device-search">{t('devices.search_label')}</label>
                <input id="device-search" type="search" placeholder={t('devices.search_placeholder')} autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
              <div className="filters" role="group" aria-label={t('devices.filter_label')}>
                {FILTERS.filter((f) => f !== 'waiting' || counts.waiting > 0).map((f) => (
                  <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                    {t(`filter.${f}`)} <span>{counts[f]}</span>
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
        <ul className="rows">{rows}</ul>
      </section>
      <section className="detail" aria-label={t('devices.detail_label')}>
        {selected ? <DeviceDetail key={selected.id} device={selected} /> : <NothingSelected hasDevices={devices.length > 0} />}
      </section>
    </div>
  );
}

function NothingSelected({ hasDevices }) {
  return (
    <div className="d-in">
      <h2 className="h2">{hasDevices ? t('devices.select_title') : t('devices.pair_title')}</h2>
      {hasDevices ? <p className="hint">{t('devices.select_text')}</p> : (
        <ol className="steps">
          <li>{t('devices.pair_step1')}</li>
          <li>{t('devices.pair_step2')}</li>
          <li>{t('devices.pair_step3')}</li>
        </ol>
      )}
      <p className="fine">{t('devices.pair_fine')}</p>
    </div>
  );
}
