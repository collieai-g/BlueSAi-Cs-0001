import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../public/workbench.js',import.meta.url),'utf8');
const start=source.indexOf('    // Model provider and choice controls');
const end=source.indexOf('    function clearAiPolicyChoices(',start);
assert.ok(start>=0&&end>start,'actual AI controls and status painter are present');
const wiring=source.split('\n').filter(line=>
  line.includes("find('[data-model-provider]').addEventListener")||
  line.includes("find('[data-model-choice]').addEventListener")||
  line.includes("find('[data-model-form]').elements.model.addEventListener")||
  line.includes("find('[data-ai-guide]').addEventListener")||
  line.includes("find('[data-model-form]').addEventListener('submit'")||
  line.includes("find('[data-native-codex-form]').addEventListener('submit'")||
  line.includes("find('[data-native-provider]').addEventListener")||
  line.includes("find('[data-native-guide]').addEventListener")||
  line.includes("find('[data-native-disconnect]').addEventListener('click'")||
  line.includes("find('[data-disconnect-ai]').addEventListener('click'"));
assert.equal(wiring.length,10,'actual AI controls retain their event handlers');
function node(value=''){
  return {value,textContent:'',hidden:false,disabled:false,required:false,checked:false,listeners:new Map(),
    addEventListener(name,fn){this.listeners.set(name,fn);},focus(options){this.focusOptions=options;},
    fire(name,submitter){return this.listeners.get(name)?.({currentTarget:this,submitter,preventDefault(){}});}};
}
function fixture(options={}){
  const nodes=new Map();
  for(const name of ['model-form','model-provider','model-choice','model-openai-fields','model-unsupported','model-provider-help','model-custom','model-submit','ai-guide','ai-guide-status','dot-task-form','native-codex-form','native-status','native-availability','native-submit','native-disconnect','ai-status','disconnect-ai','inbox-policy-knowledge','inbox-policy-mode','inbox-policy-status','ai-result','native-result','native-provider','native-consent-label','native-guide','native-guide-status','inbox-policy-automatic-note','inbox-policy'])nodes.set('[data-'+name+']',node());
  const model=node(options.model||''),apiKey=node(''),provider=nodes.get('[data-model-provider]');provider.value='openai';
  nodes.get('[data-model-form]').elements={model,apiKey,provider};nodes.get('[data-inbox-policy]').elements={automaticKnowledge:node(),automaticAi:node()};
  const instruction=node(options.taskDraft||'');nodes.get('[data-dot-task-form]').elements={instruction};
  const consent=node(),nativeProvider=nodes.get('[data-native-provider]');nativeProvider.value='codex';nodes.get('[data-native-codex-form]').elements={consent,provider:nativeProvider};
  const calls={model:[],native:[],clear:0,refresh:0,policyClear:0,reports:[]};let pending;
  const context={
    live:true,busy:false,inboxLoaded:false,modelCustomDraft:'',modelChoiceValue:'',
    snapshot:{connections:{ai:options.ai||{provider:'none',status:'unconfigured',nativeAvailable:false}},knowledge:[]},
    statusNames:{connected:'連線已驗證',configured:'已填資料 · 未測試',error:'連線未成功'},
    find:selector=>{assert.ok(nodes.has(selector),'known DOM selector '+selector);return nodes.get(selector);},
    run:(_button,fn)=>{pending=Promise.resolve().then(fn);return pending;},
    backend:{model:async input=>{calls.model.push({...input});return {message:'synthetic-model-verified'};},nativeCodex:async input=>{calls.native.push({...input});return {message:'synthetic-native-verified'};},clearAI:async()=>{calls.clear++;}},
    refresh:async()=>{calls.refresh++;},clearAiPolicyChoices:()=>{calls.policyClear++;},report:message=>calls.reports.push(message),
  };
  runInNewContext(source.slice(start,end)+'\n'+wiring.join('\n'),context,{filename:'actual-ai-management-handlers.js'});
  context.syncModelChoiceFromValue();context.paintBackgroundAI();
  const selectProvider=value=>{provider.value=value;provider.fire('change');};
  const choose=value=>{nodes.get('[data-model-choice]').value=value;nodes.get('[data-model-choice]').fire('change');};
  const submit=async()=>{nodes.get('[data-model-form]').fire('submit',nodes.get('[data-model-submit]'));await pending;};
  const selectNative=value=>{nativeProvider.value=value;nativeProvider.fire('change');};
  return {context,nodes,model,apiKey,provider,consent,nativeProvider,instruction,calls,choose,selectProvider,selectNative,submit,pending:()=>pending};
}

