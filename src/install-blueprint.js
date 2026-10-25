import { manifest, digest, InstallError } from './install.js';

// request is the existing authenticated host client. Credentials stay in its closure.
// This module never accesses general company search, backups or the merchant DB.
export function createBlueprintInstaller({request,getTargetIdentity}) {
  if(typeof request!=='function')throw new InstallError('AUTHENTICATED_HOST_CLIENT_REQUIRED');
  if(typeof getTargetIdentity!=='function')throw new InstallError('AUTHENTICATED_TARGET_IDENTITY_REQUIRED');
  const normalizeSettings=values=>{
    if(!values||typeof values!=='object'||Array.isArray(values)||Object.keys(values).some(key=>!manifest.settings.some(field=>field.key===key)))throw new InstallError('INVALID_AGENT_SETTINGS');
    return Object.fromEntries(manifest.settings.map(field=>{
      let value=Object.hasOwn(values,field.key)?values[field.key]:field.default;
      if(field.type==='boolean') {if(typeof value!=='boolean')throw new InstallError('INVALID_AGENT_SETTINGS');}
      else {
        if(typeof value!=='string'||value.length>(field.type==='textarea'?40000:1000)||value.includes('\0')||(field.required&&!value.trim()))throw new InstallError('INVALID_AGENT_SETTINGS');
        value=value.trim();if(field.type==='select'&&!field.options.some(option=>option.value===value))throw new InstallError('INVALID_AGENT_SETTINGS');
      }
      return [field.key,value];
    }));
  };
  const requireTarget=async inspection=>{
    const actual=await getTargetIdentity();
    if(!actual||typeof actual.target_id!=='string'||actual.target_id!==inspection.plan.target_id)throw new InstallError('AUTHENTICATED_TARGET_MISMATCH',403);
    if(!['owner','admin'].includes(actual.role))throw new InstallError('ADMIN_REQUIRED',403);
  };
  async function list() {
    const result=[];
    for(let offset=0;;offset+=100) {
      const page=await request('GET',`/api/studio/agents?limit=100&offset=${offset}`);
      if(!Array.isArray(page.agents)||!Number.isInteger(page.total))throw new InstallError('INVALID_HOST_RESPONSE',502);
      result.push(...page.agents);if(result.length>=page.total)break;
      if(page.agents.length===0||offset>100000)throw new InstallError('INVALID_HOST_PAGINATION',502);
    }
    return result;
  }
  return {
    async ensure({source,settings={},inspection}) {
      if(inspection?.status!=='ready'||inspection.plan_digest!==digest(inspection.plan))throw new InstallError('PREFLIGHT_NOT_READY',409);
      await requireTarget(inspection);
      if(source?.repository!=='https://github.com/collieai-g/BlueSAi-Cs-0001'||source.revision!==inspection.plan.source_revision||!/^[a-f0-9]{40}$/.test(source.revision))throw new InstallError('SOURCE_PIN_MISMATCH',409);
      // Validate the request independently from any server mutation response.
      normalizeSettings(settings);
      const candidates=(await list()).filter(a=>a.manifest?.id===manifest.id);
      if(candidates.length>1)throw new InstallError('MULTIPLE_EXISTING_INSTANCES',409);
      let agent,desiredSettings;
      if(candidates.length) {
        agent=(await request('GET',`/api/studio/agents/${encodeURIComponent(candidates[0].id)}`)).agent;
        if(!agent||agent.manifest?.version!==manifest.version||agent.source?.revision!==source.revision||agent.source?.repository!==source.repository)throw new InstallError('HOST_PACKAGE_UPGRADE_REQUIRED',409);
        if(digest(agent.manifest)!==digest(manifest))throw new InstallError('MANIFEST_CONTENT_MISMATCH',409);
        desiredSettings=normalizeSettings({...agent.settings,...settings});
        if(digest(desiredSettings)!==digest(agent.settings)) {
          await requireTarget(inspection);
          agent=(await request('PATCH',`/api/studio/agents/${encodeURIComponent(agent.id)}`,{expected_version:agent.version,settings:structuredClone(desiredSettings)})).agent;
        }
      } else {
        // Host contract deduplicates this exact manifest version and pinned source.
        desiredSettings=normalizeSettings(settings);
        await requireTarget(inspection);
        agent=(await request('POST','/api/studio/agents',{manifest,source,settings:structuredClone(desiredSettings)})).agent;
      }
      if(!agent?.id)throw new InstallError('INVALID_HOST_RESPONSE',502);
      await requireTarget(inspection);
      const actual=(await request('GET',`/api/studio/agents/${encodeURIComponent(agent.id)}`)).agent;
      if(!actual||actual.id!==agent.id||digest(actual.manifest)!==digest(manifest)||digest(actual.settings)!==digest(desiredSettings)||digest(actual.source)!==digest(source))throw new InstallError('REGISTRATION_READBACK_MISMATCH',502);
      return {agent_id:actual.id,version:actual.version,source:actual.source,settings:actual.settings,connection_state:actual.connection_state,verified:'same_id_readback',host_deployment_required:false};
    },
  };
}
