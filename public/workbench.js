(() => {
const icons = {
  dashboard:['M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z'],
  checklist:['M9 5h12 M9 12h12 M9 19h12 M3 5l1 1 2-3 M3 12l1 1 2-3 M3 19l1 1 2-3'],
  folder:['M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z'],
  chat:['M21 11a8 8 0 0 1-8 8H7l-4 3V11a9 9 0 0 1 18 0Z','M7 10h10 M7 14h6'],
  settings:['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8','m9 3-1 3-3 1-2 3 2 2-1 3 2 3h3l2 3 3-1 1-3 3-1 2-3-2-2 1-3-2-3h-3l-2-3Z'],
  menu:['M4 6h16 M4 12h16 M4 18h16'], arrow:['M5 12h14 m-5-5 5 5-5 5'],
  plus:['M12 5v14 M5 12h14'], inbox:['M4 4h16l2 12v4H2v-4Z','M2 16h6l2 3h4l2-3h6']
};
const names={'layout-grid':'dashboard','list-checks':'checklist','folder':'folder','message-circle':'chat','headset':'chat','settings':'settings','arrow-right':'arrow','arrow-left':'arrow','panel-left':'menu','archive':'inbox','file-text':'checklist'};
const cardRoot=document.getElementById('cs-card-design');if(!cardRoot)return;cardRoot.querySelectorAll('[data-lucide]').forEach(node=>{const paths=icons[names[node.dataset.lucide]];if(!paths)return;const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');for(const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(key,value);for(const d of paths){const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',d);svg.append(path);}if(node.dataset.lucide==='arrow-left')svg.style.transform='rotate(180deg)';node.append(svg);});
})();

  (async()=>{
    const root=document.getElementById('cs-card-design');
    const find=s=>root.querySelector(s), all=s=>[...root.querySelectorAll(s)];
    const live=Boolean(root.csBackend), state={screen:'list',tab:'basic',showNumber:true,cardPadding:24,replyMode:'industry'};
    let snapshot={profile:{name:'',industry:'',service:'',instructions:'',tone:'friendly'},settings:{handoffContact:''},knowledge:[],training:[],connections:{ai:{status:'unconfigured',model:''},whatsapp:{status:'unconfigured'}}};
    let busy=false,customerPolling=false,selectedCustomerId=null,customerSignature='',currentCustomerData=null,customerSelectionMade=false,customerPickerSignature='',inboxSummary={policy:{enabled:false,automaticKnowledge:false},pendingHandoffs:[]};
    let inboxPolicyDirty=false,inboxScope=null,selfScopeDirty=false;const notifiedHandoffs=new Set();let inboxEventStream=null;
    const replyDrafts=new Map(),customerDrafts=new Map();
    let dotTasks=[],selectedTask=null,renderedTaskId=null,taskDraftKey=null;
    let taskReadLease=null,taskReadEpoch=0;
    let guideFlow=null,guideStep=0;
    const setupKeys={},setupTasks={};
    const guideLabels={whatsapp:['準備手機和服務','連結手機','接收訊息','試收試覆'],web:['準備網頁客服','取得聊天網址','加入你的網頁','試問及核對']};
    function paintGuide(){
      const active=Boolean(guideFlow);find('[data-guide-header]').hidden=!active;find('[data-guide-nav]').hidden=!active;
      all('[data-secondary-connect]').forEach(node=>node.hidden=active);
      all('[data-guide-flow]').forEach(node=>node.hidden=!active||node.dataset.guideFlow!==guideFlow||Number(node.dataset.guideStep)!==guideStep);
      all('[data-start-guide]').forEach(node=>node.setAttribute('aria-expanded',String(node.dataset.startGuide===guideFlow)));
      if(!active)return;
      find('[data-guide-title]').textContent=guideFlow==='whatsapp'?'接駁 WhatsApp':'接駁網頁';
      find('[data-guide-progress]').textContent=`第 ${guideStep+1} / 4 步 · ${guideLabels[guideFlow][guideStep]}`;
      find('[data-guide-back]').disabled=guideStep===0;find('[data-guide-next]').textContent=guideStep===3?'完成教學':'下一步';
      const c=snapshot.connections,wa=c.whatsapp,runtime=c.mode==='runtime';
      find('[data-guide-wa-ready]').textContent=wa.url&&wa.instance?'接駁服務資料已備妥。下一步會向服務取得真正的二維碼。':'尚未準備接駁服務。你可以先請安裝 AI 幫忙，或繼續閱讀手機操作教學。';
      find('[data-guide-receive-help]').textContent=!runtime?'這裡是隔離預覽。正式收件需要客服服務；準備好後在該服務繼續此教學。'
        :wa.webhook?.registered?(wa.status!=='open'?'收件網址已核對相符；請先確認手機顯示已連接，再指定測試號碼。':wa.inboxScope?.mode==='all_private_text'?'收件網址已核對相符，已開啟全部新私人文字收件；發送按獨立授權檢查。':wa.manualTestEnabled?'收件網址已核對相符，指定測試號碼已開放。請到下一步用 WhatsApp 試收試覆。':wa.localTest?'收件網址已核對相符。下一步：填寫已同意參與的測試號碼，並按「只開放這個號碼測試」。':'收件網址已核對相符。發送仍需完成已授權的渠道及發送設定。')
        :wa.webhook?.configured?'收件設定已備妥，請按上方按鍵核對。':'收件服務尚未準備好，請把這一步交給安裝 AI 處理。';
      find('[data-guide-test-status]').textContent=`手機連線：${wa.status==='open'?'已核對':'尚未核對'}；最近來訊：${wa.evidence?.lastIncomingAt?'已觀察到，請在對話核對測試內容':'尚未觀察到'}；發送開關：${wa.deliveryEnabled?'已開啟':'關閉'}。`;
      all('[data-open-customer-panel]').forEach(node=>{node.hidden=!runtime;});
      const webReady=runtime&&c.webChat?.enabled===true;
      find('[data-guide-web-ready]').textContent=webReady?'網頁客服已開啟。下一步可以打開聊天頁測試。':'網頁客服尚未開啟。請先讓安裝 AI 準備服務，再回來測試。';
      const base=c.publicBaseUrl||location.origin,url=webReady?base+'/chat':'';
      find('[data-web-chat-url]').value=url;find('[data-copy-web-url]').disabled=!webReady;
      const link=find('[data-open-web-chat]');link.hidden=!webReady;link.href=url||'/chat';
      const local=webReady&&['localhost','127.0.0.1','[::1]'].includes(new URL(base).hostname);
      find('[data-web-url-help]').textContent=!webReady?'服務開啟後才會顯示可用網址。':local?'這是本機試用網址，只能在同一部電腦使用。對外分享前，請安裝人員準備公開 HTTPS 網址。':'請先完成最後一步的收發測試，再分享這個網址。';
      find('[data-web-link-code]').value=webReady&&!local?`<a href="${url}">聯絡客服</a>`:'取得公開聊天網址後，這裡會顯示可交給網站維護人員的連結碼。';
    }
    function closeGuide(){const flow=guideFlow;guideFlow=null;paintGuide();if(flow)find(`[data-start-guide="${flow}"]`).focus();}
    const resultDrafts=new Map();
    const form=find('[data-config-form]'), value=(name)=>form.elements.namedItem(name).value;
    const hints={'':'先講答案，再講必要條件。每次只問一個重點。','零售與網店':'先了解客人想買甚麼。價錢、送貨及退換安排，只用已確認的資料。','餐飲':'先了解客人的用餐需要。菜式、價錢、致敏原及訂位安排，沒有資料就交給真人確認。','美容與預約':'先問所需服務。價錢、療程及可約時間，沒有確認就不要承諾。','專業服務':'先了解客人的目的。服務範圍、報價及完成時間，需要已確認的資料。','其他':'先講答案，再講必要條件。每次只問一個重點。'};
    const replyModes={concise:'先直接回答問題，再補充必要條件。盡量用一至三句說清楚，保留重要限制。',friendly:'語氣親切自然，用簡單易明的說話。保持專業，不用幼稚稱呼或過多表情符號。',professional:'語氣禮貌、簡潔、正式。清楚交代已確認的資訊，不作未經確認的承諾。',needs:'先了解客人的目的。資料不足時，每次只問一個必要問題，再提出合適的下一步。',steps:'需要操作時，按次序逐步說明。每一步只做一件事，用短句寫清楚。'};
    const selectedHint=()=>state.replyMode==='industry'?(hints[value('industry')]||hints['']):replyModes[state.replyMode];
    function paintSuggestion(){find('[data-reply-mode]').value=state.replyMode;find('[data-industry-hint]').textContent=selectedHint();}
    function paintConnection(){const ai=snapshot.connections.ai.status,wa=snapshot.connections.whatsapp.status,connected=live&&wa==='open';find('[data-card-status]').dataset.connected=String(connected);find('[data-connection-label]').textContent=connected?'WhatsApp 已連接':wa==='configured'||wa==='connecting'?'WhatsApp 待連接':'WhatsApp 未接駁';find('[data-connection-detail]').textContent=live?`AI 模型：${ai==='connected'?'已驗證':ai==='configured'?'已設定，待驗證':'未設定'}。${connected?'手機已連結；收件及發送另按實際結果核對。':'請進入接駁完成手機連結。'}`:'卡片預覽，沒有建立 WhatsApp 連線。';}
    const category=text=>/回覆方式|語氣|先問|每次|不要|先回答/.test(text)?'style':/營業|開門|幾點|時間|星期|hours/i.test(text)?'hours':/幾錢|價錢|價格|收費|price/i.test(text)?'price':/退款|退貨/i.test(text)?'refund':'general';
    const unavailable=async()=>{throw new Error('這張卡片尚未接駁客服後台。請先由安裝人員準備服務及卡片接口，再使用此功能。');};
    const backend=root.csBackend||{load:async()=>snapshot,dotTasks:async()=>({tasks:[]}),conversations:async()=>({conversations:[]}),inbox:async()=>({conversations:[],policy:{enabled:false,automaticKnowledge:false},pendingHandoffs:[]}),faqRules:async()=>({rules:[]}),configureInbox:unavailable,addFaq:unavailable,inboxContext:unavailable,saveInboxDraft:unavailable,getWhatsAppInboxScope:unavailable,configureWhatsAppInboxScope:unavailable,saveProfile:unavailable,train:unavailable,memory:unavailable,reply:unavailable,model:unavailable,clearAI:unavailable,whatsapp:unavailable,checkWhatsApp:unavailable,clearWhatsApp:unavailable,dotTask:unavailable,createDotTask:unavailable,updateDotTask:unavailable};
    function render(){all('[data-screen]').forEach(x=>x.hidden=x.dataset.screen!==state.screen);all('[data-panel]').forEach(x=>x.hidden=x.dataset.panel!==state.tab);all('[data-tab]').forEach(x=>x.setAttribute('aria-selected',String(x.dataset.tab===state.tab)));find('[data-agent-code]').hidden=!state.showNumber;root.style.setProperty('--cs-card-padding',state.cardPadding+'px');paintSuggestion();paintConnection();}
    // The host owns persisted card layout. Local view changes never overwrite host widget state.
    function remember(){}
    function report(text,error=false){const el=find('[data-feedback]');el.textContent=text;el.dataset.error=String(error);}
    const taskStatusNames={prepared:'待交給智能 Agent',copied:'已複製 · 待處理',opened:'瀏覽器已接受 · 待你送出',host_submitted:'已交給目前 AI 對話',result_saved:'草稿已保存 · 待核對',cancelled:'已取消'};
    const taskExpired=task=>!task?.snapshot||!Array.isArray(task.snapshot.facts)||task.snapshot.facts.some(fact=>fact.expiresAt!=null&&(!Number.isFinite(fact.expiresAt)||fact.expiresAt<=Date.now()));
    const taskClosed=task=>!task||task.contextStale||taskExpired(task)||['result_saved','cancelled'].includes(task.status);
    function invalidateTaskRead(){taskReadLease=null;taskReadEpoch++;}
    function taskReadFresh(){return Boolean(selectedTask&&taskReadLease&&taskReadLease.id===selectedTask.id&&taskReadLease.version===selectedTask.version&&taskReadLease.epoch===taskReadEpoch&&Date.now()-taskReadLease.at<5000&&document.visibilityState!=='hidden'&&document.hasFocus?.()!==false&&!taskClosed(selectedTask));}
    async function checkSelectedTask(){
      if(!selectedTask)throw new Error('請先準備或選擇任務。');const id=selectedTask.id,epoch=taskReadEpoch;const task=(await backend.dotTask(id)).task;
      if(selectedTask?.id!==id)throw new Error('頁面已選擇另一個任務，請重新確認。');selectedTask=task;taskReadLease=epoch===taskReadEpoch?{id,version:task.version,epoch,at:Date.now()}:null;paintTasks();
      if(taskClosed(task))throw new Error('任務資料已更新或過期，請準備新任務。');if(!taskReadLease)throw new Error('核對期間資料有更新，請再核對一次。');return task;
    }
    function taskNotice(text){find('[data-dot-action-status]').textContent=text;}
    function paintTasks(){
      const picker=find('[data-dot-task-picker]'),choices=selectedTask&&!dotTasks.some(task=>task.id===selectedTask.id)?[selectedTask,...dotTasks]:dotTasks;picker.replaceChildren();const empty=document.createElement('option');empty.value='';empty.textContent=choices.length?'選擇任務':'尚未準備任務';picker.append(empty);
      for(const task of choices){const option=document.createElement('option');option.value=task.id;option.textContent=(taskStatusNames[task.status]||'狀態未確認')+' · '+task.instruction.slice(0,40);picker.append(option);}picker.value=selectedTask?.id||'';
      find('[data-dot-task-detail]').hidden=!selectedTask;if(!selectedTask)return;
      const changed=renderedTaskId!==selectedTask.id;find('[data-dot-task-meta]').textContent='任務 '+selectedTask.id;find('[data-dot-task-status]').textContent=taskStatusNames[selectedTask.status]||'狀態未確認';find('[data-dot-task-stale]').hidden=!selectedTask.contextStale&&!taskExpired(selectedTask);find('[data-dot-prompt]').value=selectedTask.prompt;
      for(const name of ['call','copy','cancel'])find('[data-dot-'+name+']').disabled=taskClosed(selectedTask);
      for(const field of find('[data-dot-result-form]').elements)field.disabled=taskClosed(selectedTask);
      if(changed){find('[data-dot-result-form]').elements.text.value=resultDrafts.get(selectedTask.id)||'';taskNotice(selectedTask.status==='opened'?'瀏覽器曾接受交接要求；未能確認任務已送出或處理。':selectedTask.status==='host_submitted'?'任務已交給目前 AI 對話；仍未收到處理結果。':selectedTask.status==='result_saved'?'回傳草稿已保存，請核對內容。':'準備好後，按「呼叫 Codex／DOT」，在原生介面檢查並送出。');}
      find('[data-dot-saved-result]').hidden=!selectedTask.resultText;find('[data-dot-result-text]').textContent=selectedTask.resultText||'';renderedTaskId=selectedTask.id;
    }
    async function refreshTasks(){const result=await backend.dotTasks();dotTasks=result.tasks||[];if(selectedTask){const id=selectedTask.id;try{const task=(await backend.dotTask(id)).task;if(selectedTask?.id===id)selectedTask=task;}catch(error){if(error.status===404&&selectedTask?.id===id)selectedTask={...selectedTask,contextStale:true};else throw error;}}paintTasks();}
    async function updateTask(action,result){
      if(!selectedTask)throw new Error('請先準備或選擇任務。');const taskId=selectedTask.id;
      try{selectedTask=(await backend.updateDotTask(taskId,{action,expectedVersion:selectedTask.version,...(result?{result}:{})})).task;await refreshTasks();return selectedTask;}
      catch(error){if(error.status===409){selectedTask=(await backend.dotTask(taskId)).task;await refreshTasks();throw new Error('任務或資料已更新，已讀取最新狀態。請核對後再操作。');}throw error;}
    }
    function setupAgentBridge(){
      if(!live)return;const bridge=window.csAgentBridge;find('[data-dot-support]').textContent=bridge?.describe?.()||'此瀏覽器未提供直接呼叫功能，可複製任務交給目前智能 Agent。';
      bridge?.registerTools?.({
        getSelectedTask:()=>selectedTask,
        readTask:async id=>{const task=(await backend.dotTask(id)).task;if(selectedTask?.id!==id)throw new Error('頁面已選擇另一個任務，請重新確認。');selectedTask=task;paintTasks();return task;},
        saveResult:async(id,expectedVersion,result)=>{const task=(await backend.updateDotTask(id,{action:'save_result',expectedVersion,result})).task;if(selectedTask?.id===id)selectedTask=task;await refreshTasks();return task;},
        onError:async error=>{if(error.status===409&&selectedTask)await refreshTasks();report(error.message||'操作未完成。',true);},
      });
      find('[data-dot-support]').textContent=bridge?.describe?.()||find('[data-dot-support]').textContent;
    }
    function message(container,role,text,sources=[]){const box=document.createElement('div');box.className='bp-message'+(role==='user'?' bp-customer':'');const who=document.createElement('small');who.textContent=role==='user'?'你':role;const copy=document.createElement('span');copy.textContent=text;box.append(who,copy);if(sources.length){const source=document.createElement('div');source.className='bp-source';source.textContent='用到的記憶：'+sources.map(x=>x.title).join('、');box.append(source);}container.append(box);}
    const statusNames={unconfigured:'未接駁',configured:'已填資料 · 未測試',connected:'連線已驗證',open:'WhatsApp 已連接',close:'未連接手機',connecting:'等待掃碼',unknown:'狀態未確認',error:'連線未成功'};
    const customerStates={ai:'自動處理',waiting:'等待本人／DOT',human:'由人工處理',self_test:'自己傳自己・連線測試（只讀）'};
    const customerStatuses={received:'收到',draft:'待你確認，尚未發送',queued:'等待發送',sending:'已提交發送，可能無法撤回',accepted:'供應商已接受，尚未確認送達',delivered:'已送達',read:'已讀',failed:'發送失敗，請核對',uncertain:'結果未確認，請先在 WhatsApp 核對，不要直接重發',cancelled:'已作廢'};
    function customerNotice(text){find('[data-customer-notice]').textContent=text;}
    function inboxHistoryLimit(){const {includeSelfTests}=inboxReceiveInfo();return '只顯示服務連線後收到的新私人文字；不載入手機舊聊天、群組或媒體。'+(includeSelfTests?'已啟用自己傳自己連線測試，只供閱讀，不自動回覆。':'自己傳給自己的訊息未開啟顯示。');}
    function inboxReceiveInfo(){const wa=snapshot.connections.whatsapp||{},scope=inboxScope?.mode||wa.inboxScope?.mode;return {wa,scope,includeSelfTests:typeof inboxScope?.includeSelfTests==='boolean'?inboxScope.includeSelfTests:wa.inboxScope?.includeSelfTests===true,open:wa.status==='open',registered:wa.webhook?.registered===true};}
    function paintInboxReceiveState(){const {wa,scope,open,registered}=inboxReceiveInfo();const checked=wa.checkedAt?'（'+new Date(wa.checkedAt).toLocaleString('zh-HK')+'）':'';const phone=open?'上次核對：WhatsApp 已連接'+checked:wa.status==='close'?'WhatsApp 手機未連接':wa.status==='error'?'WhatsApp 連線未成功':'WhatsApp 手機狀態待核對';const receive=registered?'收件設定已核對':'收件設定待核對';const range=scope==='all_private_text'?'全部新私人文字':scope==='test'?'指定測試號碼':'收件範圍待核對';const recorded=(inboxSummary.conversations||[]).filter(c=>c.channel==='evolution').map(c=>Number(c.last_customer_at)||0);const when=Math.max(Number(wa.evidence?.lastIncomingAt)||0,0,...recorded);const observed=when?'最近客戶來訊記錄：'+new Date(when).toLocaleString('zh-HK'):(inboxSummary.conversations||[]).some(c=>c.channel==='whatsapp_self_test')?'已顯示自傳連線測試；客戶來訊另待驗收':'此頁尚未讀取到 WhatsApp 客戶來訊記錄';const text=[phone,receive,range,observed].join(' · ');const node=find('[data-inbox-receive-state]');if(node.textContent!==text)node.textContent=text;}
    function emptyInboxInfo(){const {scope,includeSelfTests,open,registered}=inboxReceiveInfo();const visible=(inboxSummary.conversations||[]).some(c=>['evolution','whatsapp_self_test'].includes(c.channel)||(c.channel==='web'&&snapshot.connections.webChat?.enabled===true));if(visible)return {title:'請選擇客戶對話',next:'從上方選擇一位客戶，查看來訊及回覆。'};if(!open)return {title:'WhatsApp 連線待核對',next:'按「檢查 WhatsApp 收件」，確認手機連線及收件設定。'};if(!registered)return {title:'手機已連接，收件設定待核對',next:'按「檢查 WhatsApp 收件」核對訊息如何進入客服。'};if(includeSelfTests)return {title:'等待 WhatsApp 連線測試訊息',next:'現在可用已連結帳戶傳文字給自己。自傳訊息只供閱讀；另一個帳戶來訊再另行驗收。'};if(scope==='all_private_text')return {title:'等待 WhatsApp 新來訊',next:'請用另一個 WhatsApp 帳戶，現在傳一則文字到已連結的號碼。'};if(scope==='test')return {title:'等待指定測試號碼的新來訊',next:'請由已開放的另一個號碼傳新文字；其他號碼須先在「接駁」更改收件範圍。'};return {title:'收件範圍待核對',next:'按「檢查 WhatsApp 收件」，讀回目前會接收哪些新訊息。'};}
    function paintEmptyInbox(){paintInboxReceiveState();const info=emptyInboxInfo(),messages=find('[data-customer-messages]'),signature=JSON.stringify({...info,limit:inboxHistoryLimit()});if(messages.dataset.emptySignature===signature&&messages.firstElementChild?.dataset.inboxEmpty==='true')return;messages.dataset.emptySignature=signature;messages.replaceChildren();const empty=document.createElement('div');empty.className='bp-inbox-empty';empty.dataset.inboxEmpty='true';const title=document.createElement('strong');title.textContent=info.title;const next=document.createElement('p');next.textContent=info.next;const limit=document.createElement('p');limit.textContent=inboxHistoryLimit();empty.append(title,next,limit);messages.append(empty);}
    function customerSendReady(c){if(c.channel==='whatsapp_self_test')return false;if(c.channel!=='evolution')return true;return snapshot.connections.whatsapp.readiness?.canSend===true;}
    function paintCustomerDetail(data){
      const c=data?.conversation,holder=find('[data-customer-detail]');currentCustomerData=data;holder.hidden=false;if(!c){customerSignature='';find('[data-customer-name]').textContent='等待新的 WhatsApp 來訊';find('[data-customer-state]').textContent='等待新來訊';find('[data-customer-takeover]').hidden=true;find('[data-customer-resume]').hidden=true;find('[data-inbox-dot-call]').disabled=true;find('[data-inbox-dot-details]').hidden=true;const composer=find('[data-customer-reply-form]');composer.elements.text.disabled=true;composer.elements.text.value='';find('[data-customer-send]').disabled=true;paintEmptyInbox();find('[data-customer-send-note]').textContent='收到來訊後可在這裡接手並回覆。';return;}const selfTest=c.channel==='whatsapp_self_test';find('[data-inbox-dot-details]').hidden=selfTest;find('[data-customer-takeover]').disabled=selfTest;
      find('[data-customer-name]').textContent=selfTest?'自己傳自己・連線測試':c.name||'WhatsApp 客戶';find('[data-customer-state]').textContent=selfTest?'自己傳自己・連線測試（只讀）':customerStates[c.state]||'狀態未確認';
      const canSend=customerSendReady(c),wa=snapshot.connections.whatsapp;
      const missing=wa.readiness?.missingFields||[!snapshot.profile.name&&'商戶名稱',!snapshot.profile.service&&'服務介紹',!snapshot.settings.handoffContact&&'人工聯絡安排'].filter(Boolean);
      find('[data-customer-send-note]').textContent=selfTest?'這是真正的 WhatsApp 自傳文字，只供連線測試閱讀；不自動回覆、不交給 DOT，也不當作客戶收發驗收。':c.channel==='evolution'?(missing.length?'請先在本卡片填寫並儲存：'+missing.join('、')+'。':!canSend?'WhatsApp 發送尚未開放。請到「接駁」指定已同意參與的測試號碼。':wa.inboxReplyEnabled?'目前可回覆已接收的新私人來訊；不開放任意陌生訊息。':wa.manualTestEnabled?'目前只開放指定號碼的真正 WhatsApp 測試。':'WhatsApp 發送已開啟，發送前會再次檢查當前資料及對話狀態。'):'這是已接駁網頁的實際來訊。回覆經確認後才提交給客人。';
      find('[data-customer-takeover]').hidden=selfTest||c.state==='human';find('[data-customer-resume]').hidden=selfTest||c.state==='ai';find('[data-inbox-dot-call]').hidden=selfTest;
      find('[data-customer-resume]').disabled=!inboxSummary.policy?.enabled&&snapshot.connections.ai.status!=='connected';find('[data-customer-resume]').textContent=inboxSummary.policy?.enabled?'交回知識庫':'交回 AI';
      const composer=find('[data-customer-reply-form]');composer.elements.text.disabled=selfTest||c.state!=='human';composer.elements.text.placeholder=selfTest?'自己傳自己連線測試只供閱讀，不發送回覆。':'先接手對話，再寫下要發給客人的回覆。';find('[data-customer-send]').disabled=selfTest||c.state!=='human'||!canSend;
      const signature=JSON.stringify(data);if(signature===customerSignature)return;customerSignature=signature;
      if(document.activeElement!==composer.elements.text)composer.elements.text.value=selfTest?'':replyDrafts.get(c.id)||'';
      const messages=find('[data-customer-messages]'),oldScroll=messages.scrollTop,atBottom=messages.scrollHeight-messages.clientHeight-oldScroll<60,active=document.activeElement;const focusedDraft=messages.contains(active)?{id:active.dataset.draftId,start:active.selectionStart,end:active.selectionEnd}:null;delete messages.dataset.emptySignature;messages.replaceChildren();
      find('[data-inbox-dot-prompt]').value=selfTest?'':root.csInboxTools?.prompt(c.id)||'';find('[data-inbox-dot-call]').disabled=selfTest||!root.csInboxTools;
      for(const m of data.messages||[]){
        const item=document.createElement('article');item.className='bp-customer-message';const meta=document.createElement('small');meta.textContent=(m.role==='user'?(selfTest?'本人':'客人'):m.role==='staff'?'人工回覆':'客服')+' · '+(customerStatuses[m.status]||'狀態未確認')+(m.engine==='offline'?' · 離線規則草稿，並非模型回覆':m.engine==='codex-dot'?' · DOT 建議草稿':m.engine==='knowledge'?' · 已確認知識庫答案':'');const text=document.createElement('p');text.textContent=m.content;item.append(meta,text);
        if(!selfTest&&m.status==='draft'&&m.engine==='codex-dot'){const adopt=document.createElement('button');adopt.type='button';adopt.className='bp-button';adopt.textContent='採用到人工回覆';adopt.disabled=m.version!==c.version;adopt.addEventListener('click',()=>run(adopt,async()=>{const context=await backend.inboxContext(c.id);if(selectedCustomerId!==c.id||context.version!==m.version||context.revision!==m.config_version)throw new Error('訊息或知識已更新，請讓 DOT 重新閱讀後產生草稿。');replyDrafts.set(c.id,m.content);composer.elements.text.value=m.content;customerNotice(c.state==='human'?'草稿已放入人工回覆欄，請核對後發送。':'草稿已放入人工回覆欄，請先接手對話再核對發送。');}));item.append(adopt);}
        if(!selfTest&&m.status==='draft'&&c.state==='ai'&&m.role==='assistant'&&m.engine!=='codex-dot'){
          const editor=document.createElement('textarea');editor.rows=3;editor.maxLength=4000;editor.value=customerDrafts.get(m.id)||m.content;editor.dataset.draftId=m.id;editor.setAttribute('aria-label','核對客戶回覆草稿');editor.addEventListener('input',()=>customerDrafts.set(m.id,editor.value));
          const actions=document.createElement('div');actions.className='bp-actions';const approve=document.createElement('button');approve.className='bp-button bp-primary';approve.type='button';approve.textContent='確認並發送';approve.disabled=!canSend;
          approve.addEventListener('click',()=>run(approve,async()=>{try{await backend.approveReply(m.id,editor.value);customerDrafts.delete(m.id);customerNotice('回覆已排隊。請查看實際提交及送達狀態。');}finally{await refreshCustomers();}}));actions.append(approve);item.append(editor,actions);
        }
        messages.append(item);
      }
      messages.scrollTop=atBottom?messages.scrollHeight:oldScroll;if(focusedDraft?.id){const field=[...messages.querySelectorAll('[data-draft-id]')].find(node=>node.dataset.draftId===focusedDraft.id);if(field){field.focus({preventScroll:true});field.setSelectionRange(focusedDraft.start,focusedDraft.end);}}
    }
    function paintInboxSummary(result){
      inboxSummary=result;const pending=result.pendingHandoffs||[],count=result.pendingCount??pending.length,alert=find('[data-owner-alert]');alert.hidden=!count;const alertText=`${count} 段對話待你／DOT 處理：知識庫未能直接回答。`;if(alert.textContent!==alertText)alert.textContent=alertText;find('[data-inbox-entry-count]').textContent=count?`${count} 段對話等待你或 DOT 處理`:'即時對話與知識庫優先處理';
      if(!inboxPolicyDirty){const f=find('[data-inbox-policy]');f.elements.enabled.checked=result.policy?.enabled===true;f.elements.automaticKnowledge.checked=result.policy?.automaticKnowledge===true;}
      find('[data-inbox-policy-status]').textContent=result.policy?.enabled?(result.policy.automaticKnowledge?'知識庫優先已啟用；符合問題及發送條件時自動回覆。':'知識庫優先已啟用；有答案先存草稿，無答案提示本人。'):'知識庫優先尚未啟用。人工回覆毋須模型 API。';
      for(const task of pending){const id=task.id||task.window_id;if(!id||notifiedHandoffs.has(id))continue;notifiedHandoffs.add(id);if(typeof Notification!=='undefined'&&Notification.permission==='granted'){try{new Notification('客服有待處理對話',{body:'知識庫未能直接回答，請開啟客服卡片核對。',tag:'bluesai-inbox'});}catch{}}}
    }
    async function refreshCustomers(){
      if(!live){customerNotice('客服後台尚未接駁，現在不能讀取來訊。');return;}
      if(customerPolling)return;customerPolling=true;
      try{
        const result=await backend.inbox();paintInboxSummary(result);const conversations=(result.conversations||[]).filter(c=>['evolution','whatsapp_self_test'].includes(c.channel)||(c.channel==='web'&&snapshot.connections.webChat?.enabled===true)),picker=find('[data-customer-picker]');
        const pickerSignature=JSON.stringify(conversations.map(c=>[c.id,c.name,c.channel,c.state,c.pending]));if(pickerSignature!==customerPickerSignature&&document.activeElement!==picker){picker.replaceChildren();const empty=document.createElement('option');empty.value='';empty.textContent=conversations.length?'選擇來訊對話':'尚未收到真實渠道來訊';picker.append(empty);for(const c of conversations){const option=document.createElement('option');option.value=c.id;option.textContent=(c.channel==='whatsapp_self_test'?'WhatsApp · 自己傳自己・連線測試':(c.channel==='evolution'?'WhatsApp':'網頁')+' · '+(c.name||'客戶'))+' · '+(customerStates[c.state]||'狀態未確認')+(c.pending?' · 待你處理':'');picker.append(option);}customerPickerSignature=pickerSignature;}
        if(selectedCustomerId&&!conversations.some(c=>c.id===selectedCustomerId)){selectedCustomerId=null;customerSignature='';root.csInboxTools?.invalidate();}
        if(!selectedCustomerId&&!customerSelectionMade&&conversations.length)selectedCustomerId=conversations[0].id;
        picker.value=selectedCustomerId||'';
        if(selectedCustomerId){const id=selectedCustomerId,data=await backend.conversation(id);if(selectedCustomerId===id)paintCustomerDetail(data);}else paintCustomerDetail(null);
        find('[data-inbox-updated]').textContent='最近讀取 '+new Date().toLocaleTimeString('zh-HK');
        paintInboxReceiveState();if(!conversations.length){const info=emptyInboxInfo();const text=info.title+'。'+info.next;if(find('[data-customer-notice]').textContent!==text)customerNotice(text);}else if(find('[data-customer-notice]').textContent==='正在讀取實際來訊。')customerNotice('已讀回實際來訊。新訊息會自動更新，未送出的輸入會保留。');
      }catch(error){customerNotice(error.message||'讀取來訊未成功，請稍後重試。');throw error;}finally{customerPolling=false;}
    }
    function openCustomerPanel(){guideFlow=null;state.screen='config';state.tab='basic';render();paintGuide();find('[data-customer-panel]').scrollIntoView({block:'start'});refreshCustomers().catch(()=>{});}
    async function refreshFaq(){const result=await backend.faqRules(),holder=find('[data-inbox-faq-list]');holder.replaceChildren();const rules=result.rules||[];find('[data-inbox-faq-count]').textContent=rules.length+' 條完整問題規則（答案須經確認並仍有效）';for(const rule of rules){const item=document.createElement('article');item.className='bp-memory';const question=document.createElement('strong');question.textContent=rule.question;const answer=document.createElement('p');answer.textContent=rule.answer||rule.content||'';const state=document.createElement('small');state.textContent=rule.approved?'答案已確認':'答案待確認；不會自動採用';item.append(question,answer,state);holder.append(item);}}
    function paintInboxScope(){const note=find('[data-inbox-scope-state]');const scopeText=inboxScope?.mode==='all_private_text'?(inboxScope.replyToReceived?'目前接收全部新私人文字來訊；已明確允許回覆最近來訊客戶，仍須通過當前發送檢查。':'目前接收全部新私人文字來訊；發送仍保持關閉。'):'目前只接收指定測試號碼。';note.textContent=scopeText+(inboxScope?.includeSelfTests?' 自己傳自己連線測試已開啟，只供閱讀。':' 自己傳自己連線測試未開啟。');if(!selfScopeDirty)find('[data-inbox-self-test-consent]').checked=inboxScope?.includeSelfTests===true;}
    async function refreshInboxScope(){if(snapshot.connections.mode!=='runtime'){find('[data-inbox-scope]').hidden=true;return;}find('[data-inbox-scope]').hidden=false;try{inboxScope=await backend.getWhatsAppInboxScope();paintInboxScope();paintInboxReceiveState();if(!currentCustomerData)paintEmptyInbox();}catch{find('[data-inbox-scope-state]').textContent='此接駁服務尚未提供全部新私人文字收件設定。';}}
    function paintData(fill=false){
      if(fill){for(const key of ['name','industry','service','instructions','tone'])form.elements.namedItem(key).value=snapshot.profile[key]|| (key==='tone'?'friendly':'');find('[data-model-form]').elements.model.value=snapshot.connections.ai.model||'';form.elements.responseMode.value=snapshot.settings.mode||'review';form.elements.handoffContact.value=snapshot.settings.handoffContact||'';}
      paintSuggestion();paintConnection();
      const memories=find('[data-memories]');memories.replaceChildren();
      if(!snapshot.knowledge.length){const p=document.createElement('p');p.className='bp-small bp-muted';p.textContent='還沒有記憶。由左邊的對話開始。';memories.append(p);}
      for(const item of snapshot.knowledge){const box=document.createElement('article');box.className='bp-memory';const badge=document.createElement('span');badge.className='bp-badge';badge.textContent=item.approved?'已確認 · '+(item.category==='style'?'回覆方式':'商戶資料'):'待你確認';const text=document.createElement('p');text.textContent=item.content;const actions=document.createElement('div');actions.className='bp-actions';box.append(badge,text,actions);
        const button=(label,fn,primary=false)=>{const b=document.createElement('button');b.type='button';b.className='bp-button cursor-interaction'+(primary?' bp-primary':'');b.textContent=label;b.addEventListener('click',()=>run(b,fn));actions.append(b);return b;};
        if(!item.approved)button('確認採用',async()=>{await backend.memory(item.id,'approve');await refresh();report(live?'記憶已確認，可以用作客服回覆的依據。':'已在設計稿確認記憶。');},true);
        button('修改',()=>{if(box.querySelector('textarea'))return;const editor=document.createElement('textarea');editor.maxLength=2000;editor.rows=4;editor.value=item.content;editor.setAttribute('aria-label','修改記憶內容');text.hidden=true;box.insertBefore(editor,actions);const kind=document.createElement('select');kind.setAttribute('aria-label','記憶類別');for(const [key,label] of Object.entries({general:'一般商戶資料',hours:'營業時間',price:'價格',refund:'退換安排',style:'回覆方式'})){const option=document.createElement('option');option.value=key;option.textContent=label;kind.append(option);}kind.value=item.category;box.insertBefore(kind,actions);button('儲存修改',async()=>{if(!editor.value.trim())throw new Error('請填寫記憶內容。');await backend.memory(item.id,'edit',editor.value.trim(),kind.value);await refresh();report('修改已儲存，請重新確認。');},true);editor.focus();});
        button('刪除',async()=>{await backend.memory(item.id,'delete');await refresh();report('這條記憶已刪除。');});memories.append(box);
      }
      const usable=snapshot.knowledge.filter(x=>x.approved&&(!x.expires_at||x.expires_at>Date.now())).length;
      find('[data-memory-count]').textContent=usable+' 條可用';
      const chat=find('[data-training-chat]');chat.replaceChildren();for(const turn of snapshot.training)message(chat,turn.role==='user'?'user':'訓練助手',turn.content);
      const ai=snapshot.connections.ai,wa=snapshot.connections.whatsapp;find('[data-ai-status]').textContent=statusNames[ai.status]||'狀態未確認';find('[data-wa-status]').textContent=statusNames[wa.status]||'狀態未確認';
      const runtime=snapshot.connections.mode==='runtime';
      const modelLabel={unconfigured:'AI 模型未設定',configured:'AI 模型待驗證',connected:'AI 模型已驗證',error:'AI 模型連線未成功'}[ai.status]||'AI 模型狀態未確認';
      find('[data-runtime-label]').textContent=live?`${runtime?'客服卡片':'本機卡片預覽'} · ${modelLabel}`:'後台尚未接駁';
      find('[data-runtime-connection]').hidden=!runtime;
      const missingProfile=Array.isArray(wa.readiness?.missingFields)?wa.readiness.missingFields:[!snapshot.profile.name&&'商戶名稱',!snapshot.profile.service&&'服務介紹',!snapshot.settings.handoffContact&&'人工聯絡安排'].filter(Boolean);find('[data-wa-profile-ready]').textContent=missingProfile.length?'真正發送前還需在本卡片填寫並儲存：'+missingProfile.join('、')+'。':'必要客服資料已儲存；發送仍需通過測試號碼及當前對話檢查。';find('[data-open-basic]').hidden=!missingProfile.length;
      const testReady=runtime&&wa.localTest===true&&wa.status==='open'&&wa.webhook?.registered===true;find('[data-wa-test-submit]').disabled=!testReady;find('[data-wa-test-state]').textContent=wa.inboxScope?.mode==='all_private_text'?'目前已開啟全部新私人文字收件；指定號碼仍可用作獨立測試，發送範圍另行核對。':wa.manualTestEnabled?`已開放指定測試號碼：${(wa.testRecipients?.maskedNumbers||[]).join('、')||'已設定'}。其餘來訊不會進入本客服；重啟後需重新開放測試。`:!wa.localTest?'指定號碼的受限測試需要本機 WhatsApp 接駁服務。其他供應商須另行完成已授權的正式發送設定。':testReady?'手機及收件設定已核對。只開放本人或已同意參與的號碼測試；不會開放其他客戶。':'先完成手機掃碼及收件網址核對，才可以開放指定號碼測試。';
      if(runtime){
        const f=find('[data-whatsapp-form]');
        for(const key of ['url','instance']){f.elements[key].value=wa[key]||'';f.elements[key].readOnly=true;f.elements[key].required=false;}
        f.elements.apiKey.disabled=true;f.elements.apiKey.placeholder='已從伺服器私人設定載入；此頁不顯示';
        const when=timestamp=>timestamp?new Date(timestamp).toLocaleString('zh-HK'):'尚未觀察到';
        find('[data-channel-evidence]').textContent=`收件入口：${wa.receiveEnabled?'已設定':'未設定'}；供應商 webhook：${wa.webhook?.registered?'讀回相符':'未核對'}；WhatsApp 發送開關：${wa.deliveryEnabled?'已開啟':'關閉'}。最近來訊：${when(wa.evidence?.lastIncomingAt)}；最近回執：${when(wa.evidence?.lastReceiptAt)}。`;
        find('[data-channel-help]').textContent='本頁與客戶對話共用同一客服執行器及資料庫。金鑰、PUBLIC_BASE_URL、WEBHOOK_SECRET 及 DELIVERY_ENABLED 由伺服器私人環境設定；工作台不會暗中開啟發送。';
        find('[data-card-context]').textContent='客服 AI 卡片 · 設定、記憶及來訊只屬於此 Agent';
      }
      if(live){find('[data-training-mode]').textContent=ai.status==='connected'?'AI 會參考最近的訓練對話整理記憶。你確認後才用來回答客戶。':'未接駁 AI：會將你教的內容原文存為待確認記憶。';}
      paintGuide();paintInboxReceiveState();if(currentCustomerData)paintCustomerDetail(currentCustomerData);else paintEmptyInbox();
    }
    async function refresh(fill=false){invalidateTaskRead();snapshot=await backend.load();paintData(fill);await refreshTasks();await Promise.all([refreshCustomers(),refreshFaq(),refreshInboxScope()]);}
    async function run(button,fn){if(busy)return;busy=true;const original=button?.textContent;if(button){button.disabled=true;button.textContent='處理中…';}try{await fn();}catch(e){report(e.message||'操作未完成，請再試。',true);}finally{busy=false;if(button){button.disabled=false;button.textContent=original;}if(selectedTask)paintTasks();if(currentCustomerData)paintCustomerDetail(currentCustomerData);const wa=snapshot.connections.whatsapp;find('[data-wa-test-submit]').disabled=!(snapshot.connections.mode==='runtime'&&wa.status==='open'&&wa.webhook?.registered===true);}}
    function setupInboxTools(){
      if(!live)return;root.csInboxTools?.register({selectedConversation:()=>state.screen==='config'&&state.tab==='basic'&&currentCustomerData?.conversation?.id===selectedCustomerId&&currentCustomerData.conversation.channel!=='whatsapp_self_test'?selectedCustomerId:null,listInbox:()=>backend.inbox(),readContext:id=>backend.inboxContext(id),saveDraft:async input=>{const result=await backend.saveInboxDraft(input);if(selectedCustomerId===input.conversationId){customerSignature='';await refreshCustomers();find('[data-inbox-dot-status]').textContent='DOT 草稿已保存，請核對後採用到人工回覆；尚未發送。';}return result;},onError:error=>{find('[data-inbox-dot-status]').textContent=error.message||'即時對話工具未完成。';}});
      if(typeof EventSource==='function'){inboxEventStream=new EventSource('/api/agents/bluesai-cs-0001/inbox/events');inboxEventStream.addEventListener('change',()=>{if(root.isConnected&&!document.hidden&&!busy)refreshCustomers().catch(()=>{});});window.addEventListener('pagehide',()=>{inboxEventStream?.close();inboxEventStream=null;},{once:true});}
    }
    find('[data-inbox-policy]').addEventListener('change',()=>{inboxPolicyDirty=true;});
    find('[data-inbox-policy]').addEventListener('submit',event=>{event.preventDefault();const f=event.currentTarget;run(event.submitter,async()=>{await backend.configureInbox({enabled:f.elements.enabled.checked,automaticKnowledge:f.elements.automaticKnowledge.checked});inboxPolicyDirty=false;await refreshCustomers();report('知識庫處理方式已儲存；WhatsApp 發送另按實際授權核對。');});});
    find('[data-inbox-faq-form]').addEventListener('submit',event=>{event.preventDefault();const f=event.currentTarget;run(event.submitter,async()=>{await backend.addFaq({question:f.elements.question.value.trim(),answer:f.elements.answer.value.trim(),approved:f.elements.approved.checked});f.reset();await Promise.all([refreshFaq(),refresh()]);report('常見問題已儲存。只會採用你已確認且仍有效的答案。');});});
    find('[data-inbox-notifications]').addEventListener('click',event=>run(event.currentTarget,async()=>{if(typeof Notification==='undefined'||typeof Notification.requestPermission!=='function')throw new Error('此瀏覽器未提供桌面通知；卡片內待處理提示仍然可用。');const result=await Notification.requestPermission();customerNotice(result==='granted'?'瀏覽器通知已允許；新增待處理會嘗試提示你，卡片亦會保留待處理提示。':'瀏覽器通知未允許；請留意卡片內持續顯示的待處理提示。');}));
    find('[data-inbox-self-test-consent]').addEventListener('change',()=>{selfScopeDirty=true;});
    find('[data-inbox-scope-enable]').addEventListener('click',event=>run(event.currentTarget,async()=>{if(!find('[data-inbox-scope-consent]').checked)throw new Error('請先確認全部新私人文字來訊的收件範圍。');inboxScope=await backend.configureWhatsAppInboxScope({mode:'all_private_text',consent:true,replyToReceived:find('[data-inbox-reply-consent]').checked,includeSelfTests:find('[data-inbox-self-test-consent]').checked});selfScopeDirty=false;await refresh();paintInboxScope();report('收件範圍已讀回核對；發送權限另按已確認的選項及服務狀態檢查。');}));
    find('[data-inbox-scope-test]').addEventListener('click',event=>run(event.currentTarget,async()=>{inboxScope=await backend.configureWhatsAppInboxScope({mode:'test',consent:true,replyToReceived:false,includeSelfTests:false});selfScopeDirty=false;find('[data-inbox-self-test-consent]').checked=false;find('[data-inbox-scope-consent]').checked=false;find('[data-inbox-reply-consent]').checked=false;await refresh();paintInboxScope();report('已恢復指定測試號碼收件，全部來訊回覆授權已關閉。');}));
    find('[data-inbox-dot-call]').addEventListener('click',event=>{
      if(!selectedCustomerId){customerNotice('請先選擇目前客戶對話。');return;}find('[data-inbox-dot-details]').open=true;const target=find('[data-inbox-dot-prompt]');target.scrollIntoView({block:'nearest'});let request;try{request=root.csInboxTools?.invoke(target);}catch(error){find('[data-inbox-dot-status]').textContent=error.message;return;}if(!request){find('[data-inbox-dot-status]').textContent='此頁未提供 DOT 工具，請複製任務到目前對話。';return;}
      if(request.kind==='annotation'){find('[data-inbox-dot-status]').textContent=request.accepted?'瀏覽器已接受開啟要求。請在原生介面檢查並送出；尚未確認 DOT 已閱讀或已回覆。':'瀏覽器未接受開啟要求，請選取任務內容複製到目前 Codex／DOT。';return;}
      run(event.currentTarget,async()=>{const accepted=await request.promise;find('[data-inbox-dot-status]').textContent=accepted?(request.kind==='host'?'任務已交給目前 AI 對話，等待回傳草稿；尚未發送客戶訊息。':'任務已複製，請貼到目前 Codex／DOT 對話並送出。'):'未能交接；請選取任務內容複製到目前 Codex／DOT。';});
    });
    render();
    find('[data-open]').addEventListener('click',()=>{state.screen='config';state.tab='basic';render();form.closest('details').open=true;form.scrollIntoView({block:'start'});remember();refreshCustomers().catch(()=>{});});
    find('[data-open-whatsapp]').addEventListener('click',()=>{state.screen='config';state.tab='connect';guideFlow='whatsapp';guideStep=0;render();paintGuide();remember();find('[data-guide-title]').focus();});
    find('[data-open-basic]').addEventListener('click',()=>{state.tab='basic';render();form.closest('details').open=true;form.elements.name.focus();});
    find('[data-back]').addEventListener('click',()=>{state.screen='list';render();remember();});
    all('[data-open-customer-panel]').forEach(button=>button.addEventListener('click',openCustomerPanel));

    find('[data-inbox-connection-check]').addEventListener('click',event=>run(event.currentTarget,async()=>{let failure;try{await backend.checkWhatsApp();await backend.checkWebhook();inboxScope=await backend.getWhatsAppInboxScope();}catch(error){failure=error;}finally{await refresh();}const {wa,open,registered}=inboxReceiveInfo();if(!open||!registered||failure){guideFlow='whatsapp';guideStep=open?2:1;state.screen='config';state.tab='connect';render();paintGuide();find('[data-guide-title]').focus();}if(failure)throw failure;const d=wa.receiveDiagnostics;const events=d?.upserts?.events,queued=d?.queued?.incoming,selfTests=d?.queued?.selfTest;report(open&&registered?'手機連線及收件設定已讀回核對。'+(Number.isInteger(events)&&Number.isInteger(queued)?`服務已觀察 ${events} 次訊息事件；客戶文字排隊 ${queued} 則${Number.isInteger(selfTests)?'，自身連線測試 '+selfTests+' 則':''}。`:''):'請在接駁步驟核對目前缺項。');}));
    find('[data-customer-refresh]').addEventListener('click',event=>run(event.currentTarget,async()=>{await refreshCustomers();customerNotice('已讀回此客服卡片的最新來訊。');}));
    find('[data-customer-picker]').addEventListener('change',event=>{if(busy||customerPolling){event.currentTarget.value=selectedCustomerId||'';return;}if(selectedCustomerId)replyDrafts.set(selectedCustomerId,find('[data-customer-reply-form]').elements.text.value);selectedCustomerId=event.currentTarget.value||null;customerSignature='';run(null,refreshCustomers);});
    find('[data-customer-reply-form]').elements.text.addEventListener('input',event=>{if(selectedCustomerId)replyDrafts.set(selectedCustomerId,event.target.value);});
    for(const [selector,action] of [['[data-customer-takeover]','takeover'],['[data-customer-resume]','resume']])find(selector).addEventListener('click',event=>run(event.currentTarget,async()=>{if(!selectedCustomerId)return;await backend[action](selectedCustomerId);customerSignature='';await refreshCustomers();customerNotice(action==='takeover'?'你已接手，尚未提交的舊草稿會作廢。':inboxSummary.policy?.enabled?'已交回知識庫；下一則來訊先核對已確認答案，沒有答案便提示你。':'已交回 AI，下一則來訊才開始新的處理。');}));
    find('[data-customer-reply-form]').addEventListener('submit',event=>{event.preventDefault();const id=selectedCustomerId,field=event.currentTarget.elements.text,text=field.value.trim();run(event.submitter,async()=>{if(!id||!text)throw new Error('請先選擇對話並填寫回覆。');try{await backend.manualReply(id,text);replyDrafts.delete(id);if(id===selectedCustomerId)field.value='';customerNotice('人工回覆已排隊，請核對渠道的實際送達結果。');}finally{await refreshCustomers();}});});
    const inboxPollTimer=setInterval(()=>{if(!root.isConnected){clearInterval(inboxPollTimer);inboxEventStream?.close();inboxEventStream=null;return;}if(live&&!busy&&!document.hidden)refreshCustomers().catch(()=>{});},1000);
    window.addEventListener('pagehide',()=>clearInterval(inboxPollTimer),{once:true});
    all('[data-tab]').forEach(button=>button.addEventListener('click',()=>{state.tab=button.dataset.tab;render();remember();}));
    form.addEventListener('submit',event=>{event.preventDefault();run(event.submitter,async()=>{const p=Object.fromEntries(['name','industry','service','instructions','tone'].map(k=>[k,value(k)]));await backend.saveProfile(p,{...snapshot.settings,handoffContact:form.elements.handoffContact.value.trim(),mode:form.elements.responseMode.value});await refresh();report(live?'基本設定已儲存在這部電腦。':'已示範儲存，沒有寫入工作室。');});});
    form.elements.industry.addEventListener('change',paintSuggestion);
    find('[data-reply-mode]').addEventListener('change',event=>{state.replyMode=event.target.value;paintSuggestion();remember();});
    find('[data-use-hint]').addEventListener('click',()=>{const field=form.elements.instructions;const next=[field.value,selectedHint()].filter(Boolean).join('\n');if(next.length>2000){report('指令太長，請先整理現有內容再加入。',true);return;}field.value=next;report('已加入所選模式，按「儲存基本設定」採用。');});
    find('[data-teaching-example]').addEventListener('click',()=>{find('[data-training-form]').elements.text.value='【示範資料，請改成你的實際安排】\n客人問：星期日有開門嗎？\n客服答：星期日休息，星期一至六上午十時至晚上七時營業。';report('已填入示例，尚未儲存。請先改成你的實際安排。');});
    find('[data-training-form]').addEventListener('submit',event=>{event.preventDefault();const field=event.currentTarget.elements.text;run(event.submitter,async()=>{await backend.train(field.value.trim());field.value='';await refresh();report('請檢查剛整理的記憶，再確認採用。');});});
    find('[data-dot-task-form]').elements.instruction.addEventListener('input',()=>{taskDraftKey=null;});
    find('[data-dot-task-form]').addEventListener('submit',event=>{event.preventDefault();const instruction=event.currentTarget.elements.instruction.value.trim();run(event.submitter,async()=>{if(!instruction)throw new Error('請寫下想處理的任務。');taskDraftKey ||= globalThis.crypto?.randomUUID?.()||('task-'+Date.now()+'-'+Math.random().toString(36).slice(2));const result=await backend.createDotTask({instruction,idempotencyKey:taskDraftKey});taskDraftKey=null;selectedTask=result.task;await refreshTasks();find('[data-dot-prompt-details]').open=true;taskNotice(live?'任務已準備，請先檢查內容，再交給智能 Agent。':'已準備設計示例，沒有呼叫智能 Agent。');report(live?'任務已儲存在這部電腦。':'已準備設計示例。');});});
    find('[data-dot-task-picker]').addEventListener('change',event=>{if(busy){event.currentTarget.value=selectedTask?.id||'';return;}invalidateTaskRead();if(selectedTask)resultDrafts.set(selectedTask.id,find('[data-dot-result-form]').elements.text.value);const id=event.currentTarget.value;run(null,async()=>{selectedTask=id?(await backend.dotTask(id)).task:null;paintTasks();});});
    find('[data-dot-refresh]').addEventListener('click',event=>run(event.currentTarget,async()=>{invalidateTaskRead();await refreshTasks();if(selectedTask&&!taskClosed(selectedTask)){await checkSelectedTask();taskNotice('最新任務已核對。請檢查內容，再按「呼叫 Codex／DOT」。');}else taskNotice('已重新讀取任務；未確認已送出或已處理。');}));
    find('[data-dot-call]').addEventListener('click',event=>{
      if(busy)return;if(taskClosed(selectedTask)){paintTasks();taskNotice('任務已結束或資料已更新／過期，請準備新任務。');return;}if(!live){taskNotice('設計示例：正式版會交給目前智能 Agent。這裡沒有送出任務。');return;}
      if(!taskReadFresh()){run(event.currentTarget,async()=>{await checkSelectedTask();taskNotice('最新任務已核對。請檢查內容，再按一次「呼叫 Codex／DOT」開啟編輯器。');});return;}
      invalidateTaskRead();
      find('[data-dot-prompt-details]').open=true;const target=find('[data-dot-prompt]');let request;
      try{request=window.csAgentBridge?.invoke(selectedTask,target);}catch(error){taskNotice(error.message||'未能開啟，請使用「複製任務」。');return;}
      if(!request){taskNotice('未能直接呼叫，請按「複製任務」。');return;}
      if(request.kind==='annotation'){
        if(!request.accepted){taskNotice('瀏覽器未接受開啟要求。你可以使用「複製任務」。');return;}
        run(event.currentTarget,async()=>{await updateTask('opened');taskNotice('瀏覽器已接受交接要求。請在原生介面檢查並送出；目前未確認已送出或已處理。');});return;
      }
      run(event.currentTarget,async()=>{const accepted=await request.promise;if(accepted===false){taskNotice('請選取上方任務內容並複製，交給目前智能 Agent。');return;}await updateTask(request.kind==='host'?'host_submitted':'copied');taskNotice(request.kind==='host'?'任務已交給目前 AI 對話，等待回傳草稿。':'任務已複製。請貼到目前 Codex／DOT 對話，檢查後送出。');});
    });
    find('[data-dot-copy]').addEventListener('click',event=>{if(taskClosed(selectedTask)){paintTasks();taskNotice('任務已結束或資料已更新／過期，請準備新任務。');return;}if(!live){taskNotice('設計示例：可在本機版複製任務。');return;}find('[data-dot-prompt-details]').open=true;run(event.currentTarget,async()=>{const task=await checkSelectedTask();invalidateTaskRead();if(!await window.csAgentBridge?.copy(find('[data-dot-prompt]'),task)){taskNotice('最新任務已核對。請選取上方內容並複製，交給目前智能 Agent。');return;}await updateTask('copied');taskNotice('最新任務已核對並複製，尚未送出。請貼到目前智能 Agent 對話。');});});
    find('[data-dot-cancel]').addEventListener('click',event=>run(event.currentTarget,async()=>{await updateTask('cancel');taskNotice('本機任務已取消。已交給其他對話的內容仍需由你在該對話處理。');}));
    find('[data-dot-result-form]').elements.text.addEventListener('input',event=>{if(selectedTask)resultDrafts.set(selectedTask.id,event.target.value);});
    find('[data-dot-result-form]').addEventListener('submit',event=>{event.preventDefault();const text=event.currentTarget.elements.text.value.trim();run(event.submitter,async()=>{if(!text)throw new Error('請貼上處理結果。');const task=selectedTask;if(!task||taskClosed(task))throw new Error('這個任務目前不能保存新結果。');await updateTask('save_result',{taskId:task.id,verificationCode:task.verificationCode,text});resultDrafts.delete(task.id);taskNotice('回傳草稿已保存，仍需你核對；未採用為記憶，也未發送給客戶。');report('已保存待確認草稿。');});});
    window.addEventListener('bluesai-workbench-change',invalidateTaskRead);
    window.addEventListener('storage',event=>{if(event.key==='bluesai-workbench-change'){invalidateTaskRead();if(selectedTask)taskNotice('其他頁面有更新，呼叫前會重新核對任務。');}});
    window.addEventListener('blur',invalidateTaskRead);
    window.addEventListener('focus',invalidateTaskRead);
    document.addEventListener('visibilitychange',invalidateTaskRead);
    find('[data-model-form]').addEventListener('submit',event=>{event.preventDefault();const f=event.currentTarget;run(event.submitter,async()=>{const key=f.elements.apiKey.value;f.elements.apiKey.value='';find('[data-ai-result]').textContent='正在測試連線及模型回覆…';try{const result=await backend.model({model:f.elements.model.value,apiKey:key});find('[data-ai-result]').textContent=result.message;await refresh();report(result.message);}catch(e){find('[data-ai-result]').textContent=e.message;throw e;}});});
    find('[data-disconnect-ai]').addEventListener('click',event=>run(event.currentTarget,async()=>{await backend.clearAI();await refresh();find('[data-ai-result]').textContent='AI 接駁已清除。';report('已清除 AI 接駁，回到離線模式。');}));
    find('[data-whatsapp-form]').addEventListener('submit',event=>{event.preventDefault();const f=event.currentTarget;run(event.submitter,async()=>{const args=Object.fromEntries(new FormData(f));f.elements.apiKey.value='';if(!args.url?.trim()||!args.instance?.trim()){f.querySelector('details').open=true;throw new Error('接駁服務尚未準備好。請返回第一步，或請安裝人員填寫服務資料。');}find('[data-wa-result]').textContent='正在向服務取得二維碼…';find('[data-qr-box]').hidden=true;try{const result=await backend.whatsapp(args);const holder=find('[data-qr-image]');holder.replaceChildren();find('[data-qr-box]').hidden=!result.qr;if(result.qr){const img=document.createElement('img');img.src=result.qr;img.alt='WhatsApp 裝置連結二維碼';holder.append(img);}find('[data-wa-result]').textContent=result.message;await refresh();report(result.message);}catch(e){find('[data-wa-result]').textContent=e.message;await refresh();throw e;}});});
    find('[data-wa-test-recipients]').addEventListener('submit',event=>{event.preventDefault();const f=event.currentTarget;run(event.submitter,async()=>{if(!f.elements.consent.checked)throw new Error('請先確認這個號碼已同意參與測試。');const result=await backend.configureTestRecipient({number:f.elements.number.value.trim(),consent:true});await refresh();report(result.message||'只開放指定號碼作真正 WhatsApp 收發測試。');});});
    find('[data-wa-check]').addEventListener('click',event=>run(event.currentTarget,async()=>{try{const result=await backend.checkWhatsApp();find('[data-wa-result]').textContent=result.message;if(result.status==='open')find('[data-qr-box]').hidden=true;report(result.message);}catch(e){find('[data-wa-result]').textContent=e.message;find('[data-qr-box]').hidden=true;throw e;}finally{await refresh();}}));
    find('[data-wa-clear]').addEventListener('click',event=>run(event.currentTarget,async()=>{await backend.clearWhatsApp();find('[data-qr-box]').hidden=true;find('[data-qr-image]').replaceChildren();await refresh();report('已清除本機接駁資料。如要移除手機裝置，請在 WhatsApp 的「已連結裝置」處理。');}));
    for(const [selector,method] of [['[data-webhook-register]','registerWebhook'],['[data-webhook-check]','checkWebhook']])find(selector).addEventListener('click',event=>run(event.currentTarget,async()=>{try{const result=await backend[method]();find('[data-wa-result]').textContent=result.message;report(result.message);}finally{await refresh();}}));
    all('[data-start-guide]').forEach(button=>button.addEventListener('click',()=>{guideFlow=button.dataset.startGuide;guideStep=0;paintGuide();find('[data-guide-title]').focus();}));
    find('[data-guide-close]').addEventListener('click',closeGuide);
    find('[data-guide-back]').addEventListener('click',()=>{guideStep=Math.max(0,guideStep-1);paintGuide();find('[data-guide-title]').focus();});
    find('[data-guide-next]').addEventListener('click',()=>{if(guideStep===3){closeGuide();report('教學已閱讀。接駁狀態仍會按實際連線及收發結果顯示。');}else{guideStep++;paintGuide();find('[data-guide-title]').focus();}});
    find('[data-guide-refresh]').addEventListener('click',event=>run(event.currentTarget,async()=>{await refresh();report('已更新接駁狀態。');}));
    find('[data-copy-web-url]').addEventListener('click',event=>run(event.currentTarget,async()=>{const field=find('[data-web-chat-url]');if(!field.value)throw new Error('請先準備網頁客服。');try{await navigator.clipboard.writeText(field.value);report('聊天網址已複製。');}catch{field.focus();field.select();report('請複製已選取的聊天網址。');}}));
    all('[data-prepare-setup]').forEach(button=>button.addEventListener('click',event=>run(event.currentTarget,async()=>{
      if(!live){report('客服後台尚未接駁，現在不能準備安裝指引任務。',true);return;}
      const flow=button.dataset.prepareSetup;
      const instruction=flow==='whatsapp'?'請為 BlueSAI-客服的 WhatsApp 接駁整理可核對的安裝步驟草稿。列出如何核對目前客服執行器、現有主機和 Evolution 服務，說明所需安全設定及收件網址，讓我之後回到接駁教學取得二維碼並自行用手機掃碼。列明保留資料、金鑰安全入口、費用確認及測試號碼驗收步驟。這次只整理指引，不購買、部署、設定帳戶或向客戶發送。':'請為 BlueSAI-客服的網頁聊天整理可核對的安裝步驟草稿。說明如何沿用現有主機及同一客服核心，列出經用戶核准後啟用受限客人入口、取得 HTTPS 網址及加入網頁按鈕的步驟。列明會話隔離、草稿批准、客人收件及管理工作台讀回的驗收。這次只整理指引，不購買、部署或更改網站；本機網址不能當成公開入口。';
      await refreshTasks();
      let reusable=null;
      for(const candidate of dotTasks.filter(task=>task.instruction===instruction&&!task.contextStale&&!['result_saved','cancelled'].includes(task.status))){const detail=(await backend.dotTask(candidate.id)).task;if(!taskClosed(detail)){reusable=detail;break;}}
      if(reusable)selectedTask=reusable;
      else{
        if(setupTasks[flow]){try{if(taskClosed((await backend.dotTask(setupTasks[flow])).task))delete setupKeys[flow];}catch(error){if(error.status===404)delete setupKeys[flow];else throw error;}}
        setupKeys[flow]||=crypto.randomUUID();selectedTask=(await backend.createDotTask({instruction,idempotencyKey:setupKeys[flow]})).task;
        if(taskClosed(selectedTask)){setupKeys[flow]=crypto.randomUUID();selectedTask=(await backend.createDotTask({instruction,idempotencyKey:setupKeys[flow]})).task;}
      }
      setupTasks[flow]=selectedTask.id;
      guideFlow=null;paintGuide();await refreshTasks();find('[data-dot-prompt-details]').open=true;find('[data-dot-task-detail]').scrollIntoView({block:'start'});report('安裝指引任務已準備。請檢查內容，再按「呼叫 Codex／DOT」，由目前智能 Agent 整理步驟草稿。');
    })));
    find('[data-whatsapp-form]').noValidate=true;
    if(live){all('[data-secret]').forEach(x=>{x.disabled=false;x.placeholder='在本機安全輸入，毋須貼到聊天';});find('[data-model-submit]').textContent='測試並接駁 AI';find('[data-wa-submit]').textContent='取得二維碼';find('[data-key-help]').textContent='此頁輸入的金鑰暫存在客服服務記憶體；伺服器私人設定由安裝人員管理。';report('這是客服 Agent 自己的卡片，尚未安裝到測試工作室。');}else{find('[data-model-form]').noValidate=true;find('[data-whatsapp-form]').noValidate=true;}
    try{await refresh(true);setupAgentBridge();setupInboxTools();}catch(e){report(e.message,true);}

    if(globalThis.Tweak){const tweak=new Tweak({container:find('.bp-agent-card'),onChange:()=>{render();remember();}});tweak.addToggle(state,'showNumber',{label:'顯示 Agent 編號'});tweak.addSlider(state,'cardPadding',{label:'卡片留白',min:18,max:30,step:2,unit:'px'});}
  })();
  