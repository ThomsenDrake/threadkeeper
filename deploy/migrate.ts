import {readFile} from 'node:fs/promises';
import {connectDatabase} from '../packages/core/src/db.ts';
export async function migrate(db:any){for(const name of ['001_init.sql','002_auth.sql'])await db.query(await readFile(new URL(`./migrations/${name}`,import.meta.url),'utf8'));}
if(process.argv[1]?.endsWith('migrate.ts')){const db=connectDatabase(process.env.DATABASE_URL??'postgres://threadkeeper:threadkeeper@localhost:5432/threadkeeper');try{await migrate(db);console.log('Migrations complete');}finally{await db.close();}}
