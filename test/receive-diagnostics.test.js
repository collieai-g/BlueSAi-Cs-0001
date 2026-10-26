import test from 'node:test';
import assert from 'node:assert/strict';
import { receiveDiagnostics } from '../src/receive-diagnostics.js';

test('receive diagnostics expose only bounded counters, timestamps and fixed reasons',()=>{
  const now=Date.now(),privateValue='synthetic-private-body-or-credential';
  const result=receiveDiagnostics({scope:'process',startedAt:now,
    upserts:{events:2,notify:1,append:1,messageCount:2,lastAt:now,body:privateValue},
    rejected:{nonText:1,unmapped:0,secret:privateValue},queued:{incoming:1,lastAt:now},
    callbacks:{success:1,failure:0,lastSuccessAt:now,headers:privateValue},
    lastRejection:{reason:'nonText',at:now,text:privateValue},phone:privateValue,apiKey:privateValue});
  assert.equal(result.upserts.events,2);assert.equal(result.queued.incoming,1);
  assert.equal(result.lastRejection.reason,'nonText');assert.equal(result.startedAt,now);
  assert.doesNotMatch(JSON.stringify(result),/synthetic-private|headers|phone|apiKey|body/);
  assert.equal(Object.keys(result.rejected).length,12);
});

test('unsupported or malformed provider diagnostics never copy arbitrary values',()=>{
  assert.equal(receiveDiagnostics(null),null);assert.equal(receiveDiagnostics({scope:'other'}),null);
  const result=receiveDiagnostics({scope:'process',startedAt:'secret',upserts:{events:-1,notify:Infinity,append:1e15,lastAt:Date.now()+86400000},lastRejection:{reason:'private-provider-error',at:'private'}});
  assert.equal(result.startedAt,null);assert.equal(result.upserts.events,0);
  assert.equal(result.upserts.notify,0);assert.equal(result.upserts.append,0);assert.equal(result.upserts.lastAt,null);
  assert.equal(result.lastRejection.reason,null);assert.equal(result.lastRejection.at,null);
  assert.doesNotMatch(JSON.stringify(result),/secret|private/);
});
