const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const parentCsp =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; worker-src 'none'";
const childCsp =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'";
export function frameHtml(html: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${childCsp}"><meta name="referrer" content="no-referrer"><style>body{margin:0;padding:8px 0 24px;color:#3f3f46;font:15px/1.8 ui-sans-serif,system-ui,sans-serif;background:#fff}h1,h2,h3{color:#27272a;line-height:1.4}h1{font-size:28px}h2{font-size:21px;margin-top:36px}code,pre{font-family:ui-monospace,monospace}pre{overflow:auto;padding:16px;background:#f7f8f7;border-radius:5px}button{cursor:pointer;font:inherit}a,[data-unfold-ref]{color:#508060;cursor:pointer}*{box-sizing:border-box}</style></head><body>${html}<script>document.addEventListener('click',e=>{const n=e.target.closest('[data-unfold-ref]');if(n){e.preventDefault();parent.postMessage({type:'unfold:context',referenceId:n.dataset.unfoldRef},'*')}else if(e.target.closest('a'))e.preventDefault()});document.addEventListener('mouseup',()=>{const text=getSelection()?.toString().trim();if(text)parent.postMessage({type:'unfold:quote',text:text.slice(0,4000)},'*')});const report=()=>parent.postMessage({type:'unfold:height',height:document.documentElement.scrollHeight},'*');new ResizeObserver(report).observe(document.body);report();</script></body></html>`;
}
export function exportHtml(title: string, html: string) {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${parentCsp}"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><body style="margin:0;background:#18181b"><iframe title="${escapeHtml(title)}" sandbox="allow-scripts" referrerpolicy="no-referrer" style="border:0;width:100%;height:100vh" srcdoc="${escapeHtml(frameHtml(html))}"></iframe></body>`;
}
