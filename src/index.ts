import "dotenv/config";
import { createServer } from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { getEnv, InstagramApi } from "./instagram.js";
import { LocalStore, type Draft } from "./store.js";
import { decryptToken, encryptToken } from "./vault.js";
import { authenticate, issueProjectToken, loadCredentials, resolveWorkspace, validateWorkspaceId, requireScope, projectScopes, type Principal } from "./tenant.js";
import { brandKitSchema, productsBatchSchema } from "./integration.js";
import { stylePresets, suggestProductContent } from "./creative.js";
import { createA2A } from "./a2a.js";
import { PostgresStore } from "./postgres-store.js";
import { SupabaseMediaStorage } from "./media-storage.js";

const baseEnv = getEnv();
const store:LocalStore|PostgresStore = process.env.DATABASE_URL?new PostgresStore(process.env.DATABASE_URL):new LocalStore();
if(store instanceof PostgresStore) await store.assertReady();
const credentials = loadCredentials(process.env);
const projectSigningKey=process.env.PROJECT_TOKEN_SIGNING_KEY??"";
if(projectSigningKey&&projectSigningKey.length<32)throw new Error("PROJECT_TOKEN_SIGNING_KEY debe tener al menos 32 caracteres.");
const bearer = process.env.MCP_BEARER_TOKEN ?? "";
const DATA_DIR = process.env.DATA_DIR || ".data";
const UPLOAD_DIR = join(DATA_DIR, "uploads");
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 50 * 1024 * 1024);
const mediaStorage=process.env.SUPABASE_URL&&process.env.SUPABASE_SECRET_KEY&&process.env.SUPABASE_MEDIA_BUCKET?new SupabaseMediaStorage(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY,process.env.SUPABASE_MEDIA_BUCKET):null;
if(process.env.DATABASE_URL&&!mediaStorage)throw new Error("Para DATABASE_URL configura almacenamiento duradero: SUPABASE_URL, SUPABASE_SECRET_KEY y SUPABASE_MEDIA_BUCKET.");
const accounts = loadAccounts();

type AccountConfig = { id: string; workspaceId:string; label: string; username?: string; userId?: string; accessToken?: string; graphVersion: string; expiresAt?: string; oauth?: boolean };
function loadAccounts(): AccountConfig[] {
  const raw = process.env.IG_ACCOUNTS_JSON;
  if (raw) {
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    if (!Array.isArray(parsed) || parsed.length > 20) throw new Error("IG_ACCOUNTS_JSON debe ser una lista de hasta 20 cuentas.");
    return parsed.map((item, i) => ({
      id: String(item.id ?? `account-${i + 1}`), workspaceId:validateWorkspaceId(String(item.workspace_id??"default")), label: String(item.label ?? item.username ?? `Cuenta ${i + 1}`),
      username: item.username ? String(item.username) : undefined,
      userId: item.userId ? String(item.userId) : item.ig_user_id ? String(item.ig_user_id) : undefined,
      accessToken: item.accessToken ? String(item.accessToken) : item.access_token ? String(item.access_token) : undefined,
      graphVersion: String(item.graphVersion ?? process.env.IG_GRAPH_VERSION ?? "v25.0")
    }));
  }
  return [{ id: "default", workspaceId:"default", label: process.env.IG_USERNAME || "Cuenta principal", username: process.env.IG_USERNAME || undefined, userId: baseEnv.userId, accessToken: baseEnv.accessToken, graphVersion: baseEnv.graphVersion }];
}
for (const saved of await store.listConnectedAccounts()) {
  accounts.push({ id:saved.id, workspaceId:saved.workspaceId??"default", label:saved.label, username:saved.username, userId:saved.userId, accessToken:decryptToken(saved.encryptedToken), graphVersion:process.env.IG_GRAPH_VERSION||"v25.0", expiresAt:saved.expiresAt, oauth:true });
}
function getAccountFor(id: string|null|undefined, workspaceId:string): AccountConfig {
  const selected = id ?? accounts.find(a=>a.workspaceId===workspaceId)?.id;
  const account = accounts.find(item => item.id === selected && item.workspaceId===workspaceId);
  if (!account) throw new Error(`No existe una cuenta conectada para ${workspaceId}.`);
  return account;
}
async function apiForAccount(id: string|null|undefined, workspaceId:string) {
  const account = getAccountFor(id,workspaceId);
  if (account.oauth && account.expiresAt && new Date(account.expiresAt).getTime() - Date.now() < 5 * 24 * 60 * 60 * 1000) await refreshOAuthAccount(account);
  return new InstagramApi({ ...baseEnv, accessToken: account.accessToken, userId: account.userId, graphVersion: account.graphVersion });
}
async function refreshOAuthAccount(account: AccountConfig) {
  if (!account.oauth || !account.accessToken) return;
  const response = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(account.accessToken)}`);
  const data = await response.json() as { access_token?: string; expires_in?: number; error?: { message?: string } };
  if (!response.ok || !data.access_token) throw new Error(`No se pudo renovar el token de @${account.username ?? account.id}: ${data.error?.message ?? response.statusText}`);
  account.accessToken = data.access_token;
  account.expiresAt = new Date(Date.now() + (data.expires_in ?? 5_184_000) * 1000).toISOString();
  const saved = (await store.listConnectedAccounts()).find(item => item.id === account.id);
  if (saved) await store.saveConnectedAccount({ ...saved, encryptedToken: encryptToken(data.access_token), expiresAt: account.expiresAt });
}
async function activeAccountIdFor(workspaceId:string) { return (await store.getActiveAccountId(workspaceId)) ?? accounts.find(a=>a.workspaceId===workspaceId)?.id ?? null; }
function text(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] }; }
function normalizeUrls(urls: string[]) {
  if (urls.length < 1 || urls.length > 10) throw new Error("Debe haber entre 1 y 10 archivos.");
  return urls.map(value => { const url = new URL(value); if (url.protocol !== "https:") throw new Error("Los archivos deben estar en URL HTTPS públicas para que Meta pueda descargarlos."); return url.toString(); });
}
function mediaSignatureMatches(bytes:Buffer,mimeType:string){
  if(mimeType==="image/png")return bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if(mimeType==="image/jpeg")return bytes.length>3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  if(mimeType==="image/webp")return bytes.toString("ascii",0,4)==="RIFF"&&bytes.toString("ascii",8,12)==="WEBP";
  if(mimeType==="video/mp4"||mimeType==="video/quicktime")return bytes.toString("ascii",4,8)==="ftyp"&&bytes.length>=12;
  return false;
}
function validateDraft(draft: Pick<Draft,"mediaUrls"|"assetType"|"destination"|"caption">) {
  if (!draft.caption || draft.caption.length <= 2200) { /* valid */ } else throw new Error("El texto supera el límite de 2200 caracteres.");
  if (draft.destination === "carousel") {
    if (draft.mediaUrls.length < 2 || draft.mediaUrls.length > 10) throw new Error("El carrusel requiere entre 2 y 10 archivos.");
    if (draft.assetType !== "image") throw new Error("En esta versión el carrusel admite imágenes.");
  } else {
    if (draft.mediaUrls.length !== 1) throw new Error("Feed, historia y reel aceptan un archivo por publicación.");
    if (draft.destination === "reel" && draft.assetType !== "video") throw new Error("Un Reel requiere video.");
  }
}
function assetSignature(id: string, expires: string) {
  const secret = process.env.ASSET_SIGNING_SECRET || bearer;
  if (!secret) throw new Error("Configura ASSET_SIGNING_SECRET para habilitar enlaces de medios.");
  return createHmac("sha256", secret).update(`${id}:${expires}`).digest("hex");
}
function publicAssetUrl(id: string) {
  const base = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 8787}`;
  const expires = String(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const token = assetSignature(id, expires);
  return `${base.replace(/\/$/, "")}/assets/${encodeURIComponent(id)}?expires=${expires}&token=${token}`;
}
function csvCell(value: unknown) {
  let v = String(value ?? "");
  if (/^[=+@\-]/.test(v)) v = `'${v}`;
  return `"${v.replaceAll('"', '""')}"`;
}

