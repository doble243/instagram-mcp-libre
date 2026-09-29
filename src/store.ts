import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type Placement = "feed" | "story" | "reel" | "carousel";
export type AssetType = "image" | "video";
export type DraftStatus = "draft" | "pending_approval" | "approved" | "scheduled" | "publishing" | "published" | "simulated" | "failed" | "needs_review" | "cancelled";
export type Draft = {
  id: string;
  workspaceId: string;
  accountId: string;
  mediaUrls: string[];
  assetType: AssetType;
  destination: Placement;
  caption: string;
  scheduledAt: string | null;
  status: DraftStatus;
  approvedAt: string | null;
  publishedAt: string | null;
  publishedMediaId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};
export type PublishRecord = {
  id: string;
  workspaceId: string;
  accountId: string;
  draftId: string | null;
  destination: Placement;
  caption: string;
  mediaUrls: string[];
  mediaId: string | null;
  status: "published" | "demo" | "failed";
  error: string | null;
  createdAt: string;
};
export type StoredComment = { id: string; workspaceId?:string; accountId: string; mediaId: string; username: string; text: string; timestamp: string; repliedAt?: string | null; replyText?: string | null };
export type BrandKit = { businessName: string; description?: string; audience?: string; tone?: string; logoUrl?: string; colors?: { primary?: string; secondary?: string; accent?: string }; websiteUrl?: string; instagramHandle?: string; rules?: string[]; preferredStyle?: "editorial"|"producto"|"promocion" };
export type CatalogProduct = { id: string; name: string; description?: string; price?: number; currency?: string; imageUrls: string[]; productUrl?: string; availability?: "available" | "unavailable" | "unknown"; category?: string; updatedAt: string };
export type MediaAsset = { id: string; workspaceId: string; name: string; mimeType: string; size: number; fileName: string; createdAt: string };
type State = { activeAccountId: string | null; activeAccountIds?: Record<string,string>; drafts: Draft[]; history: PublishRecord[]; comments: StoredComment[]; brandKits?: Record<string,BrandKit>; products?: Record<string,CatalogProduct[]>; mediaAssets?: MediaAsset[]; oauthStates?:Array<{id:string;workspaceId:string;actorId:string|null;expiresAt:string}>; audit?:Array<{workspaceId:string;actorId:string|null;action:string;targetId:string|null;result:string;createdAt:string}> };
export type StoredAccount = { id: string; workspaceId?: string; label: string; username?: string; userId: string; encryptedToken: string; expiresAt: string; connectedAt: string };
type FullState = State & { connectedAccounts?: StoredAccount[] };

const emptyState = (): State => ({ activeAccountId: null, drafts: [], history: [], comments: [] });

/** Small, atomic, local persistence for a single-user MCP install. */
export class LocalStore {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(dataDir = process.env.DATA_DIR || ".data") { this.file = join(dataDir, "instagram-mcp.json"); }

