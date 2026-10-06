import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';

test('embedded Blast sends all 151 chats without opening a delivery window', async () => {
  const values = new Map([
    ['ca-livechat-agent-token:lc2','mock-agent-token'],
    ['ca-livechat-agent-token-expiry:lc2', String(Date.now()+3600000)],
  ]);
  const storage = {getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};
  const calls=[];
  let time=Date.now();
  const browser={
    location:{origin:'https://widget.test',pathname:'/blast/index',search:'?account=lc2'},
    localStorage:storage,sessionStorage:storage,
    document:{getElementById:()=>null},
    addEventListener(){},
    open(){throw new Error('Blast must stay embedded');},
    URL,URLSearchParams,Response,FormData,File,AbortSignal,crypto:webcrypto,
    Date:class extends Date {static now(){time+=350;return time;}},
    setTimeout:(fn)=>setTimeout(fn,0),clearTimeout,
    async fetch(url,init={}) {
      if(url==='/livechat-oauth-config')return Response.json({});
      const body=JSON.parse(init.body||'{}');
      if(url==='/livechat-chat-status')return Response.json({ok:true,chatId:body.realChatId,isActive:false,accountKey:'lc2',raw:{users:[]}});
      const action=String(url).split('/').pop();
      calls.push({action,body});
      assert.equal(init.headers.Authorization,'Bearer mock-agent-token');
      return Response.json(action==='send_event'?{event_id:'mock-event'}:{});
    },
  };
  browser.window=browser;
  browser.parent=browser;
  vm.runInContext(readFileSync(new URL('../blast/web-adapter.js',import.meta.url),'utf8'),vm.createContext(browser));
  const done=new Promise(resolve=>browser.chrome.runtime.onMessage.addListener(event=>{if(event.type==='DONE')resolve(event);}));
  browser.chrome.runtime.sendMessage({type:'START',concurrency:5,delay:0,jobs:Array.from({length:151},(_,i)=>({url:`https://my.livechatinc.com/chats/C${i}/T${i}`,messages:[`Mock ${i}`]}))});
  assert.equal((await done).stopped,false);
  assert.equal(calls.filter(c=>c.action==='send_event').length,151);
  assert.equal(new Set(calls.filter(c=>c.action==='send_event').map(c=>c.body.chat_id)).size,151);
  assert.equal(calls.filter(c=>c.action==='deactivate_chat').length,151);
});

test('deployment auto-refresh waits for running and paused Blast queues', () => {
  const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
  const fn=app.match(/function isSafeToAutoReload\(\) \{[\s\S]*?\n\}/)[0];
  const context=vm.createContext({document:{activeElement:null},state:{},blastRunInProgress:true});
  vm.runInContext(fn,context);
  assert.equal(vm.runInContext('isSafeToAutoReload()',context),false);
  // Pause keeps running=true in the existing blast-run-state message.
  assert.match(app,/blastRunInProgress = Boolean\(event.data.running\)/);
  context.blastRunInProgress=false;
  assert.equal(vm.runInContext('isSafeToAutoReload()',context),true);
});
