import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync,spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { preflight,InstallJournal,validateBackupCoverage,manifest,digest } from '../src/install.js';
import { createBlueprintInstaller } from '../src/install-blueprint.js';

const fixture=JSON.parse(readFileSync(new URL('../integrations/blueprint/fixtures/host.json',import.meta.url),'utf8'));
const source={repository:'https://github.com/collieai-g/BlueSAi-Cs-0001',revision:'a'.repeat(40)};
const inspect=(extra={})=>preflight({host:structuredClone(fixture),sourceRevision:source.revision,...extra});
const receipt={receipt_id:'synthetic-host-backup',domain:'synthetic-sqlite',schema:2,checkpoint:'fixture-before-upgrade',coverage:['database','credentials','pending_jobs','merchant_settings'],readable_private_copy:true,restore_verified:true};
function journal(t) {
  const dir=mkdtempSync(resolve(tmpdir(),'bluesai-install-')),path=resolve(dir,'journal.sqlite'),value=new InstallJournal(path);
  const handles=[value];t.after(()=>{for(const handle of handles){try{handle.close();}catch{}}rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});});return {value,path,track:handle=>{handles.push(handle);return handle;}};
}
function begin(value) {return value.begin({operation_id:'shared-host-operation',preflight:inspect(),role:'owner'});}
function advance(value,row,phase,evidence={}) {return value.advance({operation_id:row.operation_id,expected_version:row.version,phase,evidence,role:'owner'});}

