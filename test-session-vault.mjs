import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Exercise the actual configuration parser, store, encryption and persistence
// against a generated home. Never open existing user configuration or keys.
const project=dirname(fileURLToPath(import.meta.url))
const fixture=mkdtempSync(join(tmpdir(),'cloakroom-session-vault-'))
const savedFilterFlag=process.env.CLAUDE_PII_FILTER
process.env.CLAUDE_PII_FILTER='1'
try {
mkdirSync(join(fixture,'.claude'),{recursive:true})
writeFileSync(join(fixture,'.claude','pii-filter.json'),JSON.stringify({enabled:true,categories:['EMAIL'],ollamaEnabled:false,heuristicNerEnabled:false,plugins:[],vaultEnabled:true,vaultTtlMinutes:120,fpe:{enabled:false},auditLog:{enabled:false},providerOverrides:{openai:{enabled:false}}}))
const bundle=await build({stdin:{contents:[
  "export {SessionFilterStore} from './src/server/sessionFilterStore.ts';",
  "export {MappingTable} from './src/core/mappingTable.ts';",
  "export {DEFAULT_CONFIG} from './src/core/types.ts';",
  "export {saveSessionVault,loadSessionVault,deleteSessionVault} from './src/core/vault.ts';",
].join('\n'),resolveDir:project,loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,plugins:[{
  name:'synthetic-vault-isolation',setup(builder){
    builder.onResolve({filter:/^node:os$/},args=>/[/\\]core[/\\](config|vault)\.ts$/.test(args.importer)?{path:'task-only-os',namespace:'task-only-os'}:undefined)
    builder.onLoad({filter:/.*/,namespace:'task-only-os'},()=>({contents:`export const homedir=()=>${JSON.stringify(fixture)};`,loader:'js'}))
    builder.onLoad({filter:/[/\\]core[/\\]keys\.ts$/},({path})=>({contents:"import {hkdfSync} from 'node:crypto'; export function loadOrCreateKey(){return Buffer.alloc(32,31)}; export function deriveKey(master,purpose){return Buffer.from(hkdfSync('sha256',master,Buffer.alloc(0),purpose,32))}",resolveDir:dirname(path),loader:'ts'}))
  }
}]})
const {SessionFilterStore,MappingTable,DEFAULT_CONFIG,saveSessionVault,loadSessionVault}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))
const base={...DEFAULT_CONFIG,categories:['EMAIL'],ollamaEnabled:false,heuristicNerEnabled:false,plugins:[],vaultEnabled:true,vaultTtlMinutes:120,fpe:{enabled:false},auditLog:{...DEFAULT_CONFIG.auditLog,enabled:false},providerOverrides:{}}
const socket=()=>new EventEmitter()
const req=(provider,id,sock=socket(),reset=false)=>({url:provider==='openai'?'/v1/chat/completions':'/v1/messages',method:'POST',headers:{...(id?{'x-pii-session-id':id}:{}),...(reset?{'x-pii-session-reset':'1'}:{})},socket:sock})
const register=(filter,label)=>{const original=label+'@example.test';const token=filter.getMappingTable().register(original,'EMAIL','EMAIL');return {original,token}}
const contains=(data,original)=>!!data&&Object.values(data.placeholderToOriginal).includes(original)
const outcomes=[]
function run(name,fn){try{fn();outcomes.push({name,result:'PASS'})}catch(error){outcomes.push({name,result:'FAIL',error:error.message})}}

