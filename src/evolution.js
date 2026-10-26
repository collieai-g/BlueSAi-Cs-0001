export function normalizeEvent(payload, instance, now = Date.now()) {
  if (payload?.instance !== instance) throw new Error('INSTANCE_MISMATCH');
  const event = String(payload.event || '').toLowerCase().replaceAll('_', '.');
  if (payload.data?.localSelfTest === true && event !== 'messages.upsert') return { kind: 'ignore', reason: 'self_test_unsupported_event' };
  if (event === 'messages.set') return { kind: 'ignore', reason: 'history' };
  if (event === 'messages.update') {
    // Evolution emits provider acknowledgements with keyId, not its database id.
    const items = Array.isArray(payload.data) ? payload.data : [payload.data];
    if (!items.length || items.length > 100) throw new Error('INVALID_RECEIPT');
    const states = { SERVER_ACK: 'accepted', SENT: 'accepted', DELIVERY_ACK: 'delivered', DELIVERED: 'delivered', READ: 'read', PLAYED: 'read', ERROR: 'failed', FAILED: 'failed' };
    const receipts = [];
    for (const data of items) {
      if (!data || typeof data !== 'object') throw new Error('INVALID_RECEIPT');
      const providerId = data.keyId, address = data.remoteJid;
      if (typeof providerId !== 'string' || !providerId || providerId.length > 300 || typeof address !== 'string') throw new Error('INVALID_RECEIPT');
      if(data.localSelfReply!==undefined&&typeof data.localSelfReply!=='boolean')throw new Error('INVALID_RECEIPT');
      if (data.fromMe !== true || !/^\d{5,20}@s\.whatsapp\.net$/.test(address)) continue;
      const status = states[data.status];
      if (status) receipts.push({ instance, providerId, address, status,...(data.localSelfReply===true?{selfTest:true}:{}) });
    }
    return { kind: 'receipt', receipts };
  }
  if (event !== 'messages.upsert') return { kind: 'ignore', reason: 'unsupported_event' };
  const data = payload.data;
  if (!data || Array.isArray(data) || !data.key || typeof data.key.id !== 'string' || !data.key.id || data.key.id.length > 300 || typeof data.key.fromMe !== 'boolean') throw new Error('INVALID_EVENT');
  const address = data.key.remoteJid;
  // LID-only addresses require explicit alias resolution, not suffix guessing.
  if (typeof address !== 'string' || !/^\d{5,20}@s\.whatsapp\.net$/.test(address)) return { kind: 'ignore', reason: 'unsupported_address' };
  const seconds = Number(data.messageTimestamp);
  const timestamp = seconds * 1000;
  const stale = !Number.isFinite(timestamp) || timestamp > now + 60000 || timestamp < now - 5 * 60000;
  const content = data.message?.conversation ?? data.message?.extendedTextMessage?.text;
  const unsupported = typeof content !== 'string' || !content.trim();
  // Only the authenticated local bridge may authorize this marker at ingress.
  // It is classified before outgoing echoes, irrespective of fromMe, and never
  // enters the customer/receipt path or imports old/unsupported test content.
  if (data.localSelfTest === true) {
    const replyGrantId=data.selfReplyGrantId??null;
    if (stale || unsupported || content.length > 4000 || (replyGrantId!==null&&(typeof replyGrantId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(replyGrantId)))) return { kind: 'ignore', reason: 'invalid_self_test' };
    return { kind: 'self_test', eventId: data.key.id, address, text: content,
      timestamp: Math.min(timestamp, now), name:replyGrantId?'WhatsApp 本人回覆測試':'WhatsApp 自傳測試（只讀）',replyGrantId };
  }
  return { kind: data.key.fromMe ? 'outgoing' : 'incoming', eventId: data.key.id, address,
    name: typeof data.pushName === 'string' ? data.pushName.slice(0,100) : 'WhatsApp 客戶',
    text: unsupported ? '［收到非文字訊息，請由人工查看 WhatsApp］' : content.slice(0,4000),
    timestamp: Number.isFinite(timestamp) ? Math.min(timestamp, now) : 0,
    review: stale || unsupported || content.length > 4000, reason: unsupported ? 'unsupported_content' : stale ? 'recovered_or_undated' : content.length > 4000 ? 'oversize' : '',
  };
}

export function createEvolution({ url = '', instance = '', apiKey = '', deliveryEnabled = false, fetchImpl = fetch } = {}) {
  if (url) {
    const parsed = new URL(url);
    if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('INVALID_EVOLUTION_URL');
    if (parsed.protocol === 'http:' && !['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)) throw new Error('EVOLUTION_REQUIRES_HTTPS');
  }
  const configured = Boolean(url && instance && apiKey);
  return {
    configured, deliveryEnabled, instance,
    async sendSelfTest(input) {
      if(!configured)throw new Error('SELF_TEST_NOT_CONFIGURED');
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['text','grantId','replyToId','operationId','linkPreview'].includes(key))||typeof input.text!=='string'||!input.text.trim()||input.text.length>4000||typeof input.grantId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(input.grantId)||typeof input.replyToId!=='string'||!input.replyToId||input.replyToId.length>300||typeof input.operationId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(input.operationId)||(input.linkPreview!==undefined&&input.linkPreview!==false))throw new Error('SELF_TEST_INPUT_INVALID');
      const response=await fetchImpl(`${url.replace(/\/$/,'')}/message/sendSelfTest/${encodeURIComponent(instance)}`,{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{apikey:apiKey,'Content-Type':'application/json'},
        body:JSON.stringify({text:input.text,grantId:input.grantId,replyToId:input.replyToId,operationId:input.operationId,linkPreview:false}),
      });
      if(!response.ok)throw new Error(`SELF_TEST_PROVIDER_HTTP_${response.status}`);
      const data=await response.json(),id=data?.key?.id;
      if(data.error||data.status==='error'||data.selfTest!==true||typeof id!=='string'||!id||id.length>300)throw new Error('SELF_TEST_RESULT_UNKNOWN');
      return {providerId:id,selfTest:true,duplicate:data.duplicate===true};
    },
    async send(address, text) {
      if (!deliveryEnabled || !configured) throw new Error('DELIVERY_DISABLED');
      const response = await fetchImpl(`${url.replace(/\/$/,'')}/message/sendText/${encodeURIComponent(instance)}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { apikey: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ number: address.split('@')[0], text, linkPreview: false }),
      });
      if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`);
      const data = await response.json();
      const id = data?.key?.id;
      if (data.error || data.status === 'error' || typeof id !== 'string' || !id) throw new Error('PROVIDER_RESULT_UNKNOWN');
      return { providerId: id };
    },
  };
}