  private async read(): Promise<State> {
    try {
      const state = JSON.parse(await readFile(this.file, "utf8")) as FullState;
      return { ...emptyState(), ...state };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
  }

  private async mutate<T>(fn: (state: State) => T | Promise<T>): Promise<T> {
    const operation = this.queue.then(async () => {
      const state = await this.read();
      const result = await fn(state);
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
      await rename(temp, this.file);
      return result;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async getActiveAccountId(workspaceId = "default") { const state=await this.read(); return state.activeAccountIds?.[workspaceId] ?? (workspaceId==="default"?state.activeAccountId:null); }
  async setActiveAccountId(workspaceId: string, id: string) { return this.mutate(state => { state.activeAccountIds ??={}; state.activeAccountIds[workspaceId]=id; if(workspaceId==="default") state.activeAccountId=id; }); }
  async listDrafts(workspaceId = "default") { return (await this.read()).drafts.filter(d => d.workspaceId === workspaceId).sort((a,b) => (a.scheduledAt ?? a.createdAt).localeCompare(b.scheduledAt ?? b.createdAt)); }
  async getDraft(id: string) { return (await this.read()).drafts.find(d => d.id === id) ?? null; }
  async createDraft(input: Omit<Draft, "id" | "status" | "approvedAt" | "publishedAt" | "publishedMediaId" | "lastError" | "createdAt" | "updatedAt">) {
    return this.mutate(state => {
      const now = new Date().toISOString();
      const draft: Draft = { ...input, id: randomUUID(), status: "draft", approvedAt: null, publishedAt: null, publishedMediaId: null, lastError: null, createdAt: now, updatedAt: now };
      state.drafts.push(draft); return draft;
    });
  }
  async updateDraft(id: string, update: Partial<Pick<Draft,"mediaUrls"|"assetType"|"destination"|"caption"|"scheduledAt"|"status"|"approvedAt"|"publishedAt"|"publishedMediaId"|"lastError">>) {
    return this.mutate(state => {
      const draft = state.drafts.find(item => item.id === id);
      if (!draft) throw new Error(`No existe el borrador ${id}.`);
      Object.assign(draft, update, { updatedAt: new Date().toISOString() });
      return draft;
    });
  }
  async claimDraft(id: string, scheduledRun: boolean) {
    return this.mutate(state => {
      const draft=state.drafts.find(item=>item.id===id);
      if(!draft) throw new Error("No existe ese borrador.");
      const due=scheduledRun && draft.status==="scheduled" && !!draft.approvedAt && !!draft.scheduledAt && new Date(draft.scheduledAt)<=new Date();
      if(draft.status!=="approved" && !due) throw new Error("Solo se publican borradores aprobados.");
      draft.status="publishing"; draft.updatedAt=new Date().toISOString();
      return structuredClone(draft);
    });
  }
  async recoverInterruptedPublishes() {
    return this.mutate(state => {
      let count=0;
      for(const draft of state.drafts) if(draft.status==="publishing") {
        draft.status="needs_review"; draft.lastError="La publicación se interrumpió. Comprueba Instagram antes de reintentar."; draft.updatedAt=new Date().toISOString(); count++;
      }
      return count;
    });
  }
  async deleteDraft(id: string) { return this.mutate(state => { const before = state.drafts.length; state.drafts = state.drafts.filter(d => d.id !== id); return before !== state.drafts.length; }); }
  async addHistory(record: Omit<PublishRecord,"id"|"createdAt">) {
    return this.mutate(state => { const item = { ...record, id: randomUUID(), createdAt: new Date().toISOString() }; state.history.unshift(item); state.history = state.history.slice(0, 1000); return item; });
  }
  async listHistory(workspaceId = "default", limit = 50) { return (await this.read()).history.filter(h => h.workspaceId === workspaceId).slice(0, limit); }
  async listWorkspaceIds() { const state=await this.read(); return [...new Set(["default",...state.drafts.map(d=>d.workspaceId),...state.history.map(h=>h.workspaceId),...Object.keys(state.brandKits??{}),...Object.keys(state.products??{})])]; }
  async upsertComments(comments: StoredComment[],workspaceId="default") {
    return this.mutate(state => {
      const byId = new Map(state.comments.map(c => [c.id, c]));
      for (const comment of comments) {
        const existing=byId.get(comment.id);
        byId.set(comment.id, { ...existing, ...comment, workspaceId, repliedAt:comment.repliedAt??existing?.repliedAt??null, replyText:comment.replyText??existing?.replyText??null });
      }
      state.comments = [...byId.values()].slice(-5000);
      return comments.length;
    });
  }
  async listComments(accountId?: string,workspaceId="default") { return (await this.read()).comments.filter(c => (c.workspaceId??"default")===workspaceId && (!accountId || c.accountId === accountId)).sort((a,b) => b.timestamp.localeCompare(a.timestamp)); }
  async markCommentReplied(id: string, replyText: string,workspaceId="default") { return this.mutate(state => { const c = state.comments.find(x => x.id === id&&(x.workspaceId??"default")===workspaceId); if (!c) throw new Error(`No existe el comentario ${id}.`); c.repliedAt = new Date().toISOString(); c.replyText = replyText; return c; }); }
  async dueDrafts(now = new Date()) { return (await this.read()).drafts.filter(d => d.status === "scheduled" && d.approvedAt && d.scheduledAt && new Date(d.scheduledAt) <= now); }
  async listConnectedAccounts() { return (await this.read() as FullState).connectedAccounts ?? []; }
  async saveConnectedAccount(account: StoredAccount) {
    return this.mutate(state => { const full=state as FullState; full.connectedAccounts ??=[]; const existing=full.connectedAccounts.findIndex(x=>x.id===account.id); if(existing>=0) full.connectedAccounts[existing]=account; else full.connectedAccounts.push(account); });
  }
  async removeConnectedAccount(id: string) { return this.mutate(state => { const full=state as FullState; full.connectedAccounts=(full.connectedAccounts??[]).filter(a=>a.id!==id); if(state.activeAccountId===id) state.activeAccountId=null; for(const [workspace,active] of Object.entries(state.activeAccountIds??{})) if(active===id) delete state.activeAccountIds![workspace]; }); }
  async getBrandKit(workspaceId: string) { return (await this.read()).brandKits?.[workspaceId]??null; }
  async setBrandKit(workspaceId: string, kit: BrandKit) { return this.mutate(state=>{state.brandKits??={};state.brandKits[workspaceId]=kit;return kit;}); }
  async listProducts(workspaceId: string, query="",limit=50,offset=0) {
    const rows=(await this.read()).products?.[workspaceId]??[];
    const filtered=query?rows.filter(p=>`${p.name} ${p.description??""} ${p.category??""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())):rows;
    return {total:filtered.length,items:filtered.slice(offset,offset+limit)};
  }
  async getProduct(workspaceId:string,productId:string) { return (await this.read()).products?.[workspaceId]?.find(product=>product.id===productId)??null; }
  async upsertProducts(workspaceId: string, products: CatalogProduct[]) {
    return this.mutate(state=>{
      state.products??={}; const byId=new Map((state.products[workspaceId]??[]).map(p=>[p.id,p]));
      for(const product of products) byId.set(product.id,product);
      state.products[workspaceId]=[...byId.values()]; return {updated:products.length,total:byId.size};
    });
  }
  async removeProduct(workspaceId:string,productId:string) {
    return this.mutate(state=>{
      const rows=state.products?.[workspaceId]??[]; const filtered=rows.filter(p=>p.id!==productId);
      if(state.products) state.products[workspaceId]=filtered;
      return {removed:filtered.length!==rows.length};
    });
  }
  async addMediaAsset(asset: MediaAsset) { return this.mutate(state=>{state.mediaAssets??=[];state.mediaAssets.push(asset);return asset;}); }
  async listMediaAssets(workspaceId: string) { return (await this.read()).mediaAssets?.filter(asset=>asset.workspaceId===workspaceId)??[]; }
  async getMediaAssetByFilename(fileName:string){return (await this.read()).mediaAssets?.find(asset=>asset.fileName===fileName)??null;}
  async createOAuthState(id:string,workspaceId:string,actorId:string|null,expiresAt:Date){return this.mutate(state=>{state.oauthStates=(state.oauthStates??[]).filter(row=>new Date(row.expiresAt)>new Date());state.oauthStates.push({id,workspaceId,actorId,expiresAt:expiresAt.toISOString()});});}
  async consumeOAuthState(id:string){return this.mutate(state=>{const row=state.oauthStates?.find(item=>item.id===id&&new Date(item.expiresAt)>new Date());state.oauthStates=(state.oauthStates??[]).filter(item=>item.id!==id);return row?{workspaceId:row.workspaceId,actorId:row.actorId}:null;});}
  async audit(workspaceId:string,actorId:string|null,action:string,targetId:string|null,result:string){return this.mutate(state=>{state.audit??=[];state.audit.push({workspaceId,actorId,action,targetId,result,createdAt:new Date().toISOString()});state.audit=state.audit.slice(-10000);});}
}
