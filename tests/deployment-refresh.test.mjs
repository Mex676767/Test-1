import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../deployment-refresh.js',import.meta.url),'utf8');
test('release check refreshes once for new code, defers busy queues, and ignores unchanged versions', async () => {
  const old='a'.repeat(40), next='b'.repeat(40);
  let version=old, busy=false, reloads=0, check;
  const values=new Map();
  const context={document:{hidden:false,querySelector:()=>({content:old}),addEventListener(){}},
    sessionStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},
    fetch:async()=>({ok:true,json:async()=>({version})}),
    setInterval:fn=>{check=fn;},location:{reload:()=>reloads++},
    window:{canRefreshForDeployment:()=>!busy}};
  vm.runInNewContext(source,context);
  await check(); await check(); assert.equal(reloads,0);
  version=next; busy=true; await check(); assert.equal(reloads,0);
  busy=false; await check(); await check(); assert.equal(reloads,1);
  // Even stale HTML served after refresh must not cause a reload loop.
  vm.runInNewContext(source,context);
  await check(); assert.equal(reloads,1);
  version='not a release'; await check(); assert.equal(reloads,1);
});
