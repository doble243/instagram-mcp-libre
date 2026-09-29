import type { ProjectScope } from "./tenant.js";
import { brandKitSchema, productsBatchSchema, type BrandKitInput, type ProductInput } from "./integration.js";
import type { CatalogProduct, MediaAsset } from "./store.js";
export type DraftInput={media_urls:string[];asset_type:"image"|"video";destination:"feed"|"story"|"reel"|"carousel";caption?:string;scheduled_at?:string|null};
function validateWorkspaceId(id:string){if(!/^[a-zA-Z0-9_-]{1,64}$/.test(id))throw new Error("workspace_id inválido.");return id;}

/** Server-side bridge. Keep the project token in the host application's server environment. */
export class InstagramProjectClient {
  private readonly baseUrl:string;
  private readonly token:string;
  readonly workspaceId:string;
  constructor(config:{baseUrl:string;token:string;workspaceId:string}) {
    this.baseUrl=config.baseUrl.replace(/\/$/,"");
    this.token=config.token;
    this.workspaceId=validateWorkspaceId(config.workspaceId);
    if(!/^https?:\/\//.test(this.baseUrl)) throw new Error("baseUrl debe ser una URL HTTP(S).");
    if(this.token.length<32) throw new Error("El token de proyecto debe tener al menos 32 caracteres.");
  }
  private async request<T>(resource:string,method="GET",body?:unknown):Promise<T> {
    const response=await fetch(`${this.baseUrl}/api/projects/${this.workspaceId}/${resource}`,{
      method,headers:{authorization:`Bearer ${this.token}`,...(body?{"content-type":"application/json"}:{})},
      body:body?JSON.stringify(body):undefined
    });
    const data=await response.json() as T&{error?:string};
    if(!response.ok) throw new Error(data.error??`Instagram Core respondió ${response.status}.`);
    return data;
  }
  getBrand() { return this.request<{workspace_id:string;brand_kit:BrandKitInput|null}>("brand"); }
  syncBrand(value:BrandKitInput) { return this.request<{workspace_id:string;brand_kit:BrandKitInput}>("brand","PUT",brandKitSchema.parse(value)); }
  searchProducts(query="",limit=25,offset=0) {
    const params=new URLSearchParams({query,limit:String(limit),offset:String(offset)});
    return this.request<{total:number;items:CatalogProduct[]}>(`products?${params}`);
  }
  upsertProducts(products:ProductInput[]) {
    return this.request<{updated:number;total:number}>("products","PUT",productsBatchSchema.parse({products}));
  }
  removeProduct(productId:string) { return this.request<{removed:boolean}>(`products/${encodeURIComponent(productId)}`,"DELETE"); }
  listStyles() { return this.request<{items:Array<{id:string;label:string;background:string;foreground:string;accent:string;logoUrl:string|null}>}>("styles"); }
  suggestProduct(productId:string,format:"feed"|"story"="feed",style?:"editorial"|"producto"|"promocion") {
    const params=new URLSearchParams({format});if(style)params.set("style",style);
    return this.request<{suggestion:{title:string;caption:string;imageUrl:string;reviewRequired:boolean}}>(`products/${encodeURIComponent(productId)}?${params}`);
  }
  listAssets() { return this.request<{items:Array<Pick<MediaAsset,"id"|"name"|"size">&{mime_type:string;media_url:string}>}>("assets"); }
  listAccounts() { return this.request<{active_account_id:string|null;items:Array<{id:string;label:string;username?:string}>}>("accounts"); }
  startInstagramOAuth() { return this.request<{authorization_url:string;callback_uri:string;state_expires_in_seconds:number}>("oauth","POST",{}); }
  selectAccount(accountId:string) { return this.request<{active_account_id:string}>(`accounts/${encodeURIComponent(accountId)}/select`,"POST",{confirmed:true}); }
  disconnectAccount(accountId:string) { return this.request<{disconnected:boolean}>(`accounts/${encodeURIComponent(accountId)}/disconnect`,"POST",{confirmed:true}); }
  listDrafts() { return this.request<{items:Array<{id:string;status:string;caption:string;mediaUrls:string[];scheduledAt:string|null}>}>("drafts"); }
  createDraft(input:DraftInput) { return this.request<{id:string;status:string}>("drafts","POST",input); }
  updateDraft(id:string,input:Partial<DraftInput>) { return this.request<{id:string;status:string}>(`drafts/${encodeURIComponent(id)}`,"PATCH",input); }
  approveDraft(id:string) { return this.request<{id:string;status:string}>(`drafts/${encodeURIComponent(id)}/approve`,"POST",{confirmed:true}); }
  publishDraft(id:string) { return this.request<unknown>(`drafts/${encodeURIComponent(id)}/publish`,"POST",{confirmed:true}); }
  cancelDraft(id:string) { return this.request<{id:string;status:string}>(`drafts/${encodeURIComponent(id)}/cancel`,"POST",{confirmed:true}); }
  retryDraftAfterCheckingInstagram(id:string) { return this.request<unknown>(`drafts/${encodeURIComponent(id)}/retry`,"POST",{confirmed:true,checked_instagram:true}); }
  listHistory(limit=50) { return this.request<{items:unknown[]}>(`history?limit=${Math.min(200,Math.max(1,limit))}`); }
  async uploadAsset(file:Blob,name:string) {
    const form=new FormData();form.append("file",file,name);
    const response=await fetch(`${this.baseUrl}/upload`,{method:"POST",headers:{authorization:`Bearer ${this.token}`},body:form});
    const result=await response.json() as {id?:string;media_url?:string;error?:string};
    if(!response.ok||!result.media_url)throw new Error(result.error??`La carga falló (${response.status}).`);
    return result as {id:string;media_url:string};
  }
}

/** Call only from a trusted host backend after checking its own user and shop membership. */
export class InstagramAdminClient {
  private readonly baseUrl:string;
  private readonly ownerToken:string;
  constructor(config:{baseUrl:string;ownerToken:string}) {
    this.baseUrl=config.baseUrl.replace(/\/$/,"");
    this.ownerToken=config.ownerToken;
    if(!/^https?:\/\//.test(this.baseUrl)||this.ownerToken.length<32) throw new Error("Configura URL y token administrador válidos.");
  }
  async forProject(workspaceId:string,actorId:string,scopes:ProjectScope[]=["read","edit","approve","publish","accounts"]) {
    const id=validateWorkspaceId(workspaceId);
    const response=await fetch(`${this.baseUrl}/api/projects/${id}/token`,{
      method:"POST",headers:{authorization:`Bearer ${this.ownerToken}`,"content-type":"application/json"},
      body:JSON.stringify({actor_id:actorId,ttl_seconds:900,scopes})
    });
    const result=await response.json() as {token?:string;error?:string};
    if(!response.ok||!result.token) throw new Error(result.error??`No se pudo emitir el token (${response.status}).`);
    return new InstagramProjectClient({baseUrl:this.baseUrl,workspaceId:id,token:result.token});
  }
}
