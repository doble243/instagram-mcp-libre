import { z } from "zod";
import { InstagramProjectClient } from "./client.js";
import type { ProjectScope } from "./tenant.js";

/** Call from a host backend after authenticating the user and checking shop membership. */
export async function executeStudioAction(client:InstagramProjectClient,body:unknown,permissions:ProjectScope[]){
  const request=z.object({action:z.string(),args:z.array(z.unknown()).max(3)}).strict().parse(body);
  const scope:ProjectScope=({createDraft:"edit",approveDraft:"approve",publishDraft:"publish",cancelDraft:"edit",retryDraftAfterCheckingInstagram:"publish",selectAccount:"accounts",startInstagramOAuth:"accounts"} as Record<string,ProjectScope>)[request.action]??"read";
  if(!permissions.includes(scope))throw new Error(`El usuario no tiene permiso de ${scope}.`);
  const a=request.args;
  const id=()=>z.string().uuid().parse(a[0]);
  switch(request.action){
    case "getBrand":return client.getBrand();
    case "listStyles":return client.listStyles();
    case "listDrafts":return client.listDrafts();
    case "listAccounts":return client.listAccounts();
    case "searchProducts":return client.searchProducts(z.string().max(100).parse(a[0]),z.number().int().min(1).max(100).parse(a[1]));
    case "listAssets":return client.listAssets();
    case "listHistory":return client.listHistory();
    case "createDraft":return client.createDraft(z.object({media_urls:z.array(z.string().url()).min(1).max(10),asset_type:z.enum(["image","video"]),destination:z.enum(["feed","story","reel","carousel"]),caption:z.string().max(2200).optional(),scheduled_at:z.string().datetime().nullable().optional()}).strict().parse(a[0]));
    case "approveDraft":return client.approveDraft(id());
    case "publishDraft":return client.publishDraft(id());
    case "cancelDraft":return client.cancelDraft(id());
    case "retryDraftAfterCheckingInstagram":return client.retryDraftAfterCheckingInstagram(id());
    case "selectAccount":return client.selectAccount(z.string().min(1).max(128).parse(a[0]));
    case "startInstagramOAuth":return client.startInstagramOAuth();
    default:throw new Error("Acción no permitida.");
  }
}
