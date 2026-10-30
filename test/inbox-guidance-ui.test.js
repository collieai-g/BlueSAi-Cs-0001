import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../public/workbench.js',import.meta.url),'utf8');
const start=source.indexOf('    // Inbox reception guidance');
const end=source.indexOf('    // End inbox reception guidance',start);
assert.ok(start>=0&&end>start,'actual reception guidance handlers are present');
function node(){return {dataset:{},hidden:false,disabled:false,value:'',textContent:'',children:[],listeners:new Map(),attributes:new Map(),scrollTop:0,append(...items){this.children.push(...items);},replaceChildren(){this.children=[];},get firstElementChild(){return this.children[0];},setAttribute(name,value){this.attributes.set(name,value);},addEventListener(name,fn){this.listeners.set(name,fn);},click(){return this.listeners.get('click')?.({currentTarget:this});}};}

test('the inbox retains only customer and pending filters and excludes self tests from every customer list',()=>{
  assert.doesNotMatch(source,/data-customer-refresh|data-queue-filter="(?:human|tests)"|data-open-self-tests|data-inbox-self-only/);
  const first=source.indexOf('    function queueBase()'),last=source.indexOf('    function activeCustomerContext(',first);
  const nodes=new Map(),find=selector=>{if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector);};
  const context={find,inboxLoaded:true,inboxSummary:{conversations:[
    {id:'auto',channel:'evolution',state:'ai'},{id:'manual',channel:'evolution',state:'human'},
    {id:'waiting',channel:'evolution',state:'waiting'},{id:'pending',channel:'evolution',state:'ai',pending:1},
    {id:'web',channel:'web',state:'ai'},{id:'self',channel:'whatsapp_self_test',state:'self_readonly'},
  ],pendingHandoffs:[]},snapshot:{connections:{webChat:{enabled:true}}},state:{queueFilter:'customers',queueSearch:''},
    selectedCustomerId:null,queueSignature:'',customerStates:{ai:'AI',human:'人工',waiting:'待處理'},document:{createElement:()=>node()},paintConnection:()=>{},paintManagement:()=>{}};
  runInNewContext(source.slice(first,last),context);
  assert.deepEqual(Array.from(context.queueBase(),c=>c.id),['auto','manual','waiting','pending','web']);
  context.paintQueue();assert.equal(find('[data-queue-count="customers"]').textContent,5);assert.equal(find('[data-queue-count="waiting"]').textContent,2);
  context.state.queueFilter='waiting';assert.deepEqual(Array.from(context.queueRows(),c=>c.id),['waiting','pending']);
  context.snapshot.connections.webChat.enabled=false;assert.ok(!context.queueBase().some(c=>c.id==='web'));
  const chooseStart=source.indexOf('    function chooseQueueFilter('),chooseEnd=source.indexOf('    function openManagement(',chooseStart);
  context.busy=false;context.saveCurrentReply=()=>assert.fail('a retired filter cannot change or refresh a conversation');
  runInNewContext(source.slice(chooseStart,chooseEnd),context);context.chooseQueueFilter('human');context.chooseQueueFilter('tests');assert.equal(context.state.queueFilter,'waiting');
});

