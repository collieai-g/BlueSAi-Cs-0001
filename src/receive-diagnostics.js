const reasons = ['eventType','requestId','invalidKey','stale','nonText','oversize','unmapped','outOfScope','self','knownEcho','contextChanged','scopeClosed'];
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000000 ? value : 0;
const stamp = value => Number.isSafeInteger(value) && value > 0 && value <= Date.now() + 60000 ? value : null;
const counts = (value, keys) => Object.fromEntries(keys.map(key => [key, count(value?.[key])]));

// Provider responses can contain private fields. Only these aggregate counters,
// timestamps and fixed reason names may cross into the card's status response.
export function receiveDiagnostics(value) {
  if (!value || value.scope !== 'process') return null;
  return {
    scope: 'process', startedAt: stamp(value.startedAt),
    upserts: {...counts(value.upserts,['events','notify','append','other','requestId','messageCount']),lastAt:stamp(value.upserts?.lastAt)},
    rejected: counts(value.rejected,reasons),
    queued: {...counts(value.queued,['incoming','outgoing','selfTest','duplicate']),lastAt:stamp(value.queued?.lastAt)},
    callbacks: {...counts(value.callbacks,['success','failure']),lastSuccessAt:stamp(value.callbacks?.lastSuccessAt),lastFailureAt:stamp(value.callbacks?.lastFailureAt)},
    lastRejection: {reason:reasons.includes(value.lastRejection?.reason)?value.lastRejection.reason:null,at:stamp(value.lastRejection?.at)},
  };
}
