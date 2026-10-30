import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync,existsSync,realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve,dirname,basename } from 'node:path';
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
  let record=null,posts=0,patches=0;const upgrades=new Map(),requests=[];
  const identity={target_id:fixture.target_id,role:'owner'};
  const request=async(method,path,input)=>{
    requests.push({method,path,input:structuredClone(input)});
    if(method==='GET'&&path.startsWith('/api/studio/agents?'))return {agents:record?[{id:record.id,manifest:{id:record.manifest.id}}]:[],total:record?1:0};
    if(method==='GET'&&record&&path.endsWith('/'+record.id))return {agent:structuredClone(record)};
    if(method==='POST') {posts++;record={id:'same-agent',version:1,manifest:structuredClone(input.manifest),source:structuredClone(input.source),settings:{merchant_name:'',reply_tone:'friendly',...input.settings},connection_state:'added'};return {agent:structuredClone(record)};}
    if(method==='PATCH') {
      if(input.manifest) {
        const intent=digest({manifest:input.manifest,source:input.source,settings:input.settings||{}}),receipt=upgrades.get(input.upgrade_key);
        if(receipt){if(receipt.intent!==intent)throw Object.assign(new Error('conflict'),{code:'UPGRADE_KEY_CONFLICT',status:409});return {agent:structuredClone(receipt.agent)};}
        if(input.expected_version!==record.version)throw Object.assign(new Error('conflict'),{status:409});
        patches++;record={...record,manifest:structuredClone(input.manifest),source:structuredClone(input.source),settings:{...record.settings,...input.settings},version:record.version+1};
        upgrades.set(input.upgrade_key,{intent,agent:structuredClone(record)});return {agent:structuredClone(record)};
      }
      if(input.expected_version!==record.version)throw Object.assign(new Error('conflict'),{status:409});patches++;record={...record,settings:input.settings,version:record.version+1};return {agent:structuredClone(record)};
    }
    throw new Error('unexpected request');
  };
  return {request,getTargetIdentity:async()=>structuredClone(identity),identity,requests,get record(){return record;},get posts(){return posts;},get patches(){return patches;}};
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
async function upgradeFixture() {
  const host=hostClient(),installer=createBlueprintInstaller({request:host.request,getTargetIdentity:host.getTargetIdentity});
  await installer.ensure({source,inspection:inspect(),settings:{merchant_name:'Synthetic merchant'}});
  host.record.manifest.version='0.3.0';host.record.source.revision='b'.repeat(40);
  host.record.enabled=false;host.record.connection_state='connected';host.record.history=[{id:'synthetic-job',source:structuredClone(host.record.source)}];
  return {host,installer,input:{source,inspection:inspect(),expected_agent_id:'same-agent',upgrade_key:'synthetic-upgrade-1'}};
}
test('explicit package upgrade keeps the same Agent, retained settings and state, and retries the same intent once',async()=>{
  const {host,installer,input}=await upgradeFixture(),history=structuredClone(host.record.history);
  const requested={...input,settings:{reply_tone:'formal'}};
  const one=await installer.ensure(requested),two=await installer.ensure(requested);
  assert.equal(one.agent_id,'same-agent');assert.equal(two.agent_id,'same-agent');assert.equal(host.posts,1);assert.equal(host.patches,1);
  assert.equal(two.settings.merchant_name,'Synthetic merchant');assert.equal(two.settings.reply_tone,'formal');
  assert.equal(host.record.enabled,false);assert.equal(two.connection_state,'connected');assert.deepEqual(host.record.history,history);
  const patches=host.requests.filter(row=>row.method==='PATCH');assert.equal(patches.length,2);
  for(const {input:patch} of patches){assert.equal(patch.upgrade_key,input.upgrade_key);assert.deepEqual(patch.settings,{reply_tone:'formal'});assert.equal(Object.hasOwn(patch,'enabled'),false);}
});
test('explicit upgrade requires both target and key and never creates a missing or different target',async()=>{
  const host=hostClient(),installer=createBlueprintInstaller({request:host.request,getTargetIdentity:host.getTargetIdentity}),input={source,inspection:inspect()};
  for(const options of [{expected_agent_id:'same-agent'},{upgrade_key:'key'},{expected_agent_id:'same-agent',upgrade_key:'not a key'}])await assert.rejects(installer.ensure({...input,...options}),{code:'EXPLICIT_UPGRADE_TARGET_AND_KEY_REQUIRED'});
  await assert.rejects(installer.ensure({...input,expected_agent_id:'same-agent',upgrade_key:'key'}),{code:'EXPECTED_AGENT_NOT_FOUND'});assert.equal(host.posts,0);
  const ready=await upgradeFixture();
  await assert.rejects(ready.installer.ensure({...ready.input,expected_agent_id:'different-agent'}),{code:'EXPECTED_AGENT_MISMATCH'});assert.equal(ready.host.patches,0);assert.equal(ready.host.posts,1);
  const multiple=createBlueprintInstaller({getTargetIdentity:ready.host.getTargetIdentity,request:(method,path,data)=>path.includes('?')?{agents:[{id:'same-agent',manifest:{id:manifest.id}},{id:'second',manifest:{id:manifest.id}}],total:2}:ready.host.request(method,path,data)});
  await assert.rejects(multiple.ensure(ready.input),{code:'MULTIPLE_EXISTING_INSTANCES'});assert.equal(ready.host.patches,0);
});
test('upgrade rejects incompatible retained settings and source identity before mutating the host',async()=>{
  for(const mutate of [record=>record.manifest.settings[0].type='textarea',record=>record.settings.removed_setting='synthetic',record=>record.settings.reply_tone='unsupported']){
    const {host,installer,input}=await upgradeFixture();mutate(host.record);
    await assert.rejects(installer.ensure(input),{code:'INCOMPATIBLE_UPGRADE_SETTINGS'});assert.equal(host.patches,0);
  }
  const foreign=await upgradeFixture();foreign.host.record.source.repository='https://example.test/another/source';
  await assert.rejects(foreign.installer.ensure(foreign.input),{code:'SOURCE_REPOSITORY_MISMATCH'});assert.equal(foreign.host.patches,0);
  const changedPin=await upgradeFixture();changedPin.host.record.source.revision=source.revision;
  await assert.rejects(changedPin.installer.ensure(changedPin.input),{code:'MANIFEST_CONTENT_MISMATCH'});assert.equal(changedPin.host.patches,0);
});
test('upgrade permits explicit valid replacement of a retired option and removal of an unstored optional declaration',async()=>{
  const {host,installer,input}=await upgradeFixture();
  host.record.settings.reply_tone='retired-option';host.record.manifest.settings[1].options.push({value:'retired-option',label:'Synthetic retired option'});
  host.record.manifest.settings.push({key:'old_optional',label:'Synthetic old option',type:'text',required:false,default:''});
  const result=await installer.ensure({...input,settings:{reply_tone:'formal'}});
  assert.equal(result.settings.reply_tone,'formal');assert.equal(result.settings.merchant_name,'Synthetic merchant');assert.equal(host.patches,1);
  const invalid=await upgradeFixture();
  await assert.rejects(invalid.installer.ensure({...invalid.input,settings:{reply_tone:'invalid-option'}}),{code:'INVALID_AGENT_SETTINGS'});assert.equal(invalid.host.patches,0);
});
test('registration and upgrade never follow a substituted response ID',async()=>{
  for(const responseStage of ['detail','patch']){
    const {host,input}=await upgradeFixture();
    const installer=createBlueprintInstaller({getTargetIdentity:host.getTargetIdentity,request:async(method,path,data)=>{
      const result=await host.request(method,path,data);
      if((responseStage==='detail'&&method==='GET'&&!path.includes('?'))||(responseStage==='patch'&&method==='PATCH'))result.agent.id='replacement-agent';
      return result;
    }});
    await assert.rejects(installer.ensure(input),{code:'REGISTRATION_READBACK_MISMATCH'});
    assert.equal(host.requests.some(row=>row.path.endsWith('/replacement-agent')),false);assert.equal(host.posts,1);
  }
  const {host}=await upgradeFixture();host.record.manifest=structuredClone(manifest);host.record.source=structuredClone(source);
  const replaced=createBlueprintInstaller({getTargetIdentity:host.getTargetIdentity,request:async(method,path,data)=>{const result=await host.request(method,path,data);if(method==='PATCH')result.agent.id='replacement-agent';return result;}});
  await assert.rejects(replaced.ensure({source,inspection:inspect(),settings:{reply_tone:'formal'}}),{code:'REGISTRATION_READBACK_MISMATCH'});
  assert.equal(host.requests.some(row=>row.path.endsWith('/replacement-agent')),false);
});
test('unsupported or ignored package PATCH fails closed without fallback creation',async()=>{
  for(const mode of ['reject','ignore']){
    const {host,input}=await upgradeFixture();
    const installer=createBlueprintInstaller({getTargetIdentity:host.getTargetIdentity,request:(method,path,data)=>{
      if(method==='PATCH'){if(mode==='reject')throw Object.assign(new Error('unsupported upgrade'),{code:'UNSUPPORTED_HOST_UPGRADE',status:400});return host.request('GET',path);}
      return host.request(method,path,data);
    }});
    await assert.rejects(installer.ensure(input),{code:mode==='reject'?'UNSUPPORTED_HOST_UPGRADE':'REGISTRATION_READBACK_MISMATCH'});
    assert.equal(host.posts,1);assert.equal(host.patches,0);
  }
});
test('unknown upgrade outcome is not blindly resent; explicit retry keeps the key and checks current state',async()=>{
  const {host,input}=await upgradeFixture();let loseResponse=true;
  const installer=createBlueprintInstaller({getTargetIdentity:host.getTargetIdentity,request:async(method,path,data)=>{
    const result=await host.request(method,path,data);
    if(method==='PATCH'&&loseResponse){loseResponse=false;throw Object.assign(new Error('synthetic transport failure'),{code:'TRANSPORT_UNKNOWN'});}
    return result;
  }});
  await assert.rejects(installer.ensure(input),{code:'TRANSPORT_UNKNOWN'});assert.equal(host.patches,1);assert.equal(host.requests.filter(row=>row.method==='PATCH').length,1);
  assert.equal((await installer.ensure(input)).agent_id,'same-agent');assert.equal(host.patches,1);
  await assert.rejects(installer.ensure({...input,settings:{reply_tone:'formal'}}),{code:'UPGRADE_KEY_CONFLICT'});assert.equal(host.patches,1);
  const drifted=createBlueprintInstaller({getTargetIdentity:host.getTargetIdentity,request:async(method,path,data)=>{const result=await host.request(method,path,data);if(method==='PATCH')host.record.source.revision='c'.repeat(40);return result;}});
  await assert.rejects(drifted.ensure(input),{code:'REGISTRATION_READBACK_MISMATCH'});assert.equal(host.patches,1);
});
test('upgrade rechecks the authenticated target and role before write and current readback',async()=>{
  for(const switchAt of [2,3]){
    const {host,input}=await upgradeFixture();let calls=0;
    const installer=createBlueprintInstaller({request:host.request,getTargetIdentity:async()=>({target_id:fixture.target_id,role:++calls===switchAt?'viewer':'owner'})});
    await assert.rejects(installer.ensure(input),{code:'ADMIN_REQUIRED'});assert.equal(host.patches,switchAt===2?0:1);assert.equal(host.posts,1);
  }
});
test('manifest matches pinned connected_client contract and contains no credentials or executable renderer',()=>{
  assert.deepEqual(Object.keys(manifest).sort(),['adapter','contract_version','description','id','instructions','name','operations','settings','ui','version'].sort());
  assert.equal(manifest.id,'bluesai-cs-0001');assert.match(manifest.name,/BlueSAi-Cs-#0001/);assert.equal(manifest.contract_version,1);assert.equal(manifest.adapter,'connected_client');assert.equal(manifest.ui.layout,'standard');
  for(const field of [...manifest.settings,...manifest.operations.flatMap(op=>op.input_fields)])assert.ok(['text','textarea','select','boolean'].includes(field.type));
  assert.equal(manifest.settings.find(f=>f.key==='merchant_name').default,'');assert.equal(digest(manifest).length,64);
});
function packageFixture(t) {
  const base=realpathSync(tmpdir()),parent=mkdtempSync(resolve(base,'bluesai-package-')),repo=resolve(parent,'repo'),output=resolve(parent,'release');mkdirSync(resolve(repo,'tools'),{recursive:true});mkdirSync(resolve(repo,'integrations/blueprint'),{recursive:true});
  t.after(()=>{const actual=realpathSync(parent);assert.equal(dirname(actual),base);assert.ok(basename(actual).startsWith('bluesai-package-'));rmSync(actual,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
  writeFileSync(resolve(repo,'tools/package-release.js'),readFileSync(new URL('../tools/package-release.js',import.meta.url)));
  writeFileSync(resolve(repo,'tools/release-privacy.js'),readFileSync(new URL('../tools/release-privacy.js',import.meta.url)));
  writeFileSync(resolve(repo,'.gitignore'),readFileSync(new URL('../.gitignore',import.meta.url)));
  writeFileSync(resolve(repo,'package.json'),' {"type":"module"}\n');writeFileSync(resolve(repo,'integrations/blueprint/package.json'),readFileSync(new URL('../integrations/blueprint/package.json',import.meta.url)));writeFileSync(resolve(repo,'sample.txt'),'synthetic source\n');
  const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init');git('-c','core.autocrlf=false','add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','synthetic fixture');
  git('config','user.name','Fixture');git('config','user.email','fixture@example.test');git('config','core.autocrlf','false');
  const run=target=>spawnSync(process.execPath,['tools/package-release.js','--output',target],{cwd:repo,encoding:'utf8'});
  const track=(path,bytes)=>{const target=resolve(repo,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes);git('add','-f','--',path);git('commit','-m','synthetic tracked fixture');assert.equal(git('status','--porcelain'),'');};
  return {parent,repo,output,git,run,track};
}
test('preview build hashes exact clean Git source and rejects dirty or overwritten artifacts',t=>{
  const {parent,repo,output,git,run}=packageFixture(t);
  const inRepo=resolve(repo,'..private/release');assert.equal(run(inRepo).status,1);assert.equal(existsSync(inRepo),false);
  assert.equal(run(output).status,0);const result=JSON.parse(readFileSync(resolve(output,'release.json'),'utf8'));
  assert.equal(result.source.revision,git('rev-parse','HEAD'));assert.equal(result.channel,'preview');
  const sha256=x=>createHash('sha256').update(x).digest('hex');assert.equal(result.artifacts[0].sha256,sha256(readFileSync(resolve(output,'source.tar'))));assert.equal(result.inventory.find(f=>f.path==='sample.txt').sha256,sha256('synthetic source\n'));
  assert.equal(run(output).status,1);writeFileSync(resolve(repo,'sample.txt'),'changed\n');const second=resolve(parent,'dirty-release');assert.equal(run(second).status,1);assert.equal(existsSync(second),false);
});

test('public source, blank environment examples and ordinary synthetic fixtures remain distributable',t=>{
  const f=packageFixture(t);
  for(const [path,content] of [
    ['.env.example','OPENAI_API_KEY=\nEVOLUTION_API_KEY=\n'],
    ['integrations/whatsapp-local/.env.example','WA_LOCAL_API_KEY=\n'],
    ['src/agent.js','export const publicAgent = true;\n'],
    ['src/knowledge-learning.js','export const publicLearning = true;\n'],
    ['test/fixtures/customer-conversation.json',JSON.stringify({synthetic:true,messages:[]})],
    ['test/fixtures/knowledge.json',JSON.stringify({synthetic:true,knowledge:[]})],
    ['docs/KNOWLEDGE_LEARNING.md','Public workflow design and synthetic examples.\n'],
    ['docs/api-example.md','Use sk-your-key as a placeholder.\n-----BEGIN PRIVATE KEY-----\n<REPLACE_WITH_YOUR_PRIVATE_KEY>\n-----END PRIVATE KEY-----\n'],
  ])f.track(path,content);
  const result=f.run(f.output);assert.equal(result.status,0,result.stderr);
  const release=JSON.parse(readFileSync(resolve(f.output,'release.json'),'utf8'));
  assert.ok(release.inventory.some(row=>row.path==='src/knowledge-learning.js'));assert.ok(release.inventory.some(row=>row.path==='.env.example'));
});

test('release archive preserves Git blob bytes under a CRLF checkout policy',t=>{
  const {repo,output,git,run}=packageFixture(t);
  git('config','core.autocrlf','true');
  const result=run(output);assert.equal(result.status,0,result.stderr);
  const release=JSON.parse(readFileSync(resolve(output,'release.json'),'utf8'));
  const tar=readFileSync(resolve(output,'source.tar')),entries=new Map();
  for(let offset=0;offset+512<=tar.length;){
    const header=tar.subarray(offset,offset+512);
    if(header.every(byte=>byte===0))break;
    const name=header.subarray(0,100).toString().replace(/\0.*$/s,'');
    const size=parseInt(header.subarray(124,136).toString().replace(/\0.*$/s,'').trim()||'0',8);
    const prefix=header.subarray(345,500).toString().replace(/\0.*$/s,'');
    if(header[156]===0||header[156]===48)entries.set(prefix?prefix+'/'+name:name,tar.subarray(offset+512,offset+512+size));
    offset+=512+Math.ceil(size/512)*512;
  }
  for(const file of release.inventory){
    assert.ok(entries.has(file.path),file.path);
    assert.equal(createHash('sha256').update(entries.get(file.path)).digest('hex'),file.sha256,file.path);
  }
  assert.equal(entries.get('sample.txt').toString(),'synthetic source\n');
  assert.equal(git('config','core.autocrlf'),'true');
});

test('tracked private runtime and customer-export paths block release before any artifact directory exists',t=>{
  const f=packageFixture(t),marker='SYNTHETIC_PRIVATE_FILE_NOT_FOR_RELEASE';let n=0;
  for(const path of [
    'runtime.env','config/bridge.env','.env','.env.production',
    'state/service.sqlite','service.db-wal','service.sqlite-shm','server.log','server.log.1',
    'state/auth/session.json','auth.json','creds.json','admin-token','backups/snapshot.json',
    'customer-export.json','knowledge_export.json','inbox-export.csv','knowledge.json',
    'customer-data.json','exports/customer-records.json','docs/knowledge-export.md','inbox-export.sql','customer-conversations-export.yaml','knowledge-export.jsonc',
  ]){
    f.track(path,marker+'\n');
    const target=resolve(f.parent,'blocked-'+(++n)),result=f.run(target);
    assert.equal(result.status,1,path);assert.match(result.stderr,/Release blocked by privacy gate/);assert.equal(existsSync(target),false,path);
    assert.doesNotMatch(result.stdout+result.stderr,new RegExp(marker));
    f.git('rm','--',path);f.git('commit','-m','remove synthetic private fixture');
  }
});

test('commit blob bytes detect disguised databases and explicit key formats even in an allowed public path',t=>{
  const f=packageFixture(t);let n=0;
  const privateHeader=['-----BEGIN ','PRIVATE KEY-----'].join(''),privateEnd=['-----END ','PRIVATE KEY-----'].join('');
  const samples=[
    Buffer.concat([Buffer.from('SQLite format 3\0'),Buffer.from('synthetic database fixture')]),
    Buffer.from([0x37,0x7f,0x06,0x82,0,0,0,0]),
    [privateHeader,'A'.repeat(64),privateEnd].join('\n'),
    [['-----BEGIN ','RSA PRIVATE KEY-----'].join(''),'Proc-Type: 4,ENCRYPTED','DEK-Info: AES-256-CBC,'+'A'.repeat(32),'','B'.repeat(64),'Cg==',['-----END ','RSA PRIVATE KEY-----'].join('')].join('\n'),
    ['sk-','proj-','aB3cD4'.repeat(12)].join(''),
    ['sk-','svcacct-','eF5gH6'.repeat(12)].join(''),
    ['sk-','jK7mN8'.repeat(10)].join(''),
  ];
  for(const bytes of samples){
    f.track('sample.txt',bytes);const target=resolve(f.parent,'private-bytes-'+(++n)),result=f.run(target);
    assert.equal(result.status,1);assert.match(result.stderr,/PRIVATE_DATABASE_BYTES|PRIVATE_KEY_BYTES|OPENAI_CREDENTIAL_BYTES/);assert.equal(existsSync(target),false);
    assert.ok(!result.stderr.includes(Buffer.isBuffer(bytes)?bytes.toString('utf8'):bytes));
  }
  f.track('.env.example',samples[4]);const target=resolve(f.parent,'private-example');assert.equal(f.run(target).status,1);assert.equal(existsSync(target),false);
});

test('privacy inspection reads the committed blob rather than a clean-filtered public working copy',t=>{
  const f=packageFixture(t),node=process.execPath.replace(/\\/g,'/');
  f.track('tools/synthetic-clean-filter.js',"process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(['-----BEGIN '+'PRIVATE KEY-----','A'.repeat(64),'-----END '+'PRIVATE KEY-----'].join('\\n')));\n");
  f.git('config','filter.synthetic-private.clean','"'+node+'" tools/synthetic-clean-filter.js');
  f.track('.gitattributes','public-note.txt filter=synthetic-private\n');
  f.track('public-note.txt','synthetic harmless working copy\n');
  assert.equal(readFileSync(resolve(f.repo,'public-note.txt'),'utf8'),'synthetic harmless working copy\n');
  assert.equal(f.git('status','--porcelain'),'');
  const result=f.run(f.output);assert.equal(result.status,1);assert.match(result.stderr,/PRIVATE_KEY_BYTES/);assert.equal(existsSync(f.output),false);
});

test('ignore rules prevent accidental runtime additions without hiding public learning code or environment examples',t=>{
  const f=packageFixture(t);
  for(const path of ['runtime.env','bridge.env','auth/creds.json','admin-token','backups/service.sqlite','knowledge-export.json','inbox-export.csv','customer-conversations-export.yaml']){
    const result=spawnSync('git',['check-ignore','--',path],{cwd:f.repo,encoding:'utf8'});assert.equal(result.status,0,path);
  }
  for(const path of ['src/agent.js','src/knowledge-learning.js','.env.example','integrations/whatsapp-local/.env.example','test/fixtures/customer-conversation.json']){
    const result=spawnSync('git',['check-ignore','--',path],{cwd:f.repo,encoding:'utf8'});assert.equal(result.status,1,path);
  }
});
