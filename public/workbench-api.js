(() => {
  const login=document.querySelector('[data-local-login]'),surface=document.getElementById('cs-card-design');
  async function api(path,method='GET',data){
    const response=await fetch(path,{method,credentials:'same-origin',headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined});
    const result=await response.json();
    if(response.status===401){surface.hidden=true;login.hidden=false;}
    if(!response.ok){const error=new Error(result.error||'操作未完成。');error.status=response.status;throw error;}
    if(method!=='GET'&&method!=='HEAD'){
      // Only a change signal crosses tabs; never persist task text or credentials.
      try{localStorage.setItem('bluesai-workbench-change',Date.now()+'-'+Math.random());}catch{}
      window.dispatchEvent(new Event('bluesai-workbench-change'));
    }
    return result;
  }
  window.csBackend={
    async load(){const result=await api('/api/workbench');surface.hidden=false;login.hidden=true;return result;},
    saveProfile:(profile,settings)=>api('/api/workbench/profile','PUT',{profile,settings}),
    train:text=>api('/api/workbench/training','POST',{text}),
    memory:(id,action,content,category)=>api('/api/knowledge/'+encodeURIComponent(id),action==='delete'?'DELETE':action==='edit'?'PUT':'POST',action==='edit'?{content,category}:{}),
    reply:(text,history)=>api('/api/workbench/trial','POST',{text,history:history.slice(-24)}),
    model:input=>api('/api/workbench/connections/model','POST',input),
    clearAI:()=>api('/api/workbench/connections/model','DELETE'),
    whatsapp:input=>api('/api/workbench/connections/whatsapp','POST',input),
    checkWhatsApp:()=>api('/api/workbench/connections/whatsapp-check','POST',{}),
    clearWhatsApp:()=>api('/api/workbench/connections/whatsapp','DELETE'),
    dotTasks:()=>api('/api/workbench/dot/tasks'),
    dotTask:id=>api('/api/workbench/dot/tasks/'+encodeURIComponent(id)),
    createDotTask:input=>api('/api/workbench/dot/tasks','POST',input),
    updateDotTask:(id,input)=>api('/api/workbench/dot/tasks/'+encodeURIComponent(id),'PUT',input),
  };
  document.querySelector('[data-local-login-form]').addEventListener('submit',async event=>{
    event.preventDefault();const field=event.currentTarget.elements.token,button=event.submitter;button.disabled=true;
    try{const token=field.value;field.value='';await api('/api/login','POST',{token});location.reload();}
    catch(error){document.querySelector('[data-login-error]').textContent=error.message;}
    finally{button.disabled=false;}
  });
})();