test('choosing providers or models changes only the view and retains OpenAI draft input',()=>{
  const f=fixture({model:'synthetic-custom-model'});f.apiKey.value='synthetic-openai-draft-key';
  for(const provider of ['anthropic','gemini','other']){
    f.selectProvider(provider);
    assert.equal(f.nodes.get('[data-model-openai-fields]').hidden,true);
    assert.equal(f.nodes.get('[data-model-unsupported]').hidden,false);
    assert.equal(f.nodes.get('[data-model-submit]').disabled,true);
    assert.match(f.nodes.get('[data-model-provider-help]').textContent,/尚未支援/);
    assert.equal(f.model.value,'synthetic-custom-model');assert.equal(f.apiKey.value,'synthetic-openai-draft-key');
  }
  f.selectProvider('openai');assert.equal(f.nodes.get('[data-model-openai-fields]').hidden,false);assert.equal(f.nodes.get('[data-model-submit]').disabled,false);
  assert.equal(f.nodes.get('[data-model-choice]').value,'custom');
  assert.deepEqual(f.calls.model,[]);assert.deepEqual(f.calls.native,[]);assert.equal(f.calls.clear,0);
});

test('unsupported provider submission fails before reading a key or reaching the OpenAI backend',async()=>{
  for(const provider of ['anthropic','gemini','other','unknown-provider']){
    const f=fixture({model:'synthetic-model'});f.selectProvider(provider);
    Object.defineProperty(f.apiKey,'value',{get(){assert.fail('an unsupported provider must never read the OpenAI key field');},set(){assert.fail('an unsupported provider must preserve the OpenAI key field');}});
    await assert.rejects(f.submit(),/尚未支援/);assert.equal(f.calls.model.length,0);assert.equal(f.calls.refresh,0);
  }
});

test('reference choices drive the actual submitted model while custom model drafts survive switching',async()=>{
  const f=fixture({model:'synthetic-saved-model'});assert.equal(f.nodes.get('[data-model-choice]').value,'custom');
  f.model.value='synthetic-unsaved-custom';f.model.fire('input');
  for(const model of ['gpt-6-luna','gpt-6.1-sol']){
    f.choose(model);assert.equal(f.model.value,model);assert.equal(f.nodes.get('[data-model-custom]').hidden,true);
    f.selectProvider('anthropic');f.context.paintBackgroundAI();f.selectProvider('openai');assert.equal(f.model.value,model);
    f.apiKey.value='synthetic-explicit-key';await f.submit();assert.deepEqual(f.calls.model.at(-1),{model,apiKey:'synthetic-explicit-key'});assert.equal(f.apiKey.value,'');
  }
  f.choose('custom');assert.equal(f.model.value,'synthetic-unsaved-custom');assert.equal(f.nodes.get('[data-model-custom]').hidden,false);assert.equal(f.model.required,true);
  f.context.paintBackgroundAI();assert.equal(f.model.value,'synthetic-unsaved-custom');
});

test('the model control never preselects a reference or silently replaces a saved model',async()=>{
  const empty=fixture();assert.equal(empty.nodes.get('[data-model-choice]').value,'');assert.equal(empty.model.value,'');
  await assert.rejects(empty.submit(),/選擇模型/);assert.equal(empty.calls.model.length,0);
  for(const model of ['gpt-6-luna','gpt-6.1-sol','synthetic-existing-model']){
    const f=fixture({model});assert.equal(f.model.value,model);assert.equal(f.nodes.get('[data-model-choice]').value,model.startsWith('synthetic')?'custom':model);assert.equal(f.calls.model.length,0);
  }
});

test('switching the provider selector keeps the actual OpenAI disconnect action',async()=>{
  const f=fixture({ai:{provider:'openai',status:'connected',model:'synthetic-current',nativeAvailable:false}});
  f.selectProvider('gemini');f.context.paintBackgroundAI();
  assert.equal(f.nodes.get('[data-disconnect-ai]').disabled,false);assert.match(f.nodes.get('[data-ai-status]').textContent,/OpenAI/);
  f.nodes.get('[data-disconnect-ai]').fire('click');await f.pending();assert.equal(f.calls.clear,1);assert.equal(f.calls.policyClear,1);assert.equal(f.calls.model.length,0);
});

test('AI guidance fills an editable task draft without reading credentials or invoking AI',()=>{
  const f=fixture();f.selectProvider('anthropic');
  Object.defineProperty(f.apiKey,'value',{get(){assert.fail('guidance must not read a key');}});
  f.nodes.get('[data-ai-guide]').fire('click');
  assert.match(f.instruction.value,/Anthropic/);assert.match(f.instruction.value,/不建立金鑰/);assert.match(f.nodes.get('[data-ai-guide-status]').textContent,/尚未呼叫 AI/);
  assert.equal(f.instruction.focusOptions.preventScroll,true);assert.equal(f.calls.model.length,0);assert.equal(f.calls.native.length,0);assert.equal(f.calls.refresh,0);
  const occupied=fixture({taskDraft:'synthetic unsaved task that must stay'});occupied.selectProvider('other');occupied.nodes.get('[data-ai-guide]').fire('click');
  assert.equal(occupied.instruction.value,'synthetic unsaved task that must stay');assert.match(occupied.nodes.get('[data-ai-guide-status]').textContent,/已為你保留/);
});