test('the successful refresh stamp uses 24-hour hours and minutes and remains unchanged when receiving fails',async()=>{
  const first=source.indexOf('    async function refreshCustomers()'),last=source.indexOf('\n    ',first+5);
  assert.ok(first>=0&&last>first);
  const nodes=new Map(),find=selector=>{if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector);};
  let currentTime=new Date(2026,9,28,21,54).getTime();
  class Clock extends Date{constructor(...args){super(...(args.length?args:[currentTime]));}static now(){return currentTime;}}
  const context={Date:Clock,find,live:true,customerPolling:false,customerRefreshPending:false,selfReplyEpoch:0,inboxLoaded:false,
    backend:{inbox:async()=>({conversations:[]})},refreshKnowledgeForInbox:async value=>value,paintInboxSummary:()=>{},queueBase:()=>[],queueRows:()=>[],
    customerPickerSignature:'',selectedCustomerId:null,customerSelectionMade:false,customerSignature:'',root:{isConnected:true},
    document:{createElement:()=>node()},paintCustomerDetail:()=>{},paintQueue:()=>{},paintInboxReceiveState:()=>{},
    emptyInboxInfo:()=>({title:'Waiting',next:'New message'}),customerNotice:()=>{},inboxHadReadError:false,busy:false};
  runInNewContext(source.slice(first,last),context);await context.refreshCustomers();assert.equal(find('[data-inbox-updated]').textContent,'最近更新 21:54');
  currentTime=new Date(2026,9,29,0,7).getTime();context.backend.inbox=async()=>{throw Error('synthetic offline');};
  await assert.rejects(context.refreshCustomers(),/synthetic offline/);assert.equal(find('[data-inbox-updated]').textContent,'最近更新 21:54');assert.equal(find('[data-inbox-error]').hidden,false);
  context.backend.inbox=async()=>({conversations:[]});await context.refreshCustomers();assert.equal(find('[data-inbox-updated]').textContent,'最近更新 00:07');assert.equal(find('[data-inbox-error]').hidden,true);
});

test('SSE and periodic polling keep reading new messages without a manual refresh action',async()=>{
  let stream,poll,reads=0,clears=0;const pageEvents=new Map();
  class Stream{constructor(){stream=this;this.listeners=new Map();}addEventListener(name,fn){this.listeners.set(name,fn);}close(){this.closed=true;}}
  const first=source.indexOf('    function setupInboxTools()'),last=source.indexOf("    find('[data-learning-open-settings]')",first);
  const context={live:true,inboxToolsReady:false,root:{isConnected:true,csInboxTools:{register(){}}},document:{hidden:false},busy:false,
    EventSource:Stream,inboxEventStream:null,window:{addEventListener:(name,fn)=>pageEvents.set(name,fn)},refreshCustomers:async()=>{reads++;},
    setInterval:fn=>{poll=fn;return 9;},clearInterval:()=>{clears++;}};
  runInNewContext(source.slice(first,last),context);context.setupInboxTools();stream.listeners.get('change')();assert.equal(reads,1);
  const timer=source.split('\n').find(line=>line.includes('const inboxPollTimer=setInterval('));runInNewContext(timer,context);poll();assert.equal(reads,2);
  context.busy=true;stream.listeners.get('change')();poll();assert.equal(reads,2);context.busy=false;context.document.hidden=true;stream.listeners.get('change')();poll();assert.equal(reads,2);
  context.document.hidden=false;context.root.isConnected=false;poll();assert.equal(clears,1);assert.equal(stream.closed,true);
});
function fixture(wa={},options={}){
  const nodes=new Map();for(const name of ['customer-messages','inbox-receive-state','queue-search'])nodes.set('[data-'+name+']',node());
  const calls={receive:0,manage:0,queue:0,render:0};
  const context={snapshot:{connections:{mode:options.mode||'preview',whatsapp:wa}},inboxScope:null,inboxSummary:{conversations:[],policy:{}},state:{queueFilter:options.filter||'customers',queueSearch:options.search||'',mobileList:false},
    find:selector=>{assert.ok(nodes.has(selector),selector);return nodes.get(selector);},document:{createElement:()=>node()},
    queueBase:()=>options.base||[],queueRows:()=>options.rows||[],inboxHistoryLimit:()=> 'Synthetic history boundary: new private text only.',
    openWhatsAppReceiveSettings:()=>{calls.receive++;},openManagement:()=>{calls.manage++;},paintQueue:()=>{calls.queue++;},render:()=>{calls.render++;},
    backend:new Proxy({},{get(){assert.fail('painting and opening guidance must not register, grant scope or send');}}),
  };
  runInNewContext(source.slice(start,end),context,{filename:'actual-inbox-reception-guidance.js'});
  const render=()=>{context.paintEmptyInbox();return nodes.get('[data-customer-messages]').firstElementChild;};
  const action=empty=>empty.children.find(item=>item.className==='bp-actions')?.children[0];
  return {context,nodes,calls,render,action};
}

