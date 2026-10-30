import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Exercise the shipped handlers with retained form nodes, as the QR tests do.
// Layout, focus visibility and responsive geometry are checked in a real browser.
const source=readFileSync(new URL('../public/workbench.js',import.meta.url),'utf8');
const start=source.indexOf('    const guideLabels=');
const end=source.indexOf('    const resultDrafts=',start);
assert.ok(start>=0&&end>start,'actual management and guide handlers are present');
const navigation=source.split('\n').filter(line=>
  /all\('\[data-(?:management-tab|start-guide|guide-jump)\]'\)\.forEach\(button=>button\.addEventListener\('click'/.test(line)||
  /find\('\[data-guide-(?:close|back|next)\]'\)\.addEventListener\('click'/.test(line));
assert.equal(navigation.length,6,'all category and guide navigation controls are wired');
const handlers=source.slice(start,end)+'\n'+navigation.join('\n');
const sections=['channels','reply','ai','merchant','extras'];

function node(dataset={}){
  return {
    dataset,hidden:false,disabled:false,textContent:'',value:'',checked:false,
    attributes:{},children:[],listeners:new Map(),parentElement:null,scrollTop:0,
    setAttribute(name,value){this.attributes[name]=String(value);},
    removeAttribute(name){delete this.attributes[name];},
    getAttribute(name){return this.attributes[name]??null;},
    addEventListener(name,handler){this.listeners.set(name,handler);},
    click(){assert.equal(this.disabled,false);return this.listeners.get('click')?.({currentTarget:this});},
    focus(options){this.focusOptions=options;},
    append(child){
      if(child.parentElement)child.parentElement.children=child.parentElement.children.filter(item=>item!==child);
      child.parentElement=this;this.children.push(child);
    },
    replaceChildren(){assert.fail('management navigation must retain the existing form nodes');},
    scrollIntoView(){assert.fail('management navigation must not jump to content further down the page');},
  };
}

function fixture(whatsapp={status:'unconfigured'}){
  const nodes=new Map(),groups=new Map();
  const put=(selector,value=node())=>{nodes.set(selector,value);return value;};
  const group=(selector,values)=>{groups.set(selector,values);return values;};
  const content=put('[data-management-content]');content.scrollTop=240;
  const panels=group('[data-management-section]',sections.map(section=>{
    const panel=put('[data-management-section="'+section+'"]',node({managementSection:section}));
    content.append(panel);put('[data-management-section="'+section+'"] .bp-management-heading h2');return panel;
  }));
  const tabs=group('[data-management-tab]',sections.map(section=>node({managementTab:section})));
  const steps=group('[data-guide-flow]',['whatsapp','web'].flatMap(flow=>[0,1,2,3].map(step=>node({guideFlow:flow,guideStep:String(step)}))));
  const jumps=group('[data-guide-jump]',[0,1,2,3].map(step=>{
    put('[data-guide-step-label="'+step+'"]');return node({guideJump:String(step)});
  }));
  const launchers=group('[data-start-guide]',['whatsapp','web'].map(flow=>put('[data-start-guide="'+flow+'"]',node({startGuide:flow}))));
  group('[data-open-customer-panel]',[node(),node()]);
  for(const name of ['channels-overview','management-location','guide-header','guide-nav','guide-steps','guide-title','guide-progress','guide-back','guide-next','guide-close','guide-wa-ready','guide-receive-help','guide-test-status','guide-web-ready','web-chat-url','copy-web-url','open-web-chat','web-url-help','web-link-code','dot-task-form','dot-panel-title','dot-panel-intro','inbox-automatic-note','wa-receive-settings'])put('[data-'+name+']');
  put('.bp-task-picker');
  const setupAnchor=put('[data-setup-task-anchor]'),generalAnchor=put('[data-general-task-anchor]');
  panels[0].append(setupAnchor);panels[2].append(generalAnchor);
  const taskPanel=put('[data-dot-task-panel]');generalAnchor.append(taskPanel);
  const merchantDraft=node(),consentDraft=node(),taskDraft=node();
  merchantDraft.value='synthetic unsaved merchant draft';consentDraft.checked=true;taskDraft.value='synthetic unsaved task result';
  panels[3].append(merchantDraft);panels[1].append(consentDraft);taskPanel.append(taskDraft);
  const calls={render:0,remember:0,reports:[],start:0,stop:0,savedDrafts:0};
  const context={
    state:{screen:'config',tab:'connect',managementSection:'channels',contextOpen:false},
    guideFlow:null,guideStep:0,setupTaskFlow:null,receiveSetupOpen:false,whatsappLink:{phase:'idle'},
    startWhatsAppLink:()=>{calls.start++;},stopWhatsAppLink:()=>{calls.stop++;},saveCurrentReply:()=>{calls.savedDrafts++;},
    snapshot:{connections:{mode:'preview',whatsapp,webChat:{enabled:false}}},
    location:{origin:'http://127.0.0.1:3199'},URL,
    find:selector=>{assert.ok(nodes.has(selector),'known DOM selector: '+selector);return nodes.get(selector);},
    all:selector=>{assert.ok(groups.has(selector),'known DOM group: '+selector);return groups.get(selector);},
    render:()=>{calls.render++;},remember:()=>{calls.remember++;},
    report:value=>calls.reports.push(value),
    backend:new Proxy({},{get(){assert.fail('navigation must not request a provider, install software or change server settings');}}),
  };
  runInNewContext(handlers,context,{filename:'actual-workbench-management-navigation.js'});
  context.paintGuide();
  return {context,nodes,content,panels,tabs,steps,jumps,launchers,setupAnchor,generalAnchor,taskPanel,merchantDraft,consentDraft,taskDraft,calls};
}

function visibleSteps(f){return f.steps.filter(item=>!item.hidden).map(item=>item.dataset.guideFlow+':'+item.dataset.guideStep);}
function assertSection(f,section){
  assert.deepEqual(f.panels.filter(item=>!item.hidden).map(item=>item.dataset.managementSection),[section]);
  assert.deepEqual(f.tabs.filter(item=>item.getAttribute('aria-pressed')==='true').map(item=>item.dataset.managementTab),[section]);
}

test('management category clicks replace the visible pane while retaining unsaved form nodes',()=>{
  const f=fixture(),parents=f.panels.map(item=>item.parentElement);
  for(const section of ['merchant','reply','extras','ai','channels','merchant']){
    f.content.scrollTop=240;f.tabs[sections.indexOf(section)].click();assertSection(f,section);
    assert.equal(f.content.scrollTop,0,'the same pane returns to its heading');
    assert.equal(f.merchantDraft.value,'synthetic unsaved merchant draft');
    assert.equal(f.consentDraft.checked,true);
    f.panels.forEach((item,index)=>assert.equal(item.parentElement,parents[index]));
  }
  assert.equal(f.merchantDraft.parentElement,f.panels[3]);
  assert.equal(f.taskDraft.parentElement,f.taskPanel);
  assert.equal(f.calls.render,6);assert.equal(f.calls.remember,6);
});

test('WhatsApp opens one linear pane and starts only after an explicit connect click',()=>{
  const f=fixture();
  assert.equal(f.calls.start,0);
  f.context.openConnectionGuide('whatsapp');
  assert.deepEqual(visibleSteps(f),['whatsapp:1']);
  assert.equal(f.calls.start,0,'opening or painting the pane alone does not start a connection');
  assert.equal(f.nodes.get('[data-guide-steps]').hidden,true);
  assert.equal(f.nodes.get('[data-guide-nav]').hidden,true);
  f.launchers[0].click();assertSection(f,'channels');assert.equal(f.calls.start,1);
  f.context.whatsappLink.phase='connected';f.context.paintGuide();
  assert.deepEqual(visibleSteps(f),['whatsapp:1'],'phone-only preview cannot offer runtime receive actions');
  f.nodes.get('[data-guide-close]').click();assert.deepEqual(visibleSteps(f),[]);
  assert.equal(f.calls.stop,1);assert.equal(f.nodes.get('[data-channels-overview]').hidden,false);
  assert.equal(f.nodes.get('[data-guide-title]').focusOptions.preventScroll,true);
});

test('automatic local receiving hides the extra receive settings and consent steps',()=>{
  const f=fixture({status:'open',autoReceiveOnConnect:true,autoReceiveStatus:'receiving',receiveSetupAvailable:true,inboxScope:{available:true}});
  f.context.openConnectionGuide('whatsapp');f.context.whatsappLink.phase='connected';f.context.paintGuide();
  assert.deepEqual(visibleSteps(f),['whatsapp:1']);assert.equal(f.calls.start,0);
});

test('automatic receiving hides the old settings button and shows only a retry on failure',()=>{
  const first=source.indexOf('    function paintManagement(){'),last=source.indexOf('    function paintThreadContext(',first);assert.ok(first>=0&&last>first);
  const nodes=new Map(),find=selector=>{if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector);};
  const wa={autoReceiveOnConnect:true,autoReceiveStatus:'receiving',status:'open',receiveEnabled:true,receiveSetupAvailable:true,webhook:{registered:true},inboxScope:{available:true,mode:'all_private_text',consented:true}};
  const c={find,snapshot:{connections:{whatsapp:wa,ai:{status:'connected'},mode:'preview'},profile:{name:''}},inboxScope:null,inboxSummary:{policy:{}},inboxLoaded:true,paintPhoneConnection:()=>({tone:'open',number:null}),paintManagementView:()=>{},policyMode:()=> '人工'};
  runInNewContext(source.slice(first,last),c);c.paintManagement();assert.equal(find('[data-manage-receive-action]').hidden,true);assert.equal(find('[data-manage-receive]').textContent,'接收新私人訊息');
  wa.autoReceiveStatus='error';wa.receiveEnabled=false;c.paintManagement();assert.equal(find('[data-manage-receive-action]').hidden,false);assert.equal(find('[data-manage-receive-action]').textContent,'重試接駁');assert.equal(find('[data-manage-receive]').textContent,'接駁未完成');
});

test('web guide retains four clickable steps within the existing content pane',()=>{
  const f=fixture();f.launchers[1].click();assertSection(f,'channels');
  assert.deepEqual(visibleSteps(f),['web:0']);
  f.nodes.get('[data-guide-next]').click();assert.deepEqual(visibleSteps(f),['web:1']);
  f.jumps[3].click();assert.deepEqual(visibleSteps(f),['web:3']);
  assert.equal(f.jumps[3].getAttribute('aria-current'),'step');
  f.nodes.get('[data-guide-back]').click();assert.deepEqual(visibleSteps(f),['web:2']);
  assert.equal(f.calls.start,0,'web guide navigation never starts WhatsApp');
});

test('runtime receive and send settings remain separate from the completed phone connection',()=>{
  const f=fixture({status:'open',checkedAt:Date.now(),inboxScope:{available:true}});
  f.context.snapshot.connections.mode='runtime';f.context.openConnectionGuide('whatsapp');
  assert.deepEqual(visibleSteps(f),['whatsapp:1']);
  f.context.whatsappLink.phase='connected';f.context.paintGuide();
  assert.deepEqual(visibleSteps(f),['whatsapp:1','whatsapp:2','whatsapp:3']);
  assert.equal(f.calls.start,0);
  f.context.openConnectionGuide('invalid',0);assert.deepEqual(visibleSteps(f),['whatsapp:1','whatsapp:2','whatsapp:3']);
});

test('the inbox receive action opens only the consent pane using backend capabilities without starting a channel',()=>{
  const f=fixture({status:'open',receiveSetupAvailable:true,inboxScope:{available:true}});
  f.context.openWhatsAppReceiveSettings();assertSection(f,'channels');
  assert.deepEqual(visibleSteps(f),['whatsapp:2']);assert.equal(f.nodes.get('[data-wa-receive-settings]').open,true);
  assert.equal(f.nodes.get('[data-guide-title]').textContent,'WhatsApp 收件與人工回覆');assert.equal(f.calls.start,0);assert.equal(f.calls.savedDrafts,1);
  assert.equal(f.nodes.get('[data-guide-receive-help]').textContent,'請先準備收件入口，再確認收件範圍。');f.context.snapshot.connections.whatsapp.webhook={configured:true,registered:false};f.context.paintGuide();assert.equal(f.nodes.get('[data-guide-receive-help]').textContent,'請先準備收件入口，再確認收件範圍。','configured callback metadata does not mean an active verified receiver');
  const retry=fixture({status:'error',receiveSetupAvailable:true,inboxScope:{available:false}});retry.context.openWhatsAppReceiveSettings();assert.deepEqual(visibleSteps(retry),['whatsapp:2']);assert.equal(retry.calls.start,0,'explicit recovery navigation must not reconnect the phone');
  const unavailable=fixture({status:'open'});unavailable.context.snapshot.connections.mode='runtime';unavailable.context.openWhatsAppReceiveSettings();
  assert.deepEqual(visibleSteps(unavailable),[],'the runtime label alone is not permission to configure a receiver');assert.equal(unavailable.calls.start,0);
});

test('installation help moves the same draft task into the current guide and back to general AI tasks',()=>{
  const f=fixture();f.launchers[0].click();
  f.context.setupTaskFlow='whatsapp';f.context.paintGuide();
  assert.equal(f.taskPanel.parentElement,f.setupAnchor);
  assert.equal(f.setupAnchor.hidden,false);assert.deepEqual(visibleSteps(f),[]);
  assert.equal(f.nodes.get('[data-guide-nav]').hidden,true);
  assert.equal(f.nodes.get('[data-dot-task-form]').hidden,true);
  assert.equal(f.nodes.get('[data-dot-panel-title]').textContent,'WhatsApp 安裝指引');
  f.tabs[sections.indexOf('ai')].click();assertSection(f,'ai');
  assert.equal(f.taskPanel.parentElement,f.generalAnchor);
  assert.equal(f.nodes.get('[data-dot-task-form]').hidden,false);
  assert.equal(f.taskDraft.parentElement,f.taskPanel);
  assert.equal(f.taskDraft.value,'synthetic unsaved task result');
  assert.equal(f.generalAnchor.children.filter(item=>item===f.taskPanel).length,1);
});

test('the isolated preview never offers an enabled public web-chat link',()=>{
  const f=fixture();f.launchers[1].click();
  assert.deepEqual(visibleSteps(f),['web:0']);
  assert.equal(f.nodes.get('[data-copy-web-url]').disabled,true);
  assert.equal(f.nodes.get('[data-open-web-chat]').hidden,true);
  assert.equal(f.nodes.get('[data-web-chat-url]').value,'');
  assert.match(f.nodes.get('[data-guide-web-ready]').textContent,/尚未開啟/);
});

test('channel overview omits retired recipient and readiness controls while consent stays in the connection flow',()=>{
  const html=readFileSync(new URL('../public/workbench.html',import.meta.url),'utf8');
  for(const retired of ['data-wa-test-recipients','data-wa-test-submit','data-wa-test-state','data-wa-profile-ready','data-open-basic','data-inbox-scope-test','data-inbox-connection-check','data-manage-reply','data-manage-proof','data-manage-next-description']){
    assert.doesNotMatch(html,new RegExp('\\b'+retired+'\\b'),retired);
    assert.doesNotMatch(source,new RegExp('\\b'+retired+'\\b'),retired+' handler');
  }
  assert.doesNotMatch(html,/WhatsApp\s*Business[^<]*(?:尚在開發|仍在開發|開發中)/i);
  for(const consent of ['data-inbox-scope-consent','data-inbox-reply-consent']){
    const input=html.match(new RegExp('<input\\b[^>]*\\b'+consent+'\\b[^>]*>'))?.[0];
    assert.ok(input,consent+' remains available');
    assert.doesNotMatch(input,/\bchecked(?:\s|=|>)/,consent+' is not preselected');
  }
});

test('enabling all-private reception requires a deliberate click and leaves reply consent independent',async()=>{
  const handler=source.split('\n').find(line=>line.includes("find('[data-inbox-scope-enable]').addEventListener('click'"));
  assert.ok(handler,'actual all-private consent handler is present');
  const nodes=new Map(['inbox-scope-enable','inbox-scope-consent','inbox-reply-consent','inbox-self-test-consent'].map(name=>['[data-'+name+']',node()]));
  const requests=[];
  const context={
    inboxScope:null,selfScopeDirty:true,snapshot:{connections:{whatsapp:{selfTestReply:{available:false}}}},
    find:selector=>{assert.ok(nodes.has(selector),selector);return nodes.get(selector);},
    run:(_button,action)=>action(),refresh:async()=>{},paintInboxScope:()=>{},report:()=>{},
    backend:{configureWhatsAppInboxScope:async input=>{requests.push(JSON.parse(JSON.stringify(input)));return input;}},
  };
  runInNewContext(handler,context,{filename:'actual-all-private-consent-handler.js'});
  const enable=nodes.get('[data-inbox-scope-enable]');
  assert.equal(requests.length,0,'rendering or wiring controls must not grant reception');
  await assert.rejects(enable.click());
  assert.equal(requests.length,0,'unchecked receive consent never reaches the backend');
  nodes.get('[data-inbox-scope-consent]').checked=true;
  await enable.click();
  assert.deepEqual(requests,[{mode:'all_private_text',consent:true,replyToReceived:false,includeSelfTests:false}]);
  nodes.get('[data-inbox-reply-consent]').checked=true;
  await enable.click();
  assert.equal(requests[1].replyToReceived,true);
  assert.equal(requests[1].mode,'all_private_text');
  assert.equal(context.selfScopeDirty,false);
});

function phoneFixture(live=true){
  const phoneStart=source.indexOf('    function phoneConnectionState(');
  const phoneEnd=source.indexOf('    function paintConnection(',phoneStart);
  const manageStart=source.indexOf('    function paintManagement(){');
  const manageEnd=source.indexOf('    function paintThreadContext(',manageStart);
  assert.ok(phoneStart>=0&&phoneEnd>phoneStart&&manageStart>=0&&manageEnd>manageStart,'actual phone and overview painters are present');
  const nodes=new Map();
  const context={
    live,inboxLoaded:false,inboxScope:null,inboxSummary:{policy:{}},
    snapshot:{profile:{},connections:{mode:'runtime',whatsapp:{},ai:{status:'unconfigured'},webChat:{enabled:false}}},
    find:selector=>{if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector);},
    policyMode:()=>{assert.fail('unloaded reply policies must not be described as ready');},paintManagementView:()=>{},
  };
  runInNewContext(source.slice(phoneStart,phoneEnd)+'\n'+source.slice(manageStart,manageEnd),context,{filename:'actual-phone-overview-painters.js'});
  const paint=whatsapp=>{context.snapshot.connections.whatsapp=whatsapp;context.paintManagement();return context.phoneConnectionState(whatsapp);};
  return {context,nodes,paint};
}

test('the actual overview displays only a verified current phone and clears it when the connection becomes uncertain',()=>{
  const f=phoneFixture(),checkedAt=Date.now();
  // Explicitly synthetic, never taken from an account or private instance.
  const open={status:'open',checkedAt,linkedPhone:'15555550123'};
  assert.equal(f.paint(open).number,'+15555550123');
  assert.equal(f.nodes.get('[data-manage-link]').textContent,'+15555550123');
  for(const selector of ['[data-shell-wa-status]','[data-manage-phone]','[data-card-status]'])assert.equal(f.nodes.get(selector).dataset.phoneState,'open');
  for(const status of ['close','closed','error','unconfigured','disconnected']){
    const result=f.paint({...open,status});
    assert.equal(result.tone,'closed',status);assert.equal(result.number,'',status);
    assert.doesNotMatch(f.nodes.get('[data-manage-link]').textContent,/15555550123/,status+' clears old account text');
    assert.equal(f.nodes.get('[data-card-status]').dataset.connected,'false');
  }
  for(const uncertain of [{...open,checkedAt:undefined},{...open,checkedAt:0},{...open,checkedAt:NaN},{...open,requiresCheck:true},{...open,status:'connecting'},{...open,status:'unknown'}]){
    assert.equal(f.paint(uncertain).tone,'unknown');
    assert.equal(f.nodes.get('[data-card-status]').dataset.connected,'false');
    assert.doesNotMatch(f.nodes.get('[data-manage-link]').textContent,/15555550123/);
  }
  for(const linkedPhone of [null,undefined,'',12345678,'123','+15555550123','15555550123:4@s.whatsapp.net','12345678@lid','<script>account</script>']){
    const result=f.paint({...open,linkedPhone});
    assert.equal(result.tone,'open');assert.equal(result.number,'');
    assert.equal(f.nodes.get('[data-manage-link]').textContent,'未取得連結號碼');
  }
  const preview=phoneFixture(false);
  assert.equal(preview.paint(open).tone,'unknown');assert.equal(preview.paint(open).number,'');
});

test('phone connection and consented receive readiness remain independent in the actual overview',()=>{
  const f=phoneFixture(),base={status:'open',checkedAt:Date.now(),linkedPhone:'15555550123',receiveEnabled:true};
  assert.equal(f.paint({...base,inboxScope:{mode:'all_private_text',consented:false},webhook:{registered:true}}).tone,'open');
  assert.equal(f.nodes.get('[data-manage-receive]').textContent,'待確認收件範圍');
  f.paint({...base,inboxScope:{mode:'all_private_text',consented:true},webhook:{registered:false}});
  assert.equal(f.nodes.get('[data-manage-receive]').textContent,'新私人文字 · 入口待核對');
  f.paint({...base,inboxScope:{mode:'all_private_text',consented:true},webhook:{registered:true}});
  assert.equal(f.nodes.get('[data-manage-receive]').textContent,'接收新私人訊息');
  assert.equal(f.nodes.get('[data-management-reply-summary]').textContent,'規則待核對');
});

test('connection lights use a slow opacity pulse and disable animation for reduced motion',()=>{
  const css=readFileSync(new URL('../public/agent-card.css',import.meta.url),'utf8');
  const open=css.match(/[^{}]*\[data-phone-state="open"\][^{]*\{([^}]*)\}/)?.[1];
  const closed=css.match(/[^{}]*\[data-phone-state="closed"\][^{]*\{([^}]*)\}/)?.[1];
  assert.ok(open&&closed,'both connected and disconnected connection lights are styled');
  const openColor=open.match(/background:([^;}]*)/)?.[1],closedColor=closed.match(/background:([^;}]*)/)?.[1];
  assert.ok(openColor&&closedColor);assert.notEqual(openColor,closedColor);
  const rgb=value=>{assert.match(value,/^#[\da-f]{6}$/i);return [1,3,5].map(index=>parseInt(value.slice(index,index+2),16));};
  const green=rgb(openColor),red=rgb(closedColor);
  assert.ok(green[1]>green[0]&&green[1]>green[2],'connected state is green');
  assert.ok(red[0]>red[1]&&red[0]>red[2],'disconnected state is red');
  for(const declaration of [open,closed]){
    const duration=Number(declaration.match(/animation:bluesai-cs-phone-pulse\s+([\d.]+)s/)?.[1]);
    assert.ok(duration>=4,'the connection pulse is slow, not a flashing alarm');
  }
  assert.match(css,/@keyframes\s+bluesai-cs-phone-pulse\s*\{[^}]*\{opacity:/,'pulse changes opacity');
  assert.match(css,/@media\s*\(prefers-reduced-motion:\s*reduce\)[^{]*\{[^{}]*\.bp-phone-light[^{}]*\{[^{}]*animation:\s*none\s*!important/);
});
