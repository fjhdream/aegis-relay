const MAX_COUNTER=Number.MAX_SAFE_INTEGER;

const counter=value=>{
  const number=Number(value);
  return Number.isFinite(number)&&number>=0?Math.min(MAX_COUNTER,Math.floor(number)):0;
};

const cleanText=(value,max=80)=>String(value||'').replace(/[\r\n\0]/g,'').slice(0,max);
// Cap on how many detailed viewer rows an agent ships per node each check-in. The distinct counts are
// computed from the agent's full rolling set, so the badge stays accurate even past this cap.
const VIEWER_REPORT_CAP=50;
function cleanViewers(list){
  const out=[];
  for(const v of Array.isArray(list)?list.slice(0,VIEWER_REPORT_CAP):[]){
    const ip=cleanText(v?.ip,45);if(!ip)continue;
    out.push({ip,deviceName:cleanText(v.deviceName,80),client:cleanText(v.client,80),deviceId:cleanText(v.deviceId,80),ua:cleanText(v.ua,160),channelId:cleanText(v.channelId,40)||'default',firstSeen:counter(v.firstSeen),lastSeen:counter(v.lastSeen),hits:counter(v.hits)});
  }
  return out;
}

export function sanitizeTelemetry(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const nodes=[];
  for(const item of Array.isArray(value.nodes)?value.nodes.slice(0,100):[]){
    const id=cleanText(item?.id,80);if(!id)continue;
    nodes.push({
      id,alias:cleanText(item.alias,32),name:cleanText(item.name,80),
      requests:counter(item.requests),playbackRequests:counter(item.playbackRequests),errors:counter(item.errors),
      bytesIn:counter(item.bytesIn),bytesOut:counter(item.bytesOut),monthBytes:counter(item.monthBytes),
      active:counter(item.active),month:/^\d{4}-\d{2}$/.test(String(item.month||''))?String(item.month):'',
      distinctIps:counter(item.distinctIps),distinctDevices:counter(item.distinctDevices),viewers:cleanViewers(item.viewers)
    });
  }
  const daily={};
  for(const [day,bytes] of Object.entries(value.daily&&typeof value.daily==='object'&&!Array.isArray(value.daily)?value.daily:{}).sort().slice(-31)){
    if(/^\d{4}-\d{2}-\d{2}$/.test(day))daily[day]=counter(bytes);
  }
  return {
    version:1,startedAt:cleanText(value.startedAt,40)||null,reportedAt:new Date().toISOString(),nodes,daily,
    totalRequests:nodes.reduce((sum,node)=>sum+node.requests,0),
    playbackRequests:nodes.reduce((sum,node)=>sum+node.playbackRequests,0),
    errors:nodes.reduce((sum,node)=>sum+node.errors,0),
    bytesIn:nodes.reduce((sum,node)=>sum+node.bytesIn,0),
    totalBytes:nodes.reduce((sum,node)=>sum+node.bytesOut,0),
    monthBytes:nodes.reduce((sum,node)=>sum+node.monthBytes,0),
    active:nodes.reduce((sum,node)=>sum+node.active,0)
  };
}

export function telemetryFromMetrics(snapshot) {
  return sanitizeTelemetry({version:1,startedAt:snapshot?.startedAt,nodes:snapshot?.nodes,daily:snapshot?.daily})||sanitizeTelemetry({nodes:[],daily:{}});
}

export function aggregateTelemetry(items) {
  const valid=(Array.isArray(items)?items:[]).filter(Boolean),daily={};
  for(const item of valid)for(const [day,bytes] of Object.entries(item.daily||{}))daily[day]=counter((daily[day]||0)+counter(bytes));
  for(const old of Object.keys(daily).sort().slice(0,-31))delete daily[old];
  return {
    totalRequests:valid.reduce((sum,item)=>sum+counter(item.totalRequests),0),
    playbackRequests:valid.reduce((sum,item)=>sum+counter(item.playbackRequests),0),
    errors:valid.reduce((sum,item)=>sum+counter(item.errors),0),
    bytesIn:valid.reduce((sum,item)=>sum+counter(item.bytesIn),0),
    totalBytes:valid.reduce((sum,item)=>sum+counter(item.totalBytes),0),
    monthBytes:valid.reduce((sum,item)=>sum+counter(item.monthBytes),0),
    active:valid.reduce((sum,item)=>sum+counter(item.active),0),daily
  };
}

// Every machine's viewer rows grouped by node id, built once per snapshot: looking a node up used to
// rescan every node of every machine, once for each node.
export function indexViewersByNode(machines) {
  const index=new Map();
  for(const machine of machines)for(const node of (machine.telemetry?.nodes||[])){
    let rows=index.get(node.id);if(!rows)index.set(node.id,rows=[]);
    rows.push({machine:machine.name,viewers:node.viewers||[]});
  }
  return index;
}

// Distinct viewers of one node per distribution channel, merged across every machine serving it. The
// counts come straight off the rows — a viewer is IP + (deviceId → deviceName → UA), the very identity
// the merge key is made of — so the merged roster, which only /access shows, is built only on request.
export function nodeChannels(index, route, labels, includeViewers) {
  const threshold=Number(route?.accessAlertThreshold||0), byChannel=new Map();
  for(const {machine,viewers} of index.get(route.id)||[])for(const v of viewers){
    const cid=v.channelId||'default', device=v.deviceId||v.deviceName||v.ua;
    let cv=byChannel.get(cid);if(!cv)byChannel.set(cid,cv={ips:new Set(),devices:new Set(),roster:includeViewers?new Map():null});
    cv.ips.add(v.ip);if(device)cv.devices.add(device);
    if(!cv.roster)continue;
    const k=`${v.ip} ${device||''}`, cur=cv.roster.get(k);
    if(!cur)cv.roster.set(k,{ip:v.ip,deviceName:v.deviceName||'',client:v.client||'',deviceId:v.deviceId||'',ua:v.ua||'',firstSeen:Number(v.firstSeen||0),lastSeen:Number(v.lastSeen||0),hits:Number(v.hits||0),machine});
    else{cur.hits+=Number(v.hits||0);cur.firstSeen=Math.min(cur.firstSeen||Number(v.firstSeen||0),Number(v.firstSeen||0)||cur.firstSeen);if(Number(v.lastSeen||0)>cur.lastSeen)Object.assign(cur,{lastSeen:Number(v.lastSeen||0),deviceName:v.deviceName||cur.deviceName,client:v.client||cur.client,deviceId:v.deviceId||cur.deviceId,ua:v.ua||cur.ua,machine});}
  }
  const ids=new Set([...labels.keys(),...byChannel.keys()]);
  const channels=[...ids].map(cid=>{
    const cv=byChannel.get(cid), distinctIps=cv?cv.ips.size:0, distinctDevices=cv?cv.devices.size:0;
    const ch={id:cid,label:labels.get(cid)||(cid==='default'?'默认':'(已删除通道)'),isDefault:cid==='default',distinctIps,distinctDevices,suspicious:threshold>0&&distinctDevices>threshold};
    if(includeViewers)ch.viewers=[...(cv?.roster||new Map()).values()].sort((a,b)=>b.lastSeen-a.lastSeen).slice(0,200);
    return ch;
  }).sort((a,b)=>(Number(b.suspicious)-Number(a.suspicious))||(b.distinctDevices-a.distinctDevices)||(a.isDefault?-1:1));
  return {threshold,distinctIps:channels.reduce((s,c)=>s+c.distinctIps,0),distinctDevices:channels.reduce((s,c)=>s+c.distinctDevices,0),suspicious:channels.some(c=>c.suspicious),channels};
}
