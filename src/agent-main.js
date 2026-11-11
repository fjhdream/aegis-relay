import fs from 'node:fs';
import { enrollAgent, startAgent } from './agent-runtime.js';

// The agent image's entry point: read the environment, then enroll (`--enroll`, run once by the
// installer) or run the agent. Everything the agent does is in agent-runtime.js.

// Read the version from the package.json baked into this image, so the version the agent reports
// always matches the code it is actually running — an upgrade rebuilds the image, so a bumped version
// on the panel is proof the new build is live. Fall back to the env/hardcoded value if unreadable.
function codeVersion(){try{return JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;}catch{return process.env.AGENT_VERSION||'0.0.0';}}

const env=process.env,machine={dataDir:env.AGENT_DATA_DIR||'/app/agent-data',panelUrl:env.PANEL_URL,version:codeVersion()};
if(process.argv.includes('--enroll'))await enrollAgent({...machine,token:env.ENROLLMENT_TOKEN,name:env.AGENT_NAME});
else{
  const agent=await startAgent({...machine,domain:env.AGENT_DOMAIN,proxyMode:env.AGENT_PROXY_MODE,proxyIp:env.AGENT_PROXY_IP,proxyPort:Number(env.AGENT_PROXY_PORT||8080)});
  // Playbacks in flight keep the relay open; Docker's stop grace period is not waited out for them.
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{agent.stop().then(()=>process.exit(0));setTimeout(()=>process.exit(0),5_000).unref()});
}
