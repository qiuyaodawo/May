/** Serve only on a dedicated origin with no cookies, credentials or other application routes. */
export function mcpAppSandboxResponse(hostOrigin: string): { readonly body: string; readonly headers: Readonly<Record<string, string>> } {
  const url = new URL(hostOrigin);
  if (url.origin !== hostOrigin || !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Invalid MCP App host origin");
  const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'; frame-src about:; object-src 'none'; base-uri 'none'; form-action 'none'";
  const script = `const hostOrigin=${JSON.stringify(hostOrigin)};
let view; let loaded=false; let navigations=0;
const fail=()=>{ if(view) view.remove(); view=undefined; };
addEventListener('message', event=>{
  const m=event.data;
  if(!m || m.jsonrpc!=='2.0') return;
  let size; try { size=new TextEncoder().encode(JSON.stringify(m)).length; } catch { fail(); return; }
  if(size>8*1024*1024) { fail(); return; }
  if(event.source===parent && event.origin===hostOrigin){
    if(m.method==='ui/notifications/sandbox-resource-ready'){
      if(loaded || typeof m.params?.html!=='string' || new TextEncoder().encode(m.params.html).length>2*1024*1024) { fail(); return; }
      loaded=true;
      view=document.createElement('iframe');
      view.setAttribute('sandbox','allow-scripts');
      view.setAttribute('allow',"camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'");
      view.referrerPolicy='no-referrer';
      view.style.cssText='width:100%;height:100vh;border:0';
      view.addEventListener('load',()=>{ if(++navigations>1) fail(); });
      view.srcdoc=${JSON.stringify('<meta http-equiv="Content-Security-Policy" content="' + csp.replace('frame-src about:', "frame-src 'none'") + '">')}+m.params.html;
      document.body.append(view);
    } else if(!String(m.method||'').startsWith('ui/notifications/sandbox-')) view?.contentWindow.postMessage(m,'*');
  } else if(view && event.source===view.contentWindow && event.origin==='null' &&
    typeof m.method==='string' && !m.method.startsWith('ui/notifications/sandbox-') && size<=256*1024){
      parent.postMessage(m,hostOrigin);
  }
});
parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/sandbox-proxy-ready'},hostOrigin);`;
  return { body: `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><script>${script}</script></body></html>`,
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": `${csp}; frame-ancestors 'self' ${hostOrigin}`,
      "permissions-policy": "camera=(), microphone=(), geolocation=(), clipboard-write=(), payment=(), usb=()",
      "referrer-policy": "no-referrer", "cache-control": "no-store", "x-content-type-options": "nosniff" } };
}
