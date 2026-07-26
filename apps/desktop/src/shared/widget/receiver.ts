/**
 * The widget iframe "receiver" document.
 *
 * Unlike CodePilot (which inlines this as the iframe `srcdoc`), Aila serves it
 * from the `aila-widget://` Electron protocol. A custom-scheme document carries
 * its own CSP (delivered as a response header by the protocol handler, mirrored
 * here as a `<meta>`), so it does NOT inherit the strict renderer CSP and can
 * run inline + whitelisted-CDN scripts — while the main app CSP stays strict.
 *
 * The document is static and lives for the widget's whole lifetime. Content is
 * pushed in via postMessage:
 *  - `widget:update`   streaming preview → set as innerHTML (no scripts)
 *  - `widget:finalize` final HTML → scripts are extracted and re-executed
 *  - `widget:theme`    live CSS variable values from the renderer
 *
 * Receiver script ported verbatim from CodePilot `buildReceiverSrcdoc`.
 */

import { CDN_WHITELIST } from './sanitizer'
import { getWidgetStaticCss } from './styles'

/** Custom Electron scheme that serves the receiver document. */
export const WIDGET_PROTOCOL = 'aila-widget'

/** The URL the renderer points its widget iframe at. */
export const WIDGET_FRAME_URL = `${WIDGET_PROTOCOL}://frame/`

/** CSP for the receiver document — set as a response header AND a `<meta>`. */
export const WIDGET_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' ${CDN_WHITELIST.map((domain) => `https://${domain}`).join(' ')}`,
  "style-src 'unsafe-inline'",
  'img-src * data: blob:',
  'font-src * data:',
  "connect-src 'none'",
].join('; ')

const RECEIVER_SCRIPT = `(function(){
var root=document.getElementById('__root');
var _t=null,_first=true;
function _h(){
if(_t)clearTimeout(_t);
_t=setTimeout(function(){
var r=root.getBoundingClientRect();
var h=Math.ceil(r.height);
if(h>0&&h!==_lastH){_lastH=h;parent.postMessage({type:'widget:resize',height:h,first:_first},'*');}
_first=false;
},60);
}
var _lastH=0;
var _ro=new ResizeObserver(_h);
_ro.observe(root);

function applyHtml(html){
root.innerHTML=html;
_h();
}

function finalizeHtml(html){
var tmp=document.createElement('div');
tmp.innerHTML=html;
var ss=tmp.querySelectorAll('script');
var scripts=[];
for(var i=0;i<ss.length;i++){
scripts.push({src:ss[i].src||'',text:ss[i].textContent||'',attrs:[]});
for(var j=0;j<ss[i].attributes.length;j++){
var a=ss[i].attributes[j];
if(a.name!=='src')scripts[scripts.length-1].attrs.push({name:a.name,value:a.value});
}
ss[i].remove();
}
var visualHtml=tmp.innerHTML;
if(root.innerHTML!==visualHtml)root.innerHTML=visualHtml;
var cdnScripts=scripts.filter(function(s){return !!s.src});
var inlineScripts=scripts.filter(function(s){return !s.src&&s.text});
function _appendInline(){
for(var k=0;k<inlineScripts.length;k++){
var s=document.createElement('script');
s.textContent=inlineScripts[k].text;
for(var j=0;j<inlineScripts[k].attrs.length;j++)s.setAttribute(inlineScripts[k].attrs[j].name,inlineScripts[k].attrs[j].value);
root.appendChild(s);
}
_h();
setTimeout(function(){parent.postMessage({type:'widget:scriptsReady'},'*')},50);
}
if(cdnScripts.length===0){
_appendInline();
}else{
var _pending=cdnScripts.length;
function _onCdnDone(){_pending--;if(_pending<=0)_appendInline()}
for(var i=0;i<cdnScripts.length;i++){
var n=document.createElement('script');
n.src=cdnScripts[i].src;
n.onload=_onCdnDone;
n.onerror=_onCdnDone;
for(var j=0;j<cdnScripts[i].attrs.length;j++){
if(cdnScripts[i].attrs[j].name!=='onload')n.setAttribute(cdnScripts[i].attrs[j].name,cdnScripts[i].attrs[j].value);
}
root.appendChild(n);
}
}
_h();
}

window.addEventListener('message',function(e){
if(!e.data)return;
switch(e.data.type){
case 'widget:update':
applyHtml(e.data.html);
break;
case 'widget:finalize':
finalizeHtml(e.data.html);
setTimeout(_h,150);
break;
case 'widget:theme':
var r=document.documentElement,v=e.data.vars;
if(v)for(var k in v)r.style.setProperty(k,v[k]);
setTimeout(_h,100);
break;
}
});

document.addEventListener('click',function(e){
var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;
if(!a)return;var h=a.getAttribute('href');
if(!h||h.charAt(0)==='#')return;
e.preventDefault();
parent.postMessage({type:'widget:link',href:h},'*');
});

window.__widgetSendMessage=function(t){
if(typeof t!=='string'||t.length>500)return;
parent.postMessage({type:'widget:sendMessage',text:t},'*');
};

parent.postMessage({type:'widget:ready'},'*');
})();`

/** Build the full static receiver HTML document served by `aila-widget://`. */
export function buildReceiverHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP}">
<style>
${getWidgetStaticCss()}
</style>
</head>
<body style="margin:0;padding:0;height:fit-content;">
<div id="__root" style="height:fit-content;"></div>
<script>${RECEIVER_SCRIPT}</script>
</body>
</html>`
}
