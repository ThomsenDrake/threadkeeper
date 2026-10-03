import test from 'node:test';
import assert from 'node:assert/strict';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createTestDatabase} from './helpers.ts';
import {createApp} from '../apps/api/src/app.ts';
import {bootstrap} from '../apps/api/src/auth.ts';

test('two independent MCP clients observe profile correction and deletion through fresh authenticated retrieval',async()=>{
 const database=await createTestDatabase();await bootstrap(database.db,'demo@example.invalid','synthetic-password-123');
 const {app}=createApp(database.db,{origin:'http://127.0.0.1:3199'});const server=app.listen(3199,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const base='http://127.0.0.1:3199';let cookie='';const clients:Client[]=[];
 const request=async(path:string,body?:any,method=body?'POST':'GET',headers:Record<string,string>={})=>{const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(cookie?{cookie}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();return {r,data};};
 try{
  assert.equal((await request('/api/memories')).r.status,401);
  const login=await request('/api/auth/login',{email:'demo@example.invalid',password:'synthetic-password-123'});assert.equal(login.r.status,200);cookie=login.r.headers.get('set-cookie')!.split(';')[0];
  const tokenA=(await request('/api/clients',{name:'Client A',permissions:['read','capture'],projects:null})).data.token;
  const tokenB=(await request('/api/clients',{name:'Client B',permissions:['read'],projects:null})).data.token;
  const connect=async(name:string,token:string)=>{const c=new Client({name,version:'0.1.0'},{versionNegotiation:{mode:'auto'}});await c.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));clients.push(c);return c;};
  const a=await connect('client-a',tokenA),b=await connect('client-b',tokenB);
  const lowercase=await request('/api/context/search',undefined,'GET',{Authorization:`bearer ${tokenB}`});assert.equal(lowercase.r.status,200);
  const malformed=await request('/api/context/search',undefined,'GET',{Authorization:'Bearer invalid token'});assert.equal(malformed.r.status,401);
  const cookieMcp=await request('/mcp',{},'POST');assert.equal(cookieMcp.r.status,403);
  const tools=await b.listTools();assert.deepEqual(tools.tools.map(t=>t.name).sort(),['context_capture_status','context_get_source','context_search']);
  const deadline='The Atlas deadline is 20 October 2026.',preference='I prefer short sentences when writing.';
  const captured=await a.callTool({name:'context_capture',arguments:{idempotency_key:'synthetic-demo',project_id:'atlas',subject:'self',events:[{id:'deadline-v1',text:deadline,author_role:'user',origin:'user_explicit'},{id:'writing-v1',text:preference,author_role:'user',origin:'user_explicit'}],explicit_memories:[{statement:deadline,kind:'project_state',source_event_id:'deadline-v1',quote:deadline,origin:'user_explicit'},{statement:preference,kind:'preference',source_event_id:'writing-v1',quote:preference,origin:'user_explicit'}]}});assert.equal(captured.isError,undefined);
  const recall=async(c:Client)=>(await c.callTool({name:'context_search',arguments:{query:'',project_id:'atlas'}})).structuredContent as any;
  const first=await recall(b);assert.equal(first.memories.length,2);assert(first.memories.every((m:any)=>m.evidence.length>0));
  const dl=first.memories.find((m:any)=>m.kind==='project_state'),pref=first.memories.find((m:any)=>m.kind==='preference');
  const edited=await request(`/api/memories/${dl.id}`,{statement:'The Atlas deadline is 23 October 2026.',expected_revision:dl.revision},'PATCH');assert.equal(edited.r.status,200);
  const stale=await request(`/api/memories/${dl.id}`,{statement:'Stale overwrite',expected_revision:dl.revision},'PATCH');assert.equal(stale.r.status,409);
  const removed=await request(`/api/memories/${pref.id}`,{expected_revision:pref.revision},'DELETE');assert.equal(removed.r.status,200);
  for(const c of [a,b]){const result=await recall(c);assert.equal(result.memories.length,1);assert.equal(result.memories[0].statement,'The Atlas deadline is 23 October 2026.');assert.equal(result.memories[0].origin,'user_explicit');}
  assert.equal((await request(`/api/sources/${pref.evidence[0].source_id}`)).r.status,404);
  const exported=(await request('/api/export')).data;assert(!JSON.stringify(exported).includes(preference));
  const schema=await request('/openapi.json');assert.equal(schema.r.status,200);assert.equal(schema.data.openapi,'3.1.0');
  const grant=(await request('/api/clients')).data.clients.find((c:any)=>c.name==='Client B');await request(`/api/clients/${grant.id}`,undefined,'DELETE');
  const revoked=await request('/api/context/search',undefined,'GET',{Authorization:`Bearer ${tokenB}`});assert.equal(revoked.r.status,401);
  const crossSite=await request('/api/export',undefined,'GET',{origin:'https://attacker.invalid'});assert.equal(crossSite.r.status,403);
 }finally{for(const c of clients)await c.close();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));await database.close();}
});
