#!/usr/bin/env node
import { mkdir, writeFile, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { validateWorkspaceId } from "./tenant.js";

const [, ,command,...args]=process.argv;
function option(name:string) {const i=args.indexOf(`--${name}`);return i>=0?args[i+1]:undefined;}
function help() {console.log(`Instagram Core CLI
  instagram-core init --workspace ID [--dir PATH]   Crea adaptador fijo
  instagram-core init --workspace-prefix conecta    Adaptador para tiendas dinámicas
  instagram-core doctor --url URL                   Verifica el servicio y A2A
  instagram-core help                               Muestra comandos
Usa el token sólo en variables de entorno del backend; nunca en argumentos del CLI.`);}
async function main() {
  if(!command||command==="help"||command==="--help"){help();return;}
  if(command==="doctor") {
    const base=(option("url")??process.env.INSTAGRAM_CORE_URL??"http://localhost:8787").replace(/\/$/,"");
    const [health,card]=await Promise.all([fetch(`${base}/health`),fetch(`${base}/.well-known/agent-card.json`)]);
    if(!health.ok||!card.ok)throw new Error(`Servicio no disponible: health=${health.status}, A2A=${card.status}`);
    const data=await card.json() as {name:string;version:string};
    console.log(`Core activo. A2A: ${data.name} ${data.version}. MCP: ${base}/mcp`);return;
  }
  if(command==="init") {
    const prefix=option("workspace-prefix");
    if(prefix&&option("workspace"))throw new Error("Elegí --workspace o --workspace-prefix.");
    const workspaceId=validateWorkspaceId(prefix??option("workspace")??"");
    const dir=resolve(option("dir")??`instagram-${workspaceId}`);
    await mkdir(dir,{recursive:true});
    const files:Record<string,string>={
      ".env.example":"INSTAGRAM_CORE_URL=http://localhost:8787\nINSTAGRAM_CORE_ADMIN_TOKEN=\n# Generar secretos distintos en el servidor Core con: openssl rand -hex 32\n",
      "instagram.adapter.example.ts":`import { InstagramAdminClient } from "instagram-mcp-libre/integration";

const admin = new InstagramAdminClient({
  baseUrl: process.env.INSTAGRAM_CORE_URL!,
  ownerToken: process.env.INSTAGRAM_CORE_ADMIN_TOKEN!
});

// Llamar sólo en el backend después de verificar sesión, rol y pertenencia a la tienda.
export async function instagramForShop(userId: string, shop: {
  id: string; name: string; logoUrl?: string; primaryColor?: string;
}) {
  const workspaceId = ${prefix?`${JSON.stringify(workspaceId+"_")} + shop.id`:JSON.stringify(workspaceId)};
  ${prefix?"if (!/^[a-zA-Z0-9_-]{1,64}$/.test(workspaceId)) throw new Error(\"ID de tienda inválido\");":`if (shop.id !== ${JSON.stringify(workspaceId)}) throw new Error("Tienda incorrecta");`}
  const client = await admin.forProject(workspaceId, userId);
  await client.syncBrand({businessName: shop.name, logoUrl: shop.logoUrl,
    colors: shop.primaryColor ? {primary: shop.primaryColor} : undefined});
  return client;
}
`,
      "AGENTS.md":`# Instagram del proyecto ${workspaceId}

- Usar el Core compartido por MCP (/mcp) o A2A (/a2a). A2A Agent Card: /.well-known/agent-card.json.
- Obtener productos, precio, stock, fotos y marca del backend real de la tienda; no inventar datos.
- Pedir revisión humana del texto y medio antes de llamar a approve/publish.
- Guardar el token propietario sólo en el backend. Validar sesión, rol y membresía antes de emitir token de proyecto.
- Si una publicación falla, comprobar Instagram antes de reintentar. Nunca reintentar automáticamente.
- A2A acepta comandos JSON como {"action":"products.search","query":"funda"}. Para lenguaje libre usar un agente externo conectado al MCP.
`
    };
    for(const name of Object.keys(files)) {
      const target=join(dir,name);
      try{await access(target);throw new Error(`Ya existe ${target}; no se sobrescribió.`);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    }
    for(const [name,content] of Object.entries(files)) {
      const target=join(dir,name);
      await writeFile(target,content,{flag:"wx",mode:0o600});
    }
    console.log(`Integración creada en ${dir}. Configurá el backend y probá con instagram-core doctor.`);return;
  }
  throw new Error(`Comando desconocido: ${command}`);
}
main().catch(error=>{console.error(error instanceof Error?error.message:error);process.exitCode=1;});