test('preflight is read-only, exact-source pinned and separates customer/provider capabilities',()=>{
  const before=JSON.stringify(fixture),result=inspect();
  assert.equal(result.status,'ready');assert.equal(result.fixture,true);assert.equal(result.read_only,true);assert.equal(JSON.stringify(fixture),before);
  assert.equal(result.capabilities.modes['web-chat'].status,'requires_setup');assert.equal(result.capabilities.modes.whatsapp.live_receipt,'not_verified');
  assert.equal(inspect({sourceRevision:'main'}).status,'blocked');assert.equal(inspect({mode:'unsupported-channel'}).status,'blocked');
  assert.ok(inspect({mode:'web-chat'}).required_setup.includes('EXPLICIT_WEB_CHAT_ENABLE_REQUIRED'));
  const noModel=inspect({mode:'whatsapp'});assert.equal(noModel.status,'requires_setup');assert.ok(noModel.required_setup.includes('LIVE_TEST_ACCOUNT_RECEIPT_NOT_VERIFIED'));
});
test('Sites management requires reviewed native renderer/API before any mutation',()=>{
  const host={...structuredClone(fixture),platform:'sites'};
  assert.equal(inspect({host}).status,'ready');
  const management=inspect({host,management:true});assert.equal(management.status,'blocked');
  assert.deepEqual(management.blockers,['NATIVE_MANAGEMENT_RENDERER_MISSING','SCOPED_MANAGEMENT_API_MISSING']);
  host.role='viewer';assert.ok(inspect({host}).blockers.includes('ADMIN_REQUIRED'));
  host.runtime.kind='workers-d1';assert.ok(inspect({host,mode:'whatsapp'}).blockers.includes('INDEPENDENT_NODE_RUNTIME_REQUIRED'));
});
test('preflight accepts only exact capability strings in arrays and safely blocks malformed evidence',()=>{
  for(const renderers of ['standard-other',{includes:true},['standard-other'],[null]]) {
    const result=inspect({host:{...fixture,renderers},management:true});assert.equal(result.status,'blocked');assert.ok(result.blockers.includes('STANDARD_RENDERER_REQUIRED'));
  }
  for(const apis of ['blueprint-agent/10',{includes:true},['blueprint-agent/10'],[1]]) {
    const result=inspect({host:{...fixture,apis},management:true});assert.equal(result.status,'blocked');assert.ok(result.blockers.includes('BLUEPRINT_AGENT_API_REQUIRED'));
  }
});
test('D1 receipt cannot cover external SQLite; scope, schema, checkpoint, copy and restore are all required',()=>{
  const required=fixture.required_data;
  assert.equal(validateBackupCoverage(required,[receipt]).valid,true);
  for(const altered of [{...receipt,domain:'host-d1'},{...receipt,schema:1},{...receipt,checkpoint:'old'},{...receipt,readable_private_copy:false},{...receipt,restore_verified:false},{...receipt,coverage:['database']}])assert.equal(validateBackupCoverage(required,[altered]).valid,false);
  for(const malformed of [null,1,[],false])assert.throws(()=>validateBackupCoverage(required,[malformed]),{code:'INVALID_BACKUP_RECEIPT'});
  assert.throws(()=>validateBackupCoverage([null],[receipt]),{code:'INVALID_BACKUP_COVERAGE'});
});
test('shared journal reuses operation and plan; conflicting retry cannot overwrite it',t=>{
  const {value}=journal(t),one=begin(value);
  assert.deepEqual(begin(value),one);
  assert.equal(value.begin({operation_id:'second-copy',preflight:inspect(),role:'owner'}).operation_id,one.operation_id);
  assert.throws(()=>value.begin({operation_id:one.operation_id,preflight:inspect({management:true,host:{...fixture,platform:'standalone'}}),role:'owner'}),{code:'OPERATION_ID_CONFLICT'});
  assert.equal(value.get(one.operation_id).version,1);
});
test('journal CAS rejects stale concurrent coordinator writes and uses the same backup receipt',t=>{
  const {value}=journal(t),one=begin(value),plan=advance(value,one,'plan');
  assert.throws(()=>advance(value,one,'plan'),{code:'VERSION_CONFLICT'});
  assert.throws(()=>advance(value,plan,'backup_gate',{backup_receipts:[{...receipt,domain:'d1'}]}),{code:'BACKUP_COVERAGE_MISSING'});
  assert.equal(value.get(one.operation_id).phase,'plan');
  const backed=advance(value,plan,'backup_gate',{backup_receipts:[receipt]});assert.equal(backed.evidence.backup_gate.backup_receipts[0].receipt_id,receipt.receipt_id);
});
test('journal preserves wait/resume, phases and same-ID evidence across restart',t=>{
  const {value,path,track}=journal(t);let row=begin(value);row=advance(value,row,'plan');row=advance(value,row,'waiting_user',{reason:'native user submission pending'});
  assert.throws(()=>advance(value,row,'apply'),{code:'INVALID_RESUME_STAGE'});
  value.close();const restarted=track(new InstallJournal(path));
  row=restarted.get(row.operation_id);assert.equal(row.phase,'waiting_user');row=advance(restarted,row,'plan');row=advance(restarted,row,'backup_gate',{backup_receipts:[receipt]});row=advance(restarted,row,'apply');row=advance(restarted,row,'register_or_update',{agent_id:'same-agent'});row=advance(restarted,row,'verify');
  assert.throws(()=>advance(restarted,row,'complete'),{code:'READBACK_VERIFICATION_REQUIRED'});
  row=advance(restarted,row,'complete',{verified:true,agent_id:'same-agent'});assert.equal(row.evidence.complete.agent_id,'same-agent');
});
test('journal refuses permission bypass, credentials, unsupported preflight and newer schema',t=>{
  const {value,path}=journal(t),row=begin(value);
  assert.throws(()=>value.begin({operation_id:'no',preflight:inspect(),role:'viewer'}),{code:'ADMIN_REQUIRED'});
  assert.throws(()=>value.begin({operation_id:'blocked',preflight:inspect({mode:'unsupported-channel'}),role:'owner'}),{code:'PREFLIGHT_NOT_READY'});
  assert.throws(()=>advance(value,row,'plan',{apiKey:'never-store'}),{code:'CREDENTIALS_NOT_ALLOWED'});
  assert.throws(()=>new InstallJournal(resolve('private-journal.sqlite')),{code:'JOURNAL_MUST_BE_PRIVATE'});
  assert.throws(()=>new InstallJournal(resolve('..private/install.sqlite')),{code:'JOURNAL_MUST_BE_PRIVATE'});
  value.close();const db=new DatabaseSync(path);db.exec('PRAGMA user_version=99');db.close();assert.throws(()=>new InstallJournal(path),{code:'NEWER_INSTALL_SCHEMA'});
});

