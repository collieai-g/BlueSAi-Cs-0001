(() => {
  const form = document.getElementById('message-form'), field = document.getElementById('message');
  const button = form.querySelector('button'), notice = document.getElementById('notice'), list = document.getElementById('messages');
  let version = 0, busy = false, polling = false, ready = false, pending = null, signature = '';
  async function api(path, method = 'GET', data) {
    const response = await fetch('/chat/api/' + path, { method, credentials: 'same-origin',
      headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || '未能完成，請再試。'), { status: response.status });
    return result;
  }
  async function refresh() {
    if (polling) return;
    polling = true;
    try {
      const result = await api('messages'); version = result.version;
      const next = JSON.stringify(result.messages);
      if (next !== signature) {
        signature = next;
        const items = result.messages.map(message => {
          const item = document.createElement('li'), speaker = document.createElement('span'), text = document.createElement('span');
          item.className = message.role; speaker.className = 'speaker'; speaker.textContent = message.role === 'user' ? '你' : '客服';
          text.textContent = message.text; item.append(speaker, text); return item;
        });
        list.replaceChildren(...items);
      }
      const messageIds = result.messages.filter(message => message.role === 'assistant' && message.status === 'accepted').map(message => message.id);
      if (messageIds.length) await api('ack', 'POST', { messageIds: messageIds.slice(-100) });
      if (!busy) notice.textContent = result.conversation?.state === 'waiting' || result.conversation?.state === 'human' ? '已交由人工跟進，回覆會顯示在這裡。' : result.messages.length ? '訊息已保存。等待客服回覆。' : '會話已準備好，請輸入你的問題。';
    } finally { polling = false; }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !ready || !field.value.trim()) return;
    busy = true; button.disabled = true;
    const text = field.value.trim();
    // Keep the same key after an interrupted response. A deliberate content
    // change becomes a new message only after the previous request is resolved.
    if (!pending || pending.text !== text) pending = { text, idempotencyKey: crypto.randomUUID(), expectedVersion: version };
    try {
      await api('messages', 'POST', pending); pending = null; field.value = ''; await refresh();
      notice.textContent = '訊息已保存。等待客服回覆。'; field.focus();
    } catch (error) {
      notice.textContent = error.message;
      if (error.status === 409) { pending = null; await refresh().catch(() => {}); notice.textContent = '會話已更新，請再按傳送。'; }
      if (error.status === 401 || error.status === 404) ready = false;
    } finally { busy = false; button.disabled = !ready; }
  });
  (async () => {
    try { const result = await api('session', 'POST', {}); version = result.version; ready = true; button.disabled = false; await refresh(); }
    catch (error) { notice.textContent = error.message; }
  })();
  setInterval(() => { if (ready && !busy && !document.hidden) refresh().catch(error => { notice.textContent = error.message; }); }, 2500);
})();
