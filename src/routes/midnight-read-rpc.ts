import { Router, json } from "express";
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { fetch as patchedFetch } from "undici";

const REGISTRY="438b1ea134e760e8b4e87409d663f36561f15341880c118dc41e4fc2b224c736";
const EVENTS="0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7";
const TIMESTAMP="0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb";
const MAXIMUM_CALLS=80_000,MAXIMUM_REQUESTS=40_000,MAXIMUM_RESPONSE=40*1024*1024,MAXIMUM_CACHE=128*1024*1024;
type Call={jsonrpc:"2.0";id:number|string;method:string;params:unknown[]};
type Answer={result:unknown}|{error:{code:number;message:string}};
const hash=(value:unknown)=>typeof value==="string"&&/^0x[a-f0-9]{64}$/.test(value);
const height=(value:unknown)=>Number.isInteger(value)&&Number(value)>=0&&Number(value)<=0xffffffff;
function parse(value:unknown):Call {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!=="id,jsonrpc,method,params")throw new Error("Invalid RPC envelope");
  const call=value as Call,p=call.params;
  if(call.jsonrpc!=="2.0"||!(Number.isSafeInteger(call.id)||(typeof call.id==="string"&&/^[A-Za-z0-9_.:-]{1,64}$/.test(call.id)))||!Array.isArray(p))throw new Error("Invalid RPC identity");
  const valid=call.method==="chain_getFinalizedHead"?p.length===0:
    call.method==="chain_getBlockHash"||call.method==="grandpa_proveFinality"?p.length===1&&height(p[0]):
    ["chain_getHeader","chain_getBlock","midnight_zswapStateRoot"].includes(call.method)?p.length===1&&hash(p[0]):
    call.method==="midnight_contractState"?p.length===2&&p[0]===REGISTRY&&hash(p[1]):
    call.method==="state_getReadProof"?p.length===2&&hash(p[1])&&(JSON.stringify(p[0])===JSON.stringify(["0x3a636f646500"])||JSON.stringify(p[0])===JSON.stringify([EVENTS,TIMESTAMP])):false;
  if(!valid)throw new Error("RPC read is not allowed");return call;
}
function privateFile(path:string) {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const info=fstatSync(fd);
    if(!info.isFile()||info.mode&0o077||(process.getuid&&info.uid!==process.getuid())||info.size>4096)throw new Error("Unsafe read RPC file");
    return readFileSync(fd,"utf8");
  }finally{closeSync(fd);}
}

