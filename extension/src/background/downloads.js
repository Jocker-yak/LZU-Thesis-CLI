/**
 * 把内存里的 PDF 交下载。
 *
 * Chrome 的 service worker 里没有 DOM，`URL.createObjectURL` 不可靠 →
 * 用 offscreen document 造 blob URL；Firefox 的后台页本身有 DOM，直接造。
 * 都失败就退回 data: URL（大文件不推荐，仅兜底）。
 */
import { api, isFirefox, logEvent, bytesToBase64 } from '../lib/ext.js';

let offscreenCreating = null;

async function hasOffscreenDocument() {
  if (!api.offscreen) return false;
  try {
    if (typeof api.offscreen.hasDocument === 'function') return await api.offscreen.hasDocument();
  } catch {
    /* 老版本没有 hasDocument */
  }
  return false;
}

async function ensureOffscreen() {
  if (isFirefox) return false;
  if (!api.offscreen) return false;
  const existing = await hasOffscreenDocument();
  // hasDocument 不可用时直接尝试 createDocument，重复创建会报错（已存在），忽略
  if (existing && typeof api.offscreen.hasDocument === 'function') return true;
  if (offscreenCreating) {
    await offscreenCreating.catch(() => {});
    return true;
  }
  offscreenCreating = (async () => {
    try {
      await api.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: '在离线文档里生成 PDF 的 blob URL，交给下载接口',
      });
    } catch (err) {
      if (!/already|exists|single offscreen/i.test(String(err && err.message))) {
        logEvent('warn', `offscreen 创建失败：${err && err.message}`);
      }
    }
  })();
  await offscreenCreating.catch(() => {});
  offscreenCreating = null;
  return true;
}

async function offscreenMakeUrl(bytes, mime) {
  await ensureOffscreen();
  const reply = await api.runtime.sendMessage({
    target: 'offscreen',
    type: 'make-url',
    mime,
    base64: bytesToBase64(bytes),
  });
  if (!reply || !reply.ok) throw new Error((reply && reply.error) || 'offscreen 无响应');
  return reply;
}

async function offscreenRevoke(id) {
  try {
    await api.runtime.sendMessage({ target: 'offscreen', type: 'revoke', id });
  } catch {
    /* ignore */
  }
}

function dataUrl(bytes, mime) {
  return `data:${mime || 'application/pdf'};base64,${bytesToBase64(bytes)}`;
}

/**
 * @param {Uint8Array} bytes
 * @param {string} filename
 * @param {{saveAs?:boolean, mime?:string}} [opts]
 * @returns {Promise<{downloadId:number|null, filename:string, via:string}>}
 */
export async function saveBytes(bytes, filename, { saveAs = false, mime = 'application/pdf' } = {}) {
  const name = filename || 'document.pdf';
  let url = '';
  let via = '';
  let offscreenId = null;

  if (!isFirefox) {
    try {
      const made = await offscreenMakeUrl(bytes, mime);
      url = made.url;
      offscreenId = made.id;
      via = 'offscreen';
    } catch (err) {
      logEvent('warn', `offscreen 造 URL 失败，换后台页：${err.message}`);
    }
  }

  if (!url) {
    try {
      url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      via = via || 'blob';
      // 后台页可以直接 revoke，交给下载后清理
      setTimeout(() => {
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
      }, 180000);
    } catch (err) {
      logEvent('warn', `blob URL 失败，用 data URL：${err.message}`);
      url = dataUrl(bytes, mime);
      via = 'data';
    }
  }

  const downloadId = await api.downloads.download({ url, filename: name, saveAs });
  if (offscreenId) {
    // 下载真正完成后再 revoke（拿不到事件也兜底）
    const cleanup = () => {
      offscreenRevoke(offscreenId);
      try { api.downloads.onChanged.removeListener(listener); } catch { /* ignore */ }
      clearTimeout(timer);
    };
    const listener = (delta) => {
      if (delta && delta.id === downloadId && delta.state
        && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
        cleanup();
      }
    };
    const timer = setTimeout(cleanup, 180000);
    try {
      api.downloads.onChanged.addListener(listener);
    } catch {
      setTimeout(cleanup, 30000);
    }
  }

  return { downloadId, filename: name, via };
}

export { isFirefox };