test('native Codex still requires capability and explicit consent and remains independent of API choices',async()=>{
  const f=fixture({ai:{provider:'none',status:'unconfigured',nativeAvailable:true}});f.selectProvider('gemini');
  f.nodes.get('[data-native-codex-form]').fire('submit',f.nodes.get('[data-native-submit]'));await assert.rejects(f.pending(),/同意/);assert.equal(f.calls.native.length,0);
  f.consent.checked=true;f.nodes.get('[data-native-codex-form]').fire('submit',f.nodes.get('[data-native-submit]'));await f.pending();assert.deepEqual(f.calls.native,[{consent:true}]);assert.equal(f.consent.checked,false);assert.equal(f.calls.model.length,0);
  const unavailable=fixture();assert.equal(unavailable.nodes.get('[data-native-submit]').disabled,true);
});

test('native choices expose true availability without treating Grok or Claude as Codex',async()=>{
  const f=fixture({ai:{provider:'codex-cli',status:'connected',nativeAvailable:true}});
  for(const provider of ['grok','claude']){
    f.consent.checked=true;f.selectNative(provider);
    assert.equal(f.consent.checked,false,'changing a local route requires new consent');assert.equal(f.consent.disabled,true);
    assert.equal(f.nodes.get('[data-native-submit]').disabled,true);assert.match(f.nodes.get('[data-native-availability]').textContent,/此版本尚未提供/);
    assert.match(f.nodes.get('[data-native-availability]').textContent,/未檢查安裝或登入/);
    assert.match(f.nodes.get('[data-native-status]').textContent,/Codex/,'actual connected route stays separate from the selected candidate');
    assert.equal(f.nodes.get('[data-native-disconnect]').hidden,false,'the actual Codex connection can still be stopped');
    f.nodes.get('[data-native-codex-form]').fire('submit',f.nodes.get('[data-native-submit]'));await assert.rejects(f.pending(),/尚未提供/);
  }
  assert.equal(f.calls.native.length,0);assert.equal(f.calls.model.length,0);assert.equal(f.calls.clear,0);
  f.selectNative('codex');assert.equal(f.consent.checked,false);assert.equal(f.consent.disabled,false);assert.equal(f.nodes.get('[data-native-submit]').disabled,false);
  const unavailable=fixture();assert.match(unavailable.nodes.get('[data-native-availability]').textContent,/尚未提供 Codex 執行器/);assert.doesNotMatch(unavailable.nodes.get('[data-native-availability]').textContent,/已登入/);
  f.selectNative('grok');f.nodes.get('[data-native-disconnect]').fire('click');await f.pending();assert.equal(f.calls.clear,1,'disconnect targets the actual Codex connection even while Grok is selected');
});

test('native login guidance is editable and never attempts an unsupported login or reads credentials',()=>{
  const f=fixture();f.selectNative('claude');Object.defineProperty(f.apiKey,'value',{get(){assert.fail('native guidance must not read API credentials');}});
  f.nodes.get('[data-native-guide]').fire('click');assert.match(f.instruction.value,/Claude 本機登入/);assert.match(f.instruction.value,/不要改用 API key/);assert.match(f.instruction.value,/不登入/);
  assert.equal(f.calls.native.length,0);assert.equal(f.calls.model.length,0);assert.match(f.nodes.get('[data-native-guide-status]').textContent,/尚未呼叫 AI/);
  const draft=f.instruction.value;f.selectNative('grok');f.nodes.get('[data-native-guide]').fire('click');assert.equal(f.instruction.value,draft);assert.match(f.nodes.get('[data-native-guide-status]').textContent,/已為你保留/);
});

test('the compact source exposes honest selectable providers and a reduced-motion decorative diagram',()=>{
  const html=readFileSync(new URL('../public/workbench.html',import.meta.url),'utf8'),css=readFileSync(new URL('../public/agent-card.css',import.meta.url),'utf8');
  const providers=html.match(/<select\b[^>]*data-model-provider[\s\S]*?<\/select>/)?.[0];assert.ok(providers);
  for(const provider of ['openai','anthropic','gemini','other']){const option=providers.match(new RegExp('<option value="'+provider+'"[^>]*>[^<]*<\/option>'))?.[0];assert.ok(option,provider);assert.doesNotMatch(option,/disabled/);}
  assert.match(providers,/Anthropic · 尚未支援/);assert.match(providers,/Google Gemini · 尚未支援/);
  const native=html.match(/<select\b[^>]*data-native-provider[\s\S]*?<\/select>/)?.[0];assert.ok(native);
  for(const provider of ['codex','grok','claude'])assert.match(native,new RegExp('<option value="'+provider+'"'));
  assert.match(html,/目前只提供 Codex 本機接駁/);
  assert.match(html,/實際可用性及本客服相容性在接駁時核對/);assert.match(html,/這不是你的帳戶模型清單/);
  assert.ok(html.indexOf('<h3>模型 API</h3>')<html.indexOf('<h3>本機登入</h3>'),'model choices precede native Codex in both visual and keyboard reading order');
  assert.match(html,/role="img" aria-label="接駁流程示意/);
  assert.match(css,/@keyframes\s+bluesai-cs-ai-flow/);
  assert.match(css,/@media\s*\(prefers-reduced-motion:\s*reduce\)[^{]*\{[^{}]*\.bp-ai-flow-icon[^{}]*\{[^{}]*animation:\s*none\s*!important/);
});