test('a linked phone with reception disabled shows an actionable consent route, never a fake conversation',()=>{
  const f=fixture({status:'open',receiveSetupAvailable:true,inboxScope:{available:true,mode:'test',consented:false},webhook:{registered:false}});
  const empty=f.render();assert.match(empty.children[0].textContent,/接收尚未啟動/);
  assert.equal(f.action(empty).textContent,'設定 WhatsApp 收件');assert.equal(f.calls.receive,0);
  f.action(empty).click();assert.equal(f.calls.receive,1);assert.equal(f.calls.manage,0);
  assert.equal(f.nodes.get('[data-customer-messages]').children.length,1);assert.equal(empty.dataset.inboxEmpty,'true');
});

test('runtime alone cannot advertise a receiver and all three live receive conditions must be confirmed',()=>{
  const unsupported=fixture({status:'open'},{mode:'runtime'}),empty=unsupported.render();assert.equal(unsupported.action(empty).textContent,'查看渠道設定');assert.match(empty.children[1].textContent,/尚未提供即時收件能力/);
  const base={status:'open',receiveSetupAvailable:true,receiveEnabled:true,inboxScope:{available:true,mode:'all_private_text',consented:true},webhook:{registered:true}};
  for(const wa of [{...base,receiveEnabled:false},{...base,inboxScope:{...base.inboxScope,consented:false}},{...base,webhook:{registered:false}}])assert.match(fixture(wa).render().children[0].textContent,/接收尚未啟動/);
  const ready=fixture(base),waiting=ready.render();assert.match(waiting.children[0].textContent,/收件已啟用/);assert.equal(ready.action(waiting),undefined);assert.match(waiting.children[1].textContent,/舊訊息不會匯入/);
});

test('automatic local receiving shows real progress, failures and verified readiness without a setup form',()=>{
  const base={autoReceiveOnConnect:true,status:'open',receiveSetupAvailable:true,inboxScope:{available:true,mode:'test',consented:false},webhook:{registered:false}};
  const preparing=fixture({...base,autoReceiveStatus:'preparing'}),pending=preparing.render();
  assert.match(pending.children[0].textContent,/正在準備/);assert.equal(preparing.action(pending),undefined);
  const failure=fixture({...base,autoReceiveStatus:'error'}),empty=failure.render();assert.match(empty.children[0].textContent,/未完成/);assert.equal(failure.action(empty).textContent,'重試接駁');
  const changed=fixture({...base,autoReceiveStatus:'account_changed'}),account=changed.render();assert.match(account.children[0].textContent,/帳戶需要重新核對/);assert.equal(changed.action(account).textContent,'查看手機接駁');
  const unknown=fixture({...base,autoReceiveStatus:'status_unknown'}),unreadable=unknown.render();assert.match(unreadable.children[0].textContent,/未能讀取/);assert.doesNotMatch(unreadable.children[0].textContent,/已啟用/);
  const ready={...base,autoReceiveStatus:'receiving',receiveEnabled:true,inboxScope:{available:true,mode:'all_private_text',consented:true},webhook:{registered:true}};
  const done=fixture(ready),waiting=done.render();assert.match(waiting.children[0].textContent,/收件已啟用/);assert.equal(done.action(waiting),undefined);
  for(const wa of [{...ready,receiveEnabled:false},{...ready,webhook:{registered:false}},{...ready,inboxScope:{...ready.inboxScope,consented:false}},{...ready,autoReceiveStatus:'preparing'}])assert.doesNotMatch(fixture(wa).render().children[0].textContent,/收件已啟用/);
});

test('retry for automatic receiving runs only on an explicit click and never sends a message',async()=>{
  const f=fixture({autoReceiveOnConnect:true,autoReceiveStatus:'error',status:'open'}),empty=f.render(),button=f.action(empty);let requested=0,refreshes=0,pending;
  f.nodes.set('[data-customer-messages] [data-inbox-setup-action="retry"]',button);
  f.context.backend={retryWhatsAppAutoReceive:async()=>{requested++;}};f.context.run=(_button,fn)=>{pending=fn();};f.context.refresh=async()=>{refreshes++;};
  assert.equal(requested,0);button.click();await pending;assert.equal(requested,1);assert.equal(refreshes,1);
});

