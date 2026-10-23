/** 设置项（storage.local 里一个 settings 对象）。 */
import { api } from './ext.js';

export const DEFAULT_SETTINGS = {
  /** PDF 里标注的物理尺寸用：像素 × 72 / resolution（与 CLI 的 Pillow resolution=150 对齐）。 */
  resolution: 150,
  /** 每页图片并发数（对 .29 太猛会触发限流）。 */
  concurrency: 2,
  /** 传输方式：auto = 同源桥接优先，失败退回后台 fetch。 */
  transport: 'auto',
  /** 文件名取哪个字段。 */
  filenameSource: 'infoname',
  /** 下载时是否弹“另存为”。 */
  saveAs: false,
  /** 检索时是否顺便识别 fid（会为每条记录短暂开标签页，慢）。 */
  resolveFidOnSearch: false,
};

const KEY = 'settings';

export async function getSettings() {
  try {
    const got = await api.storage.local.get(KEY);
    return { ...DEFAULT_SETTINGS, ...(got[KEY] || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await api.storage.local.set({ [KEY]: next });
  return next;
}

export function onSettingsChanged(callback) {
  if (!api.storage || !api.storage.onChanged) return () => {};
  const listener = (changes, area) => {
    if (area === 'local' && changes[KEY]) callback({ ...DEFAULT_SETTINGS, ...(changes[KEY].newValue || {}) });
  };
  api.storage.onChanged.addListener(listener);
  return () => api.storage.onChanged.removeListener(listener);
}

/** 记住上次检索的关键词。 */
const LAST_KEYWORD = 'lastKeyword';

export async function getLastKeyword() {
  try {
    const got = await api.storage.local.get(LAST_KEYWORD);
    return typeof got[LAST_KEYWORD] === 'string' ? got[LAST_KEYWORD] : '';
  } catch {
    return '';
  }
}

export async function setLastKeyword(keyword) {
  try {
    await api.storage.local.set({ [LAST_KEYWORD]: String(keyword || '') });
  } catch {
    /* ignore */
  }
}
