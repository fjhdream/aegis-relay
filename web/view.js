// What the panel shows, worked out from data: the text, the markup, what a form sends. Nothing in here
// touches the page, the network or the clock (the time comes in as an argument), so every function can
// be called with plain data, from the page or from a test. web/app.js is the other half: it fetches,
// calls these, writes what they return into the page and listens for what the person does next.

export const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function bytes(n=0){const units=['B','KB','MB','GB','TB'];let i=0;n=Number(n)||0;while(n>=1024&&i<units.length-1){n/=1024;i++}return`${n>=10||i===0?n.toFixed(0):n.toFixed(1)} ${units[i]}`}
// The `count` days (UTC) that end with the day of `now`, oldest first, each with its traffic.
export function recentDays(daily,now,count=14){const rows=[];for(let ago=count-1;ago>=0;ago--){const day=new Date(now);day.setUTCHours(0,0,0,0);day.setUTCDate(day.getUTCDate()-ago);const key=day.toISOString().slice(0,10);rows.push({key,label:`${day.getUTCMonth()+1}/${day.getUTCDate()}`,bytes:Number(daily?.[key]||0)})}return rows}

export const TITLES={dashboard:'仪表盘',nodes:'节点管理',agents:'代理机器',steering:'自动切流',traffic:'流量统计',access:'访问监控',diagnostics:'故障诊断',audit:'安全审计',notifications:'通知提醒',account:'个人设置',deployment:'部署向导'};
// One-click client-identity templates for authorized upstreams. Device ID stays untouched so it remains unique per install.
export const UA_PRESETS=[
  {name:'透传（默认）',clear:true},
  {name:'Infuse',userAgent:'Infuse-Direct/8.1.1',client:'Infuse',deviceName:'Infuse'},
  {name:'Emby Web',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',client:'Emby Web',deviceName:'Chrome'},
  {name:'Emby for Android',userAgent:'Emby/3.4.10 (Android 14; Pixel 8)',client:'Emby for Android',deviceName:'Pixel 8'},
  {name:'Fileball',userAgent:'Fileball/1.5.0',client:'Fileball',deviceName:'Fileball'},
  {name:'SenPlayer',userAgent:'SenPlayer/1.2.0',client:'SenPlayer',deviceName:'SenPlayer'},
  {name:'VidHub',userAgent:'VidHub/1.9 (iOS 17)',client:'VidHub',deviceName:'VidHub'},
];

// The AegisRelay mark: a solid shield with an A cut out of it, drawn on a 24-unit grid in currentColor.
const BRAND_MARK_PATH='M12 2.4 19.6 5.3v6.2c0 4.9-3.2 8.5-7.6 10.3-4.4-1.8-7.6-5.4-7.6-10.3V5.3zM12 8.1 15.9 15.8h-2.3L12 12.5l-1.6 3.3H8.1z';
export const BRAND_MARK=`<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="${BRAND_MARK_PATH}"/></svg>`;
export const DEFAULT_FAVICON='data:image/svg+xml;base64,'+btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#09090b"/><path transform="translate(12.16 12.16) scale(1.653)" fill="#ffffff" fill-rule="evenodd" d="${BRAND_MARK_PATH}"/></svg>`);

// What an operator copies for a client: the node's whole address, and its key when it has one.
// `data` is what the panel answers for a node's credentials; `origin` stands in when it names no public address.
export function credentialText(data,origin){const full=`${String(data.publicBaseUrl||origin).replace(/\/$/,'')}${data.clientPath}`;return data.accessKey?`客户端服务器地址（复制这一整行）\n${full}\n\n地址保护码（已经包含在上面的地址中，无需单独填写）\n${data.accessKey}\n\n在 Emby 客户端添加服务器时，只需粘贴完整服务器地址。`:`客户端服务器地址（复制这一整行）\n${full}\n\n此节点没有启用连接密码，知道地址的人都可以访问。`}
export const ADDR_MASK='••••••••••••••••••';
export const EYE_SVG='<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
// Whether a node answers to a search (already trimmed and lowercased): by name, path or tag.
export function routeMatches(r,q){if(!q)return true;const hay=`${r.name} ${r.alias} ${(r.tags||[]).join(' ')}`.toLowerCase();return hay.includes(q)}

export function qrSvg(qr){
  const quiet=4,scale=5,dim=(qr.size+quiet*2)*scale;
  let path='';
  qr.rows.forEach((row,y)=>{[...row].forEach((bit,x)=>{if(bit==='1')path+=`M${(x+quiet)*scale} ${(y+quiet)*scale}h${scale}v${scale}h-${scale}z`})});
  return `<svg viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" role="img" aria-label="两步验证二维码"><rect width="${dim}" height="${dim}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
