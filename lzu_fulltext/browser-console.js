/* ============================================================================
   在“全文阅读”页面里运行：把整篇文档的每一页图片抓下来，直接合成一个 PDF 保存。
   用法：
     1) 用浏览器打开能看到全文的那个阅读页面（地址栏带 fid=...）
     2) 按 F12 → Console（控制台）
     3) 把本文件全部内容粘贴进去，回车
     4) 等进度跑完，会自动下载  fulltext.pdf
   如果浏览器阻止下载，脚本最后会打印所有页面地址（也可以复制给 AI 处理）。
   ============================================================================ */
(async () => {
  const $ = (id) => document.getElementById(id);
  const val = (id) => { const e = $(id); return e ? e.value : null; };
  const qs = new URLSearchParams(location.search);

  // 1. 取文档信息
  const fid = (val('fid') && val('fid') !== 'null') ? val('fid') : qs.get('fid');
  let total = parseInt(val('pageCount'), 10);
  if (!Number.isFinite(total)) total = parseInt(val('endpage'), 10);
  const start = parseInt(val('startpage'), 10) || 1;
  console.log('%c[info]', 'color:#08f', { fid, total, start, filename: val('filename'), infoname: val('infoname') });
  if (!fid) return console.error('拿不到 fid，请确认这个页面能看到全文');

  const abs = (u) => (u.startsWith('http') ? u : new URL(u, location.href).href);

  // 2. 向 jumpServlet 要每一页的全尺寸图地址
  const urls = [];
  const add = (list) => (list || []).forEach((it) => {
    const u = abs(it.src || it);
    if (!urls.includes(u)) urls.push(u);
  });
  try {
    add((await (await fetch('jumpServlet?page=0&fid=' + encodeURIComponent(fid))).json()).list);
  } catch (e) { console.warn('jumpServlet 失败，改为一页一页取', e); }

  if (Number.isFinite(total) && urls.length < total) {
    for (let i = start; i <= total; i++) {
      if (urls.length >= total) break;
      try {
        add((await (await fetch('jumpServlet?page=' + i + '&fid=' + encodeURIComponent(fid))).json()).list);
      } catch (e) { /* 忽略 */ }
      console.log('  取地址进度', urls.length + '/' + total);
    }
  }
  console.log('%c[info] 共取得 ' + urls.length + ' 页图片地址', 'color:#08f');

  // 3. 逐页下载图片
  const pages = [];
  for (let i = 0; i < urls.length; i++) {
    const r = await fetch(urls[i], { credentials: 'include' });
    const b = await r.blob();
    const dataUrl = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); });
    const size = await new Promise((res) => { const im = new Image(); im.onload = () => res([im.naturalWidth, im.naturalHeight]); im.src = dataUrl; });
    pages.push({ dataUrl, w: size[0], h: size[1] });
    if (i % 10 === 0 || i === urls.length - 1) console.log('  下载进度 ' + (i + 1) + '/' + urls.length);
  }
  if (!pages.length) return console.error('没有下载到任何页面');

  // 4. 加载 jsPDF 并合成 PDF
  const load = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  try {
    if (!window.jspdf) {
      await load('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js')
        .catch(() => load('https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js'));
    }
    const { jsPDF } = window.jspdf;
    const p0 = pages[0];
    const pdf = new jsPDF({ unit: 'px', format: [p0.w, p0.h], orientation: p0.w > p0.h ? 'landscape' : 'portrait', compress: true });
    pages.forEach((p, i) => {
      if (i) pdf.addPage([p.w, p.h], p.w > p.h ? 'landscape' : 'portrait');
      pdf.addImage(p.dataUrl, 'JPEG', 0, 0, p.w, p.h);
      if (i % 25 === 0) console.log('  合成进度 ' + (i + 1) + '/' + pages.length);
    });
    const name = ((val('infoname') && val('infoname') !== 'null') || (val('filename') || 'fulltext')).replace(/\.pdf$/i, '') + '.pdf';
    pdf.save(name);
    console.log('%c[done] 已保存 ' + name + '，共 ' + pages.length + ' 页', 'color:#0a0;font-weight:bold');
  } catch (e) {
    console.warn('jsPDF 加载失败，改为输出所有页面地址', e);
    copy(urls.join('\n'));
    console.log('%c[fallback] 所有页面地址已复制到剪贴板（' + urls.length + ' 条），粘贴给 AI 即可替你把 PDF 拼出来', 'color:#a60;font-weight:bold');
  }
})();