run('default constructor applies startup provider override',()=>{
  const store=new SessionFilterStore()
  assert.equal(store.acquire(req('openai','startup')).isEnabled(),false)
  assert.equal(store.acquire(req('anthropic','startup')).isEnabled(),true)
  assert.equal(store.activeSessionCount(),2)
})
run('legacy bare-ID vault is ignored without provider fallback',()=>{
  const old=new MappingTable();const token=old.register('old.legacy@example.test','EMAIL','EMAIL')
  saveSessionVault('legacy-bare',old.toJSON())
  const store=new SessionFilterStore(base);const filter=store.acquire(req('anthropic','legacy-bare'))
  assert.equal(filter.getMappingTable().resolve(token),undefined)
  assert.equal(loadSessionVault('legacy-bare','anthropic'),null)
  assert.equal(contains(loadSessionVault('legacy-bare'),'old.legacy@example.test'),true)
})
run('colon/underscore raw IDs remain isolated on disk',()=>{
  const store=new SessionFilterStore(base);const a=socket(),b=socket()
  const first=register(store.acquire(req('anthropic','alias:id',a)),'colon')
  const second=register(store.acquire(req('anthropic','alias_id',b)),'underscore')
  a.emit('close');b.emit('close')
  const reloaded=new SessionFilterStore(base)
  assert.equal(reloaded.acquire(req('anthropic','alias:id')).getMappingTable().resolve(first.token),first.original)
  assert.equal(reloaded.acquire(req('anthropic','alias_id')).getMappingTable().resolve(second.token),second.original)
  assert.equal(contains(loadSessionVault('alias:id','anthropic'),second.original),false)
  assert.equal(contains(loadSessionVault('alias_id','anthropic'),first.original),false)
})
run('same ID is isolated across provider memory and vault',()=>{
  const store=new SessionFilterStore(base);const a=socket(),b=socket()
  const anth=store.acquire(req('anthropic','provider-shared',a)),open=store.acquire(req('openai','provider-shared',b))
  assert.notEqual(anth,open)
  const first=register(anth,'anthropic'),second=register(open,'openai')
  a.emit('close');b.emit('close')
  const reloaded=new SessionFilterStore(base)
  assert.equal(reloaded.acquire(req('anthropic','provider-shared')).getMappingTable().resolve(first.token),first.original)
  assert.equal(reloaded.acquire(req('openai','provider-shared')).getMappingTable().resolve(second.token),second.original)
  assert.equal(contains(loadSessionVault('provider-shared','anthropic'),second.original),false)
  assert.equal(contains(loadSessionVault('provider-shared','openai'),first.original),false)
})
run('same-socket resets replace close registration without listener growth',()=>{
  const store=new SessionFilterStore(base),sock=socket();let latest
  const old=register(store.acquire(req('anthropic','reset-same',sock)),'before-reset')
  for(let i=0;i<4;i++)latest=register(store.acquire(req('anthropic','reset-same',sock,true)),'after-reset-'+i)
  assert.equal(sock.listenerCount('close'),1);assert.equal(store.activeSessionCount(),1)
  sock.emit('close')
  assert.equal(contains(loadSessionVault('reset-same','anthropic'),old.original),false)
  assert.equal(contains(loadSessionVault('reset-same','anthropic'),latest.original),true)
})
run('other-socket stale close cannot resurrect reset entry',()=>{
  const store=new SessionFilterStore(base),oldSocket=socket(),newSocket=socket()
  const old=register(store.acquire(req('anthropic','reset-other',oldSocket)),'stale-reset')
  const fresh=register(store.acquire(req('anthropic','reset-other',newSocket,true)),'fresh-reset')
  oldSocket.emit('close');assert.equal(loadSessionVault('reset-other','anthropic'),null)
  newSocket.emit('close')
  assert.equal(contains(loadSessionVault('reset-other','anthropic'),old.original),false)
  assert.equal(contains(loadSessionVault('reset-other','anthropic'),fresh.original),true)
})
run('provider reset leaves other provider entry and vault intact',()=>{
  const store=new SessionFilterStore(base),otherSocket=socket()
  const other=store.acquire(req('openai','provider-reset',otherSocket));const saved=register(other,'other-provider')
  const selected=store.acquire(req('anthropic','provider-reset'));register(selected,'selected-provider')
  const fresh=store.acquire(req('anthropic','provider-reset',socket(),true))
  assert.notEqual(selected,fresh);assert.equal(store.acquire(req('openai','provider-reset')),other)
  otherSocket.emit('close');assert.equal(contains(loadSessionVault('provider-reset','openai'),saved.original),true)
})
run('clear prevents prior explicit close callbacks from persisting stale entry',()=>{
  const store=new SessionFilterStore(base),sock=socket();register(store.acquire(req('anthropic','cleared',sock)),'cleared')
  store.clear();sock.emit('close');assert.equal(store.activeSessionCount(),0);assert.equal(loadSessionVault('cleared','anthropic'),null)
})
run('memory TTL creates new restored entry and stale close cannot overwrite it',()=>{
  const originalNow=Date.now;let now=originalNow();Date.now=()=>now
  try{
    const store=new SessionFilterStore(base),oldSocket=socket(),freshSocket=socket()
    const oldFilter=store.acquire(req('anthropic','ttl',oldSocket)),saved=register(oldFilter,'ttl-original')
    now+=31*60*1000
    const newFilter=store.acquire(req('anthropic','ttl',freshSocket))
    assert.notEqual(newFilter,oldFilter);assert.equal(newFilter.getMappingTable().resolve(saved.token),saved.original)
    const stale=register(oldFilter,'ttl-stale-late')
    oldSocket.emit('close');assert.equal(contains(loadSessionVault('ttl','anthropic'),stale.original),false)
    freshSocket.emit('close');assert.equal(contains(loadSessionVault('ttl','anthropic'),saved.original),true)
  }finally{Date.now=originalNow}
})
run('reload disabling vault suppresses registered close save',()=>{
  const store=new SessionFilterStore(base),sock=socket();register(store.acquire(req('anthropic','disabled-close',sock)),'disabled-close')
  store.reload({...base,vaultEnabled:false});sock.emit('close');assert.equal(loadSessionVault('disabled-close','anthropic'),null)
})
run('reload preserves provider mappings while replacing effective enable policy',()=>{
  const store=new SessionFilterStore(base),sock=socket()
  const anth=store.acquire(req('anthropic','reload',sock)),open=store.acquire(req('openai','reload',sock))
  const first=register(anth,'reload-anthropic'),second=register(open,'reload-openai')
  store.reload({...base,providerOverrides:{openai:{enabled:false}}})
  assert.equal(store.acquire(req('anthropic','reload',sock)),anth);assert.equal(store.acquire(req('openai','reload',sock)),open)
  assert.equal(anth.isEnabled(),true);assert.equal(open.isEnabled(),false)
  assert.equal(anth.getMappingTable().resolve(first.token),first.original);assert.equal(open.getMappingTable().resolve(second.token),second.original)
  assert.equal(sock.listenerCount('close'),1)
})
run('provider socket reset does not remove other provider context',()=>{
  const store=new SessionFilterStore({...base,vaultEnabled:false}),sock=socket()
  const anth=store.acquire(req('anthropic',null,sock)),open=store.acquire(req('openai',null,sock))
  const saved=register(open,'socket-openai')
  const fresh=store.acquire(req('anthropic',null,sock,true))
  assert.notEqual(fresh,anth);assert.equal(store.acquire(req('openai',null,sock)),open)
  assert.equal(open.getMappingTable().resolve(saved.token),saved.original);assert.equal(store.activeSessionCount(),2)
  sock.emit('close');assert.equal(store.activeSessionCount(),0)
})
run('reset during vault-disabled reload invalidates previously persisted mapping',()=>{
  const store=new SessionFilterStore(base),sock=socket()
  const old=register(store.acquire(req('anthropic','disabled-reset',sock)),'previous-persisted');sock.emit('close')
  assert.equal(contains(loadSessionVault('disabled-reset','anthropic'),old.original),true)
  store.reload({...base,vaultEnabled:false});store.acquire(req('anthropic','disabled-reset',socket(),true))
  const restarted=new SessionFilterStore(base)
  assert.equal(restarted.acquire(req('anthropic','disabled-reset')).getMappingTable().resolve(old.token),undefined)
})
console.log(JSON.stringify({transport:'Actual SessionFilterStore and vault encryption/filesystem; EventEmitter sockets; isolated config path and synthetic key stub',existingKeyReads:0,externalApiCalls:0,outcomes},null,2))
if(outcomes.some(item=>item.result==='FAIL'))process.exitCode=1
} finally {
  if(savedFilterFlag===undefined)delete process.env.CLAUDE_PII_FILTER
  else process.env.CLAUDE_PII_FILTER=savedFilterFlag
  rmSync(fixture,{recursive:true,force:true})
  assert.equal(existsSync(fixture),false,'temporary fixture was not removed')
  console.log('Temporary fixture cleanup: PASS')
}
