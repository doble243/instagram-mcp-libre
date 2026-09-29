import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Private bucket access stays on the server. Core serves signed media URLs to Meta. */
export class SupabaseMediaStorage {
  private client:SupabaseClient;
  private bucket:string;
  constructor(url:string,secretKey:string,bucket:string) {
    if(!/^https:\/\//.test(url)||!secretKey||!bucket)throw new Error("Configura SUPABASE_URL, SUPABASE_SECRET_KEY y SUPABASE_MEDIA_BUCKET.");
    this.client=createClient(url,secretKey,{auth:{persistSession:false,autoRefreshToken:false}});
    this.bucket=bucket;
  }
  private key(workspaceId:string,fileName:string){return `${workspaceId}/${fileName}`;}
  async upload(workspaceId:string,fileName:string,body:Buffer,mimeType:string){
    const {error}=await this.client.storage.from(this.bucket).upload(this.key(workspaceId,fileName),body,{contentType:mimeType,upsert:false});
    if(error)throw new Error(`No se pudo guardar el medio: ${error.message}`);
  }
  async download(workspaceId:string,fileName:string){
    const {data,error}=await this.client.storage.from(this.bucket).download(this.key(workspaceId,fileName));
    if(error||!data)throw new Error(`No se pudo leer el medio: ${error?.message??"sin datos"}`);
    return Buffer.from(await data.arrayBuffer());
  }
  async remove(workspaceId:string,fileName:string){await this.client.storage.from(this.bucket).remove([this.key(workspaceId,fileName)]);}
}
