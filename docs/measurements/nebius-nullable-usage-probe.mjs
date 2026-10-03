import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const model = 'nvidia/Nemotron-3_5-Lightning';
if (!process.env.NEBIUS_API_KEY) throw new Error('Credential missing');
const body = JSON.stringify({model,messages:[{role:'user',content:'Reply exactly READY.'}],temperature:0,max_tokens:32,reasoning_effort:'none'});
const started = Date.now();
const response = await fetch('https://api.tokenfactory.nebius.com/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${process.env.NEBIUS_API_KEY}`,'Content-Type':'application/json'},body,signal:AbortSignal.timeout(60000)});
const raw = await response.text();
const parsed = JSON.parse(raw);
function shape(value) { if(value===null) return null; if(typeof value==='number') return value; if(value && typeof value==='object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,shape(item)])); return {type:typeof value}; }
const result = {purpose:'Diagnose nullable usage detail schema after rejected native run',measured_at:new Date(started).toISOString(),http_status:response.status,requested_model:model,returned_model_matches:parsed.model===model,reasoning_effort:'none',elapsed_ms:Date.now()-started,request_sha256:createHash('sha256').update(body).digest('hex'),response_sha256:createHash('sha256').update(raw).digest('hex'),usage:shape(parsed.usage)};
await writeFile('/tmp/threadkeeper-direct/nullable-usage-probe.json',JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(result));
if(!response.ok) process.exitCode=1;
