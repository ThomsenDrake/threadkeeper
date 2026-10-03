import express from 'express';
import {z,ZodError} from 'zod';
import {createMcpHandler,McpServer} from '@modelcontextprotocol/server';
import {toNodeHandler} from '@modelcontextprotocol/node';
import {CaptureSchema,SearchSchema,CorrectSchema,DeleteSchema,ExportSchema} from '../../../packages/contracts/src/index.ts';
import {createStore,DomainError,type Database} from '../../../packages/core/src/index.ts';
import {createAuth} from './auth.ts';
import {resolve} from 'node:path';

export function createApp(db:Database,options:{origin?:string;cookieSecure?:boolean;staticDir?:string}={}){
 const app=express(),store=createStore(db),auth=createAuth(db);const origin=options.origin??'http://localhost:3000';const allowedHost=new URL(origin).host;
 app.disable('x-powered-by');
 app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');if(req.headers.host!==allowedHost)return res.status(403).json({error:'invalid_host'});if(req.headers.origin&&req.headers.origin!==origin)return res.status(403).json({error:'invalid_origin'});next();});
 app.get('/health',async(_req,res)=>{await db.query('SELECT 1');res.json({status:'ok'});});
 app.get('/openapi.json',(_req,res)=>res.json(openapi(origin)));
 app.use(express.json({limit:'12mb'}));
 const attempts=new Map<string,{count:number,until:number}>();
 app.post('/api/auth/login',async(req,res)=>{const key=req.ip??'local',now=Date.now();let a=attempts.get(key);if(!a||a.until<now){a={count:0,until:now+60000};attempts.set(key,a);}if(++a.count>10)return res.status(429).json({error:'rate_limit'});const v=z.object({email:z.email(),password:z.string().min(1).max(1024)}).parse(req.body);const r=await auth.login(v.email,v.password);if(!r)return res.status(401).json({error:'invalid_credentials'});res.cookie('tk_session',r.token,{httpOnly:true,sameSite:'strict',secure:options.cookieSecure??false,maxAge:7*86400000,path:'/'});res.json({user:r.user});});
 app.use(['/api','/mcp'],async(req,res,next)=>{const p=await auth.principal(req.headers);if(!p)return res.status(401).json({error:'unauthorized'});res.locals.principal=p;next();});
 const owner:express.RequestHandler=(_req,res,next)=>{if(!res.locals.principal.user)return res.status(403).json({error:'profile_session_required'});next();};
 app.get('/api/auth/me',owner,(_req,res)=>res.json({user:res.locals.principal.user}));
 app.post('/api/auth/logout',owner,async(_req,res)=>{await db.query('DELETE FROM tk_sessions WHERE token_hash=$1',[res.locals.principal.sessionHash]);res.clearCookie('tk_session',{path:'/'});res.json({ok:true});});
 app.post('/api/capture',async(req,res)=>res.status(201).json(await store.capture(res.locals.principal.auth,CaptureSchema.parse(req.body))));
 app.get('/api/context/search',async(req,res)=>res.json(await store.search(res.locals.principal.auth,SearchSchema.parse(req.query))));
 app.get('/api/memories',owner,async(req,res)=>res.json(await store.list(res.locals.principal.auth,SearchSchema.parse(req.query))));
 app.get('/api/memories/:id',owner,async(req,res)=>res.json(await store.detail(res.locals.principal.auth,String(req.params.id))));
 app.patch('/api/memories/:id',owner,async(req,res)=>res.json(await store.correct(res.locals.principal.auth,String(req.params.id),CorrectSchema.parse(req.body))));
 app.delete('/api/memories/:id',owner,async(req,res)=>res.json(await store.remove(res.locals.principal.auth,String(req.params.id),DeleteSchema.parse(req.body))));
 app.get('/api/sources/:id',async(req,res)=>res.json(await store.getSource(res.locals.principal.auth,String(req.params.id))));
 app.get('/api/clients',owner,async(_req,res)=>{const r=await db.query('SELECT id,name,permissions,projects,created_at,revoked_at FROM tk_clients WHERE user_id=$1 ORDER BY created_at DESC',[res.locals.principal.user.id]);res.json({clients:r.rows});});
 app.post('/api/clients',owner,async(req,res)=>{const input=z.object({name:z.string().min(1).max(100),permissions:z.array(z.enum(['read','capture'])).min(1),projects:z.array(z.string().min(1).max(200)).max(100).nullable().default(null)}).strict().parse(req.body);res.status(201).json(await auth.createClient(res.locals.principal.user.id,input.name,input.permissions,input.projects));});
 app.delete('/api/clients/:id',owner,async(req,res)=>{const r=await db.query('UPDATE tk_clients SET revoked_at=now() WHERE id=$1 AND user_id=$2 RETURNING id',[req.params.id,res.locals.principal.user.id]);if(!r.rows.length)return res.status(404).json({error:'not_found'});res.json({ok:true});});
 app.get('/api/export',owner,async(_req,res)=>{res.setHeader('Content-Disposition','attachment; filename="threadkeeper-export.json"');res.json(await store.export(res.locals.principal.auth));});
 app.post('/api/import',owner,async(req,res)=>res.json(await store.import(res.locals.principal.auth,ExportSchema.parse(req.body))));
 app.all('/mcp',async(req,res)=>{
 if(!/^Bearer /i.test(req.headers.authorization??''))return res.status(403).json({error:'client_token_required'});
 const principal=res.locals.principal.auth;
 const handler=createMcpHandler(()=>{
  const server=new McpServer({name:'threadkeeper',version:'0.1.0'});
  const result=(data:any)=>({content:[{type:'text' as const,text:JSON.stringify(data)}],structuredContent:data});
  if(principal.permissions.includes('read')){
   server.registerTool('context_search',{description:'Recall authorized personal context. Use for earlier work or missing durable preferences/decisions that materially affect the current request. Fresh reads reflect profile corrections and deletions. Evidence attribution is returned; inference is not a user quote.',inputSchema:SearchSchema,outputSchema:z.object({memories:z.array(z.unknown()),snapshot_version:z.unknown()}).passthrough(),annotations:{readOnlyHint:true}},async(input)=>result(await store.search(principal,input)));
   server.registerTool('context_get_source',{description:'Read authorized source evidence by stable source ID.',inputSchema:z.object({source_id:z.string()})},async({source_id})=>result(await store.getSource(principal,source_id)));
  }
  if(principal.permissions.includes('capture'))server.registerTool('context_capture',{description:'Save explicit user-approved durable context or authorized excerpts. Preserve author roles; summaries are agent_reported. Installing MCP does not automatically capture conversations. Reuse stable event IDs/idempotency key for retries. Return pending extraction accurately.',inputSchema:CaptureSchema,outputSchema:z.object({capture_id:z.string(),status:z.enum(['complete','pending'])}).passthrough(),annotations:{readOnlyHint:false,destructiveHint:false}},async(input)=>result(await store.capture(principal,input)));
  return server;
 },{responseMode:'json'});
 await toNodeHandler(handler)(req,res,req.body);
 });
 app.use('/api',(_req,res)=>res.status(404).json({error:'not_found'}));
 app.use(express.static(options.staticDir??resolve('apps/web/dist'),{etag:false}));
 app.get('/{*path}',(_req,res)=>res.sendFile(resolve(options.staticDir??'apps/web/dist','index.html')));
 app.use((err:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{if(err instanceof ZodError)return res.status(400).json({error:'validation',issues:err.issues});if(err instanceof DomainError)return res.status(err.status).json({error:err.code,message:err.message});if(err.type==='entity.too.large')return res.status(413).json({error:'payload_too_large'});console.error('Request failed',{name:err.name,code:err.code});res.status(500).json({error:'internal_error'});});
 return {app,store,auth};
}
function openapi(origin:string){const requestBody=(schema:any)=>({required:true,content:{'application/json':{schema:z.toJSONSchema(schema,{io:'input'})}}});const response={200:{description:'Authorized structured result'},400:{description:'Invalid request'},401:{description:'Authentication required'},403:{description:'Scope or permission denied'}};return {openapi:'3.1.0',info:{title:'Threadkeeper personal-context API',version:'0.1.0'},servers:[{url:origin}],security:[{clientBearer:[]}],components:{securitySchemes:{clientBearer:{type:'http',scheme:'bearer'}}},paths:{'/api/capture':{post:{operationId:'context_capture',summary:'Capture source-backed personal context',requestBody:requestBody(CaptureSchema),responses:{...response,201:{description:'Durably stored, status complete or pending'}}}},'/api/context/search':{get:{operationId:'context_search',summary:'Recall authorized active personal context',parameters:[{name:'query',in:'query',schema:{type:'string'}},{name:'project_id',in:'query',schema:{type:'string'}},{name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:100}}],responses:response}},'/api/sources/{source_id}':{get:{operationId:'context_get_source',parameters:[{name:'source_id',in:'path',required:true,schema:{type:'string'}}],responses:response}}}};}
