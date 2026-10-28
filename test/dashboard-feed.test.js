import test from 'node:test';
import assert from 'node:assert/strict';
import { createDashboardFeed } from '../src/dashboard-feed.js';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function harness({minIntervalMs=60,heartbeatMs=10_000}={}){
  const state={builds:0,subscribed:0,unsubscribed:0,emit:null};
  const feed=createDashboardFeed({minIntervalMs,heartbeatMs,build:()=>({n:++state.builds}),subscribe:listener=>{state.subscribed++;state.emit=listener;return()=>{state.unsubscribed++;state.emit=null;};}});
  const tab=()=>{const frames=[];return {frames,write:frame=>frames.push(frame)};};
  return {feed,state,tab};
}
const builds=frames=>frames.map(frame=>JSON.parse(frame.split('data: ')[1]).n);

test('every open tab shares one build per update instead of rebuilding its own',async()=>{
  const {feed,state,tab}=harness(),a=tab(),b=tab(),c=tab();
  feed.follow(a);feed.follow(b);feed.follow(c);
  assert.deepEqual([builds(a.frames),builds(b.frames),builds(c.frames)],[[1],[2],[3]],'a tab that opens gets its own fresh snapshot');
  assert.equal(state.subscribed,1,'one metrics subscription however many tabs are open');
  for(let i=0;i<50;i++)state.emit(); // a burst of proxied requests
  await sleep(150);
  assert.equal(state.builds,4,'the whole burst is one build');
  for(const t of [a,b,c])assert.deepEqual(builds(t.frames).slice(1),[4],'and every tab receives that same frame');
});

test('updates are spaced at least minIntervalMs apart',async()=>{
  const {feed,state,tab}=harness({minIntervalMs:80}),a=tab();
  feed.follow(a);state.emit();
  while(a.frames.length<2)await sleep(1);
  const updatedAt=Date.now();state.emit(); // a change right after an update
  while(a.frames.length<3)await sleep(1);
  assert.ok(Date.now()-updatedAt>=70,`waited ${Date.now()-updatedAt}ms; the rest of the window must be waited out`);
  assert.equal(state.builds,3);
});

test('a heartbeat refreshes an idle dashboard',async()=>{
  const {feed,tab}=harness({heartbeatMs:40}),a=tab();
  const unfollow=feed.follow(a);await sleep(150);
  assert.ok(a.frames.length>=3,`expected heartbeat frames, got ${a.frames.length}`);
  unfollow();
});

test('nothing stays subscribed or scheduled once the last tab closes',async()=>{
  const {feed,state,tab}=harness({heartbeatMs:30}),a=tab(),b=tab();
  const leaveA=feed.follow(a),leaveB=feed.follow(b);
  leaveA();leaveA();
  assert.equal(state.unsubscribed,0,'one tab is still open');
  state.emit();leaveB();
  const built=state.builds;await sleep(120);
  assert.equal(state.unsubscribed,1);
  assert.equal(state.builds,built,'no pending update or heartbeat fires after the last tab left');
  feed.follow(tab());
  assert.equal(state.subscribed,2,'a tab opening later subscribes again');
});
