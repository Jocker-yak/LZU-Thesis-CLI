import { mountView } from './shared-view.js';

const TABS = new Set(['search', 'tasks', 'history', 'settings', 'log', 'help']);

function tabFromHash() {
  const raw = String(location.hash || '').replace(/^#\/?/, '').trim();
  if (raw === 'workspace') return 'search';
  return TABS.has(raw) ? raw : 'search';
}

const view = mountView(document.getElementById('root'), { compact: false });
view.showTab(tabFromHash());

window.addEventListener('hashchange', () => view.showTab(tabFromHash()));
