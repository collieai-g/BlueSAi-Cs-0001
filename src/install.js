import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const integrationPackage = JSON.parse(readFileSync(new URL('../integrations/blueprint/package.json', import.meta.url), 'utf8'));
export const manifest = JSON.parse(readFileSync(new URL('../integrations/blueprint/agent.json', import.meta.url), 'utf8'));
const canonical = value => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(v=>JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(canonical(value[k]))])) : value);
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export class InstallError extends Error { constructor(code, status=400) { super(code); this.code=code; this.status=status; } }
const requireValue = (condition, code, status=400) => { if(!condition) throw new InstallError(code,status); };
const commit = value => typeof value==='string' && /^[a-f0-9]{40}$/.test(value);
const authorized = role => requireValue(['owner','admin'].includes(role),'ADMIN_REQUIRED',403);
const clone = value => JSON.parse(JSON.stringify(value));
const stringList = value => Array.isArray(value)&&value.every(item=>typeof item==='string');
const dataCoverage = value => Array.isArray(value)&&value.every(d=>d&&typeof d==='object'&&!Array.isArray(d)&&typeof d.domain==='string'&&d.domain&&Number.isInteger(d.schema)&&d.schema>=0&&typeof d.checkpoint==='string'&&d.checkpoint&&stringList(d.coverage)&&d.coverage.every(Boolean));

// Pure inspection: this function never opens a store, registers, backs up or writes.
export function preflight({host, mode='collaboration', sourceRevision, management=false}={}) {
  const blockers=[], requiredSetup=[];
  const check=(ok,code)=>{if(!ok)blockers.push(code);};
  check(commit(sourceRevision),'FULL_SOURCE_COMMIT_REQUIRED');
  check(Boolean(host && typeof host==='object'),'HOST_EVIDENCE_REQUIRED');
  host=host||{};
  check(typeof host.target_id==='string'&&Boolean(host.target_id),'TARGET_ID_REQUIRED');
  check(['owner','admin'].includes(host.role),'ADMIN_REQUIRED');
  check(['native','sites','standalone'].includes(host.platform),'UNSUPPORTED_PLATFORM');
  check(host.required_data===undefined||dataCoverage(host.required_data),'INVALID_DATA_COVERAGE_EVIDENCE');
  check(Object.hasOwn(integrationPackage.modes,mode),'UNSUPPORTED_MODE');
  if(host.platform!=='standalone') {
    check(stringList(host.renderers),'INVALID_RENDERER_CAPABILITIES');
    check(stringList(host.apis),'INVALID_API_CAPABILITIES');
    const renderers=stringList(host.renderers)?host.renderers:[],apis=stringList(host.apis)?host.apis:[];
    check(host.agent_contract===1,'BLUEPRINT_AGENT_1_REQUIRED');
    check(renderers.includes('standard'),'STANDARD_RENDERER_REQUIRED');
    check(apis.includes('blueprint-agent/1'),'BLUEPRINT_AGENT_API_REQUIRED');
    check(commit(host.source?.revision),'HOST_SOURCE_COMMIT_REQUIRED');
  }
  if(management && host.platform!=='standalone') {
    check(stringList(host.renderers)&&host.renderers.includes('bluesai-management/1'),'NATIVE_MANAGEMENT_RENDERER_MISSING');
    check(stringList(host.apis)&&host.apis.includes('bluesai-management-api/1'),'SCOPED_MANAGEMENT_API_MISSING');
  }
  if(['whatsapp','web-chat'].includes(mode)) {
    const runtime=host.runtime||{};
    check(['external-node','standalone-node'].includes(runtime.kind),'INDEPENDENT_NODE_RUNTIME_REQUIRED');
    check(/^24\.(?:2[2-9]|[3-9]\d|\d{3,})\.\d+$/.test(runtime.node_version||''),'NODE_24_22_REQUIRED');
    check(runtime.persistent_storage===true,'PERSISTENT_STORAGE_REQUIRED');
    if(mode==='whatsapp') {
      if(runtime.public_https!==true)requiredSetup.push('PUBLIC_HTTPS_WEBHOOK_REQUIRED');
      if(runtime.provider_configured!==true)requiredSetup.push('EVOLUTION_ACCOUNT_SETUP_REQUIRED');
      if(runtime.webhook_configured!==true)requiredSetup.push('AUTHENTICATED_WEBHOOK_SETUP_REQUIRED');
      if(runtime.delivery_enabled!==true)requiredSetup.push('EXPLICIT_DELIVERY_ENABLE_REQUIRED');
    } else {
      if(runtime.public_https!==true)requiredSetup.push('PUBLIC_HTTPS_GUEST_ENTRY_REQUIRED');
      if(runtime.web_chat_enabled!==true)requiredSetup.push('EXPLICIT_WEB_CHAT_ENABLE_REQUIRED');
    }
    // A model is optional for human replies; sustained automatic AI requires one.
    if(runtime.live_test_receipt!==true)requiredSetup.push('LIVE_TEST_ACCOUNT_RECEIPT_NOT_VERIFIED');
  }
  const plan={package_id:integrationPackage.id,package_version:integrationPackage.version,source_revision:sourceRevision||null,target_id:host.target_id||null,platform:host.platform||null,mode,management:Boolean(management),required_data:host.required_data||[]};
  return {schema_version:1,read_only:true,status:blockers.length?'blocked':requiredSetup.length?'requires_setup':'ready',blockers,required_setup:requiredSetup,plan,plan_digest:digest(plan),capabilities:clone(integrationPackage),fixture:host.fixture===true,evidence_scope:'Supplied capability evidence only; no live host or provider validation performed.'};
}

