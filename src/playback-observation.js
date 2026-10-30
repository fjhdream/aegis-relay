import zlib from 'node:zlib';
export const PLAYBACK_OBSERVATION_CAPABILITY='playback-observation-v1';

const JSON_LIMIT=256*1024,MAX_READERS=32;
let readers=0;
// Subscribe only after forwarding is wired; observation must never consume or delay the proxy body.
export function observeJson(stream, headers, consume) {
  if(readers>=MAX_READERS||!/(?:\/|\+)json(?:\s*;|$)/i.test(String(headers['content-type']||''))||Number(headers['content-length'])>JSON_LIMIT)return;
  const encoding=String(headers['content-encoding']||'identity').toLowerCase();
  const decode={gzip:zlib.gunzip,deflate:zlib.inflate,br:zlib.brotliDecompress}[encoding];
  if(encoding!=='identity'&&!decode)return;
  readers++;
  let chunks=[],size=0,released=false;
  const release=()=>{if(released)return;released=true;readers--;chunks=[];clearTimeout(timer);stream.off('data',data);stream.off('end',end);stream.off('close',release);};
  const parsed=(error,buffer)=>{if(released)return;try{if(!error&&buffer.length<=JSON_LIMIT){const value=JSON.parse(buffer);if(value&&typeof value==='object'&&!Array.isArray(value))consume(value)}}catch{}finally{release()}};
  const data=chunk=>{size+=chunk.length;if(size>JSON_LIMIT)release();else chunks.push(chunk)};
  const end=()=>{const body=Buffer.concat(chunks);chunks=[];stream.off('close',release);if(decode)decode(body,{maxOutputLength:JSON_LIMIT},parsed);else parsed(null,body)};
  const timer=setTimeout(release,15000);timer.unref?.();
  stream.on('data',data);stream.once('end',end);stream.once('close',release);
}

const KEY=/^[A-Za-z0-9_-]{22}$/,TTL=30*60_000,SAMPLE_TTL=10*60_000;
const finite=(n,min,max)=>typeof n==='number'&&Number.isFinite(n)&&n>=min&&n<=max;
const text=value=>typeof value==='string'?value.replace(/[\r\n\0]/g,'').slice(0,80):'';

