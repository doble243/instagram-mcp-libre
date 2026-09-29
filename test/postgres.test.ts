import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { PostgresStore } from "../src/postgres-store.js";

test("PostgreSQL migration and durable operations isolate shops and claim once",async()=>{
  const pg=new PGlite();
  try{
    await pg.exec(await readFile("sql/001_core.sql","utf8"));
    const pool={query:(sql:string,params?:unknown[])=>pg.query(sql,params),connect:async()=>({query:(sql:string,params?:unknown[])=>pg.query(sql,params),release:()=>{}}),end:()=>pg.close()} as unknown as Pool;
    const store=new PostgresStore("test",pool);
    await store.assertReady();
    await store.setBrandKit("shop_a",{businessName:"A"});
    assert.equal((await store.getBrandKit("shop_b")),null);
    await store.upsertProducts("shop_a",[{id:"1",name:"100% funda",description:"Azul",imageUrls:["https://example.com/a.jpg"],updatedAt:new Date().toISOString()}]);
    assert.equal((await store.listProducts("shop_a","100%",10)).total,1);
    assert.equal((await store.listProducts("shop_a","100_",10)).total,0);
    assert.equal((await store.listProducts("shop_b","",10)).total,0);
    const draft=await store.createDraft({workspaceId:"shop_a",accountId:"ig1",mediaUrls:["https://example.com/a.jpg"],assetType:"image",destination:"feed",caption:"Hola",scheduledAt:null});
    await store.updateDraft(draft.id,{status:"approved",approvedAt:new Date().toISOString()});
    assert.equal((await store.claimDraft(draft.id,false)).status,"publishing");
    await assert.rejects(store.claimDraft(draft.id,false),/Solo se publican/);
    await pg.query("update instagram_core.drafts set lease_until=now()-interval '1 second' where id=$1",[draft.id]);
    assert.equal(await store.recoverInterruptedPublishes(),1);
    assert.equal((await store.getDraft(draft.id))?.status,"needs_review");
    assert.equal((await store.listDrafts("shop_b")).length,0);
    await store.createOAuthState("11111111-1111-4111-8111-111111111111","shop_a","editor",new Date(Date.now()+60000));
    assert.deepEqual(await store.consumeOAuthState("11111111-1111-4111-8111-111111111111"),{workspaceId:"shop_a",actorId:"editor"});
    assert.equal(await store.consumeOAuthState("11111111-1111-4111-8111-111111111111"),null);
    await store.audit("shop_a","editor","draft.approve",draft.id,"success");
  }finally{await pg.close();}
});
