import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authenticate, issueProjectToken, loadCredentials, resolveWorkspace, requireScope } from "../src/tenant.js";
import { executeStudioAction } from "../src/host-handler.js";
import { brandKitSchema, productsBatchSchema } from "../src/integration.js";
import { LocalStore } from "../src/store.js";
import { InstagramAdminClient, InstagramProjectClient } from "../src/client.js";
import { suggestProductContent } from "../src/creative.js";

const ownerToken="o".repeat(64);
const worldToken="w".repeat(64);
const naniToken="n".repeat(64);
const signingKey="s".repeat(64);

test("project credentials cannot select another workspace and duplicate secrets fail",()=>{
  const credentials=loadCredentials({MCP_BEARER_TOKEN:ownerToken,PROJECT_TOKENS_JSON:JSON.stringify({worldcase:worldToken,nanisports:naniToken})});
  const principal=authenticate(`Bearer ${worldToken}`,credentials)!;
  assert.equal(resolveWorkspace(principal),"worldcase");
  assert.throws(()=>resolveWorkspace(principal,"nanisports"),/no tiene acceso/);
  assert.equal(resolveWorkspace(authenticate(`Bearer ${ownerToken}`,credentials)!,"nanisports"),"nanisports");
  assert.equal(authenticate("Bearer unknown",credentials),null);
  assert.throws(()=>loadCredentials({MCP_BEARER_TOKEN:ownerToken,PROJECT_TOKENS_JSON:JSON.stringify({worldcase:ownerToken})}),/distintos/);
});

test("signed shop tokens are scoped, tamper resistant and expire",()=>{
  const credentials=loadCredentials({MCP_BEARER_TOKEN:ownerToken});
  const token=issueProjectToken(signingKey,"shop_42","merchant:42");
  const principal=authenticate(`Bearer ${token}`,credentials,signingKey)!;
  assert.equal(resolveWorkspace(principal),"shop_42");
  assert.equal(principal.kind==="project"&&principal.actorId,"merchant:42");
  assert.throws(()=>resolveWorkspace(principal,"shop_43"),/no tiene acceso/);
  assert.equal(authenticate(`Bearer ${token.slice(0,-1)}x`,credentials,signingKey),null);
  const expired=issueProjectToken(signingKey,"shop_42","merchant:42",60,Date.now()-120_000);
  assert.equal(authenticate(`Bearer ${expired}`,credentials,signingKey),null);
});

test("short-lived role tokens and studio action dispatcher enforce permissions",async()=>{
  const token=issueProjectToken(signingKey,"shop_42","editor",900,Date.now(),["read","edit"]);
  const principal=authenticate(`Bearer ${token}`,[],signingKey)!;
  requireScope(principal,"edit");
  assert.throws(()=>requireScope(principal,"publish"),/no permite publish/);
  assert.throws(()=>requireScope(principal,"accounts"),/no permite accounts/);
  const calls:string[]=[];
  const fake={listDrafts:async()=>{calls.push("list");return {items:[]}},publishDraft:async()=>{calls.push("publish")}} as unknown as InstagramProjectClient;
  assert.deepEqual(await executeStudioAction(fake,{action:"listDrafts",args:[]},["read"]),{items:[]});
  await assert.rejects(executeStudioAction(fake,{action:"publishDraft",args:["11111111-1111-4111-8111-111111111111"]},["read"]),/permiso de publish/);
  assert.deepEqual(calls,["list"]);
});

test("brand and catalog inputs reject invented or unsafe values",()=>{
  assert.throws(()=>brandKitSchema.parse({businessName:"Tienda",logoUrl:"javascript:alert(1)"}));
  assert.throws(()=>productsBatchSchema.parse({products:[{id:"1",name:"Funda",price:-1,imageUrls:[]}]}));
  assert.equal(brandKitSchema.parse({businessName:" World Case ",colors:{primary:"#31243A"}}).businessName,"World Case");
});

test("product suggestions use confirmed brand and catalog facts",()=>{
  const suggestion=suggestProductContent({id:"1",name:"Funda UV",imageUrls:["https://example.com/funda.jpg"],availability:"unknown",updatedAt:"2026-09-29"},{
    businessName:"World Case",logoUrl:"https://example.com/logo.png",colors:{primary:"#31243A"},preferredStyle:"editorial"
  },"story");
  assert.equal(suggestion.style.id,"editorial");
  assert.equal(suggestion.canvas.height,1920);
  assert.equal(suggestion.price,null);
  assert.doesNotMatch(suggestion.caption,/gratis|oferta|\$/i);
  assert.throws(()=>suggestProductContent({id:"2",name:"Agotado",imageUrls:["https://example.com/a.jpg"],availability:"unavailable",updatedAt:"2026-09-29"},null,"feed"),/no disponible/);
});

