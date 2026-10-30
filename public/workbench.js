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
    const live=Boolean(root.csBackend), state={screen:'list',tab:'basic',showNumber:true,cardPadding:24,replyMode:'industry',queueFilter:'customers',queueSearch:'',contextOpen:false,managementSection:'channels'};
    let snapshot={profile:{name:'',industry:'',service:'',instructions:'',tone:'friendly'},settings:{handoffContact:''},knowledge:[],training:[],connections:{ai:{status:'unconfigured',model:''},whatsapp:{status:'unconfigured'}}};
    let busy=false,customerPolling=false,selectedCustomerId=null,customerSignature='',currentCustomerData=null,customerSelectionMade=false,customerPickerSignature='',inboxSummary={policy:{enabled:false,automaticKnowledge:false,aiFallback:false,automaticAi:false},pendingHandoffs:[]};
    let inboxPolicyDirty=false,inboxScope=null,selfScopeDirty=false,queueSignature='',inboxLoaded=false,inboxHadReadError=false,customerRefreshPending=false,knowledgeRevision=null,knowledgeCheckedAt=null,inboxToolsReady=false;const notifiedHandoffs=new Set();let inboxEventStream=null;
    const replyDrafts=new Map(),customerDrafts=new Map(),selfReplyOperations=new Map();let selfReplyPolicy=null,selfReplyEpoch=0;
    let learningState=null,learningLoaded=false,learningPolling=false,learningSettingsDirty=false,learningEpoch=0;
    const learningDrafts=new Map(),learningProposalNodes=new Map();
    let dotTasks=[],selectedTask=null,renderedTaskId=null,taskDraftKey=null;
    let modelCustomDraft='',modelChoiceValue='';
    let taskReadLease=null,taskReadEpoch=0;
    let guideFlow=null,guideStep=0,setupTaskFlow=null,receiveSetupOpen=false;
    const whatsappLink={phase:'idle',message:'',active:false,epoch:0,timer:null,startedAt:0,qrUntil:0,args:{}};
    const setupKeys={},setupTasks={};
    const guideLabels={whatsapp:['準備服務','手機掃碼','設定收件','試收試覆'],web:['準備網頁客服','取得聊天網址','加入你的網頁','試問及核對']};
    // Management workspace navigation
    const managementSections=['channels','reply','ai','merchant','extras'];
    const managementLabels={channels:'渠道接駁',reply:'回覆方式',ai:'AI 與助手',merchant:'商戶資料',extras:'測試與提示'};
    function moveTaskPanelForContext(){
      const setup=Boolean(guideFlow&&setupTaskFlow===guideFlow&&state.managementSection==='channels');
      const panel=find('[data-dot-task-panel]'),anchor=find(setup?'[data-setup-task-anchor]':'[data-general-task-anchor]');
      if(panel.parentElement!==anchor)anchor.append(panel);
      find('[data-setup-task-anchor]').hidden=!setup;
      find('[data-dot-task-form]').hidden=setup;find('.bp-task-picker').hidden=setup;
      find('[data-dot-panel-title]').textContent=setup?(guideFlow==='whatsapp'?'WhatsApp 安裝指引':'網頁客服安裝指引'):'交給 Codex／DOT 處理';
      find('[data-dot-panel-intro]').textContent=setup?'這是可選的安裝步驟草稿。檢查任務後再交給目前 AI，不會自動安裝或連結手機。':'交給目前的 Codex／DOT 處理，結果先存草稿。';
    }
    function paintManagementView(){
      const current=managementSections.includes(state.managementSection)?state.managementSection:'channels';state.managementSection=current;
      all('[data-management-section]').forEach(node=>node.hidden=node.dataset.managementSection!==current);
      all('[data-management-tab]').forEach(node=>node.setAttribute('aria-pressed',String(node.dataset.managementTab===current)));
      find('[data-channels-overview]').hidden=Boolean(guideFlow);
      find('[data-management-location]').textContent=guideFlow&&current==='channels'?(setupTaskFlow===guideFlow?'安裝協助':guideFlow==='whatsapp'?'WhatsApp 接駁':'網頁客服'):managementLabels[current];
      moveTaskPanelForContext();
    }
    function openManagementSection(section,{keepGuide=false}={}){
      if(!managementSections.includes(section))return;
      if(!keepGuide&&guideFlow==='whatsapp')stopWhatsAppLink();
      if(!keepGuide){guideFlow=null;setupTaskFlow=null;receiveSetupOpen=false;}
      state.managementSection=section;state.screen='config';state.tab='connect';state.contextOpen=false;
      render();paintGuide();paintManagementView();find('[data-management-content]').scrollTop=0;
      const heading=find('[data-management-section="'+section+'"] .bp-management-heading h2');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}
      remember();
    }
    function openConnectionGuide(flow,step){
      if(!['whatsapp','web'].includes(flow))return;
      setupTaskFlow=null;receiveSetupOpen=false;guideFlow=flow;const wa=snapshot.connections.whatsapp||{};
      guideStep=flow==='whatsapp'?1:Number.isInteger(step)&&step>=0&&step<=3?step:0;
      state.managementSection='channels';state.screen='config';state.tab='connect';state.contextOpen=false;
      render();paintGuide();paintManagementView();find('[data-management-content]').scrollTop=0;find('[data-guide-title]').focus({preventScroll:true});remember();
    }
    function openWhatsAppReceiveSettings(){
      const wa=snapshot.connections.whatsapp||{};
      if(wa.receiveSetupAvailable!==true&&wa.inboxScope?.available!==true){openManagementSection('channels');report('此服務尚未提供收件設定，請先核對渠道能力。');return;}
      saveCurrentReply();stopWhatsAppLink();openConnectionGuide('whatsapp');receiveSetupOpen=true;paintGuide();find('[data-wa-receive-settings]').open=true;find('[data-management-content]').scrollTop=0;find('[data-guide-title]').focus({preventScroll:true});
    }
    // End management workspace navigation
    function paintGuide(){
      const active=Boolean(guideFlow)&&state.managementSection==='channels',setup=active&&setupTaskFlow===guideFlow;
      find('[data-guide-header]').hidden=!active;find('[data-guide-nav]').hidden=!active||setup||guideFlow==='whatsapp';find('[data-guide-steps]').hidden=!active||guideFlow==='whatsapp';find('[data-guide-progress]').hidden=guideFlow==='whatsapp';
      paintManagementView();
      const autoReceive=snapshot.connections.whatsapp?.autoReceiveOnConnect===true;
      all('[data-guide-flow]').forEach(node=>{const step=Number(node.dataset.guideStep);node.hidden=!active||setup||node.dataset.guideFlow!==guideFlow||(guideFlow==='whatsapp'?(autoReceive?step!==1:receiveSetupOpen?step!==2:step!==1&&!(step>=2&&whatsappLink.phase==='connected'&&(snapshot.connections.whatsapp?.receiveSetupAvailable===true||snapshot.connections.whatsapp?.inboxScope?.available===true))):step!==guideStep);});
      all('[data-start-guide]').forEach(node=>node.setAttribute('aria-expanded',String(node.dataset.startGuide===guideFlow)));
      if(!active)return;
      find('[data-guide-title]').textContent=setup?(guideFlow==='whatsapp'?'WhatsApp 安裝指引':'網頁客服安裝指引'):guideFlow==='whatsapp'?(receiveSetupOpen?'WhatsApp 收件與人工回覆':'接駁 WhatsApp'):'接駁網頁';
      all('[data-guide-jump]').forEach(node=>{const step=Number(node.dataset.guideJump);if(step===guideStep)node.setAttribute('aria-current','step');else node.removeAttribute('aria-current');find('[data-guide-step-label="'+step+'"]').textContent=guideLabels[guideFlow][step];});
      find('[data-guide-progress]').textContent=`第 ${guideStep+1} / 4 步 · ${guideLabels[guideFlow][guideStep]}`;
      find('[data-guide-back]').disabled=guideStep===0;find('[data-guide-next]').textContent=guideStep===3?'完成教學':'下一步';
      const c=snapshot.connections,wa=c.whatsapp,runtime=c.mode==='runtime',receiveAvailable=wa.receiveSetupAvailable===true||wa.inboxScope?.available===true;
      find('[data-guide-wa-ready]').textContent=wa.url&&wa.instance?'已保留現有接駁服務。重試會沿用此服務及手機授權。':'受支援的本機測試台會自動準備接駁；其他環境可由安裝人員提供服務資料。';
      find('[data-guide-receive-help]').textContent=!receiveAvailable?'此服務尚未提供即時收件設定。手機已連結也不代表已接收訊息。'
        :wa.webhook?.registered?(wa.status!=='open'?'收件網址已核對相符；請先確認手機顯示已連接，再確認新私人文字收件範圍。':wa.inboxScope?.mode==='all_private_text'?'收件網址已核對相符，已開啟全部新私人文字收件；發送按獨立授權檢查。':wa.localTest?'收件網址已核對相符。請在下方明確確認接收所有新私人文字，並獨立選擇是否允許回覆。':'收件網址已核對相符。發送仍需完成已授權的渠道及發送設定。')
        :'請先準備收件入口，再確認收件範圍。';
      find('[data-guide-test-status]').textContent=`手機連線：${wa.status==='open'?'已核對':'尚未核對'}；最近來訊：${wa.evidence?.lastIncomingAt?'已觀察到，請在對話核對測試內容':'尚未觀察到'}；發送開關：${wa.deliveryEnabled?'已開啟':'關閉'}。`;
      all('[data-open-customer-panel]').forEach(node=>{node.hidden=false;});
      const webReady=runtime&&c.webChat?.enabled===true;
      find('[data-guide-web-ready]').textContent=webReady?'網頁客服已開啟。下一步可以打開聊天頁測試。':'網頁客服尚未開啟。請先讓安裝 AI 準備服務，再回來測試。';
      const base=c.publicBaseUrl||location.origin,url=webReady?base+'/chat':'';
      find('[data-web-chat-url]').value=url;find('[data-copy-web-url]').disabled=!webReady;
      const link=find('[data-open-web-chat]');link.hidden=!webReady;link.href=url||'/chat';
      const local=webReady&&['localhost','127.0.0.1','[::1]'].includes(new URL(base).hostname);
      find('[data-web-url-help]').textContent=!webReady?'服務開啟後才會顯示可用網址。':local?'這是本機試用網址，只能在同一部電腦使用。對外分享前，請安裝人員準備公開 HTTPS 網址。':'請先完成最後一步的收發測試，再分享這個網址。';
      find('[data-web-link-code]').value=webReady&&!local?`<a href="${url}">聯絡客服</a>`:'取得公開聊天網址後，這裡會顯示可交給網站維護人員的連結碼。';
    }
    function closeGuide(){const flow=guideFlow;if(flow==='whatsapp')stopWhatsAppLink();guideFlow=null;setupTaskFlow=null;receiveSetupOpen=false;paintGuide();find('[data-management-content]').scrollTop=0;if(flow)find(`[data-start-guide="${flow}"]`).focus({preventScroll:true});}
    const resultDrafts=new Map();
    const form=find('[data-config-form]'), value=(name)=>form.elements.namedItem(name).value;
    const hints={'':'先講答案，再講必要條件。每次只問一個重點。','零售與網店':'先了解客人想買甚麼。價錢、送貨及退換安排，只用已確認的資料。','餐飲':'先了解客人的用餐需要。菜式、價錢、致敏原及訂位安排，沒有資料就交給真人確認。','美容與預約':'先問所需服務。價錢、療程及可約時間，沒有確認就不要承諾。','專業服務':'先了解客人的目的。服務範圍、報價及完成時間，需要已確認的資料。','其他':'先講答案，再講必要條件。每次只問一個重點。'};
    const replyModes={concise:'先直接回答問題，再補充必要條件。盡量用一至三句說清楚，保留重要限制。',friendly:'語氣親切自然，用簡單易明的說話。保持專業，不用幼稚稱呼或過多表情符號。',professional:'語氣禮貌、簡潔、正式。清楚交代已確認的資訊，不作未經確認的承諾。',needs:'先了解客人的目的。資料不足時，每次只問一個必要問題，再提出合適的下一步。',steps:'需要操作時，按次序逐步說明。每一步只做一件事，用短句寫清楚。'};
    const selectedHint=()=>state.replyMode==='industry'?(hints[value('industry')]||hints['']):replyModes[state.replyMode];
    function paintSuggestion(){find('[data-reply-mode]').value=state.replyMode;find('[data-industry-hint]').textContent=selectedHint();}
    function policyMode(policy=inboxSummary.policy||{}){return !policy.enabled?(snapshot.connections.ai.provider==='openai'&&snapshot.connections.ai.status==='connected'?'模型 API · 原有模式':'人工處理'):policy.aiFallback?(policy.automaticAi?'AI 有據自動答':'AI 草稿'):policy.automaticKnowledge?'FAQ 自動答':'FAQ 草稿';}
    function policyDescription(policy=inboxSummary.policy||{}){if(!policy.enabled)return snapshot.connections.ai.provider==='openai'&&snapshot.connections.ai.status==='connected'?'知識庫優先尚未啟用；目前保留原有模型 API 處理，按商戶基本設定的回覆模式運行。要改用 FAQ 優先，請明確勾選並儲存。':'知識庫優先尚未啟用。人工回覆及本人交給 DOT 草擬毋須另接模型。';const faq=policy.automaticKnowledge?'FAQ 完全吻合時按授權自動發送':'FAQ 答案先存草稿';if(!policy.aiFallback)return 'FAQ-only：'+faq+'；未命中便交你／DOT 處理。';const ai=snapshot.connections.ai||{},next=policy.automaticAi?'有已確認來源的 AI 答案才可按授權自動發送，其餘保留草稿／交接':'背景 AI 產生草稿，核對後才發送';return faq+'；未命中時'+next+'。'+(ai.status==='connected'?'':'請先檢查並接駁背景 AI，目前不能產生 AI 答案。');}
    // Model provider and choice controls retain the actual form inputs and drafts.
    const modelProviderLabels={openai:'OpenAI',anthropic:'Anthropic',gemini:'Google Gemini',other:'其他供應商'};
    const modelReferences=['gpt-6-luna','gpt-6.1-sol'];
    function paintModelProvider(){
      const f=find('[data-model-form]'),supported=f.elements.provider.value==='openai',choice=find('[data-model-choice]');
      find('[data-model-openai-fields]').hidden=!supported;find('[data-model-unsupported]').hidden=supported;
      find('[data-model-provider-help]').textContent=supported?'目前可接駁 OpenAI。':'尚未支援 '+(modelProviderLabels[f.elements.provider.value]||'此供應商')+' 接駁；原有 OpenAI 輸入已保留。';
      find('[data-model-custom]').hidden=!supported||choice.value!=='custom';f.elements.model.required=supported&&choice.value==='custom';choice.required=supported;
      find('[data-model-submit]').disabled=!supported||busy;find('[data-ai-guide]').disabled=busy;
    }
    function syncModelChoiceFromValue(){
      const current=find('[data-model-form]').elements.model.value;
      modelChoiceValue=modelReferences.includes(current)?current:current?'custom':'';find('[data-model-choice]').value=modelChoiceValue;
      if(modelChoiceValue==='custom')modelCustomDraft=current;paintModelProvider();
    }
    function changeModelChoice(){
      const f=find('[data-model-form]'),choice=find('[data-model-choice]').value;
      if(modelChoiceValue==='custom')modelCustomDraft=f.elements.model.value;
      f.elements.model.value=choice==='custom'?modelCustomDraft:modelReferences.includes(choice)?choice:'';modelChoiceValue=choice;paintModelProvider();
    }
    const nativeProviderLabels={codex:'Codex',grok:'Grok',claude:'Claude'};
    function writeAiGuideDraft(provider,statusSelector,native=false){
      const task=find('[data-dot-task-form]').elements.instruction;
      if(task.value.trim()){find(statusSelector).textContent='已有未儲存任務，已為你保留。請先完成或清空該任務，再整理接駁指引。';return;}
      task.value='請為 BlueSAI-客服整理 '+provider+(native?' 本機登入':'')+' 的接駁指引草稿，讓我核對後決定下一步。先核對本產品是否支援此路線；未支援時只列出功能缺項及可行做法，不聲稱已安裝、已登入或已接駁。'+(native?'只研究官方本機登入及受限程式介面，列明隔離限制；不要改用 API key 當作本機登入。':'說明模型選擇、本人安全填寫金鑰的入口、費用及確認步驟。')+'這次只整理指引，不建立金鑰、不讀取或傳送憑證、不安裝、不登入、不配置、不呼叫外部模型或向客戶發送。';
      find(statusSelector).textContent='已放入下方可編輯任務草稿。確認後按「準備任務」，再交給 Codex／DOT；尚未呼叫 AI 或接駁。';task.focus({preventScroll:true});
    }
    function prepareModelGuideDraft(){const f=find('[data-model-form]');writeAiGuideDraft(modelProviderLabels[f.elements.provider.value]||'所選供應商','[data-ai-guide-status]');}
    function prepareNativeGuideDraft(){const f=find('[data-native-codex-form]');writeAiGuideDraft(nativeProviderLabels[f.elements.provider.value]||'所選助手','[data-native-guide-status]',true);}
    function changeNativeProvider(){find('[data-native-codex-form]').elements.consent.checked=false;find('[data-native-result]').textContent='選擇助手不會登入或切換目前接駁；接駁須重新確認同意。';paintBackgroundAI();}
    // End model provider and choice controls
    function paintBackgroundAI(){
      const ai=snapshot.connections.ai||{},native=ai.provider==='codex-cli',f=find('[data-native-codex-form]'),selected=f.elements.provider.value,selectedCodex=selected==='codex',available=selectedCodex&&live&&ai.nativeAvailable===true;
      find('[data-native-status]').textContent=native?'Codex · '+(ai.requiresCheck||ai.status==='configured'?'待重新檢查':statusNames[ai.status]||'待核對'):'尚未接駁本機助手';
      find('[data-native-availability]').textContent=!selectedCodex?'此版本尚未提供 '+(nativeProviderLabels[selected]||'此助手')+' 本機接駁；未檢查安裝或登入。':!live?'後台尚未接駁。':!available?'此環境尚未提供 Codex 執行器；未檢查安裝或登入。':native&&ai.status==='connected'&&!ai.requiresCheck?'Codex 已通過本機登入及推理檢查。':native&&(ai.requiresCheck||ai.status==='configured')?'已保留 Codex 選擇；請重新同意並檢查。':'可檢查 Codex；登入狀態尚未核對。';
      find('[data-native-consent-label]').textContent=selectedCodex?'我同意使用本機 Codex 的 ChatGPT 帳戶額度處理客服內容。':'此助手的本機接駁尚未提供，未有可確認的使用授權。';
      f.elements.consent.disabled=!available||busy;find('[data-native-submit]').disabled=!available||busy;find('[data-native-provider]').disabled=busy;find('[data-native-guide]').disabled=busy;find('[data-native-disconnect]').hidden=!native;find('[data-native-disconnect]').disabled=busy;
      find('[data-ai-status]').textContent=native?'目前使用本機 Codex':ai.provider==='openai'?'OpenAI · '+(statusNames[ai.status]||'待核對'):'尚未接駁';find('[data-disconnect-ai]').disabled=native||busy;paintModelProvider();
      const usable=snapshot.knowledge.filter(k=>k.approved&&(!k.expires_at||k.expires_at>Date.now())).length;find('[data-inbox-policy-knowledge]').textContent=usable?'最近讀回 '+usable+' 條已確認且未過期知識；是否足以回答仍逐題核對。':'目前沒有已確認且未過期的知識。請先在「知識庫」加入並確認真實商戶資料；接駁模型不會補造答案。';find('[data-inbox-policy-mode]').textContent=inboxLoaded?policyMode():'尚未讀回';find('[data-inbox-policy-status]').textContent=inboxLoaded?'已儲存：'+policyDescription():'回覆規則尚未讀回，暫不能儲存。';
    }
    function clearAiPolicyChoices(){const f=find('[data-inbox-policy]');f.elements.aiFallback.checked=false;f.elements.automaticAi.checked=false;}
    function phoneConnectionState(wa){
      const verified=live&&wa.status==='open'&&Number.isFinite(wa.checkedAt)&&wa.checkedAt>0&&wa.requiresCheck!==true;
      const tone=verified?'open':live&&['close','closed','error','unconfigured','disconnected'].includes(wa.status)?'closed':'unknown';
      const number=verified&&typeof wa.linkedPhone==='string'&&/^\d{8,15}$/.test(wa.linkedPhone)?'+'+wa.linkedPhone:'';
      return {tone,label:tone==='open'?'已接駁':tone==='closed'?'未接駁':'待核對',number};
    }
    function paintPhoneConnection(wa){
      const phone=phoneConnectionState(wa),checked=Number.isFinite(wa.checkedAt)&&wa.checkedAt>0?new Date(wa.checkedAt).toLocaleString('zh-HK'):'';
      find('[data-shell-wa-status]').dataset.phoneState=phone.tone;find('[data-shell-wa-label]').textContent='WhatsApp · '+phone.label;
      find('[data-shell-wa-status]').title=checked?'上次核對：'+checked:'尚未核對手機連線';
      find('[data-manage-phone]').dataset.phoneState=phone.tone;find('[data-manage-phone-label]').textContent=phone.label;
      find('[data-card-status]').dataset.phoneState=phone.tone;find('[data-card-status]').dataset.connected=String(phone.tone==='open');find('[data-connection-label]').textContent='WhatsApp · '+phone.label;
      return phone;
    }
    function paintConnection(){paintPhoneConnection(snapshot.connections.whatsapp||{});find('[data-connection-detail]').textContent=!live?'介面預覽，沒有建立 WhatsApp 連線。':!inboxLoaded?'回覆規則尚未讀回核對。':policyMode()+'；'+(inboxSummary.policy?.aiFallback?(snapshot.connections.ai.status==='connected'?'FAQ 優先，例外交由你核對。':'背景 AI 待接駁，例外由你／DOT 處理。'):'知識庫未能回答時，由你／DOT 處理。');}
    const category=text=>/回覆方式|語氣|先問|每次|不要|先回答/.test(text)?'style':/營業|開門|幾點|時間|星期|hours/i.test(text)?'hours':/幾錢|價錢|價格|收費|price/i.test(text)?'price':/退款|退貨/i.test(text)?'refund':'general';
    const unavailable=async()=>{throw new Error('這張卡片尚未接駁客服後台。請先由安裝人員準備服務及卡片接口，再使用此功能。');};
    const backend=root.csBackend||{load:async()=>snapshot,dotTasks:async()=>({tasks:[]}),conversations:async()=>({conversations:[]}),inbox:async()=>({conversations:[],policy:{enabled:false,automaticKnowledge:false,aiFallback:false,automaticAi:false},pendingHandoffs:[]}),faqRules:async()=>({rules:[]}),knowledgeLearning:unavailable,configureKnowledgeLearning:unavailable,collectLearningCases:unavailable,analyzeLearningCase:unavailable,approveLearningProposal:unavailable,rejectLearningProposal:unavailable,configureInbox:unavailable,addFaq:unavailable,inboxContext:unavailable,saveInboxDraft:unavailable,getWhatsAppInboxScope:unavailable,configureWhatsAppInboxScope:unavailable,getSelfTestReply:unavailable,configureSelfTestReply:unavailable,manualSelfTestReply:unavailable,saveProfile:unavailable,train:unavailable,memory:unavailable,reply:unavailable,model:unavailable,nativeCodex:unavailable,clearAI:unavailable,whatsapp:unavailable,checkWhatsApp:unavailable,clearWhatsApp:unavailable,dotTask:unavailable,createDotTask:unavailable,updateDotTask:unavailable};
    const learningKinds={fact:'商戶事實',procedure:'處理流程',style:'回覆方式'};
    const learningStates={pending:'待整理',queued:'等待 AI 整理',running:'AI 正在整理',analyzing:'AI 正在整理',analyzed:'已分析',ready:'已有整理建議',complete:'已整理',completed:'已整理',proposed:'已有整理建議',failed:'整理未完成',error:'整理未完成',stale:'來源已更新',skipped:'暫無可整理內容'};
    function learningNotice(text,error=false){const el=find('[data-learning-notice]');el.textContent=text;el.dataset.error=String(error);}
    function learningModelReady(){return live&&learningState?.model?.ready===true;}
    function paintSemanticStatus(){
      const ai=snapshot.connections.ai||{},ready=ai.status==='connected'&&!ai.requiresCheck,policy=inboxSummary.policy||{};
      find('[data-semantic-status]').textContent=!ready?'不同問法：背景 AI 尚未驗證，目前只會直接比對完整 FAQ；人工回覆及資料保存仍可用。':!policy.enabled||!policy.aiFallback?'不同問法：模型已接駁，請在管理啟用知識庫優先及 AI 後備，才會理解未完全吻合的問題。':'不同問法：AI 會按已確認知識理解意圖；資料不足先準備提問草稿，沒有依據便交人工。';
    }
    function learningDraft(form){return {title:form.elements.title.value,content:form.elements.content.value,category:form.elements.category.value,confirmed:form.elements.confirmed.checked,reviewed:form.elements.reviewed.checked};}
    function currentLearningProposal(id){return (learningState?.proposals||[]).find(p=>p.id===id);}
    function learningProposalVisible(item){return (find('[data-learning-filter]').value==='all'||find('[data-learning-filter]').value===item.kind)&&(find('[data-learning-status-filter]').value==='all'||find('[data-learning-status-filter]').value===item.status);}
    function learningLine(tag,text,className='bp-small'){const el=document.createElement(tag);el.className=className;el.textContent=text;return el;}
    function createLearningProposal(proposal){
      const box=document.createElement('article');box.className='bp-memory bp-learning-proposal';box.dataset.proposalId=proposal.id;
      const heading=document.createElement('div');heading.className='bp-data-head';const badge=learningLine('span','','bp-badge');badge.dataset.proposalBadge='';const source=learningLine('span','','bp-small bp-muted');source.dataset.proposalSource='';heading.append(badge,source);
      const rationale=learningLine('p','');rationale.dataset.proposalRationale='';const evidence=document.createElement('details');evidence.className='bp-learning-evidence';const summary=learningLine('summary','查看整理依據');evidence.append(summary);const evidenceCopy=document.createElement('div');evidenceCopy.dataset.proposalEvidence='';evidence.append(evidenceCopy);
      const review=learningLine('p','');review.dataset.proposalReview='';const warning=learningLine('p','','bp-small bp-inline-error');warning.dataset.proposalWarning='';
      const editor=document.createElement('form');editor.dataset.proposalForm='';
      function field(labelText,node){const label=document.createElement('label');label.className='bp-field';label.append(document.createTextNode(labelText),node);editor.append(label);return node;}
      const title=document.createElement('input');title.name='title';title.required=true;title.maxLength=100;field('記憶標題',title);
      const content=document.createElement('textarea');content.name='content';content.required=true;content.maxLength=2000;content.rows=5;field('可共用的內容／處理流程',content);
      const categorySelect=document.createElement('select');categorySelect.name='category';for(const [key,label]of Object.entries({general:'一般商戶資料',hours:'營業時間',price:'價格',refund:'退換安排',procedure:'處理流程',style:'回覆方式'})){const option=document.createElement('option');option.value=key;option.textContent=label;categorySelect.append(option);}field('記憶類別',categorySelect);
      const confirmedLabel=document.createElement('label');confirmedLabel.className='bp-consent';const confirmed=document.createElement('input');confirmed.type='checkbox';confirmed.name='confirmed';confirmedLabel.append(confirmed,document.createTextNode('我已核對內容及適用範圍，允許客服採用。'));editor.append(confirmedLabel);
      const reviewedLabel=document.createElement('label');reviewedLabel.className='bp-consent bp-gap';reviewedLabel.dataset.proposalReviewed='';const reviewed=document.createElement('input');reviewed.type='checkbox';reviewed.name='reviewed';reviewedLabel.append(reviewed,document.createTextNode('我已核對待補問題及衝突，並已修正不確定內容。'));editor.append(reviewedLabel);
      const actions=document.createElement('div');actions.className='bp-actions';const approve=learningLine('button','確認並採用','bp-button bp-primary');approve.type='submit';approve.dataset.proposalApprove='';const reject=learningLine('button','不採用','bp-button');reject.type='button';reject.dataset.proposalReject='';actions.append(approve,reject);editor.append(actions);
      editor.addEventListener('input',event=>{if(['title','content','category'].includes(event.target.name)){confirmed.checked=false;reviewed.checked=false;}learningDrafts.set(proposal.id,learningDraft(editor));updateLearningProposal(proposal.id);});
      editor.addEventListener('change',()=>{learningDrafts.set(proposal.id,learningDraft(editor));updateLearningProposal(proposal.id);});
      editor.addEventListener('submit',event=>{event.preventDefault();run(event.submitter,async()=>{
        const item=currentLearningProposal(proposal.id),draft=learningDraft(editor);if(!item||item.status!=='pending'||item.sourceStale)throw new Error('建議或來源已更新，請重新整理後核對。');
        if(!draft.title.trim()||!draft.content.trim()||!draft.confirmed)throw new Error('請填齊標題及內容，並確認已核對適用範圍。');
        if(((item.questions||[]).length||(item.conflicts||[]).length)&&!draft.reviewed)throw new Error('請先核對待補問題及衝突，再勾選確認。');
        const input={title:draft.title.trim(),content:draft.content.trim(),category:item.kind==='procedure'?'procedure':item.kind==='style'?'style':draft.category,confirmed:true,reviewed:draft.reviewed};
        await backend.approveLearningProposal(proposal.id,input);
        if(JSON.stringify(learningDraft(editor))===JSON.stringify(draft))learningDrafts.delete(proposal.id);
        const editingMemory=Boolean(find('[data-memories] textarea'));
        if(editingMemory){const latest=await backend.load();snapshot.knowledge=latest.knowledge;await refreshLearning();}
        else await refresh();
        learningNotice('記憶已正式採用。'+(editingMemory?'原有記憶編輯保持，完成後再更新清單。':'以後回覆仍按來源、流程及當前人工狀態檢查。'));report('新記憶已確認採用，未向客戶發送訊息。');
      });});
      reject.addEventListener('click',()=>run(reject,async()=>{await backend.rejectLearningProposal(proposal.id);await refreshLearning();learningNotice('這項建議已列為不採用，原有知識及對話保留。');}));
      box.append(heading,rationale,evidence,review,warning,editor);return box;
    }
    function updateLearningProposal(id){
      const box=learningProposalNodes.get(id);if(!box)return;const item=currentLearningProposal(id),editor=box.querySelector('form');
      if(!item){box.querySelector('[data-proposal-warning]').textContent='建議未在本次清單內，未送出的修改保留；請更新紀錄再核對。';editor.querySelectorAll('button').forEach(b=>b.disabled=true);return;}
      const kind=learningKinds[item.kind]||'待核對類型',pending=item.status==='pending';box.hidden=!learningProposalVisible(item);
      box.querySelector('[data-proposal-badge]').textContent=kind+' · '+({pending:'待你確認',approved:'已採用',rejected:'不採用'}[item.status]||'狀態待核對');
      box.querySelector('[data-proposal-source]').textContent='依據 '+(Array.isArray(item.evidenceMessageIds)?item.evidenceMessageIds.length:0)+' 則人工回覆';
      box.querySelector('[data-proposal-rationale]').textContent=item.rationale||'請核對這項建議的內容及適用條件。';
      const evidence=box.querySelector('[data-proposal-evidence]');const evidenceSignature=JSON.stringify(item.evidence||[]);if(evidence.dataset.signature!==evidenceSignature){evidence.replaceChildren();for(const entry of (item.evidence||[]).slice(0,8)){evidence.append(learningLine('p',(entry.role==='staff'?'人工回覆：':'對話背景：')+String(entry.content||'').slice(0,500)));}if(!evidence.childElementCount)evidence.append(learningLine('p','依據為已送出的人工對話；不把個案識別資料列作共用知識。'));evidence.dataset.signature=evidenceSignature;}
      const needsReview=Boolean((item.questions||[]).length||(item.conflicts||[]).length),reviewText=[...(item.questions||[]).map(q=>'待補：'+q),...(item.conflicts||[]).map(c=>'待核對衝突：'+(c.title||'已有知識'))].join('\n');box.querySelector('[data-proposal-review]').textContent=reviewText;
      const signature=JSON.stringify([item.sourceStale,item.questions,item.conflicts,item.status]);if(box.dataset.reviewSignature&&box.dataset.reviewSignature!==signature){editor.elements.confirmed.checked=false;editor.elements.reviewed.checked=false;const draft=learningDrafts.get(id);if(draft){draft.confirmed=false;draft.reviewed=false;}}box.dataset.reviewSignature=signature;
      const draft=learningDrafts.get(id);if(!draft){editor.elements.title.value=item.title||'';editor.elements.content.value=item.content||'';editor.elements.category.value=item.kind==='procedure'?'procedure':item.kind==='style'?'style':item.category||'general';}
      editor.elements.title.disabled=!pending;editor.elements.content.disabled=!pending;editor.elements.category.disabled=!pending||item.kind!=='fact';for(const option of editor.elements.category.options)option.disabled=item.kind==='fact'&&['procedure','style'].includes(option.value);
      editor.elements.confirmed.disabled=!pending||item.sourceStale===true;editor.elements.reviewed.disabled=!pending||item.sourceStale===true;box.querySelector('[data-proposal-reviewed]').hidden=!needsReview;
      box.querySelector('[data-proposal-warning]').textContent=item.sourceStale?'來源已更新或撤銷，不能採用；請從對話紀錄重新分析。':item.kind==='procedure'?'這是處理次序，不能證明價格、到貨日期或查單結果。':'';
      box.querySelector('[data-proposal-approve]').disabled=busy||!pending||item.sourceStale===true||!editor.elements.confirmed.checked||(needsReview&&!editor.elements.reviewed.checked);box.querySelector('[data-proposal-reject]').disabled=busy||!pending;
    }
    function paintLearning(){
      paintSemanticStatus();const ready=learningModelReady(),settings=find('[data-learning-settings]');find('[data-learning-model]').textContent=ready?'AI 整理可用':'模型待接駁';
      if(learningLoaded&&!learningSettingsDirty)settings.elements.automaticAnalysis.checked=learningState.settings?.automaticAnalysis===true;
      settings.elements.automaticAnalysis.disabled=!learningLoaded||(!ready&&learningState?.settings?.automaticAnalysis!==true);settings.querySelector('button').disabled=busy||!learningLoaded||(settings.elements.automaticAnalysis.checked&&!ready);
      find('[data-learning-settings-status]').textContent=!learningLoaded?'尚未讀回整理設定。':learningSettingsDirty?'你更改的整理方式尚未儲存。':'已儲存：'+(learningState.settings?.automaticAnalysis?'自動提出待確認建議。':'只收集紀錄，選擇後才交 AI 整理。');
      find('[data-learning-collect]').disabled=busy||!live;find('[data-learning-refresh]').disabled=busy||!live;
      const cases=Array.isArray(learningState?.cases)?learningState.cases:[],proposals=Array.isArray(learningState?.proposals)?learningState.proposals:[];
      find('[data-learning-summary]').textContent=learningLoaded?cases.length+' 筆人工整理紀錄；'+proposals.filter(p=>p.status==='pending').length+' 項建議待確認。'+(ready?'':'人工對話已保存在客服後台；AI 整理需先接駁模型。'):'整理紀錄尚未讀回。';
      const limits=learningState?.limits,limitNotice=find('[data-learning-limits]'),limitDetails=[];
      if(Number.isInteger(limits?.visibleCases)&&limits.visibleCases>0)limitDetails.push('學習紀錄清單最多顯示最近 '+limits.visibleCases+' 筆。');
      if(Number.isInteger(limits?.visibleProposals)&&limits.visibleProposals>0)limitDetails.push('整理建議清單最多顯示最近 '+limits.visibleProposals+' 項。');
      if(limits?.caseLimitReached===true&&Number.isInteger(limits.caseLimit)&&limits.caseLimit>0)limitDetails.unshift('學習紀錄已達 '+limits.caseLimit+' 筆上限，新增人工對話仍保留原對話，暫不新增學習紀錄。');
      limitNotice.hidden=!limitDetails.length;limitNotice.textContent=limitDetails.join(' ');
      const list=find('[data-learning-cases]'),caseSignature=JSON.stringify([ready,busy,cases]);if(list.dataset.signature!==caseSignature){list.replaceChildren();for(const item of cases){const row=document.createElement('article');row.className='bp-memory';const date=Number(item.createdAt||0);row.append(learningLine('p','人工對話 · '+(date?new Date(date).toLocaleString('zh-HK'):'時間待核對')+' · '+(learningStates[item.status]||'狀態待核對')),learningLine('p','引用 '+(Number.isInteger(item.sourceCount)?item.sourceCount:0)+' 則對話訊息','bp-small bp-muted'));if(item.lastError)row.append(learningLine('p','上次整理未完成；請核對模型後重新分析。','bp-small bp-inline-error'));const button=learningLine('button',item.status==='failed'||item.status==='error'||item.status==='stale'?'重新分析':item.status==='analyzed'?'已分析':'交 AI 整理','bp-button');button.type='button';button.disabled=busy||!ready||['running','analyzing','queued','analyzed'].includes(item.status);button.addEventListener('click',()=>run(button,async()=>{await backend.analyzeLearningCase(item.id);await refreshLearning();learningNotice('整理工作已提交。請留意稍後出現的待確認建議，尚未正式採用。');}));row.append(button);list.append(row);}if(!cases.length)list.append(learningLine('p','未收集到成功送出的人工回覆。原有聊天仍保留在收件匣。','bp-small bp-muted'));list.dataset.signature=caseSignature;}
      const holder=find('[data-learning-proposals]');for(const [index,item] of proposals.entries()){if(!learningProposalNodes.has(item.id)){const node=createLearningProposal(item);const next=proposals.slice(index+1).map(p=>learningProposalNodes.get(p.id)).find(Boolean);learningProposalNodes.set(item.id,node);holder.insertBefore(node,next||null);}updateLearningProposal(item.id);}for(const id of learningProposalNodes.keys())if(!proposals.some(p=>p.id===id))updateLearningProposal(id);
      find('[data-learning-empty]').hidden=proposals.some(learningProposalVisible);find('[data-learning-empty]').textContent=!learningLoaded?'整理建議尚未讀回。':!proposals.length&&cases.some(item=>item.status==='analyzed')?'AI 已分析現有人工示範，暫未提出新建議；可補充處理背景或繼續累積對話。':'這個分類暫未有整理建議。';
    }
    async function refreshLearning(){if(!live||typeof backend.knowledgeLearning!=='function'){paintLearning();return;}if(learningPolling)return;learningPolling=true;const epoch=learningEpoch;try{const result=await backend.knowledgeLearning();if(epoch!==learningEpoch)return;if(!result||!Array.isArray(result.cases)||!Array.isArray(result.proposals)||typeof result.settings?.automaticAnalysis!=='boolean')throw new Error('整理紀錄格式未能核對。');learningState=result;learningLoaded=true;paintLearning();}catch(error){learningNotice(error.message||'未能更新整理紀錄；未送出的修改保留。',true);throw error;}finally{learningPolling=false;}}
    function render(){root.dataset.view=state.screen;all('[data-screen]').forEach(x=>x.hidden=x.dataset.screen!==state.screen);all('[data-panel]').forEach(x=>x.hidden=x.dataset.panel!==state.tab);all('[data-tab]').forEach(x=>x.setAttribute('aria-selected',String(x.dataset.tab===state.tab)));find('[data-agent-code]').hidden=!state.showNumber;root.style.setProperty('--cs-card-padding',state.cardPadding+'px');find('.bp-config-card').dataset.activeView=state.tab;find('.bp-inbox-workspace').dataset.contextOpen=String(state.contextOpen);find('[data-thread-context]').hidden=!state.contextOpen;find('[data-inbox-context-toggle]').setAttribute('aria-expanded',String(state.contextOpen));paintSuggestion();paintConnection();paintManagementView();}
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
    const customerStates={ai:'自動處理',waiting:'等待本人／DOT',human:'由人工處理',self_test:'本人測試 · 等待新來訊',self_auto:'本人測試 · FAQ 自動',self_human:'本人測試 · 人工回覆'};
    const customerStatuses={received:'收到',draft:'待你確認，尚未發送',queued:'等待發送',sending:'已提交發送，可能無法撤回',accepted:'供應商已接受，尚未確認送達',delivered:'已送達',read:'已讀',failed:'發送失敗，請核對',uncertain:'結果未確認，請先在 WhatsApp 核對，不要直接重發',cancelled:'已作廢'};
    function customerNotice(text){find('[data-customer-notice]').textContent=text;}
    function selfReplySettings(){const value=selfReplyPolicy||snapshot.connections.whatsapp.selfTestReply||{};return {available:value.available===true,enabled:value.enabled===true,automaticFaq:value.automaticFaq===true,grantId:typeof value.grantId==='string'?value.grantId:null};}
    function selfReplyContext(data=currentCustomerData){const policy=selfReplySettings(),value=data?.selfTestReply||{};return {enabled:policy.enabled&&value.enabled===true,eligible:policy.enabled&&value.enabled===true&&value.eligible===true,automaticFaq:policy.automaticFaq&&value.automaticFaq===true};}
    function paintSelfReply(){const policy=selfReplySettings(),self=currentCustomerData?.conversation?.channel==='whatsapp_self_test',context=selfReplyContext(),pending=selfReplyOperations.get(selectedCustomerId);all('[data-self-reply-enable]').forEach(button=>{button.hidden=policy.enabled||Boolean(button.closest('.bp-thread-tools')&&!self);button.disabled=!live||!policy.available||busy;});all('[data-self-reply-disable]').forEach(button=>{button.hidden=!policy.enabled||Boolean(button.closest('.bp-thread-tools')&&!self);button.disabled=busy;});find('[data-self-reply-status]').textContent=policy.enabled?(policy.automaticFaq?'已開啟 · FAQ 自動＋人工':'已開啟 · 人工測試'):policy.available?'只讀 · 回覆未開啟':'回覆測試未準備';find('[data-composer-label]').textContent=self?'本人測試回覆（發給自己）':'回覆客戶';find('[data-thread-readonly]').hidden=!self;if(self)find('[data-thread-readonly]').textContent=pending?'上次本人回覆的提交結果待核對；暫停再次發送，沒有自動重試。':policy.enabled&&!policy.available?'本人測試服務目前未準備，請到管理檢查手機及收件設定。':!policy.enabled?'本人對話目前只讀。開啟回覆測試後，請在手機再傳 Hello；只測 FAQ／人工，不使用 AI／DOT。':!context.eligible?'回覆測試已開啟，舊 Hello 不會重跑。請在手機再傳 Hello，收到目前授權下的新文字後才可輸入回覆。':currentCustomerData.conversation.state==='self_human'?'本人測試正由人工回覆；恢復 FAQ 後下一則新文字才開始比對。':'本人回覆測試：FAQ 完全吻合才自動，亦可直接輸入人工回覆；不呼叫 AI／DOT。';}
    function syncSelfReplyOperation(data){const c=data?.conversation;if(c?.channel!=='whatsapp_self_test')return;const operation=selfReplyOperations.get(c.id);if(!operation)return;const message=(data.messages||[]).find(m=>m.operation_id===operation.operationId);if(!message)return;if(['uncertain','sending'].includes(message.status)){operation.status=message.status;return;}selfReplyOperations.delete(c.id);if(['queued','accepted','delivered','read'].includes(message.status)){if(replyDrafts.get(c.id)?.trim()===operation.text)replyDrafts.delete(c.id);customerNotice(message.status==='queued'?'本人測試回覆已保存並排隊，尚未確認送達。':'已讀回本人測試的實際訊息狀態，請在時間線核對。');}else customerNotice('本人測試回覆未完成發送，請核對時間線及目前授權後再處理。');}
    async function refreshSelfReply(){const epoch=selfReplyEpoch,value=await backend.getSelfTestReply();if(epoch!==selfReplyEpoch)return;selfReplyPolicy=value;snapshot.connections.whatsapp.selfTestReply=value;paintSelfReply();}
    function inboxHistoryLimit(){return '只顯示服務連線後收到的客戶新私人文字；不載入手機舊聊天、群組、媒體或本人連線測試。';}
    // Inbox reception guidance is derived from backend capabilities and consent.
    function inboxReceiveInfo(){
      const wa=snapshot.connections.whatsapp||{},scopeInfo=wa.autoReceiveOnConnect===true?(wa.inboxScope||{}):(inboxScope||wa.inboxScope||{}),scope=scopeInfo.mode;
      const consented=scope==='all_private_text'&&scopeInfo.consented===true,registered=wa.webhook?.registered===true,open=wa.status==='open';
      return {wa,scope,consented,includeSelfTests:scopeInfo.includeSelfTests===true,open,registered,canSetup:wa.receiveSetupAvailable===true||wa.inboxScope?.available===true,active:wa.receiveEnabled===true&&consented&&registered&&open&&(wa.autoReceiveOnConnect!==true||wa.autoReceiveStatus==='receiving')};
    }
    function paintInboxReceiveState(){const {wa,scope,open,registered,consented,active}=inboxReceiveInfo();const checked=wa.checkedAt?'（'+new Date(wa.checkedAt).toLocaleString('zh-HK')+'）':'';const phone=open?'上次核對：WhatsApp 已連接'+checked:wa.status==='close'?'WhatsApp 手機未連接':wa.status==='error'?'WhatsApp 連線未成功':'WhatsApp 手機狀態待核對';const receive=active?'新私人文字收件已啟用':registered?'收件入口已核對，啟用狀態待確認':'接收尚未啟動';const range=wa.autoReceiveOnConnect===true?(active?'接收所有新私人文字':'收件狀態待核對'):scope==='all_private_text'&&consented?'已同意全部新私人文字':'新私人文字收件待確認';const recorded=(inboxSummary.conversations||[]).filter(c=>c.channel==='evolution').map(c=>Number(c.last_customer_at)||0);const when=Math.max(Number(wa.evidence?.lastIncomingAt)||0,0,...recorded);const observed=when?'最近客戶來訊記錄：'+new Date(when).toLocaleString('zh-HK'):'尚未觀察到客戶來訊';const text=[phone,receive,range,observed].join(' · ');const node=find('[data-inbox-receive-state]');if(node.textContent!==text)node.textContent=text;}
    function emptyInboxInfo(){
      const {wa,open,registered,consented,active,canSetup}=inboxReceiveInfo(),base=queueBase(),visible=queueRows().length>0;
      if(visible)return {title:'請選擇客戶對話',next:'從清單選擇一位客戶，便可人工接手或交回已啟用的知識庫／AI。'};
      if(base.length&&(state.queueSearch||state.queueFilter!=='customers'))return {title:'目前篩選沒有對話',next:'改為全部對話，查看已收到的來訊。',action:'filter'};
      if(wa.autoReceiveOnConnect===true){
        if(wa.autoReceiveStatus==='status_unknown')return {title:'暫時未能讀取收件狀態',next:'請檢查本機工作台是否運行，並重新登入。',action:'manage'};
        if(wa.autoReceiveStatus==='account_changed')return {title:'WhatsApp 帳戶需要重新核對',next:'已保留原有資料；請核對手機帳戶和接駁狀態。',action:'phone'};
        if(wa.autoReceiveStatus==='error')return {title:'WhatsApp 接駁未完成',next:'新訊息暫時未能進入收件匣，請重試接駁。',action:'retry'};
        if(!open)return {title:'WhatsApp 手機連線待核對',next:'連結手機後會自動準備接收新私人文字。',action:'phone'};
        if(!active)return {title:'正在準備接收訊息',next:'手機已連結，正在核對收件；準備完成後這裡會顯示新訊息。'};
      }else{
        if(!open)return {title:'WhatsApp 手機連線待核對',next:'先核對手機連線，再設定接收新私人文字。',action:'phone'};
        if(!registered||!consented||!active)return {title:'手機已連結，接收尚未啟動',next:canSetup?'準備收件入口，並確認接收新私人文字；允許人工回覆需另外勾選。':'此服務尚未提供即時收件能力。請到渠道設定核對，不能以手機連結代替收件。',action:canSetup?'receive':'manage'};
      }
      return {title:'收件已啟用，等待新來訊',next:'請用另一個 WhatsApp 帳戶傳一則新文字。啟用前的舊訊息不會匯入。'};
    }
    function openInboxGuidance(action){
      if(action==='receive'){openWhatsAppReceiveSettings();return;}
      if(action==='retry'){const button=find('[data-customer-messages] [data-inbox-setup-action="retry"]');run(button,async()=>{await backend.retryWhatsAppAutoReceive();await refresh();});return;}
      if(action==='filter'){state.queueFilter='customers';state.queueSearch='';find('[data-queue-search]').value='';paintQueue();render();return;}
      openManagement();
    }
    function paintEmptyInbox(){
      paintInboxReceiveState();const info=emptyInboxInfo(),messages=find('[data-customer-messages]'),signature=JSON.stringify({...info,limit:inboxHistoryLimit()});if(messages.dataset.emptySignature===signature&&messages.firstElementChild?.dataset.inboxEmpty==='true')return;
      messages.dataset.emptySignature=signature;messages.replaceChildren();const empty=document.createElement('div');empty.className='bp-inbox-empty';empty.dataset.inboxEmpty='true';const title=document.createElement('strong');title.textContent=info.title;const next=document.createElement('p');next.textContent=info.next;const limit=document.createElement('p');limit.textContent=inboxHistoryLimit();empty.append(title,next,limit);
      if(info.action){const actions=document.createElement('div');actions.className='bp-actions';const button=document.createElement('button');button.type='button';button.className='bp-button bp-primary';button.dataset.inboxSetupAction=info.action;button.textContent={receive:'設定 WhatsApp 收件',retry:'重試接駁',phone:'查看手機接駁',manage:'查看渠道設定',filter:'查看全部對話'}[info.action];button.addEventListener('click',()=>openInboxGuidance(info.action));actions.append(button);empty.append(actions);}
      messages.append(empty);
    }
    // End inbox reception guidance
    function customerSendReady(c){if(c.channel==='whatsapp_self_test')return false;if(c.channel!=='evolution')return true;return snapshot.connections.whatsapp.readiness?.canSend===true;}
    function paintCustomerDetail(data){
      const c=data?.conversation,holder=find('[data-customer-detail]');currentCustomerData=data;syncSelfReplyOperation(data);holder.hidden=false;paintThreadContext(data);paintSelfReply();if(!c){customerSignature='';find('[data-customer-name]').textContent='收件匣';find('[data-customer-state]').textContent='等待新來訊';find('[data-customer-takeover]').hidden=false;find('[data-customer-takeover]').disabled=true;find('[data-customer-resume]').hidden=false;find('[data-customer-resume]').disabled=true;find('[data-customer-resume]').textContent='交回知識庫／AI';find('[data-inbox-dot-call]').hidden=false;find('[data-inbox-dot-call]').disabled=true;find('[data-inbox-control-help]').textContent='先選擇收到的對話便可人工接手；交回後僅下一筆新來訊按已啟用知識庫／AI政策處理。';find('[data-inbox-dot-details]').hidden=true;const composer=find('[data-customer-reply-form]');composer.elements.text.disabled=true;composer.elements.text.value='';find('[data-customer-send]').disabled=true;paintEmptyInbox();find('[data-customer-send-note]').textContent='收到來訊後可在這裡接手並回覆。';return;}const selfTest=c.channel==='whatsapp_self_test',selfContext=selfReplyContext(data),selfReady=selfTest&&selfReplySettings().available&&selfContext.eligible&&!selfReplyOperations.has(c.id);const notice=find('[data-customer-notice]').textContent;if(['正在讀取實際來訊。','正在讀取所選對話。','對話清單已更新，請選擇一位客戶。'].includes(notice)||notice.startsWith('請選擇客戶對話。'))customerNotice(selfTest?'已讀取本人對話測試，回覆按目前授權核對。':'已讀取目前對話；新訊息會自動更新。');find('[data-inbox-dot-details]').hidden=selfTest;find('[data-customer-takeover]').disabled=selfTest;
      find('[data-customer-name]').textContent=selfTest?'本人對話・回覆測試':c.name||'WhatsApp 客戶';find('[data-customer-state]').textContent=selfTest?(selfReplySettings().enabled?customerStates[c.state]||'本人測試 · 待核對':'本人對話測試（只讀）'):customerStates[c.state]||'狀態未確認';
      const canSend=customerSendReady(c),wa=snapshot.connections.whatsapp;
      const missing=wa.readiness?.missingFields||[!snapshot.profile.name&&'商戶名稱',!snapshot.profile.service&&'服務介紹',!snapshot.settings.handoffContact&&'人工聯絡安排'].filter(Boolean);
      find('[data-customer-send-note]').textContent=selfTest?(selfReady?'本人測試可直接輸入回覆；送出後暫停此對話的自動 FAQ。不計客戶收發驗收。':selfReplyOperations.has(c.id)?'上次提交結果未明，請核對手機及時間線；不會自動重送。':selfReplySettings().enabled?'請在手機再傳 Hello；舊訊息不能啟動本次回覆測試。':'本人對話目前只讀；請先開啟本人對話回覆測試。'):c.channel==='evolution'?(missing.length?'請先在本卡片填寫並儲存：'+missing.join('、')+'。':!canSend?(wa.autoReceiveOnConnect===true?'WhatsApp 暫時未能回覆，請核對手機及收件狀態。':'WhatsApp 回覆權限尚未開放。請到「渠道接駁」確認新私人文字收件及回覆授權。'):wa.autoReceiveOnConnect===true?'按「發送回覆」只會提交這則回覆，系統會再次核對連線及對話。':wa.inboxReplyEnabled?'目前可回覆已接收的新私人來訊；不開放任意陌生訊息。':'WhatsApp 發送已開啟，發送前會再次檢查當前資料及對話狀態。'):'這是已接駁網頁的實際來訊。回覆經確認後才提交給客人。';
      find('[data-customer-takeover]').hidden=selfTest||c.state==='human';find('[data-customer-resume]').hidden=selfTest?!(selfReplySettings().enabled&&selfContext.eligible&&c.state==='self_human'):c.state==='ai';find('[data-inbox-dot-call]').hidden=selfTest;
      find('[data-customer-resume]').disabled=selfTest?!selfReady:!inboxSummary.policy?.enabled&&snapshot.connections.ai.status!=='connected';find('[data-customer-resume]').textContent=selfTest?'恢復本人測試 FAQ':inboxSummary.policy?.enabled?(inboxSummary.policy.aiFallback?'交回知識庫／AI':'交回知識庫'):'交回 AI';find('[data-inbox-control-help]').textContent=selfTest?'本人測試與客戶對話分開，不交給 AI／DOT。':c.state==='human'?'目前由你回覆；交回後從下一則新來訊按已啟用的知識庫／AI政策處理，舊訊息及草稿不會補發。':'可先人工接手；知識庫／AI能否回覆，仍按已啟用政策、有效知識及模型狀態核對。';
      const composer=find('[data-customer-reply-form]');composer.elements.text.disabled=selfTest?!selfReady:c.state!=='human';composer.elements.text.placeholder=selfTest?(selfReady?'輸入要發給自己手機的測試回覆。':'先開啟回覆測試，再在手機傳一則新的 Hello。'):'先接手對話，再寫下要發給客人的回覆。';find('[data-customer-send]').disabled=selfTest?!selfReady:c.state!=='human'||!canSend;find('[data-customer-send]').textContent=selfTest?'發送本人測試回覆':'發送回覆';
      const signature=JSON.stringify(data);if(signature===customerSignature)return;customerSignature=signature;
      if(document.activeElement!==composer.elements.text)composer.elements.text.value=replyDrafts.get(c.id)||'';
      const messages=find('[data-customer-messages]'),oldScroll=messages.scrollTop,atBottom=messages.scrollHeight-messages.clientHeight-oldScroll<60,active=document.activeElement;const focusedDraft=messages.contains(active)?{id:active.dataset.draftId,start:active.selectionStart,end:active.selectionEnd}:null;delete messages.dataset.emptySignature;messages.replaceChildren();
      find('[data-inbox-dot-prompt]').value=selfTest?'':root.csInboxTools?.prompt(c.id)||'';find('[data-inbox-dot-call]').disabled=selfTest||!root.csInboxTools;
      for(const m of data.messages||[]){
        const item=document.createElement('article');item.className='bp-customer-message';item.dataset.role=m.role;const meta=document.createElement('small');meta.textContent=(m.role==='user'?(selfTest?'本人':'客人'):m.role==='staff'?'人工回覆':'客服')+' · '+(customerStatuses[m.status]||'狀態未確認')+(m.engine==='offline'?' · 離線規則草稿，並非模型回覆':m.engine==='codex-dot'?' · DOT 建議草稿':m.engine==='knowledge'?' · 已確認知識庫答案':m.engine==='codex-cli'?' · 本機 Codex 背景回覆':m.engine==='self-test-knowledge'?' · 本人測試 FAQ':m.engine==='self-test-manual'?' · 本人人工測試':'')+' · '+new Date(m.created_at).toLocaleTimeString('zh-HK',{hour:'2-digit',minute:'2-digit',hourCycle:'h23'});const text=document.createElement('p');text.textContent=m.content;item.append(meta,text);
        if(!selfTest&&m.status==='draft'&&m.engine==='codex-dot'){const adopt=document.createElement('button');adopt.type='button';adopt.className='bp-button';adopt.textContent='採用到人工回覆';adopt.disabled=m.version!==c.version;adopt.addEventListener('click',()=>run(adopt,async()=>{if(!activeCustomerContext(c.id))throw new Error('對話已切換，請重新核對目前客戶的草稿。');const context=await backend.inboxContext(c.id);if(selectedCustomerId!==c.id||context.version!==m.version||context.revision!==m.config_version)throw new Error('訊息或知識已更新，請讓 DOT 重新閱讀後產生草稿。');replyDrafts.set(c.id,m.content);composer.elements.text.value=m.content;customerNotice(c.state==='human'?'草稿已放入人工回覆欄，請核對後發送。':'草稿已放入人工回覆欄，請先接手對話再核對發送。');}));item.append(adopt);}
        if(!selfTest&&m.status==='draft'&&c.state==='ai'&&m.role==='assistant'&&m.engine!=='codex-dot'){
          const editor=document.createElement('textarea');editor.rows=3;editor.maxLength=4000;editor.value=customerDrafts.has(m.id)?customerDrafts.get(m.id):m.content;editor.dataset.draftId=m.id;editor.setAttribute('aria-label','核對客戶回覆草稿');editor.addEventListener('input',()=>customerDrafts.set(m.id,editor.value));
          const actions=document.createElement('div');actions.className='bp-actions';const approve=document.createElement('button');approve.className='bp-button bp-primary';approve.type='button';approve.textContent='確認並發送';approve.disabled=!canSend;
          approve.addEventListener('click',()=>run(approve,async()=>{if(!activeCustomerContext(c.id))throw new Error('對話已切換，請重新核對目前客戶的草稿。');if(!editor.value.trim())throw new Error('請填寫並核對回覆內容，空白草稿不會發送。');try{await backend.approveReply(m.id,editor.value);customerDrafts.delete(m.id);customerNotice('回覆已排隊。請查看實際提交及送達狀態。');}finally{await refreshCustomers();}}));actions.append(approve);item.append(editor,actions);
        }
        messages.append(item);
      }
      messages.scrollTop=atBottom?messages.scrollHeight:oldScroll;if(focusedDraft?.id){const field=[...messages.querySelectorAll('[data-draft-id]')].find(node=>node.dataset.draftId===focusedDraft.id);if(field){field.focus({preventScroll:true});field.setSelectionRange(focusedDraft.start,focusedDraft.end);}}
    }
    function paintInboxSummary(result,selfEpoch=selfReplyEpoch){
      inboxSummary=result;if(selfEpoch===selfReplyEpoch)selfReplyPolicy=result.selfTestReply||snapshot.connections.whatsapp.selfTestReply||null;paintSelfReply();const pending=result.pendingHandoffs||[],count=result.pendingCount??pending.length,alert=find('[data-owner-alert]');alert.hidden=!count;const alertText=`${count} 段對話待你／DOT 處理：需要核對答案、例外或處理結果。`;if(alert.textContent!==alertText)alert.textContent=alertText;find('[data-inbox-entry-count]').textContent=count?`${count} 段對話等待你或 DOT 處理`:'即時對話與知識庫優先處理';
      if(!inboxPolicyDirty){const f=find('[data-inbox-policy]');for(const key of ['enabled','automaticKnowledge','aiFallback','automaticAi'])f.elements[key].checked=result.policy?.[key]===true;}
      paintBackgroundAI();
      for(const task of pending){const id=task.id||task.window_id;if(!id||notifiedHandoffs.has(id))continue;notifiedHandoffs.add(id);if(typeof Notification!=='undefined'&&Notification.permission==='granted'){try{new Notification('客服有待處理對話',{body:'有對話需要本人核對，請開啟客服卡片處理。',tag:'bluesai-inbox'});}catch{}}}
    }
    function queueBase(){return (inboxSummary.conversations||[]).filter(c=>c.channel==='evolution'||(c.channel==='web'&&snapshot.connections.webChat?.enabled===true));}
    function queueMatch(c,filter){if(filter==='waiting')return c.state==='waiting'||Number(c.pending)>0||(inboxSummary.pendingHandoffs||[]).some(t=>t.conversationId===c.id);return true;}
    function queueRows(){const search=state.queueSearch.trim().toLocaleLowerCase();return queueBase().filter(c=>queueMatch(c,state.queueFilter)&&(!search||[c.name,c.preview,c.address].filter(Boolean).join(' ').toLocaleLowerCase().includes(search)));}
    function paintQueue(){if(!inboxLoaded){all('[data-queue-count]').forEach(node=>node.textContent='—');find('[data-queue-summary]').textContent='尚未讀取到對話清單，請稍後重試。';return;}const base=queueBase(),rows=queueRows();for(const filter of ['customers','waiting']){find('[data-queue-count="'+filter+'"]').textContent=base.filter(c=>queueMatch(c,filter)).length;find('[data-queue-filter="'+filter+'"]').setAttribute('aria-pressed',String(state.queueFilter===filter));}find('[data-queue-summary]').textContent=state.queueSearch?`目前已載入清單中找到 ${rows.length} 段對話`:`已載入 ${base.length} 段對話；依最新記錄排列`;const holder=find('[data-queue-list]'),signature=JSON.stringify([state.queueFilter,state.queueSearch,selectedCustomerId,rows.map(c=>[c.id,c.name,c.preview,c.pending,c.state,c.updated_at])]);if(signature!==queueSignature){const scroll=holder.scrollTop,focused=document.activeElement?.dataset?.queueId;holder.replaceChildren();if(!rows.length){const empty=document.createElement('p');empty.className='bp-queue-empty';empty.textContent=state.queueSearch?'目前清單沒有符合搜尋的對話。':'目前沒有符合此分類的客戶對話。';holder.append(empty);}for(const c of rows){const item=document.createElement('button');item.type='button';item.className='bp-queue-row';item.dataset.queueId=c.id;item.setAttribute('aria-pressed',String(c.id===selectedCustomerId));const title=document.createElement('strong');title.textContent=c.name||'WhatsApp 客戶';const preview=document.createElement('span');preview.className='bp-queue-preview';preview.textContent=c.preview||'尚未有訊息內容';const meta=document.createElement('small');meta.textContent=((c.channel==='web'?'網頁':'WhatsApp')+' · '+(customerStates[c.state]||'待核對'))+(c.pending?' · 有待處理內容':'');item.append(title,preview,meta);item.addEventListener('click',()=>selectQueueConversation(c.id));const row=document.createElement('div');row.setAttribute('role','listitem');row.append(item);holder.append(row);}holder.scrollTop=scroll;if(focused){const node=[...holder.querySelectorAll('[data-queue-id]')].find(n=>n.dataset.queueId===focused);node?.focus({preventScroll:true});}queueSignature=signature;}paintConnection();paintManagement();}
    function activeCustomerContext(id=selectedCustomerId){return Boolean(id&&id===selectedCustomerId&&currentCustomerData?.conversation?.id===id&&!customerRefreshPending);}function saveCurrentReply(){if(activeCustomerContext()&&currentCustomerData.conversation.channel!=='whatsapp_self_test')replyDrafts.set(selectedCustomerId,find('[data-customer-reply-form]').elements.text.value);}
    function selectQueueConversation(id){if(busy)return;saveCurrentReply();selectedCustomerId=id;currentCustomerData=null;customerSelectionMade=true;customerSignature='';customerRefreshPending=true;root.csInboxTools?.invalidate();paintCustomerDetail(null);const row=queueBase().find(c=>c.id===id);find('[data-customer-name]').textContent=row?.name||'讀取對話';find('[data-customer-state]').textContent='正在讀取';const loading=find('[data-customer-messages] .bp-inbox-empty');if(loading){loading.replaceChildren();const caption=document.createElement('strong');caption.textContent='正在讀取所選對話';loading.append(caption);}customerNotice('正在讀取所選對話。');render();paintQueue();refreshCustomers().catch(()=>{});}
    function chooseQueueFilter(filter){if(busy||!['customers','waiting'].includes(filter))return;saveCurrentReply();state.queueFilter=filter;selectedCustomerId=null;currentCustomerData=null;customerSelectionMade=false;customerSignature='';customerRefreshPending=true;root.csInboxTools?.invalidate();queueSignature='';paintCustomerDetail(null);render();paintQueue();refreshCustomers().catch(()=>{});}
    function openManagement(){openManagementSection('channels');paintManagement();}
    function paintManagement(){
      const wa=snapshot.connections.whatsapp||{},policy=inboxSummary.policy||{},scope=wa.autoReceiveOnConnect===true?(wa.inboxScope||{}):(inboxScope||wa.inboxScope||{}),phone=paintPhoneConnection(wa);
      find('[data-manage-link]').textContent=phone.number||(phone.tone==='open'?'未取得連結號碼':'尚未連結手機');
      find('[data-manage-receive]').textContent=wa.autoReceiveOnConnect===true?(wa.autoReceiveStatus==='error'?'接駁未完成':wa.autoReceiveStatus==='account_changed'?'帳戶待核對':wa.autoReceiveStatus==='status_unknown'?'狀態未能讀取':wa.autoReceiveStatus==='receiving'&&wa.receiveEnabled===true&&wa.status==='open'&&wa.webhook?.registered===true&&scope.mode==='all_private_text'&&scope.consented===true?'接收新私人訊息':wa.autoReceiveStatus==='preparing'?'正在準備收件':'等待手機連接'):scope.mode==='all_private_text'&&scope.consented===true?(wa.webhook?.registered?(wa.receiveEnabled===true&&wa.status==='open'?'接收新私人訊息':'收件啟用待核對'):'新私人文字 · 入口待核對'):'待確認收件範圍';
      find('[data-management-reply-summary]').textContent=inboxLoaded?policyMode(policy):'規則待核對';
      find('[data-management-ai-summary]').textContent=snapshot.connections.ai.status==='connected'?'背景 AI 上次已接駁':'背景 AI 未核對';
      find('[data-management-merchant-summary]').textContent=snapshot.profile.name||'尚未填寫名稱';
      find('[data-manage-web]').textContent=snapshot.connections.mode==='runtime'&&snapshot.connections.webChat?.enabled?'客人入口已啟用；收發仍須驗收':'讓客人在網頁聯絡你 · 未開啟';
      find('[data-manage-next-action]').textContent=phone.tone==='open'?'核對接駁':'接駁 WhatsApp';const retry=find('[data-manage-receive-action]');retry.hidden=wa.autoReceiveOnConnect===true?wa.autoReceiveStatus!=='error':wa.receiveSetupAvailable!==true&&wa.inboxScope?.available!==true;retry.textContent=wa.autoReceiveOnConnect===true?'重試接駁':'設定／重試收件';
      paintManagementView();
    }
    function contextDateTime(value){const time=Number(value);if(!Number.isFinite(time)||time<=0)return '未提供';const date=new Date(time);return Number.isNaN(date.getTime())?'未提供':date.toLocaleString('zh-HK',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});}
    function contextReplyMethod(message){if(!message)return '—';if(message.role==='staff')return '人工回覆';return ({knowledge:'已確認知識庫', 'codex-cli':'本機 Codex', 'codex-dot':'DOT 草稿', 'openai':'模型 API', 'offline':'離線規則', 'self-test-knowledge':'本人測試 FAQ', 'self-test-manual':'本人人工測試'})[message.engine]||'AI 回覆';}
    function paintThreadContext(data){
      const c=data?.conversation,self=c?.channel==='whatsapp_self_test',messages=c&&Array.isArray(data?.messages)?data.messages:[],latestIncoming=[...messages].reverse().find(m=>m.role==='user'),answer=[...messages].reverse().find(m=>['assistant','staff'].includes(m.role)&&m.status!=='cancelled');
      find('[data-thread-channel]').textContent=!c?'從左邊選擇對話':self?'WhatsApp · 本人對話測試':c.channel==='web'?'網頁來訊':'WhatsApp 客戶對話';
      find('[data-context-summary]').textContent=c?(c.name||'目前客戶'):'選擇對話後，查看目前處理及回覆記錄。';
      find('[data-context-channel]').textContent=!c?'尚未選擇對話':self?'WhatsApp 自傳測試':c.channel==='web'?'網頁':'WhatsApp';
      find('[data-context-incoming]').textContent=c?contextDateTime(c.last_customer_at||latestIncoming?.created_at):'—';
      find('[data-context-message-count]').textContent=c?messages.length+' 則':'—';
      find('[data-context-state]').textContent=c?(self?(selfReplySettings().enabled?customerStates[c.state]||'本人測試 · 待核對':'只讀連線測試'):customerStates[c.state]||'狀態待核對'):'—';
      const pending=(inboxSummary.pendingHandoffs||[]).find(task=>task.conversationId===c?.id),reasons={knowledge_missing:'尚未有可採用的已確認答案。',knowledge_conflict:'已確認資料有衝突，需要本人核對。',knowledge_requires_human:'這項安排需要本人核對。',customer_requests_human:'客戶要求由人工處理。',agent_requests_human:'AI 已交回本人核對。',deadline:'回覆工作未能及時完成，需要本人跟進。'};
      find('[data-context-handling]').textContent=!c?'尚未選擇對話。':self?'本人測試與客戶對話分開，不交由 AI／DOT 處理。':c.state==='human'?'自動回覆已暫停；交回後只處理下一則新來訊。':c.state==='waiting'?(reasons[pending?.reason]||'這段對話正等待本人核對及處理。'):c.state==='ai'?'按已儲存規則處理新來訊；舊草稿不會補發。':'目前處理狀態待核對。';
      find('[data-context-policy]').textContent=c?(self?'本人測試設定':policyMode(inboxSummary.policy||{})):'—';
      find('[data-thread-readonly]').hidden=!self;
      find('[data-composer-note]').textContent=self?(selfReplyOperations.has(c.id)?'提交結果待核對，暫不再次發送。':selfReplyContext(data).eligible?'本人測試回覆只發給自己，不計客戶驗收。':'請開啟測試並在手機再傳 Hello。'):c?.state==='human'?'你正接手此對話；發送前請核對內容。':'先開始人工回覆，或請 DOT 準備草稿。';
      find('[data-context-reply-method]').textContent=contextReplyMethod(answer);
      const staleDraft=answer?.status==='draft'&&(answer.version!==c?.version||answer.config_version!==data?.revision);
      find('[data-context-reply-status]').textContent=answer?(staleDraft?'草稿需重新核對':customerStatuses[answer.status]||'狀態待核對'):'尚未有回覆';
      find('[data-context-reply-time]').textContent=answer?contextDateTime(answer.created_at):'—';
      find('[data-context-reply-note]').textContent=!answer?'尚未有客服或人工回覆記錄。':answer.status==='accepted'?'供應商已接受這則回覆，仍未確認送達。':answer.status==='delivered'?'渠道已回報送達，尚未回報已讀。':answer.status==='read'?'渠道已回報對方已讀。':answer.status==='uncertain'?'發送結果未明，請先核對 WhatsApp，避免重複發送。':staleDraft?'訊息或設定已更新，這份草稿不能直接按原狀發送。':answer.status==='draft'?'這是尚未發送的草稿。':answer.status==='queued'?'回覆已排隊，尚未確認提交或送達。':answer.status==='sending'?'回覆正在提交，尚未確認送達。':answer.status==='failed'?'這次發送未成功，請先核對原因。':'只顯示目前已讀回的狀態。';
      const holder=find('[data-context-knowledge]');holder.replaceChildren();holder.textContent='';
      if(!answer){holder.textContent=self?'本人測試只比對已確認 FAQ 或由你回覆，不計客戶收發驗收。':'最近回覆尚未採用任何資料。';return;}
      if(answer.role==='staff'){holder.textContent='這則是人工回覆，未自動引用知識庫來源。';return;}
      if(answer.engine==='codex-dot'){holder.textContent='DOT 建議草稿，待本人核對；不會自動成為商戶知識。';return;}
      const ids=[...new Set(Array.isArray(answer.sources)?answer.sources:[])];
      if(!ids.length){holder.textContent=answer.engine==='offline'?'舊離線規則草稿，不代表模型或正式渠道驗收。':'這則回覆沒有列出已確認知識來源，請自行核對。';return;}
      const fresh=Number.isSafeInteger(knowledgeRevision)&&knowledgeRevision===inboxSummary.revision&&data?.revision===knowledgeRevision;
      for(const id of ids){const fact=(snapshot.knowledge||[]).find(k=>k.id===id),entry=document.createElement('div'),title=document.createElement('strong'),status=document.createElement('span');entry.className='bp-source-entry';if(!fresh){title.textContent='來源待重新核對';status.textContent='資料版本未完成核對，暫不標示為已確認。';}else if(!fact){title.textContent='來源已更新';status.textContent='請重新核對回覆依據。';}else{title.textContent=fact.title||'已採用知識';status.textContent=fact.approved&&(!fact.expires_at||fact.expires_at>Date.now())?'已確認 · '+contextDateTime(knowledgeCheckedAt)+' 核對':'已更新、失效或待重新確認';}entry.append(title,status);holder.append(entry);}
    }
    async function refreshKnowledgeForInbox(result){const revision=result.revision;if(!Number.isSafeInteger(revision)){knowledgeRevision=null;knowledgeCheckedAt=null;return result;}if(knowledgeRevision===revision)return result;try{const latest=await backend.load(),confirmation=await backend.inbox();if(confirmation.revision!==revision||!Array.isArray(latest.knowledge)){knowledgeRevision=null;knowledgeCheckedAt=null;return confirmation;}snapshot.knowledge=latest.knowledge;knowledgeRevision=revision;knowledgeCheckedAt=Date.now();return confirmation;}catch{knowledgeRevision=null;knowledgeCheckedAt=null;return result;}}
    async function refreshCustomers(){if(!live){customerNotice('客服後台尚未接駁，現在不能讀取來訊。');return;}if(customerPolling)return;customerPolling=true;customerRefreshPending=false;const selfEpoch=selfReplyEpoch;try{let result=await backend.inbox();result=await refreshKnowledgeForInbox(result);inboxLoaded=true;paintInboxSummary(result,selfEpoch);const conversations=queueBase(),rows=queueRows(),picker=find('[data-customer-picker]');const pickerSignature=JSON.stringify(conversations.map(c=>[c.id,c.name,c.channel,c.state,c.pending]));if(pickerSignature!==customerPickerSignature){picker.replaceChildren();const empty=document.createElement('option');empty.value='';empty.textContent='選擇對話';picker.append(empty);for(const c of conversations){const option=document.createElement('option');option.value=c.id;option.textContent=c.name||'客戶';picker.append(option);}customerPickerSignature=pickerSignature;}if(selectedCustomerId&&!conversations.some(c=>c.id===selectedCustomerId)){selectedCustomerId=null;customerSignature='';root.csInboxTools?.invalidate();}if(!selectedCustomerId&&!customerSelectionMade&&rows.length)selectedCustomerId=rows[0].id;picker.value=selectedCustomerId||'';if(selectedCustomerId){const id=selectedCustomerId,data=await backend.conversation(id);if(selectedCustomerId===id){if(data.conversation?.channel==='whatsapp_self_test'&&selfEpoch!==selfReplyEpoch)customerRefreshPending=true;else{customerRefreshPending=false;paintCustomerDetail(data);}}}else{customerRefreshPending=false;paintCustomerDetail(null);}paintQueue();find('[data-inbox-updated]').textContent='最近更新 '+new Date().toLocaleTimeString('zh-HK',{hour:'2-digit',minute:'2-digit',hourCycle:'h23'});paintInboxReceiveState();find('[data-inbox-error]').hidden=true;if(!conversations.length){const info=emptyInboxInfo();customerNotice(info.title+'。'+info.next);}else if(inboxHadReadError||['正在讀取實際來訊。','正在讀取所選對話。'].includes(find('[data-customer-notice]').textContent)){customerNotice(selectedCustomerId?(activeCustomerContext()?'已讀取目前對話；新訊息會自動更新。':'正在讀取所選對話。'):'對話清單已更新，請選擇一位客戶。');}inboxHadReadError=false;}catch(error){inboxHadReadError=true;const notice=find('[data-inbox-error]');notice.hidden=false;notice.textContent='未能更新來訊；目前保留上次讀取的記錄。'+(error.status===401?'請重新登入。':'請稍後重試。');if(!inboxLoaded)paintQueue();customerNotice(error.message||'讀取來訊未成功。');throw error;}finally{customerPolling=false;if(customerRefreshPending&&!busy&&root.isConnected)Promise.resolve().then(()=>refreshCustomers()).catch(()=>{});}}
    function openCustomerPanel(){guideFlow=null;state.screen='config';state.tab='basic';render();paintGuide();find('[data-customer-panel]').scrollIntoView({block:'start'});refreshCustomers().catch(()=>{});}
    async function refreshFaq(){const result=await backend.faqRules(),holder=find('[data-inbox-faq-list]');holder.replaceChildren();const rules=result.rules||[];find('[data-inbox-faq-count]').textContent=rules.length+' 條完整問題規則（答案須經確認並仍有效）';for(const rule of rules){const item=document.createElement('article');item.className='bp-memory';const question=document.createElement('strong');question.textContent=rule.question;const answer=document.createElement('p');answer.textContent=rule.answer||rule.content||'';const state=document.createElement('small');state.textContent=rule.approved?'答案已確認':'答案待確認；不會自動採用';item.append(question,answer,state);holder.append(item);}}
    function paintInboxScope(){const note=find('[data-inbox-scope-state]');const scopeText=inboxScope?.mode==='all_private_text'?(inboxScope.replyToReceived?'目前接收全部新私人文字來訊；已明確允許回覆最近來訊客戶，仍須通過當前發送檢查。':'目前接收全部新私人文字來訊；發送仍保持關閉。') :'尚未確認接收全部新私人文字來訊。';note.textContent=scopeText+(inboxScope?.includeSelfTests?' 自己傳自己訊息已開啟顯示；回覆測試另行授權。':' 自己傳自己連線測試未開啟。');if(!selfScopeDirty)find('[data-inbox-self-test-consent]').checked=inboxScope?.includeSelfTests===true;}
    async function refreshInboxScope(){if(snapshot.connections.whatsapp.inboxScope?.available!==true){find('[data-inbox-scope]').hidden=true;return;}find('[data-inbox-scope]').hidden=false;try{inboxScope=await backend.getWhatsAppInboxScope();paintInboxScope();paintInboxReceiveState();if(!currentCustomerData)paintEmptyInbox();}catch{find('[data-inbox-scope-state]').textContent='此接駁服務尚未提供全部新私人文字收件設定。';}}
    function paintData(fill=false){
      if(fill){for(const key of ['name','industry','service','instructions','tone'])form.elements.namedItem(key).value=snapshot.profile[key]|| (key==='tone'?'friendly':'');find('[data-model-form]').elements.model.value=snapshot.connections.ai.provider==='codex-cli'?'':snapshot.connections.ai.model||'';syncModelChoiceFromValue();form.elements.responseMode.value=snapshot.settings.mode||'review';form.elements.handoffContact.value=snapshot.settings.handoffContact||'';}
      paintSuggestion();paintConnection();
      const memories=find('[data-memories]');memories.replaceChildren();
      if(!snapshot.knowledge.length){const p=document.createElement('p');p.className='bp-small bp-muted';p.textContent='還沒有記憶。由左邊的對話開始。';memories.append(p);}
      for(const item of snapshot.knowledge){const box=document.createElement('article');box.className='bp-memory';const badge=document.createElement('span');badge.className='bp-badge';badge.textContent=(item.approved?'已確認 · ':'待你確認 · ')+(item.category==='style'?'回覆方式':item.category==='procedure'?'處理流程':'商戶資料');const text=document.createElement('p');text.textContent=item.content;const actions=document.createElement('div');actions.className='bp-actions';box.append(badge,text,actions);
        const button=(label,fn,primary=false)=>{const b=document.createElement('button');b.type='button';b.className='bp-button cursor-interaction'+(primary?' bp-primary':'');b.textContent=label;b.addEventListener('click',()=>run(b,fn));actions.append(b);return b;};
        if(!item.approved)button('確認採用',async()=>{await backend.memory(item.id,'approve');await refresh();report(live?'記憶已確認，可以用作客服回覆的依據。':'已在設計稿確認記憶。');},true);
        button('修改',()=>{if(box.querySelector('textarea'))return;const editor=document.createElement('textarea');editor.maxLength=2000;editor.rows=4;editor.value=item.content;editor.setAttribute('aria-label','修改記憶內容');text.hidden=true;box.insertBefore(editor,actions);const kind=document.createElement('select');kind.setAttribute('aria-label','記憶類別');for(const [key,label] of Object.entries({general:'一般商戶資料',hours:'營業時間',price:'價格',refund:'退換安排',procedure:'處理流程',style:'回覆方式'})){const option=document.createElement('option');option.value=key;option.textContent=label;kind.append(option);}kind.value=item.category;box.insertBefore(kind,actions);button('儲存修改',async()=>{if(!editor.value.trim())throw new Error('請填寫記憶內容。');await backend.memory(item.id,'edit',editor.value.trim(),kind.value);await refresh();report('修改已儲存，請重新確認。');},true);editor.focus();});
        button('刪除',async()=>{await backend.memory(item.id,'delete');await refresh();report('這條記憶已刪除。');});memories.append(box);
      }
      const usable=snapshot.knowledge.filter(x=>x.approved&&(!x.expires_at||x.expires_at>Date.now())).length;
      find('[data-memory-count]').textContent=usable+' 條可用';
      const chat=find('[data-training-chat]');chat.replaceChildren();for(const turn of snapshot.training)message(chat,turn.role==='user'?'user':'訓練助手',turn.content);
      const ai=snapshot.connections.ai,wa=snapshot.connections.whatsapp;syncWhatsAppQr(wa);paintBackgroundAI();find('[data-wa-status]').textContent=statusNames[wa.status]||'狀態未確認';
      const runtime=snapshot.connections.mode==='runtime';
      const modelLabel={unconfigured:'AI 模型未設定',configured:'AI 模型待驗證',connected:'AI 模型已驗證',error:'AI 模型連線未成功'}[ai.status]||'AI 模型狀態未確認';
      find('[data-runtime-label]').textContent=live?(runtime?'本機測試':'隔離預覽'):'後台尚未接駁';
      find('[data-runtime-connection]').hidden=wa.receiveSetupAvailable!==true&&wa.inboxScope?.available!==true&&wa.webhook?.configured!==true;const selfTestsAvailable=wa.selfTestReply?.available===true;find('[data-inbox-self-test-option]').hidden=!selfTestsAvailable;find('[data-inbox-self-test-note]').hidden=!selfTestsAvailable;find('[data-inbox-self-test-consent]').disabled=!selfTestsAvailable;
      if(runtime){
        const f=find('[data-whatsapp-form]');
        for(const key of ['url','instance']){f.elements[key].value=wa[key]||'';f.elements[key].readOnly=true;f.elements[key].required=false;}
        f.elements.apiKey.disabled=true;f.elements.apiKey.placeholder='已從伺服器私人設定載入；此頁不顯示';
        const when=timestamp=>timestamp?new Date(timestamp).toLocaleString('zh-HK'):'尚未觀察到';
        find('[data-channel-evidence]').textContent=`收件入口：${wa.receiveEnabled?'已設定':'未設定'}；供應商 webhook：${wa.webhook?.registered?'讀回相符':'未核對'}；WhatsApp 發送開關：${wa.deliveryEnabled?'已開啟':'關閉'}。最近來訊：${when(wa.evidence?.lastIncomingAt)}；最近回執：${when(wa.evidence?.lastReceiptAt)}。`;
        find('[data-channel-help]').textContent='本頁與客戶對話共用同一客服執行器及資料庫。金鑰、PUBLIC_BASE_URL、WEBHOOK_SECRET 及 DELIVERY_ENABLED 由伺服器私人環境設定；工作台不會暗中開啟發送。';
        find('[data-card-context]').textContent='客服 AI 卡片 · 設定、記憶及來訊只屬於此 Agent';
      }
      if(wa.autoReceiveOnConnect===true){find('[data-channel-help]').textContent='手機連線後自動接收新私人文字，並按已儲存的回覆方式處理。你可隨時人工接手；舊聊天、群組及媒體不會匯入。';}
      else if(wa.receiveSetupAvailable===true){find('[data-channel-evidence]').textContent='收件入口：'+(wa.webhook?.registered?'已核對':'待準備')+'；新私人文字：'+(wa.receiveEnabled?'已啟用':'未啟用')+'；最近來訊人工回覆：'+(wa.inboxReplyEnabled?'已授權':'未授權')+'。所有回覆仍由你確認發送。';find('[data-channel-help]').textContent='此服務接收新私人文字，未匯入舊聊天。人工回覆、知識庫／AI草稿與自動發送分開授權。';}
      if(live){find('[data-training-mode]').textContent=ai.status==='connected'&&!ai.requiresCheck?'AI 會理解你這次教的內容及最近訓練對話，整理待確認記憶；由你確認後才用於客戶回覆。':'模型尚未通過檢查：這次教學只會保存原文為待確認內容，不代表 AI 已理解或學會流程。';}
      paintLearning();paintGuide();paintManagement();paintSelfReply();paintWhatsAppLink();find('[data-wa-submit]').hidden=wa.status==='open';paintInboxReceiveState();if(currentCustomerData)paintCustomerDetail(currentCustomerData);else paintEmptyInbox();
    }
    async function refresh(fill=false){invalidateTaskRead();snapshot=await backend.load();paintData(fill);setupInboxTools();await Promise.allSettled([refreshLearning(),refreshCustomers(),refreshFaq().catch(()=>{find('[data-inbox-faq-count]').textContent='知識庫暫時未能更新，請稍後重試。';}),refreshInboxScope(),refreshSelfReply().catch(()=>{find('[data-self-reply-result]').textContent='本人回覆測試設定未能更新，請重新檢查；未知狀態不開啟發送。';}),refreshTasks().catch(error=>taskNotice(error.message||'任務暫時未能更新。'))]);}
    async function run(button,fn){if(busy)return;busy=true;const original=button?.textContent;if(button){button.disabled=true;button.textContent='處理中…';}try{await fn();}catch(e){report(e.message||'操作未完成，請再試。',true);}finally{busy=false;if(button){button.disabled=false;button.textContent=original;}if(selectedTask)paintTasks();if(currentCustomerData)paintCustomerDetail(currentCustomerData);paintBackgroundAI();paintSelfReply();paintLearning();paintWhatsAppLink();}}
    function setupInboxTools(){
      if(!live||inboxToolsReady)return;inboxToolsReady=true;root.csInboxTools?.register({selectedConversation:()=>state.screen==='config'&&state.tab==='basic'&&activeCustomerContext()&&currentCustomerData.conversation.channel!=='whatsapp_self_test'?selectedCustomerId:null,listInbox:()=>backend.inbox(),readContext:id=>backend.inboxContext(id),saveDraft:async input=>{const result=await backend.saveInboxDraft(input);if(selectedCustomerId===input.conversationId){customerSignature='';await refreshCustomers();find('[data-inbox-dot-status]').textContent='DOT 草稿已保存，請核對後採用到人工回覆；尚未發送。';}return result;},onError:error=>{find('[data-inbox-dot-status]').textContent=error.message||'即時對話工具未完成。';}});
      if(typeof EventSource==='function'){inboxEventStream=new EventSource('/api/agents/bluesai-cs-0001/inbox/events');inboxEventStream.addEventListener('change',()=>{if(root.isConnected&&!document.hidden&&!busy)refreshCustomers().catch(()=>{});});window.addEventListener('pagehide',()=>{inboxEventStream?.close();inboxEventStream=null;},{once:true});}
    }
    find('[data-learning-open-settings]').addEventListener('click',()=>openManagementSection('ai'));
    find('[data-learning-settings]').elements.automaticAnalysis.addEventListener('change',()=>{learningSettingsDirty=true;paintLearning();});
    find('[data-learning-settings]').addEventListener('submit',event=>{event.preventDefault();const f=event.currentTarget;run(event.submitter,async()=>{
      if(!learningLoaded)throw new Error('請先更新整理紀錄，核對目前設定。');
      const automaticAnalysis=f.elements.automaticAnalysis.checked;if(automaticAnalysis&&!learningModelReady())throw new Error('請先在管理核對並接駁 AI，才可啟用自動整理。');
      const epoch=++learningEpoch;await backend.configureKnowledgeLearning({automaticAnalysis,consent:true});const result=await backend.knowledgeLearning();
      if(epoch!==learningEpoch||result.settings?.automaticAnalysis!==automaticAnalysis)throw new Error('儲存後讀回的整理設定不相符，請重新核對。');
      learningState=result;learningLoaded=true;learningSettingsDirty=f.elements.automaticAnalysis.checked!==automaticAnalysis;paintLearning();learningNotice('對話整理方式已儲存並讀回；新建議仍須你確認，沒有開啟額外發送權限。');
    });});
    find('[data-learning-refresh]').addEventListener('click',event=>run(event.currentTarget,async()=>{await refreshLearning();learningNotice('已讀回整理紀錄，未送出的修改保留。');}));
    find('[data-learning-collect]').addEventListener('click',event=>run(event.currentTarget,async()=>{await backend.collectLearningCases();await refreshLearning();learningNotice('已收集成功送出的人工對話紀錄；是否有 AI 建議按模型及整理設定核對。');}));
    find('[data-learning-filter]').addEventListener('change',paintLearning);
    find('[data-learning-status-filter]').addEventListener('change',paintLearning);
    const learningPollTimer=setInterval(()=>{if(!root.isConnected){clearInterval(learningPollTimer);return;}if(live&&!busy&&!document.hidden&&state.screen==='config'&&state.tab==='training')refreshLearning().catch(()=>{});},2000);
    window.addEventListener('pagehide',()=>clearInterval(learningPollTimer),{once:true});
    find('[data-inbox-policy]').addEventListener('change',()=>{inboxPolicyDirty=true;});
    find('[data-inbox-policy]').addEventListener('submit',event=>{event.preventDefault();const f=event.currentTarget;run(event.submitter,async()=>{if(!inboxLoaded)throw new Error('尚未讀取現有回覆規則，請先更新收件匣。');const keys=['enabled','automaticKnowledge','aiFallback','automaticAi'],read=()=>Object.fromEntries(keys.map(key=>[key,f.elements[key].checked])),policy=read();if(policy.aiFallback&&!policy.enabled)throw new Error('背景 AI 草稿須先啟用知識庫優先；請核對勾選後再儲存。');if(policy.automaticAi&&!policy.aiFallback)throw new Error('AI 自動發送須同時啟用「FAQ 未命中時，交由背景 AI」。');if(policy.aiFallback&&snapshot.connections.ai.status!=='connected')throw new Error('請先在「AI 與助手」完成本機 Codex 或模型 API 的「檢查並接駁」，再啟用背景 AI。');await backend.configureInbox(policy);const confirmation=await backend.inbox();if(!keys.every(key=>(confirmation.policy?.[key]===true)===policy[key]))throw new Error('保存後讀回的規則已有變更，請重新核對後再儲存。');inboxPolicyDirty=JSON.stringify(read())!==JSON.stringify(policy);paintInboxSummary(confirmation);paintQueue();await refreshCustomers();report('回覆處理方式已儲存並讀回；'+(inboxPolicyDirty?'你剛作的新勾選仍未儲存。':'WhatsApp 發送另按實際授權核對。'));});});
    find('[data-inbox-faq-form]').addEventListener('submit',event=>{event.preventDefault();const f=event.currentTarget;run(event.submitter,async()=>{await backend.addFaq({question:f.elements.question.value.trim(),answer:f.elements.answer.value.trim(),approved:f.elements.approved.checked});f.reset();await Promise.all([refreshFaq(),refresh()]);report('常見問題已儲存。只會採用你已確認且仍有效的答案。');});});
    find('[data-inbox-notifications]').addEventListener('click',event=>run(event.currentTarget,async()=>{if(typeof Notification==='undefined'||typeof Notification.requestPermission!=='function')throw new Error('此瀏覽器未提供桌面通知；卡片內待處理提示仍然可用。');const result=await Notification.requestPermission();customerNotice(result==='granted'?'瀏覽器通知已允許；新增待處理會嘗試提示你，卡片亦會保留待處理提示。':'瀏覽器通知未允許；請留意卡片內持續顯示的待處理提示。');}));
    for(const enabled of [true,false])all(enabled?'[data-self-reply-enable]':'[data-self-reply-disable]').forEach(button=>button.addEventListener('click',event=>run(event.currentTarget,async()=>{if(enabled&&!selfReplySettings().available)throw new Error('本人回覆測試服務尚未準備，請先檢查手機及收件設定。');saveCurrentReply();selfReplyEpoch++;await backend.configureSelfTestReply({enabled,automaticFaq:enabled,consent:true});await refreshSelfReply();if(selfReplySettings().enabled!==enabled||selfReplySettings().automaticFaq!==enabled)throw new Error('讀回的本人回覆測試設定與選擇不符，請重新檢查。');customerSignature='';await refresh();const id=selectedCustomerId;if(id&&currentCustomerData?.conversation?.channel==='whatsapp_self_test'){const data=await backend.conversation(id);if(id===selectedCustomerId)paintCustomerDetail(data);}const message=enabled?'本人回覆測試已開啟，不重跑舊訊息。請在手機再傳 Hello；FAQ 完全吻合才自動，亦可人工回覆。':'本人回覆測試已關閉，回到只讀。未送出的文字保留，不會自動重送。';find('[data-self-reply-result]').textContent=message;customerNotice(message);report(message);})));
    find('[data-self-reply-check]').addEventListener('click',event=>run(event.currentTarget,async()=>{await refreshSelfReply();await refreshCustomers();report(selfReplySettings().enabled?'本人回覆測試設定已讀回；舊訊息不會重跑，請在手機再傳 Hello。':'本人對話目前只讀；回覆測試未開啟。');}));
    find('[data-inbox-self-test-consent]').addEventListener('change',()=>{selfScopeDirty=true;});
    find('[data-inbox-scope-enable]').addEventListener('click',event=>run(event.currentTarget,async()=>{if(!find('[data-inbox-scope-consent]').checked)throw new Error('請先確認全部新私人文字來訊的收件範圍。');inboxScope=await backend.configureWhatsAppInboxScope({mode:'all_private_text',consent:true,replyToReceived:find('[data-inbox-reply-consent]').checked,includeSelfTests:snapshot.connections.whatsapp.selfTestReply?.available===true&&find('[data-inbox-self-test-consent]').checked});selfScopeDirty=false;await refresh();paintInboxScope();report('收件與人工回覆範圍已讀回；請由另一帳戶傳送新文字。知識庫／AI是否可自動發送另按後端能力及已啟用政策檢查。');}));
    find('[data-inbox-dot-call]').addEventListener('click',event=>{
      if(!activeCustomerContext()){customerNotice('請先等待目前客戶對話讀取完成。');return;}state.contextOpen=true;render();find('[data-inbox-dot-details]').open=true;const target=find('[data-inbox-dot-prompt]');target.scrollIntoView({block:'nearest'});let request;try{request=root.csInboxTools?.invoke(target);}catch(error){find('[data-inbox-dot-status]').textContent=error.message;return;}if(!request){find('[data-inbox-dot-status]').textContent='此頁未提供 DOT 工具，請複製任務到目前對話。';return;}
      if(request.kind==='annotation'){find('[data-inbox-dot-status]').textContent=request.accepted?'瀏覽器已接受開啟要求。請在原生介面檢查並送出；尚未確認 DOT 已閱讀或已回覆。':'瀏覽器未接受開啟要求，請選取任務內容複製到目前 Codex／DOT。';return;}
      run(event.currentTarget,async()=>{const accepted=await request.promise;find('[data-inbox-dot-status]').textContent=accepted?(request.kind==='host'?'任務已交給目前 AI 對話，等待回傳草稿；尚未發送客戶訊息。':'任務已複製，請貼到目前 Codex／DOT 對話並送出。'):'未能交接；請選取任務內容複製到目前 Codex／DOT。';});
    });
    render();
    find('[data-shell-wa-status]').addEventListener('click',openManagement);
    find('[data-open-manage-channel]').addEventListener('click',openManagement);
    find('[data-manage-receive-action]').addEventListener('click',event=>{if(snapshot.connections.whatsapp?.autoReceiveOnConnect===true){run(event.currentTarget,async()=>{await backend.retryWhatsAppAutoReceive();await refresh();});return;}openWhatsAppReceiveSettings();});
    function closeThreadContext(){const opened=state.contextOpen;state.contextOpen=false;render();if(opened)find('[data-inbox-context-toggle]').focus({preventScroll:true});}
    find('[data-inbox-context-toggle]').addEventListener('click',()=>{if(state.contextOpen){closeThreadContext();return;}state.contextOpen=true;render();find('[data-inbox-context-close]').focus({preventScroll:true});});
    find('[data-inbox-context-close]').addEventListener('click',closeThreadContext);
    root.addEventListener('keydown',event=>{if(event.key==='Escape'&&state.screen==='config'&&state.tab==='basic'&&state.contextOpen&&!find('[data-thread-context]').hidden){event.preventDefault();event.stopPropagation();closeThreadContext();}});
    all('[data-queue-filter]').forEach(button=>button.addEventListener('click',()=>chooseQueueFilter(button.dataset.queueFilter)));
    find('[data-queue-search]').addEventListener('input',event=>{state.queueSearch=event.target.value;queueSignature='';paintQueue();});
    find('[data-open]').addEventListener('click',openManagement);
    find('[data-open-whatsapp]').addEventListener('click',openManagement);
    find('[data-back]').addEventListener('click',()=>{state.screen='list';render();remember();});
    all('[data-open-customer-panel]').forEach(button=>button.addEventListener('click',openCustomerPanel));

    find('[data-customer-picker]').addEventListener('change',event=>{if(busy||customerPolling){event.currentTarget.value=selectedCustomerId||'';return;}if(selectedCustomerId)replyDrafts.set(selectedCustomerId,find('[data-customer-reply-form]').elements.text.value);selectedCustomerId=event.currentTarget.value||null;customerSignature='';run(null,refreshCustomers);});
    find('[data-customer-reply-form]').elements.text.addEventListener('input',event=>{if(selectedCustomerId)replyDrafts.set(selectedCustomerId,event.target.value);});
    for(const [selector,action] of [['[data-customer-takeover]','takeover'],['[data-customer-resume]','resume']])find(selector).addEventListener('click',event=>run(event.currentTarget,async()=>{if(!activeCustomerContext())throw new Error('對話正在切換，請待目前對話讀取完成。');const self=currentCustomerData.conversation.channel==='whatsapp_self_test';if(self&&(action!=='resume'||!selfReplyContext().eligible||selfReplyOperations.has(selectedCustomerId)))throw new Error('本人測試須先核對目前授權及上次提交結果。');saveCurrentReply();await backend[action](selectedCustomerId);customerSignature='';await refreshCustomers();customerNotice(self?'已恢復本人測試 FAQ；請在手機再傳 Hello，只有下一則新文字才開始比對。':action==='takeover'?'你已接手，尚未提交的舊草稿會作廢。':inboxSummary.policy?.enabled?(inboxSummary.policy.aiFallback?'已交回知識庫／AI；下一則來訊先比對 FAQ，再按已儲存政策處理；舊訊息及草稿不會補發。':'已交回知識庫；下一則來訊先核對已確認答案，沒有答案便提示你。'):'已交回 AI，下一則來訊才開始新的處理。');}));
    find('[data-customer-reply-form]').addEventListener('submit',event=>{event.preventDefault();const id=selectedCustomerId,field=event.currentTarget.elements.text,text=field.value.trim();run(event.submitter,async()=>{if(!activeCustomerContext(id)||!text)throw new Error('請先等待這段對話讀取完成，再核對及發送回覆。');const c=currentCustomerData.conversation;if(c.channel==='whatsapp_self_test'){if(!selfReplySettings().available||!selfReplyContext().eligible)throw new Error('請先開啟本人回覆測試，並在手機再傳一則新的 Hello。');if(selfReplyOperations.has(id))throw new Error('上次提交結果尚未核對，暫不再次送出。');const input={text,operationId:crypto.randomUUID(),expectedVersion:c.version};selfReplyOperations.set(id,{...input,status:'submitting'});paintSelfReply();try{const result=await backend.manualSelfTestReply(id,input);if(result.operationId!==input.operationId||!result.messageId)throw new Error('未能核對本人回覆的提交結果；不會自動重送。');selfReplyOperations.delete(id);if(replyDrafts.get(id)?.trim()===text)replyDrafts.delete(id);if(id===selectedCustomerId&&field.value.trim()===text)field.value='';customerNotice('本人測試回覆已保存並排隊，尚未確認送達；此對話已轉人工測試。');}catch(error){if([400,409].includes(error.status))selfReplyOperations.delete(id);else{const operation=selfReplyOperations.get(id);if(operation)operation.status='unknown';}throw error;}finally{await refreshCustomers();paintSelfReply();}return;}try{await backend.manualReply(id,text);replyDrafts.delete(id);if(id===selectedCustomerId)field.value='';customerNotice('人工回覆已排隊，請核對渠道的實際送達結果。');}finally{await refreshCustomers();}});});
    const inboxPollTimer=setInterval(()=>{if(!root.isConnected){clearInterval(inboxPollTimer);inboxEventStream?.close();inboxEventStream=null;return;}if(live&&!busy&&!document.hidden)refreshCustomers().catch(()=>{});},1000);
    let autoReceivePolling=false;
    const autoReceiveTimer=setInterval(async()=>{
      if(!root.isConnected){clearInterval(autoReceiveTimer);return;}
      if(!live||busy||document.hidden||whatsappLink.active||autoReceivePolling||snapshot.connections.whatsapp?.autoReceiveOnConnect!==true)return;
      autoReceivePolling=true;const previousConnections=snapshot.connections;
      try{const latest=await backend.load(),wa=latest?.connections?.whatsapp;if(busy||whatsappLink.active||!root.isConnected||snapshot.connections!==previousConnections||!wa||wa.autoReceiveOnConnect!==true)return;
        if(JSON.stringify(snapshot.connections.whatsapp)!==JSON.stringify(wa)){snapshot.connections=latest.connections;inboxScope=wa.inboxScope||null;paintConnection();paintManagement();paintInboxReceiveState();paintWhatsAppLink();if(currentCustomerData)paintCustomerDetail(currentCustomerData);else paintEmptyInbox();}
      }catch{if(root.isConnected&&!busy&&snapshot.connections===previousConnections){const wa=snapshot.connections.whatsapp;snapshot.connections={...snapshot.connections,whatsapp:{...wa,status:'unknown',checkedAt:null,receiveEnabled:false,autoReceiveStatus:'status_unknown',readiness:{...wa.readiness,canSend:false}}};paintConnection();paintManagement();paintInboxReceiveState();paintWhatsAppLink();if(currentCustomerData)paintCustomerDetail(currentCustomerData);else paintEmptyInbox();}}finally{autoReceivePolling=false;}
    },3000);
    window.addEventListener('pagehide',()=>{clearInterval(inboxPollTimer);clearInterval(autoReceiveTimer);},{once:true});
    all('[data-tab]').forEach(button=>button.addEventListener('click',()=>{state.tab=button.dataset.tab;state.contextOpen=false;render();remember();if(state.tab==='basic')refreshCustomers().catch(()=>{});if(state.tab==='training'){refreshFaq().catch(()=>{find('[data-inbox-faq-count]').textContent='知識庫未能更新，請稍後重試。';});refreshLearning().catch(()=>{});}if(state.tab==='connect'){paintManagement();paintGuide();}}));
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
    find('[data-native-provider]').addEventListener('change',changeNativeProvider);
    find('[data-native-guide]').addEventListener('click',prepareNativeGuideDraft);
    find('[data-native-codex-form]').addEventListener('submit',event=>{event.preventDefault();const f=event.currentTarget;run(event.submitter,async()=>{if(f.elements.provider.value!=='codex')throw new Error('此助手的本機接駁尚未提供。可先整理本機登入指引。');if(!live||snapshot.connections.ai.nativeAvailable!==true)throw new Error('此客服執行器尚未提供本機 Codex 路線。');if(!f.elements.consent.checked)throw new Error('請先同意沿用本機 ChatGPT 登入及帳戶額度。');find('[data-native-result]').textContent='正在檢查本機登入及合成推理，尚未啟用 AI 草稿或發送…';paintBackgroundAI();try{const result=await backend.nativeCodex({consent:true});f.elements.consent.checked=false;await refresh();find('[data-native-result]').textContent=result.message||'本機 Codex 已通過實際推理檢查；回覆政策沒有自動更改。';report(find('[data-native-result]').textContent);}catch(error){await refresh().catch(()=>{});find('[data-native-result]').textContent=error.message||'本機 Codex 檢查未完成；請核對本機登入及可用額度。';throw error;}});});
    find('[data-native-disconnect]').addEventListener('click',event=>run(event.currentTarget,async()=>{if(snapshot.connections.ai.provider!=='codex-cli')throw new Error('目前已不是本機 Codex 接駁，請先核對狀態。');await backend.clearAI();clearAiPolicyChoices();await refresh();find('[data-native-result]').textContent='本機 Codex 已停用；AI 後備及 AI 自動發送已關閉，FAQ 設定保留。';report(find('[data-native-result]').textContent);}));
    find('[data-model-provider]').addEventListener('change',paintModelProvider);
    find('[data-model-choice]').addEventListener('change',changeModelChoice);
    find('[data-model-form]').elements.model.addEventListener('input',()=>{if(modelChoiceValue==='custom')modelCustomDraft=find('[data-model-form]').elements.model.value;});
    find('[data-ai-guide]').addEventListener('click',prepareModelGuideDraft);
    find('[data-model-form]').addEventListener('submit',event=>{event.preventDefault();const f=event.currentTarget;run(event.submitter,async()=>{if(f.elements.provider.value!=='openai')throw new Error('尚未支援此供應商接駁。可先請 Codex／DOT 整理指引。');if(!f.elements.model.value.trim())throw new Error('請先選擇模型，或填寫模型名稱。');const key=f.elements.apiKey.value;f.elements.apiKey.value='';find('[data-ai-result]').textContent='正在測試連線及模型回覆…';try{const result=await backend.model({model:f.elements.model.value,apiKey:key});find('[data-ai-result]').textContent=result.message;await refresh();report(result.message);}catch(e){find('[data-ai-result]').textContent=e.message;throw e;}});});
    find('[data-disconnect-ai]').addEventListener('click',event=>run(event.currentTarget,async()=>{if(snapshot.connections.ai.provider==='codex-cli')throw new Error('請使用「停用本機 Codex 接駁」處理目前路線。');await backend.clearAI();clearAiPolicyChoices();await refresh();find('[data-ai-result]').textContent='模型 API 已清除；AI 後備及 AI 自動發送已關閉，FAQ 設定保留。';report(find('[data-ai-result]').textContent);}));
    let whatsappQrTimer=null,whatsappQrGeneration=0;
    function clearWhatsAppQr(){
      clearTimeout(whatsappQrTimer);whatsappQrTimer=null;whatsappQrGeneration++;
      find('[data-qr-box]').hidden=true;
      find('[data-qr-image]').replaceChildren();
    }
    function syncWhatsAppQr(result){
      if(result.status!=='connecting'||result.qrAvailable===false)clearWhatsAppQr();
    }
    function showWhatsAppQr(result){
      clearWhatsAppQr();
      if(!result.qr||result.qrAvailable===false||result.qrExpiresInMs===0||result.status!=='connecting')return;
      const img=document.createElement('img');img.src=result.qr;img.alt='WhatsApp 裝置連結二維碼';
      find('[data-qr-image]').append(img);find('[data-qr-box]').hidden=false;
      const expires=result.qrExpiresInMs,generation=whatsappQrGeneration;
      if(Number.isInteger(expires)&&expires>0&&expires<=20000)whatsappQrTimer=setTimeout(()=>{
        if(generation!==whatsappQrGeneration)return;
        clearWhatsAppQr();find('[data-wa-result]').textContent='二維碼已失效，請重新取得並使用新碼。';
      },expires);
    }
    // WhatsApp linear connection flow
    function paintWhatsAppLink(){
      const wa=snapshot.connections.whatsapp||{},phone=phoneConnectionState(wa),autoReady=wa.autoReceiveOnConnect===true&&inboxReceiveInfo().active;
      if(whatsappLink.phase==='connected'&&phone.tone!=='open'&&!(wa.autoReceiveOnConnect===true&&['preparing','status_unknown'].includes(wa.autoReceiveStatus))){whatsappLink.phase='idle';whatsappLink.message='手機狀態已改變，請重新核對接駁。';}
      const phase=whatsappLink.phase;
      const stages={idle:0,preparing:0,waiting:1,checking:2,connected:3,error:whatsappLink.failedStage||0,cancelled:0},current=stages[phase]??0;
      find('[data-wa-link-flow]').dataset.waLinkPhase=phase;
      all('[data-wa-link-stage]').forEach(node=>{const step=Number(node.dataset.waLinkStage);node.dataset.complete=String(step<current||phase==='connected');if(step===current)node.setAttribute('aria-current','step');else node.removeAttribute('aria-current');});
      find('[data-wa-link-title]').textContent=phase==='connected'&&wa.autoReceiveOnConnect===true&&!autoReady?(wa.autoReceiveStatus==='status_unknown'?'連線狀態未能讀取':wa.autoReceiveStatus==='error'?'收件準備未完成':wa.autoReceiveStatus==='account_changed'?'帳戶待核對':'正在準備接收訊息'):{idle:'準備接駁 WhatsApp',preparing:'正在準備接駁',waiting:'請用本人手機掃碼',checking:'正在確認手機連線',connected:'手機已接駁',error:'接駁未完成',cancelled:'已停止等候'}[phase]||'準備接駁 WhatsApp';
      find('[data-wa-link-status]').textContent=phase==='connected'&&wa.autoReceiveOnConnect===true?(autoReady?'已接駁手機並準備接收新私人文字。':wa.autoReceiveStatus==='error'?'手機已連結，但收件準備未完成。請返回渠道接駁後重試。':wa.autoReceiveStatus==='account_changed'?'手機帳戶需要重新核對。':wa.autoReceiveStatus==='status_unknown'?'工作台暫時未能讀取狀態，請檢查服務並重新登入。':'手機已連結，正在準備接收新私人文字。'):whatsappLink.message||'按「接駁 WhatsApp」後會自動準備，請保留這個頁面。';
      const number=find('[data-wa-link-phone]');number.hidden=phase!=='connected'||!phone.number;number.textContent=phase==='connected'?phone.number:'';
      find('[data-wa-link-scan-help]').hidden=phase!=='waiting';
      find('[data-wa-link-retry]').hidden=!['idle','error','cancelled'].includes(phase);find('[data-wa-link-retry]').disabled=whatsappLink.active;
      find('[data-wa-link-cancel]').hidden=!whatsappLink.active;
      find('[data-whatsapp-form]').querySelectorAll('button').forEach(button=>button.disabled=whatsappLink.active);
      find('[data-service-check]').disabled=whatsappLink.active;find('[data-prepare-setup="whatsapp"]').disabled=whatsappLink.active;
    }
    function setWhatsAppLinkPhase(phase,message){whatsappLink.phase=phase;whatsappLink.message=message;paintWhatsAppLink();paintGuide();}
    function stopWhatsAppLink(){
      if(!whatsappLink.active)return;
      whatsappLink.active=false;whatsappLink.epoch++;clearTimeout(whatsappLink.timer);whatsappLink.timer=null;clearWhatsAppQr();
      delete whatsappLink.args.apiKey;if(whatsappLink.manualArgs)delete whatsappLink.manualArgs.apiKey;whatsappLink.manualArgs=null;
      setWhatsAppLinkPhase('cancelled','本頁已停止等候。已開始的本機準備及手機授權會保留；按重試可重新核對。');
    }
    function whatsAppLinkCurrent(epoch){if(whatsappLink.active&&epoch===whatsappLink.epoch&&(!root.isConnected||guideFlow!=='whatsapp'||state.screen!=='config'||state.tab!=='connect'||state.managementSection!=='channels'||setupTaskFlow)){stopWhatsAppLink();return false;}return whatsappLink.active&&epoch===whatsappLink.epoch;}
    function failWhatsAppLink(error,epoch){
      if(!whatsAppLinkCurrent(epoch))return;
      whatsappLink.failedStage=whatsappLink.phase==='preparing'?0:whatsappLink.phase==='waiting'?1:2;
      whatsappLink.active=false;clearTimeout(whatsappLink.timer);whatsappLink.timer=null;clearWhatsAppQr();
      delete whatsappLink.args.apiKey;if(whatsappLink.manualArgs)delete whatsappLink.manualArgs.apiKey;whatsappLink.manualArgs=null;
      setWhatsAppLinkPhase('error',error?.message||'接駁未完成。請核對網絡及服務，再按重試。');
    }
    function scheduleWhatsAppLink(task,epoch,delay=2000){
      clearTimeout(whatsappLink.timer);whatsappLink.timer=setTimeout(async()=>{
        if(!whatsAppLinkCurrent(epoch))return;
        if(busy){scheduleWhatsAppLink(task,epoch,delay);return;}
        try{await task(epoch);}catch(error){failWhatsAppLink(error,epoch);}
      },delay);
    }
    async function readWhatsAppLinkState(epoch){
      const latest=await backend.load();if(!whatsAppLinkCurrent(epoch))return null;
      snapshot=latest;paintData(false);return snapshot.connections.whatsapp||{};
    }
    async function finishWhatsAppLink(epoch){
      const wa=await readWhatsAppLinkState(epoch);if(!wa)return false;
      if(phoneConnectionState(wa).tone!=='open')return false;
      whatsappLink.active=false;clearTimeout(whatsappLink.timer);whatsappLink.timer=null;clearWhatsAppQr();
      setWhatsAppLinkPhase('connected',typeof wa.linkedPhone==='string'&&/^\d{8,15}$/.test(wa.linkedPhone)?'已從接駁服務核對手機及連結號碼。':'手機連線已核對，服務尚未提供可確認的電話號碼。');
      report(wa.autoReceiveOnConnect===true?(inboxReceiveInfo().active?'WhatsApp 手機已接駁，已準備接收新私人文字。':'WhatsApp 手機已接駁，正在準備接收新私人文字。'):'WhatsApp 手機已接駁。訊息接收及回覆保持原有獨立授權。');return true;
    }
    async function fetchWhatsAppLinkQr(epoch,readOnly=false){
      const args=whatsappLink.args;
      let result;try{result=await(readOnly?backend.getWhatsAppQr():backend.whatsapp(args));}finally{delete args.apiKey;if(epoch===whatsappLink.epoch)whatsappLink.manualArgs=null;}if(!whatsAppLinkCurrent(epoch))return;
      showWhatsAppQr(result);whatsappLink.qrUntil=result.qr&&Number.isInteger(result.qrExpiresInMs)?Date.now()+result.qrExpiresInMs:0;
      find('[data-wa-result]').textContent=snapshot.connections.whatsapp?.autoReceiveOnConnect===true?'手機連結後會自動準備接收新私人文字，並按已儲存的知識庫／AI政策回覆。':'手機連結不會自動開啟收件、回覆或 AI。';
      if(result.status==='open')setWhatsAppLinkPhase('checking','已取得手機連線回應，正在核對目前帳戶。');
      else if(result.status==='connecting')setWhatsAppLinkPhase(!find('[data-qr-box]').hidden?'waiting':'checking',!find('[data-qr-box]').hidden?'用本人手機掃描二維碼；完成後會自動核對。':'正在等候手機連線。已有有效授權時毋須重新掃碼。');
      else throw new Error(result.message||'接駁服務未能開始手機連線，請核對後重試。');
      scheduleWhatsAppLink(pollWhatsAppLink,epoch);
    }
    async function pollWhatsAppLink(epoch){
      if(Date.now()-whatsappLink.startedAt>180000)throw new Error('等候手機連線已逾時。手機授權會保留，請按重試重新核對。');
      const result=await backend.checkWhatsApp();if(!whatsAppLinkCurrent(epoch))return;
      syncWhatsAppQr(result);
      if(result.status==='open'){
        setWhatsAppLinkPhase('checking','已偵測到手機連線，正在讀回核對。');
        if(await finishWhatsAppLink(epoch))return;
        throw new Error('服務回報已連線，但目前狀態未能讀回確認。請重試核對。');
      }
      if(['close','closed','error'].includes(result.status)||['logged_out','account_not_available','credential_save_failed'].includes(result.lastReason))throw new Error(result.message||'手機連線已停止，請核對後重試。');
      if(!await readWhatsAppLinkState(epoch))return;
      const hasQr=!find('[data-qr-box]').hidden;
      if((whatsappLink.local||snapshot.connections.whatsapp?.localTest===true)&&typeof backend.getWhatsAppQr==='function'&&result.status==='connecting'&&(!hasQr||whatsappLink.qrUntil&&Date.now()>=whatsappLink.qrUntil)){
        // Refresh reads the current QR only: a close between checks must never start another socket.
        await fetchWhatsAppLinkQr(epoch,true);return;
      }
      if(!hasQr)setWhatsAppLinkPhase('checking','正在等候手機確認。若需要新二維碼，可停止等候後重試。');
      scheduleWhatsAppLink(pollWhatsAppLink,epoch);
    }
    async function connectPreparedWhatsApp(epoch){
      const wa=await readWhatsAppLinkState(epoch);if(!wa)return;
      whatsappLink.args=whatsappLink.manualArgs||{...(wa.url?{url:wa.url}:{}),...(wa.instance?{instance:wa.instance}:{})};
      if(!whatsappLink.manualArgs&&wa.url&&wa.instance){
        const result=await backend.checkWhatsApp();if(!whatsAppLinkCurrent(epoch))return;
        if(result.status==='open'){
          setWhatsAppLinkPhase('checking','正在核對現有手機授權。');if(await finishWhatsAppLink(epoch))return;
          throw new Error('服務回報已連線，但目前狀態未能讀回確認。請重試核對；沒有重新開始連線。');
        }
        if(!await readWhatsAppLinkState(epoch))return;
      }
      whatsappLink.startedAt=Date.now();await fetchWhatsAppLinkQr(epoch);
    }
    async function pollWhatsAppPreparation(epoch){
      if(Date.now()-whatsappLink.preparationAt>600000)throw new Error('本機準備仍未完成，已停止本頁等候。可稍後按重試讀回進度，不會重複安裝。');
      const result=await backend.getWhatsAppLocal();if(!whatsAppLinkCurrent(epoch))return;
      if(result.status==='ready'){whatsappLink.local=true;await connectPreparedWhatsApp(epoch);return;}
      if(result.status==='error')throw new Error(result.message||'本機接駁服務準備未完成，請重試。');
      if(!['preparing','unconfigured'].includes(result.status))throw new Error('未能確認本機準備進度，請重試核對。');
      setWhatsAppLinkPhase('preparing',result.message||'正在準備本機接駁服務，首次準備可能需要幾分鐘。');scheduleWhatsAppLink(pollWhatsAppPreparation,epoch,3000);
    }
    async function startWhatsAppLink(manualArgs=null){
      if(whatsappLink.active)return;
      if(!live){setWhatsAppLinkPhase('error','此設計預覽沒有連接客服後台，未有啟動手機接駁。');return;}
      const epoch=++whatsappLink.epoch;whatsappLink.active=true;whatsappLink.manualArgs=manualArgs;whatsappLink.local=false;whatsappLink.qrUntil=0;whatsappLink.startedAt=Date.now();whatsappLink.preparationAt=Date.now();clearWhatsAppQr();
      setWhatsAppLinkPhase('preparing','正在核對接駁服務及現有手機授權。');
      try{
        const wa=snapshot.connections.whatsapp||{};
        const mayPrepare=wa.localPreparationAvailable!==false&&(!wa.url||wa.localPreparationAvailable===true);
        if(!manualArgs&&!wa.url&&wa.localPreparationAvailable===false)throw new Error('此環境未提供一鍵準備接駁服務。請在進階設定使用現有服務，或請安裝人員準備。');
        if(!manualArgs&&typeof backend.prepareWhatsAppLocal==='function'&&mayPrepare){
          let result;
          try{result=await backend.prepareWhatsAppLocal();}catch(error){if([404,405,501].includes(error.status)){if(!wa.url)throw new Error('此環境未提供一鍵準備接駁服務。請在進階設定使用現有服務，或請安裝人員準備。');}else throw error;}
          if(!whatsAppLinkCurrent(epoch))return;
          if(result){if(result.status==='error')throw new Error(result.message||'本機準備未完成。');if(result.status!=='ready'){setWhatsAppLinkPhase('preparing',result.message||'正在準備本機接駁服務，首次準備可能需要幾分鐘。');scheduleWhatsAppLink(pollWhatsAppPreparation,epoch,1000);return;}whatsappLink.local=true;}
        }
        if(!manualArgs&&!wa.url&&typeof backend.prepareWhatsAppLocal!=='function')throw new Error('此環境尚未提供一鍵準備接駁服務。請在進階設定填入現有服務，或請安裝人員準備。');
        await connectPreparedWhatsApp(epoch);
      }catch(error){failWhatsAppLink(error,epoch);}
    }
    // End WhatsApp linear connection flow
    async function requestWhatsAppQr(form){
      if(whatsappLink.active)return;
      clearWhatsAppQr();
      const args=Object.fromEntries(new FormData(form));form.elements.apiKey.value='';
      if(!args.url?.trim()||!args.instance?.trim()){form.querySelector('details').open=true;throw new Error('請填寫現有接駁服務網址及連線名稱，或直接使用一鍵接駁。');}
      await startWhatsAppLink(args);
    }
    async function checkWhatsAppConnection(){
      try{const result=await backend.checkWhatsApp();find('[data-wa-result]').textContent=result.message;syncWhatsAppQr(result);report(result.message);}
      catch(error){clearWhatsAppQr();find('[data-wa-result]').textContent=error.message;throw error;}
      finally{await refresh();}
    }
    find('[data-whatsapp-form]').addEventListener('submit',event=>{event.preventDefault();const form=event.currentTarget;run(event.submitter,()=>requestWhatsAppQr(form));});
    find('[data-wa-check]').addEventListener('click',event=>run(event.currentTarget,checkWhatsAppConnection));
    find('[data-wa-clear]').addEventListener('click',event=>run(event.currentTarget,async()=>{stopWhatsAppLink();clearWhatsAppQr();await backend.clearWhatsApp();await refresh();setWhatsAppLinkPhase('idle','已清除本機接駁資料，可重新開始。');report('已清除本機接駁資料。如要移除手機裝置，請在 WhatsApp 的「已連結裝置」處理。');}));
    for(const [selector,method] of [['[data-webhook-register]','registerWebhook'],['[data-webhook-check]','checkWebhook']])find(selector).addEventListener('click',event=>run(event.currentTarget,async()=>{try{const result=await backend[method]();find('[data-wa-result]').textContent=result.message;report(result.message);}finally{await refresh();}}));
    all('[data-management-tab]').forEach(button=>button.addEventListener('click',()=>openManagementSection(button.dataset.managementTab)));
    all('[data-start-guide]').forEach(button=>button.addEventListener('click',()=>{openConnectionGuide(button.dataset.startGuide);if(button.dataset.startGuide==='whatsapp')startWhatsAppLink();}));
    find('[data-wa-link-retry]').addEventListener('click',()=>startWhatsAppLink());
    find('[data-wa-link-cancel]').addEventListener('click',stopWhatsAppLink);
    window.addEventListener('pagehide',stopWhatsAppLink,{once:true});
    all('[data-guide-jump]').forEach(button=>button.addEventListener('click',()=>openConnectionGuide(guideFlow,Number(button.dataset.guideJump))));
    find('[data-service-check]').addEventListener('click',event=>run(event.currentTarget,checkWhatsAppConnection));
    find('[data-setup-task-close]').addEventListener('click',()=>{setupTaskFlow=null;paintGuide();find('[data-management-content]').scrollTop=0;find('[data-guide-title]').focus({preventScroll:true});});
    find('[data-guide-close]').addEventListener('click',closeGuide);
    find('[data-guide-back]').addEventListener('click',()=>{guideStep=Math.max(0,guideStep-1);paintGuide();find('[data-management-content]').scrollTop=0;find('[data-guide-title]').focus({preventScroll:true});});
    find('[data-guide-next]').addEventListener('click',()=>{if(guideStep===3){closeGuide();report('教學已閱讀。接駁狀態仍會按實際連線及收發結果顯示。');}else{guideStep++;paintGuide();find('[data-management-content]').scrollTop=0;find('[data-guide-title]').focus({preventScroll:true});}});
    find('[data-guide-refresh]').addEventListener('click',event=>run(event.currentTarget,async()=>{await refresh();report('已更新接駁狀態。');}));
    find('[data-copy-web-url]').addEventListener('click',event=>run(event.currentTarget,async()=>{const field=find('[data-web-chat-url]');if(!field.value)throw new Error('請先準備網頁客服。');try{await navigator.clipboard.writeText(field.value);report('聊天網址已複製。');}catch{field.focus();field.select();report('請複製已選取的聊天網址。');}}));
    all('[data-prepare-setup]').forEach(button=>button.addEventListener('click',event=>run(event.currentTarget,async()=>{
      if(!live){report('客服後台尚未接駁，現在不能準備安裝指引任務。',true);return;}
      const flow=button.dataset.prepareSetup;
      const instruction=flow==='whatsapp'?'請為 BlueSAI-客服的 WhatsApp 接駁整理可核對的安裝步驟草稿。列出如何核對目前客服執行器、現有主機和 Evolution 服務，說明所需安全設定及收件網址，讓我之後回到接駁教學取得二維碼並自行用手機掃碼。列明保留資料、金鑰安全入口、費用確認、收件範圍及實際收發核對步驟。這次只整理指引，不購買、部署、設定帳戶或向客戶發送。':'請為 BlueSAI-客服的網頁聊天整理可核對的安裝步驟草稿。說明如何沿用現有主機及同一客服核心，列出經用戶核准後啟用受限客人入口、取得 HTTPS 網址及加入網頁按鈕的步驟。列明會話隔離、草稿批准、客人收件及管理工作台讀回的驗收。這次只整理指引，不購買、部署或更改網站；本機網址不能當成公開入口。';
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
      setupTaskFlow=flow;state.managementSection='channels';guideFlow=flow;paintGuide();await refreshTasks();find('[data-dot-prompt-details]').open=true;find('[data-management-content]').scrollTop=0;find('[data-guide-title]').focus({preventScroll:true});report('安裝指引任務已準備。請在目前接駁流程檢查內容，再按「呼叫 Codex／DOT」整理步驟草稿；尚未執行安裝。');
    })));
    find('[data-whatsapp-form]').noValidate=true;
    if(live){all('[data-secret]').forEach(x=>{x.disabled=false;x.placeholder='在本機安全輸入，毋須貼到聊天';});find('[data-model-submit]').textContent='測試並接駁 AI';find('[data-key-help]').textContent='只在你按下接駁時提交；不會顯示已儲存金鑰。';report('從收件匣選擇對話；渠道與回覆規則在「管理」處理。');}else{find('[data-model-form]').noValidate=true;find('[data-whatsapp-form]').noValidate=true;}
    try{await refresh(true);setupAgentBridge();setupInboxTools();}catch(e){report(e.message,true);}

    if(globalThis.Tweak){const tweak=new Tweak({container:find('.bp-agent-card'),onChange:()=>{render();remember();}});tweak.addToggle(state,'showNumber',{label:'顯示 Agent 編號'});tweak.addSlider(state,'cardPadding',{label:'卡片留白',min:18,max:30,step:2,unit:'px'});}
  })();
  