import { timingSafeEqual } from 'node:crypto';

const json = (res,status,value) => {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(value));
};
const local = address => ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);
const equal = (a,b) => typeof a==='string' && Buffer.byteLength(a)===Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));

// Admission control is separate from business grants. Resuming an installation
// never changes receive/send consent, native-model verification or human state.
export function createManagedControl({token,releaseId,version,expectedAgentId,engine,store,shutdown,ingressPolicy='manual_pause'}) {
  if(typeof token!=='string'||token.length<32||token.length>256||typeof releaseId!=='string'||!/^[a-f0-9]{64}$/.test(releaseId)||typeof expectedAgentId!=='string'||!expectedAgentId||expectedAgentId.length>100)throw Error('INVALID_MANAGED_IDENTITY');
  let paused=true,ready=false,stopping=false,active=0,server=null;
  engine.pauseForUpdate();
  const busy=()=>active>0||engine.updateBusy()||Boolean(server?.managedWorkBusy?.());
  const status=()=>({pid:process.pid,release_id:releaseId,version,data_schema:7,database_schema:7,
    managed_schema:1,expected_agent_id:expectedAgentId,ready,paused,busy:busy(),
    active_requests:active,stopping,ingress:'retry_503',ingress_policy:ingressPolicy,node_version:process.version,bridge_managed:false});
  function attach(value){server=value;server.pauseManagedWork?.();}
  function enter(req,res){
    if(paused){res.setHeader('Retry-After','3');json(res,503,{error:'客服正在安全更新，請稍後重試。',code:'MANAGED_UPDATE_PAUSED'});return false;}
    active++;
    let done=false;
    // A disconnected browser does not cancel an awaited handler or its writes.
    // Only the handler's finally block can release admission accounting.
    return ()=>{if(!done){done=true;active--;}};
  }
  async function handle(req,res,path){
    if(path!=='/api/managed/internal')return false;
    if(!local(req.socket.remoteAddress)||req.headers.origin!==undefined||!equal(req.headers['x-blueprint-installer'],token)){
      json(res,404,{error:'找不到此操作。'});return true;
    }
    if(req.method==='GET'){json(res,200,status());return true;}
    if(req.method!=='POST'){json(res,405,{error:'不支援此操作。'});return true;}
    if(String(req.headers['content-type']||'').split(';')[0].trim()!=='application/json'){
      json(res,415,{error:'需要 JSON 格式。'});return true;
    }
    let input;
    try{
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>1024)throw Error();chunks.push(chunk);}
      input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!input||Array.isArray(input)||Object.keys(input).length!==1||!['quiesce','resume','shutdown'].includes(input.action))throw Error();
    }catch{json(res,400,{error:'更新控制內容不正確。'});return true;}
    if(input.action==='quiesce'){
      paused=true;engine.pauseForUpdate();server?.pauseManagedWork?.();json(res,200,status());
    }else if(input.action==='resume'){
      if(!ready||stopping){json(res,409,{error:'客服尚未就緒。'});return true;}
      paused=false;engine.resumeAfterUpdate();server?.resumeManagedWork?.();json(res,200,status());
    }else{
      if(!paused||busy()){json(res,409,{error:'仍有工作未完成，請先暫停並等待。',code:'MANAGED_UPDATE_BUSY'});return true;}
      if(!stopping){stopping=true;setImmediate(()=>void shutdown());}
      json(res,202,status());
    }
    return true;
  }
  return {status,handle,enter,attach,markReady(){ready=true;},isPaused:()=>paused,
    async drain(timeoutMs=70000){paused=true;engine.pauseForUpdate();server?.pauseManagedWork?.();const until=Date.now()+timeoutMs;while(busy()){if(Date.now()>until)throw Error('MANAGED_DRAIN_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,20));}},
    checkpoint(){if(!paused||busy())throw Error('MANAGED_UPDATE_BUSY');store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}};
}
