import { createAgent } from './agent.js';
import { createEvolution } from './evolution.js';
import { ServiceError } from './engine.js';

// Connection credentials exist only in this process. Never serialize this closure.
export function createConnections({engine,store,fetchImpl=fetch}) {
  let ai={status:'unconfigured',model:''},wa={status:'unconfigured'},waSecret=null,changing=false;
  async function exclusive(fn){if(changing)throw new ServiceError('正在測試接駁，請稍候。',409);changing=true;try{return await fn();}finally{changing=false;}}
  const text=(x,max)=>{if(typeof x!=='string'||!x.trim()||x.length>max)throw new ServiceError('請填齊接駁資料。');return x.trim();};
  async function waRequest(action){
    if(!waSecret)throw new ServiceError('請先填寫 Evolution 服務資料。');
    try{
      const response=await fetchImpl(`${waSecret.url}/instance/${action}/${encodeURIComponent(waSecret.instance)}`,{redirect:'error',signal:AbortSignal.timeout(15000),headers:{apikey:waSecret.apiKey}});
      if(!response.ok)throw new Error();
      return await response.json();
    }catch{wa.status='error';throw new ServiceError('連線未成功。請檢查服務網址、連線名稱及金鑰，並確認 Evolution 正在運行。',502);}
  }
  return {
    status:()=>({ai:{...ai},whatsapp:{...wa}}),
    model:input=>exclusive(async()=>{
      const model=text(input.model,100),apiKey=text(input.apiKey,500);
      const candidate=createAgent({model,apiKey,fetchImpl});
      // A real structured response verifies both model access and the reply protocol.
      try{await candidate.reply({profile:{tone:'friendly'},facts:[],history:[{role:'user',content:'你好，我想了解服務。'}]});}
      catch{throw new ServiceError('AI 測試未成功。請檢查金鑰、模型名稱及帳戶額度；模型需支援 Responses 與結構化回覆。',502);}
      engine.agent=candidate;ai={status:'connected',model,checkedAt:Date.now()};store.revise();
      return {message:'AI 已通過實際回覆測試，可以到「訓練」教客服。'};
    }),
    clearAI:()=>exclusive(async()=>{engine.agent=createAgent();ai={status:'unconfigured',model:''};store.revise();}),
    whatsapp:input=>exclusive(async()=>{
      const url=text(input.url,500).replace(/\/$/,''),instance=text(input.instance,100);
      const apiKey=typeof input.apiKey==='string'&&input.apiKey.trim()?text(input.apiKey,500):waSecret?.url===url&&waSecret?.instance===instance?waSecret.apiKey:'';
      if(!apiKey)throw new ServiceError('請填寫接駁金鑰。');
      try{createEvolution({url,instance,apiKey});}catch{throw new ServiceError('請使用有效的 HTTPS 服務網址。本機 localhost 可使用 HTTP。');}
      waSecret={url,instance,apiKey};wa={status:'configured',url,instance};
      const data=await waRequest('connect');
      const qr=data.base64||data.qrcode?.base64;
      // Only provider PNG data is rendered. Never forward keys, pairing codes or arbitrary URLs.
      const safeQr=typeof qr==='string'&&qr.length<500000&&/^data:image\/png;base64,[A-Za-z0-9+/=\r\n]+$/.test(qr)?qr:null;
      const status=data.instance?.state==='open'?'open':safeQr?'connecting':'unknown';wa.status=status;
      return {qr:safeQr,status,message:status==='open'?'WhatsApp 裝置已連接；本機仍未開啟訊息收發。':safeQr?'請在 WhatsApp 的「已連結裝置」掃描，完成後按「檢查連線」。':'服務暫未提供二維碼。請檢查連線狀態，或重新取得二維碼。'};
    }),
    checkWhatsApp:()=>exclusive(async()=>{const data=await waRequest('connectionState');const state=data.instance?.state;wa.status=['open','close','connecting'].includes(state)?state:'unknown';wa.checkedAt=Date.now();return{status:wa.status,message:wa.status==='open'?'WhatsApp 裝置已連接；本機仍未開啟訊息收發。':wa.status==='close'?'手機尚未連接，請重新取得二維碼。':wa.status==='connecting'?'正在等待手機連接，請完成掃碼後再檢查。':'服務未回傳可確認的狀態。'};}),
    clearWhatsApp:()=>exclusive(async()=>{waSecret=null;wa={status:'unconfigured'};}),
  };
}