test('automatic receiver status polling does not overwrite newer state and closes displayed readiness on read failure',async()=>{
  const first=source.indexOf('    let autoReceivePolling=false;'),last=source.indexOf("    window.addEventListener('pagehide'",first);assert.ok(first>=0&&last>first);
  let tick,finish;const wa={autoReceiveOnConnect:true,autoReceiveStatus:'preparing',status:'open',readiness:{canSend:true}};
  const state={snapshot:{connections:{whatsapp:wa}},inboxScope:null,live:true,busy:false,document:{hidden:false},root:{isConnected:true},whatsappLink:{active:false},currentCustomerData:null,
    setInterval:fn=>{tick=fn;return 7;},clearInterval:()=>{},backend:{load:()=>new Promise(resolve=>{finish=resolve;})},
    paintConnection:()=>{},paintManagement:()=>{},paintInboxReceiveState:()=>{},paintWhatsAppLink:()=>{},paintCustomerDetail:()=>{},paintEmptyInbox:()=>{}};
  runInNewContext(source.slice(first,last),state);const ongoing=tick();state.snapshot.connections={whatsapp:{...wa,autoReceiveStatus:'receiving'}};
  finish({connections:{whatsapp:{...wa,autoReceiveStatus:'preparing'}}});await ongoing;assert.equal(state.snapshot.connections.whatsapp.autoReceiveStatus,'receiving');
  state.backend.load=async()=>{throw Error('offline');};await tick();assert.equal(state.snapshot.connections.whatsapp.autoReceiveStatus,'status_unknown');assert.equal(state.snapshot.connections.whatsapp.receiveEnabled,false);assert.equal(state.snapshot.connections.whatsapp.readiness.canSend,false);
});

test('a filter with no matches directs users to existing conversations rather than claiming reception is off',()=>{
  const f=fixture({status:'open'},{filter:'waiting',search:'synthetic search',base:[{id:'synthetic',channel:'evolution'}]});
  const empty=f.render();assert.match(empty.children[0].textContent,/篩選沒有對話/);f.action(empty).click();
  assert.equal(f.context.state.queueFilter,'customers');assert.equal(f.context.state.queueSearch,'');assert.equal(f.context.state.mobileList,false,'filtering never switches away from a persistent conversation region');assert.equal(f.calls.receive,0);
});

test('the actual empty conversation painter leaves manual, return and DOT controls visible but safely disabled',()=>{
  const detailStart=source.indexOf('    function paintCustomerDetail('),detailEnd=source.indexOf('    function paintInboxSummary(',detailStart);
  assert.ok(detailStart>=0&&detailEnd>detailStart);
  const nodes=new Map(),drafts=new Map([['synthetic-conversation','synthetic unsent reply']]);
  const find=selector=>{if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector);};find('[data-customer-reply-form]').elements={text:node()};
  const context={find,currentCustomerData:null,customerSignature:'',replyDrafts:drafts,syncSelfReplyOperation:()=>{},paintThreadContext:()=>{},paintSelfReply:()=>{},paintEmptyInbox:()=>{}};
  runInNewContext(source.slice(detailStart,detailEnd),context);context.paintCustomerDetail(null);
  for(const selector of ['[data-customer-takeover]','[data-customer-resume]','[data-inbox-dot-call]']){assert.equal(find(selector).hidden,false,selector);assert.equal(find(selector).disabled,true,selector);}
  assert.match(find('[data-inbox-control-help]').textContent,/下一筆新來訊/);assert.equal(drafts.get('synthetic-conversation'),'synthetic unsent reply');
});

