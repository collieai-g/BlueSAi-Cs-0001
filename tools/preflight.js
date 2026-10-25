import { readFileSync } from 'node:fs';
import { preflight } from '../src/install.js';

const args=process.argv.slice(2),allowed=new Set(['--host','--mode','--source','--management']);
try {
  const values={};
  for(let i=0;i<args.length;i++) {
    if(!allowed.has(args[i])||Object.hasOwn(values,args[i]))throw new Error();
    if(args[i]==='--management')values[args[i]]=true;
    else {if(!args[i+1]||args[i+1].startsWith('--'))throw new Error();values[args[i]]=args[++i];}
  }
  if(!values['--host'])throw new Error();
  const host=JSON.parse(readFileSync(values['--host'],'utf8'));
  const result=preflight({host,mode:values['--mode']||'collaboration',sourceRevision:values['--source'],management:values['--management']===true});
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  if(result.status!=='ready')process.exitCode=2;
}catch {process.stderr.write('Usage: node tools/preflight.js --host PRIVATE_HOST_EVIDENCE.json --mode collaboration|whatsapp|web-chat --source FULL_COMMIT [--management]\n');process.exitCode=1;}
