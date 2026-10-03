import {randomBytes,randomUUID,scryptSync,timingSafeEqual,createHash} from 'node:crypto';
import type {Database,Auth} from '../../../packages/core/src/index.ts';
export const hash=(token:string)=>createHash('sha256').update(token).digest('hex');
function passwordHash(password:string){const salt=randomBytes(16).toString('hex');return `${salt}:${scryptSync(password,salt,64).toString('hex')}`;}
function checkPassword(password:string,encoded:string){const [salt,h]=encoded.split(':');if(!salt||!h)return false;const expected=Buffer.from(h,'hex'),actual=scryptSync(password,salt,64);return expected.length===actual.length&&timingSafeEqual(expected,actual);}
export async function bootstrap(db:Database,email?:string,password?:string){if(!email||!password)return;if(password.length<12)throw new Error('BOOTSTRAP_PASSWORD must contain at least 12 characters');const users=await db.query('SELECT id FROM tk_users LIMIT 1');if(users.rows.length)return;await db.query('INSERT INTO tk_users(id,email,password_hash) VALUES($1,$2,$3)',[randomUUID(),email.toLowerCase(),passwordHash(password)]);}
export function createAuth(db:Database){return {
 async login(email:string,password:string){const r=await db.query('SELECT * FROM tk_users WHERE email=$1',[email.toLowerCase()]);if(!r.rows[0]||!checkPassword(password,r.rows[0].password_hash))return null;const token=randomBytes(32).toString('base64url');await db.query('INSERT INTO tk_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval \'7 days\')',[hash(token),r.rows[0].id]);return {token,user:{id:r.rows[0].id,email:r.rows[0].email}};},
 async principal(headers:Record<string,any>):Promise<{auth:Auth;user?:{id:string,email:string};sessionHash?:string}|null>{
 const bearer=/^Bearer ([A-Za-z0-9_-]+)$/i.exec(headers.authorization??'');
 if(bearer){const r=await db.query('SELECT * FROM tk_clients WHERE token_hash=$1 AND revoked_at IS NULL',[hash(bearer[1])]);const c=r.rows[0];return c?{auth:{ownerId:c.user_id,clientId:c.id,permissions:c.permissions,projects:c.projects}}:null;}
 if(headers.authorization)return null;
 const session=/(?:^|;\s*)tk_session=([A-Za-z0-9_-]+)/.exec(headers.cookie??'');if(!session)return null;const r=await db.query('SELECT u.id,u.email FROM tk_sessions s JOIN tk_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()',[hash(session[1])]);const u=r.rows[0];return u?{auth:{ownerId:u.id,clientId:'profile',permissions:['read','capture','correct','delete','export','import','admin','retry'],projects:null},user:u,sessionHash:hash(session[1])}:null;
 },
 async createClient(userId:string,name:string,permissions:string[],projects:string[]|null){const token=randomBytes(32).toString('base64url'),id=randomUUID();const r=await db.query('INSERT INTO tk_clients(id,user_id,name,token_hash,permissions,projects) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,permissions,projects,created_at,revoked_at',[id,userId,name,hash(token),JSON.stringify(permissions),projects===null?null:JSON.stringify(projects)]);return {client:r.rows[0],token};}
};}
