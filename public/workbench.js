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
document.querySelectorAll('[data-lucide]').forEach(node=>{const paths=icons[names[node.dataset.lucide]];if(!paths)return;const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');for(const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(key,value);for(const d of paths){const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',d);svg.append(path);}if(node.dataset.lucide==='arrow-left')svg.style.transform='rotate(180deg)';node.append(svg);});
})();

  (async()=>{
    const root=document.getElementById('cs-card-design');
    const find=s=>root.querySelector(s), all=s=>[...root.querySelectorAll(s)];
    const live=Boolean(window.csBackend), state={screen:'list',tab:'basic',showNumber:true,cardPadding:24,replyMode:'industry',previewConnected:false};
    let snapshot={profile:{name:'',industry:'',service:'',instructions:'',tone:'friendly'},settings:{handoffContact:''},knowledge:[],training:[],connections:{ai:{status:'unconfigured',model:''},whatsapp:{status:'unconfigured'}}};
    let busy=false;
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
      find('[data-guide-receive-help]').textContent=runtime?(wa.webhook?.configured?'收件設定已備妥，請按上方按鍵核對。':'收件服務尚未準備好，請把這一步交給安裝 AI 處理。'):'這裡是隔離預覽。正式收件需要客服服務；準備好後在該服務繼續此教學。';
      find('[data-guide-test-status]').textContent=`手機連線：${wa.status==='open'?'已核對':'尚未核對'}；最近來訊：${wa.evidence?.lastIncomingAt?'已觀察到，請在對話核對測試內容':'尚未觀察到'}；發送開關：${wa.deliveryEnabled?'已開啟':'關閉'}。`;
      all('[data-runtime-console]').forEach(node=>{node.hidden=!runtime;});
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
    const resultDrafts=new Map(),demoTasks=[];
    const form=find('[data-config-form]'), value=(name)=>form.elements.namedItem(name).value;
    const hints={'':'先講答案，再講必要條件。每次只問一個重點。','零售與網店':'先了解客人想買甚麼。價錢、送貨及退換安排，只用已確認的資料。','餐飲':'先了解客人的用餐需要。菜式、價錢、致敏原及訂位安排，沒有資料就交給真人確認。','美容與預約':'先問所需服務。價錢、療程及可約時間，沒有確認就不要承諾。','專業服務':'先了解客人的目的。服務範圍、報價及完成時間，需要已確認的資料。','其他':'先講答案，再講必要條件。每次只問一個重點。'};
    const replyModes={concise:'先直接回答問題，再補充必要條件。盡量用一至三句說清楚，保留重要限制。',friendly:'語氣親切自然，用簡單易明的說話。保持專業，不用幼稚稱呼或過多表情符號。',professional:'語氣禮貌、簡潔、正式。清楚交代已確認的資訊，不作未經確認的承諾。',needs:'先了解客人的目的。資料不足時，每次只問一個必要問題，再提出合適的下一步。',steps:'需要操作時，按次序逐步說明。每一步只做一件事，用短句寫清楚。'};
    const selectedHint=()=>state.replyMode==='industry'?(hints[value('industry')]||hints['']):replyModes[state.replyMode];
    function paintSuggestion(){find('[data-reply-mode]').value=state.replyMode;find('[data-industry-hint]').textContent=selectedHint();}
    function paintConnection(){const ai=snapshot.connections.ai.status==='connected',wa=snapshot.connections.whatsapp.status==='open';const connected=live?(ai&&wa):state.previewConnected;find('[data-card-status]').dataset.connected=String(connected);find('[data-connection-label]').textContent=connected?'已連接':'未連接';find('[data-connection-detail]').textContent=live?`最近檢查：AI ${ai?'已連接':'未連接'} · WhatsApp ${wa?'已連接':'未連接'}`:connected?'設計示例：AI 模型及 WhatsApp 均已連接。':'AI 模型及 WhatsApp 尚未連接。';}
    const category=text=>/回覆方式|語氣|先問|每次|不要|先回答/.test(text)?'style':/營業|開門|幾點|時間|星期|hours/i.test(text)?'hours':/幾錢|價錢|價格|收費|price/i.test(text)?'price':/退款|退貨/i.test(text)?'refund':'general';
    const demo={
      async load(){return snapshot;},
      async saveProfile(p,s){snapshot.profile=p;snapshot.settings=s;},
      async train(text){const id=String(Date.now());snapshot.knowledge.unshift({id,title:'這次教的內容',content:text,category:category(text),approved:0});snapshot.training.push({role:'user',content:text},{role:'assistant',content:'已原文整理成待確認記憶。請檢查內容，再確認採用。'});},
      async memory(id,action,content,kind){const m=snapshot.knowledge.find(x=>x.id===id);if(action==='delete')snapshot.knowledge=snapshot.knowledge.filter(x=>x.id!==id);else if(action==='approve')m.approved=1;else{m.content=content;m.category=kind||m.category;m.approved=0;}},
      async model(){snapshot.connections.ai.status='preview';return{message:'設計示例：模型連線已驗證。這裡沒有真正連接。'};},
      async clearAI(){snapshot.connections.ai.status='unconfigured';},
      async whatsapp(){snapshot.connections.whatsapp.status='preview';return{preview:true,message:'二維碼位置示意。沒有連接 WhatsApp。'};},
      async checkWhatsApp(){return{status:'preview',message:'設計稿沒有實際連線，請在本機版測試。'};},
      async clearWhatsApp(){snapshot.connections.whatsapp.status='unconfigured';},
      async dotTasks(){return{tasks:demoTasks};},
      async dotTask(id){const task=demoTasks.find(x=>x.id===id);if(!task)throw new Error('找不到任務。');return{task};},
      async createDotTask({instruction,idempotencyKey}){let task=demoTasks.find(x=>x.idempotencyKey===idempotencyKey);if(!task){const id='preview-'+Date.now(),verificationCode='PREVIEW';const context={profile:snapshot.profile,facts:snapshot.knowledge.filter(x=>x.approved).map(x=>({...x,expiresAt:x.expires_at??null}))};task={id,instruction,idempotencyKey,status:'prepared',version:1,createdAt:Date.now(),updatedAt:Date.now(),revision:1,verificationCode,contextStale:false,snapshot:context,resultText:null,prompt:'【設計預覽任務】\n任務：'+id+'\n要求：'+instruction+'\n只整理草稿，不發送客戶訊息。\n已儲存的商戶資料：\n'+JSON.stringify(context,null,2)};demoTasks.unshift(task);}return{task};},
      async updateDotTask(id,input){const task=demoTasks.find(x=>x.id===id);if(!task)throw new Error('找不到任務。');if(task.version!==input.expectedVersion)throw new Error('任務已更新，請重新讀取。');task.status=input.action==='save_result'?'result_saved':input.action==='cancel'?'cancelled':input.action;if(input.result)task.resultText=input.result.text;task.version++;task.updatedAt=Date.now();return{task};}
    };
    const backend=window.csBackend||demo;
    function restore(saved){const v=saved?.privateContent||saved?.modelContent||saved;if(!v||v.prototype!=='customer-agent-card')return;if(['list','config'].includes(v.screen))state.screen=v.screen;if(['basic','training','connect'].includes(v.tab))state.tab=v.tab;if(v.tab==='trial')state.tab='basic';if(v.tab==='data')state.tab='training';if(typeof v.showNumber==='boolean')state.showNumber=v.showNumber;if(v.replyMode==='industry'||Object.hasOwn(replyModes,v.replyMode))state.replyMode=v.replyMode;if(typeof v.previewConnected==='boolean')state.previewConnected=v.previewConnected;}
    function render(){all('[data-screen]').forEach(x=>x.hidden=x.dataset.screen!==state.screen);all('[data-panel]').forEach(x=>x.hidden=x.dataset.panel!==state.tab);all('[data-tab]').forEach(x=>x.setAttribute('aria-selected',String(x.dataset.tab===state.tab)));find('[data-breadcrumb]').textContent=state.screen==='list'?'Agent 工作台':'Agent 工作台 / 客服 AI';find('[data-agent-code]').hidden=!state.showNumber;root.style.setProperty('--cs-card-padding',state.cardPadding+'px');paintSuggestion();paintConnection();}
    function remember(){const value={prototype:'customer-agent-card',screen:state.screen,tab:state.tab,showNumber:state.showNumber,replyMode:state.replyMode,previewConnected:state.previewConnected};if(window.openai?.setWidgetState)window.openai.setWidgetState({modelContent:value,privateContent:null}).catch(()=>{});}
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
    const statusNames={unconfigured:'未接駁',configured:'已填資料 · 未測試',connected:'連線已驗證',preview:'設計示例',open:'WhatsApp 已連接',close:'未連接手機',connecting:'等待掃碼',unknown:'狀態未確認',error:'連線未成功'};
    function paintData(fill=false){
      if(fill){for(const key of ['name','industry','service','instructions','tone'])form.elements.namedItem(key).value=snapshot.profile[key]|| (key==='tone'?'friendly':'');find('[data-model-form]').elements.model.value=snapshot.connections.ai.model||'';}
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
      find('[data-runtime-label]').textContent=live?`${runtime?'客服收發執行器':'隔離本機預覽'} · ${statusNames[ai.status]||'狀態未確認'}`:'設計預覽';
      find('[data-runtime-connection]').hidden=!runtime;
      if(runtime){
        const f=find('[data-whatsapp-form]');
        for(const key of ['url','instance']){f.elements[key].value=wa[key]||'';f.elements[key].readOnly=true;f.elements[key].required=false;}
        f.elements.apiKey.disabled=true;f.elements.apiKey.placeholder='已從伺服器私人設定載入；此頁不顯示';
        const when=timestamp=>timestamp?new Date(timestamp).toLocaleString('zh-HK'):'尚未觀察到';
        find('[data-channel-evidence]').textContent=`收件入口：${wa.receiveEnabled?'已設定':'未設定'}；供應商 webhook：${wa.webhook?.registered?'讀回相符':'未核對'}；WhatsApp 發送開關：${wa.deliveryEnabled?'已開啟':'關閉'}。最近來訊：${when(wa.evidence?.lastIncomingAt)}；最近回執：${when(wa.evidence?.lastReceiptAt)}。`;
        find('[data-channel-help]').textContent='本頁與客戶對話共用同一客服執行器及資料庫。金鑰、PUBLIC_BASE_URL、WEBHOOK_SECRET 及 DELIVERY_ENABLED 由伺服器私人環境設定；工作台不會暗中開啟發送。';
        find('.bp-preview-label').textContent='客服收發執行器';find('.bp-bottom-caption').textContent='設定、記憶與客戶對話由同一後台保存；收發依上方實際設定及觀察結果。';
      }
      if(live){find('[data-training-mode]').textContent=ai.status==='connected'?'AI 會參考最近的訓練對話整理記憶。你確認後才用來回答客戶。':'未接駁 AI：會將你教的內容原文存為待確認記憶。';}
      paintGuide();
    }
    async function refresh(fill=false){invalidateTaskRead();snapshot=await backend.load();paintData(fill);await refreshTasks();}
    async function run(button,fn){if(busy)return;busy=true;const original=button?.textContent;if(button){button.disabled=true;button.textContent='處理中…';}try{await fn();}catch(e){report(e.message||'操作未完成，請再試。',true);}finally{busy=false;if(button){button.disabled=false;button.textContent=original;}if(selectedTask)paintTasks();}}
    restore(window.openai?.widgetState);render();
    find('[data-open]').addEventListener('click',()=>{state.screen='config';render();remember();});
    find('[data-back]').addEventListener('click',()=>{state.screen='list';render();remember();});
    all('[data-tab]').forEach(button=>button.addEventListener('click',()=>{state.tab=button.dataset.tab;render();remember();}));
    form.addEventListener('submit',event=>{event.preventDefault();run(event.submitter,async()=>{const p=Object.fromEntries(['name','industry','service','instructions','tone'].map(k=>[k,value(k)]));await backend.saveProfile(p,{...snapshot.settings,handoffContact:snapshot.settings.handoffContact||'',mode:snapshot.settings.mode||'review'});await refresh();report(live?'基本設定已儲存在這部電腦。':'已示範儲存，沒有寫入工作室。');});});
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
    find('[data-whatsapp-form]').addEventListener('submit',event=>{event.preventDefault();const f=event.currentTarget;run(event.submitter,async()=>{const args=Object.fromEntries(new FormData(f));f.elements.apiKey.value='';if(!args.url?.trim()||!args.instance?.trim()){f.querySelector('details').open=true;throw new Error('接駁服務尚未準備好。請返回第一步，或請安裝人員填寫服務資料。');}find('[data-wa-result]').textContent='正在向服務取得二維碼…';find('[data-qr-box]').hidden=true;try{const result=await backend.whatsapp(args);const holder=find('[data-qr-image]');holder.replaceChildren();find('[data-qr-box]').hidden=!result.qr&&!result.preview;if(result.qr){const img=document.createElement('img');img.src=result.qr;img.alt='WhatsApp 裝置連結二維碼';holder.append(img);}else if(result.preview){holder.textContent='二維碼位置示意 · 不可掃描';}find('[data-wa-result]').textContent=result.message;await refresh();report(result.message);}catch(e){find('[data-wa-result]').textContent=e.message;await refresh();throw e;}});});
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
      if(!live){report('設計預覽：正式工作台會先準備安裝任務，再讓你交給目前智能 Agent。');return;}
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
    if(live){find('.bp-preview-label').textContent='本機實測 · 與測試工作室分開';find('.bp-bottom-caption').textContent='設定及訓練記憶只儲存在本機；WhatsApp 對客發送未開啟。';find('.bp-workspace strong').textContent='本機工作台';find('.bp-avatar').textContent='本';all('[data-secret]').forEach(x=>{x.disabled=false;x.placeholder='在本機輸入，重啟服務後需重新填寫';});find('[data-model-submit]').textContent='測試並接駁 AI';find('[data-wa-submit]').textContent='取得二維碼';find('[data-key-help]').textContent='金鑰只暫存在本機服務記憶體，不寫入磁碟；重啟服務後需重新填寫。';}else{find('[data-model-form]').noValidate=true;find('[data-whatsapp-form]').noValidate=true;}
    if(live){report('設定及訓練記憶會儲存在這部電腦。');find('[data-screen="list"] .bp-note').textContent='由卡片進入「配置客服」，設定回覆方式、訓練記憶及接駁渠道。';find('[data-screen="list"] .bp-page-title p').textContent='在同一個工作台設定、訓練及接駁你的客服。';find('[data-screen="list"] .bp-actions').hidden=true;}
    try{await refresh(true);setupAgentBridge();}catch(e){report(e.message,true);}
    window.addEventListener('openai:set_globals',event=>{if(event.detail?.globals?.widgetState){restore(event.detail.globals.widgetState);render();}});
    if(globalThis.Tweak){const tweak=new Tweak({container:find('.bp-agent-card'),onChange:()=>{render();remember();}});tweak.addToggle(state,'showNumber',{label:'顯示 Agent 編號'});tweak.addSlider(state,'cardPadding',{label:'卡片留白',min:18,max:30,step:2,unit:'px'});if(!live)tweak.addToggle(state,'previewConnected',{label:'預覽已連接綠燈'});}
  })();
  