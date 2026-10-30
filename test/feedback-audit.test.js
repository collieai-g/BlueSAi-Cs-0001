import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,realpathSync,mkdirSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,dirname,basename} from 'node:path';
import {execFileSync} from 'node:child_process';
import {auditFeedback,repositoryChanges,repositoryDelta} from '../tools/feedback-audit.js';

function fixture(t){
  const parent=realpathSync(tmpdir()),base=mkdtempSync(resolve(parent,'feedback-synthetic-'));
  t.after(()=>{assert.equal(dirname(realpathSync(base)),parent);assert.ok(basename(base).startsWith('feedback-synthetic-'));rmSync(base,{recursive:true,force:true});});
  mkdirSync(resolve(base,'test'));writeFileSync(resolve(base,'source.js'),'export const synthetic=true;\n');writeFileSync(resolve(base,'test/check.js'),'// synthetic test\n');
  const registry={schema_version:1,project_id:'bluesai-cs-0001',scope_id:'synthetic-loop',baseline_commit:'a'.repeat(40),cases:[{case_id:'synthetic-case',title:'Synthetic feedback',owner_project:'bluesai-cs-0001',observations:[{id:'generation-drift',classification:'product_bug',disposition:'candidate_fix',summary:'Synthetic source fix'}],files:['source.js'],checks:['test/check.js'],references:[]}]};
  return {base,registry};
}
test('every source delta must have a declared case; coverage never attests deployment',t=>{
  const f=fixture(t);const report=auditFeedback({...f,changedPaths:['source.js','new-button.js']});
  assert.equal(report.observation_mapping_percent,100);assert.equal(report.status,'unmapped_source_changes');assert.deepEqual(report.unmapped_changed_files,['new-button.js']);assert.match(report.meaning,/separate receipts/);assert.equal('deployed' in report,false);
});
test('same stable case cannot silently be replaced by a second scope',t=>{
  const f=fixture(t);f.registry.cases.push(structuredClone(f.registry.cases[0]));assert.throws(()=>auditFeedback(f),/Duplicate/);
});
test('duplicate observation, missing test, private fields and escaping paths fail closed',t=>{
  const f=fixture(t),original=structuredClone(f.registry);
  f.registry.cases[0].observations.push(structuredClone(f.registry.cases[0].observations[0]));assert.throws(()=>auditFeedback(f),/duplicate observation/);
  f.registry=structuredClone(original);f.registry.cases[0].checks=['missing.js'];assert.throws(()=>auditFeedback(f),/Missing/);
  f.registry=structuredClone(original);f.registry.customer_messages=[];assert.throws(()=>auditFeedback(f),/Private evidence/);
  f.registry=structuredClone(original);f.registry.cases[0].files=['../outside'];assert.throws(()=>auditFeedback(f),/repository-relative/);
});
test('external dependencies remain explicit and do not count as a local implementation',t=>{
  const f=fixture(t);const item=f.registry.cases[0];item.owner_project='blueprint-studio';item.files=[];item.references=['https://github.com/collieai-g/Blueprint-Studio-Open-Source/pull/18'];item.observations[0].disposition='external_dependency';
  const report=auditFeedback(f);assert.equal(report.status,'mapped_candidate');assert.equal(report.unresolved.length,1);assert.equal(report.unresolved[0].disposition,'external_dependency');
});

test('stable scope, case and observation IDs reject missing or non-string values',t=>{
  const f=fixture(t),original=structuredClone(f.registry);
  for(const where of ['scope','case','observation'])for(const value of [undefined,null,123,true,{},[],['synthetic-id']]){
    f.registry=structuredClone(original);
    const target=where==='scope'?f.registry:where==='case'?f.registry.cases[0]:f.registry.cases[0].observations[0];
    const key=where==='scope'?'scope_id':where==='case'?'case_id':'id';
    if(value===undefined)delete target[key];else target[key]=value;
    assert.throws(()=>auditFeedback(f),/Invalid feedback registry|invalid case ID|Invalid or duplicate observation/,where+' '+String(value));
  }
});

