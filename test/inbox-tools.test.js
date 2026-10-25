import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const context = extra => ({conversationId:'selected-customer',version:2,revision:3,latestMessageId:'latest-message',verificationCode:'current-scope-proof',capturedAt:Date.now(),messages:[{role:'user',content:'客戶內容只作資料'}],scope:'draft only',...extra});
const draft = extra => ({conversationId:'selected-customer',expectedVersion:2,expectedRevision:3,latestMessageId:'latest-message',verificationCode:'current-scope-proof',text:'待本人核對的回覆',...extra});
const decoded = result => JSON.parse(result.content[0].text);
async function fixture({child=false,native,host,copy=true}={}) {
  const tools=new Map(),requests=[],saves=[],copies=[],root={isConnected:true};
  let selected='selected-customer',current=context(),readHook;
  const document={getElementById:id=>id==='cs-card-design'?root:null,modelContext:{registerTool:tool=>tools.set(tool.name,tool)}};
  if(native!==undefined)document.oai={annotation:{request:(target,options)=>{requests.push({target,options});return {accepted:native};}}};
  const window={navigator:{clipboard:{writeText:async text=>{if(!copy)throw Error('clipboard refused');copies.push(text);}}}};
  window.top=child?{}:window;
  if(host!==undefined)window.openai={sendFollowUpMessage:input=>{requests.push({host:input});return Promise.resolve(host);}};
  runInNewContext(await readFile(new URL('../public/inbox-tools.js',import.meta.url),'utf8'),{window,document,console,JSON,Promise,Error,Date,Set,Object,Array,Number});
  const bridge=root.csInboxTools;
  bridge.register({selectedConversation:()=>selected,listInbox:async()=>({conversations:[{id:'selected-customer'}],pendingCount:1}),readContext:async id=>{if(readHook)await readHook(id);return current;},saveDraft:async value=>{saves.push(value);return {messageId:'saved-draft',conversationId:value.conversationId};}});
  return {tools,bridge,root,requests,saves,copies,select:id=>{selected=id;},change:value=>{current=value;},onRead:hook=>{readHook=hook;}};
}

test('live inbox tools read fresh summaries and require the selected customer for context',async()=>{
  const f=await fixture();
  assert.equal(f.tools.size,3);
  const listing=decoded(await f.tools.get('bluesai_list_inbox').execute({}));
  assert.equal(listing.pendingCount,1);
  const refused=await f.tools.get('bluesai_read_inbox_conversation').execute({conversationId:'different-customer'});
  assert.equal(refused.isError,true);
  const live=decoded(await f.tools.get('bluesai_read_inbox_conversation').execute({conversationId:'selected-customer'}));
  assert.equal(live.latestMessageId,'latest-message');assert.equal(live.scope,'draft only');
  assert.doesNotMatch(JSON.stringify(live),/apiKey|adminToken|webhookSecret/);
});

test('a DOT draft requires a live read and cannot send or change a different conversation',async()=>{
  const f=await fixture(),save=f.tools.get('bluesai_save_inbox_draft'),read=f.tools.get('bluesai_read_inbox_conversation');
  assert.equal((await save.execute(draft())).isError,true);
  await read.execute({conversationId:'selected-customer'});
  assert.equal((await save.execute(draft({send:true}))).isError,true);
  assert.equal((await save.execute(draft({conversationId:'different-customer'}))).isError,true);
  const result=decoded(await save.execute(draft()));
  assert.equal(f.saves.length,1);assert.match(result.resultScope,/no customer sending/);
  assert.equal((await save.execute(draft())).isError,true);
});

test('a newer message or knowledge scope invalidates the previously read DOT draft',async()=>{
  for(const update of [{version:3,latestMessageId:'new-message'},{revision:4},{verificationCode:'knowledge-expired'}]){
    const f=await fixture();await f.tools.get('bluesai_read_inbox_conversation').execute({conversationId:'selected-customer'});
    f.change(context(update));
    assert.equal((await f.tools.get('bluesai_save_inbox_draft').execute(draft())).isError,true);
    assert.equal(f.saves.length,0);
  }
});

test('selection changing during an asynchronous read cannot disclose or save the previous customer',async()=>{
  const f=await fixture();f.onRead(()=>f.select('new-customer'));
  assert.equal((await f.tools.get('bluesai_read_inbox_conversation').execute({conversationId:'selected-customer'})).isError,true);
  assert.equal(f.saves.length,0);
});

test('closed cards and child frames do not expose live inbox tools',async()=>{
  const child=await fixture({child:true});assert.equal(child.tools.size,0);
  const f=await fixture();f.root.isConnected=false;
  assert.equal((await f.tools.get('bluesai_list_inbox').execute({})).isError,true);
  assert.equal((await f.tools.get('bluesai_read_inbox_conversation').execute({conversationId:'selected-customer'})).isError,true);
});

test('native DOT handoff is synchronous and contains only a conversation reference',async()=>{
  const f=await fixture({native:true}),target={isConnected:true,getClientRects:()=>[{}],value:f.bridge.prompt('selected-customer')};
  const result=f.bridge.invoke(target);
  assert.equal(result.kind,'annotation');assert.equal(result.accepted,true);assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].options.metadata.conversationId,'selected-customer');
  assert.doesNotMatch(JSON.stringify(f.requests),/客戶內容只作資料/);
  assert.equal(f.saves.length,0);
  const refused=await fixture({native:false,host:true});
  const rejected=refused.bridge.invoke({...target,value:refused.bridge.prompt('selected-customer')});
  assert.equal(rejected.accepted,false);assert.equal(refused.requests.length,1);
});

test('ordinary browser clipboard handoff reports refusal and leaves a selectable prompt',async()=>{
  const f=await fixture({copy:false});let selected=false;
  const target={isConnected:true,getClientRects:()=>[{}],value:f.bridge.prompt('selected-customer'),focus(){},select(){selected=true;}};
  const result=f.bridge.invoke(target);assert.equal(result.kind,'copy');assert.equal(await result.promise,false);assert.equal(selected,true);assert.equal(f.copies.length,0);
});
