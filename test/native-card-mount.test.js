import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

// Synthetic host DOM: no running Studio, private store, account or channel.
class Element {
  constructor(tag){this.tagName=tag;this.children=[];this.parentNode=null;this.dataset={};this.className='';this.hidden=false;this.value='';}
  setAttribute(name,value){
    if(name==='class')this.className=value;
    else if(name==='hidden')this.hidden=true;
    else if(name.startsWith('data-'))this.dataset[name.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=value;
    else this[name]=value;
  }
  append(...nodes){for(const node of nodes){node.remove();node.parentNode=this;this.children.push(node);}}
  remove(){if(this.parentNode){this.parentNode.children=this.parentNode.children.filter(node=>node!==this);this.parentNode=null;}}
  contains(node){return node===this||this.children.some(child=>child.contains?.(node));}
  get isConnected(){return this.tagName==='body'||!!this.parentNode?.isConnected;}
  matches(selector){if(selector.startsWith('.'))return this.className.split(/\s+/).includes(selector.slice(1));return false;}
  querySelector(selector){
    for(const child of this.children){
      if(selector==='[data-screen="config"]'&&child.dataset?.screen==='config')return child;
      if(selector==='[data-screen="list"]'&&child.dataset?.screen==='list')return child;
      if(selector==='textarea'&&child.tagName==='textarea')return child;
      const nested=child.querySelector?.(selector);if(nested)return nested;
    }
    return null;
  }
}
function fixture({hostReady=true}={}){
  const body=new Element('body'),listeners=new Map(),registrations=[],observers=[],calls=[];
  const document={body,hidden:false,activeElement:null,createElement:tag=>new Element(tag),createTextNode:value=>{const node=new Element('#text');node.textContent=value;return node;}};
  const registry={registerCardRenderer:(id,renderer)=>registrations.push({id,renderer})};
  const window={document,addEventListener:(name,callback)=>listeners.set(name,callback),dispatchEvent:()=>{},BlueprintAgents:hostReady?registry:undefined};window.top=window;
  class MutationObserver {constructor(callback){this.callback=callback;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}}
  const revision='a'.repeat(40),agent={id:'synthetic-agent',manifest:{id:'bluesai-cs-0001'},source:{repository:'https://github.com/collieai-g/BlueSAi-Cs-0001',revision}};
  const sandbox=createContext({window,document,MutationObserver,Event:class{constructor(type){this.type=type;}},setInterval,clearInterval,setTimeout,clearTimeout,
    fetch:async path=>{calls.push(path);return {ok:true,json:async()=>({agent_id:agent.id,product_id:agent.manifest.id,source_revision:revision,renderer:'bluesai-management/1',api:'bluesai-management-api/1',sse:false})};},
    createBackend:()=>({synthetic:true}),createAgentBridge:()=>({}),initializeInboxTools:()=>{},initializeWorkbench:async root=>{root.hidden=false;return {isBusy:()=>false,showEntry(){root.querySelector('[data-screen="config"]').hidden=true;root.querySelector('[data-screen="list"]').hidden=false;}};},
  });
  const tree=['div',{id:'cs-card-design',hidden:''},[['section',{'data-screen':'list'},[]],['section',{'data-screen':'config',hidden:''},[['textarea',{},[]]]]]];
  const source=readFileSync(new URL('../integrations/blueprint/native/renderer.js.tmpl',import.meta.url),'utf8')
    .replace(/^import .*;\r?\n/gm,'').replaceAll('export ','').replace('@@SOURCE_REVISION@@',revision).replace('@@COMPONENT_TREE@@',JSON.stringify(tree));
  runInContext(source,sandbox);
  const api=runInContext('({mount,layoutSpec,pause,isBusy})',sandbox);
  const panel=new Element('main'),target=new Element('div');target.dataset.agentCardTarget=agent.id;panel.append(target);body.append(panel);
  let renders=0,current=true;
  const context={panel,cardTarget:target,state:{identity:{username:'synthetic-owner',role:'owner'}},isCurrent:()=>current,onRendered:()=>renders++};
  return {agent,api,body,panel,target,context,calls,listeners,registrations,registry,window,observers,get renders(){return renders;},setCurrent:value=>{current=value;}};
}

test('reviewed native renderer registers with an early or late host without page injection',()=>{
  for(const hostReady of [true,false]){
    const f=fixture({hostReady});
    if(!hostReady){assert.equal(f.registrations.length,0);f.window.BlueprintAgents=f.registry;f.listeners.get('blueprint:agents-ready')();}
    assert.equal(f.registrations.length,1);
    assert.equal(f.registrations[0].id,'bluesai-cs-0001');
    assert.equal(f.registrations[0].renderer.mount,f.api.mount);
    assert.equal(f.body.children.length,1,'registration alone does not mount or replace a host page');
    assert.equal(f.calls.length,0,'registration does not read private binding or connect a channel');
  }
});

test('native mount requires the dedicated host target and never inserts beside generic settings',async()=>{
  const f=fixture();delete f.context.cardTarget;
  let legacyInsertion=false;f.panel.insertBefore=()=>{legacyInsertion=true;};
  await assert.rejects(f.api.mount(f.context,f.agent),/單一卡片掛載接口/);
  assert.equal(legacyInsertion,false);
  assert.equal(f.calls.length,0,'missing host capability fails before any binding access');
  assert.equal(f.panel.children.length,1);
});

test('native mount uses one target and reattaches the same draft DOM after parking',async()=>{
  const f=fixture();
  // The host can prepare a connected surface outside the visible page while
  // awaiting the renderer, so partial cards never enter its layout engine.
  f.body.append(f.target);assert.equal(f.panel.contains(f.target),false);
  assert.equal(await f.api.mount(f.context,f.agent),true);
  assert.equal(f.target.children.length,1);
  const wrapper=f.target.children[0],draft=wrapper.querySelector('textarea');draft.value='synthetic unsent draft';
  const entry=f.api.layoutSpec(wrapper);
  assert.equal(entry.min.h,18);assert.equal(entry.defaultSize.h,18);assert.equal(entry.max.h,24);assert.equal(entry.aspectRatio,undefined,'entry presentation remains flexible');
  const config=wrapper.querySelector('[data-screen="config"]');config.hidden=false;
  f.observers.at(-1).callback();
  assert.equal(wrapper.dataset.bluesaiMode,'expanded');
  const expanded=f.api.layoutSpec(wrapper);assert.equal(expanded.defaultSize.w,36);assert.equal(expanded.aspectRatio,4/3);for(const key of ['min','defaultSize','max'])assert.equal(expanded[key].w/expanded[key].h,4/3,key+' stays on the same ratio');assert.equal(expanded.min.h,18);assert.equal(expanded.defaultSize.h,27);assert.equal(expanded.max.h,36);
  assert.equal(f.renders,1,'mode changes ask the host to resize its existing single surface');
  f.target.remove();f.observers[0].callback();
  const target=new Element('div');target.dataset.agentCardTarget=f.agent.id;f.panel.append(target);
  assert.equal(await f.api.mount({...f.context,cardTarget:target},f.agent),true);
  assert.equal(target.children[0],wrapper,'route return reuses the same component');
  assert.equal(wrapper.querySelector('textarea'),draft);
  assert.equal(draft.value,'synthetic unsent draft');
  assert.equal(target.children.length,1,'there is no second native card');
});

test('unsupported source and stale or non-admin contexts do not mount a customer component',async()=>{
  const f=fixture();
  assert.equal(await f.api.mount(f.context,{...f.agent,source:{...f.agent.source,revision:'b'.repeat(40)}}),false);
  assert.equal(f.calls.length,0);
  assert.equal(await f.api.mount({...f.context,state:{identity:{username:'synthetic-member',role:'member'}}},f.agent),false);
  assert.equal(f.calls.length,0);
  f.setCurrent(false);assert.equal(await f.api.mount(f.context,f.agent),false);
  assert.equal(f.target.children.length,0);
});

test('Agent home opens and returns to the same native entry without losing the conversation draft',async()=>{
  const f=fixture(),opened=[];
  const home={...f.context,openCard:id=>opened.push(id)};
  assert.equal(await f.api.mount(home,f.agent),true);
  const wrapper=f.target.children[0],draft=wrapper.querySelector('textarea');draft.value='synthetic in-progress reply';
  const config=wrapper.querySelector('[data-screen="config"]');config.hidden=false;
  f.observers.at(-1).callback();
  assert.deepEqual(opened,[f.agent.id]);
  assert.equal(wrapper.dataset.bluesaiMode,'expanded','mode changes before the host route opens');
  assert.equal(f.renders,0,'home opening navigates instead of resizing a second card');

  f.target.remove();f.observers[0].callback();
  const detailTarget=new Element('div');detailTarget.dataset.agentCardTarget=f.agent.id;f.panel.append(detailTarget);
  assert.equal(await f.api.mount({...f.context,cardTarget:detailTarget},f.agent),true);
  assert.equal(detailTarget.children[0],wrapper);
  assert.equal(config.hidden,false,'detail keeps the view chosen on the home entry');
  assert.equal(wrapper.querySelector('textarea'),draft);

  detailTarget.remove();f.observers[0].callback();
  const nextHomeTarget=new Element('div');nextHomeTarget.dataset.agentCardTarget=f.agent.id;f.panel.append(nextHomeTarget);
  assert.equal(await f.api.mount({...home,cardTarget:nextHomeTarget},f.agent),true);
  f.observers.at(-1).callback();
  assert.equal(nextHomeTarget.children[0],wrapper);
  assert.equal(config.hidden,true,'returning home shows the existing entry view');
  assert.equal(wrapper.dataset.bluesaiMode,'entry');
  assert.equal(draft.value,'synthetic in-progress reply');
  assert.deepEqual(opened,[f.agent.id],'returning home never reopens the detail route');
  assert.equal(nextHomeTarget.children.length,1);
});