test('source and check mappings require actual files, not directories',t=>{
  const f=fixture(t),original=structuredClone(f.registry);
  for(const field of ['files','checks']){
    f.registry=structuredClone(original);f.registry.cases[0][field]=['test'];
    assert.throws(()=>auditFeedback(f),/Missing feedback source file/);
  }
});

function gitFixture(t){
  const f=fixture(t);
  const git=(...args)=>execFileSync('git',['-c','core.hooksPath='+resolve(f.base,'disabled-hooks'),'-c','commit.gpgSign=false',...args],{cwd:f.base,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git('init','--quiet');git('config','user.name','Synthetic Test');git('config','user.email','synthetic@example.invalid');
  writeFileSync(resolve(f.base,'delete-me.js'),'// synthetic deleted source\n');
  writeFileSync(resolve(f.base,'rename-old.js'),'// synthetic renamed source\n');
  git('add','--','.');git('commit','--quiet','-m','Synthetic baseline');
  f.registry.baseline_commit=git('rev-parse','HEAD').trim();
  return {...f,git};
}

test('real Git delta keeps staged additions, untracked files, deletions and both rename paths in coverage',t=>{
  const f=gitFixture(t);
  writeFileSync(resolve(f.base,'source.js'),'export const synthetic="modified";\n');
  rmSync(resolve(f.base,'delete-me.js'));
  renameSync(resolve(f.base,'rename-old.js'),resolve(f.base,'renamed new.js'));
  writeFileSync(resolve(f.base,'added.js'),'// synthetic staged addition\n');
  f.git('add','--all');
  writeFileSync(resolve(f.base,'untracked.js'),'// synthetic untracked addition\n');
  const delta=repositoryDelta(f.base,f.registry.baseline_commit);
  assert.deepEqual(delta.changedPaths,['added.js','delete-me.js','rename-old.js','renamed new.js','source.js','untracked.js']);
  assert.deepEqual(delta.deletedPaths,['delete-me.js','rename-old.js']);
  assert.deepEqual(repositoryChanges(f.base,f.registry.baseline_commit),delta.changedPaths);
  f.registry.cases[0].files=delta.changedPaths;
  const report=auditFeedback({...f,...delta});
  assert.equal(report.changed_files,6);assert.equal(report.deleted_files,2);assert.equal(report.mapped_changed_files,6);assert.equal(report.status,'mapped_candidate');
  assert.equal(JSON.stringify(report).includes('synthetic deleted source'),false,'baseline contents never enter the report');
  f.registry.cases[0].files=delta.changedPaths.filter(path=>path!=='delete-me.js');
  const unmapped=auditFeedback({...f,...delta});assert.deepEqual(unmapped.unmapped_changed_files,['delete-me.js']);
});

test('deletion metadata cannot disguise a typo, surviving source or deleted required check',t=>{
  const f=gitFixture(t);
  assert.throws(()=>auditFeedback({...f,changedPaths:['missing.js'],deletedPaths:['missing.js']}),/Unverified deleted/);
  assert.throws(()=>auditFeedback({...f,changedPaths:['source.js'],deletedPaths:['source.js']}),/Unverified deleted/);
  rmSync(resolve(f.base,'delete-me.js'));const delta=repositoryDelta(f.base,f.registry.baseline_commit);
  f.registry.cases[0].files=['delete-me.js'];
  assert.throws(()=>auditFeedback({...f,changedPaths:delta.changedPaths}),/Missing feedback source file/,'a deleted source needs explicit verified deletion metadata');
  f.registry.cases[0].checks=['delete-me.js'];
  assert.throws(()=>auditFeedback({...f,...delta}),/Missing feedback source file/,'regression checks must exist now');
  assert.throws(()=>auditFeedback({...f,changedPaths:[],deletedPaths:delta.deletedPaths}),/Unverified deleted/,'deleted paths must remain in the source denominator');
});
