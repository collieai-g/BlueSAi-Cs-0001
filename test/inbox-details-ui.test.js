import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const design=readFileSync(new URL('../design/customer-agent-card-design.html',import.meta.url),'utf8');
const start=design.indexOf('    function contextDateTime('),end=design.indexOf('    async function refreshKnowledgeForInbox(',start);
assert.ok(start>=0&&end>start);
const selected=design.slice(start,end);
function node(tag='div'){return {tag,textContent:'',children:[],hidden:false,append(...items){this.children.push(...items);},replaceChildren(){this.children=[];}};}
function fixture(){
  const nodes=new Map(),find=s=>{if(!nodes.has(s))nodes.set(s,node());return nodes.get(s);};
  const context={Date,Number,Set,Array,find,document:{createElement:tag=>node(tag)},snapshot:{knowledge:[{id:'synthetic-fact',title:'已確認合成資料',approved:true,expires_at:null}]},
    inboxSummary:{revision:9,policy:{enabled:true},pendingHandoffs:[]},knowledgeRevision:9,knowledgeCheckedAt:new Date(2026,9,28,21,54).getTime(),
    customerStates:{ai:'自動處理',waiting:'等待本人／DOT',human:'由人工處理'},customerStatuses:{draft:'待你確認，尚未發送',accepted:'供應商已接受，尚未確認送達',delivered:'已送達',read:'已讀',uncertain:'結果未確認'},
    selfReplySettings:()=>({enabled:false}),selfReplyContext:()=>({eligible:false}),selfReplyOperations:new Map(),policyMode:()=> 'FAQ 自動答'};
  runInNewContext(selected,context,{filename:'actual-inbox-details.js'});
  const text=name=>find('[data-'+name+']').textContent;
  return {context,nodes,find,text,paint:data=>context.paintThreadContext(data)};
}
function conversation(extra={}){return {id:'synthetic-customer',name:'合成客戶',channel:'evolution',state:'ai',version:3,last_customer_at:new Date(2026,9,28,21,54).getTime(),...extra};}
function reply(extra={}){return {id:'synthetic-reply',role:'assistant',engine:'knowledge',status:'accepted',created_at:new Date(2026,9,28,21,55).getTime(),version:3,config_version:9,sources:['synthetic-fact'],...extra};}

test('details groups real conversation, handling and reply data without treating accepted as delivered',()=>{
  const f=fixture();f.paint({conversation:conversation(),revision:9,messages:[{role:'user',created_at:1},reply()]});
  assert.equal(f.text('context-summary'),'合成客戶');assert.equal(f.text('context-channel'),'WhatsApp');assert.equal(f.text('context-message-count'),'2 則');
  assert.match(f.text('context-incoming'),/21:54/);assert.doesNotMatch(f.text('context-incoming'),/下午|上午|AM|PM/);
  assert.equal(f.text('context-policy'),'FAQ 自動答');assert.equal(f.text('context-reply-method'),'已確認知識庫');
  assert.match(f.text('context-reply-status'),/尚未確認送達/);assert.match(f.text('context-reply-note'),/仍未確認送達/);assert.match(f.text('context-reply-time'),/21:55/);
  const entry=f.find('[data-context-knowledge]').children[0];assert.equal(entry.children[0].textContent,'已確認合成資料');assert.match(entry.children[1].textContent,/已確認.*21:54/);
  assert.match(design,/建立時間<\/dt><dd data-context-reply-time/);assert.doesNotMatch(design,/送達時間<\/dt><dd data-context-reply-time/);
});

test('latest manual reply replaces older knowledge context and cancelled replies are ignored',()=>{
  const f=fixture();f.paint({conversation:conversation({state:'human'}),revision:9,messages:[reply(),reply({role:'staff',status:'delivered',sources:[]}),reply({status:'cancelled'})]});
  assert.equal(f.text('context-reply-method'),'人工回覆');assert.equal(f.text('context-reply-status'),'已送達');assert.match(f.text('context-reply-note'),/尚未回報已讀/);
  assert.match(f.text('context-handling'),/自動回覆已暫停/);assert.match(f.text('context-knowledge'),/人工回覆/);assert.equal(f.find('[data-context-knowledge]').children.length,0);
  f.paint({conversation:conversation(),revision:9,messages:[reply({status:'read'})]});assert.equal(f.text('context-reply-status'),'已讀');assert.match(f.text('context-reply-note'),/已回報對方已讀/);
});

test('switching to an empty selection clears previous conversation, reply and source data',()=>{
  const f=fixture(),data={conversation:conversation(),revision:9,messages:[reply()]},before=JSON.stringify(data);f.paint(data);f.paint(null);
  assert.equal(f.text('context-channel'),'尚未選擇對話');assert.equal(f.text('context-incoming'),'—');assert.equal(f.text('context-message-count'),'—');assert.equal(f.text('context-reply-status'),'尚未有回覆');
  assert.equal(f.text('context-reply-method'),'—');assert.equal(f.text('context-reply-time'),'—');assert.equal(f.find('[data-context-knowledge]').children.length,0);assert.equal(JSON.stringify(data),before);
});

test('stale knowledge and drafts remain unverified and unknown times are not invented',()=>{
  const f=fixture();f.context.knowledgeRevision=8;f.paint({conversation:conversation({last_customer_at:0}),revision:9,messages:[reply({status:'draft',config_version:8,created_at:0})]});
  assert.equal(f.text('context-incoming'),'未提供');assert.equal(f.text('context-reply-time'),'未提供');assert.equal(f.text('context-reply-status'),'草稿需重新核對');
  const entry=f.find('[data-context-knowledge]').children[0];assert.equal(entry.children[0].textContent,'來源待重新核對');assert.doesNotMatch(entry.children[1].textContent,/^已確認/);
});

test('pending reasons and uncertain send outcomes are shown without fabricating an action or receipt',()=>{
  const f=fixture();f.context.inboxSummary.pendingHandoffs=[{conversationId:'synthetic-customer',reason:'knowledge_conflict'}];
  f.paint({conversation:conversation({state:'waiting'}),revision:9,messages:[reply({status:'uncertain'})]});
  assert.match(f.text('context-handling'),/資料有衝突/);assert.match(f.text('context-reply-note'),/發送結果未明/);assert.match(f.text('context-reply-note'),/避免重複發送/);
  f.context.inboxSummary.pendingHandoffs[0].reason='<untrusted>';f.paint({conversation:conversation({state:'waiting'}),revision:9,messages:[]});assert.equal(f.text('context-handling'),'這段對話正等待本人核對及處理。');
});