const placementSchema = z.enum(["feed", "story", "reel", "carousel"]);
const workspaceSchema = z.string().optional();
const urlListSchema = z.array(z.string().url()).min(1).max(10);
const draftInputSchema=z.object({media_urls:urlListSchema,asset_type:z.enum(["image","video"]),destination:placementSchema,caption:z.string().max(2200).default(""),scheduled_at:z.string().datetime().nullable().default(null)}).strict();

async function createOAuthUrl(workspaceId:string,actorId:string|null=null) {
  const clientId=process.env.IG_CLIENT_ID; const redirect=process.env.OAUTH_REDIRECT_URI;
  if(!clientId||!process.env.IG_CLIENT_SECRET||!redirect) throw new Error("Configura IG_CLIENT_ID, IG_CLIENT_SECRET y OAUTH_REDIRECT_URI.");
  encryptToken("configuration-check");
  const state=randomUUID();await store.createOAuthState(state,workspaceId,actorId,new Date(Date.now()+10*60_000));
  const authorize=new URL("https://www.instagram.com/oauth/authorize");
  authorize.searchParams.set("client_id",clientId);authorize.searchParams.set("redirect_uri",redirect);
  authorize.searchParams.set("response_type","code");
  authorize.searchParams.set("scope","instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments,instagram_business_manage_insights");
  authorize.searchParams.set("state",state);authorize.searchParams.set("enable_fb_login","0");authorize.searchParams.set("force_authentication","1");
  return {authorization_url:authorize.toString(),callback_uri:redirect,state_expires_in_seconds:600};
}

