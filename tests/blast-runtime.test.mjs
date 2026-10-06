import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';

test('embedded Blast sends 151 chats and retries failed final cleanup without resending', async () => {
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
      if(action==='deactivate_chat' && body.id==='C150' && calls.filter(c=>c.action==='deactivate_chat'&&c.body.id==='C150').length===1)throw new Error('Temporary cleanup network failure');
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
  assert.equal(calls.filter(c=>c.action==='deactivate_chat').length,152);
  assert.equal(new Set(calls.filter(c=>c.action==='deactivate_chat').map(c=>c.body.id)).size,151);
  // Cleanup closes directly and confirms once: one get_chat per chat, plus one more only for the chat whose first close failed.
  assert.equal(calls.filter(c=>c.action==='get_chat').length,152);
});

test('main application delegates deployment refresh to the release checker', () => {
  const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
  assert.doesNotMatch(app,/location\.reload\s*\(|checkForUpdate|reloadWhenSafe/);
});
test('SDK connection preserves selected Blast and queue pins its existing iframe', async () => {
  const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
  const fn=name=>app.match(new RegExp(`function ${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))[0];
  const frame={src:'https://widget.test/blast/index?account=lc2'};
  const view={hidden:false,querySelector:()=>frame};
  const buttons=['customer','blast'].map(tab=>({dataset:{mainTab:tab},classList:{toggle(){}}}));
  let connect;
  const context=vm.createContext({
    activeMainTab:'blast',blastRunInProgress:false,previewMode:true,
    DEPARTMENT_TABS_LIVE:false,BLAST_LIVE:true,CONFIGURED_LIVECHAT_ACCOUNT:'lc2',
    mainTabAvailability:()=>({customer:true,blast:true,tickets:false,knowledge:false}),
    document:{getElementById:id=>id==='blastView'?view:null,querySelector:()=>null,querySelectorAll:()=>buttons},
    LiveChat:{createDetailsWidget:()=>new Promise(resolve=>{connect=resolve;})},
    logDiagnostic(){},renderChats(){},applyProfile(){},
  });
  vm.runInContext(fn('syncMainTabs')+'\n'+fn('initLiveChatSdk'),context);
  vm.runInContext('initLiveChatSdk()',context);
  connect({getCustomerProfile:()=>null,on(){}});
  await Promise.resolve();
  assert.equal(context.activeMainTab,'blast');
  assert.equal(view.hidden,false);
  context.blastRunInProgress=true;
  context.activeMainTab='customer'; // Late department update or tab switch.
  vm.runInContext('syncMainTabs()',context);
  assert.equal(context.activeMainTab,'blast');
  assert.equal(view.hidden,false);
  assert.equal(frame.src,'https://widget.test/blast/index?account=lc2');
  context.blastRunInProgress=false;
  context.activeMainTab='customer';
  vm.runInContext('syncMainTabs()',context);
  assert.equal(view.hidden,true);
});

for (const reloadAt of ['resume_chat', 'send_event', 'deactivate_chat', 'unconfirmed_send', 'last_close']) {
  test(`151-chat queue recovers a destroyed iframe during ${reloadAt} without duplicate messages`, async () => {
    const values=new Map([
      ['ca-livechat-agent-token:lc2','mock-token'],
      ['ca-livechat-agent-token-expiry:lc2',String(Date.now()+3600000)],
      ['ca-livechat-agent-account-id:lc2','agent'],
    ]);
    const storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};
    const chats=new Map();
    const calls=[];
    let destroyed=false;
    let notifyDestroyed;
    const destruction=new Promise(resolve=>notifyDestroyed=resolve);
    function boot() {
      const events={};
      let time=Date.now();
      const browser={
        location:{origin:'https://widget.test',pathname:'/blast/index',search:'?account=lc2'},
        sessionStorage:storage,localStorage:storage,document:{getElementById:()=>null},
        addEventListener:(name,fn)=>{events[name]=fn;},
        URL,URLSearchParams,Response,FormData,File,AbortSignal,crypto:webcrypto,
        Date:class extends Date{static now(){time+=350;return time;}},
        setTimeout:fn=>setTimeout(fn,0),clearTimeout,
        async fetch(url,init={}) {
          if(url==='/livechat-oauth-config')return Response.json({});
          const body=JSON.parse(init.body||'{}');
          const id=body.realChatId||body.chat_id||body.chat?.id||body.id;
          const chat=chats.get(id)||{active:false,events:[]};
          chats.set(id,chat);
          if(url==='/livechat-chat-status')return Response.json({ok:true,chatId:id,isActive:chat.active,accountKey:'lc2',raw:{users:[{id:'agent'}]}});
          const name=String(url).split('/').pop();
          calls.push({name,id});
          if(name==='resume_chat')chat.active=true;
          if(name==='send_event' && !(reloadAt==='unconfirmed_send' && !destroyed))chat.events.push(body.event);
          if(name==='deactivate_chat' && !(reloadAt==='last_close'&&id==='C150'&&!destroyed))chat.active=false;
          if(!destroyed&&((reloadAt==='last_close'&&name==='deactivate_chat'&&id==='C150')||name===(reloadAt==='unconfirmed_send'?'send_event':reloadAt))) {
            destroyed=true;
            events.pagehide();
            notifyDestroyed();
            return new Promise(()=>{}); // The old document never gets the response.
          }
          return Response.json(name==='get_chat'?{thread:{events:chat.events}}:{event_id:'mock-event'});
        },
      };
      browser.window=browser;browser.parent=browser;
      vm.runInContext(readFileSync(new URL('../blast/web-adapter.js',import.meta.url),'utf8'),vm.createContext(browser));
      return browser;
    }
    const first=boot();
    first.chrome.runtime.sendMessage({type:'START',concurrency:5,delay:0,jobs:Array.from({length:151},(_,i)=>({url:`https://my.livechatinc.com/chats/C${i}/T${i}`,messages:[`Test ${i}`]}))});
    await destruction;
    assert.ok(values.get('ca-livechat-engagement:queue:lc2'));
    const next=boot();
    const done=new Promise(resolve=>next.chrome.runtime.onMessage.addListener(event=>{if(event.type==='DONE')resolve(event);}));
    next.__blastRestoreQueue();
    assert.equal((await done).stopped,false);
    assert.equal(calls.filter(c=>c.name==='send_event').length,151);
    for(let i=0;i<151;i++) {
      assert.equal(chats.get(`C${i}`).events.length,reloadAt==='unconfirmed_send'&&i===0?0:1);
      assert.equal(chats.get(`C${i}`).active,false);
    }
    assert.equal(values.get('ca-livechat-engagement:queue:lc2'),undefined);
  });
}
