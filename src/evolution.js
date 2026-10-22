export function normalizeEvent(payload, instance, now = Date.now()) {
  if (payload?.instance !== instance) throw new Error('INSTANCE_MISMATCH');
  const event = String(payload.event || '').toLowerCase().replaceAll('_', '.');
  if (event === 'messages.set') return { kind: 'ignore', reason: 'history' };
  if (event !== 'messages.upsert') return { kind: 'ignore', reason: 'unsupported_event' };
  const data = payload.data;
  if (!data || Array.isArray(data) || !data.key || typeof data.key.id !== 'string' || !data.key.id || typeof data.key.fromMe !== 'boolean') throw new Error('INVALID_EVENT');
  const address = data.key.remoteJid;
  // LID-only addresses require explicit alias resolution, not suffix guessing.
  if (typeof address !== 'string' || !/^\d{5,20}@s\.whatsapp\.net$/.test(address)) return { kind: 'ignore', reason: 'unsupported_address' };
  const seconds = Number(data.messageTimestamp);
  const timestamp = seconds * 1000;
  const stale = !Number.isFinite(timestamp) || timestamp > now + 60000 || timestamp < now - 5 * 60000;
  const content = data.message?.conversation ?? data.message?.extendedTextMessage?.text;
  const unsupported = typeof content !== 'string' || !content.trim();
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
