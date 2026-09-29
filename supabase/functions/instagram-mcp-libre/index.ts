type Placement = "feed" | "story" | "reel";
type AssetType = "image" | "video";
type Json = Record<string, unknown>;

const graphVersion = Deno.env.get("IG_GRAPH_VERSION") || "v25.0";
const demoMode = Deno.env.get("MOCK_MODE") !== "false";
const allowWrites = Deno.env.get("ALLOW_WRITES") === "true";
const accessToken = Deno.env.get("IG_ACCESS_TOKEN");
const userId = Deno.env.get("IG_USER_ID");

const definitions = [
  { name: "instagram_profile", title: "Ver perfil de Instagram", description: "Devuelve el perfil conectado; en modo demo usa datos ficticios.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "instagram_recent_posts", title: "Listar publicaciones recientes", description: "Lista publicaciones y Reels recientes.", inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 25, default: 10 } }, additionalProperties: false } },
  { name: "instagram_post_insights", title: "Consultar métricas", description: "Obtiene métricas disponibles para un post o Reel.", inputSchema: { type: "object", properties: { media_id: { type: "string" } }, required: ["media_id"], additionalProperties: false } },
  { name: "instagram_post_comments", title: "Leer comentarios", description: "Trae comentarios recientes de una publicación.", inputSchema: { type: "object", properties: { media_id: { type: "string" } }, required: ["media_id"], additionalProperties: false } },
  { name: "instagram_reply_to_comment", title: "Responder comentario", description: "Publica una respuesta. Acción externa: confirma el texto exacto con el usuario antes de ejecutarla.", inputSchema: { type: "object", properties: { comment_id: { type: "string" }, message: { type: "string", maxLength: 2200 } }, required: ["comment_id", "message"], additionalProperties: false }, annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  { name: "instagram_publish_media", title: "Publicar post, historia o Reel", description: "Publica una imagen o video desde una URL HTTPS directa que Meta pueda descargar. Destino: feed, story o reel. Acción externa: muestra el archivo y el texto al usuario y pide confirmación antes de publicar. Stories requieren cuenta Business y están sujetas a permisos de Meta.", inputSchema: { type: "object", properties: { media_url: { type: "string", format: "uri" }, asset_type: { type: "string", enum: ["image", "video"] }, destination: { type: "string", enum: ["feed", "story", "reel"] }, caption: { type: "string", maxLength: 2200, default: "" }, share_to_feed: { type: "boolean", default: true } }, required: ["media_url", "asset_type", "destination"], additionalProperties: false }, annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true } }
];

const demoPosts = [
  { id: "demo-101", caption: "Nueva colección disponible ✨", media_type: "IMAGE", permalink: "https://example.com/demo-post-101", timestamp: "2026-09-25T18:30:00Z", like_count: 42, comments_count: 6 },
  { id: "demo-102", caption: "Envíos a todo el país 📦", media_type: "VIDEO", permalink: "https://example.com/demo-post-102", timestamp: "2026-09-24T14:10:00Z", like_count: 31, comments_count: 3 }
];

function toolResult(data: unknown) {
  return { content: [{ type: "text", text: JSON.stringify({ demo: demoMode, data }, null, 2) }], structuredContent: { demo: demoMode, data } };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

async function igRequest(path: string, method = "GET", fields: Record<string, string> = {}): Promise<Json> {
  if (!accessToken) throw new Error("Instagram no está conectado: define IG_ACCESS_TOKEN como secreto de la Edge Function.");
  const url = new URL(`https://graph.instagram.com/${graphVersion}${path}`);
  const headers = new Headers({ authorization: `Bearer ${accessToken}` });
  if (method !== "GET") headers.set("content-type", "application/x-www-form-urlencoded");
  const response = await fetch(url, {
    method,
    headers,
    body: method === "GET" ? undefined : new URLSearchParams(fields)
  });
  const data = await response.json() as Json;
  if (!response.ok) {
    const err = data.error as { message?: string } | undefined;
    throw new Error(`Instagram API (${response.status}): ${err?.message ?? "solicitud rechazada"}`);
  }
  return data;
}

async function publishMedia(args: Json) {
  if (demoMode) return { success: true, demo: true, message: "Simulación: no se publicó en Instagram.", args };
  if (!allowWrites) throw new Error("Publicaciones desactivadas. Configura ALLOW_WRITES=true tras revisar permisos y pruebas.");
  if (!userId) throw new Error("Falta IG_USER_ID como secreto de la Edge Function.");
  if (!accessToken) throw new Error("Falta IG_ACCESS_TOKEN como secreto de la Edge Function.");

  const mediaUrl = String(args.media_url ?? "");
  const parsed = new URL(mediaUrl);
  if (parsed.protocol !== "https:") throw new Error("Meta debe poder descargar el archivo desde una URL HTTPS pública.");
  const assetType = args.asset_type as AssetType;
  const placement = args.destination as Placement;
  const caption = String(args.caption ?? "");
  if (placement === "reel" && assetType !== "video") throw new Error("Los Reels requieren un video.");
  if (!(["feed", "story", "reel"].includes(placement)) || !(["image", "video"].includes(assetType))) throw new Error("Formato o destino no válido.");

  const fields: Record<string, string> = assetType === "image" ? { image_url: mediaUrl } : { video_url: mediaUrl };
  if (placement === "story") fields.media_type = "STORIES";
  else if (placement === "reel") fields.media_type = "REELS";
  else if (assetType === "video") fields.media_type = "VIDEO";
  if (placement !== "story" && caption) fields.caption = caption;
  if (placement === "reel") fields.share_to_feed = String(args.share_to_feed ?? true);

  const container = await igRequest(`/${encodeURIComponent(userId)}/media`, "POST", fields);
  const containerId = String(container.id ?? "");
  if (!containerId) throw new Error("Instagram no devolvió el ID del contenedor de medios.");

  if (assetType === "video") {
    let ready = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const status = await igRequest(`/${encodeURIComponent(containerId)}`, "GET", { fields: "status_code,status" });
      if (status.status_code === "FINISHED") { ready = true; break; }
      if (status.status_code === "ERROR" || status.status_code === "EXPIRED") throw new Error(`Instagram no pudo procesar el video: ${String(status.status ?? status.status_code)}`);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    if (!ready) throw new Error("Instagram todavía procesa el video. No se publicó; espera antes de volver a intentar.");
  }

  const published = await igRequest(`/${encodeURIComponent(userId)}/media_publish`, "POST", { creation_id: containerId });
  return { container_id: containerId, published_media: published };
}

async function callTool(name: string, args: Json) {
  if (demoMode) {
    switch (name) {
      case "instagram_profile": return toolResult({ id: "demo-account", username: "simplemente_demo", account_type: "BUSINESS", media_count: 18 });
      case "instagram_recent_posts": return toolResult(demoPosts.slice(0, Math.max(1, Math.min(25, Number(args.limit ?? 10)))));
      case "instagram_post_insights": return toolResult({ media_id: String(args.media_id ?? ""), insights: [{ name: "reach", value: 810 }, { name: "saved", value: 24 }, { name: "shares", value: 9 }] });
      case "instagram_post_comments": return toolResult({ media_id: String(args.media_id ?? ""), comments: [{ id: "demo-comment-1", username: "cliente_demo", text: "¿Hacen envíos al interior?" }] });
      case "instagram_reply_to_comment": return toolResult({ success: true, demo: true, message: "Simulación: respuesta no enviada.", comment_id: args.comment_id, reply: args.message });
      case "instagram_publish_media": return toolResult(await publishMedia(args));
      default: throw new Error(`Herramienta desconocida: ${name}`);
    }
  }

  switch (name) {
    case "instagram_profile": return toolResult(await igRequest("/me", "GET", { fields: "id,user_id,username,account_type,media_count" }));
    case "instagram_recent_posts": return toolResult(await igRequest("/me/media", "GET", { fields: "id,caption,media_type,permalink,timestamp,like_count,comments_count", limit: String(Math.max(1, Math.min(25, Number(args.limit ?? 10)))) }));
    case "instagram_post_insights": return toolResult(await igRequest(`/${encodeURIComponent(String(args.media_id ?? ""))}/insights`, "GET", { metric: "reach,saved,shares" }));
    case "instagram_post_comments": return toolResult(await igRequest(`/${encodeURIComponent(String(args.media_id ?? ""))}/comments`, "GET", { fields: "id,text,username,timestamp", limit: "50" }));
    case "instagram_reply_to_comment": {
      if (!allowWrites) throw new Error("Respuestas desactivadas. Configura ALLOW_WRITES=true después de validar permisos.");
      return toolResult(await igRequest(`/${encodeURIComponent(String(args.comment_id ?? ""))}/replies`, "POST", { message: String(args.message ?? "") }));
    }
    case "instagram_publish_media": return toolResult(await publishMedia(args));
    default: throw new Error(`Herramienta desconocida: ${name}`);
  }
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, apikey" } });
  if (request.method !== "POST") return json({ error: "Use POST for Streamable HTTP MCP." }, 405);

  let rpc: Json;
  try { rpc = await request.json() as Json; }
  catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }

  const id = rpc.id ?? null;
  const method = rpc.method;
  const params = (rpc.params ?? {}) as Json;
  if (method === "notifications/initialized" || method === "notifications/cancelled") return new Response(null, { status: 202 });
  if (method === "initialize") return json({ jsonrpc: "2.0", id, result: { protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "instagram-mcp-libre", version: "0.2.0" }, instructions: demoMode ? "Modo demo: datos ficticios y escrituras simuladas." : "Conectado por Meta Graph API. Publicar requiere confirmación humana previa." } });
  if (method === "ping") return json({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") return json({ jsonrpc: "2.0", id, result: { tools: definitions } });
  if (method === "tools/call") {
    try {
      const result = await callTool(String(params.name ?? ""), (params.arguments ?? {}) as Json);
      return json({ jsonrpc: "2.0", id, result });
    } catch (error) {
      return json({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Error interno" }] } });
    }
  }
  if (typeof id === "string" || typeof id === "number") return json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(method)}` } }, 404);
  return new Response(null, { status: 202 });
});
