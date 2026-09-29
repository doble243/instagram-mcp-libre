import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { BrandKit, CatalogProduct, Draft, MediaAsset, PublishRecord, StoredAccount, StoredComment } from "./store.js";

/** Server-only database adapter. The SQL schema must be installed before startup. */
export class PostgresStore {
  private readonly db:Pool;
  constructor(connectionString:string,pool?:Pool) {
    if(!connectionString)throw new Error("DATABASE_URL requerido.");
    this.db=pool??new Pool({connectionString,max:5,connectionTimeoutMillis:5000,idleTimeoutMillis:30000});
  }
  async assertReady(){await this.db.query("select 1 from instagram_core.workspaces limit 1");}
  async close(){await this.db.end();}
  private async workspace(id:string,client:Pool|PoolClient=this.db){await client.query("insert into instagram_core.workspaces(id) values($1) on conflict do nothing",[id]);}
  private async tx<T>(fn:(client:PoolClient)=>Promise<T>) {const client=await this.db.connect();try{await client.query("begin");const value=await fn(client);await client.query("commit");return value;}catch(error){await client.query("rollback");throw error;}finally{client.release();}}
  async getActiveAccountId(workspaceId="default") {const r=await this.db.query<{active_account_id:string|null}>("select active_account_id from instagram_core.workspaces where id=$1",[workspaceId]);return r.rows[0]?.active_account_id??null;}
  async setActiveAccountId(workspaceId:string,id:string) {await this.workspace(workspaceId);await this.db.query("update instagram_core.workspaces set active_account_id=$2,updated_at=now() where id=$1",[workspaceId,id]);}
  async listDrafts(workspaceId="default") {const r=await this.db.query<{payload:Draft}>("select payload from instagram_core.drafts where workspace_id=$1 order by coalesce(scheduled_at,created_at),id",[workspaceId]);return r.rows.map(x=>x.payload);}
  async getDraft(id:string) {const r=await this.db.query<{payload:Draft}>("select payload from instagram_core.drafts where id=$1",[id]);return r.rows[0]?.payload??null;}
  async createDraft(input:Omit<Draft,"id"|"status"|"approvedAt"|"publishedAt"|"publishedMediaId"|"lastError"|"createdAt"|"updatedAt">) {
    const now=new Date().toISOString();const draft:Draft={...input,id:randomUUID(),status:"draft",approvedAt:null,publishedAt:null,publishedMediaId:null,lastError:null,createdAt:now,updatedAt:now};
    await this.workspace(input.workspaceId);
    await this.db.query("insert into instagram_core.drafts(id,workspace_id,account_id,status,scheduled_at,approved_at,payload) values($1,$2,$3,$4,$5,$6,$7)",[draft.id,draft.workspaceId,draft.accountId,draft.status,draft.scheduledAt,draft.approvedAt,draft]);return draft;
  }
  async updateDraft(id:string,update:Partial<Pick<Draft,"mediaUrls"|"assetType"|"destination"|"caption"|"scheduledAt"|"status"|"approvedAt"|"publishedAt"|"publishedMediaId"|"lastError">>) {
    return this.tx(async client=>{
      const r=await client.query<{payload:Draft}>("select payload from instagram_core.drafts where id=$1 for update",[id]);const draft=r.rows[0]?.payload;if(!draft)throw new Error(`No existe el borrador ${id}.`);
      Object.assign(draft,update,{updatedAt:new Date().toISOString()});
      await client.query("update instagram_core.drafts set payload=$2,status=$3,scheduled_at=$4,approved_at=$5,lease_until=case when $3='publishing' then lease_until else null end where id=$1",[id,draft,draft.status,draft.scheduledAt,draft.approvedAt]);return draft;
    });
  }
  async claimDraft(id:string,scheduledRun:boolean) {
    return this.tx(async client=>{
      const r=await client.query<{payload:Draft}>("select payload from instagram_core.drafts where id=$1 for update",[id]);const draft=r.rows[0]?.payload;if(!draft)throw new Error("No existe ese borrador.");
      const due=scheduledRun&&draft.status==="scheduled"&&!!draft.approvedAt&&!!draft.scheduledAt&&new Date(draft.scheduledAt)<=new Date();
      if(draft.status!=="approved"&&!due)throw new Error("Solo se publican borradores aprobados.");
      draft.status="publishing";draft.updatedAt=new Date().toISOString();
      await client.query("update instagram_core.drafts set status='publishing',payload=$2,lease_until=now()+interval '30 minutes' where id=$1",[id,draft]);return draft;
    });
  }
  async recoverInterruptedPublishes() {
    const r=await this.db.query("update instagram_core.drafts set status='needs_review',lease_until=null,payload=jsonb_set(jsonb_set(jsonb_set(payload,'{status}','\"needs_review\"'::jsonb),'{lastError}',to_jsonb('El trabajo se interrumpió. Comprueba Instagram antes de reintentar.'::text)),'{updatedAt}',to_jsonb(now()::text)) where status='publishing' and lease_until<now()");return r.rowCount??0;
  }
  async deleteDraft(id:string){const r=await this.db.query("delete from instagram_core.drafts where id=$1",[id]);return !!r.rowCount;}
  async dueDrafts(now=new Date()){const r=await this.db.query<{payload:Draft}>("select payload from instagram_core.drafts where status='scheduled' and approved_at is not null and scheduled_at<=$1 order by scheduled_at limit 100",[now]);return r.rows.map(x=>x.payload);}
  async addHistory(input:Omit<PublishRecord,"id"|"createdAt">){const record:PublishRecord={...input,id:randomUUID(),createdAt:new Date().toISOString()};await this.workspace(input.workspaceId);await this.db.query("insert into instagram_core.history(id,workspace_id,payload,created_at) values($1,$2,$3,$4)",[record.id,record.workspaceId,record,record.createdAt]);return record;}
  async listHistory(workspaceId="default",limit=50){const r=await this.db.query<{payload:PublishRecord}>("select payload from instagram_core.history where workspace_id=$1 order by created_at desc limit $2",[workspaceId,limit]);return r.rows.map(x=>x.payload);}
  async listWorkspaceIds(){const r=await this.db.query<{id:string}>("select id from instagram_core.workspaces order by id");return r.rows.map(x=>x.id);}
  async listConnectedAccounts(){const r=await this.db.query<{payload:StoredAccount}>("select payload from instagram_core.accounts");return r.rows.map(x=>x.payload);}
  async saveConnectedAccount(account:StoredAccount){const workspaceId=account.workspaceId??"default";await this.workspace(workspaceId);const r=await this.db.query("insert into instagram_core.accounts(id,workspace_id,payload) values($1,$2,$3) on conflict(id) do update set payload=excluded.payload,updated_at=now() where instagram_core.accounts.workspace_id=excluded.workspace_id",[account.id,workspaceId,account]);if(!r.rowCount)throw new Error("Esta cuenta pertenece a otro proyecto.");}
  async removeConnectedAccount(id:string){await this.tx(async client=>{await client.query("delete from instagram_core.accounts where id=$1",[id]);await client.query("update instagram_core.workspaces set active_account_id=null where active_account_id=$1",[id]);});}
  async getBrandKit(workspaceId:string){const r=await this.db.query<{brand_kit:BrandKit|null}>("select brand_kit from instagram_core.workspaces where id=$1",[workspaceId]);return r.rows[0]?.brand_kit??null;}
  async setBrandKit(workspaceId:string,kit:BrandKit){await this.workspace(workspaceId);await this.db.query("update instagram_core.workspaces set brand_kit=$2,updated_at=now() where id=$1",[workspaceId,kit]);return kit;}
  async listProducts(workspaceId:string,query="",limit=50,offset=0){const term=`%${query.replace(/[\\%_]/g,"\\$&")}%`;const where="workspace_id=$1 and ($2='' or coalesce(payload->>'name','') ilike $3 escape '\\' or coalesce(payload->>'description','') ilike $3 escape '\\' or coalesce(payload->>'category','') ilike $3 escape '\\')";
    const [count,rows]=await Promise.all([this.db.query<{total:string}>(`select count(*)::text as total from instagram_core.products where ${where}`,[workspaceId,query,term]),this.db.query<{payload:CatalogProduct}>(`select payload from instagram_core.products where ${where} order by id limit $4 offset $5`,[workspaceId,query,term,limit,offset])]);return {total:Number(count.rows[0]?.total??0),items:rows.rows.map(x=>x.payload)};
  }
  async getProduct(workspaceId:string,productId:string){const r=await this.db.query<{payload:CatalogProduct}>("select payload from instagram_core.products where workspace_id=$1 and id=$2",[workspaceId,productId]);return r.rows[0]?.payload??null;}
  async upsertProducts(workspaceId:string,products:CatalogProduct[]){await this.workspace(workspaceId);return this.tx(async client=>{for(const product of products)await client.query("insert into instagram_core.products(workspace_id,id,payload) values($1,$2,$3) on conflict(workspace_id,id) do update set payload=excluded.payload",[workspaceId,product.id,product]);const r=await client.query<{total:string}>("select count(*)::text as total from instagram_core.products where workspace_id=$1",[workspaceId]);return {updated:products.length,total:Number(r.rows[0].total)};});}
  async removeProduct(workspaceId:string,productId:string){const r=await this.db.query("delete from instagram_core.products where workspace_id=$1 and id=$2",[workspaceId,productId]);return {removed:!!r.rowCount};}
  async addMediaAsset(asset:MediaAsset){await this.workspace(asset.workspaceId);await this.db.query("insert into instagram_core.assets(id,workspace_id,payload) values($1,$2,$3)",[asset.id,asset.workspaceId,asset]);return asset;}
  async listMediaAssets(workspaceId:string){const r=await this.db.query<{payload:MediaAsset}>("select payload from instagram_core.assets where workspace_id=$1 order by created_at desc",[workspaceId]);return r.rows.map(x=>x.payload);}
  async getMediaAssetByFilename(fileName:string){const r=await this.db.query<{payload:MediaAsset}>("select payload from instagram_core.assets where payload->>'fileName'=$1 limit 1",[fileName]);return r.rows[0]?.payload??null;}
  async upsertComments(comments:StoredComment[],workspaceId="default"){await this.workspace(workspaceId);return this.tx(async client=>{for(const comment of comments)await client.query("insert into instagram_core.comments(id,workspace_id,account_id,payload) values($1,$2,$3,$4) on conflict(id) do update set payload=excluded.payload || jsonb_build_object('repliedAt',instagram_core.comments.payload->'repliedAt','replyText',instagram_core.comments.payload->'replyText') where instagram_core.comments.workspace_id=excluded.workspace_id",[comment.id,workspaceId,comment.accountId,comment]);return comments.length;});}
  async listComments(accountId?:string,workspaceId="default"){const r=await this.db.query<{payload:StoredComment}>("select payload from instagram_core.comments where workspace_id=$1 and ($2::text is null or account_id=$2) order by payload->>'timestamp' desc limit 5000",[workspaceId,accountId??null]);return r.rows.map(x=>x.payload);}
  async markCommentReplied(id:string,replyText:string,workspaceId="default"){const repliedAt=new Date().toISOString();const r=await this.db.query<{payload:StoredComment}>("update instagram_core.comments set payload=jsonb_set(jsonb_set(payload,'{replyText}',to_jsonb($3::text)),'{repliedAt}',to_jsonb($4::text)) where id=$1 and workspace_id=$2 returning payload",[id,workspaceId,replyText,repliedAt]);if(!r.rows[0])throw new Error("No existe el comentario.");return r.rows[0].payload;}
  async createOAuthState(id:string,workspaceId:string,actorId:string|null,expiresAt:Date){await this.workspace(workspaceId);await this.db.query("insert into instagram_core.oauth_states(id,workspace_id,actor_id,expires_at) values($1,$2,$3,$4)",[id,workspaceId,actorId,expiresAt]);}
  async consumeOAuthState(id:string){const r=await this.db.query<{workspace_id:string;actor_id:string|null}>("delete from instagram_core.oauth_states where id=$1 and expires_at>now() returning workspace_id,actor_id",[id]);return r.rows[0]?{workspaceId:r.rows[0].workspace_id,actorId:r.rows[0].actor_id}:null;}
  async audit(workspaceId:string,actorId:string|null,action:string,targetId:string|null,result:string){await this.workspace(workspaceId);await this.db.query("insert into instagram_core.audit(workspace_id,actor_id,action,target_id,result) values($1,$2,$3,$4,$5)",[workspaceId,actorId,action,targetId,result]);}
}
