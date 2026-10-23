/**
 * .17 门户 docinfo 页（“查看论文信息”）：发现 onlinePDF 全文链接后，
 * 右下角浮层列出可下载的篇目，一键交给后台走「导航取 fid → 抓页 → 合成」。
 */
import { api } from '../lib/ext.js';
import { decodeToken } from '../lib/protocol.js';
import { installBridge } from './bridge.js';
import { createPanel } from './panel.js';

installBridge();

let panel = null;
let currentTaskId = null;

/** docinfo 页上的全文链接（相对路径，如 onlinePDF?dbid=72&objid=…）。 */
function collectLinks() {
  const seen = new Set();
  const out = [];
  for (const a of Array.from(document.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href') || '';
    if (!/onlinePDF/i.test(href)) continue;
    const abs = toAbsolute(href);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

function toAbsolute(href) {
  try {
    return new URL(href, location.href).href;
  } catch {
    return '';
  }
}

/** 从 onlinePDF 链接里解出 objid / 令牌，用来展示（令牌只有出现时才解得开）。 */
function describe(link) {
  const objid = /[?&]objid=([^&]+)/.exec(link);
  const token = /personaliiifServlet\?path=([A-Za-z0-9+/=%]+)/.exec(link);
  if (token) {
    try {
      const info = decodeToken(token[1]);
      return info.infoname || info.filename || '';
    } catch {
      return '';
    }
  }
  return objid ? `objid ${objid[1]}` : '';
}

function init() {
  const links = collectLinks();
  if (!links.length) return;

  const actions = links.map((link, i) => ({
    id: `link:${i}`,
    label: links.length > 1 ? `下载第 ${i + 1} 篇` : '下载全文',
    primary: i === 0,
  }));
  actions.push({ id: 'workspace', label: '工作台' });

  panel = createPanel({
    title: links.length > 1 ? `发现 ${links.length} 篇可下载全文` : '发现可下载的全文',
    subtitle: describe(links[0]) || '点击下方按钮开始（约按页数耗时）',
    actions,
    onAction: (id) => onAction(id, links),
  });
  panel.setStatus('PDF 为阅读器渲染的图片页，不含文字层');

  api.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'task-update' || !message.task || !panel) return false;
    if (!currentTaskId || message.task.id !== currentTaskId) return false;
    panel.applyTask(message.task);
    if (message.task.status !== 'running') {
      currentTaskId = null;
      panel.setActions(actions);
    }
    return false;
  });
}

async function onAction(id, links) {
  if (!panel) return;
  if (id === 'workspace') {
    await api.runtime.sendMessage({ type: 'open-app', hash: '#/workspace' }).catch(() => {});
    return;
  }
  const match = /^link:(\d+)$/.exec(id);
  if (!match) return;
  const link = links[Number(match[1])];
  if (!link) return;

  panel.setBusy(true);
  panel.setStatus('正在打开全文入口…');
  panel.setActions([{ id: 'workspace', label: '工作台' }]);
  try {
    const reply = await api.runtime.sendMessage({ type: 'start', link });
    if (!reply || !reply.ok) throw new Error((reply && reply.error) || '后台没有响应');
    currentTaskId = reply.task.id;
    panel.applyTask(reply.task);
  } catch (err) {
    panel.setBusy(false);
    panel.setStatus(`✗ ${err.message || err}`, 'error');
    panel.setActions(links.map((l, i) => ({ id: `link:${i}`, label: links.length > 1 ? `第 ${i + 1} 篇` : '重试', primary: i === 0 })).concat([{ id: 'workspace', label: '工作台' }]));
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    try { init(); } catch (err) { console.warn('[兰大全文助手] 初始化失败', err); }
  }, { once: true });
} else {
  try { init(); } catch (err) { console.warn('[兰大全文助手] 初始化失败', err); }
}