export function openMidnightReadRpc(options:{projectIdFile?:string|undefined;stateDir?:string|undefined;fetcher?:typeof fetch}) {
  if(!options.projectIdFile)return null;
  const token=privateFile(options.projectIdFile).trim();
  if(!/^nightmainnet[A-Za-z0-9]{32}$/.test(token)||!options.stateDir)throw new Error("Invalid read RPC configuration");
  const directory=lstatSync(options.stateDir);
  if(!directory.isDirectory()||directory.mode&0o077||(process.getuid&&directory.uid!==process.getuid()))throw new Error("Read RPC state must be private and owned");
  const lock=openSync(join(options.stateDir,"read-rpc.lock"),constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
  const dbPath=join(options.stateDir,"read-rpc.sqlite"),guardPath=join(options.stateDir,"read-rpc-high-water.json");
  const existing=existsSync(dbPath);
  let db:Database.Database;
  try{
    const info=fstatSync(lock);
    if(!info.isFile()||info.mode&0o077||(process.getuid&&info.uid!==process.getuid()))throw new Error("Unsafe read RPC lock");
    const ownership=spawnSync("flock",["--exclusive","--nonblock","3"],{stdio:["ignore","ignore","ignore",lock]});
    if(ownership.status!==0||ownership.error)throw new Error("Read RPC state is already owned or locking is unavailable");
    if(existing!==existsSync(guardPath))throw new Error("Read RPC quota history is incomplete");
    const fd=openSync(dbPath,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
    try {const info=fstatSync(fd);if(!info.isFile()||info.mode&0o077||(process.getuid&&info.uid!==process.getuid()))throw new Error("Unsafe read RPC database");}finally{closeSync(fd);}
    db=new Database(dbPath);
  }catch(error){closeSync(lock);throw error;}
  let closed=false;
  const close=()=>{if(!closed){closed=true;try{db.close();}finally{closeSync(lock);}}};
  function watermark(day:number,used:number,requests:number) {
    const next=join(options.stateDir!,`read-rpc.${randomUUID()}.next`);
    try {
      writeFileSync(next,JSON.stringify({day,used,requests}),{mode:0o600,flag:"wx"});
      const file=openSync(next,constants.O_RDONLY);try{fsyncSync(file);}finally{closeSync(file);}
      renameSync(next,guardPath);
      const parent=openSync(options.stateDir!,constants.O_RDONLY|constants.O_DIRECTORY);try{fsyncSync(parent);}finally{closeSync(parent);}
    }finally{if(existsSync(next))unlinkSync(next);}
  }
  function reserve(count:number) {
    const day=Math.floor(Date.now()/86_400_000),guard=JSON.parse(privateFile(guardPath)) as {day:number;used:number;requests:number};
    if(Object.keys(guard).sort().join(",")!=="day,requests,used"||!Number.isSafeInteger(guard.day)||guard.day<0||!Number.isSafeInteger(guard.used)||guard.used<0||guard.used>MAXIMUM_CALLS||!Number.isSafeInteger(guard.requests)||guard.requests<0||guard.requests>MAXIMUM_REQUESTS)throw new Error("Invalid read RPC quota high-water");
    const result=db.transaction(()=>{
      const latest=db.prepare("select day,used,requests from read_budget order by day desc limit 1").get() as {day:number;used:number;requests:number}|undefined;
      if(!latest||latest.day<guard.day||(latest.day===guard.day&&(latest.used<guard.used||latest.requests<guard.requests))||day<latest.day)throw new Error("Read RPC quota history rewound");
      const used=latest.day===day?latest.used:0,requests=latest.day===day?latest.requests:0,nextRequests=requests+Number(count>0);
      if(!Number.isSafeInteger(used)||used<0||used+count>MAXIMUM_CALLS||!Number.isSafeInteger(requests)||requests<0||nextRequests>MAXIMUM_REQUESTS)return null;
      db.prepare("insert or replace into read_budget values (?,?,?)").run(day,used+count,nextRequests);return {used:used+count,requests:nextRequests};
    })();
    if(result===null)return false;watermark(day,result.used,result.requests);return true;
  }
  try {
    db.pragma("journal_mode=WAL");db.pragma("synchronous=FULL");db.pragma("busy_timeout=3000");
    if(!existing){
      db.exec("create table read_budget(day integer primary key,used integer not null,requests integer not null default 0);create table read_cache(key text primary key,value text not null,bytes integer not null,expires integer not null,touched integer not null)");
      const day=Math.floor(Date.now()/86_400_000);db.prepare("insert into read_budget values (?,0,0)").run(day);watermark(day,0,0);
    }
    if(!reserve(0))throw new Error("Read RPC quota is unavailable");
  }catch(error){close();throw error;}
  const fetcher=options.fetcher??(patchedFetch as unknown as typeof fetch),router=Router({strict:true,caseSensitive:true});
  const pending=new Map<string,Promise<Map<string,Answer>>>();let active=0,responseBytes=0,tail=Promise.resolve();
  const rate=new Map<string,{at:number;count:number}>();
  const key=(call:Call)=>JSON.stringify([call.method,call.params]);
  const cached=(id:string):Answer|undefined=>{
    const row=db.prepare("select value from read_cache where key=? and expires>?").get(id,Date.now()) as {value:string}|undefined;
    if(!row)return undefined;return {result:JSON.parse(row.value)};
  };
  const put=(call:Call,value:unknown)=>{
    if(value===null)return;
    const encoded=JSON.stringify(value),bytes=Buffer.byteLength(encoded);
    if(bytes>256*1024)return;
    const now=Date.now(),ttl=call.method==="chain_getFinalizedHead"?3000:call.method==="chain_getBlockHash"?5000:7*86_400_000;
    db.transaction(()=>{
      db.prepare("insert or replace into read_cache values (?,?,?,?,?)").run(key(call),encoded,bytes,now+ttl,now);
      db.prepare("delete from read_cache where expires<=?").run(now);
      while(Number((db.prepare("select coalesce(sum(bytes),0) total from read_cache").get() as {total:number}).total)>MAXIMUM_CACHE||Number((db.prepare("select count(*) total from read_cache").get() as {total:number}).total)>8192){
        db.exec("delete from read_cache where key in (select key from read_cache order by touched limit 32)");
      }
    })();
  };
  async function read(calls:Call[]):Promise<Map<string,Answer>> {
    const answers=new Map<string,Answer>(),missing=new Map<string,Call>();
    for(const call of calls){const id=key(call),value=cached(id);if(value)answers.set(id,value);else missing.set(id,call);}
    if(!missing.size)return answers;
    const group=[...missing.keys()].sort().join("|");let job=pending.get(group);
    if(!job){
      if(!reserve(missing.size))return new Map([...missing.keys()].map(id=>[id,{error:{code:-32005,message:"Read quota exhausted"}}]));
      const before=tail,abort=new AbortController();
      const expired=new Promise<never>((_resolve,reject)=>abort.signal.addEventListener("abort",()=>reject(new Error("Read RPC deadline exceeded")),{once:true}));
      const timer=setTimeout(()=>abort.abort(),12_000);
      job=Promise.resolve().then(async()=>{
        const request=[...missing.values()].map((call,id)=>({...call,id}));
        try {
          await Promise.race([before,expired]);abort.signal.throwIfAborted();
          const response=await fetcher("https://rpc.midnight-mainnet.blockfrost.io",{method:"POST",redirect:"error",signal:abort.signal,headers:{"content-type":"application/json",project_id:token},body:JSON.stringify(request.length===1?request[0]:request)});
          abort.signal.throwIfAborted();
          if(!response.ok||!response.body)throw new Error("Read RPC upstream is unavailable");
          const chunks:Buffer[]=[];let length=0;const reader=response.body.getReader();
          try{for(;;){const next=await reader.read();if(next.done)break;length+=next.value.byteLength;if(length>MAXIMUM_RESPONSE){await reader.cancel();throw new Error("Read RPC response exceeds bounds");}chunks.push(Buffer.from(next.value));}}
          finally{reader.releaseLock();}
          abort.signal.throwIfAborted();
          const text=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));
          const decoded:unknown=JSON.parse(text),rows=Array.isArray(decoded)?decoded:[decoded];
          if(rows.length!==request.length)throw new Error("Read RPC response count differs");
          const values=new Map<string,Answer>(),ids=new Set<number>();
          for(const raw of rows){
            if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new Error("Invalid read RPC response");
            const row=raw as {jsonrpc?:unknown;id?:unknown;result?:unknown;error?:{code?:unknown}};
            if(row.jsonrpc!=="2.0"||!Number.isInteger(row.id)||Number(row.id)<0||Number(row.id)>=request.length||ids.has(Number(row.id))||("result" in row)===("error" in row))throw new Error("Read RPC response identity differs");
            const id=Number(row.id),call=request[id]!;ids.add(id);
            if("error" in row){
              if(!row.error||!Number.isSafeInteger(row.error.code))throw new Error("Invalid read RPC error");
              values.set(key(call),{error:{code:Number(row.error.code),message:"Upstream read refused"}});
            }else{if(JSON.stringify(row.result).includes(token))throw new Error("Read RPC result contains private data");values.set(key(call),{result:row.result});put(call,row.result);}
          }
          return values;
        }finally{clearTimeout(timer);abort.abort();pending.delete(group);}
      });pending.set(group,job);tail=Promise.allSettled([before,job]).then(()=>undefined);
    }
    for(const [id,value] of await job)answers.set(id,value);return answers;
  }
  router.use("/midnight/mainnet/rpc",(req,res,next)=>{
    if(req.method!=="POST"||req.originalUrl.includes("?")||req.headers["content-encoding"]||!req.is("application/json")){res.status(400).json({error:"Invalid read RPC request"});return;}next();
  },json({limit:"8kb",inflate:false}));
  router.post("/midnight/mainnet/rpc",async(req,res)=>{
    let calls:Call[];const batch=Array.isArray(req.body);
    try {
      const values=batch?req.body:[req.body];if(!values.length||values.length>32)throw new Error("Invalid read RPC batch");
      calls=values.map(parse);if(new Set(calls.map(call=>JSON.stringify(call.id))).size!==calls.length)throw new Error("Duplicate read RPC identities");
    }catch{res.status(400).json({error:"Invalid read RPC request"});return;}
    const now=Date.now(),peer=req.socket.remoteAddress??"unknown",previousWindow=rate.get(peer),window=previousWindow&&now-previousWindow.at<60_000?previousWindow:undefined;
    for(const [id,row] of rate)if(now-row.at>=60_000)rate.delete(id);
    if(active>=8||(window&&now-window.at<60_000&&window.count>=600)||(!window&&rate.size>=256)){res.status(429).json({error:"Read RPC is busy"});return;}
    rate.set(peer,{at:window?.at??now,count:(window?.count??0)+1});active++;
    let released=false,settled=false,finished=false,heldBytes=0;const release=()=>{if(!released&&settled&&finished){released=true;active--;responseBytes-=heldBytes;}};
    const finish=()=>{finished=true;release();};res.once("finish",finish);res.once("close",finish);
    try {
      const answers=await read(calls);
      if(res.destroyed)return;
      if([...answers.values()].some(answer=>"error" in answer&&answer.error.code===-32005)){res.status(429).json({error:"Read quota exhausted"});return;}
      const rows:string[]=[];let bytes=2;
      for(const call of calls){
        const answer=answers.get(key(call));if(!answer)throw new Error("Missing read RPC result");
        const metadata=JSON.stringify({jsonrpc:"2.0",id:call.id}),value=JSON.stringify(answer);
        bytes+=Buffer.byteLength(metadata)+Buffer.byteLength(value)+1;
        if(bytes>MAXIMUM_RESPONSE)throw new Error("Read RPC output exceeds bounds");
        rows.push(metadata.slice(0,-1)+","+value.slice(1));
      }
      if(responseBytes+bytes>2*MAXIMUM_RESPONSE)throw new Error("Read RPC output capacity is exhausted");
      heldBytes=bytes;responseBytes+=bytes;
      res.type("application/json").send(batch?"["+rows.join(",")+"]":rows[0]);
    }catch{if(!res.destroyed&&!res.headersSent)res.status(503).json({error:"Read RPC unavailable"});}
    finally{settled=true;release();}
  });
  router.use((error:unknown,_req:import("express").Request,res:import("express").Response,_next:import("express").NextFunction)=>{
    res.status((error as {status?:number})?.status===413?413:400).json({error:"Invalid read RPC request"});
  });
  return {router,close};
}
