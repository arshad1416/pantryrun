const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const PORT = 19989;
let child, directory;
const sockets = [];
const payload = {ciphertext:'opaque-family-ciphertext',iv:'opaque-nonce',tag:'opaque-tag'};
const waitFor = (socket, predicate) => new Promise((resolve,reject) => {
  const timer=setTimeout(() => { socket.off('message', listener); reject(new Error('expected relay frame timed out')); },2000);
  const listener=raw => { const frame=JSON.parse(raw); if(predicate(frame)) {clearTimeout(timer); socket.off('message',listener); resolve(frame);} };
  socket.on('message',listener);
});
async function connect(token, familyId, deviceId) {
  const socket=new WebSocket(`ws://127.0.0.1:${PORT}`); sockets.push(socket);
  await new Promise((resolve,reject) => { socket.once('open',resolve);socket.once('error',reject); });
  const authenticated=waitFor(socket,f=>f.type==='auth_ack'); socket.send(JSON.stringify({type:'auth',relayToken:token}));await authenticated;
  const identified=waitFor(socket,f=>f.type==='ack');socket.send(JSON.stringify({type:'identity',familyId,deviceId}));await identified;return socket;
}
beforeAll(async () => {
  directory=fs.mkdtempSync(path.join(os.tmpdir(),'pantryrun-recovery-test-'));
  const state=path.join(directory,'state.json'); const expiresAt=Date.now()+3600000;
  fs.writeFileSync(state,JSON.stringify({enrolledDevices:{a:{familyId:'family',deviceId:'a',expiresAt},b:{familyId:'family',deviceId:'b',expiresAt},c:{familyId:'other-family',deviceId:'c',expiresAt}}}));
  child=spawn(process.execPath,['-e',"const net=require('net');const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(port,...args){return listen.call(this,port,'127.0.0.1',...args)};require('./server.js')"],{cwd:__dirname,env:{...process.env,PORT:String(PORT),RELAY_PORT:String(PORT),POOL_PORT:String(PORT+1),RELAY_DATA_DIR:directory,RELAY_STATE_FILE:state,POOL_SEPARATE_PORT:'false'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{output+=data;});
  for(let i=0;i<100;i++){try{const result=await fetch(`http://127.0.0.1:${PORT}/health`);if(result.ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}
  throw new Error('test relay did not start: '+output);
});
afterAll(async () => {sockets.forEach(s=>s.terminate());if(child&&child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await exited;}if(directory)fs.rmSync(directory,{recursive:true,force:true});});

test.each(['sync_request','recovery_request','recovery_response'])('forwards %s ciphertext within the authenticated family without storing it as a grocery update',async type=>{
  const a=await connect('a','family','a');const b=await connect('b','family','b');const c=await connect('c','other-family','c');const cross=[];c.on('message',raw=>cross.push(JSON.parse(raw)));
  const received=waitFor(b,f=>f.type===type);a.send(JSON.stringify({type,familyId:'family',deviceId:'spoofed',listId:'list',payload}));
  expect(await received).toEqual({type,familyId:'family',deviceId:'a',listId:'list',payload});
  await new Promise(r=>setTimeout(r,30));expect(cross.filter(f=>f.type===type)).toEqual([]);
  const file=path.join(directory,'data','encrypted-updates.json');expect(fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{}).toEqual({});
  a.close();b.close();c.close();
});

test('rejects a recovery frame claiming a different family room',async()=>{
  const a=await connect('a','family','a');const error=waitFor(a,f=>f.type==='error');a.send(JSON.stringify({type:'recovery_request',familyId:'other-family',listId:'list',payload}));
  expect((await error).message).toContain('family room');a.close();
});