function makeServer(principal:Principal) {
  const workspace=(requested?:string|null)=>resolveWorkspace(principal,requested);
  const activeAccountId=()=>activeAccountIdFor(workspace());
  const apiFor=(id?:string|null)=>apiForAccount(id,workspace());
  const getAccount=(id?:string|null)=>getAccountFor(id,workspace());
  const ownedDraft=async(id:string)=>{const draft=await store.getDraft(id);if(!draft)throw new Error("No existe ese borrador.");workspace(draft.workspaceId);return draft;};
  const server = new McpServer({ name: "instagram-mcp-libre", version: "1.0.0-rc.1" });
  server.registerTool("instagram_profile", { title: "Ver perfil de Instagram", description: "Devuelve el perfil profesional de la cuenta activa.", inputSchema: {} }, async () => text(await (await apiFor(await activeAccountId())).getProfile()));
  server.registerTool("instagram_recent_posts", { title: "Listar publicaciones recientes", description: "Lista posts y Reels recientes de la cuenta activa.", inputSchema: { limit: z.number().int().min(1).max(25).default(10) } }, async ({limit}) => text(await (await apiFor(await activeAccountId())).listMedia(limit)));
  server.registerTool("instagram_post_insights", { title: "Consultar métricas", description: "Devuelve las métricas de una publicación por su ID.", inputSchema: { media_id: z.string().min(1) } }, async ({media_id}) => text(await (await apiFor(await activeAccountId())).getMediaInsights(media_id)));
  server.registerTool("instagram_post_comments", { title: "Leer comentarios", description: "Lee comentarios recientes de una publicación.", inputSchema: { media_id: z.string().min(1) } }, async ({media_id}) => text(await (await apiFor(await activeAccountId())).getComments(media_id)));
  server.registerTool("instagram_reply_to_comment", { title: "Responder comentario", description: "Responde a un comentario; solo ejecutar luego de confirmar el texto con el usuario.", inputSchema: { comment_id: z.string().min(1), message: z.string().min(1).max(2200), confirmed: z.literal(true) }, annotations: { idempotentHint: false, openWorldHint: true } }, async ({comment_id,message}) => {requireScope(principal,"publish");
    const accountId = await activeAccountId(); const result = await (await apiFor(accountId)).replyToComment(comment_id,message);
    await store.markCommentReplied(comment_id,message,workspace()).catch(() => undefined);
    return text(result);
  });
  server.registerTool("instagram_preview_publication", { title: "Previsualizar publicación", description: "Valida y resume el contenido antes de publicar o programar.", inputSchema: { media_urls: urlListSchema, asset_type: z.enum(["image","video"]), destination: placementSchema, caption: z.string().max(2200).default("") } }, async ({media_urls,asset_type,destination,caption}) => {
    const urls = normalizeUrls(media_urls); const candidate = {mediaUrls:urls,assetType:asset_type,destination,caption}; validateDraft(candidate);
    return text({ valid:true, destination, asset_type, caption, media_urls:urls, needs_confirmation:true, note:"Revisa las URL y el texto; las imágenes no se pueden mostrar dentro de este cliente MCP." });
  });
  server.registerTool("instagram_publish_media", { title: "Publicar post, historia o Reel", description: "Publica imagen o video en feed, Story o Reel desde una URL HTTPS accesible. Requiere confirmed=true después de revisar el contenido.", inputSchema: { media_url:z.string().url(), asset_type:z.enum(["image","video"]), destination:z.enum(["feed","story","reel"]), caption:z.string().max(2200).default(""), share_to_feed:z.boolean().default(true), confirmed:z.literal(true) }, annotations:{idempotentHint:false,openWorldHint:true} }, async args => {requireScope(principal,"publish");
    const urls = normalizeUrls([args.media_url]); validateDraft({mediaUrls:urls,assetType:args.asset_type,destination:args.destination,caption:args.caption});
    const accountId = await activeAccountId(); const result = await (await apiFor(accountId)).publishMedia({mediaUrl:urls[0],assetType:args.asset_type,placement:args.destination,caption:args.caption,shareToFeed:args.share_to_feed});
    await store.addHistory({workspaceId:workspace(),accountId:accountId ?? "default",draftId:null,destination:args.destination,caption:args.caption,mediaUrls:urls,mediaId:String((result.published_media as Record<string,unknown>|undefined)?.id ?? "") || null,status:(result as {demo?:boolean}).demo?"demo":"published",error:null});
    return text(result);
  });
  server.registerTool("instagram_publish_carousel", { title:"Publicar carrusel", description:"Publica de 2 a 10 imágenes en un carrusel. Pide confirmación después de mostrar todas las imágenes y el texto.", inputSchema:{media_urls:z.array(z.string().url()).min(2).max(10),caption:z.string().max(2200).default(""),confirmed:z.literal(true)},annotations:{idempotentHint:false,openWorldHint:true}}, async ({media_urls,caption}) => {requireScope(principal,"publish");
    const urls=normalizeUrls(media_urls); const accountId=await activeAccountId(); const result=await (await apiFor(accountId)).publishCarousel({mediaUrls:urls,caption});
    await store.addHistory({workspaceId:workspace(),accountId:accountId??"default",draftId:null,destination:"carousel",caption,mediaUrls:urls,mediaId:String((result.published_media as Record<string,unknown>|undefined)?.id??"")||null,status:(result as {demo?:boolean}).demo?"demo":"published",error:null}); return text(result);
  });

  server.registerTool("instagram_draft_create", { title:"Crear borrador", description:"Guarda una publicación sin enviarla a Instagram. Puedes pedir aprobación antes de programarla.", inputSchema:{workspace_id:workspaceSchema,media_urls:urlListSchema,asset_type:z.enum(["image","video"]),destination:placementSchema,caption:z.string().max(2200).default(""),scheduled_at:z.string().datetime().nullable().default(null)} }, async args => {requireScope(principal,"edit");
    const workspaceId=workspace(args.workspace_id); const urls=normalizeUrls(args.media_urls); const data={mediaUrls:urls,assetType:args.asset_type,destination:args.destination,caption:args.caption}; validateDraft(data);
    if(args.scheduled_at && new Date(args.scheduled_at)<=new Date()) throw new Error("La fecha programada debe estar en el futuro.");
    const accountId=await activeAccountIdFor(workspaceId); if(!accountId) throw new Error("Conecta una cuenta para este proyecto antes de crear borradores."); const draft=await store.createDraft({workspaceId,accountId,...data,scheduledAt:args.scheduled_at}); return text(draft);
  });
  server.registerTool("instagram_drafts_list", { title:"Listar borradores", description:"Lista borradores y publicaciones planificadas de un espacio de trabajo.", inputSchema:{workspace_id:workspaceSchema} }, async ({workspace_id})=>text(await store.listDrafts(workspace(workspace_id))));
  server.registerTool("instagram_draft_update", { title:"Editar borrador", description:"Edita texto, medios, destino o fecha de un borrador que todavía no se publicó.", inputSchema:{draft_id:z.string().uuid(),media_urls:urlListSchema.optional(),asset_type:z.enum(["image","video"]).optional(),destination:placementSchema.optional(),caption:z.string().max(2200).optional(),scheduled_at:z.string().datetime().nullable().optional()} }, async args => {requireScope(principal,"edit");
    const current=await ownedDraft(args.draft_id); if(["publishing","published","cancelled","needs_review"].includes(current.status)) throw new Error("Ese estado ya no permite editar el borrador.");
    const next={mediaUrls:args.media_urls?normalizeUrls(args.media_urls):current.mediaUrls,assetType:args.asset_type??current.assetType,destination:args.destination??current.destination,caption:args.caption??current.caption}; validateDraft(next);
    if(args.scheduled_at && new Date(args.scheduled_at)<=new Date()) throw new Error("La fecha programada debe estar en el futuro.");
    return text(await store.updateDraft(args.draft_id,{mediaUrls:next.mediaUrls,assetType:next.assetType,destination:next.destination,caption:next.caption,...("scheduled_at" in args?{scheduledAt:args.scheduled_at}:{}),status:"draft",approvedAt:null}));
  });
  server.registerTool("instagram_draft_approve", { title:"Aprobar borrador", description:"Aprueba el contenido revisado. Si tiene fecha futura, queda programado y se publicará a esa hora mientras el servidor esté encendido.", inputSchema:{draft_id:z.string().uuid(),confirmed:z.literal(true)} }, async ({draft_id})=>{requireScope(principal,"approve");
    const draft=await ownedDraft(draft_id); if(["publishing","published","cancelled","needs_review"].includes(draft.status)) throw new Error("No se puede aprobar un borrador cerrado."); validateDraft(draft);
    const future=!!draft.scheduledAt && new Date(draft.scheduledAt)>new Date(); return text(await store.updateDraft(draft_id,{status:future?"scheduled":"approved",approvedAt:new Date().toISOString(),lastError:null}));
  });
  server.registerTool("instagram_draft_publish", { title:"Publicar borrador aprobado", description:"Publica un borrador aprobado ahora. Confirma explícitamente después de revisar su vista previa.", inputSchema:{draft_id:z.string().uuid(),confirmed:z.literal(true)} ,annotations:{idempotentHint:false,openWorldHint:true}}, async ({draft_id})=>{requireScope(principal,"publish");await ownedDraft(draft_id);return text(await publishDraft(draft_id));});
  server.registerTool("instagram_draft_cancel", { title:"Cancelar borrador", description:"Cancela una publicación borrador o programada que aún no comenzó.", inputSchema:{draft_id:z.string().uuid()} }, async ({draft_id})=>{requireScope(principal,"edit");
    const d=await ownedDraft(draft_id); if(["publishing","published","needs_review"].includes(d.status)) throw new Error("No se puede cancelar una publicación que ya comenzó."); return text(await store.updateDraft(draft_id,{status:"cancelled"}));
  });
  server.registerTool("instagram_draft_retry", { title:"Reintentar publicación fallida", description:"Requiere comprobar en Instagram que no apareció la publicación original antes de reintentar.", inputSchema:{draft_id:z.string().uuid(),checked_instagram:z.literal(true),confirmed:z.literal(true)} ,annotations:{idempotentHint:false,openWorldHint:true}}, async ({draft_id})=>{requireScope(principal,"publish");
    const d=await ownedDraft(draft_id); if(d.status!=="failed"&&d.status!=="needs_review") throw new Error("Solo se pueden reintentar publicaciones fallidas o pendientes de revisión."); await store.updateDraft(draft_id,{status:"approved",approvedAt:new Date().toISOString(),lastError:null}); return text(await publishDraft(draft_id));
  });
  server.registerTool("instagram_calendar_list", { title:"Ver calendario editorial", description:"Lista las publicaciones y borradores dentro de un rango de fechas ISO 8601.", inputSchema:{workspace_id:workspaceSchema,from:z.string().datetime(),to:z.string().datetime()} }, async ({workspace_id,from,to})=>{
    if(new Date(to)<new Date(from)) throw new Error("to debe ser posterior a from."); const rows=await store.listDrafts(workspace(workspace_id)); return text(rows.filter(d=>d.scheduledAt&&d.scheduledAt>=from&&d.scheduledAt<=to));
  });
  server.registerTool("instagram_publish_history", { title:"Ver historial", description:"Consulta resultados y errores de publicaciones enviadas desde esta herramienta.", inputSchema:{workspace_id:workspaceSchema,limit:z.number().int().min(1).max(200).default(50)} }, async ({workspace_id,limit})=>text(await store.listHistory(workspace(workspace_id),limit)));

  server.registerTool("instagram_comments_inbox", { title:"Bandeja de comentarios", description:"Revisa comentarios recientes de las últimas publicaciones y los guarda localmente para triage.", inputSchema:{posts_limit:z.number().int().min(1).max(10).default(5)} }, async ({posts_limit})=>{
    const accountId=await activeAccountId(); const api=await apiFor(accountId); const posts=(await api.listMedia(posts_limit) as {data?:Array<Record<string,unknown>>}).data??[]; const results=[];
    for(const post of posts){const mediaId=String(post.id??""); if(!mediaId) continue; const response=await api.getComments(mediaId) as {data?:Array<Record<string,unknown>>}; for(const c of response.data??[]) results.push({id:String(c.id),accountId:accountId??"default",mediaId,username:String(c.username??""),text:String(c.text??""),timestamp:String(c.timestamp??new Date().toISOString()),repliedAt:null,replyText:null});}
    await store.upsertComments(results,workspace()); return text({synced:results.length,comments:await store.listComments(accountId??undefined,workspace())});
  });
  server.registerTool("instagram_comments_list", { title:"Listar comentarios guardados", description:"Consulta la bandeja local y filtra comentarios que aún no tienen respuesta registrada.", inputSchema:{pending_only:z.boolean().default(false)} }, async ({pending_only})=>{
    const rows=await store.listComments(await activeAccountId()??undefined,workspace()); return text(pending_only?rows.filter(comment=>!comment.repliedAt):rows);
  });
  server.registerTool("instagram_insights_dashboard", { title:"Resumen de rendimiento", description:"Calcula totales del contenido reciente para revisar alcance, guardados, compartidos e interacciones.", inputSchema:{posts_limit:z.number().int().min(1).max(25).default(10)} }, async ({posts_limit})=>{
    const api=await apiFor(await activeAccountId()); const posts=(await api.listMedia(posts_limit) as {data?:Array<Record<string,unknown>>}).data??[];
    const totals={posts:posts.length,reach:0,saved:0,shares:0,likes:0,comments:0}; const rows=[];
    for(const post of posts){totals.likes+=Number(post.like_count??0);totals.comments+=Number(post.comments_count??0);const id=String(post.id??"");if(!id)continue;
      const response=await api.getMediaInsights(id) as {data?:Array<{name:string;values?:Array<{value:unknown}>}>;insights?:Array<{name:string;values?:Array<{value:unknown}>}>};
      const map=new Map((response.data??response.insights??[]).map(metric=>[metric.name,Number(metric.values?.[0]?.value??0)]));
      for(const key of ["reach","saved","shares"] as const) totals[key]+=map.get(key)??0;
      rows.push({media_id:id,caption:String(post.caption??""),media_type:String(post.media_type??""),reach:map.get("reach")??0,saved:map.get("saved")??0,shares:map.get("shares")??0,likes:Number(post.like_count??0),comments:Number(post.comments_count??0)});
    }
    return text({generated_at:new Date().toISOString(),totals,posts:rows});
  });
  server.registerTool("instagram_workspaces_list", { title:"Listar espacios de trabajo", description:"Resume los espacios locales encontrados en borradores e historial. Cada workspace separa calendario e historial.", inputSchema:{} }, async ()=>{
    const ids=principal.kind==="project"?[principal.workspaceId]:await store.listWorkspaceIds(); const allDrafts=await Promise.all(ids.map(workspaceId=>store.listDrafts(workspaceId)));
    return text(ids.map((workspaceId,index)=>({workspace_id:workspaceId,drafts:allDrafts[index].length,scheduled:allDrafts[index].filter(d=>d.status==="scheduled").length})));
  });
  server.registerTool("instagram_workspace_summary", { title:"Resumen del espacio", description:"Muestra borradores, próximas publicaciones e historial de un workspace.", inputSchema:{workspace_id:workspaceSchema} }, async ({workspace_id})=>{
    const id=workspace(workspace_id); const drafts=await store.listDrafts(id); const history=await store.listHistory(id,100); return text({workspace_id:id,draft_count:drafts.length,pending_approval:drafts.filter(d=>d.status==="draft").length,scheduled:drafts.filter(d=>d.status==="scheduled").length,failed:drafts.filter(d=>d.status==="failed"||d.status==="needs_review").length,history_count:history.length,next_scheduled:drafts.filter(d=>d.status==="scheduled").slice(0,5)});
  });
  server.registerTool("instagram_insights_csv", { title:"Exportar rendimiento CSV", description:"Consulta métricas de las publicaciones recientes y devuelve un CSV listo para guardar.", inputSchema:{posts_limit:z.number().int().min(1).max(25).default(10)} }, async ({posts_limit})=>{
    const api=await apiFor(await activeAccountId()); const posts=(await api.listMedia(posts_limit) as {data?:Array<Record<string,unknown>>}).data??[]; const rows:[[string,...string[]],...Array<string[]>]=[["media_id","caption","media_type","timestamp","reach","saved","shares"]];
    for(const p of posts){const id=String(p.id??""); if(!id) continue; const metrics=await api.getMediaInsights(id) as {data?:Array<{name:string;values?:Array<{value:unknown}>}>;insights?:Array<{name:string;values?:Array<{value:unknown}>}>}; const map=new Map((metrics.data??metrics.insights??[]).map(x=>[x.name,x.values?.[0]?.value])); rows.push([id,String(p.caption??""),String(p.media_type??""),String(p.timestamp??""),String(map.get("reach")??""),String(map.get("saved")??""),String(map.get("shares")??"")]);}
    return {content:[{type:"text",text:rows.map(row=>row.map(csvCell).join(",")).join("\n")}],structuredContent:{format:"text/csv",rows:rows.length-1}};
  });
  server.registerTool("instagram_accounts_list", { title:"Listar cuentas conectadas", description:"Lista cuentas configuradas en IG_ACCOUNTS_JSON sin exponer sus tokens.", inputSchema:{} }, async ()=>{
    const active=await activeAccountId(); return text({active_account_id:active,accounts:accounts.filter(account=>account.workspaceId===workspace()).map(({id,label,username,userId,accessToken})=>({id,label,username,instagram_user_id:userId,token_configured:!!accessToken,selected:id===active}))});
  });
  server.registerTool("instagram_account_connect", { title:"Conectar cuenta de Instagram", description:"Inicia el OAuth oficial de Instagram. Requiere credenciales Meta y clave de cifrado configuradas en el servidor.", inputSchema:{} }, async ()=>{requireScope(principal,"accounts");
    return text({...await createOAuthUrl(workspace(),principal.kind==="project"?principal.actorId??null:null),open_url_to_continue:true});
  });
  server.registerTool("instagram_account_disconnect", { title:"Desconectar cuenta", description:"Elimina una cuenta OAuth y su token cifrado local. No revoca el acceso en Meta.", inputSchema:{account_id:z.string().min(1),confirmed:z.literal(true)} }, async ({account_id})=>{requireScope(principal,"accounts");
    const account=getAccount(account_id); if(!account.oauth) throw new Error("La cuenta se agregó manualmente por variables de entorno; quítala de IG_ACCOUNTS_JSON para desconectarla.");
    await store.removeConnectedAccount(account_id); const index=accounts.findIndex(a=>a.id===account_id); if(index>=0) accounts.splice(index,1); return text({success:true,account_id,meta_access_revoked:false});
  });
  server.registerTool("instagram_account_select", { title:"Cambiar cuenta activa", description:"Cambia la cuenta de Instagram usada por las próximas llamadas MCP.", inputSchema:{account_id:z.string().min(1),confirmed:z.literal(true)} }, async ({account_id})=>{requireScope(principal,"accounts");
    getAccount(account_id); await store.setActiveAccountId(workspace(),account_id); return text({success:true,active_account_id:account_id});
  });
  server.registerTool("instagram_project_context", {title:"Contexto de marca",description:"Lee nombre, logo, colores, tono y reglas de este proyecto.",inputSchema:{workspace_id:workspaceSchema}},async({workspace_id})=>text({workspace_id:workspace(workspace_id),brand_kit:await store.getBrandKit(workspace(workspace_id))}));
  server.registerTool("instagram_project_styles", {title:"Estilos de contenido",description:"Devuelve tres estilos visuales opcionales basados en logo y colores confirmados.",inputSchema:{workspace_id:workspaceSchema}},async({workspace_id})=>text(stylePresets(await store.getBrandKit(workspace(workspace_id)))));
  server.registerTool("instagram_products_search", {title:"Buscar productos",description:"Busca productos reales sincronizados desde la tienda; no inventa precios ni stock.",inputSchema:{workspace_id:workspaceSchema,query:z.string().max(100).default(""),limit:z.number().int().min(1).max(100).default(25),offset:z.number().int().min(0).default(0)}},async({workspace_id,query,limit,offset})=>text(await store.listProducts(workspace(workspace_id),query,limit,offset)));
  server.registerTool("instagram_product_content_suggest", {title:"Sugerir contenido de producto",description:"Prepara una propuesta de post o historia con datos reales del catálogo. Requiere revisión antes de publicarla.",inputSchema:{workspace_id:workspaceSchema,product_id:z.string().min(1),format:z.enum(["feed","story"]),style:z.enum(["editorial","producto","promocion"]).optional()}},async({workspace_id,product_id,format,style})=>{
    const id=workspace(workspace_id);const product=await store.getProduct(id,product_id);
    if(!product)throw new Error("No existe ese producto en el proyecto.");
    return text(suggestProductContent(product,await store.getBrandKit(id),format,style));
  });
  server.registerTool("instagram_project_assets", {title:"Archivos del proyecto",description:"Lista medios cargados y enlaces del catálogo del proyecto.",inputSchema:{workspace_id:workspaceSchema}},async({workspace_id})=>{
    const id=workspace(workspace_id); const media=await store.listMediaAssets(id); const catalog=await store.listProducts(id,"",100,0);
    return text({uploaded:media.map(({id,name,mimeType,size,fileName})=>({id,name,mime_type:mimeType,size,media_url:publicAssetUrl(fileName)})),product_images:catalog.items.flatMap(p=>p.imageUrls.map(url=>({product_id:p.id,url}))),total_products:catalog.total});
  });
  server.registerTool("instagram_upload_help", { title:"Preparar carga de archivos", description:"Devuelve la dirección del cargador de medios. En producción usa el dominio HTTPS del Core.", inputSchema:{} }, async ()=>text({upload_page:`${process.env.PUBLIC_BASE_URL||`http://localhost:${process.env.PORT||8787}`}/upload`,public_base_url_configured:!!process.env.PUBLIC_BASE_URL,requirements:["Configura PUBLIC_BASE_URL con un dominio HTTPS estable antes de publicar.","La URL temporal de medios caduca en 7 días.","Mantén el token privado."]}));
  return server;
}

async function publishDraft(id: string, scheduledRun = false) {
  const candidate=await store.getDraft(id); if(!candidate) throw new Error("No existe ese borrador.");
  validateDraft(candidate);
  const draft=await store.claimDraft(id,scheduledRun);
  try {
    const api=await apiForAccount(draft.accountId,draft.workspaceId);
    const assetNames=new Set((await store.listMediaAssets(draft.workspaceId)).map(asset=>asset.fileName));
    const mediaUrls=draft.mediaUrls.map(value=>{
      const parsed=new URL(value); const name=decodeURIComponent(parsed.pathname.replace(/^\/assets\//,""));
      return parsed.pathname.startsWith("/assets/")&&assetNames.has(name)?publicAssetUrl(name):value;
    });
    const result=draft.destination==="carousel"?await api.publishCarousel({mediaUrls,caption:draft.caption}):await api.publishMedia({mediaUrl:mediaUrls[0],assetType:draft.assetType,placement:draft.destination,caption:draft.caption});
    const mediaId=String((result.published_media as Record<string,unknown>|undefined)?.id??"")||null; const now=new Date().toISOString(); const simulated=Boolean((result as {demo?:boolean}).demo);
    await store.updateDraft(id,{status:simulated?"simulated":"published",publishedAt:simulated?null:now,publishedMediaId:mediaId,lastError:null});
    await store.addHistory({workspaceId:draft.workspaceId,accountId:draft.accountId,draftId:id,destination:draft.destination,caption:draft.caption,mediaUrls:draft.mediaUrls,mediaId,status:simulated?"demo":"published",error:null});
    return {draft_id:id,...result};
  } catch(error) {
    const message=error instanceof Error?error.message:String(error); await store.updateDraft(id,{status:"needs_review",lastError:message});
    await store.addHistory({workspaceId:draft.workspaceId,accountId:draft.accountId,draftId:id,destination:draft.destination,caption:draft.caption,mediaUrls:draft.mediaUrls,mediaId:null,status:"failed",error:message}); throw error;
  }
}

let schedulerBusy=false;
async function runScheduler() {
  if(schedulerBusy) return; schedulerBusy=true;
  try { for(const draft of await store.dueDrafts()) await publishDraft(draft.id,true).catch(error=>console.error(`Scheduled publish ${draft.id} failed:`,error instanceof Error?error.message:error)); }
  finally { schedulerBusy=false; }
}

async function readBody(req: import("node:http").IncomingMessage, maxBytes=MAX_UPLOAD_BYTES+1024*1024) {
  const chunks:Buffer[]=[]; let total=0;
  for await(const chunk of req){const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk); total+=b.length; if(total>maxBytes) throw new Error("La solicitud supera el tamaño máximo permitido."); chunks.push(b);}
  return Buffer.concat(chunks);
}
async function purgeExpiredUploads() {
  try {
    const now=Date.now();
    for(const name of await readdir(UPLOAD_DIR)){
      if(!/^[-a-f0-9]{36}\.(jpg|jpeg|png|webp|mp4|mov)$/i.test(name)) continue;
      const info=await stat(join(UPLOAD_DIR,name)); if(now-info.mtimeMs>8*24*60*60*1000) await unlink(join(UPLOAD_DIR,name));
    }
  } catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT") console.error("Upload cleanup failed:",error); }
}
async function handleUpload(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, principal:Principal) {
  requireScope(principal,"edit");
  const body=await readBody(req); const request=new Request(`http://${req.headers.host}/upload`,{method:"POST",headers:req.headers as HeadersInit,body});
  const form=await request.formData(); const input=form.get("file");
  if(!(input instanceof File)){res.writeHead(400);res.end(JSON.stringify({error:"Selecciona un archivo."}));return;}
  if(!["image/jpeg","image/png","image/webp","video/mp4","video/quicktime"].includes(input.type)){res.writeHead(415);res.end(JSON.stringify({error:"Formatos: JPG, PNG, WEBP, MP4 o MOV."}));return;}
  if(input.size>MAX_UPLOAD_BYTES){res.writeHead(413);res.end(JSON.stringify({error:`Máximo ${Math.floor(MAX_UPLOAD_BYTES/1024/1024)} MB.`}));return;}
  const workspaceId=resolveWorkspace(principal);const id=randomUUID(); const ext=({"image/jpeg":".jpg","image/png":".png","image/webp":".webp","video/mp4":".mp4","video/quicktime":".mov"} as Record<string,string>)[input.type]; const fileName=`${id}${ext}`;const bytes=Buffer.from(await input.arrayBuffer());
  if(!mediaSignatureMatches(bytes,input.type)){sendJson(res,415,{error:"El contenido no coincide con el formato declarado."});return;}
  if(mediaStorage)await mediaStorage.upload(workspaceId,fileName,bytes,input.type);
  else {await mkdir(UPLOAD_DIR,{recursive:true,mode:0o700});await writeFile(join(UPLOAD_DIR,fileName),bytes,{mode:0o600});}
  try{await store.addMediaAsset({id,workspaceId,name:input.name,mimeType:input.type,size:input.size,fileName,createdAt:new Date().toISOString()});}
  catch(error){if(mediaStorage)await mediaStorage.remove(workspaceId,fileName);else await unlink(join(UPLOAD_DIR,fileName));throw error;}
  res.writeHead(201,{"content-type":"application/json","cache-control":"no-store"}); res.end(JSON.stringify({id,name:input.name,mime_type:input.type,size:input.size,media_url:publicAssetUrl(`${id}${ext}`),expires_in_days:7}));
}
function sendJson(res:import("node:http").ServerResponse,status:number,value:unknown) {
  res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});res.end(JSON.stringify(value));
}
async function handleProjectApi(req:import("node:http").IncomingMessage,res:import("node:http").ServerResponse,url:URL,principal:Principal) {
  const match=url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]{1,64})\/(brand|products|assets|styles|accounts|oauth|drafts|history)(?:\/([^/]+))?(?:\/(approve|publish|cancel|retry|select|disconnect))?$/);
  if(!match){sendJson(res,404,{error:"No existe la ruta."});return;}
  if(principal.kind==="project"&&principal.workspaceId!==match[1]){sendJson(res,403,{error:"Este token no tiene acceso a ese proyecto."});return;}
  const workspaceId=resolveWorkspace(principal,match[1]); const resource=match[2]; const itemId=match[3]?decodeURIComponent(match[3]):null; const action=match[4]??null;
  const scope=req.method==="GET"?"read":resource==="accounts"||resource==="oauth"?"accounts":action==="approve"?"approve":action==="publish"||action==="retry"?"publish":"edit";
  try{requireScope(principal,scope);}catch{return sendJson(res,403,{error:`Este token no permite ${scope}.`});}
  if(itemId&&!["products","accounts","drafts"].includes(resource)){sendJson(res,404,{error:"No existe la ruta."});return;}
  const ownedDraft=async()=>{
    if(!itemId) throw new Error("Falta el ID del borrador.");
    const draft=await store.getDraft(itemId);
    if(!draft||draft.workspaceId!==workspaceId) throw new Error("No existe ese borrador en este proyecto.");
    return draft;
  };
  if(req.method==="GET") {
    if(resource==="brand") return sendJson(res,200,{workspace_id:workspaceId,brand_kit:await store.getBrandKit(workspaceId)});
    if(resource==="styles") return sendJson(res,200,{items:stylePresets(await store.getBrandKit(workspaceId))});
    if(resource==="accounts") {
      const active=await activeAccountIdFor(workspaceId);
      return sendJson(res,200,{active_account_id:active,items:accounts.filter(a=>a.workspaceId===workspaceId).map(({id,label,username,userId})=>({id,label,username,instagram_user_id:userId}))});
    }
    if(resource==="drafts") return sendJson(res,200,itemId?await ownedDraft():{items:await store.listDrafts(workspaceId)});
    if(resource==="history") return sendJson(res,200,{items:await store.listHistory(workspaceId,Math.min(200,Math.max(1,Number(url.searchParams.get("limit"))||50)))});
    if(resource==="products"&&itemId) {
      const product=await store.getProduct(workspaceId,itemId);
      if(!product)return sendJson(res,404,{error:"No existe ese producto."});
      const format=url.searchParams.get("format")==="story"?"story":"feed";
      const requestedStyle=url.searchParams.get("style");
      const style=requestedStyle==="editorial"||requestedStyle==="producto"||requestedStyle==="promocion"?requestedStyle:undefined;
      return sendJson(res,200,{suggestion:suggestProductContent(product,await store.getBrandKit(workspaceId),format,style)});
    }
    if(resource==="products") return sendJson(res,200,await store.listProducts(workspaceId,url.searchParams.get("query")??"",Math.min(100,Math.max(1,Number(url.searchParams.get("limit"))||25)),Math.max(0,Number(url.searchParams.get("offset"))||0)));
    const assets=await store.listMediaAssets(workspaceId);
    if(resource!=="assets"){sendJson(res,405,{error:"Método no permitido."});return;}
    return sendJson(res,200,{items:assets.map(asset=>({id:asset.id,name:asset.name,mime_type:asset.mimeType,size:asset.size,media_url:publicAssetUrl(asset.fileName)}))});
  }
  if(req.method==="DELETE"&&resource==="products"&&itemId) return sendJson(res,200,await store.removeProduct(workspaceId,itemId));
  if(!["PUT","POST","PATCH"].includes(req.method??"")){sendJson(res,405,{error:"Método no permitido."});return;}
  if(!req.headers["content-type"]?.startsWith("application/json")){sendJson(res,415,{error:"Se requiere application/json."});return;}
  let payload:unknown;
  try { payload=JSON.parse((await readBody(req,1024*1024)).toString("utf8")); }
  catch {sendJson(res,400,{error:"JSON inválido o demasiado grande."});return;}
  if(resource==="brand"&&req.method==="PUT"&&!itemId) return sendJson(res,200,{workspace_id:workspaceId,brand_kit:await store.setBrandKit(workspaceId,brandKitSchema.parse(payload))});
  if(resource==="products"&&req.method==="PUT"&&!itemId) {
    const batch=productsBatchSchema.parse(payload);
    return sendJson(res,200,await store.upsertProducts(workspaceId,batch.products.map(product=>({...product,updatedAt:new Date().toISOString()}))));
  }
  if(resource==="oauth"&&req.method==="POST"&&!itemId) return sendJson(res,200,await createOAuthUrl(workspaceId,principal.kind==="project"?principal.actorId??null:null));
  if(resource==="accounts"&&req.method==="POST"&&itemId) {
    const account=getAccountFor(itemId,workspaceId);
    if(z.object({confirmed:z.literal(true)}).parse(payload)) {
      if(action==="select"){await store.setActiveAccountId(workspaceId,account.id);return sendJson(res,200,{active_account_id:account.id});}
      if(action==="disconnect"&&account.oauth){await store.removeConnectedAccount(account.id);const index=accounts.findIndex(a=>a.id===account.id);if(index>=0)accounts.splice(index,1);return sendJson(res,200,{disconnected:true});}
    }
  }
  if(resource==="drafts"&&req.method==="POST"&&!itemId) {
    const input=draftInputSchema.parse(payload);const mediaUrls=normalizeUrls(input.media_urls);
    validateDraft({mediaUrls,assetType:input.asset_type,destination:input.destination,caption:input.caption});
    if(input.scheduled_at&&new Date(input.scheduled_at)<=new Date())throw new Error("La fecha programada debe estar en el futuro.");
    const accountId=await activeAccountIdFor(workspaceId);if(!accountId)throw new Error("Conecta una cuenta de Instagram al proyecto.");
    return sendJson(res,201,await store.createDraft({workspaceId,accountId,mediaUrls,assetType:input.asset_type,destination:input.destination,caption:input.caption,scheduledAt:input.scheduled_at}));
  }
  if(resource==="drafts"&&itemId) {
    const draft=await ownedDraft();
    if(req.method==="PATCH"&&!action) {
      if(["publishing","published","cancelled","needs_review"].includes(draft.status))throw new Error("Ese borrador ya no admite cambios.");
      const input=draftInputSchema.partial().parse(payload);
      const mediaUrls=input.media_urls?normalizeUrls(input.media_urls):draft.mediaUrls;
      const candidate={mediaUrls,assetType:input.asset_type??draft.assetType,destination:input.destination??draft.destination,caption:input.caption??draft.caption};
      validateDraft(candidate);
      if(input.scheduled_at&&new Date(input.scheduled_at)<=new Date())throw new Error("La fecha programada debe estar en el futuro.");
      return sendJson(res,200,await store.updateDraft(itemId,{...candidate,...("scheduled_at" in input?{scheduledAt:input.scheduled_at}:{}),status:"draft",approvedAt:null}));
    }
    if(req.method==="POST"&&action) {
      const control=z.object({confirmed:z.literal(true),checked_instagram:z.literal(true).optional()}).strict().parse(payload);
      if(action==="approve") {
        if(["publishing","published","cancelled","needs_review"].includes(draft.status))throw new Error("No se puede aprobar este borrador.");
        validateDraft(draft);
        const scheduled=!!draft.scheduledAt&&new Date(draft.scheduledAt)>new Date();
        return sendJson(res,200,await store.updateDraft(itemId,{status:scheduled?"scheduled":"approved",approvedAt:new Date().toISOString(),lastError:null}));
      }
      if(action==="publish") return sendJson(res,200,await publishDraft(itemId));
      if(action==="cancel") {
        if(["publishing","published","needs_review"].includes(draft.status))throw new Error("No se puede cancelar este borrador.");
        return sendJson(res,200,await store.updateDraft(itemId,{status:"cancelled"}));
      }
      if(action==="retry") {
        if(!control.checked_instagram||!["failed","needs_review"].includes(draft.status))throw new Error("Comprueba primero que no esté publicado en Instagram.");
        await store.updateDraft(itemId,{status:"approved",approvedAt:new Date().toISOString(),lastError:null});
        return sendJson(res,200,await publishDraft(itemId));
      }
    }
  }
  return sendJson(res,405,{error:"Método no permitido."});
}
async function handleOAuthCallback(url: URL, res: import("node:http").ServerResponse) {
  const state=url.searchParams.get("state")??""; const pending=/^[0-9a-f-]{36}$/i.test(state)?await store.consumeOAuthState(state):null;
  if(!pending){res.writeHead(400,{"content-type":"text/html; charset=utf-8"});res.end("<h1>Conexión vencida</h1><p>Vuelve a iniciar instagram_account_connect desde Claude.</p>");return;}
  const code=url.searchParams.get("code"); const metaError=url.searchParams.get("error_description")||url.searchParams.get("error_reason");
  if(!code||metaError){res.writeHead(400,{"content-type":"text/html; charset=utf-8"});res.end("<h1>Meta no autorizó la conexión</h1><p>Revisa los permisos de la app y vuelve a intentarlo.</p>");return;}
  const clientId=process.env.IG_CLIENT_ID!; const clientSecret=process.env.IG_CLIENT_SECRET!; const redirect=process.env.OAUTH_REDIRECT_URI!;
  try {
    const shortResponse=await fetch("https://api.instagram.com/oauth/access_token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,grant_type:"authorization_code",redirect_uri:redirect,code})});
    const shortData=await shortResponse.json() as {access_token?:string;user_id?:string;error_message?:string};
    if(!shortResponse.ok||!shortData.access_token) throw new Error(shortData.error_message??"Intercambio OAuth rechazado.");
    const longUrl=new URL("https://graph.instagram.com/access_token"); longUrl.searchParams.set("grant_type","ig_exchange_token");longUrl.searchParams.set("client_secret",clientSecret);longUrl.searchParams.set("access_token",shortData.access_token);
    const longResponse=await fetch(longUrl); const longData=await longResponse.json() as {access_token?:string;expires_in?:number};
    if(!longResponse.ok||!longData.access_token) throw new Error("No se pudo obtener un token de larga duración.");
    const profileUrl=new URL(`https://graph.instagram.com/${process.env.IG_GRAPH_VERSION||"v25.0"}/me`);profileUrl.searchParams.set("fields","user_id,username");
    const profileResponse=await fetch(profileUrl,{headers:{authorization:`Bearer ${longData.access_token}`}}); const profile=await profileResponse.json() as {user_id?:string;id?:string;username?:string};
    if(!profileResponse.ok||!(profile.user_id||profile.id)) throw new Error("No se pudo leer el perfil profesional autorizado.");
    const id=String(profile.user_id??profile.id); const expiresAt=new Date(Date.now()+(longData.expires_in??5_184_000)*1000).toISOString();
    if(accounts.some(item=>item.id===id&&item.workspaceId!==pending.workspaceId)) throw new Error("Esta cuenta ya pertenece a otro proyecto. Desconéctala allí antes de moverla.");
    await store.saveConnectedAccount({id,workspaceId:pending.workspaceId,label:profile.username?`@${profile.username}`:id,username:profile.username,userId:id,encryptedToken:encryptToken(longData.access_token),expiresAt,connectedAt:new Date().toISOString()});
    const account:AccountConfig={id,workspaceId:pending.workspaceId,label:profile.username?`@${profile.username}`:id,username:profile.username,userId:id,accessToken:longData.access_token,graphVersion:process.env.IG_GRAPH_VERSION||"v25.0",expiresAt,oauth:true};
    const existing=accounts.findIndex(item=>item.id===id); if(existing>=0) accounts[existing]=account; else accounts.push(account);
    await store.setActiveAccountId(pending.workspaceId,id);
    res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}); res.end(`<meta name="viewport" content="width=device-width"><title>Instagram conectado</title><main style="font:16px system-ui;max-width:560px;margin:12vh auto;padding:24px"><h1>Instagram conectado</h1><p>La cuenta @${String(profile.username??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]!))} ya está lista en IG Toolkit Libre. Puedes cerrar esta pestaña y volver a Claude.</p></main>`);
  } catch(error) {
    console.error("Instagram OAuth callback failed:",error instanceof Error?error.message:error);
    res.writeHead(400,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});res.end("<meta name=\"viewport\" content=\"width=device-width\"><h1>No se pudo conectar Instagram</h1><p>Revisa la configuración OAuth de Meta y el callback configurado en el servidor.</p>");
  }
}

