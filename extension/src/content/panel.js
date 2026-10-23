/**
 * 页面内浮层（shadow DOM，避免被门户/阅读器的 CSS 污染）。
 * .29 阅读页与 .17 docinfo 页共用同一套样式和交互。
 */

const STYLE = `
  :host { all: initial; }
  .card {
    position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
    width: 300px; box-sizing: border-box;
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
          "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    color: #1f2937; background: #fff;
    border: 1px solid #dbe3ef; border-radius: 12px;
    box-shadow: 0 12px 32px rgba(15, 23, 42, .18);
    overflow: hidden;
  }
  .head {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 12px; color: #fff;
    background: linear-gradient(135deg, #1d4ed8, #2563eb 55%, #3b82f6);
  }
  .head .logo {
    width: 18px; height: 18px; border-radius: 5px; background: rgba(255,255,255,.22);
    display: inline-flex; align-items: center; justify-content: center; font-size: 11px;
  }
  .head .name { font-weight: 600; font-size: 13px; flex: 1; }
  .head button {
    all: unset; cursor: pointer; color: rgba(255,255,255,.85);
    font-size: 15px; line-height: 1; padding: 2px 4px; border-radius: 5px;
  }
  .head button:hover { background: rgba(255,255,255,.18); color: #fff; }
  .body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 8px; }
  .title {
    font-size: 12.5px; font-weight: 600; color: #111827;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .sub { font-size: 11.5px; color: #6b7280; word-break: break-all; }
  .bar { height: 5px; border-radius: 999px; background: #eef2f7; overflow: hidden; }
  .bar > i { display: block; height: 100%; width: 0%; background: #2563eb; transition: width .2s; }
  .status { font-size: 11.5px; color: #4b5563; min-height: 16px; }
  .status.error { color: #b91c1c; }
  .status.done { color: #047857; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  button.act {
    all: unset; cursor: pointer; box-sizing: border-box;
    padding: 6px 12px; border-radius: 8px; font-size: 12.5px; font-weight: 600;
    border: 1px solid #d6dde9; color: #1f2937; background: #f8fafc;
  }
  button.act:hover { background: #eef2f7; }
  button.act.primary {
    border-color: #1d4ed8; color: #fff;
    background: linear-gradient(135deg, #1d4ed8, #3b82f6);
  }
  button.act.primary:hover { filter: brightness(1.05); }
  button.act[disabled] { opacity: .55; cursor: not-allowed; }
  .list { display: flex; flex-direction: column; gap: 6px; max-height: 168px; overflow: auto; }
  .list a { color: #1d4ed8; text-decoration: none; font-size: 12px; }
  .list a:hover { text-decoration: underline; }
  .hidden { display: none !important; }
`;

const PHASE_TEXT = {
  queued: '排队中…',
  resolve: '正在打开阅读器…',
  meta: '读取文档信息…',
  urls: '获取页面地址…',
  pages: '下载页面…',
  build: '合成 PDF…',
  save: '保存文件…',
  done: '已保存',
  error: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

/**
 * @param {{title?:string, subtitle?:string, actions?:Array<{id:string,label:string,primary?:boolean}>,
 *          onAction?:(id:string)=>void, onClose?:()=>void}} opts
 */
export function createPanel(opts = {}) {
  const host = document.createElement('div');
  host.id = 'lzu-thesis-helper-host';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = STYLE;

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="head">
      <span class="logo">L</span>
      <span class="name">兰大论文全文助手</span>
      <button class="close" title="收起">✕</button>
    </div>
    <div class="body">
      <div class="title"></div>
      <div class="sub hidden"></div>
      <div class="bar hidden"><i></i></div>
      <div class="status"></div>
      <div class="row actions"></div>
    </div>`;

  shadow.appendChild(style);
  shadow.appendChild(card);

  const $ = (sel) => card.querySelector(sel);
  const titleEl = $('.title');
  const subEl = $('.sub');
  const barEl = $('.bar');
  const barFill = $('.bar > i');
  const statusEl = $('.status');
  const actionsEl = $('.actions');
  const closeEl = $('.close');

  const actionButtons = new Map();
  const state = { busy: false };

  function setTitle(text) {
    titleEl.textContent = text || '';
    titleEl.classList.toggle('hidden', !text);
  }

  function setSubtitle(text) {
    subEl.textContent = text || '';
    subEl.classList.toggle('hidden', !text);
  }

  function setStatus(text, kind = '') {
    statusEl.textContent = text || '';
    statusEl.className = `status ${kind}`.trim();
  }

  function setProgress(done, total) {
    const show = Number.isFinite(done) && Number.isFinite(total) && total > 0;
    barEl.classList.toggle('hidden', !show);
    if (show) barFill.style.width = `${Math.max(0, Math.min(100, (done / total) * 100)).toFixed(1)}%`;
  }

  function setBusy(busy) {
    state.busy = busy;
    for (const [id, btn] of actionButtons) {
      if (id === 'workspace' || id === 'help') continue;
      btn.disabled = busy;
    }
  }

  function setActions(actions = []) {
    actionsEl.textContent = '';
    actionButtons.clear();
    for (const action of actions) {
      const btn = document.createElement('button');
      btn.className = `act${action.primary ? ' primary' : ''}`;
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        if (state.busy && action.primary) return;
        if (opts.onAction) opts.onAction(action.id);
      });
      actionsEl.appendChild(btn);
      actionButtons.set(action.id, btn);
    }
  }

  /** 把 background 的 task 快照映射到浮层。 */
  function applyTask(task) {
    if (!task) return;
    if (task.title) setTitle(task.title);
    if (task.total) setSubtitle(`${task.total} 页${task.fid ? ` · ${task.fid.slice(0, 8)}…` : ''}`);
    setProgress(task.done, task.total);
    const phase = PHASE_TEXT[task.phase] || PHASE_TEXT[task.status] || '';
    if (task.status === 'done') {
      setBusy(false);
      setStatus(`✓ ${task.msg || `已保存 ${task.filename || ''}`}`, 'done');
    } else if (task.status === 'error') {
      setBusy(false);
      setStatus(`✗ ${task.error || '下载失败'}`, 'error');
    } else if (task.status === 'cancelled' || task.status === 'interrupted') {
      setBusy(false);
      setStatus(task.status === 'cancelled' ? '已取消' : (task.error || '任务已中断'), 'error');
    } else {
      setBusy(true);
      setStatus(task.msg || phase);
    }
  }

  closeEl.addEventListener('click', () => {
    if (opts.onClose) opts.onClose();
    else host.remove();
  });

  setTitle(opts.title || '');
  if (opts.subtitle) setSubtitle(opts.subtitle);
  else subEl.classList.add('hidden');
  setActions(opts.actions || []);

  (document.body || document.documentElement).appendChild(host);

  return {
    host,
    setTitle,
    setSubtitle,
    setStatus,
    setProgress,
    setBusy,
    setActions,
    applyTask,
    remove: () => host.remove(),
  };
}