test("claim is atomic and interrupted publications require review",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ig-claims-"));
  try {
    const store=new LocalStore(dir);
    const draft=await store.createDraft({workspaceId:"worldcase",accountId:"ig-w",mediaUrls:["https://example.com/a.jpg"],assetType:"image",destination:"feed",caption:"Hola",scheduledAt:null});
    await store.updateDraft(draft.id,{status:"approved",approvedAt:new Date().toISOString()});
    const attempts=await Promise.allSettled([store.claimDraft(draft.id,false),store.claimDraft(draft.id,false)]);
    assert.equal(attempts.filter(result=>result.status==="fulfilled").length,1);
    assert.equal(attempts.filter(result=>result.status==="rejected").length,1);
    assert.equal(await store.recoverInterruptedPublishes(),1);
    assert.equal((await store.getDraft(draft.id))?.status,"needs_review");
  } finally {await rm(dir,{recursive:true,force:true});}
});

async function freePort() {
  const server=createServer();
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address(); if(!address||typeof address==="string") throw new Error("No TCP port");
  const port=address.port; await new Promise<void>(resolve=>server.close(()=>resolve()));
  return port;
}

test("project bridge persists only its own brand and products",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"ig-project-api-"));
  const port=await freePort();
  const baseUrl=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,["dist/src/index.js"],{cwd:process.cwd(),env:{
    ...process.env,PORT:String(port),DATA_DIR:dir,MOCK_MODE:"true",MCP_BEARER_TOKEN:ownerToken,
    PROJECT_TOKENS_JSON:JSON.stringify({worldcase:worldToken,nanisports:naniToken}),
    PROJECT_TOKEN_SIGNING_KEY:signingKey,
    ASSET_SIGNING_SECRET:"s".repeat(64),PUBLIC_BASE_URL:"https://media.example.test",
    IG_ACCOUNTS_JSON:JSON.stringify([{id:"world-ig",workspace_id:"worldcase",ig_user_id:"world-demo",access_token:"test-token"}])
  },stdio:"ignore"});
  t.after(async()=>{child.kill();await new Promise<void>(resolve=>child.once("exit",()=>resolve()));await rm(dir,{recursive:true,force:true});});
  let ready=false;
  for(let attempt=0;attempt<60;attempt++) {
    if(child.exitCode!==null) throw new Error("El servidor de prueba terminó inesperadamente.");
    try {const response=await fetch(`${baseUrl}/health`);if(response.ok){ready=true;break;}} catch {/* waiting for listener */}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(ready,true);
  const cardResponse=await fetch(`${baseUrl}/.well-known/agent-card.json`);
  const card=await cardResponse.json() as {supportedInterfaces:Array<{protocolVersion:string}>};
  assert.equal(card.supportedInterfaces[0]?.protocolVersion,"1.0");
  const a2a=async(token:string,action:object)=>fetch(`${baseUrl}/a2a`,{method:"POST",headers:{authorization:`Bearer ${token}`,"a2a-version":"1.0","content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"SendMessage",params:{message:{messageId:"msg-1",role:"ROLE_USER",parts:[{data:action}]}}})});
  const a2aDenied=await a2a("invalid",{action:"brand.get"});assert.equal(a2aDenied.status,401);
  const world=new InstagramProjectClient({baseUrl,token:worldToken,workspaceId:"worldcase"});
  const nani=new InstagramProjectClient({baseUrl,token:naniToken,workspaceId:"nanisports"});
  const admin=new InstagramAdminClient({baseUrl,ownerToken});
  const shop=await admin.forProject("conecta_shop_42","merchant:42");
  await shop.syncBrand({businessName:"Tienda Conecta 42"});
  assert.equal((await shop.getBrand()).brand_kit?.businessName,"Tienda Conecta 42");
  const viewer=await admin.forProject("conecta_shop_42","viewer:7",["read"]);
  assert.equal((await viewer.getBrand()).brand_kit?.businessName,"Tienda Conecta 42");
  await assert.rejects(viewer.syncBrand({businessName:"Intrusión"}),/no permite edit/);
  await assert.rejects(viewer.startInstagramOAuth(),/no permite accounts/);
  assert.equal((await world.getBrand()).brand_kit,null);
  await assert.rejects(()=>admin.forProject("bad/shop","actor"),/workspace_id/);
  const deniedMint=await fetch(`${baseUrl}/api/projects/shop_43/token`,{method:"POST",headers:{authorization:`Bearer ${worldToken}`,"content-type":"application/json"},body:JSON.stringify({actor_id:"merchant:42"})});
  assert.equal(deniedMint.status,403);
  assert.equal((await world.listAccounts()).items.length,1);
  assert.equal((await nani.listAccounts()).items.length,0);
  await world.syncBrand({businessName:"World Case",logoUrl:"https://worldcaseuy.com/logo.png",colors:{primary:"#31243A"}});
  await world.upsertProducts([{id:"case-1",name:"Funda personalizada",price:990,currency:"UYU",imageUrls:["https://worldcaseuy.com/case.jpg"],availability:"available"}]);
  assert.equal((await world.getBrand()).brand_kit?.businessName,"World Case");
  const a2aWorld=await a2a(worldToken,{action:"brand.get"});
  assert.equal(a2aWorld.status,200);
  const a2aResult=await a2aWorld.json() as {result?:{task?:{id:string;status:{state:string}}}};
  assert.equal(a2aResult.result?.task?.status.state,"TASK_STATE_COMPLETED");
  assert.match(JSON.stringify(a2aResult),/World Case/);
  const a2aNani=await a2a(naniToken,{action:"brand.get"});
  assert.doesNotMatch(await a2aNani.text(),/World Case/);
  const crossTask=await fetch(`${baseUrl}/a2a`,{method:"POST",headers:{authorization:`Bearer ${naniToken}`,"a2a-version":"1.0","content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:2,method:"GetTask",params:{id:a2aResult.result?.task?.id}})});
  assert.match(await crossTask.text(),/error/i);
  assert.equal((await world.searchProducts("funda")).total,1);
  assert.equal((await world.listStyles()).items[0].foreground,"#31243A");
  const suggestion=(await world.suggestProduct("case-1","story")).suggestion;
  assert.equal(suggestion.title,"Funda personalizada");
  assert.equal(suggestion.reviewRequired,true);
  assert.equal((await nani.getBrand()).brand_kit,null);
  assert.equal((await nani.searchProducts("funda")).total,0);
  const uploaded=await world.uploadAsset(new Blob([Buffer.from([137,80,78,71,13,10,26,10,0])],{type:"image/png"}),"funda.png");
  assert.match(uploaded.media_url,/^https:\/\/media\.example\.test\/assets\//);
  assert.equal((await world.listAssets()).items.length,1);
  assert.equal((await nani.listAssets()).items.length,0);
  const draft=await world.createDraft({media_urls:[uploaded.media_url],asset_type:"image",destination:"story",caption:"Funda UV"});
  assert.equal(draft.status,"draft");
  assert.equal((await world.approveDraft(draft.id)).status,"approved");
  assert.equal((await nani.listDrafts()).items.length,0);
  await world.publishDraft(draft.id);
  assert.equal((await world.listDrafts()).items[0]?.status,"simulated");
  assert.equal((await world.listHistory()).items.length,1);
  const denied=await fetch(`${baseUrl}/api/projects/worldcase/brand`,{headers:{authorization:`Bearer ${naniToken}`}});
  assert.equal(denied.status,403);
  const unauthorized=await fetch(`${baseUrl}/api/projects/worldcase/products`);
  assert.equal(unauthorized.status,401);
  const bad=await fetch(`${baseUrl}/api/projects/worldcase/products`,{method:"PUT",headers:{authorization:`Bearer ${worldToken}`,"content-type":"application/json"},body:JSON.stringify({products:[{id:"x",name:"Invalid",price:-20,imageUrls:[]}]})});
  assert.equal(bad.status,400);
  const initialized=await fetch(`${baseUrl}/mcp`,{method:"POST",headers:{authorization:`Bearer ${worldToken}`,"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"test",version:"1"}}})});
  assert.equal(initialized.status,200);
  const session=initialized.headers.get("mcp-session-id");
  assert.ok(session);
  const hijack=await fetch(`${baseUrl}/mcp`,{method:"POST",headers:{authorization:`Bearer ${naniToken}`,"mcp-session-id":session,"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/list",params:{}})});
  assert.equal(hijack.status,403);
  const crossTool=await fetch(`${baseUrl}/mcp`,{method:"POST",headers:{authorization:`Bearer ${worldToken}`,"mcp-session-id":session,"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"instagram_project_context",arguments:{workspace_id:"nanisports"}}})});
  assert.match(await crossTool.text(),/no tiene acceso/);
  assert.equal((await world.removeProduct("case-1")).removed,true);
  assert.equal((await world.searchProducts("funda")).total,0);
});