const uploadPage=`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IG Toolkit · Cargar medio</title><style>body{font:16px system-ui;background:#111;color:#f5f5f5;max-width:680px;margin:8vh auto;padding:24px}main{background:#1b1b20;border:1px solid #333;border-radius:18px;padding:26px}h1{margin-top:0}p{color:#bbb}input,button{font:inherit;padding:12px;border-radius:9px}input{width:100%;box-sizing:border-box;background:#111;color:white;border:1px solid #444;margin:12px 0}button{background:#8b5cf6;color:white;border:0;cursor:pointer}textarea{width:100%;min-height:85px;background:#111;color:white;border:1px solid #444;border-radius:9px;padding:12px;box-sizing:border-box}pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#c4b5fd}small{color:#aaa}</style><main><h1>Cargar contenido</h1><p>Sube una imagen o video. El enlace temporal permite que Meta descargue el archivo para publicar.</p><label>Token MCP <input id="token" type="password" autocomplete="off" placeholder="MCP_BEARER_TOKEN"></label><label>Archivo <input id="file" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime"></label><button id="send" type="button">Subir archivo</button><p id="status" aria-live="polite"></p><label>URL para pegar en el borrador <textarea id="url" readonly></textarea></label><small>Máximo: ${Math.floor(MAX_UPLOAD_BYTES/1024/1024)} MB. El archivo y su URL expiran en 7 días.</small><pre id="error" role="alert"></pre></main><script>document.getElementById('send').addEventListener('click',async()=>{const file=document.getElementById('file').files[0],token=document.getElementById('token').value,status=document.getElementById('status'),out=document.getElementById('url'),err=document.getElementById('error');err.textContent='';out.value='';if(!file||!token){err.textContent='Ingresa el token y selecciona un archivo.';return}status.textContent='Subiendo…';try{const r=await fetch('/upload',{method:'POST',headers:{Authorization:'Bearer '+token},body:(()=>{const f=new FormData();f.append('file',file);return f})()});const d=await r.json();if(!r.ok)throw new Error(d.error||'No se pudo subir el archivo');out.value=d.media_url;status.textContent='Carga completa. Copia el enlace en un borrador.'}catch(e){status.textContent='';err.textContent=e.message}})</script></html>`;

