import { randomUUID } from "node:crypto";
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, JsonRpcTransportHandler, ServerCallContext, type AgentExecutor } from "@a2a-js/sdk/server";
import { Role, TaskState, type AgentCard, type Message, type Part, type Task } from "@a2a-js/sdk";
import { z } from "zod";
import { InstagramProjectClient } from "./client.js";
import type { Principal } from "./tenant.js";

const commandSchema=z.discriminatedUnion("action",[
  z.object({action:z.literal("brand.get")}),
  z.object({action:z.literal("products.search"),query:z.string().max(100).optional(),limit:z.number().int().min(1).max(100).optional()}),
  z.object({action:z.literal("product.suggest"),product_id:z.string().min(1),format:z.enum(["feed","story"]).optional()}),
  z.object({action:z.literal("accounts.list")}),
  z.object({action:z.literal("drafts.list")}),
  z.object({action:z.literal("draft.create"),media_urls:z.array(z.string().url()).min(1).max(10),asset_type:z.enum(["image","video"]),destination:z.enum(["feed","story","reel","carousel"]),caption:z.string().max(2200).optional(),scheduled_at:z.string().datetime().nullable().optional()}),
  z.object({action:z.literal("draft.approve"),draft_id:z.string().uuid(),confirmed:z.literal(true)}),
  z.object({action:z.literal("draft.publish"),draft_id:z.string().uuid(),confirmed:z.literal(true)}),
  z.object({action:z.literal("history.list")})
]);
export type AgentCommand=z.infer<typeof commandSchema>;

function dataPart(value:unknown):Part {return {content:{$case:"data",value},mediaType:"application/json",metadata:undefined,filename:""};}
function message(contextId:string,taskId:string,value:unknown):Message {return {messageId:randomUUID(),contextId,taskId,role:Role.ROLE_AGENT,parts:[dataPart(value)],metadata:undefined,extensions:[],referenceTaskIds:[]};}
function parseCommand(parts:Part[]) {
  const wire=parts as Array<Part&{data?:unknown;text?:string}>;
  const data=wire.find(part=>part.data!==undefined)?.data??parts.find(part=>part.content?.$case==="data")?.content;
  const raw=data??wire.find(part=>typeof part.text==="string")?.text??parts.find(part=>part.content?.$case==="text")?.content;
  let value:unknown=typeof raw==="string"?JSON.parse(raw):raw&&typeof raw==="object"&&"$case" in raw?"value" in raw?raw.value:undefined:raw;
  if(typeof value==="string") value=JSON.parse(value);
  return commandSchema.parse(value);
}
export async function executeCommand(client:InstagramProjectClient,cmd:AgentCommand):Promise<unknown> {
  switch(cmd.action) {
    case "brand.get":return client.getBrand();
    case "products.search":return client.searchProducts(cmd.query??"",cmd.limit??25);
    case "product.suggest":return client.suggestProduct(cmd.product_id,cmd.format??"feed");
    case "accounts.list":return client.listAccounts();
    case "drafts.list":return client.listDrafts();
    case "draft.create":return client.createDraft({media_urls:cmd.media_urls,asset_type:cmd.asset_type,destination:cmd.destination,caption:cmd.caption,scheduled_at:cmd.scheduled_at});
    case "draft.approve":return client.approveDraft(cmd.draft_id);
    case "draft.publish":return client.publishDraft(cmd.draft_id);
    case "history.list":return client.listHistory();
  }
}
export function agentCard(baseUrl:string):AgentCard {
  const skill=(id:string,name:string,description:string,examples:string[])=>({id,name,description,tags:["instagram","comercio"],examples,inputModes:["application/json"],outputModes:["application/json"],securityRequirements:[{schemes:{bearer:{list:[]}}}]});
  return {
    name:"Instagram Commerce Core",version:"1.0.0-rc.1",description:"Agente de operaciones de Instagram para una tienda autenticada. Acepta comandos JSON explícitos; no interpreta pedidos libres.",
    supportedInterfaces:[{url:`${baseUrl.replace(/\/$/,"")}/a2a`,protocolBinding:"JSONRPC",protocolVersion:"1.0",tenant:""}],
    provider:undefined,capabilities:{streaming:false,pushNotifications:false,extensions:[]},
    securitySchemes:{bearer:{scheme:{$case:"httpAuthSecurityScheme",value:{scheme:"Bearer",bearerFormat:"",description:"Token de proyecto"}}}},
    securityRequirements:[{schemes:{bearer:{list:[]}}}],defaultInputModes:["application/json","text/plain"],defaultOutputModes:["application/json"],signatures:[],
    skills:[skill("catalog","Consultar catálogo","Busca productos reales y propone un texto revisable.",["{\"action\":\"products.search\",\"query\":\"funda\"}"]),skill("editorial","Borradores y publicación","Crea, aprueba y publica borradores con confirmación explícita.",["{\"action\":\"drafts.list\"}"])]
  };
}
export function createA2A(publicBaseUrl:string,internalBaseUrl=publicBaseUrl):{card:AgentCard;handle:(body:unknown,principal:Principal,token:string)=>Promise<unknown>} {
  const executor:AgentExecutor={
    async execute(request,bus) {
      const {taskId,contextId}=request;
      const task:Task={id:taskId,contextId,status:{state:TaskState.TASK_STATE_WORKING,message:undefined,timestamp:new Date().toISOString()},artifacts:[],history:[request.userMessage],metadata:undefined};
      bus.publish(AgentEvent.task(task));
      let result:unknown;let state=TaskState.TASK_STATE_COMPLETED;
      try {
        const ctx=request.context.state.get("auth") as {token:string;workspaceId:string}|undefined;
        if(!ctx)throw new Error("Falta autenticación.");
        const client=new InstagramProjectClient({baseUrl:internalBaseUrl,token:ctx.token,workspaceId:ctx.workspaceId});
        result=await executeCommand(client,parseCommand(request.userMessage.parts));
      }catch(error){state=TaskState.TASK_STATE_FAILED;result={error:error instanceof Error?error.message:String(error)};}
      const output=message(contextId,taskId,result);
      bus.publish(AgentEvent.artifactUpdate({taskId,contextId,artifact:{artifactId:randomUUID(),name:"resultado",description:"Resultado de la acción",parts:output.parts,metadata:undefined,extensions:[]},append:false,lastChunk:true,metadata:undefined}));
      bus.publish(AgentEvent.statusUpdate({taskId,contextId,status:{state,message:output,timestamp:new Date().toISOString()},metadata:undefined}));
    },
    async cancelTask(taskId,bus){bus.publish(AgentEvent.statusUpdate({taskId,contextId:"",status:{state:TaskState.TASK_STATE_CANCELED,message:undefined,timestamp:new Date().toISOString()},metadata:undefined}));}
  };
  const handler=new DefaultRequestHandler(agentCard(publicBaseUrl),new InMemoryTaskStore(),executor);
  const transport=new JsonRpcTransportHandler(handler);
  return {
    card:agentCard(publicBaseUrl),
    async handle(body:unknown,principal:Principal,token:string) {
      const workspaceId=principal.workspaceId??"default";
      const userName=principal.kind==="project"?`${workspaceId}:${principal.actorId??"project"}`:"owner";
      const context=new ServerCallContext({tenant:workspaceId,user:{isAuthenticated:true,userName},requestedVersion:"1.0",state:new Map([["auth",{token,workspaceId}]])});
      return transport.handle(body as Record<string,unknown>,context);
    }
  };
}
