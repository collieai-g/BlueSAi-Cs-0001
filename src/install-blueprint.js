import { manifest, digest, InstallError } from './install.js';

// request is the existing authenticated host client. Credentials stay in its closure.
// This module never accesses general company search, backups or the merchant DB.
export function createBlueprintInstaller({request,getTargetIdentity}) {
  if(typeof request!=='function')throw new InstallError('AUTHENTICATED_HOST_CLIENT_REQUIRED');
  if(typeof getTargetIdentity!=='function')throw new InstallError('AUTHENTICATED_TARGET_IDENTITY_REQUIRED');
  const normalizeSettings=(values,partial=false)=>{
    if(!values||typeof values!=='object'||Array.isArray(values)||Object.keys(values).some(key=>!manifest.settings.some(field=>field.key===key)))throw new InstallError('INVALID_AGENT_SETTINGS');
    return Object.fromEntries(manifest.settings.filter(field=>!partial||Object.hasOwn(values,field.key)).map(field=>{
      let value=Object.hasOwn(values,field.key)?values[field.key]:field.default;
      if(field.type==='boolean') {if(typeof value!=='boolean')throw new InstallError('INVALID_AGENT_SETTINGS');}
      else {
        if(typeof value!=='string'||value.length>(field.type==='textarea'?40000:1000)||value.includes('\0')||(field.required&&!value.trim()))throw new InstallError('INVALID_AGENT_SETTINGS');
        value=value.trim();if(field.type==='select'&&!field.options.some(option=>option.value===value))throw new InstallError('INVALID_AGENT_SETTINGS');
      }
      return [field.key,value];
    }));
  };
  const upgradeSettings=(agent,requested)=>{
    if(!Array.isArray(agent.manifest.settings))throw new InstallError('INVALID_HOST_RESPONSE',502);
    if(agent.manifest.settings.some(previous=>{
      const next=manifest.settings.find(field=>field.key===previous.key);
      return next?next.type!==previous.type:Object.hasOwn(agent.settings,previous.key);
    }))throw new InstallError('INCOMPATIBLE_UPGRADE_SETTINGS',409);
    try {
      // Match the host: validate the merged values, allowing an explicit valid
      // replacement for an old select value. Stored keys cannot disappear.
      return normalizeSettings({...agent.settings,...requested});
    } catch(error) {
      if(error.code==='INVALID_AGENT_SETTINGS')throw new InstallError('INCOMPATIBLE_UPGRADE_SETTINGS',409);
      throw error;
    }
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
    async ensure({source,settings={},inspection,expected_agent_id,upgrade_key}) {
      if(inspection?.status!=='ready'||inspection.plan_digest!==digest(inspection.plan))throw new InstallError('PREFLIGHT_NOT_READY',409);
      await requireTarget(inspection);
      if(source?.repository!=='https://github.com/collieai-g/BlueSAi-Cs-0001'||source.revision!==inspection.plan.source_revision||!/^[a-f0-9]{40}$/.test(source.revision))throw new InstallError('SOURCE_PIN_MISMATCH',409);
      const upgrading=expected_agent_id!==undefined||upgrade_key!==undefined;
      if(upgrading&&(typeof expected_agent_id!=='string'||!expected_agent_id||expected_agent_id.length>200||/[\s\0]/.test(expected_agent_id)||typeof upgrade_key!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(upgrade_key)))throw new InstallError('EXPLICIT_UPGRADE_TARGET_AND_KEY_REQUIRED',409);
      // Validate the request independently from any server mutation response.
      const requestedSettings=normalizeSettings(settings,true);
      const candidates=(await list()).filter(a=>a.manifest?.id===manifest.id);
      if(candidates.length>1)throw new InstallError('MULTIPLE_EXISTING_INSTANCES',409);
      if(upgrading&&!candidates.length)throw new InstallError('EXPECTED_AGENT_NOT_FOUND',409);
      if(upgrading&&candidates[0].id!==expected_agent_id)throw new InstallError('EXPECTED_AGENT_MISMATCH',409);
      let agent,agentId,desiredSettings,retainedState;
      if(candidates.length) {
        agentId=candidates[0].id;
        if(typeof agentId!=='string'||!agentId)throw new InstallError('INVALID_HOST_RESPONSE',502);
        agent=(await request('GET',`/api/studio/agents/${encodeURIComponent(agentId)}`)).agent;
        if(!agent||agent.id!==agentId||agent.manifest?.id!==manifest.id)throw new InstallError('REGISTRATION_READBACK_MISMATCH',502);
        if(upgrading) {
          if(agent.source?.repository!==source.repository)throw new InstallError('SOURCE_REPOSITORY_MISMATCH',409);
          if(agent.source.revision===source.revision&&digest(agent.manifest)!==digest(manifest))throw new InstallError('MANIFEST_CONTENT_MISMATCH',409);
          desiredSettings=upgradeSettings(agent,requestedSettings);
          retainedState=Object.fromEntries(['enabled','connection_state'].filter(key=>Object.hasOwn(agent,key)).map(key=>[key,agent[key]]));
          await requireTarget(inspection);
          // Keep the caller's key and partial intent stable across deliberate
          // retries. The host excludes the refreshed CAS token from its receipt.
          // Transport failures propagate: never blindly retry or fall back to POST.
          agent=(await request('PATCH',`/api/studio/agents/${encodeURIComponent(agentId)}`,{expected_version:agent.version,manifest:structuredClone(manifest),source:structuredClone(source),upgrade_key,settings:structuredClone(requestedSettings)})).agent;
        } else {
          if(agent.manifest.version!==manifest.version||agent.source?.revision!==source.revision||agent.source?.repository!==source.repository)throw new InstallError('HOST_PACKAGE_UPGRADE_REQUIRED',409);
          if(digest(agent.manifest)!==digest(manifest))throw new InstallError('MANIFEST_CONTENT_MISMATCH',409);
          desiredSettings=normalizeSettings({...agent.settings,...requestedSettings});
          if(digest(desiredSettings)!==digest(agent.settings)) {
            await requireTarget(inspection);
            agent=(await request('PATCH',`/api/studio/agents/${encodeURIComponent(agentId)}`,{expected_version:agent.version,settings:structuredClone(desiredSettings)})).agent;
          }
        }
      } else {
        // Host contract deduplicates this exact manifest version and pinned source.
        desiredSettings=normalizeSettings(requestedSettings);
        await requireTarget(inspection);
        agent=(await request('POST','/api/studio/agents',{manifest,source,settings:structuredClone(desiredSettings)})).agent;
      }
      if(typeof agent?.id!=='string'||!agent.id)throw new InstallError('INVALID_HOST_RESPONSE',502);
      if(agentId&&agent.id!==agentId)throw new InstallError('REGISTRATION_READBACK_MISMATCH',502);
      agentId=agentId||agent.id;
      await requireTarget(inspection);
      const actual=(await request('GET',`/api/studio/agents/${encodeURIComponent(agentId)}`)).agent;
      if(!actual||actual.id!==agentId||!actual.manifest||!actual.settings||!actual.source||digest(actual.manifest)!==digest(manifest)||digest(actual.settings)!==digest(desiredSettings)||digest(actual.source)!==digest(source)||retainedState&&Object.entries(retainedState).some(([key,value])=>actual[key]!==value))throw new InstallError('REGISTRATION_READBACK_MISMATCH',502);
      return {agent_id:actual.id,version:actual.version,source:actual.source,settings:actual.settings,connection_state:actual.connection_state,verified:'same_id_readback',host_deployment_required:false};
    },
  };
}
