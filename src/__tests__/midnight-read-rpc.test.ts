import { afterEach, expect, it, vi } from "vitest";
import express from "express";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer,type Server } from "node:http";
import Database from "better-sqlite3";
import { openMidnightReadRpc } from "../routes/midnight-read-rpc.js";
import { MockAgent,getGlobalDispatcher,setGlobalDispatcher } from "undici";

const roots:string[]=[],servers:Server[]=[],closers:(()=>void)[]=[];
const hash="0x"+"01".repeat(32),registry="438b1ea134e760e8b4e87409d663f36561f15341880c118dc41e4fc2b224c736";
const token="nightmainnet"+"a".repeat(32);
const clientFetch=globalThis.fetch;
const request=(method="chain_getHeader",params:unknown[]=[hash],id:unknown=1)=>({jsonrpc:"2.0",id,method,params});
afterEach(async()=>{vi.restoreAllMocks();for(const server of servers.splice(0))await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));for(const close of closers.splice(0))close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function fixture(answer?:(body:unknown)=>unknown,useDefault=false){
  const root=mkdtempSync(join(tmpdir(),"midnight-read-"));roots.push(root);
  const keyFile=join(root,"project-id");writeFileSync(keyFile,token,{mode:0o600});
  const upstream=vi.fn(async(_url:unknown,options?:RequestInit)=>{
    const body=JSON.parse(String(options?.body));
    const reply=(entry:any)=>({jsonrpc:"2.0",id:entry.id,result:entry.method==="chain_getFinalizedHead"?hash:{height:1}});
    return new Response(JSON.stringify(answer?answer(body):Array.isArray(body)?body.map(reply):reply(body)),{headers:{"content-type":"application/json"}});
  });
  const service=openMidnightReadRpc({projectIdFile:keyFile,stateDir:root,...(useDefault?{}:{fetcher:upstream as typeof fetch})});if(!service)throw new Error("Missing enabled proxy");closers.push(service.close);
  const app=express();app.use(service.router);
  const server=app.listen(0,"127.0.0.1");servers.push(server);await new Promise<void>(resolve=>server.once("listening",resolve));
  const address=server.address();if(!address||typeof address==="string")throw new Error("Missing fixture port");
  const call=async(body:unknown,headers:Record<string,string>={},signal?:AbortSignal)=>clientFetch(`http://127.0.0.1:${address.port}/midnight/mainnet/rpc`,{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body),signal});
  return {root,service,upstream,call};
}
it("keeps the route disabled without the new explicit project file",()=>{
  expect(openMidnightReadRpc({})).toBeNull();
});
it("uses the patched explicit HTTP client independently of Node's bundled fetch",async()=>{
  const dispatcher=getGlobalDispatcher(),mock=new MockAgent();mock.disableNetConnect();mock.enableNetConnect(/^127\.0\.0\.1(?::[0-9]+)?$/);setGlobalDispatcher(mock);
  mock.get("https://rpc.midnight-mainnet.blockfrost.io").intercept({path:"/",method:"POST"}).reply(200,{jsonrpc:"2.0",id:0,result:{height:1}});
  const bundled=vi.spyOn(globalThis,"fetch").mockImplementation(async()=>{throw new Error("Bundled fetch must not be used");});
  try{const f=await fixture(undefined,true);expect((await f.call(request())).status).toBe(200);expect(bundled).not.toHaveBeenCalled();mock.assertNoPendingInterceptors();}
  finally{setGlobalDispatcher(dispatcher);await mock.close();}
});
it("allows only one quota writer for a state directory and releases ownership on close",async()=>{
  const f=await fixture(),options={projectIdFile:join(f.root,"project-id"),stateDir:f.root};
  expect(()=>openMidnightReadRpc(options)).toThrow(/already owned/);
  f.service.close();closers.pop();
  const next=openMidnightReadRpc(options);expect(next).not.toBeNull();closers.push(next!.close);
});
it.each([
 request("author_submitExtrinsic",["0x00"]),request("state_getStorage",["0x00",hash]),request("chain_subscribeNewHeads",[]),request("state_getReadProof",[["0x3a636f6465"],hash]),
 request("state_getReadProof",[["0x00"],hash]),request("chain_getHeader",[]),request("midnight_contractState",["00".repeat(32),hash]),request("grandpa_proveFinality",[-1]),
 {jsonrpc:"2.0",method:"chain_getFinalizedHead",params:[]},{...request(),url:"https://attacker.example"},[],Array.from({length:33},(_,id)=>request("chain_getHeader",[hash],id)),[request(),request()],[[request()]]
])("rejects unsupported or ambiguous requests before contacting upstream: %j",async body=>{
  const f=await fixture();expect((await f.call(body)).status).toBe(400);expect(f.upstream).not.toHaveBeenCalled();
});
it("uses a fixed credential header and rewrites cached response IDs",async()=>{
  const f=await fixture(),first=await f.call(request());expect(first.status).toBe(200);expect((await first.json()).id).toBe(1);
  const next=await f.call(request("chain_getHeader",[hash],"second"));expect((await next.json()).id).toBe("second");expect(f.upstream).toHaveBeenCalledTimes(1);
  const [url,options]=f.upstream.mock.calls[0]!;expect(url).toBe("https://rpc.midnight-mainnet.blockfrost.io");
  expect((options!.headers as Record<string,string>).project_id).toBe(token);expect(options!.redirect).toBe("error");
});
it("preserves numeric RPC error codes while suppressing all upstream text and echoed tokens",async()=>{
  const f=await fixture(body=>({jsonrpc:"2.0",id:(body as any).id,error:{code:-32602,message:token,data:{private:token}}}));
  const response=await f.call(request("midnight_contractState",[registry,hash]));expect(response.status).toBe(200);
  const text=await response.text();expect(text).not.toContain(token);expect(JSON.parse(text).error).toEqual({code:-32602,message:"Upstream read refused"});
});
it("reserves durable quota by subcalls before upstream work and keeps it after reopening",async()=>{
  const f=await fixture();
  const db=new Database(join(f.root,"read-rpc.sqlite"));
  db.prepare("insert or replace into read_budget(day,used) values (?,?)").run(Math.floor(Date.now()/86400000),79999);db.close();
  const body=[request("chain_getHeader",[hash],1),request("chain_getBlock",[hash],2)];
  expect((await f.call(body)).status).toBe(429);expect(f.upstream).not.toHaveBeenCalled();
  expect((await f.call(request())).status).toBe(200);
  f.service.close();closers.pop();
  const reopened=openMidnightReadRpc({projectIdFile:join(f.root,"project-id"),stateDir:f.root,fetcher:f.upstream as typeof fetch});closers.push(reopened.close);
  const check=new Database(join(f.root,"read-rpc.sqlite"),{readonly:true});expect(check.prepare("select used from read_budget").get()).toMatchObject({used:80000});check.close();
});
it("recovers from a synchronous upstream failure without retaining a poisoned in-flight job",async()=>{
  const f=await fixture();f.upstream.mockImplementationOnce(()=>{throw new Error("fixture unavailable");});
  expect((await f.call(request())).status).toBe(503);expect((await f.call(request())).status).toBe(200);
});
it("starts a fresh bounded rate window after the old one expires",async()=>{
  let now=Date.now();vi.spyOn(Date,"now").mockImplementation(()=>now);const f=await fixture();
  for(let turn=0;turn<2;turn++){
    for(let n=0;n<600;n++)expect((await f.call(request())).status).toBe(200);
    expect((await f.call(request())).status).toBe(429);now+=60_001;
  }
});
it("refuses restored quota rows below the separately retained high-water mark",async()=>{
  const f=await fixture();expect((await f.call(request())).status).toBe(200);f.service.close();closers.pop();
  const db=new Database(join(f.root,"read-rpc.sqlite"));db.prepare("update read_budget set used=0").run();db.close();
  expect(()=>openMidnightReadRpc({projectIdFile:join(f.root,"project-id"),stateDir:f.root})).toThrow(/rewound/);
});
it("never forwards or caches a provider token echoed inside a result",async()=>{
  const f=await fixture(body=>({jsonrpc:"2.0",id:(body as any).id,result:{nested:[token]}}));
  const response=await f.call(request());expect(response.status).toBe(503);expect(await response.text()).not.toContain(token);
  expect((await f.call(request())).status).toBe(503);expect(f.upstream).toHaveBeenCalledTimes(2);
});
it("bounds the expanded downstream batch even when identical calls share one upstream result",async()=>{
  const f=await fixture(body=>({jsonrpc:"2.0",id:(body as any).id,result:"a".repeat(2*1024*1024)}));
  const response=await f.call(Array.from({length:32},(_,id)=>request("chain_getHeader",[hash],id)));
  expect(response.status).toBe(503);expect((await response.text()).length).toBeLessThan(1000);expect(f.upstream).toHaveBeenCalledTimes(1);
});
it("serializes distinct concurrent verifier reads without rejecting a normal parallel pair",async()=>{
  const f=await fixture(),original=f.upstream.getMockImplementation()!;
  f.upstream.mockImplementation(async(...args)=>{await new Promise(resolve=>setTimeout(resolve,50));return original(...args);});
  const replies=await Promise.all([f.call(request("chain_getHeader",[hash],1)),f.call(request("chain_getBlock",[hash],2))]);
  expect(replies.map(reply=>reply.status)).toEqual([200,200]);expect(f.upstream).toHaveBeenCalledTimes(2);
});
it("limits actual HTTP exchanges as well as subcalls to retain free-tier wallet headroom",async()=>{
  const f=await fixture(),db=new Database(join(f.root,"read-rpc.sqlite"));
  db.prepare("update read_budget set used=0,requests=39999").run();db.close();
  expect((await f.call([request("chain_getHeader",[hash],1),request("chain_getBlock",[hash],2)])).status).toBe(200);
  expect((await f.call(request("chain_getFinalizedHead",[],3))).status).toBe(429);
  expect(f.upstream).toHaveBeenCalledTimes(1);
});
it("keeps timed-out queued jobs behind an earlier upstream operation until it drains",async()=>{
  const timer=globalThis.setTimeout;
  vi.spyOn(globalThis,"setTimeout").mockImplementation(((callback:()=>void,delay:number,...args:unknown[])=>timer(callback,delay===12_000?60:delay,...args)) as typeof setTimeout);
  const f=await fixture(),original=f.upstream.getMockImplementation()!;let active=0,maximum=0;
  f.upstream.mockImplementation(async(...args)=>{active++;maximum=Math.max(maximum,active);try{await new Promise(resolve=>timer(resolve,180));return await original(...args);}finally{active--;}});
  const first=f.call(request("chain_getHeader",[hash],1));await new Promise(resolve=>timer(resolve,10));
  const second=f.call(request("chain_getBlock",[hash],2));await new Promise(resolve=>timer(resolve,90));
  const third=f.call(request("chain_getFinalizedHead",[],3));
  const replies=await Promise.all([first,second,third]);expect(maximum).toBe(1);expect(replies.map(reply=>reply.status)).toEqual([503,503,503]);
});
it("aborts an actual upstream response that trickles bytes past the whole exchange deadline",async()=>{
  const timer=globalThis.setTimeout;
  vi.spyOn(globalThis,"setTimeout").mockImplementation(((callback:()=>void,delay:number,...args:unknown[])=>timer(callback,delay===12_000?100:delay,...args)) as typeof setTimeout);
  let disconnected=false;
  const upstream=createServer((_req,res)=>{res.writeHead(200,{"content-type":"application/json"});res.write('{"jsonrpc":"2.0","id":0,"result":"');const interval=setInterval(()=>res.write("a"),10);res.once("close",()=>{clearInterval(interval);disconnected=true;});});
  servers.push(upstream);upstream.listen(0,"127.0.0.1");await new Promise<void>(resolve=>upstream.once("listening",resolve));
  const port=(upstream.address() as {port:number}).port,f=await fixture();
  f.upstream.mockImplementation((_url,options)=>fetch(`http://127.0.0.1:${port}`,options));
  const started=Date.now(),response=await f.call(request());expect(response.status).toBe(503);expect(Date.now()-started).toBeLessThan(2000);
  await new Promise(resolve=>timer(resolve,30));expect(disconnected).toBe(true);
});
it("rejects malformed UTF-8 without replacement characters or caching",async()=>{
  const f=await fixture();f.upstream.mockImplementation(async()=>new Response(new Uint8Array([123,255,125])));
  expect((await f.call(request())).status).toBe(503);expect((await f.call(request())).status).toBe(503);expect(f.upstream).toHaveBeenCalledTimes(2);
});
it("caps decoded upstream streams before accumulating more than forty MiB",async()=>{
  const f=await fixture();let cancelled=false,pulls=0;
  f.upstream.mockImplementation(async()=>new Response(new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}})));
  expect((await f.call(request())).status).toBe(503);expect(cancelled).toBe(true);expect(pulls).toBeLessThan(45);
});
it("retains capacity for disconnected clients until their coalesced upstream read drains",async()=>{
  const f=await fixture(),original=f.upstream.getMockImplementation()!;let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  f.upstream.mockImplementation(async(...args)=>{await gate;return original(...args);});
  const controllers=Array.from({length:8},()=>new AbortController());
  const calls=controllers.map((controller,id)=>f.call(request("chain_getHeader",[hash],id),{},controller.signal));
  const settled=Promise.allSettled(calls);
  try{
    for(let count=0;f.upstream.mock.calls.length===0&&count<100;count++)await new Promise(resolve=>setTimeout(resolve,5));
    expect(f.upstream).toHaveBeenCalledTimes(1);await new Promise(resolve=>setTimeout(resolve,30));
    controllers.forEach(controller=>controller.abort());await settled;
    expect((await f.call(request())).status).toBe(429);
  }finally{release();}
  await new Promise(resolve=>setTimeout(resolve,30));expect((await f.call(request())).status).toBe(200);expect(f.upstream).toHaveBeenCalledTimes(1);
});
