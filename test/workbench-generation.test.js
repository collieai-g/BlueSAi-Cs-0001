import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync, copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';

const repo=dirname(dirname(fileURLToPath(import.meta.url)));
const python=process.env.PYTHON || (process.platform==='win32'?'python':'python3');
const revision='0dce8c8e082d075351f098603aeec81d227c9d29';
const read=path=>readFileSync(path,'utf8').replaceAll('\r\n','\n');
const hash=value=>createHash('sha256').update(value).digest('hex');
function run(script,...args){return spawnSync(python,['-B',script,...args],{cwd:repo,encoding:'utf8'});}
function passed(result){assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+result.stderr);}
function fixture(t){const root=mkdtempSync(join(tmpdir(),'bluesai-ui-generation-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
function native(output,...args){return run('tools/build-blueprint-card.py','--source-revision',revision,'--output-dir',output,...args);}

test('syntax checking ignores dependency metadata while retaining every project source root',t=>{
  const root=fixture(t),roots=['src','public','tools','integrations/whatsapp-local'];
  writeFileSync(join(root,'package.json'),'{"type":"module"}\n');
  for(const dir of roots){
    mkdirSync(join(root,dir,'nested'),{recursive:true});
    writeFileSync(join(root,dir,'nested','project-owned.js'),'export const synthetic = true;\n');
    for(const ignored of ['node_modules','.git','__pycache__']){
      const metadata=join(root,dir,'nested',ignored,'nested');mkdirSync(metadata,{recursive:true});
      writeFileSync(join(metadata,'not-project-source.js'),'synthetic invalid JavaScript {{{\n');
    }
  }
  writeFileSync(join(root,'tools/check.js'),read(join(repo,'tools/check.js')));
  writeFileSync(join(root,'tools/build-workbench.py'),'print("synthetic generated assets checked")\n');
  const check=()=>spawnSync(process.execPath,['tools/check.js'],{cwd:root,encoding:'utf8',env:{...process.env,PYTHON:python}});
  const clean=check();passed(clean);assert.match(clean.stdout,/synthetic generated assets checked/);
  for(const dir of roots){
    const own=join(root,dir,'nested','project-owned.js');writeFileSync(own,'export const broken = ;\n');
    const invalid=check();assert.notEqual(invalid.status,0,dir+' remains checked');
    assert.match(invalid.stderr,/project-owned\.js/);
    assert.doesNotMatch(invalid.stdout,/synthetic generated assets checked/,'invalid project source stops before asset verification');
    writeFileSync(own,'export const synthetic = true;\n');
  }
});

function assertChannelContract(markup,script,css){
  for(const attribute of ['data-manage-phone','data-manage-phone-label','data-manage-link','data-phone-state','data-inbox-scope-consent','data-inbox-reply-consent','data-wa-link-flow','data-wa-link-stage','data-wa-link-title','data-wa-link-status','data-wa-link-phone','data-wa-link-retry','data-wa-link-cancel'])assert.ok(markup.includes(attribute),attribute);
  for(const retired of ['data-wa-test-recipients','data-wa-test-submit','data-inbox-scope-test','data-inbox-connection-check','data-manage-reply','data-manage-proof','data-manage-next-description'])assert.ok(!markup.includes(retired),retired+' is retired');
  assert.doesNotMatch(markup,/手機連結（本機測試路線）|WhatsApp\s*Business[^<]*(?:尚在開發|仍在開發|開發中)/i);
  const start=script.indexOf('    function phoneConnectionState('),end=script.indexOf('    function paintPhoneConnection(',start);
  assert.ok(start>=0&&end>start,'canonical phone state handler is included');
  const context={live:true};runInNewContext(script.slice(start,end),context);
  // Synthetic provider phone; no instance, credential or device ID is a fallback.
  const open={status:'open',checkedAt:Date.now(),linkedPhone:'15555550123'};
  assert.equal(context.phoneConnectionState(open).number,'+15555550123');
  assert.equal(context.phoneConnectionState(open).tone,'open');
  assert.equal(context.phoneConnectionState({...open,status:'close'}).number,'');
  assert.equal(context.phoneConnectionState({...open,status:'close'}).tone,'closed');
  assert.equal(context.phoneConnectionState({...open,requiresCheck:true}).tone,'unknown');
  assert.equal(context.phoneConnectionState({...open,linkedPhone:'15555550123@lid'}).number,'');
  for(const handler of ['startWhatsAppLink','pollWhatsAppPreparation','pollWhatsAppLink','stopWhatsAppLink'])assert.ok(script.includes('function '+handler+'('),handler+' survives both renderers');
  assert.match(script,/backend\.prepareWhatsAppLocal\(\)/);
  assert.match(script,/backend\.getWhatsAppLocal\(\)/);
  const pollStart=script.indexOf('    async function pollWhatsAppLink('),pollEnd=script.indexOf('    async function connectPreparedWhatsApp(',pollStart);
  assert.ok(pollStart>=0&&pollEnd>pollStart,'actual connection polling remains extractable');
  const poll=script.slice(pollStart,pollEnd);
  assert.match(poll,/fetchWhatsAppLinkQr\(epoch,true\)/,'QR polling chooses the read-only branch');
  assert.doesNotMatch(poll,/backend\.whatsapp\(/,'polling cannot directly start another connection');
  assert.match(script,/readOnly\?backend\.getWhatsAppQr\(\):backend\.whatsapp\(args\)/,'QR refresh uses a distinct read-only backend API');
  assert.match(css,/\[data-phone-state="open"\][^{]*\{[^}]*animation:bluesai-cs-phone-pulse\s+[\d.]+s/);
  assert.match(css,/\[data-phone-state="closed"\][^{]*\{[^}]*animation:bluesai-cs-phone-pulse\s+[\d.]+s/);
  assert.match(css,/@media\s*\(prefers-reduced-motion:\s*reduce\)[^{]*\{[^{}]*\.bp-phone-light[^{}]*\{[^{}]*animation:\s*none\s*!important/);
}

test('canonical build retains the QR lifecycle and all reviewed conversation controls',t=>{
  const output=fixture(t);passed(run('tools/build-workbench.py','--output-dir',output));
  for(const name of ['agent-card.html','agent-card.css','workbench.html','workbench.css','workbench.js']){
    assert.equal(read(join(output,name)),read(join(repo,'public',name)),name);
  }
  const markup=read(join(output,'agent-card.html')),script=read(join(output,'workbench.js'));
  assertChannelContract(markup,script,read(join(output,'agent-card.css')));
  for(const attribute of ['data-customer-takeover','data-customer-resume','data-customer-send','data-inbox-policy','data-inbox-faq-form'])assert.ok(markup.includes(attribute),attribute);
  assert.match(script,/function clearWhatsAppQr\(/);
  assert.match(script,/function showWhatsAppQr\(/);
  assert.match(script,/syncWhatsAppQr\(wa\)/);
  assert.match(script,/generation!==whatsappQrGeneration/);
  passed(run('tools/build-workbench.py','--output-dir',output,'--check'));
});

test('canonical check detects edits and missing generated assets without overwriting them',t=>{
  const output=fixture(t);passed(run('tools/build-workbench.py','--output-dir',output));
  const path=join(output,'workbench.js'),changed=read(path)+'\n// synthetic drift\n';writeFileSync(path,changed);
  const check=run('tools/build-workbench.py','--output-dir',output,'--check');
  assert.equal(check.status,1);assert.match(check.stdout,/workbench.js/);assert.equal(read(path),changed);
  rmSync(join(output,'agent-card.css'));
  const missing=run('tools/build-workbench.py','--output-dir',output,'--check');
  assert.equal(missing.status,1);assert.match(missing.stdout,/agent-card.css/);assert.equal(existsSync(join(output,'agent-card.css')),false);
});

test('native generation covers all canonical controls and endpoints with deterministic digests',t=>{
  const output=fixture(t);passed(native(output));
  assert.deepEqual(readdirSync(output).sort(),['PROVENANCE.json','agent-card.css','agent-handoff.js','inbox-tools.js','renderer.js','workbench-api.js','workbench.js'].sort());
  const proof=JSON.parse(read(join(output,'PROVENANCE.json')));
  assert.equal(proof.source_revision_verified,false,'UI changed since the declared base pin must not claim commit identity');
  assert.equal(proof.revision,revision);
  assert.match(proof.deployment_status,/not installed/);
  for(const [name,digest]of Object.entries(proof.host_assets))assert.equal(hash(read(join(output,name))),digest,name);
  for(const [name,digest]of Object.entries(proof.original_assets))assert.equal(hash(read(join(repo,name))),digest,name);
  for(const [name,digest]of Object.entries(proof.generator_assets))assert.equal(hash(read(join(repo,name))),digest,name);
  const renderer=read(join(output,'renderer.js'));
  const tree=JSON.parse(renderer.match(/^const COMPONENT_TREE = (.+);$/m)[1]);
  const attrs=[],texts=[];
  function walk(node){if(typeof node==='string'){texts.push(node);return;}attrs.push(node[1]);for(const child of node[2])walk(child);}
  walk(tree);
  const canonical=read(join(repo,'public/agent-card.html'));
  const controlNames=new Set([...canonical.matchAll(/\s(data-[\w-]+)(?:=|[\s>])/g)].map(x=>x[1]));
  for(const name of controlNames)assert.ok(attrs.some(item=>Object.hasOwn(item,name)),name);
  for(const label of ['開始人工回覆','交回知識庫','發送回覆'])assert.ok(texts.includes(label),label);
  const api=read(join(output,'workbench-api.js')),sourceApi=read(join(repo,'public/workbench-api.js'));
  for(const line of sourceApi.split('\n').filter(line=>/^    \w+:.*=>api\(/.test(line)))assert.ok(api.includes(line),line);
  assert.match(api,/X-Blueprint-Account/);assert.match(api,/X-Blueprint-Request/);assert.doesNotMatch(api,/data-local-login|location.reload/);
  const script=read(join(output,'workbench.js'));
  assertChannelContract(JSON.stringify(tree),script,read(join(output,'agent-card.css')));
  for(const handler of ['clearWhatsAppQr','showWhatsAppQr','checkWhatsAppConnection'])assert.ok(script.includes('function '+handler+'('),handler);
  assert.match(script,/const EventSource=undefined/);
  assert.doesNotMatch(script,/globalThis.Tweak/);
  // Conversation ownership/policy labels are carried verbatim, not replaced by
  // a second native UI. Runtime handoff behavior has existing inbox tests.
  const canonicalScript=read(join(repo,'public/workbench.js'));
  for(const line of canonicalScript.split('\n').filter(line=>/data-customer-(?:resume|takeover|send)/.test(line)))assert.ok(script.includes(line),line);
  for(const name of readdirSync(output).filter(name=>name.endsWith('.js')))passed(spawnSync(process.execPath,['--input-type=module','--check'],{input:read(join(output,name)),encoding:'utf8'}));
  passed(native(output,'--check'));
  const first=Object.fromEntries(readdirSync(output).map(name=>[name,read(join(output,name))]));
  passed(native(output));
  for(const [name,value]of Object.entries(first))assert.equal(read(join(output,name)),value,name);
});

test('native and standalone preserve one conversation with explicit human and policy-based automatic handoff',t=>{
  const output=fixture(t);passed(native(output));
  for(const path of [join(repo,'public/workbench.js'),join(output,'workbench.js')]){
    const lines=read(path).split('\n').filter(line=>line.includes("find('[data-customer-takeover]').hidden=selfTest")||line.includes("find('[data-customer-resume]').disabled=selfTest"));
    assert.equal(lines.length,2,'real conversation-control rendering remains available');
    for(const scenario of [
      {state:'human',policy:{enabled:true,aiFallback:false},model:'unconfigured',label:'交回知識庫',disabled:false},
      {state:'human',policy:{enabled:true,aiFallback:true},model:'connected',label:'交回知識庫／AI',disabled:false},
      {state:'human',policy:{enabled:false},model:'connected',label:'交回 AI',disabled:false},
      {state:'human',policy:{enabled:false},model:'unconfigured',label:'交回 AI',disabled:true},
      {state:'ai',policy:{enabled:true,aiFallback:true},model:'connected',label:'交回知識庫／AI',disabled:false},
    ]){
      const nodes=new Map();const find=key=>{if(!nodes.has(key))nodes.set(key,{});return nodes.get(key);};
      runInNewContext(lines.join('\n'),{find,selfTest:false,selfReady:false,c:{state:scenario.state},inboxSummary:{policy:scenario.policy},snapshot:{connections:{ai:{status:scenario.model}}}});
      assert.equal(find('[data-customer-resume]').textContent,scenario.label);
      assert.equal(find('[data-customer-resume]').disabled,scenario.disabled);
      assert.equal(find('[data-customer-resume]').hidden,scenario.state==='ai');
      assert.equal(find('[data-customer-takeover]').hidden,scenario.state==='human');
    }
  }
});

test('native commit verification includes templates and generators when public UI assets have not changed',t=>{
  const root=fixture(t),source=join(root,'source'),output=join(root,'artifact');mkdirSync(source);
  const inputs=[
    'design/customer-agent-card-design.html',
    ...['agent-card.html','agent-card.css','workbench-api.js','agent-handoff.js','inbox-tools.js','workbench.js'].map(name=>'public/'+name),
    'public/app.js','public/workbench.html','public/workbench.css',
    'tools/build-blueprint-card.py','tools/build-workbench.py',
    ...['renderer.js.tmpl','backend.js.tmpl','host-bounds.css'].map(name=>'integrations/blueprint/native/'+name),
  ];
  for(const path of inputs){mkdirSync(dirname(join(source,path)),{recursive:true});copyFileSync(join(repo,path),join(source,path));}
  const git=(...args)=>spawnSync('git',['-C',source,...args],{encoding:'utf8'});
  passed(git('init'));passed(git('add','--all'));
  passed(git('-c','user.name=Synthetic Fixture','-c','user.email=synthetic@example.invalid','-c','commit.gpgSign=false','-c','core.hooksPath='+join(root,'empty-hooks'),'commit','-m','Synthetic source verification baseline'));
  const pin=git('rev-parse','HEAD').stdout.trim();
  const build=()=>{
    passed(spawnSync(python,['-B',join(source,'tools/build-blueprint-card.py'),'--source-revision',pin,'--output-dir',output],{cwd:source,encoding:'utf8'}));
    return JSON.parse(read(join(output,'PROVENANCE.json')));
  };
  const baseline=build();
  assert.equal(baseline.source_revision_verified,true,'matching public assets, templates and generators establish one source identity');
  assert.deepEqual(Object.keys(baseline.source_inputs).sort(),inputs.slice().sort(),'provenance lists every consumed source, validation asset, template and generator');
  for(const [path,digest]of Object.entries(baseline.source_inputs))assert.equal(hash(read(join(source,path))),digest,path);
  for(const path of inputs.filter(path=>!path.startsWith('public/')&&!path.startsWith('design/'))){
    const original=read(join(source,path));
    const comment=path.endsWith('.py')?'\n# synthetic uncommitted generator change\n':'\n/* synthetic uncommitted template change */\n';
    writeFileSync(join(source,path),original+comment);
    const proof=build();
    assert.equal(proof.source_revision_verified,false,path+' drift cannot inherit the public-asset commit verification');
    assert.match(proof.source_status,/working-tree candidate/);
    writeFileSync(join(source,path),original);
  }
  // Source identity uses the same LF normalization as generated provenance;
  // Windows checkout line endings alone must not mark matching inputs dirty.
  for(const path of inputs)writeFileSync(join(source,path),read(join(source,path)).replaceAll('\n','\r\n'));
  assert.equal(build().source_revision_verified,true,'CRLF checkout content compares with normalized pinned blobs');
});

test('native check reports edited UI without overwriting it and rejects unsafe output destinations',t=>{
  const output=fixture(t);passed(native(output));
  const path=join(output,'renderer.js'),changed=read(path)+'\n// synthetic drift\n';writeFileSync(path,changed);
  const check=native(output,'--check');assert.equal(check.status,1);assert.match(check.stderr,/renderer.js/);assert.equal(read(path),changed);
  const unrelated=join(output,'customer-data.txt');writeFileSync(unrelated,'synthetic unrelated file');
  assert.equal(native(output).status,1);assert.equal(read(unrelated),'synthetic unrelated file');
  assert.equal(native(join(repo,'public')).status,1);
  const short=run('tools/build-blueprint-card.py','--source-revision','main','--output-dir',fixture(t));
  assert.equal(short.status,1);assert.match(short.stderr,/40-character commit/);
});

test('native transforms fail closed on changed anchors and unsupported markup',()=>{
  const result=run('-c',String.raw`
import importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('native',Path('tools/build-blueprint-card.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
checks=[lambda:m.adapt_workbench('changed async entry'),lambda:m.adapt_backend('changed backend entry','@@ENDPOINT_METHODS@@'),lambda:m.adapt_inbox('changed inbox entry'),lambda:m.adapt_handoff('changed bridge entry'),lambda:m.component_tree('<div id="cs-card-design"><script>alert(1)</script></div>'),lambda:m.component_tree('<div id="cs-card-design"><button onclick="send()">x</button></div>'),lambda:m.component_tree('<div id="cs-card-design"><span></div>')]
for check in checks:
    try: check()
    except ValueError: pass
    else: raise AssertionError('unreviewed transformation was accepted')
tree=m.component_tree('<div id="cs-card-design"><button data-customer-takeover disabled>Manual &amp; AI</button><input name="text"></div>')
assert tree[2][0][1]['disabled']=='' and tree[2][0][2]==['Manual & AI']
`);passed(result);
});
