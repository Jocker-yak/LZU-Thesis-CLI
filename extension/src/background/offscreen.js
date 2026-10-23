/**
 * Chrome offscreen document：唯一职责是把 PDF 字节变成 blob URL（service worker 里没有 DOM）。
 */
const urls = new Map();

function base64ToBytes(text) {
  const clean = String(text || '').replace(/[^A-Za-z0-9+/=]/g, '');
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return undefined;

  if (message.type === 'ping') {
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'make-url') {
    try {
      const bytes = base64ToBytes(message.base64);
      const url = URL.createObjectURL(new Blob([bytes], { type: message.mime || 'application/pdf' }));
      const id = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      urls.set(id, url);
      sendResponse({ ok: true, id, url });
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message) });
    }
    return true;
  }

  if (message.type === 'revoke') {
    const url = urls.get(message.id);
    if (url) {
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
      urls.delete(message.id);
    }
    sendResponse({ ok: true });
    return true;
  }

  return undefined;
});

// 页面关闭时兜底清理
window.addEventListener('pagehide', () => {
  for (const url of urls.values()) {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  }
  urls.clear();
});
