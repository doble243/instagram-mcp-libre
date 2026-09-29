import { createHmac, timingSafeEqual } from "node:crypto";

export const projectScopes=["read","edit","approve","publish","accounts"] as const;
export type ProjectScope=typeof projectScopes[number];
export type Principal = { kind: "owner"; workspaceId: null } | { kind: "project"; workspaceId: string; actorId?:string; scopes?:ProjectScope[] };
export type Credential = { token: string; principal: Principal };
const workspacePattern=/^[a-zA-Z0-9_-]{1,64}$/;

export function validateWorkspaceId(value: string) {
  if(!workspacePattern.test(value)) throw new Error("workspace_id solo admite letras, números, guion y guion bajo (máx. 64).");
  return value;
}

export function loadCredentials(env: NodeJS.ProcessEnv): Credential[] {
  const credentials: Credential[]=[];
  if(env.MCP_BEARER_TOKEN) {
    if(env.MCP_BEARER_TOKEN.length<32) throw new Error("MCP_BEARER_TOKEN debe tener al menos 32 caracteres.");
    credentials.push({token:env.MCP_BEARER_TOKEN,principal:{kind:"owner",workspaceId:null}});
  }
  if(env.PROJECT_TOKENS_JSON) {
    const parsed:unknown=JSON.parse(env.PROJECT_TOKENS_JSON);
    if(!parsed || Array.isArray(parsed) || typeof parsed!=="object") throw new Error("PROJECT_TOKENS_JSON debe ser un objeto workspace_id → token.");
    for(const [workspaceId,token] of Object.entries(parsed)) {
      validateWorkspaceId(workspaceId);
      if(typeof token!=="string" || token.length<32) throw new Error(`El token de ${workspaceId} debe tener al menos 32 caracteres.`);
      credentials.push({token,principal:{kind:"project",workspaceId}});
    }
  }
  if(new Set(credentials.map(item=>item.token)).size!==credentials.length) throw new Error("Los tokens de proyecto y el token MCP deben ser distintos.");
  return credentials;
}

export function issueProjectToken(signingKey:string,workspaceId:string,actorId:string,ttlSeconds=900,now=Date.now(),scopes:ProjectScope[]=[...projectScopes]) {
  validateWorkspaceId(workspaceId);
  if(!/^[a-zA-Z0-9_:@.-]{1,128}$/.test(actorId)) throw new Error("actor_id inválido.");
  if(signingKey.length<32) throw new Error("PROJECT_TOKEN_SIGNING_KEY debe tener al menos 32 caracteres.");
  if(!Number.isInteger(ttlSeconds)||ttlSeconds<60||ttlSeconds>900) throw new Error("ttl_seconds debe estar entre 60 y 900.");
  if(!Array.isArray(scopes)||scopes.some(scope=>!projectScopes.includes(scope)))throw new Error("Permisos inválidos.");
  const payload=Buffer.from(JSON.stringify({v:1,aud:"instagram-core",workspaceId,actorId,scopes:[...new Set(scopes)],exp:Math.floor(now/1000)+ttlSeconds})).toString("base64url");
  const signature=createHmac("sha256",signingKey).update(payload).digest("base64url");
  return `igp_${payload}.${signature}`;
}

function verifyProjectToken(token:string,signingKey:string,now=Date.now()):Principal|null {
  if(!token.startsWith("igp_")||signingKey.length<32) return null;
  const match=token.slice(4).match(/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if(!match)return null;
  const expected=createHmac("sha256",signingKey).update(match[1]).digest("base64url");
  const a=Buffer.from(match[2]),b=Buffer.from(expected);
  if(a.length!==b.length||!timingSafeEqual(a,b))return null;
  try {
    const data=JSON.parse(Buffer.from(match[1],"base64url").toString("utf8")) as Record<string,unknown>;
    if(data.v!==1||data.aud!=="instagram-core"||typeof data.workspaceId!=="string"||typeof data.actorId!=="string"||typeof data.exp!=="number"||!Number.isInteger(data.exp)||data.exp<=Math.floor(now/1000))return null;
    validateWorkspaceId(data.workspaceId);
    if(!/^[a-zA-Z0-9_:@.-]{1,128}$/.test(data.actorId))return null;
    if(!Array.isArray(data.scopes)||data.scopes.some(scope=>typeof scope!=="string"||!projectScopes.includes(scope as ProjectScope)))return null;
    return {kind:"project",workspaceId:data.workspaceId,actorId:data.actorId,scopes:data.scopes as ProjectScope[]};
  } catch {return null;}
}

export function requireScope(principal:Principal,scope:ProjectScope){
  if(principal.kind==="project"&&principal.scopes&&!principal.scopes.includes(scope))throw new Error(`Este token no permite ${scope}.`);
}

export function authenticate(header: string|undefined, credentials: Credential[],signingKey=""): Principal|null {
  const supplied=header?.match(/^Bearer (.+)$/i)?.[1];
  if(!supplied) return null;
  for(const {token,principal} of credentials) {
    const a=Buffer.from(supplied),b=Buffer.from(token);
    if(a.length===b.length && timingSafeEqual(a,b)) return principal;
  }
  return verifyProjectToken(supplied,signingKey);
}

export function resolveWorkspace(principal: Principal, requested?:string|null) {
  const workspaceId=validateWorkspaceId(requested??principal.workspaceId??"default");
  if(principal.kind==="project" && workspaceId!==principal.workspaceId) throw new Error("Este token no tiene acceso a ese proyecto.");
  return workspaceId;
}
