// One dashboard feed shared by every open panel tab. metrics.emit() fires once per proxied request, and
// each tab used to rebuild and serialise the whole dashboard on its own timers — the same aggregation
// run once per tab, on the event loop that streams media. Now an update is built once and written to
// every tab: bursts coalesce into at most one build per `minIntervalMs`, a heartbeat refreshes idle
// dashboards, and with no tab open nothing is subscribed or scheduled at all.
const frameOf=snapshot=>`event: dashboard\ndata: ${JSON.stringify(snapshot)}\n\n`;

export function createDashboardFeed({build,subscribe,minIntervalMs=2000,heartbeatMs=15000}) {
  const clients=new Set();let lastBuilt=0,coalesce=null,heartbeat=null,unsubscribe=null;
  const broadcast=()=>{clearTimeout(coalesce);coalesce=null;lastBuilt=Date.now();const frame=frameOf(build());for(const res of clients)res.write(frame);};
  const schedule=()=>{if(coalesce)return;coalesce=setTimeout(broadcast,Math.max(0,minIntervalMs-(Date.now()-lastBuilt)));coalesce.unref?.();};
  return {
    // Returns the unfollow function. A tab that opens gets its own fresh snapshot straight away.
    follow(res){
      res.write(frameOf(build()));
      clients.add(res);
      if(clients.size===1){unsubscribe=subscribe(schedule);heartbeat=setInterval(broadcast,heartbeatMs);heartbeat.unref?.();}
      return ()=>{
        if(!clients.delete(res)||clients.size)return;
        unsubscribe();unsubscribe=null;clearInterval(heartbeat);heartbeat=null;clearTimeout(coalesce);coalesce=null;
      };
    }
  };
}
