import type { InstagramProjectClient, DraftInput } from "./client.js";

/** Mount inside an authenticated shop panel; obtain a short-lived scoped token from its backend. */
export function mountInstagramStudio(root:HTMLElement,options:{gateway:Pick<InstagramProjectClient,"getBrand"|"listStyles"|"listDrafts"|"listAccounts"|"uploadAsset"|"createDraft"|"approveDraft"|"publishDraft"|"cancelDraft"|"retryDraftAfterCheckingInstagram"|"searchProducts"|"listAssets"|"listHistory"|"selectAccount"|"startInstagramOAuth">;workspaceId:string;permissions?:Array<"read"|"edit"|"approve"|"publish"|"accounts">}){
  const client=options.gateway, permissions=new Set(options.permissions??["read","edit","approve","publish","accounts"]);
  const shadow=root.shadowRoot??root.attachShadow({mode:"open"});shadow.replaceChildren();
  const css=document.createElement("style");css.textContent=`:host{display:block}*{box-sizing:border-box}.ig{font:14px/1.5 system-ui,sans-serif;color:#182039;background:#f6f7fb;padding:20px;border-radius:16px;max-width:1100px}.head{display:flex;justify-content:space-between;align-items:center;gap:12px}.brand{font-size:22px;font-weight:750}.sub{color:#62708a}.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0}.tabs button,.button{font:inherit;border:1px solid #d6dbea;border-radius:9px;background:white;padding:9px 13px;cursor:pointer;color:#273249}.tabs button[aria-current=true],.primary{background:#4431bd;color:white;border-color:#4431bd}.danger{color:#a51d35}section{background:white;border:1px solid #e1e5ef;border-radius:12px;padding:20px;margin-bottom:12px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}.card{border:1px solid #e1e5ef;border-radius:10px;padding:14px}.muted{color:#647089}.row{display:flex;align-items:center;gap:9px;flex-wrap:wrap}input,textarea,select{font:inherit;width:100%;padding:10px;border:1px solid #cbd2e0;border-radius:8px;background:white;color:#182039}textarea{min-height:100px}label{display:block;font-weight:600;margin:12px 0 4px}img{width:100%;height:130px;object-fit:cover;border-radius:8px}h2{font-size:17px;margin:0 0 12px}h3{margin:6px 0}p{margin:6px 0 12px}.badge{border-radius:99px;background:#edf0f8;padding:3px 9px}.error{color:#a51d35}.success{color:#187146}button:disabled{opacity:.5;cursor:not-allowed}`;
  shadow.append(css);
  const shell=document.createElement("div");shell.className="ig";shadow.append(shell);
  let tab="overview",message="",error=false,query="";
  const el=(tag:string,text="",className="")=>{const node=document.createElement(tag);node.textContent=text;if(className)node.className=className;return node;};
  const btn=(label:string,action:()=>Promise<unknown>|void,kind="")=>{const button=el("button",label,`button ${kind}`) as HTMLButtonElement;button.type="button";button.onclick=async()=>{button.disabled=true;try{await action();message="Listo";error=false;await render();}catch(e){message=e instanceof Error?e.message:String(e);error=true;await render();}finally{button.disabled=false;}};return button;};
  const add=(parent:HTMLElement,...children:HTMLElement[])=>{parent.append(...children);return parent;};
  const card=(title:string,details:string)=>add(el("div","","card"),el("h3",title),el("p",details,"muted"));
  const tabs:[string,string][]=[["overview","Resumen"],["compose","Crear publicación"],["drafts","Borradores"],["catalog","Productos"],["assets","Archivos"],["history","Historial"],["accounts","Cuentas"]];
  async function render(){
    shell.replaceChildren();const head=add(el("div","","head"),add(el("div"),el("div","Instagram Core","brand"),el("div",`Proyecto: ${options.workspaceId}`,"sub")));shell.append(head);
    const nav=el("nav","","tabs");nav.setAttribute("aria-label","Instagram Core");for(const [key,label] of tabs){if(key==="accounts"&&!permissions.has("accounts"))continue;const button=el("button",label) as HTMLButtonElement;button.type="button";button.setAttribute("aria-current",String(tab===key));button.onclick=()=>{tab=key;message="";void render();};nav.append(button);}shell.append(nav);
    if(message)shell.append(el("p",message,error?"error":"success"));
    const section=el("section") as HTMLElement;shell.append(section);
    try{
      if(tab==="overview"){
        const [brand,drafts,accounts,styles]=await Promise.all([client.getBrand(),client.listDrafts(),client.listAccounts(),client.listStyles()]);
        add(section,el("h2","Resumen"),el("p",brand.brand_kit?.businessName??"Configura la marca desde el panel de tu tienda.","muted"));
        const grid=el("div","","grid");add(grid,card("Borradores",String(drafts.items.length)),card("Pendientes de aprobación",String(drafts.items.filter(d=>d.status==="draft").length)),card("Cuentas",String(accounts.items.length)));section.append(grid);const palette=el("div","","row");for(const style of styles.items){const swatch=el("span",style.label,"badge");swatch.style.background=style.background;swatch.style.color=style.foreground;palette.append(swatch);}section.append(el("h2","Estilos de marca"),palette);
        if(drafts.items.some(d=>d.status==="needs_review"))section.append(el("p","Hay publicaciones que requieren comprobar Instagram antes de reintentar.","error"));
      }
      if(tab==="compose"){
        add(section,el("h2","Crear publicación"));if(!permissions.has("edit")){section.append(el("p","Tu usuario tiene acceso de lectura."));return;}
        const form=document.createElement("form");form.onsubmit=event=>event.preventDefault();
        const media=document.createElement("input");media.type="file";media.accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime";media.multiple=true;
        const destination=document.createElement("select");for(const [value,label] of [["feed","Post"],["story","Historia"],["reel","Reel"],["carousel","Carrusel de imágenes"]]){const opt=document.createElement("option");opt.value=value;opt.textContent=label;destination.append(opt);}
        const caption=document.createElement("textarea");caption.maxLength=2200;caption.placeholder="Texto de la publicación";
        const schedule=document.createElement("input");schedule.type="datetime-local";
        add(form,el("label","Destino"),destination,el("label","Imagen o video"),media,el("label","Texto"),caption,el("label","Programar (opcional)"),schedule);
        const submit=btn("Subir y guardar borrador",async()=>{
          const files=[...(media.files??[])];if(!files.length)throw new Error("Selecciona un archivo.");
          if(destination.value==="carousel"&&(files.length<2||files.length>10||files.some(file=>!file.type.startsWith("image/"))))throw new Error("Un carrusel requiere de 2 a 10 imágenes.");
          if(destination.value!=="carousel"&&files.length!==1)throw new Error("Elige un archivo para este destino.");
          const uploaded=[];for(const file of files)uploaded.push(await client.uploadAsset(file,file.name));
          const input:DraftInput={media_urls:uploaded.map(asset=>asset.media_url),asset_type:files[0].type.startsWith("video/")?"video":"image",destination:destination.value as DraftInput["destination"],caption:caption.value,scheduled_at:schedule.value?new Date(schedule.value).toISOString():null};
          await client.createDraft(input);tab="drafts";
        },"primary");form.append(submit);section.append(form);
      }
      if(tab==="drafts"){
        const result=await client.listDrafts();add(section,el("h2","Borradores y calendario"));if(!result.items.length)section.append(el("p","Todavía no hay publicaciones.","muted"));
        for(const draft of result.items){const row=card(draft.caption?.slice(0,90)||"Sin texto",`Estado: ${draft.status} · ${draft.scheduledAt?new Date(draft.scheduledAt).toLocaleString():"Sin fecha"}`);const actions=el("div","","row");
          if(draft.status==="draft"&&permissions.has("approve"))actions.append(btn("Aprobar",()=>client.approveDraft(draft.id),"primary"));
          if(draft.status==="approved"&&permissions.has("publish"))actions.append(btn("Publicar ahora",async()=>{if(confirm("¿Publicar este borrador en Instagram ahora?"))await client.publishDraft(draft.id);},"primary"));
          if(["draft","approved","scheduled"].includes(draft.status)&&permissions.has("edit"))actions.append(btn("Cancelar",async()=>{if(confirm("¿Cancelar este borrador?"))await client.cancelDraft(draft.id);},"danger"));
          if(["failed","needs_review"].includes(draft.status)&&permissions.has("publish"))actions.append(btn("Ya comprobé Instagram; reintentar",async()=>{if(confirm("Confirma que esta publicación NO apareció en Instagram. ¿Reintentar?"))await client.retryDraftAfterCheckingInstagram(draft.id);},"danger"));
          row.append(actions);section.append(row);}
      }
      if(tab==="catalog"){
        add(section,el("h2","Catálogo"));const search=document.createElement("input");search.placeholder="Buscar producto";search.value=query;search.onchange=()=>{query=search.value;void render();};section.append(search);
        const result=await client.searchProducts(query,30);section.append(el("p",`${result.total} productos encontrados`,"muted"));const grid=el("div","","grid");for(const product of result.items){const item=card(product.name,product.description??"");if(product.imageUrls?.[0]){const img=document.createElement("img");img.src=product.imageUrls[0];img.alt=product.name;item.prepend(img);}item.append(el("p",product.price!=null?`${product.price} ${product.currency??""}`:"Precio no disponible"));grid.append(item);}section.append(grid);
      }
      if(tab==="assets"){
        add(section,el("h2","Archivos del proyecto"));const result=await client.listAssets();const grid=el("div","","grid");for(const asset of result.items){const item=card(asset.name,`${Math.round(asset.size/1024)} KB`);if(asset.mime_type.startsWith("image/")){const img=document.createElement("img");img.src=asset.media_url;img.alt=asset.name;item.prepend(img);}grid.append(item);}section.append(grid);
      }
      if(tab==="history"){
        add(section,el("h2","Historial de publicación"));const result=await client.listHistory();for(const item of result.items as Array<{destination?:string;status?:string;caption?:string;createdAt?:string;error?:string}>){section.append(card(`${item.destination??"Publicación"} · ${item.status??""}`,`${item.createdAt?new Date(item.createdAt).toLocaleString():""} ${item.caption??""} ${item.error??""}`));}
      }
      if(tab==="accounts"){
        add(section,el("h2","Cuentas de Instagram"));const result=await client.listAccounts();for(const account of result.items){const item=card(account.label,account.username??"");if(permissions.has("accounts")&&result.active_account_id!==account.id)item.append(btn("Usar cuenta",()=>client.selectAccount(account.id)));section.append(item);}
        if(permissions.has("accounts"))section.append(btn("Conectar Instagram",async()=>{const oauth=await client.startInstagramOAuth();window.location.assign(oauth.authorization_url);},"primary"));
      }
    }catch(e){section.append(el("p",e instanceof Error?e.message:String(e),"error"));}
  }
  void render();return {refresh:render,destroy:()=>shadow.replaceChildren()};
}