export function validateBackupCoverage(requiredData, receipts) {
  requireValue(dataCoverage(requiredData)&&Array.isArray(receipts),'INVALID_BACKUP_COVERAGE');
  requireValue(receipts.every(r=>r&&typeof r==='object'&&!Array.isArray(r)),'INVALID_BACKUP_RECEIPT');
  const missing=[];
  for(const required of requiredData) {
    const receipt=receipts.find(r=>r.domain===required.domain && r.schema===required.schema && r.checkpoint===required.checkpoint && r.readable_private_copy===true && r.restore_verified===true && typeof r.receipt_id==='string' && r.receipt_id && Array.isArray(r.coverage) && required.coverage.every(item=>r.coverage.includes(item)));
    if(!receipt)missing.push(required.domain);
  }
  return {valid:missing.length===0,missing_domains:missing,receipt_ids:receipts.filter(r=>r?.receipt_id).map(r=>r.receipt_id),verification:'receipt_fields_only'};
}

const stages=['preflight','plan','backup_gate','apply','register_or_update','verify','complete'];
function safeEvidence(value) {
  requireValue(value&&typeof value==='object'&&!Array.isArray(value),'INVALID_EVIDENCE');
  const scan=x=>{if(!x||typeof x!=='object')return;for(const [key,v] of Object.entries(x)){requireValue(!/token|password|secret|api.?key|authorization|cookie/i.test(key),'CREDENTIALS_NOT_ALLOWED');scan(v);}};
  scan(value);requireValue(Buffer.byteLength(JSON.stringify(value))<=65536,'EVIDENCE_TOO_LARGE');return clone(value);
}
function outsideRepository(path) {
  const root=realpathSync(fileURLToPath(new URL('../',import.meta.url)));
  let parent=resolve(path);while(!existsSync(parent)){const next=dirname(parent);requireValue(next!==parent,'PRIVATE_PARENT_REQUIRED');parent=next;}
  const resolved=resolve(realpathSync(parent),relative(parent,resolve(path)));
  const rel=relative(root,resolved);requireValue(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel),'JOURNAL_MUST_BE_PRIVATE');
}