// Observation only: no result from this monitor enters steering scores, history or decisions.
export class PlaybackObservation {
  constructor(){this.sessions=new Map()}
  ingest(machine,event,now){
    if(!KEY.test(event?.k)||!finite(event.at,now-TTL,now+1000)||!['progress','metadata','transfer'].includes(event.kind))return;
    if(event.source&&!KEY.test(event.source))return;
    const source=event.source||'';
    if(event.kind==='progress'&&(!['start','progress','stop'].includes(event.phase)||event.phase!=='stop'&&!finite(event.position,0,86400*365)||event.paused!==null&&typeof event.paused!=='boolean'||!finite(event.rate,0.1,4)))return;
    if(event.kind==='metadata'&&(!finite(event.bitrate,1000,1e9)||typeof event.unique!=='boolean'))return;
    if(event.kind==='transfer'&&(!Number.isSafeInteger(event.start)||event.start<0||!Number.isSafeInteger(event.end)||event.end<event.start||!Number.isSafeInteger(event.bytes)||event.bytes!==event.end-event.start+1||event.bytes<1024*1024||!finite(event.requestAt,event.at-3600_000,event.at-250)))return;
    for(const [key,s] of this.sessions)if(now-s.seen>TTL)this.sessions.delete(key);
    let s=this.sessions.get(event.k);
    if(s&&s.routeId!==event.r)return;
    if(!s){s={key:event.k,routeId:event.r,client:'',seen:now,lastActivity:0,progress:null,points:[],metadata:new Map(),machines:new Map(),resetAt:0};this.sessions.set(event.k,s)}
    s.seen=now;if(text(event.client))s.client=text(event.client);
    if(this.sessions.size>1000)this.sessions.delete(this.sessions.keys().next().value);
    if(event.kind==='metadata'){
      if(event.at>=(s.metadata.get(source)?.at||0))s.metadata.set(source,{bitrate:event.bitrate,unique:event.unique,at:event.at});
      if(s.metadata.size>16)s.metadata.delete(s.metadata.keys().next().value);
      return;
    }
    s.lastActivity=Math.max(s.lastActivity,event.at);
    if(event.kind==='progress'){
      const prev=s.progress;if(prev&&event.at<=prev.at)return;
      const elapsed=prev?(event.at-prev.at)/1000:0,delta=prev?event.position-prev.position:0;
      const seek=!!prev&&finite(event.position,0,86400*365)&&finite(prev.position,0,86400*365)&&(delta< -2||delta>elapsed*Math.max(prev.rate,event.rate)+10);
      const changed=!!prev&&(prev.source!==source||prev.rate!==event.rate||prev.paused!==event.paused||prev.phase==='stop');
      if(event.phase!=='progress'||seek||changed){s.points=[];s.machines.clear();s.resetAt=event.at}
      s.progress={at:event.at,position:event.position,paused:event.paused,rate:event.rate,phase:event.phase,source,seek};
      s.points.push(s.progress);s.points=s.points.filter(p=>event.at-p.at<=60000).slice(-12);
      return;
    }
    if(event.requestAt<s.resetAt||s.progress?.phase==='stop'||s.progress?.paused===true)return;
    let m=s.machines.get(machine);
    if(!m){m={samples:[],last:null};s.machines.set(machine,m)}
    const last=m.last;
    if(last&&(event.at<=last.at||event.requestAt<last.at))return; // duplicates, parallel prefetch and out-of-order completions
    if(last&&(event.start!==last.end+1||source!==last.source))m.samples=[];
    m.last={start:event.start,end:event.end,requestAt:event.requestAt,at:event.at,source};
    m.samples.push({...m.last,rateBps:event.bytes*1000/(event.at-event.requestAt)});
    m.samples=m.samples.filter(v=>event.at-v.at<=SAMPLE_TTL).slice(-5);
    if(s.machines.size>32)s.machines.delete(s.machines.keys().next().value);
  }
  view(now){
    return [...this.sessions.values()].filter(s=>s.lastActivity&&now-s.lastActivity<=SAMPLE_TTL).sort((a,b)=>b.lastActivity-a.lastActivity).slice(0,100).map(s=>{
      const p=s.progress,fresh=p&&now-p.at<=45000,first=s.points[0],elapsed=fresh&&first?(p.at-first.at)/1000:0;
      const advancing=elapsed>=10&&p.position-first.position>=elapsed*p.rate*0.8;
      const stalled=elapsed>=20&&p.paused===false&&p.position-first.position<elapsed*p.rate*0.2;
      const state=p?.phase==='stop'?'stopped':!fresh?'unknown':p.paused===true?'paused':p.seek?'seeking':advancing?'playing':stalled?'possible_stall':'collecting';
      const machines=[...s.machines].map(([id,m])=>{
        const recent=m.samples.filter(v=>now-v.at<=SAMPLE_TTL&&(!p?.source||!v.source||v.source===p.source));
        const source=p?.source||m.last?.source||'',metadata=source?s.metadata.get(source):(s.metadata.size===1&&[...s.metadata.values()][0].unique?[...s.metadata.values()][0]:null);
        const samples=recent.slice(-3),rateBps=samples.length?Math.round(samples.reduce((n,v)=>n+v.end-v.start+1,0)*1000/samples.reduce((n,v)=>n+v.at-v.requestAt,0)):0;
        const bitrate=metadata?.bitrate||0,margin=bitrate&&rateBps?Math.round(rateBps*8/bitrate*100)/100:null;
        const complete=samples.length>=3,freshTransfer=!!samples.length&&now-samples.at(-1).at<=180000;
        const low=complete&&bitrate>0&&samples.every(v=>v.rateBps*8<bitrate*0.9);
        const advice=!freshTransfer?'stale':!bitrate?'missing_bitrate':!complete?'collecting':state==='paused'||state==='stopped'?'inactive':low&&state==='possible_stall'?'would_switch':low?'low_margin':margin>=1.3?'enough':'observe';
        return {id,samples:recent.length,rateBps,bitrate,margin,advice,at:m.last?.at||0};
      }).sort((a,b)=>b.at-a.at);
      return {session:s.key.slice(0,6),routeId:s.routeId,client:s.client,state,lastProgressAt:p?.at||0,lastActivity:s.lastActivity,positionSeconds:finite(p?.position,0,86400*365)?p.position:null,machines};
    });
  }
}