/** Browser bridge to a same-origin route controlled by the host application. */
export function createStudioGateway(endpoint:string){
  async function call<T>(action:string,args:unknown[]=[]):Promise<T>{
    const response=await fetch(endpoint,{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({action,args})});
    const result=await response.json() as T&{error?:string};if(!response.ok)throw new Error(result.error??`Instagram respondió ${response.status}.`);return result;
  }
  return {
    getBrand:()=>call<Awaited<ReturnType<InstagramProjectClient["getBrand"]>>>("getBrand"),
    listStyles:()=>call<Awaited<ReturnType<InstagramProjectClient["listStyles"]>>>("listStyles"),
    listDrafts:()=>call<Awaited<ReturnType<InstagramProjectClient["listDrafts"]>>>("listDrafts"),
    listAccounts:()=>call<Awaited<ReturnType<InstagramProjectClient["listAccounts"]>>>("listAccounts"),
    createDraft:(input:DraftInput)=>call<Awaited<ReturnType<InstagramProjectClient["createDraft"]>>>("createDraft",[input]),
    approveDraft:(id:string)=>call<Awaited<ReturnType<InstagramProjectClient["approveDraft"]>>>("approveDraft",[id]),
    publishDraft:(id:string)=>call<Awaited<ReturnType<InstagramProjectClient["publishDraft"]>>>("publishDraft",[id]),
    cancelDraft:(id:string)=>call<Awaited<ReturnType<InstagramProjectClient["cancelDraft"]>>>("cancelDraft",[id]),
    retryDraftAfterCheckingInstagram:(id:string)=>call<Awaited<ReturnType<InstagramProjectClient["retryDraftAfterCheckingInstagram"]>>>("retryDraftAfterCheckingInstagram",[id]),
    searchProducts:(query="",limit=25)=>call<Awaited<ReturnType<InstagramProjectClient["searchProducts"]>>>("searchProducts",[query,limit]),
    listAssets:()=>call<Awaited<ReturnType<InstagramProjectClient["listAssets"]>>>("listAssets"),
    listHistory:()=>call<Awaited<ReturnType<InstagramProjectClient["listHistory"]>>>("listHistory"),
    selectAccount:(id:string)=>call<Awaited<ReturnType<InstagramProjectClient["selectAccount"]>>>("selectAccount",[id]),
    startInstagramOAuth:()=>call<Awaited<ReturnType<InstagramProjectClient["startInstagramOAuth"]>>>("startInstagramOAuth"),
    async uploadAsset(file:Blob,name:string){const form=new FormData();form.append("file",file,name);const response=await fetch(`${endpoint}/upload`,{method:"POST",credentials:"same-origin",body:form});const result=await response.json() as {id:string;media_url:string;error?:string};if(!response.ok)throw new Error(result.error??"No se pudo subir el archivo.");return result;}
  };
}
