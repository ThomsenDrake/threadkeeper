// Disposable synthetic profile demo. Real deployments use PostgreSQL and the worker.
import {createTestDatabase} from '../tests/helpers.ts';
import {bootstrap} from '../apps/api/src/auth.ts';
import {createApp} from '../apps/api/src/app.ts';
const db=await createTestDatabase();
await bootstrap(db.db,'demo@example.invalid','threadkeeper-demo-password');
const origin='http://127.0.0.1:3000';const {app}=createApp(db.db,{origin});
const server=app.listen(3000,'127.0.0.1',()=>{
 console.log(`Disposable synthetic profile: ${origin}`);
 console.log('Sign in: demo@example.invalid / threadkeeper-demo-password');
 console.log('Data resets when stopped. No model inference or external accounts used.');
});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close(async()=>{await db.close();process.exit(0);});});
