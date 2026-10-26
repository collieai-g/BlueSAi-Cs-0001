// Release policy inspects the pinned commit, never a merchant's external runtime.
// These explicit guards complement review; they cannot identify arbitrary private
// prose or every credential format in otherwise ordinary public source files.
const dataExtension=/\.(?:json|jsonc|jsonl|ndjson|ya?ml|csv|tsv|xlsx?|txt|md|sql|html?|zip|tar|tgz|gz|bak|backup)$/i;
const topic=/(?:^|[-_.])(?:customers?|knowledge|inbox|conversations?|messages|faqs?|merchant|learning[-_]?(?:cases?|proposals?))(?:[-_.]|$)/;
const exportHint=/(?:^|[-_.])(?:exports?|dumps?|snapshots?|backups?|data)(?:[-_.]|$)/;

function syntheticFixture(path,bytes) {
  if(!path.split('/').includes('fixtures')||!path.endsWith('.json'))return false;
  try{const value=JSON.parse(bytes.toString('utf8'));return value?.synthetic===true||value?.fixture===true;}catch{return false;}
}

export function releasePrivacyViolation(path,bytes) {
  if(typeof path!=='string'||!Buffer.isBuffer(bytes))throw Error('INVALID_RELEASE_PRIVACY_INPUT');
  const value=path.normalize('NFKC').replace(/\\/g,'/').toLowerCase(),parts=value.split('/'),name=parts.at(-1);
  if(parts.some(p=>!p||p==='.'||p==='..'))return 'UNSAFE_COMMIT_PATH';
  if(name!=='.env.example'&&(name==='.env'||name.startsWith('.env.')||/\.env(?:\..*)?$/.test(name)))return 'PRIVATE_ENV_FILE';
  if(parts.slice(0,-1).some(p=>['auth','creds','credentials','backup','backups','exports','private','.private','data','logs','.codex','.ssh','.aws','.azure'].includes(p)||/^\.bluesai(?:-|$)/.test(p)))return 'PRIVATE_STORAGE_DIRECTORY';
  if(/\.(?:sqlite(?:3)?|db)(?:[-.](?:wal|shm|journal|backup|bak))?$/.test(name)||/\.(?:wal|shm)$/.test(name)||/\.log(?:\.(?:\d+|gz|zip|bak))?$/.test(name))return 'PRIVATE_DATABASE_OR_LOG';
  if(/^(?:auth|creds|credentials|secrets?)\.(?:json|ya?ml|toml|txt|bin)$/.test(name)||/^\.?admin[-_]token(?:[.-].*)?$/.test(name)||/^\.?credentials$/.test(name)||/^id_(?:rsa|ed25519|ecdsa)(?:\.pub)?$/.test(name)&&!name.endsWith('.pub'))return 'PRIVATE_CREDENTIAL_FILE';
  const stem=name.replace(/\.[^.]+$/,''),bareTopic=/^(?:customers?|knowledge|inbox|conversations?|messages|faqs?|merchant|learning[-_]?(?:cases?|proposals?))$/.test(stem);
  if(dataExtension.test(name)&&((topic.test(value.replace(/\//g,'-'))&&exportHint.test(value.replace(/\//g,'-')))||(bareTopic&&!syntheticFixture(value,bytes))))return 'PRIVATE_EXPORTED_DATA';
  if(bytes.subarray(0,16).equals(Buffer.from('SQLite format 3\0'))||(bytes.length>=4&&[0x377f0682,0x377f0683].includes(bytes.readUInt32BE(0))))return 'PRIVATE_DATABASE_BYTES';
  const text=bytes.toString('utf8');
  if(/-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----\r?\n(?:Proc-Type:[ \t]*4,ENCRYPTED\r?\n)?(?:DEK-Info:[ \t]*[A-Z0-9-]+,[A-F0-9]+\r?\n)?(?:\r?\n)*(?:[A-Za-z0-9+/=]{16,}\r?\n)+(?:[A-Za-z0-9+/=]{1,15}\r?\n)?-----END (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----/iu.test(text))return 'PRIVATE_KEY_BYTES';
  if(/\bsk-(?:(?:proj|svcacct)-[A-Za-z0-9_-]{40,}|[A-Za-z0-9]{48,})\b/u.test(text))return 'OPENAI_CREDENTIAL_BYTES';
  return null;
}

export function assertPublicReleaseFile(path,bytes) {
  const code=releasePrivacyViolation(path,bytes);
  if(code)throw Object.assign(new Error(`Release blocked by privacy gate (${code}). Keep runtime, customer data and credentials outside the public source.`),{code});
}
