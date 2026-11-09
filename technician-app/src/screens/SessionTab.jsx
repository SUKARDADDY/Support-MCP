import { useApp } from '../context.jsx';
import { t } from '../i18n/index.js';

// Replaced in the next step by the full session tab (screen, activity, take over).
export function SessionTab({ tab }) {
  const { endTab } = useApp();
  return (
    <div className="sess">
      <div className="sess-bar">
        <div className="sess-id"><h2 className="sess-name">{tab.deviceName}</h2></div>
        <div className="sess-tools"><button type="button" className="btn btn-end btn-sm" onClick={() => endTab(tab.key)}>{t('session.end')}</button></div>
      </div>
    </div>
  );
}