test('returning a human conversation restores the saved policy for new messages without replaying old drafts',()=>{
  const line=source.split('\n').find(value=>value.includes("find('[data-customer-resume]').disabled=selfTest"));assert.ok(line);
  for(const [enabled,aiStatus,disabled] of [[false,'unconfigured',true],[false,'connected',false],[true,'unconfigured',false],[true,'connected',false]]){
    const nodes=new Map(),find=selector=>{if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector);};
    runInNewContext(line,{find,selfTest:false,selfReady:false,c:{state:'human'},inboxSummary:{policy:{enabled,aiFallback:enabled}},snapshot:{connections:{whatsapp:{automaticRepliesAvailable:true},ai:{status:aiStatus}}}});
    assert.equal(find('[data-customer-resume]').disabled,disabled);
    const help=find('[data-inbox-control-help]').textContent;assert.match(help,/下一則新來訊/);assert.match(help,/草稿不會補發/);assert.doesNotMatch(help,/不會自動發送|預設人工/);
  }
});

test('local reception never enables preview self-message tests through a stale checkbox',async()=>{
  const handler=source.split('\n').find(line=>line.includes("find('[data-inbox-scope-enable]').addEventListener('click'"));assert.ok(handler);
  const nodes=new Map();for(const name of ['inbox-scope-enable','inbox-scope-consent','inbox-reply-consent','inbox-self-test-consent'])nodes.set('[data-'+name+']',node());
  nodes.get('[data-inbox-scope-consent]').checked=true;nodes.get('[data-inbox-reply-consent]').checked=true;nodes.get('[data-inbox-self-test-consent]').checked=true;
  const requests=[];let pending;const context={find:selector=>nodes.get(selector),snapshot:{connections:{whatsapp:{selfTestReply:{available:false}}}},inboxScope:null,selfScopeDirty:true,run:(_button,fn)=>{pending=fn();},backend:{configureWhatsAppInboxScope:async input=>{requests.push({...input});return input;}},refresh:async()=>{},paintInboxScope:()=>{},report:()=>{}};
  runInNewContext(handler,context);nodes.get('[data-inbox-scope-enable]').click();await pending;
  assert.deepEqual(requests,[{mode:'all_private_text',consent:true,replyToReceived:true,includeSelfTests:false}]);
});


test('local automatic FAQ and AI policy controls can save and read back the selected automation',async()=>{
  const modeStart=source.indexOf('    function policyMode('),modeEnd=source.indexOf('    // Model provider and choice controls',modeStart);
  const context={snapshot:{connections:{whatsapp:{automaticRepliesAvailable:true},ai:{status:'connected'}}},inboxSummary:{policy:{enabled:true,aiFallback:true,automaticAi:true,automaticKnowledge:true}}};
  runInNewContext(source.slice(modeStart,modeEnd),context);assert.equal(context.policyMode(),'AI 有據自動答');assert.match(context.policyDescription(),/FAQ 完全吻合時按授權自動發送/);assert.match(context.policyDescription(),/AI 答案才可按授權自動發送/);
  assert.equal(context.policyMode({enabled:true,automaticKnowledge:true}),'FAQ 自動答');assert.equal(context.policyMode({enabled:true,automaticKnowledge:false}),'FAQ 草稿');
  const handler=source.split('\n').find(line=>line.includes("find('[data-inbox-policy]').addEventListener('submit'"));assert.ok(handler);
  for(const flags of [{automaticKnowledge:true,aiFallback:false,automaticAi:false},{automaticKnowledge:true,aiFallback:true,automaticAi:true}]){
    const policy={enabled:true,...flags},form=node();form.elements={};for(const [key,value] of Object.entries(policy))form.elements[key]={checked:value};
    let pending;const requests=[];let refreshed=0;const fixture={find:selector=>{assert.equal(selector,'[data-inbox-policy]');return form;},inboxLoaded:true,inboxPolicyDirty:false,snapshot:context.snapshot,run:(_button,fn)=>{pending=fn();},backend:{configureInbox:async value=>requests.push({...value}),inbox:async()=>({policy:{...policy}})},paintInboxSummary:()=>{},paintQueue:()=>{},refreshCustomers:async()=>{refreshed++;},report:()=>{}};
    runInNewContext(handler,fixture);form.listeners.get('submit')({currentTarget:form,preventDefault(){}});await pending;
    assert.deepEqual(requests,[policy]);assert.equal(refreshed,1);assert.equal(fixture.inboxPolicyDirty,false);
  }
});