// The host coordinator owns this private journal. It does not touch merchant DBs.
export class InstallJournal {
  constructor(path) {
    requireValue(typeof path==='string'&&isAbsolute(path),'ABSOLUTE_PRIVATE_JOURNAL_REQUIRED');outsideRepository(path);
    this.db=new DatabaseSync(path);
    const version=this.db.prepare('PRAGMA user_version').get().user_version;
    if(version>1){this.db.close();throw new InstallError('NEWER_INSTALL_SCHEMA');}
    try {
      this.db.exec('BEGIN IMMEDIATE');
      if(version===0)this.db.exec(`CREATE TABLE install_operations(operation_id TEXT PRIMARY KEY,target_id TEXT NOT NULL,plan_digest TEXT NOT NULL,document TEXT NOT NULL,version INTEGER NOT NULL,UNIQUE(target_id,plan_digest)); PRAGMA user_version=1;`);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');this.db.close();throw error;}
  }
  close(){this.db.close();}
  get(operationId){const row=this.db.prepare('SELECT document FROM install_operations WHERE operation_id=?').get(operationId);return row?JSON.parse(row.document):null;}
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  begin({operation_id,preflight:inspection,role}) {
    authorized(role);requireValue(typeof operation_id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(operation_id),'INVALID_OPERATION_ID');
    requireValue(inspection?.read_only===true&&inspection.status==='ready','PREFLIGHT_NOT_READY');
    requireValue(digest(inspection.plan)===inspection.plan_digest,'PLAN_DIGEST_MISMATCH');
    requireValue(commit(inspection.plan.source_revision),'FULL_SOURCE_COMMIT_REQUIRED');
    return this.transaction(()=>{
      const old=this.get(operation_id);
      if(old){requireValue(old.plan_digest===inspection.plan_digest,'OPERATION_ID_CONFLICT',409);return old;}
      const same=this.db.prepare('SELECT document FROM install_operations WHERE target_id=? AND plan_digest=?').get(inspection.plan.target_id,inspection.plan_digest);
      if(same)return JSON.parse(same.document);
      const row={operation_id,target_id:inspection.plan.target_id,plan:clone(inspection.plan),plan_digest:inspection.plan_digest,phase:'preflight',version:1,evidence:{},resume_phase:null};
      this.db.prepare('INSERT INTO install_operations VALUES(?,?,?,?,?)').run(operation_id,row.target_id,row.plan_digest,JSON.stringify(row),1);return row;
    });
  }
  advance({operation_id,expected_version,phase,evidence={},role}) {
    authorized(role);const clean=safeEvidence(evidence);
    return this.transaction(()=>{
      const old=this.get(operation_id);requireValue(old,'OPERATION_NOT_FOUND',404);requireValue(old.version===expected_version,'VERSION_CONFLICT',409);
      const next=clone(old);
      if(phase==='waiting_user') {
        requireValue(old.phase!=='complete'&&old.phase!=='waiting_user','INVALID_STAGE_TRANSITION',409);
        next.resume_phase=old.phase;
      } else if(old.phase==='waiting_user') {
        requireValue(phase===old.resume_phase,'INVALID_RESUME_STAGE',409);next.resume_phase=null;
      } else {
        requireValue(stages.indexOf(phase)===stages.indexOf(old.phase)+1,'INVALID_STAGE_TRANSITION',409);
        if(phase==='backup_gate')requireValue(validateBackupCoverage(old.plan.required_data,clean.backup_receipts||[]).valid,'BACKUP_COVERAGE_MISSING',409);
        if(phase==='complete')requireValue(clean.verified===true,'READBACK_VERIFICATION_REQUIRED',409);
      }
      next.phase=phase;next.version++;next.evidence[phase]=clean;
      this.db.prepare('UPDATE install_operations SET document=?,version=? WHERE operation_id=? AND version=?').run(JSON.stringify(next),next.version,operation_id,expected_version);
      return next;
    });
  }
}
