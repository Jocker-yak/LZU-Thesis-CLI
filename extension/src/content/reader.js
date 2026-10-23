/**
 * .29 阅读器页面（pdfindex1.jsp）：
 * - 装消息桥（background 之后所有 .29 请求都经这里同源发出）；
 * - 右下角浮层：显示标题/页数，一键「获取全文」，实时进度，可取消。
 */
import { api } from '../lib/ext.js';
import { pageCount, titleOf } from '../lib/reader.js';
import { installBridge, isReaderPage, readPageMeta, readPageFid } from './bridge.js';
import { createPanel } from './panel.js';

installBridge();

let panel = null;
let currentTaskId = null;

function init() {
  if (!isReaderPage()) return;

  let meta;
  try {
    meta = readPageMeta();
  } catch {
    return;
  }
  const n = pageCount(meta);
  const fid = readPageFid();
  const title = titleOf(meta, fid);

  panel = createPanel({
    title,
    subtitle: `${n} 页 · fid ${String(fid).slice(0, 8)}…`,
    actions: [
      { id: 'download', label: '获取全文', primary: true },
      { id: 'workspace', label: '工作台' },
    ],
    onAction: (id) => onAction(id),
  });
  panel.setStatus('点击「获取全文」把页面图片合成为 PDF（只含图片，无文字层）');

  api.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'task-update' || !message.task) return false;
    const task = message.task;
    const mine = currentTaskId ? task.id === currentTaskId : task.fid === String(fid).toLowerCase();
    if (!mine) return false;
    if (task.status === 'running') {
      panel.setActions([{ id: 'cancel', label: '取消' }, { id: 'workspace', label: '工作台' }]);
    } else {
      currentTaskId = null;
      panel.setActions([
        { id: 'download', label: '重新下载', primary: true },
        { id: 'workspace', label: '工作台' },
      ]);
    }
    panel.applyTask(task);
    return false;
  });
}

async function onAction(id) {
  if (id === 'workspace') {
    await api.runtime.sendMessage({ type: 'open-app', hash: '#/workspace' }).catch(() => {});
    return;
  }
  if (id === 'cancel') {
    if (currentTaskId) await api.runtime.sendMessage({ type: 'cancel-task', id: currentTaskId }).catch(() => {});
    return;
  }
  if (id !== 'download' || !panel) return;

  const fid = readPageFid();
  const meta = readPageMeta();
  panel.setBusy(true);
  panel.setStatus('正在启动下载…');
  panel.setProgress(0, pageCount(meta));
  try {
    const reply = await api.runtime.sendMessage({ type: 'start-from-page', fid, meta });
    if (!reply || !reply.ok) throw new Error((reply && reply.error) || '后台没有响应');
    currentTaskId = reply.task.id;
    panel.applyTask(reply.task);
    panel.setActions([{ id: 'cancel', label: '取消' }, { id: 'workspace', label: '工作台' }]);
  } catch (err) {
    panel.setBusy(false);
    panel.setStatus(`✗ ${err.message || err}`, 'error');
    panel.setActions([
      { id: 'download', label: '重试', primary: true },
      { id: 'workspace', label: '工作台' },
    ]);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    try { init(); } catch (err) { console.warn('[兰大全文助手] 初始化失败', err); }
  }, { once: true });
} else {
  try { init(); } catch (err) { console.warn('[兰大全文助手] 初始化失败', err); }
}