function hostClient() {
  let record=null,posts=0,patches=0;
  const identity={target_id:fixture.target_id,role:'owner'};
  const request=async(method,path,input)=>{
    if(method==='GET'&&path.startsWith('/api/studio/agents?'))return {agents:record?[{id:record.id,manifest:{id:record.manifest.id}}]:[],total:record?1:0};
    if(method==='GET'&&record&&path.endsWith('/'+record.id))return {agent:structuredClone(record)};
    if(method==='POST') {posts++;record={id:'same-agent',version:1,manifest:structuredClone(input.manifest),source:structuredClone(input.source),settings:{merchant_name:'',reply_tone:'friendly',...input.settings},connection_state:'added'};return {agent:structuredClone(record)};}
    if(method==='PATCH') {if(input.expected_version!==record.version)throw Object.assign(new Error('conflict'),{status:409});patches++;record={...record,settings:input.settings,version:record.version+1};return {agent:structuredClone(record)};}
    throw new Error('unexpected request');
  };
  return {request,getTargetIdentity:async()=>structuredClone(identity),identity,get record(){return record;},get posts(){return posts;},get patches(){return patches;}};
}
test('valid native manifest registers once; repeat reuses same ID with blank optional merchant data',async()=>{
  const host=hostClient(),installer=createBlueprintInstaller({request:host.request,getTargetIdentity:host.getTargetIdentity});
  const input={source,inspection:inspect(),role:'owner'};
  const one=await installer.ensure(input),two=await installer.ensure(input);
  assert.equal(one.agent_id,two.agent_id);assert.equal(two.settings.merchant_name,'');assert.equal(host.posts,1);assert.equal(host.patches,0);assert.equal(two.host_deployment_required,false);
  const changed=await installer.ensure({...input,settings:{reply_tone:'formal'}});assert.equal(changed.settings.reply_tone,'formal');assert.equal(changed.settings.merchant_name,'');assert.equal(host.patches,1);
});
test('registration checks permissions, source pin, content readback and avoids duplicate upgrade cards',async()=>{
  const host=hostClient(),installer=createBlueprintInstaller({request:host.request,getTargetIdentity:host.getTargetIdentity}),input={source,inspection:inspect(),role:'owner'};
  host.identity.role='viewer';await assert.rejects(installer.ensure(input),{code:'ADMIN_REQUIRED'});assert.equal(host.posts,0);host.identity.role='owner';
  await assert.rejects(installer.ensure({...input,source:{...source,revision:'main'}}),{code:'SOURCE_PIN_MISMATCH'});
  await installer.ensure(input);host.record.manifest.version='0.1.0';
  await assert.rejects(installer.ensure(input),{code:'HOST_PACKAGE_UPGRADE_REQUIRED'});assert.equal(host.posts,1);
  host.record.manifest.version=manifest.version;host.record.manifest.instructions='modified';await assert.rejects(installer.ensure(input),{code:'MANIFEST_CONTENT_MISMATCH'});
});
test('registration binds target and role to authenticated context and rechecks immediately before mutation',async()=>{
  const host=hostClient(),input={source,inspection:inspect(),role:'owner'};
  assert.throws(()=>createBlueprintInstaller({request:host.request}),{code:'AUTHENTICATED_TARGET_IDENTITY_REQUIRED'});
  host.identity.target_id='different-company';
  const installer=createBlueprintInstaller({request:host.request,getTargetIdentity:host.getTargetIdentity});
  await assert.rejects(installer.ensure(input),{code:'AUTHENTICATED_TARGET_MISMATCH'});assert.equal(host.posts,0);
  host.identity.target_id=fixture.target_id;let calls=0;
  const switched=createBlueprintInstaller({request:host.request,getTargetIdentity:async()=>({target_id:++calls===1?fixture.target_id:'different-company',role:'owner'})});
  await assert.rejects(switched.ensure(input),{code:'AUTHENTICATED_TARGET_MISMATCH'});assert.equal(host.posts,0);
});
test('registration readback must match independent requested settings even if server ignores POST or PATCH',async()=>{
  const host=hostClient(),input={source,inspection:inspect()};
  const ignoredPost=createBlueprintInstaller({getTargetIdentity:host.getTargetIdentity,request:(method,path,data)=>host.request(method,path,method==='POST'?{...data,settings:{}}:data)});
  await assert.rejects(ignoredPost.ensure({...input,settings:{merchant_name:'Requested merchant'}}),{code:'REGISTRATION_READBACK_MISMATCH'});
  assert.equal(host.record.settings.merchant_name,'');
  const ignoredPatch=createBlueprintInstaller({getTargetIdentity:host.getTargetIdentity,request:(method,path,data)=>host.request(method==='PATCH'?'GET':method,path,data)});
  await assert.rejects(ignoredPatch.ensure({...input,settings:{reply_tone:'formal'}}),{code:'REGISTRATION_READBACK_MISMATCH'});
  const installer=createBlueprintInstaller({request:host.request,getTargetIdentity:host.getTargetIdentity});
  const normalized=await installer.ensure({...input,settings:{merchant_name:'  Requested merchant  '}});assert.equal(normalized.settings.merchant_name,'Requested merchant');
  await assert.rejects(installer.ensure({...input,settings:{unknown_setting:true}}),{code:'INVALID_AGENT_SETTINGS'});
});
test('manifest matches pinned connected_client contract and contains no credentials or executable renderer',()=>{
  assert.deepEqual(Object.keys(manifest).sort(),['adapter','contract_version','description','id','instructions','name','operations','settings','ui','version'].sort());
  assert.equal(manifest.id,'bluesai-cs-0001');assert.match(manifest.name,/BlueSAi-Cs-#0001/);assert.equal(manifest.contract_version,1);assert.equal(manifest.adapter,'connected_client');assert.equal(manifest.ui.layout,'standard');
  for(const field of [...manifest.settings,...manifest.operations.flatMap(op=>op.input_fields)])assert.ok(['text','textarea','select','boolean'].includes(field.type));
  assert.equal(manifest.settings.find(f=>f.key==='merchant_name').default,'');assert.equal(digest(manifest).length,64);
});
test('preview build hashes exact clean Git source and rejects dirty or overwritten artifacts',t=>{
  const parent=mkdtempSync(resolve(tmpdir(),'bluesai-package-')),repo=resolve(parent,'repo'),output=resolve(parent,'release');mkdirSync(resolve(repo,'tools'),{recursive:true});mkdirSync(resolve(repo,'integrations/blueprint'),{recursive:true});
  t.after(()=>rmSync(parent,{recursive:true,force:true,maxRetries:10,retryDelay:50}));
  writeFileSync(resolve(repo,'tools/package-release.js'),readFileSync(new URL('../tools/package-release.js',import.meta.url)));
  writeFileSync(resolve(repo,'package.json'),' {"type":"module"}\n');writeFileSync(resolve(repo,'integrations/blueprint/package.json'),readFileSync(new URL('../integrations/blueprint/package.json',import.meta.url)));writeFileSync(resolve(repo,'sample.txt'),'synthetic source\n');
  const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init');git('-c','core.autocrlf=false','add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','synthetic fixture');
  const run=target=>spawnSync(process.execPath,['tools/package-release.js','--output',target],{cwd:repo,encoding:'utf8'});
  const inRepo=resolve(repo,'..private/release');assert.equal(run(inRepo).status,1);assert.equal(existsSync(inRepo),false);
  assert.equal(run(output).status,0);const result=JSON.parse(readFileSync(resolve(output,'release.json'),'utf8'));
  assert.equal(result.source.revision,git('rev-parse','HEAD'));assert.equal(result.channel,'preview');
  const sha256=x=>createHash('sha256').update(x).digest('hex');assert.equal(result.artifacts[0].sha256,sha256(readFileSync(resolve(output,'source.tar'))));assert.equal(result.inventory.find(f=>f.path==='sample.txt').sha256,sha256('synthetic source\n'));
  assert.equal(run(output).status,1);writeFileSync(resolve(repo,'sample.txt'),'changed\n');const second=resolve(parent,'dirty-release');assert.equal(run(second).status,1);assert.equal(existsSync(second),false);
});
