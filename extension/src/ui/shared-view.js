/**
 * popup 与工作台共用的界面：同一个 mountView，`compact` 决定显示哪些页签。
 * 只用 DOM API（MV3 CSP 不允许内联脚本；动态内容一律 textContent，避免注入）。
 */
import { api } from '../lib/ext.js';
import { extractToken, decodeToken } from '../lib/protocol.js';

const PHASES = {
  queued: '排队中',
  resolve: '打开阅读器',
  meta: '读取文档信息',
  urls: '获取页面地址',
  pages: '下载页面',
  build: '合成 PDF',
  save: '保存文件',
  done: '完成',
  error: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

const COMPACT_TABS = [
  ['search', '检索'],
  ['token', '令牌'],
  ['link', '直链'],
];

const FULL_TABS = [
  ['search', '检索'],
  ['tasks', '任务'],
  ['history', '历史'],
  ['settings', '设置'],
  ['log', '日志'],
  ['help', '帮助'],
];

// ---------------------------------------------------------------- 工具

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'onClick') node.addEventListener('click', value);
    else if (key === 'onInput') node.addEventListener('input', value);
    else if (key === 'onChange') node.addEventListener('change', value);
    else if (key === 'onSubmit') node.addEventListener('submit', value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

async function call(type, extra = {}) {
  let reply;
  try {
    reply = await api.runtime.sendMessage({ type, ...extra });
  } catch (err) {
    throw new Error(`后台没有响应（${err && err.message}）`);
  }
  if (!reply) throw new Error('后台没有响应');
  if (reply.ok === false) throw new Error(reply.error || '操作失败');
  return reply;
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function phaseText(task) {
  const key = task.phase || task.status;
  return PHASES[key] || key || '';
}

// ---------------------------------------------------------------- 主界面

/**
 * @param {HTMLElement} root
 * @param {{compact?:boolean}} [opts]
 */
export function mountView(root, { compact = false } = {}) {
  const TAB_LIST = compact ? COMPACT_TABS : FULL_TABS;
  const state = {
    compact,
    tab: TAB_LIST[0][0],
    settings: null,
    lastKeyword: '',
    tasks: [],
    rows: [],
    rowState: new Map(), // rowKey → {busy, fid, status, error}
    keyword: '',
    probe: null,
    toastTimer: null,
  };

  // ---- 外壳
  const dot = el('span', { class: 'status-dot', title: '正在检测门户/阅读器连通性…' });
  const topbar = el('header', { class: 'topbar' }, [
    el('div', { class: 'brand' }, [
      el('span', { class: 'logo', text: 'L' }),
      el('div', {}, [
        el('h1', { text: '兰大论文全文助手' }),
        el('div', { class: 'sub', text: fmtVersion() }),
      ]),
    ]),
    el('span', { class: 'spacer' }),
    dot,
    compact
      ? el('button', { text: '工作台', onClick: openWorkspace })
      : el('button', { text: '重新检测', onClick: () => probe(true) }),
  ]);

  const tabs = el('nav', { class: 'tabs' });
  const view = el('main', { class: 'view' });
  const toast = el('div', { class: 'toast' });

  root.textContent = '';
  root.appendChild(el('div', { class: 'app' }, [topbar, tabs, view]));
  root.appendChild(toast);

  const tabButtons = new Map();
  for (const [id, label] of TAB_LIST) {
    const btn = el('button', { text: label, onClick: () => showTab(id) });
    tabButtons.set(id, btn);
    tabs.appendChild(btn);
  }

  function showTab(id) {
    state.tab = id;
    for (const [key, btn] of tabButtons) btn.classList.toggle('active', key === id);
    render();
  }

  function showToast(message, isError = false) {
    toast.textContent = message;
    toast.className = `toast show${isError ? ' error' : ''}`;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3200);
  }

  async function openWorkspace() {
    try {
      await call('open-app', { hash: '#/workspace' });
      window.close();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  async function probe(refresh = false) {
    dot.className = 'status-dot';
    dot.title = '检测中…';
    try {
      const reply = await call('probe');
      state.probe = reply;
      const portalOk = reply.portal && reply.portal.ok === true;
      const readerOk = reply.reader && reply.reader.ok === true;
      const skipped = reply.portal && reply.portal.ok === null;
      dot.className = `status-dot ${portalOk ? 'ok' : (skipped ? 'unknown' : 'bad')}`;
      dot.title = skipped
        ? `门户 202.201.7.17 / 阅读器 202.201.7.29：${reply.portal.note || '需先打开站点页面'}` : `门户 202.201.7.17：${portalOk ? `可达 ${reply.portal.status || 200}` : '不可达（校内网/登录）'}；阅读器 202.201.7.29：${readerOk ? '可达' : '不可达'}`;
      if (refresh) {
        if (skipped) showToast(reply.portal.note || '打开门户页面后即可使用', false);
        else showToast(portalOk ? '门户可达' : '门户不可达：请确认校内网与登录状态', !portalOk);
      }
    } catch (err) {
      dot.className = 'status-dot bad';
      dot.title = err.message;
    }
    // 设置里的 probe 结果供检索页提示
    if (state.tab === 'search') render();
  }

  function fmtVersion() {
    try {
      const manifest = api.runtime.getManifest();
      return `v${manifest.version} · 校内网 · 复用已登录会话`;
    } catch {
      return '校内网 · 复用已登录会话';
    }
  }

  // ---- 任务/行的实时更新
  api.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.type !== 'string') return false;
    if (message.type === 'task-update' && message.task) {
      mergeTask(message.task);
      if (state.tab === 'tasks') render();
      else if (state.tab === 'search') refreshRowStatuses();
    } else if (message.type === 'row-link') {
      applyRowLink(message);
    } else if (message.type === 'row-fid') {
      applyRowFid(message);
    } else if (message.type === 'row-fid-done') {
      showToast(`fid 解析完成（${message.count} 条）`);
    }
    return false;
  });

  function mergeTask(task) {
    const index = state.tasks.findIndex((t) => t.id === task.id);
    if (index >= 0) state.tasks[index] = { ...state.tasks[index], ...task };
    else state.tasks.unshift(task);
    state.tasks = state.tasks.slice(0, 30);
  }

  // ---- 页签渲染
  function render() {
    clear(view);
    if (state.tab === 'search') renderSearch();
    else if (state.tab === 'token') renderToken();
    else if (state.tab === 'link') renderLink();
    else if (state.tab === 'tasks') renderTasks();
    else if (state.tab === 'history') renderHistory();
    else if (state.tab === 'settings') renderSettings();
    else if (state.tab === 'log') renderLog();
    else if (state.tab === 'help') renderHelp();
  }

  // ---------------------------------------------------------------- 检索
  let rowsWrap = null;

  function renderSearch() {
    const input = el('input', {
      type: 'text',
      placeholder: '作者姓名 / 题名关键词，如：侯扶江',
      value: state.keyword || '',
      onInput: (e) => { state.keyword = e.target.value; },
    });
    const submit = el('button', { class: 'primary', type: 'submit', text: '检索' });
    const form = el('form', {
      class: 'form-row',
      onSubmit: async (event) => {
        event.preventDefault();
        await doSearch(input.value.trim(), submit);
      },
    }, [input, submit]);

    const probeSkipped = state.probe && state.probe.portal && state.probe.portal.ok === null;
    const probeFailed = state.probe && state.probe.portal && state.probe.portal.ok === false;
    const probeHint = el('div', {
      class: `hint${probeFailed ? ' error' : ''}`,
      text: probeFailed
        ? '门户当前不可达：请连校内网并在浏览器里登录门户后再试。'
        : (probeSkipped
          ? (state.probe.portal.note || 'Firefox 需先打开门户页面，之后会自动使用页面内通道。')
          : '检索走门户 xkcode 07* 库；只读检索，不改变任何数据。'),
    });

    const toolbar = el('div', { class: 'toolbar' }, [
      el('button', { text: '解析全部 fid', onClick: () => resolveAllFids() }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'hint', text: state.lastKeyword ? `上次：${state.lastKeyword}` : '' }),
    ]);

    rowsWrap = el('div', { class: 'rows' });
    view.appendChild(el('h2', { text: '检索论文' }));
    view.appendChild(form);
    view.appendChild(probeHint);
    view.appendChild(toolbar);
    view.appendChild(rowsWrap);
    renderRows();
    if (state.rows.length === 0) {
      rowsWrap.appendChild(el('div', { class: 'empty', text: '还没有结果。输入关键词后回车或点「检索」。' }));
    }
  }

  function renderRows() {
    if (!rowsWrap) return;
    clear(rowsWrap);
    if (!state.rows.length) return;
    for (const row of state.rows) rowsWrap.appendChild(buildRow(row));
  }

  function refreshRowStatuses() {
    if (!rowsWrap) return;
    renderRows();
  }

  function rowKey(row) {
    return `${row.id1}/${row.id2}`;
  }

  function buildRow(row) {
    const key = rowKey(row);
    const rs = state.rowState.get(key) || {};
    const statusClass = rs.error ? 'err' : rs.fid ? 'ok' : '';
    const statusText = rs.error || (rs.fid ? `fid ${rs.fid.slice(0, 10)}…` : rs.status || '未解析 fid');
    return el('div', { class: 'row' }, [
      el('div', { class: 'row-title', text: row.title || '(无标题)' }),
      el('div', { class: 'row-meta', text: `id1 ${String(row.id1).slice(0, 12)}… · ${row.link ? '有全文入口' : '无全文入口'}` }),
      el('div', { class: 'row-actions' }, [
        el('button', {
          class: 'primary',
          text: rs.busy ? '处理中…' : '下载全文',
          disabled: !row.link || rs.busy ? true : null,
          onClick: () => downloadRow(row),
        }),
        el('button', {
          text: '仅解析 fid',
          disabled: rs.busy ? true : null,
          onClick: () => resolveRow(row),
        }),
        row.link ? el('button', { class: 'link', text: '打开入口', onClick: () => openUrl(row.link) }) : null,
      ]),
      el('div', { class: `row-status ${statusClass}`.trim(), text: statusText }),
    ]);
  }

  async function doSearch(keyword, button) {
    if (!keyword) {
      showToast('请输入检索词', true);
      return;
    }
    state.keyword = keyword;
    button.disabled = true;
    button.textContent = '检索中…';
    try {
      const reply = await call('search', { keyword });
      state.rows = reply.rows || [];
      state.lastKeyword = reply.keyword || keyword;
      state.rowState = new Map();
      if (state.rows.length === 0) showToast('没有检索到记录');
      else showToast(`共 ${state.rows.length} 条${reply.total ? `（门户标称 ${reply.total} 条）` : ''}`);
      render();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      button.disabled = false;
      button.textContent = '检索';
    }
  }

  async function resolveAllFids() {
    if (!state.rows.length) {
      showToast('请先检索', true);
      return;
    }
    try {
      await call('resolve-fids', { rows: state.rows });
      showToast('开始后台解析 fid…');
    } catch (err) {
      showToast(err.message, true);
    }
  }

  function applyRowLink(message) {
    const row = state.rows.find((r) => r.id1 === message.id1 && r.id2 === message.id2);
    if (!row) return;
    if (message.link) row.link = message.link;
    if (state.tab === 'search') renderRows();
  }

  function applyRowFid(message) {
    if (!message || !message.id1) return;
    const key = `${message.id1}/${message.id2}`;
    const prev = state.rowState.get(key) || {};
    state.rowState.set(key, {
      ...prev,
      busy: false,
      fid: message.fid || null,
      error: message.error || null,
      status: message.fid ? `fid ${message.fid.slice(0, 10)}…` : (message.error || '未解析 fid'),
    });
    if (state.tab === 'search') renderRows();
  }

  async function resolveRow(row) {
    const key = rowKey(row);
    state.rowState.set(key, { ...(state.rowState.get(key) || {}), busy: true, status: '解析 fid…', error: null });
    renderRows();
    try {
      const reply = await call('resolve-link', { link: row.link });
      state.rowState.set(key, { busy: false, fid: reply.fid, status: `fid ${reply.fid.slice(0, 10)}…`, error: null });
      mergeTask(await start({ fid: reply.fid }));
    } catch (err) {
      state.rowState.set(key, { busy: false, error: err.message, fid: null });
    }
    if (state.tab === 'search') renderRows();
  }

  async function downloadRow(row) {
    const key = rowKey(row);
    const rs = state.rowState.get(key) || {};
    state.rowState.set(key, { ...rs, busy: true, status: '准备下载…', error: null });
    renderRows();
    try {
      if (rs.fid) {
        mergeTask(await start({ fid: rs.fid }));
        state.rowState.set(key, { ...rs, busy: false, status: '已加入下载', error: null });
      } else {
        const reply = await call('resolve-link', { link: row.link });
        state.rowState.set(key, { busy: false, fid: reply.fid, status: `fid ${reply.fid.slice(0, 10)}…`, error: null });
        mergeTask(await start({ fid: reply.fid }));
      }
      if (state.compact) showToast('已开始下载，进度见任务页/浮层');
    } catch (err) {
      state.rowState.set(key, { busy: false, error: err.message, fid: rs.fid || null });
      showToast(err.message, true);
    }
    if (state.tab === 'search') renderRows();
  }

  async function start(payload) {
    const reply = await call('start', payload);
    return reply.task;
  }

  // ---------------------------------------------------------------- 令牌
  function renderToken() {
    const textarea = el('textarea', {
      placeholder: '粘贴令牌，或含 personaliiifServlet?path=… 的链接/HTML 片段',
      onInput: () => { preview(); },
    });
    const previewBox = el('div', { class: 'card' });

    function preview() {
      clear(previewBox);
      const token = extractToken(textarea.value);
      if (!token) {
        previewBox.appendChild(el('div', { class: 'hint', text: '还没识别到令牌（有效令牌至少 20 个字符）。' }));
        return;
      }
      let info;
      try {
        info = decodeToken(token);
      } catch (err) {
        previewBox.appendChild(el('div', { class: 'hint error', text: `令牌解析失败：${err.message}` }));
        return;
      }
      previewBox.appendChild(el('dl', { class: 'kv' }, [
        el('dt', { text: '题名' }), el('dd', { text: info.infoname || '(空)' }),
        el('dt', { text: '文件名' }), el('dd', { text: info.filename || '(空)' }),
        el('dt', { text: '页数' }), el('dd', { text: info.endpage ? `1 – ${info.endpage}` : '未知' }),
        el('dt', { text: '存储路径' }), el('dd', { text: info.path }),
        el('dt', { text: '令牌长度' }), el('dd', { text: `${token.length} 字符（前缀 ${info.prefix}）` }),
      ]));
    }

    const download = el('button', {
      class: 'primary', text: '开始下载',
      onClick: async () => {
        const token = extractToken(textarea.value);
        if (!token) {
          showToast('没识别到令牌', true);
          return;
        }
        try {
          const task = await start({ token });
          mergeTask(task);
          showToast('已开始下载，可在工作台查看进度');
        } catch (err) {
          showToast(err.message, true);
        }
      },
    });

    view.appendChild(el('h2', { text: '用令牌下载' }));
    view.appendChild(el('div', { class: 'hint', text: '令牌有效期很短（几分钟到几十分钟），由门户 docinfo 页的 onlinePDF 入口生成。' }));
    view.appendChild(textarea);
    view.appendChild(el('div', { class: 'toolbar' }, [download]));
    view.appendChild(previewBox);
    preview();
  }

  // ---------------------------------------------------------------- 直链
  function renderLink() {
    const textarea = el('textarea', {
      placeholder: '粘贴 onlinePDF 链接（http://202.201.7.17/onlinePDF?dbid=72&objid=…&state=free&flag=online）',
    });
    const download = el('button', {
      class: 'primary', text: '开始下载',
      onClick: async () => {
        const link = textarea.value.trim();
        if (!link) {
          showToast('请粘贴链接', true);
          return;
        }
        try {
          const task = await start({ link });
          mergeTask(task);
          showToast('已开始下载，可在工作台查看进度');
        } catch (err) {
          showToast(err.message, true);
        }
      },
    });
    view.appendChild(el('h2', { text: '用全文链接下载' }));
    view.appendChild(el('div', { class: 'hint', text: '在门户论文详情页右键复制 onlinePDF 链接即可；插件会用当前浏览器会话打开它并识别 fid。' }));
    view.appendChild(textarea);
    view.appendChild(el('div', { class: 'toolbar' }, [download]));
    view.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'hint', text: '提示：也可以在门户「查看论文信息」页或阅读器页上直接用右下角浮层按钮。' }),
    ]));
  }

  // ---------------------------------------------------------------- 任务
  function renderTasks() {
    view.appendChild(el('div', { class: 'toolbar' }, [
      el('h2', { text: '下载任务' }),
      el('span', { class: 'spacer' }),
      el('button', {
        text: '刷新',
        onClick: async () => {
          try {
            const reply = await call('list-tasks');
            state.tasks = reply.tasks || [];
            render();
          } catch (err) {
            showToast(err.message, true);
          }
        },
      }),
    ]));
    const list = el('div', { class: 'rows' });
    if (!state.tasks.length) list.appendChild(el('div', { class: 'empty', text: '暂无任务。去「检索」或「令牌」页发起一个下载。' }));
    for (const task of state.tasks) {
      const done = task.status === 'done';
      const failed = task.status === 'error' || task.status === 'interrupted';
      const list$ = el('div', { class: 'row' }, [
        el('div', { class: 'row-title', text: task.title || task.filename || task.fid || '(未知文档)' }),
        el('div', { class: 'row-meta', text: `${phaseText(task)}${task.total ? ` · ${task.done || 0}/${task.total} 页` : ''}${task.filename ? ` · ${task.filename}` : ''}` }),
        el('div', { class: `bar${done ? ' done' : failed ? ' err' : ''}`.trim() }, [
          el('i', { style: `width:${task.total ? Math.min(100, Math.round(((task.done || 0) / task.total) * 100)) : 0}%` }),
        ]),
        el('div', { class: 'row-actions' }, [
          el('span', {
            class: `row-status ${done ? 'ok' : failed ? 'err' : ''}`.trim(),
            text: task.status === 'running' ? (task.msg || '进行中…') : (task.error || task.msg || task.status),
          }),
          task.status === 'running'
            ? el('button', { class: 'danger', text: '取消', onClick: () => cancelTask(task.id) })
            : null,
        ]),
      ]);
      list.appendChild(list$);
    }
    view.appendChild(list);
    if (!state.tasks.length) return;
    call('list-tasks').then((reply) => {
      if (state.tab === 'tasks') {
        state.tasks = reply.tasks || [];
        render();
      }
    }).catch(() => {});
  }

  async function cancelTask(id) {
    try {
      await call('cancel-task', { id });
      showToast('已请求取消');
    } catch (err) {
      showToast(err.message, true);
    }
  }

  // ---------------------------------------------------------------- 历史
  function renderHistory() {
    const list = el('div', { class: 'list' });
    view.appendChild(el('div', { class: 'toolbar' }, [
      el('h2', { text: '下载历史' }),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'danger', text: '清空',
        onClick: async () => {
          try {
            await call('history:clear');
            render();
          } catch (err) {
            showToast(err.message, true);
          }
        },
      }),
    ]));
    view.appendChild(list);
    list.appendChild(el('div', { class: 'empty', text: '加载中…' }));
    call('history:get').then((reply) => {
      clear(list);
      const entries = reply.entries || [];
      if (!entries.length) {
        list.appendChild(el('div', { class: 'empty', text: '还没有下载记录。' }));
        return;
      }
      for (const entry of entries) {
        list.appendChild(el('div', { class: 'list-item' }, [
          el('span', { class: 't', text: fmtTime(entry.endedAt) }),
          el('span', { class: 'm', text: `${entry.title || entry.fid || ''}${entry.filename ? ` · ${entry.filename}` : ''}${entry.pageCount ? ` · ${entry.pageCount} 页` : ''}` }),
          el('span', { class: `lv ${entry.status === 'done' ? '' : 'error'}`.trim(), text: entry.status === 'done' ? fmtSize(entry.bytes) || '完成' : '失败' }),
        ]));
      }
    }).catch((err) => {
      clear(list);
      list.appendChild(el('div', { class: 'hint error', text: err.message }));
    });
  }

  // ---------------------------------------------------------------- 设置
  function renderSettings() {
    view.appendChild(el('h2', { text: '设置' }));
    const box = el('div', { class: 'settings' });
    view.appendChild(box);
    box.appendChild(el('div', { class: 'empty', text: '加载中…' }));
    call('settings:get').then((reply) => {
      clear(box);
      const settings = reply.settings || {};
      const fields = [];
      const add = (label, control, hintText) => {
        fields.push(el('div', { class: 'field' }, [el('label', { text: label }), control, hintText ? el('div', { class: 'hint', text: hintText }) : null]));
      };

      const transport = el('select', {}, [
        el('option', { value: 'auto', text: '自动（优先页面内桥接，失败退回后台请求）' }),
        el('option', { value: 'bridge', text: '只用页面内桥接（会话最可靠）' }),
        el('option', { value: 'bg', text: '只用后台 fetch（不推荐）' }),
      ]);
      transport.value = settings.transport || 'auto';
      add('传输方式', transport, '.29 的会话 cookie 只有同源页面请求才稳定带上，默认 auto 即可。');

      const resolution = el('input', { type: 'number', min: '72', max: '300', step: '10', value: String(settings.resolution || 150) });
      add('PDF 分辨率（dpi）', resolution, '页面尺寸 = 像素 × 72 / dpi；与服务端 150dpi 对齐时最接近原始排版。');

      const concurrency = el('input', { type: 'number', min: '1', max: '4', step: '1', value: String(settings.concurrency || 2) });
      add('并发下载页数', concurrency, '1–4；服务端不稳时调到 1。');

      const filenameSource = el('select', {}, [
        el('option', { value: 'infoname', text: '题名' }),
        el('option', { value: 'filename', text: '原始文件名' }),
      ]);
      filenameSource.value = settings.filenameSource || 'infoname';
      add('PDF 文件名来源', filenameSource);

      const saveAs = el('input', { type: 'checkbox' });
      saveAs.checked = Boolean(settings.saveAs);
      fields.push(el('label', { class: 'check' }, [saveAs, el('span', { text: '每次下载都弹出「另存为」对话框' })]));

      const resolveOnSearch = el('input', { type: 'checkbox' });
      resolveOnSearch.checked = Boolean(settings.resolveFidOnSearch);
      fields.push(el('label', { class: 'check' }, [resolveOnSearch, el('span', { text: '检索后自动在后台解析每条记录的 fid' })]));

      const save = el('button', {
        class: 'primary', text: '保存设置',
        onClick: async () => {
          try {
            await call('settings:set', {
              patch: {
                transport: transport.value,
                resolution: Number(resolution.value) || 150,
                concurrency: Number(concurrency.value) || 2,
                filenameSource: filenameSource.value,
                saveAs: saveAs.checked,
                resolveFidOnSearch: resolveOnSearch.checked,
              },
            });
            showToast('已保存');
          } catch (err) {
            showToast(err.message, true);
          }
        },
      });
      for (const field of fields) box.appendChild(field);
      box.appendChild(el('div', { class: 'toolbar' }, [save]));
    }).catch((err) => {
      clear(box);
      box.appendChild(el('div', { class: 'hint error', text: err.message }));
    });
  }

  // ---------------------------------------------------------------- 日志
  function renderLog() {
    const list = el('div', { class: 'list' });
    view.appendChild(el('div', { class: 'toolbar' }, [
      el('h2', { text: '运行日志' }),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'danger', text: '清空',
        onClick: async () => {
          try {
            await call('log:clear');
            render();
          } catch (err) {
            showToast(err.message, true);
          }
        },
      }),
    ]));
    view.appendChild(el('div', { class: 'hint', text: '本地环形日志（最多 200 条），不含任何 cookie 或令牌全文。' }));
    view.appendChild(list);
    call('log:get').then((reply) => {
      clear(list);
      const entries = (reply.entries || []).slice().reverse();
      if (!entries.length) {
        list.appendChild(el('div', { class: 'empty', text: '还没有日志。' }));
        return;
      }
      for (const entry of entries) {
        list.appendChild(el('div', { class: 'list-item' }, [
          el('span', { class: 't', text: fmtTime(entry.t) }),
          el('span', { class: `lv ${entry.level}` .trim(), text: entry.level }),
          el('span', { class: 'm', text: entry.message }),
        ]));
      }
    }).catch((err) => {
      clear(list);
      list.appendChild(el('div', { class: 'hint error', text: err.message }));
    });
  }

  // ---------------------------------------------------------------- 帮助
  function renderHelp() {
    view.appendChild(el('h2', { text: '使用说明' }));
    view.appendChild(el('div', { class: 'help card' }, [
      el('ol', {}, [
        el('li', {}, ['在浏览器里登录 ', el('strong', { text: '兰州大学图书馆门户' }), '，并连校内网 / VPN。']),
        el('li', {}, ['检索：输入作者或题名 → 回车 → 点某条记录的「下载全文」；插件会自动打开隐藏页面识别 fid 并抓取页面。']),
        el('li', {}, ['门户「查看论文信息」页、阅读器页面右下角也会出现浮层按钮，可直接下载。']),
        el('li', {}, ['下载的 PDF 只含阅读器渲染的 ', el('strong', { text: '图片页' }), '，没有文字层，且带门户水印。']),
        el('li', {}, ['令牌很短命（几分钟到几十分钟）；失效会提示「令牌对应的文件已不存在」。']),
        el('li', {}, ['抓取时会短暂出现一个后台标签页（', el('code', { text: 'tabs.create({active:false})' }), '），可忽略。']),
      ]),
      el('p', { class: 'note', text: '仅用于你本来就有权访问的论文；请遵守学校与数据库的使用条款，不要批量下载或传播。' }),
      el('p', { class: 'note', text: '技术细节与故障排查见插件目录下的 README.md。' }),
    ]));
  }

  // ---- 初始化
  probe(false);
  call('settings:get').then((reply) => {
    state.settings = reply.settings;
    state.lastKeyword = reply.lastKeyword || '';
    if (state.tab === 'search' && !state.rows.length) render();
  }).catch(() => {});
  call('list-tasks').then((reply) => {
    state.tasks = reply.tasks || [];
    if (state.tab === 'tasks') render();
  }).catch(() => {});

  api.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'task-update' && message.task) mergeTask(message.task);
    return false;
  });

  showTab(state.tab);
  return { showTab, refresh: render };
}

export { PHASES };
