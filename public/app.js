const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let state, selectedId = null, demoId = null, detailSignature = '', pollBusy = false, noticeTimer;
let knowledgeSignature = '', contactsSignature = '', demoSignature = '', recentSignature = '';
const routes = { overview:'客服總覽', inbox:'客戶對話', teach:'教客服', knowledge:'客服知識', settings:'設定' };
const mobileWidth = matchMedia('(max-width: 900px)');
// Icon paths and shared chrome follow the pinned Blueprint Studio source (see UI_SOURCE.json).
const icons = {
  dashboard:['M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z'],
  checklist:['M9 5h12 M9 12h12 M9 19h12 M3 5l1 1 2-3 M3 12l1 1 2-3 M3 19l1 1 2-3'],
  folder:['M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z'],
  chat:['M21 11a8 8 0 0 1-8 8H7l-4 3V11a9 9 0 0 1 18 0Z','M7 10h10 M7 14h6'],
  settings:['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8','m9 3-1 3-3 1-2 3 2 2-1 3 2 3h3l2 3 3-1 1-3 3-1 2-3-2-2 1-3-2-3h-3l-2-3Z'],
  menu:['M4 6h16 M4 12h16 M4 18h16'], arrow:['M5 12h14 m-5-5 5 5-5 5'],
  plus:['M12 5v14 M5 12h14'], inbox:['M4 4h16l2 12v4H2v-4Z','M2 16h6l2 3h4l2-3h6']
};
$$('[data-icon]').forEach(node => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  for (const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',class:'ui-icon'})) svg.setAttribute(key,value);
  for (const d of icons[node.dataset.icon] || []) { const path = document.createElementNS(svg.namespaceURI,'path'); path.setAttribute('d',d); svg.append(path); }
  node.append(svg);
});
const states = { ai:'AI 處理中', waiting:'等待人工', human:'由人工處理' };
const statuses = { received:'收到', draft:'草稿 · 尚未發送', queued:'等待發送', sending:'發送中 · 可能無法撤回', simulated:'只在試聊顯示', accepted:'渠道已接受 · 未確認送達', delivered:'已送達', read:'已讀', failed:'需要處理', uncertain:'結果未確認 · 請核對 WhatsApp，勿直接重發', cancelled:'已作廢' };
function el(tag, text, className) { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; }
function notice(message) { $('#notice').textContent = message; $('#notice').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => $('#notice').hidden = true, 6500); }
async function api(path, method='GET', data) {
  const response = await fetch('/api' + path, { method, headers: data === undefined ? {} : { 'Content-Type':'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) { closeSidebar(false); $('#app').hidden = true; $('#login').hidden = false; state = null; }
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
function button(text, fn, className='secondary small') { const b = el('button',text,'button '+className); b.type='button'; b.addEventListener('click',action(fn)); return b; }
function closeSidebar(returnFocus=true) {
  const wasOpen = $('#sidebar').classList.contains('open');
  $('#sidebar').classList.remove('open'); $('#sidebar-backdrop').hidden=true; $('.app-main').inert=false;
  $('#mobile-menu').setAttribute('aria-expanded','false'); document.body.classList.remove('sidebar-open');
  if(wasOpen && returnFocus) $('#mobile-menu').focus();
}
function page(name, { updateHash=true, focus=false }={}) {
  if(!Object.hasOwn(routes,name))name='overview';
  Object.keys(routes).forEach(p => $('#page-' + p).hidden = p !== name);
  $$('#sidebar [data-page]').forEach(b => { const active=b.dataset.page===name; b.classList.toggle('active',active); if(active)b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current'); });
  $('#breadcrumb-current').textContent=routes[name]; document.title=routes[name]+'｜BlueSAI-客服';
  closeSidebar(false);
  if(updateHash && location.hash!=='#/'+name) history.pushState(null,'','#/'+name);
  if(focus) { window.scrollTo(0,0); $('#'+name+'-title').focus({preventScroll:true}); }
}
function routeFromHash() { if(location.hash==='#main'){$('#main').focus();return;} page(location.hash.replace(/^#\//,''),{updateHash:false}); }
addEventListener('hashchange',routeFromHash);
function openKnowledge() { page('knowledge'); $('#knowledge-details').open=true; $('#fact-title').focus(); }
function isPending(c) { return Boolean(c.pending || c.state==='waiting' || c.state==='human'); }
function renderOverview() {
  const pending=state.conversations.filter(isPending).length;
  const valid=state.knowledge.filter(k=>k.approved && (!k.expires_at || k.expires_at>Date.now())).length;
  $('#summary-pending').textContent=pending; $('#summary-conversations').textContent=state.conversations.length;
  $('#summary-knowledge').textContent=valid; $('#summary-mode').textContent=state.settings.mode==='auto'?'自動回覆':'先確認';
  $('#summary-delivery').textContent=state.runtime.liveReady?'允許真實發送':'真實發送未開啟';
  $('#pending-count').textContent=pending; $('#pending-count').hidden=pending===0;
  $('#company-name').textContent=state.profile.name || '我的客服'; $('#company-avatar').textContent=state.profile.name?.slice(0,1)||'客';
  const recent=state.conversations.slice(0,4); const signature=JSON.stringify(recent);
  if(signature===recentSignature)return; recentSignature=signature;
  const list=$('#recent-conversations'); list.replaceChildren();
  if(!recent.length) { list.append(el('p','這裡準備好，等你的第一段對話。','empty-copy'),el('p','先教客服、加入資料，再用試聊核對回覆。','help'),button('開始試聊',()=>{page('teach');$('#demo-text').focus();})); }
  for(const c of recent) {
    const b=button('',async()=>{selectedId=c.id;detailSignature='';$('#conversation-filter').value='all';$('#conversation-search').value='';page('inbox',{focus:true});renderContacts();await renderDetail();},'contact recent-contact');
    b.append(el('strong',c.name),el('p',(c.channel==='demo'?'試聊 · ':'WhatsApp · ')+states[c.state]),el('p',(c.preview||'').slice(0,70)));list.append(b);
  }
}
function fillForms() {
  ['name','service','instructions','tone'].forEach(key => $('#' + key).value = state.profile[key]);
  $(`input[name="mode"][value="${state.settings.mode}"]`).checked = true;
  $('#handoff-contact').value = state.settings.handoffContact;
}
function renderRuntime() {
  const r = state.runtime;
  $('#engine-tag').textContent = r.agent === 'offline' ? '離線示範' : 'AI 已設定';
  $('#workspace-sync').textContent = r.liveReady ? '真實發送已開啟' : '真實發送未開啟';
  $('#demo-description').textContent = r.agent === 'offline' ? '目前以固定規則示範價錢、時間及退款問答。未連接 AI，自訂工作指令未會生效。' : '使用已設定的 AI，根據已儲存指令、有效資料及本次對話產生回覆；會使用 API 額度。';
  const dl = $('#connection-status'); dl.replaceChildren();
  for (const [key,value] of Object.entries({ 'AI':r.agent === 'offline' ? '未連接 · 離線示範' : '已設定 · 未經此畫面驗證連線', 'WhatsApp 接駁':r.evolutionConfigured ? '已設定 · 請用測試帳號核對' : '未設定', '接收訊息':r.webhookConfigured ? '驗證資料已設定' : '未設定', '真實發送':r.liveReady ? '允許發送 · 仍按回覆方式處理' : '未開啟或尚欠設定' })) { dl.append(el('dt',key),el('dd',value)); }
}
function renderKnowledge() {
  const query=$('#knowledge-search').value.trim().toLocaleLowerCase();
  const signature=JSON.stringify([state.knowledge,query,state.knowledge.map(k=>Boolean(k.expires_at && k.expires_at<=Date.now()))]);
  if(signature===knowledgeSignature)return; knowledgeSignature=signature;
  const list = $('#knowledge-list'); list.replaceChildren();
  if (!state.knowledge.length) list.append(el('p','尚未加入資料。留白就代表未知。','empty'));
  const items=state.knowledge.filter(k=>(k.title+' '+k.content).toLocaleLowerCase().includes(query));
  if(state.knowledge.length&&!items.length)list.append(el('p','找不到符合的資料。試試其他字詞。','empty'));
  for (const k of items) {
    const item = el('article',undefined,'knowledge-item');
    const expired = k.expires_at && k.expires_at <= Date.now();
    const heading = el('div',undefined,'inline spread'); heading.append(el('h3',k.title),el('span',expired?'已過期':k.approved?'已確認':'待確認','badge'));
    heading.lastChild.dataset.status=expired?'expired':k.approved?'approved':'pending';
    item.append(heading,el('p',k.content),el('p',k.expires_at?'有效至 '+new Date(k.expires_at).toLocaleDateString('zh-HK'):'未設定到期日','help'));
    const controls = el('div',undefined,'inline');
    if(!k.approved && !expired) controls.append(button('確認採用',async()=>{await api('/knowledge/'+k.id,'POST',{});await refresh();notice('已確認，可用來回答。');}));
    controls.append(button('刪除',async()=>{if(!confirm('刪除這條商戶資料？之後不會再用它回答。'))return;await api('/knowledge/'+k.id,'DELETE');await refresh();},'quiet danger'));
    item.append(controls);list.append(item);
  }
}
function renderContacts() {
  const list = $('#conversation-list'); const filter = $('#conversation-filter').value;
  const query=$('#conversation-search').value.trim().toLocaleLowerCase();
  const signature=JSON.stringify([state.conversations,filter,query,selectedId]);if(signature===contactsSignature)return;contactsSignature=signature;list.replaceChildren();
  const conversations = state.conversations.filter(c => (filter==='all'||(filter==='pending'?isPending(c):c.state===filter)) && (c.name+' '+(c.preview||'')).toLocaleLowerCase().includes(query));
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
    controls.append(button('整理成待確認資料',()=>{page('knowledge');$('#knowledge-details').open=true;$('#fact-title').value='由對話整理';$('#fact-content').value=m.content;$('#fact-approved').checked=false;$('#fact-content').focus();notice('請移除個人資料，核對是否適用於其他客戶，再儲存。');}));box.append(controls);
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
  const signature=JSON.stringify(data);if(signature===demoSignature)return;demoSignature=signature;
  list.replaceChildren(...data.messages.filter(m=>m.status!=='cancelled').map(m=>messageNode(m)));
  if(data.conversation.state!=='ai')list.append(el('p','已列入待處理。請到「工作 → 客戶對話」接手。','service-note'));
}
async function refresh(initial=false) {
  state=await api('/state');$('#login').hidden=true;$('#app').hidden=false;
  if(initial){fillForms();routeFromHash();}renderRuntime();renderKnowledge();renderContacts();renderOverview();
  if(selectedId&&!state.conversations.some(c=>c.id===selectedId))selectedId=null;
  await renderDetail();await renderDemo();
}
$('#login-form').addEventListener('submit',action(async()=>{await api('/login','POST',{token:$('#token').value});$('#token').value='';await refresh(true);notice('已登入。');}));
$('#logout').addEventListener('click',action(async()=>{await api('/logout','POST',{});state=null;selectedId=null;demoId=null;detailSignature='';demoSignature='';closeSidebar(false);$('#app').hidden=true;$('#login').hidden=false;$('#token').focus();}));
$$('[data-page]').forEach(b=>b.addEventListener('click',()=>{if(b.dataset.filter){$('#conversation-filter').value=b.dataset.filter;$('#conversation-search').value='';if(state)renderContacts();}page(b.dataset.page,{focus:true});if(b.dataset.focus)$('#'+b.dataset.focus).focus();}));
$('#add-knowledge').addEventListener('click',openKnowledge);
$('#knowledge-search').addEventListener('input',()=>state&&renderKnowledge());
$('#conversation-search').addEventListener('input',()=>state&&renderContacts());
$('#sidebar-toggle').addEventListener('click',()=>{const narrow=document.body.classList.toggle('studio-narrow');$('#sidebar-toggle').textContent=narrow?'展開側欄':'收窄側欄';$('#sidebar-toggle').setAttribute('aria-expanded',String(!narrow));try{localStorage.setItem('bluesai-sidebar-narrow',String(narrow));}catch{}});
try{if(localStorage.getItem('bluesai-sidebar-narrow')==='true'){$('#sidebar-toggle').click();}}catch{}
$('#mobile-menu').addEventListener('click',()=>{$('#sidebar').classList.add('open');$('#sidebar-backdrop').hidden=false;$('.app-main').inert=true;document.body.classList.add('sidebar-open');$('#mobile-menu').setAttribute('aria-expanded','true');($('#sidebar [data-page].active')||$('#studio-navigation button')).focus();});
$('#sidebar-backdrop').addEventListener('click',()=>closeSidebar());
const closeMenu=button('×',()=>closeSidebar(),'icon-button sidebar-close');closeMenu.setAttribute('aria-label','關閉導覽');$('#sidebar').append(closeMenu);
document.addEventListener('keydown',event=>{if(!$('#sidebar').classList.contains('open'))return;if(event.key==='Escape'){event.preventDefault();closeSidebar();}if(event.key==='Tab'){const items=[$('#sidebar .sidebar-brand'),...$$('#sidebar button')].filter(b=>b.getClientRects().length&&!b.disabled);const first=items[0],last=items.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}});
mobileWidth.addEventListener('change',()=>closeSidebar(false));
$('#page-date').textContent=new Intl.DateTimeFormat('zh-HK',{month:'long',day:'numeric',weekday:'short'}).format(new Date());
$('#profile-form').addEventListener('submit',action(async()=>{const input={};['name','service','instructions','tone'].forEach(k=>input[k]=$('#'+k).value);await api('/profile','PUT',input);await refresh();notice('設定已儲存。舊的 AI 草稿已作廢。');}));
$('#settings-form').addEventListener('submit',action(async()=>{await api('/settings','PUT',{mode:$('input[name="mode"]:checked').value,handoffContact:$('#handoff-contact').value});await refresh();notice('回覆設定已儲存。');}));
$('#knowledge-form').addEventListener('submit',action(async()=>{const date=$('#fact-expiry').value;await api('/knowledge','POST',{title:$('#fact-title').value,category:$('#fact-category').value,content:$('#fact-content').value,approved:$('#fact-approved').checked,expiresAt:date?new Date(date+'T23:59:59').toISOString():null});$('#knowledge-form').reset();await refresh();notice('資料已儲存。');}));
async function demo(text){const result=await api('/demo','POST',{text,conversationId:demoId});demoId=result.conversationId;selectedId=demoId;$('#demo-text').value='';await refresh();}
$('#demo-form').addEventListener('submit',action(async()=>{await demo($('#demo-text').value);}));
$$('[data-question]').forEach(b=>b.addEventListener('click',action(()=>demo(b.dataset.question))));
$('#new-demo').addEventListener('click',()=>{demoId=null;demoSignature='';$('#demo-chat').replaceChildren(el('p','試問一句，看看客服怎樣回答。','empty'));});
$('#refresh').addEventListener('click',action(async()=>{await refresh();notice('已更新資料。未儲存的輸入會保留。');}));
$('#conversation-filter').addEventListener('change',()=>renderContacts());
$('#takeover').addEventListener('click',action(async()=>{await api('/conversations/'+selectedId+'/takeover','POST',{});await refresh();notice('已接手，尚未發送的回覆已取消。');}));
$('#resume').addEventListener('click',action(async()=>{await api('/conversations/'+selectedId+'/resume','POST',{});await refresh();notice('已交回 AI，下一則新訊息才會開始處理。');}));
$('#reply-form').addEventListener('submit',action(async()=>{await api('/conversations/'+selectedId+'/reply','POST',{text:$('#reply-text').value});$('#reply-text').value='';await refresh();notice('回覆已排入處理，請查看狀態。');}));
$('#delete-conversation').addEventListener('click',action(async()=>{if(!confirm('刪除這段對話及訊息？此操作不能復原，也不會刪除 WhatsApp 內的訊息。'))return;await api('/conversations/'+selectedId,'DELETE');if(demoId===selectedId)demoId=null;selectedId=null;detailSignature='';await refresh();}));
refresh(true).catch(()=>{});
setInterval(async()=>{if(!state||pollBusy||document.hidden)return;pollBusy=true;try{await refresh();}catch{}finally{pollBusy=false;}},2500);
