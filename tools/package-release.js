import { execFileSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdirSync,existsSync,realpathSync,lstatSync } from 'node:fs';
import { resolve,relative,isAbsolute,dirname,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url));
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
try {
  if(process.argv.length!==4||process.argv[2]!=='--output')throw new Error('Use --output ABSOLUTE_PRIVATE_RELEASE_DIRECTORY');
  const target=process.argv[3];if(!isAbsolute(target))throw new Error('Output directory must be absolute.');
  let parent=resolve(target);while(!existsSync(parent))parent=dirname(parent);
  const actual=resolve(realpathSync(parent),relative(parent,resolve(target)));
  const rel=relative(realpathSync(root),actual);if(!(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)))throw new Error('Output must be outside the repository.');
  if(existsSync(target))throw new Error('Output directory already exists; release artifacts are immutable.');
  if(git('status','--porcelain'))throw new Error('Release requires a clean committed source tree.');
  const revision=git('rev-parse','HEAD');if(!/^[a-f0-9]{40}$/.test(revision))throw new Error('Full source commit required.');
  const files=git('ls-files','-z').split('\0').filter(Boolean).sort();
  if(files.some(path=>lstatSync(resolve(root,path)).isSymbolicLink()))throw new Error('Symlinks require an explicitly reviewed packaging rule.');
  const pkg=JSON.parse(readFileSync(resolve(root,'integrations/blueprint/package.json'),'utf8'));
  const inventory=files.map(path=>({path,sha256:sha256(execFileSync('git',['show',`${revision}:${path}`],{cwd:root,maxBuffer:20*1024*1024,stdio:['ignore','pipe','pipe']}))}));
  mkdirSync(target,{recursive:true,mode:0o700});
  execFileSync('git',['archive','--format=tar','--output',resolve(target,'source.tar'),revision],{cwd:root,stdio:['ignore','pipe','pipe']});
  const release={schema_version:1,id:pkg.id,version:pkg.version,channel:pkg.channel,source:{repository:pkg.repository,revision},host_contract:pkg.host_contract,capabilities:pkg.modes,artifacts:[{path:'source.tar',sha256:sha256(readFileSync(resolve(target,'source.tar')))}],inventory,evidence:{scope:'CI and repository tests; live host/channel acceptance is separate',tests:['npm test','npm run check'],results:'See CI run for this exact source revision; generation alone does not attest test success.'}};
  writeFileSync(resolve(target,'release.json'),JSON.stringify(release,null,2)+'\n',{flag:'wx',mode:0o600});
  process.stdout.write(JSON.stringify({revision,version:pkg.version,channel:pkg.channel,output:resolve(target),artifacts:release.artifacts})+'\n');
}catch(error){process.stderr.write(`${error.message?.startsWith('Command failed:')?'Git source or archive operation failed.':error.message}\n`);process.exitCode=1;}
