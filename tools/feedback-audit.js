import {readFileSync,existsSync,realpathSync,statSync} from 'node:fs';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url));
const ID=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const classifications=new Set(['product_bug','configuration_gap','client_compatibility_gap','integration_gap','verification_gap','process_gap']);
const dispositions=new Set(['candidate_fix','documented_workflow','external_dependency','external_validation','referenced_maintenance']);
const topKeys=['schema_version','project_id','scope_id','baseline_commit','cases'];
const caseKeys=['case_id','title','owner_project','observations','files','checks','references'];
const observationKeys=['id','classification','disposition','summary'];
const validId=value=>typeof value==='string'&&ID.test(value);
function keys(value,allowed){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw new Error('Unsupported feedback fields. Private evidence belongs outside source.');
}
function safePath(path){
  if(typeof path!=='string'||!path||path.includes('\\')||isAbsolute(path)||path.split('/').some(p=>!p||p==='.'||p==='..')||/^[A-Za-z]:/.test(path))throw new Error('Feedback paths must be explicit repository-relative files.');
  return path;
}
function safeFile(base,path){
  safePath(path);
  const target=resolve(base,path);
  if(!existsSync(target)||!statSync(target).isFile())throw new Error('Missing feedback source file: '+path);
  const delta=relative(realpathSync(base),realpathSync(target));
  if(delta==='..'||delta.startsWith('..'+sep)||isAbsolute(delta))throw new Error('Feedback source escapes repository.');
  return target;
}

// A coverage check, not another test runner, installer, or deployment journal.
export function auditFeedback({base,registry,changedPaths=[],deletedPaths=[]}){
  keys(registry,topKeys);
  if(registry.schema_version!==1||registry.project_id!=='bluesai-cs-0001'||!validId(registry.scope_id)||typeof registry.baseline_commit!=='string'||!/^[a-f0-9]{40}$/.test(registry.baseline_commit)||!Array.isArray(registry.cases)||!registry.cases.length)throw new Error('Invalid feedback registry.');
  if(!Array.isArray(changedPaths)||!Array.isArray(deletedPaths))throw new Error('Invalid repository delta.');
  const changes=[...new Set(changedPaths.map(safePath))].sort(),deleted=new Set(deletedPaths.map(safePath));
  if(deleted.size){
    const actualDeleted=new Set(repositoryDelta(base,registry.baseline_commit).deletedPaths);
    for(const path of deleted)if(!changes.includes(path)||!actualDeleted.has(path))throw new Error('Unverified deleted feedback source: '+path);
  }
  const seenCases=new Set(),observations=[],owners=new Map(),requiredChecks=new Set();
  for(const item of registry.cases){
    keys(item,caseKeys);
    if(!validId(item.case_id)||seenCases.has(item.case_id))throw new Error('Duplicate or invalid case ID.');
    seenCases.add(item.case_id);
    if(!['bluesai-cs-0001','blueprint-studio','private-runtime'].includes(item.owner_project)||typeof item.title!=='string'||!item.title.trim())throw new Error('A case needs one explicit owner and title.');
    if(!Array.isArray(item.observations)||!item.observations.length||!Array.isArray(item.files)||!Array.isArray(item.checks)||!Array.isArray(item.references))throw new Error('Incomplete case mapping.');
    if(!item.files.length&&!item.references.length)throw new Error('A case needs source files or a dependency reference.');
    const localIds=new Set();
    for(const observation of item.observations){
      keys(observation,observationKeys);
      if(!validId(observation.id)||localIds.has(observation.id)||!classifications.has(observation.classification)||!dispositions.has(observation.disposition)||typeof observation.summary!=='string'||!observation.summary.trim())throw new Error('Invalid or duplicate observation.');
      localIds.add(observation.id);
      observations.push({case_id:item.case_id,id:observation.id,classification:observation.classification,disposition:observation.disposition});
    }
    for(const path of item.files){
      safePath(path);
      if(deleted.has(path)){
        // A deletion remains part of coverage. Verify the old source exists in
        // the pinned tree, without reading its contents into the report.
        if(gitRead(base,'cat-file','-t',registry.baseline_commit+':'+path).trim()!=='blob')throw new Error('Deleted feedback source must be a baseline file.');
      }else safeFile(base,path);
      if(!owners.has(path))owners.set(path,[]);
      owners.get(path).push(item.case_id);
    }
    for(const path of item.checks){safeFile(base,path);requiredChecks.add(path);}
    for(const reference of item.references){
      if(typeof reference!=='string'||!/^https:\/\/github\.com\/collieai-g\/(BlueSAi-Cs-0001|Blueprint-Studio-Open-Source)(?:\/|$)/.test(reference))throw new Error('Use reviewed public repository references only.');
    }
  }
  const unmapped=changes.filter(path=>!owners.has(path));
  return {
    schema_version:1,scope_id:registry.scope_id,baseline_commit:registry.baseline_commit,
    registry_sha256:createHash('sha256').update(JSON.stringify(registry)).digest('hex'),
    cases:seenCases.size,known_observations:observations.length,
    mapped_observations:observations.length,observation_mapping_percent:100,
    changed_files:changes.length,deleted_files:deleted.size,mapped_changed_files:changes.length-unmapped.length,
    unmapped_changed_files:unmapped,required_checks:[...requiredChecks].sort(),
    unresolved:observations.filter(row=>['external_dependency','external_validation','referenced_maintenance'].includes(row.disposition)),
    status:unmapped.length?'unmapped_source_changes':'mapped_candidate',
    meaning:'Mapping covers the declared observations and source diff only. Tests, host integration, publication, release and each private deployment require separate receipts.',
  };
}

function gitRead(base,...args){
  return execFileSync('git',args,{cwd:base,encoding:'utf8',maxBuffer:10*1024*1024,stdio:['ignore','pipe','pipe']});
}
export function repositoryDelta(base,baseline){
  if(typeof baseline!=='string'||!/^[a-f0-9]{40}$/.test(baseline))throw new Error('Invalid pinned Git baseline.');
  const git=(...args)=>gitRead(base,...args),paths=text=>text.split('\0').filter(Boolean);
  git('cat-file','-e',baseline+'^{commit}');
  // Count both old and new paths of a rename, independent of Git similarity
  // settings. No deleted source can disappear from the coverage denominator.
  return {
    changedPaths:[...new Set([...paths(git('diff','--no-renames','--name-only','-z',baseline,'--')),...paths(git('ls-files','--others','--exclude-standard','-z'))])].sort(),
    deletedPaths:paths(git('diff','--no-renames','--name-only','--diff-filter=D','-z',baseline,'--')).sort(),
  };
}
export function repositoryChanges(base,baseline){
  return repositoryDelta(base,baseline).changedPaths;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==2)throw new Error('Usage: node tools/feedback-audit.js');
    const registry=JSON.parse(readFileSync(resolve(root,'feedback/registry.json'),'utf8'));
    const report=auditFeedback({base:root,registry,...repositoryDelta(root,registry.baseline_commit)});
    process.stdout.write(JSON.stringify(report,null,2)+'\n');
    if(report.unmapped_changed_files.length)process.exitCode=2;
  }catch(error){process.stderr.write((error.message?.startsWith('Command failed:')?'Cannot read the pinned Git source.':error.message)+'\n');process.exitCode=1;}
}
