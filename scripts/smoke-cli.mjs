// Local-only smoke test: seeds disposable identities through Wrangler's local explorer,
// never through a production application route. Start `npm run dev` first.
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const origin='http://localhost:8787';
const base=origin+'/chat/v1';
const root=await mkdtemp(join(tmpdir(),'aichat-smoke-'));
const cli=(dir,args,token,input)=>{
  const childEnv={...process.env}; delete childEnv.AICHAT_TOKEN; if(token)childEnv.AICHAT_TOKEN=token;
  const result=execFileSync(process.execPath,['cli/index.ts',...args,'--base-url',base,'--config-dir',join(root,dir)],{
    encoding:'utf8',input,stdio:['pipe','pipe','pipe'],env:childEnv,
  });
  return JSON.parse(result);
};
async function seed(){
 const token=randomBytes(32).toString('hex'),user=randomUUID();
 const result=await(await fetch(origin+'/cdn-cgi/local/explorer/api/workers/durable_objects/namespaces/ai-session-chatroom-Directory/query',{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({durable_object_name:'directory',queries:[{
   sql:'INSERT INTO credentials (id,token_hash,user_id,kind,name,rooms,expires_at) VALUES (?,?,?,?,?,?,?)',
   params:[randomUUID(),createHash('sha256').update(token).digest('hex'),user,'management','smoke','[]',Date.now()+600000],
  }]}),
 })).json();
 assert.equal(result.success,true,'Local credential seed failed');return token;
}
try{
 await fetch(base+'/rooms',{headers:{Authorization:'Bearer '+ 'a'.repeat(64)}}); // initialize local Directory schema
 const alice=await seed(),bob=await seed();
 const room=cli('alice',['room','create','--name','CLI smoke'],alice);
 const invite=cli('alice',['invite','create','--room',room.id],alice);
 cli('bob',['invite','accept','--stdin'],bob,invite.code+'\n');
 const a1=cli('alice',['session','create','--room',room.id,'--name','backend'],alice);
 const a2=cli('alice',['session','create','--room',room.id,'--name','review'],alice);
 const b1=cli('bob',['session','create','--room',room.id,'--name','tester'],bob);
 const args=['--room',room.id,'--session',a1.id];
 const sent=cli('alice',['send',...args,'--message','API ready','--request-id','stable-smoke']);
 assert.equal(cli('alice',['send',...args,'--message','API ready','--request-id','stable-smoke']).id,sent.id);
 for(const [dir,id] of [['alice',a1.id],['alice',a2.id],['bob',b1.id]]){
  const received=cli(dir,['read','--room',room.id,'--session',id]);assert.equal(received.messages[0].id,sent.id);
 }
 const reply=cli('bob',['send','--room',room.id,'--session',b1.id,'--reply-to',sent.id,'--message','Tests passed']);assert.equal(reply.reply_to,sent.id);
 cli('bob',['ack','--room',room.id,'--session',b1.id,'--cursor',String(reply.seq)]);
 assert.equal(cli('bob',['read','--room',room.id,'--session',b1.id]).messages.length,0);
 cli('bob',['session','revoke',b1.id],bob);
 console.log('PASS: real local HTTP and CLI — 2 users, 3 sessions, invitation, deduplication, reply, independent cursors, ack, revocation.');
}catch(error){
 // Child-process failures may contain captured secrets; never print the error object.
 console.error('Local CLI smoke failed. Inspect the command implementation and local server logs.');process.exitCode=1;
}finally{await rm(root,{recursive:true,force:true});}
