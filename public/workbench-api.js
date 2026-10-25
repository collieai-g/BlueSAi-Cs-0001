(() => {
  const BASE='/api/agents/bluesai-cs-0001';
  const login=document.querySelector('[data-local-login]'),surface=document.getElementById('cs-card-design');
  if(!surface)return;
  async function api(path,method='GET',data){
    const response=await fetch(BASE+path,{method,credentials:'same-origin',headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined});
    const result=await response.json();
    if(response.status===401){surface.hidden=true;if(login)login.hidden=false;}
    if(!response.ok){const error=new Error(result.error||'操作未完成。');error.status=response.status;throw error;}
    if(method!=='GET'&&method!=='HEAD'){
      // Only a change signal crosses tabs; never persist task text or credentials.
      try{localStorage.setItem('bluesai-workbench-change',Date.now()+'-'+Math.random());}catch{}
      window.dispatchEvent(new Event('bluesai-workbench-change'));
    }
    return result;
  }
  surface.csBackend={
    async load(){const result=await api('/state');surface.hidden=false;if(login)login.hidden=true;return result;},
    saveProfile:(profile,settings)=>api('/profile','PUT',{profile,settings}),
    train:text=>api('/training','POST',{text}),
    memory:(id,action,content,category)=>api('/knowledge/'+encodeURIComponent(id),action==='delete'?'DELETE':action==='edit'?'PUT':'POST',action==='edit'?{content,category}:{}),
    reply:(text,history)=>api('/trial','POST',{text,history:history.slice(-24)}),
    model:input=>api('/connections/model','POST',input),
    clearAI:()=>api('/connections/model','DELETE'),
    whatsapp:input=>api('/connections/whatsapp','POST',input),
    checkWhatsApp:()=>api('/connections/whatsapp-check','POST',{}),
    registerWebhook:()=>api('/connections/whatsapp-webhook','POST',{}),
    checkWebhook:()=>api('/connections/whatsapp-webhook-check','POST',{}),
    configureTestRecipient:input=>api('/connections/whatsapp-test-recipients','POST',input),
    clearWhatsApp:()=>api('/connections/whatsapp','DELETE'),
    conversations:()=>api('/conversations'),
    conversation:id=>api('/conversations/'+encodeURIComponent(id)),
    takeover:id=>api('/conversations/'+encodeURIComponent(id)+'/takeover','POST',{}),
    resume:id=>api('/conversations/'+encodeURIComponent(id)+'/resume','POST',{}),
    manualReply:(id,text)=>api('/conversations/'+encodeURIComponent(id)+'/reply','POST',{text}),
    approveReply:(id,text)=>api('/messages/'+encodeURIComponent(id)+'/approve','POST',{text}),
    dotTasks:()=>api('/dot/tasks'),
    dotTask:id=>api('/dot/tasks/'+encodeURIComponent(id)),
    createDotTask:input=>api('/dot/tasks','POST',input),
    updateDotTask:(id,input)=>api('/dot/tasks/'+encodeURIComponent(id),'PUT',input),
  };
  document.querySelector('[data-local-login-form]')?.addEventListener('submit',async event=>{
    event.preventDefault();const field=event.currentTarget.elements.token,button=event.submitter;button.disabled=true;
    try{const token=field.value;field.value='';await api('/login','POST',{token});location.reload();}
    catch(error){document.querySelector('[data-login-error]').textContent=error.message;}
    finally{button.disabled=false;}
  });
})();
