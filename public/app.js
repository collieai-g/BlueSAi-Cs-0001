const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let state, selectedId = null, demoId = null, detailSignature = '', pollBusy = false, noticeTimer;
const states = { ai:'AI 處理中', waiting:'等待人工', human:'由人工處理' };
const statuses = { received:'收到', draft:'草稿 · 尚未發送', queued:'等待發送', sending:'發送中 · 可能無法撤回', simulated:'只在試聊顯示', accepted:'渠道已接受 · 未確認送達', delivered:'已送達', read:'已讀', failed:'需要處理', uncertain:'結果未確認 · 請核對 WhatsApp，勿直接重發', cancelled:'已作廢' };
function el(tag, text, className) { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; }
function notice(message) { $('#notice').textContent = message; $('#notice').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => $('#notice').hidden = true, 6500); }
async function api(path, method='GET', data) {
  const response = await fetch('/api' + path, { method, headers: data === undefined ? {} : { 'Content-Type':'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) { $('#app').hidden = true; $('#login').hidden = false; state = null; }
    throw new Error(result.error || '未能完成，請再試。');
  }
  return result;
}
const busyControls = new WeakSet();
function action(fn) { return async event => {
  event?.preventDefault(); const control=event?.currentTarget;
  if(control && busyControls.has(control))return;
  if(control)busyControls.add(control);
  try { await fn(event); } catch(error) { notice(error.message); }
  finally { if(control)busyControls.delete(control); }
}; }
function button(text, fn, className='') { const b = el('button',text,className); b.type='button'; b.addEventListener('click',action(fn)); return b; }
function page(name) { ['teach','inbox','settings'].forEach(p => $('#page-' + p).hidden = p !== name); $$('nav button').forEach(b => { if(b.dataset.page===name)b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current'); }); }
function fillForms() {
  ['name','service','instructions','tone'].forEach(key => $('#' + key).value = state.profile[key]);
  $(`input[name="mode"][value="${state.settings.mode}"]`).checked = true;
  $('#handoff-contact').value = state.settings.handoffContact;
}
function renderRuntime() {
  const r = state.runtime;
  $('#engine-tag').textContent = r.agent === 'offline' ? '離線示範' : 'AI 已設定';
  $('#demo-description').textContent = r.agent === 'offline' ? '目前以固定規則示範價錢、時間及退款問答。未連接 AI，自訂工作指令未會生效。' : '使用已設定的 AI，根據已儲存指令、有效資料及本次對話產生回覆；會使用 API 額度。';
  const dl = $('#connection-status'); dl.replaceChildren();
  for (const [key,value] of Object.entries({ 'AI':r.agent === 'offline' ? '未連接 · 離線示範' : '已設定 · 未經此畫面驗證連線', 'WhatsApp 接駁':r.evolutionConfigured ? '已設定 · 請用測試帳號核對' : '未設定', '接收訊息':r.webhookConfigured ? '驗證資料已設定' : '未設定', '真實發送':r.liveReady ? '允許發送 · 仍按回覆方式處理' : '未開啟或尚欠設定' })) { dl.append(el('dt',key),el('dd',value)); }
}
function renderKnowledge() {
  const list = $('#knowledge-list'); list.replaceChildren();
  if (!state.knowledge.length) list.append(el('p','尚未加入資料。留白就代表未知。','empty'));
  for (const k of state.knowledge) {
    const item = el('article',undefined,'knowledge-item');
    const expired = k.expires_at && k.expires_at <= Date.now();
    const heading = el('div',undefined,'inline spread'); heading.append(el('h3',k.title),el('span',expired?'已過期':k.approved?'已確認':'待確認','badge'));
    item.append(heading,el('p',k.content),el('p',k.expires_at?'有效至 '+new Date(k.expires_at).toLocaleDateString('zh-HK'):'未設定到期日','help'));
    const controls = el('div',undefined,'inline');
    if(!k.approved && !expired) controls.append(button('確認採用',async()=>{await api('/knowledge/'+k.id,'POST',{});await refresh();notice('已確認，可用來回答。');}));
    controls.append(button('刪除',async()=>{if(!confirm('刪除這條商戶資料？之後不會再用它回答。'))return;await api('/knowledge/'+k.id,'DELETE');await refresh();},'quiet danger'));
    item.append(controls);list.append(item);
  }
}
function renderContacts() {
  const list = $('#conversation-list'); list.replaceChildren(); const filter = $('#conversation-filter').value;
  const conversations = state.conversations.filter(c => filter==='all'||c.state===filter);
  if(!conversations.length)list.append(el('p','暫時沒有對話。','empty'));
  for(const c of conversations) {
    const b = button('',async()=>{selectedId=c.id;detailSignature='';await renderDetail();renderContacts();},'contact'+(c.id===selectedId?' selected':''));
    b.append(el('strong',c.name),el('p',(c.channel==='demo'?'試聊 · ':'WhatsApp · ')+states[c.state]+(c.pending?' · 有待辦':'')),el('p',(c.preview||'').slice(0,60)));list.append(b);
  }
}
function messageNode(m, editable=false, conversation) {
  const box=el('article',undefined,'message '+m.role);
  const roles={user:'客人',assistant:'AI 客服',staff:'你／人工客服',system:'內部提示'};
  box.append(el('span',(roles[m.role]||m.role)+' · '+(statuses[m.status]||m.status)+(m.engine==='offline'?' · 離線示範':''),'message-label'),el('p',m.content,'bubble'));
  if(m.sources.length){const titles=m.sources.map(id=>state.knowledge.find(k=>k.id===id)?.title||'已移除的資料');box.append(el('p','依據：'+titles.join('、'),'help'));}
  if(editable && m.status==='draft' && conversation.state==='ai') {
    const input=el('textarea',m.content,'draft-edit');input.rows=3;input.maxLength=4000;input.setAttribute('aria-label','修改回覆草稿');box.append(input);
    box.append(button(conversation.channel==='demo'?'確認這份試聊回覆':'確認並發送',async()=>{await api('/messages/'+m.id+'/approve','POST',{text:input.value});detailSignature='';await refresh();notice(conversation.channel==='demo'?'已確認，只在試聊顯示。':'已排入發送，請查看最新狀態。');},'primary'));
  }
  if(editable && ['assistant','staff'].includes(m.role)) {
    const controls=el('div',undefined,'message-tools');
    if(conversation.state==='human')controls.append(button('帶入人工回覆',()=>{$('#reply-text').value=m.content;$('#reply-text').focus();}));
    controls.append(button('整理成待確認資料',()=>{page('teach');$('#knowledge-details').open=true;$('#fact-title').value='由對話整理';$('#fact-content').value=m.content;$('#fact-approved').checked=false;$('#fact-content').focus();notice('請移除個人資料，核對是否適用於其他客戶，再儲存。');}));box.append(controls);
  }
  return box;
}
async function renderDetail() {
  if(!selectedId){$('#conversation-empty').hidden=false;$('#conversation-detail').hidden=true;return;}
  const requestedId=selectedId;const data=await api('/conversations/'+requestedId);if(requestedId!==selectedId)return;const signature=JSON.stringify(data);
  if(signature===detailSignature)return; detailSignature=signature;
  const c=data.conversation;$('#conversation-empty').hidden=true;$('#conversation-detail').hidden=false;
  $('#conversation-name').textContent=c.name;$('#conversation-status').textContent=states[c.state];
  $('#takeover').hidden=c.state==='human';$('#resume').hidden=c.state==='ai';
  $('#channel-note').textContent=c.channel==='demo'?'這是試聊，不會發送任何 WhatsApp 訊息。':'這是真實渠道對話。已在發送中的訊息可能無法撤回；「渠道已接受」不代表已送達。';
  const messages=$('#messages');messages.replaceChildren(...data.messages.map(m=>messageNode(m,true,c)));
  $('#reply-text').disabled=c.state!=='human';$('#send-reply').disabled=c.state!=='human';$('#send-reply').textContent=c.channel==='demo'?'加入試聊回覆':'發送回覆';
}
async function renderDemo() {
  if(!demoId)return;const data=await api('/conversations/'+demoId);const list=$('#demo-chat');
  list.replaceChildren(...data.messages.filter(m=>m.status!=='cancelled').map(m=>messageNode(m)));
  if(data.conversation.state!=='ai')list.append(el('p','已列入待處理。請到「對話」接手；這不是已通知其他人。','notice'));
}
async function refresh(initial=false) {
  state=await api('/state');$('#login').hidden=true;$('#app').hidden=false;
  if(initial)fillForms();renderRuntime();renderKnowledge();renderContacts();
  if(selectedId&&!state.conversations.some(c=>c.id===selectedId))selectedId=null;
  await renderDetail();await renderDemo();
}
$('#login-form').addEventListener('submit',action(async()=>{await api('/login','POST',{token:$('#token').value});$('#token').value='';await refresh(true);notice('已登入。');}));
$('#logout').addEventListener('click',action(async()=>{await api('/logout','POST',{});state=null;selectedId=null;demoId=null;detailSignature='';$('#app').hidden=true;$('#login').hidden=false;}));
$$('nav button').forEach(b=>b.addEventListener('click',()=>page(b.dataset.page)));
$('#profile-form').addEventListener('submit',action(async()=>{const input={};['name','service','instructions','tone'].forEach(k=>input[k]=$('#'+k).value);await api('/profile','PUT',input);await refresh();notice('設定已儲存。舊的 AI 草稿已作廢。');}));
$('#settings-form').addEventListener('submit',action(async()=>{await api('/settings','PUT',{mode:$('input[name="mode"]:checked').value,handoffContact:$('#handoff-contact').value});await refresh();notice('回覆設定已儲存。');}));
$('#knowledge-form').addEventListener('submit',action(async()=>{const date=$('#fact-expiry').value;await api('/knowledge','POST',{title:$('#fact-title').value,category:$('#fact-category').value,content:$('#fact-content').value,approved:$('#fact-approved').checked,expiresAt:date?new Date(date+'T23:59:59').toISOString():null});$('#knowledge-form').reset();await refresh();notice('資料已儲存。');}));
async function demo(text){const result=await api('/demo','POST',{text,conversationId:demoId});demoId=result.conversationId;selectedId=demoId;$('#demo-text').value='';await refresh();}
$('#demo-form').addEventListener('submit',action(async()=>{await demo($('#demo-text').value);}));
$$('[data-question]').forEach(b=>b.addEventListener('click',action(()=>demo(b.dataset.question))));
$('#new-demo').addEventListener('click',()=>{demoId=null;$('#demo-chat').replaceChildren(el('p','試問一句，看看客服怎樣回答。','empty'));});
$('#refresh').addEventListener('click',action(()=>refresh()));
$('#conversation-filter').addEventListener('change',()=>renderContacts());
$('#takeover').addEventListener('click',action(async()=>{await api('/conversations/'+selectedId+'/takeover','POST',{});await refresh();notice('已接手，尚未發送的回覆已取消。');}));
$('#resume').addEventListener('click',action(async()=>{await api('/conversations/'+selectedId+'/resume','POST',{});await refresh();notice('已交回 AI，下一則新訊息才會開始處理。');}));
$('#reply-form').addEventListener('submit',action(async()=>{await api('/conversations/'+selectedId+'/reply','POST',{text:$('#reply-text').value});$('#reply-text').value='';await refresh();notice('回覆已排入處理，請查看狀態。');}));
$('#delete-conversation').addEventListener('click',action(async()=>{if(!confirm('刪除這段對話及訊息？此操作不能復原，也不會刪除 WhatsApp 內的訊息。'))return;await api('/conversations/'+selectedId,'DELETE');if(demoId===selectedId)demoId=null;selectedId=null;detailSignature='';await refresh();}));
refresh(true).catch(()=>{});
setInterval(async()=>{if(!state||pollBusy||document.hidden)return;pollBusy=true;try{await refresh();}catch{}finally{pollBusy=false;}},2500);
