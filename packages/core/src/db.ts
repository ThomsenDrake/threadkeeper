import pg from 'pg';
import type { Database } from './index.ts';
export function connectDatabase(url:string): Database & {close():Promise<void>} {
 const pool=new pg.Pool({connectionString:url,max:10});
 return {
  query:async(sql,params)=>{const r=await pool.query(sql,params);return {rows:r.rows};},
  transaction:async(fn)=>{const client=await pool.connect();const tx:Database={query:async(sql,params)=>{const r=await client.query(sql,params);return {rows:r.rows};},transaction:async()=>{throw new Error('Nested transactions unsupported');}};try{await client.query('BEGIN');const r=await fn(tx);await client.query('COMMIT');return r;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}},
  close:async()=>pool.end()
 };
}
