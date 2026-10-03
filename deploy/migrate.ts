import {readFile} from 'node:fs/promises';
import {connectDatabase} from '../packages/core/src/db.ts';
export async function migrate(db:any){for(const name of ['001_init.sql','002_auth.sql','003_embeddings.sql','004_capture_status.sql','005_candidate_review.sql'])await db.query(await readFile(new URL(`./migrations/${name}`,import.meta.url),'utf8'));}
if(process.argv[1]?.endsWith('migrate.ts')){const databaseUrl=process.env.DATABASE_URL;if(!databaseUrl)throw new Error('DATABASE_URL is required');const db=connectDatabase(databaseUrl);try{await migrate(db);console.log('Migrations complete');}finally{await db.close();}}
