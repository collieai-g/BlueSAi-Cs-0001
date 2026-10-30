import { createHash, randomUUID } from 'node:crypto';
import { ServiceError } from './engine.js';

const sent = new Set(['accepted','delivered','read']);
const kinds = new Set(['fact','procedure','style']);
const factCategories = new Set(['general','hours','price','refund']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalized = value => String(value).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu,'');
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };

// These are deliberately bounded redactions, not a claim of perfect PII detection.
// The model and the owner must still reject individual cases as shared policy.
export function redactLearningText(value) {
  return String(value)
    .replace(/https?:\/\/[^\s<>]+/giu,'[已移除連結]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu,'[已移除電郵]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~-]{12,})\b/giu,'[已移除憑證]')
    .replace(/(?<![\p{L}\d])\+?\d[\d\s()+-]{6,}\d(?![\p{L}\d])/gu,'[已移除電話或識別碼]')
    .replace(/((?:訂單|運單|追蹤)(?:編號|號碼|號)?|order\s*(?:id|number|no\.?))\s*[:：#]?\s*[A-Z0-9][A-Z0-9_-]{3,}/giu,'$1[已移除識別碼]')
    .replace(/((?:收貨|送貨)?地址)\s*[:：]\s*[^。！？\n]{1,150}/gu,'$1：[已移除地址]')
    .replace(/(姓名|收件人|我叫)\s*[:：]?\s*[\p{L}·]{1,30}/gu,'$1[已移除姓名]');
}

export function createKnowledgeLearning({ store, engine, analysisTimeoutMs=65000, intervalMs=1000 }) {
  if(!Number.isInteger(analysisTimeoutMs)||analysisTimeoutMs<1||analysisTimeoutMs>65000||!Number.isInteger(intervalMs)||intervalMs<10)throw Error('INVALID_LEARNING_CONFIGURATION');
  let timer=null,started=false,stopped=false,epoch=0,active=null,scheduled=false,updatePaused=false;
  const manualQueue=new Set();
  const ready=()=>{
    const agent=engine.agent;
    if(!agent?.configured||typeof agent.analyzeConversation!=='function')return false;
    if(typeof agent.health==='function'){try{if(agent.health()?.status==='error')return false;}catch{return false;}}
    return true;
  };
  const settings=()=>({automaticAnalysis:parse(store.get("SELECT value FROM config WHERE key='knowledge_learning'")?.value,'')?.automaticAnalysis===true});
  const rawHash=row=>digest([row.id,row.conversation_id,row.channel,row.role,row.content,row.role==='user'?'input':sent.has(row.status)?'sent':row.status]);
  const rawMessage=id=>store.get(`SELECT m.*,c.channel FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=?`,id);
  const validSource=row=>Boolean(row&&['evolution','web'].includes(row.channel)&&row.role==='staff'&&sent.has(row.status));
  const snapshotOf=row=>parse(row.snapshot_json,null);
  function sourceStale(row) {
    const source=rawMessage(row.source_message_id),snapshot=snapshotOf(row);
    if(!validSource(source)||rawHash(source)!==row.source_digest||!snapshot||!Array.isArray(snapshot.messages)||!snapshot.hashes)return true;
    return snapshot.messages.some(message=>{
      const current=rawMessage(message.id);
      return !current||current.conversation_id!==row.conversation_id||!['evolution','web'].includes(current.channel)||rawHash(current)!==snapshot.hashes[message.id];
    });
  }
  function currentConflicts(proposal) {
    const facts=store.facts();
    return facts.filter(f=>f.id!==proposal.knowledge_id&&normalized(f.title)===normalized(proposal.title)&&normalized(f.content)!==normalized(proposal.content))
      .map(f=>({knowledgeId:f.id,title:f.title}));
  }
  function questionsFor(proposal,caseRow) {
    const questions=parse(proposal.questions_json,[]),snapshot=snapshotOf(caseRow);
    if(Number.isInteger(snapshot?.analysisRevision)&&snapshot.analysisRevision!==store.value('revision'))questions.push('分析後知識庫已有更新，請核對建議是否仍適用。');
    return [...new Set(questions)];
  }
  function caseSummary(row) {
    return {id:row.id,conversationId:row.conversation_id,status:row.status,sourceCount:snapshotOf(row)?.messages?.length||0,
      createdAt:row.created_at,analyzedAt:row.analyzed_at,lastError:row.error_code,errorCode:row.error_code};
  }
  function proposalSummary(row) {
    const caseRow=store.get('SELECT * FROM learning_cases WHERE id=?',row.case_id),snapshot=caseRow&&snapshotOf(caseRow);
    const evidenceMessageIds=parse(row.evidence_json,[]);
    return {id:row.id,caseId:row.case_id,kind:row.kind,title:row.title,content:row.content,category:row.category,rationale:row.rationale,
      evidenceMessageIds,evidence:(snapshot?.messages||[]).filter(m=>evidenceMessageIds.includes(m.id)).map(m=>({id:m.id,role:m.role,content:m.content.slice(0,200)})),
      questions:caseRow?questionsFor(row,caseRow):parse(row.questions_json,[]),status:row.status,knowledgeId:row.knowledge_id,
      createdAt:row.created_at,reviewedAt:row.reviewed_at,sourceStale:!caseRow||sourceStale(caseRow),conflicts:currentConflicts(row)};
  }
  function status() {
    const policy=settings();
    return {settings:policy,policy,model:{ready:ready(),provider:engine.agent?.provider||(engine.agent?.configured?'openai':'none')},available:ready(),
      limits:{caseLimit:200,visibleCases:100,visibleProposals:100,caseLimitReached:store.get('SELECT COUNT(*) n FROM learning_cases').n>=200},
      counts:{pendingCases:store.get("SELECT COUNT(*) n FROM learning_cases WHERE status='pending'").n,
        analyzingCases:store.get("SELECT COUNT(*) n FROM learning_cases WHERE status='analyzing'").n,
        failedCases:store.get("SELECT COUNT(*) n FROM learning_cases WHERE status='failed'").n,
        pendingProposals:store.get("SELECT COUNT(*) n FROM learning_proposals WHERE status='pending'").n,
        approvedProposals:store.get("SELECT COUNT(*) n FROM learning_proposals WHERE status='approved'").n},
      cases:store.all('SELECT * FROM learning_cases ORDER BY created_at DESC,rowid DESC LIMIT 100').map(caseSummary),
      proposals:store.all('SELECT * FROM learning_proposals ORDER BY created_at DESC,rowid DESC LIMIT 100').map(proposalSummary)};
  }
  function configure(input) {
    if(!input||typeof input.automaticAnalysis!=='boolean'||Object.keys(input).some(k=>!['automaticAnalysis','consent'].includes(k)))throw new ServiceError('請確認人工對話整理設定。');
    store.transaction(()=>{
      store.run('INSERT INTO config(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value','knowledge_learning',JSON.stringify({automaticAnalysis:input.automaticAnalysis}));
      store.audit('knowledge_learning_configured',input.automaticAnalysis?'automatic':'manual');
    });
    if(!input.automaticAnalysis&&active?.automatic)active.controller.abort('disabled');
    if(started)schedule();
    return status();
  }
  function collect() {
    if(stopped)throw new ServiceError('知識整理服務已停止。',409);
    const remaining=Math.max(0,200-store.get('SELECT COUNT(*) n FROM learning_cases').n);
    const rows=remaining?store.all(`SELECT m.*,c.channel FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE c.channel IN ('evolution','web') AND m.role='staff' AND m.status IN ('accepted','delivered','read')
      AND NOT EXISTS (SELECT 1 FROM learning_cases l WHERE l.source_message_id=m.id)
      ORDER BY m.created_at,m.rowid LIMIT ?`,Math.min(remaining,100)):[];
    const caseIds=[];
    store.transaction(()=>{
      for(const source of rows){
        const original=store.all(`SELECT m.*,c.channel FROM messages m JOIN conversations c ON c.id=m.conversation_id
          WHERE m.conversation_id=? AND m.rowid<=(SELECT rowid FROM messages WHERE id=?)
          AND (m.role='user' OR (m.role IN ('staff','assistant') AND m.status IN ('accepted','delivered','read')))
          ORDER BY m.rowid DESC LIMIT 20`,source.conversation_id,source.id).reverse();
        const messages=[],hashes={};let bytes=0;
        for(const message of original.reverse()){
          const safe={id:message.id,role:message.role,content:redactLearningText(message.content).slice(0,2000)};
          const size=Buffer.byteLength(JSON.stringify(safe));if(bytes+size>24000)break;
          messages.unshift(safe);hashes[message.id]=rawHash(message);bytes+=size;
        }
        const id=randomUUID();
        store.run('INSERT OR IGNORE INTO learning_cases(id,source_message_id,conversation_id,source_digest,snapshot_json,status,created_at) VALUES (?,?,?,?,?,?,?)',
          id,source.id,source.conversation_id,rawHash(source),JSON.stringify({messages,hashes,capturedAt:Date.now()}),'pending',Date.now());
        caseIds.push(id);store.audit('learning_case_collected',id);
      }
    });
    return {collected:caseIds.length,caseIds,limitReached:store.get('SELECT COUNT(*) n FROM learning_cases').n>=200};
  }
  function analyze(caseId) {
    if(stopped)throw new ServiceError('知識整理服務已停止。',409);
    const row=store.get('SELECT * FROM learning_cases WHERE id=?',caseId);
    if(!row)throw new ServiceError('找不到這段人工對話整理。',404);
    if(row.status==='analyzed')return {caseId,status:'analyzed',duplicate:true};
    if(row.status==='analyzing'||manualQueue.has(caseId))throw new ServiceError('這段對話正在分析，請稍候。',409);
    if(!ready())throw new ServiceError('模型尚未通過接駁，保留原對話，尚未進行 AI 分析。',409);
    if(sourceStale(row))throw new ServiceError('來源對話已變更，請重新核對，未交給模型。',409);
    store.run("UPDATE learning_cases SET status='pending',error_code=NULL WHERE id=?",caseId);
    manualQueue.add(caseId);schedule();
    return {caseId,status:'queued'};
  }
  function validateProposals(result,snapshot) {
    if(!result||typeof result!=='object'||Array.isArray(result)||Object.keys(result).some(k=>k!=='proposals')||!Array.isArray(result.proposals)||result.proposals.length>3)throw Error('LEARNING_INVALID_RESPONSE');
    const staffIds=new Set(snapshot.messages.filter(m=>m.role==='staff').map(m=>m.id));
    return result.proposals.map(p=>{
      if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['kind','title','content','category','rationale','evidenceMessageIds','questions'].includes(k))||
        !kinds.has(p.kind)||typeof p.title!=='string'||!p.title.trim()||p.title.length>100||typeof p.content!=='string'||!p.content.trim()||p.content.length>2000||
        typeof p.rationale!=='string'||!p.rationale.trim()||p.rationale.length>1000||!Array.isArray(p.questions)||p.questions.length>5||p.questions.some(q=>typeof q!=='string'||!q.trim()||q.length>300)||
        !Array.isArray(p.evidenceMessageIds)||!p.evidenceMessageIds.length||p.evidenceMessageIds.length>20||p.evidenceMessageIds.some(id=>!staffIds.has(id))||
        (p.kind==='procedure'?p.category!=='procedure':p.kind==='style'?p.category!=='style':!factCategories.has(p.category)))throw Error('LEARNING_INVALID_RESPONSE');
      const strings=[p.title,p.content,p.rationale,...p.questions];
      if(strings.some(text=>redactLearningText(text)!==text))throw Error('LEARNING_PRIVATE_OUTPUT');
      return {...p,title:p.title.trim(),content:p.content.trim(),rationale:p.rationale.trim(),evidenceMessageIds:[...new Set(p.evidenceMessageIds)],questions:p.questions.map(q=>q.trim())};
    });
  }
  function schedule() {
    if(stopped||scheduled||updatePaused)return;scheduled=true;
    queueMicrotask(()=>{scheduled=false;if(!stopped)void runNext().catch(()=>{});});
  }
  async function runNext() {
    if(stopped||active||updatePaused)return;
    let caseId=manualQueue.values().next().value;
    const automatic=!caseId;
    if(caseId)manualQueue.delete(caseId);
    if(!caseId&&started&&settings().automaticAnalysis&&ready())caseId=store.get("SELECT id FROM learning_cases WHERE status='pending' ORDER BY created_at,rowid LIMIT 1")?.id;
    if(!caseId)return;
    const row=store.get('SELECT * FROM learning_cases WHERE id=?',caseId);
    if(!row||!['pending','failed'].includes(row.status))return;
    if(!ready()||sourceStale(row)){
      store.run("UPDATE learning_cases SET status='failed',error_code=? WHERE id=?",ready()?'LEARNING_SOURCE_STALE':'LEARNING_MODEL_UNAVAILABLE',caseId);schedule();return;
    }
    const snapshot=snapshotOf(row),controller=new AbortController(),runEpoch=epoch,agent=engine.agent;
    snapshot.analysisRevision=store.value('revision');
    store.run("UPDATE learning_cases SET status='analyzing',error_code=NULL,snapshot_json=? WHERE id=?",JSON.stringify(snapshot),caseId);
    let releaseAbort;
    const aborted=new Promise((resolve,reject)=>{releaseAbort=()=>reject(Error(controller.signal.reason==='timeout'?'LEARNING_TIMEOUT':'LEARNING_INTERRUPTED'));controller.signal.addEventListener('abort',releaseAbort,{once:true});});
    const timeout=setTimeout(()=>controller.abort('timeout'),analysisTimeoutMs);
    active={caseId,controller,epoch:runEpoch,agent,automatic};
    const canTouch=()=>!stopped&&epoch===runEpoch;
    try{
      const knowledge=store.facts().map(f=>({id:f.id,title:f.title,content:f.content,category:f.category}));
      const output=Promise.resolve().then(()=>agent.analyzeConversation({messages:snapshot.messages.map(m=>({...m})),knowledge},{signal:controller.signal}));
      const result=await Promise.race([output,aborted]);
      if(!canTouch())return;
      // The output may have won Promise.race before the owner disabled learning,
      // while this continuation was still queued. Recheck the grant at save time.
      if(controller.signal.aborted)throw Error(controller.signal.reason==='disabled'?'LEARNING_DISABLED':controller.signal.reason==='timeout'?'LEARNING_TIMEOUT':'LEARNING_INTERRUPTED');
      if(automatic&&!settings().automaticAnalysis)throw Error('LEARNING_DISABLED');
      if(engine.agent!==agent)throw Error('LEARNING_PROVIDER_CHANGED');
      if(sourceStale(row))throw Error('LEARNING_SOURCE_STALE');
      const proposals=validateProposals(result,snapshot);
      store.transaction(()=>{
        let omitted=0;
        for(const p of proposals){
          // A new example retains its own case/provenance, but an unchanged
          // suggestion must not refill the review queue on every human reply.
          const prior=store.all('SELECT content FROM learning_proposals WHERE kind=? AND category=?',p.kind,p.category);
          if(prior.some(row=>normalized(row.content)===normalized(p.content))||store.facts().some(f=>f.category===p.category&&normalized(f.content)===normalized(p.content))){omitted++;continue;}
          store.run(`INSERT OR IGNORE INTO learning_proposals(id,case_id,kind,title,content,category,rationale,evidence_json,questions_json,proposal_digest,status,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,randomUUID(),caseId,p.kind,p.title,p.content,p.category,p.rationale,JSON.stringify(p.evidenceMessageIds),JSON.stringify(p.questions),digest([p.kind,normalized(p.title),normalized(p.content),p.category]),'pending',Date.now());
        }
        store.run("UPDATE learning_cases SET status='analyzed',analyzed_at=?,error_code=NULL WHERE id=?",Date.now(),caseId);
        store.audit('learning_analysis_completed',caseId);
        if(omitted)store.audit('learning_proposals_omitted',caseId+':'+omitted);
      });
    }catch(error){
      if(canTouch()){
        const code=engine.agent!==agent?'LEARNING_PROVIDER_CHANGED':controller.signal.reason==='disabled'?'LEARNING_DISABLED':error?.code==='CODEX_TIMEOUT'||error?.message==='CODEX_TIMEOUT'?'LEARNING_TIMEOUT':['LEARNING_DISABLED','LEARNING_TIMEOUT','LEARNING_INTERRUPTED','LEARNING_SOURCE_STALE','LEARNING_INVALID_RESPONSE','LEARNING_PRIVATE_OUTPUT'].includes(error?.message)?error.message:'LEARNING_ANALYSIS_FAILED';
        store.run("UPDATE learning_cases SET status='failed',error_code=? WHERE id=?",code,caseId);store.audit('learning_analysis_failed',caseId);
      }
    }finally{
      clearTimeout(timeout);controller.signal.removeEventListener('abort',releaseAbort);
      if(active?.epoch===runEpoch&&active.caseId===caseId)active=null;
      if(!stopped&&epoch===runEpoch)schedule();
    }
  }
  function approve(proposalId,input={}) {
    if(!input||input.confirmed!==true||Object.keys(input).some(k=>!['title','content','category','confirmed','reviewed'].includes(k)))throw new ServiceError('請明確確認這條共用記憶。');
    return store.transaction(()=>{
      const p=store.get('SELECT * FROM learning_proposals WHERE id=?',proposalId);
      if(!p)throw new ServiceError('找不到這條記憶建議。',404);
      if(p.status==='approved'&&p.knowledge_id&&store.get('SELECT id FROM knowledge WHERE id=?',p.knowledge_id))return {id:proposalId,knowledgeId:p.knowledge_id,approved:true,duplicate:true};
      if(p.status!=='pending')throw new ServiceError('這條建議已處理，請重新讀取。',409);
      const c=store.get('SELECT * FROM learning_cases WHERE id=?',p.case_id);
      if(!c||sourceStale(c))throw new ServiceError('來源對話已變更，不能採用舊建議。',409);
      const next={...p,title:input.title??p.title,content:input.content??p.content,category:input.category??p.category};
      if(typeof next.title!=='string'||!next.title.trim()||next.title.length>100||typeof next.content!=='string'||!next.content.trim()||next.content.length>2000||
        (next.kind==='procedure'?next.category!=='procedure':next.kind==='style'?next.category!=='style':!factCategories.has(next.category))||
        [next.title,next.content].some(text=>redactLearningText(text)!==text))throw new ServiceError('請核對共用記憶內容、類別及個人資料。');
      next.title=next.title.trim();next.content=next.content.trim();
      if((questionsFor(p,c).length||currentConflicts(next).length)&&input.reviewed!==true)throw new ServiceError('這條建議有待補充或衝突，請先核對並明確確認。',409);
      if(store.facts().some(f=>f.category===next.category&&normalized(f.content)===normalized(next.content)))throw new ServiceError('已有相同的已確認記憶，請整理重複建議。',409);
      if(store.get('SELECT COUNT(*) n FROM knowledge').n>=100)throw new ServiceError('已達 100 條知識，請先整理。');
      const knowledgeId=randomUUID(),now=Date.now();
      store.run('INSERT INTO knowledge VALUES (?,?,?,?,?,?,?)',knowledgeId,next.title,next.category,next.content,1,null,now);
      store.run("UPDATE learning_proposals SET title=?,content=?,category=?,status='approved',knowledge_id=?,reviewed_at=? WHERE id=?",next.title,next.content,next.category,knowledgeId,now,proposalId);
      store.revise();store.audit('learning_proposal_approved',proposalId);
      return {id:proposalId,knowledgeId,approved:true};
    });
  }
  function reject(proposalId) {
    const row=store.get('SELECT * FROM learning_proposals WHERE id=?',proposalId);
    if(!row)throw new ServiceError('找不到這條記憶建議。',404);
    if(row.status==='rejected')return {id:proposalId,rejected:true,duplicate:true};
    if(row.status!=='pending')throw new ServiceError('這條建議已採用，請在正式知識中管理。',409);
    store.transaction(()=>{store.run("UPDATE learning_proposals SET status='rejected',reviewed_at=? WHERE id=?",Date.now(),proposalId);store.audit('learning_proposal_rejected',proposalId);});
    return {id:proposalId,rejected:true};
  }
  function start() {
    if(started)return;started=true;stopped=false;
    const tick=()=>{if(stopped||updatePaused)return;try{if(active&&engine.agent!==active.agent)active.controller.abort('provider_changed');collect();schedule();}catch{}};
    timer=setInterval(tick,intervalMs);timer.unref();tick();
  }
  function stop() {
    if(stopped)return;stopped=true;started=false;epoch++;clearInterval(timer);timer=null;manualQueue.clear();
    if(active){
      if(!store.closed)store.run("UPDATE learning_cases SET status='failed',error_code='LEARNING_INTERRUPTED' WHERE id=? AND status='analyzing'",active.caseId);
      active.controller.abort('stop');
    }
  }
  store.run("UPDATE learning_cases SET status='failed',error_code='LEARNING_INTERRUPTED' WHERE status='analyzing'");
  return {status,configure,collect,analyze,approve,reject,start,stop,
    pauseForUpdate(){updatePaused=true;},resumeAfterUpdate(){updatePaused=false;schedule();},updateBusy:()=>Boolean(active)};
}
