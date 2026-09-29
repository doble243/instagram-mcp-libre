import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstagramApi } from "../src/instagram.js";
import { LocalStore } from "../src/store.js";
import { decryptToken, encryptToken } from "../src/vault.js";

const live = { mockMode: false, allowWrites: true, accessToken: "test-token", userId: "ig-user-1", graphVersion: "v25.0" };

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

test("demo mode returns sample profile and posts without credentials", async () => {
  const api = new InstagramApi({ mockMode: true, allowWrites: false, graphVersion: "v25.0" });
  assert.equal((await api.getProfile()).username, "simplemente_demo");
  const media = await api.listMedia(1) as { data: unknown[] };
  assert.equal(media.data.length, 1);
});

test("live mode refuses calls without an access token", async () => {
  const api = new InstagramApi({ mockMode: false, allowWrites: false, graphVersion: "v25.0" });
  await assert.rejects(() => api.getProfile(), /Falta IG_ACCESS_TOKEN/);
});

test("live writes are blocked unless explicitly enabled", async () => {
  let calls = 0;
  const api = new InstagramApi({ ...live, allowWrites: false }, async () => { calls++; return jsonResponse({}); });
  await assert.rejects(() => api.publishMedia({ mediaUrl: "https://cdn.example.test/post.jpg", assetType: "image", placement: "feed" }), /ALLOW_WRITES=true/);
  assert.equal(calls, 0);
});

test("publishes a feed photo using Meta's create-container then publish flow", async () => {
  const requests: Array<{ url: URL; method: string; body: URLSearchParams | undefined }> = [];
  const api = new InstagramApi(live, async (input, init) => {
    requests.push({ url: new URL(String(input)), method: init?.method ?? "GET", body: init?.body as URLSearchParams | undefined });
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token");
    assert.equal(new URL(String(input)).searchParams.has("access_token"), false);
    return requests.length === 1 ? jsonResponse({ id: "container-1" }) : jsonResponse({ id: "published-1" });
  });
  const result = await api.publishMedia({ mediaUrl: "https://cdn.example.test/post.jpg", assetType: "image", placement: "feed", caption: "Hola" });
  assert.equal((result.published_media as Record<string, unknown>).id, "published-1");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url.pathname, "/v25.0/ig-user-1/media");
  assert.equal(requests[0].body?.get("image_url"), "https://cdn.example.test/post.jpg");
  assert.equal(requests[0].body?.get("caption"), "Hola");
  assert.equal(requests[1].body?.get("creation_id"), "container-1");
});

test("publishes a story as STORIES and reports demo mode without publishing", async () => {
  const demo = new InstagramApi({ mockMode: true, allowWrites: false, graphVersion: "v25.0" });
  const result = await demo.publishMedia({ mediaUrl: "https://cdn.example.test/story.mp4", assetType: "video", placement: "story" });
  assert.equal(result.demo, true);
  assert.equal(result.placement, "story");
});

test("polls video processing before publishing a reel", async () => {
  const requests: Array<{ url: URL; body: URLSearchParams | undefined }> = [];
  const api = new InstagramApi(live, async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, body: init?.body as URLSearchParams | undefined });
    if (url.pathname.endsWith("/media")) return jsonResponse({ id: "video-container" });
    if (url.pathname.endsWith("/media_publish")) return jsonResponse({ id: "reel-1" });
    return jsonResponse({ status_code: "FINISHED" });
  });
  const result = await api.publishMedia({ mediaUrl: "https://cdn.example.test/reel.mp4", assetType: "video", placement: "reel", shareToFeed: true });
  assert.equal((result.published_media as Record<string, unknown>).id, "reel-1");
  assert.equal(requests.length, 3);
  assert.equal(requests[0].body?.get("media_type"), "REELS");
  assert.equal(requests[1].url.pathname, "/v25.0/video-container");
  assert.equal(requests[2].body?.get("creation_id"), "video-container");
});

test("publishes carousel children before publishing the parent", async () => {
  const requests: Array<{url:URL;body:URLSearchParams|undefined}> = [];
  const api=new InstagramApi(live,async(input,init)=>{
    const url=new URL(String(input)); requests.push({url,body:init?.body as URLSearchParams|undefined});
    return jsonResponse({id:`container-${requests.length}`});
  });
  await api.publishCarousel({mediaUrls:["https://cdn.example.test/a.jpg","https://cdn.example.test/b.jpg"],caption:"Colección"});
  assert.equal(requests.length,4);
  assert.equal(requests[0].body?.get("is_carousel_item"),"true");
  assert.equal(requests[1].body?.get("is_carousel_item"),"true");
  assert.equal(requests[2].body?.get("media_type"),"CAROUSEL");
  assert.equal(requests[2].body?.get("children"),"container-1,container-2");
  assert.equal(requests[3].body?.get("creation_id"),"container-3");
});

test("local store persists drafts and keeps reply state when syncing comments", async () => {
  const dir=await mkdtemp(join(tmpdir(),"ig-toolkit-"));
  try {
    const store=new LocalStore(dir);
    const draft=await store.createDraft({workspaceId:"marca_a",accountId:"ig-1",mediaUrls:["https://cdn.example.test/post.jpg"],assetType:"image",destination:"feed",caption:"Hola",scheduledAt:null});
    await store.updateDraft(draft.id,{status:"approved",approvedAt:new Date().toISOString()});
    await store.upsertComments([{id:"comment-1",accountId:"ig-1",mediaId:"post-1",username:"wal",text:"Hola",timestamp:new Date().toISOString()}]);
    await store.markCommentReplied("comment-1","Gracias");
    await store.upsertComments([{id:"comment-1",accountId:"ig-1",mediaId:"post-1",username:"wal",text:"Hola",timestamp:new Date().toISOString()}]);
    const reopened=new LocalStore(dir);
    assert.equal((await reopened.getDraft(draft.id))?.status,"approved");
    assert.equal((await reopened.listComments())[0]?.replyText,"Gracias");
    assert.deepEqual(await reopened.listWorkspaceIds(),["default","marca_a"]);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("OAuth tokens are encrypted and can be decrypted only with the configured key", () => {
  const previous=process.env.TOKEN_ENCRYPTION_KEY; process.env.TOKEN_ENCRYPTION_KEY="11".repeat(32);
  try {
    const encrypted=encryptToken("secret-access-token");
    assert.notEqual(encrypted,"secret-access-token");
    assert.equal(decryptToken(encrypted),"secret-access-token");
    process.env.TOKEN_ENCRYPTION_KEY="22".repeat(32);
    assert.throws(()=>decryptToken(encrypted));
  } finally { if(previous===undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY=previous; }
});