const sessions = new Map<string, {transport:StreamableHTTPServerTransport;principal:Principal}>();
const port = Number(process.env.PORT || 8787);
const a2a=createA2A(process.env.PUBLIC_BASE_URL||`http://localhost:${port}`,`http://localhost:${port}`);
const http = createServer(async (req,res)=>{
  try {
    const url=new URL(req.url??"/",`http://${req.headers.host??"localhost"}`);
    if(req.method==="GET"&&(url.pathname==="/"||url.pathname==="/upload")){res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});res.end(uploadPage);return;}
    if(req.method==="GET"&&url.pathname==="/oauth/instagram/callback"){await handleOAuthCallback(url,res);return;}
    if(req.method==="GET"&&url.pathname.startsWith("/assets/")){
      const id=decodeURIComponent(url.pathname.slice("/assets/".length)); const expires=url.searchParams.get("expires")??""; const token=url.searchParams.get("token")??"";
      if(!/^[-a-f0-9]{36}\.(jpg|jpeg|png|webp|mp4|mov)$/i.test(id)||!/^\d+$/.test(expires)||Number(expires)<Date.now()){res.writeHead(404);res.end("Not found");return;}
      const expected=Buffer.from(assetSignature(id,expires)); const supplied=Buffer.from(token); if(expected.length!==supplied.length||!timingSafeEqual(expected,supplied)){res.writeHead(404);res.end("Not found");return;}
      if(mediaStorage){const asset=await store.getMediaAssetByFilename(id);if(!asset){res.writeHead(404);res.end("Not found");return;}const bytes=await mediaStorage.download(asset.workspaceId,id);res.writeHead(200,{"content-type":asset.mimeType,"content-length":bytes.length,"cache-control":"public, max-age=3600"});res.end(bytes);return;}
      const file=join(UPLOAD_DIR,id); const info=await stat(file); if(!info.isFile()){res.writeHead(404);res.end("Not found");return;}
      res.writeHead(200,{"content-type":({".jpg":"image/jpeg",".jpeg":"image/jpeg",".png":"image/png",".webp":"image/webp",".mp4":"video/mp4",".mov":"video/quicktime"} as Record<string,string>)[extname(id).toLowerCase()]??"application/octet-stream","content-length":info.size,"cache-control":"public, max-age=3600"}); await pipeline(createReadStream(file),res); return;
    }
    if(url.pathname==="/health"){sendJson(res,200,{ok:true,mode:baseEnv.mockMode?"demo":"instagram"});return;}
    if(req.method==="GET"&&url.pathname==="/.well-known/agent-card.json"){sendJson(res,200,a2a.card);return;}
    if(url.pathname!=="/mcp"&&url.pathname!=="/upload"&&url.pathname!=="/a2a"&&!url.pathname.startsWith("/api/projects/")){res.writeHead(404);res.end("Not found");return;}
    const principal=authenticate(req.headers.authorization,credentials,projectSigningKey);
    if(!principal){res.writeHead(401,{"www-authenticate":"Bearer"});res.end("Unauthorized");return;}
    if(url.pathname==="/a2a") {
      requireScope(principal,"read");
      if(req.method!=="POST"){sendJson(res,405,{error:"Método no permitido."});return;}
      if(req.headers["a2a-version"]!=="1.0"){sendJson(res,400,{error:"A2A-Version 1.0 requerido."});return;}
      let body:unknown;try{body=JSON.parse((await readBody(req,1024*1024)).toString("utf8"));}catch{sendJson(res,400,{error:"JSON inválido."});return;}
      const token=req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1]??"";
      const response=await a2a.handle(body,principal,token);
      if(typeof response==="object"&&response!==null&&Symbol.asyncIterator in response){sendJson(res,400,{error:"Streaming A2A no está disponible."});return;}
      sendJson(res,200,response);return;
    }
    const tokenRoute=url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]{1,64})\/token$/);
    if(tokenRoute) {
      if(principal.kind!=="owner"){sendJson(res,403,{error:"Solo el servidor administrador puede emitir credenciales."});return;}
      if(req.method!=="POST"){sendJson(res,405,{error:"Método no permitido."});return;}
      if(!projectSigningKey){sendJson(res,503,{error:"Configura PROJECT_TOKEN_SIGNING_KEY."});return;}
      const raw=(await readBody(req,1024*16)).toString("utf8");let data:unknown;
      try {data=JSON.parse(raw);}catch {sendJson(res,400,{error:"JSON inválido."});return;}
      const input=z.object({actor_id:z.string().min(1).max(128),ttl_seconds:z.number().int().min(60).max(900).default(900),scopes:z.array(z.enum(projectScopes)).default([...projectScopes])}).strict().parse(data);
      sendJson(res,200,{workspace_id:tokenRoute[1],token:issueProjectToken(projectSigningKey,tokenRoute[1],input.actor_id,input.ttl_seconds,Date.now(),input.scopes),scopes:input.scopes,expires_in_seconds:input.ttl_seconds});return;
    }
    if(req.method==="POST"&&url.pathname==="/upload"){await handleUpload(req,res,principal);await store.audit(resolveWorkspace(principal),principal.kind==="project"?principal.actorId??null:null,"asset.upload",null,"success");return;}
    if(url.pathname.startsWith("/api/projects/")){
      await handleProjectApi(req,res,url,principal);
      if(req.method!=="GET"&&res.statusCode>=200&&res.statusCode<300){const match=url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]{1,64})\/(\w+)(?:\/([^/]+))?(?:\/(\w+))?$/);if(match)await store.audit(resolveWorkspace(principal,match[1]),principal.kind==="project"?principal.actorId??null:null,`${match[2]}.${match[4]??req.method?.toLowerCase()}`,match[3]??null,"success");}
      return;
    }
    requireScope(principal,"read");
    const sessionId=req.headers["mcp-session-id"] as string|undefined; const existing=sessionId?sessions.get(sessionId):undefined;
    if(existing && (existing.principal.kind!==principal.kind||existing.principal.workspaceId!==principal.workspaceId||(existing.principal.kind==="project"?existing.principal.actorId:undefined)!==(principal.kind==="project"?principal.actorId:undefined)||JSON.stringify(existing.principal.kind==="project"?existing.principal.scopes:null)!==JSON.stringify(principal.kind==="project"?principal.scopes:null))){sendJson(res,403,{error:"La sesión pertenece a otro proyecto o usuario."});return;}
    let transport=existing?.transport;
    if(!transport&&req.method==="POST"&&!sessionId){const server=makeServer(principal);transport=new StreamableHTTPServerTransport({sessionIdGenerator:()=>randomUUID(),onsessioninitialized:id=>{sessions.set(id,{transport:transport!,principal});}});transport.onclose=()=>{if(transport?.sessionId)sessions.delete(transport.sessionId);};await server.connect(transport);}
    if(!transport){res.writeHead(400,{"content-type":"application/json"});res.end(JSON.stringify({jsonrpc:"2.0",error:{code:-32000,message:"Unknown or missing session"},id:null}));return;}
    await transport.handleRequest(req,res);
  } catch(error) { console.error("Request failed:",error instanceof Error?error.message:error); if(!res.headersSent)sendJson(res,error instanceof z.ZodError?400:500,{error:error instanceof z.ZodError?"Datos inválidos.":error instanceof Error?error.message:"Internal server error"}); else res.destroy(); }
});
await store.recoverInterruptedPublishes();
setInterval(()=>void (async()=>{if(store instanceof PostgresStore)await store.recoverInterruptedPublishes();await runScheduler();})().catch(error=>console.error("Scheduler:",error)),30_000).unref();
setInterval(()=>void purgeExpiredUploads(),60*60*1000).unref();
void purgeExpiredUploads();
http.listen(port,"0.0.0.0",()=>console.log(`Instagram MCP listening on http://localhost:${port}/mcp (${baseEnv.mockMode?"demo mode":"Instagram mode"}); ${accounts.length} account(s)`));
