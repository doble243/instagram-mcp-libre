export type Env = {
  mockMode: boolean;
  allowWrites: boolean;
  accessToken?: string;
  userId?: string;
  graphVersion: string;
};

export type Fetcher = typeof fetch;

const demoMedia = [
  { id: "demo-101", caption: "Nueva colección disponible ✨", media_type: "IMAGE", permalink: "https://www.instagram.com/p/demo101/", timestamp: "2026-09-25T18:30:00+0000", like_count: 42, comments_count: 6 },
  { id: "demo-102", caption: "Envíos a todo el país 📦", media_type: "VIDEO", permalink: "https://www.instagram.com/p/demo102/", timestamp: "2026-09-24T14:10:00+0000", like_count: 31, comments_count: 3 }
];

export type Placement = "feed" | "story" | "reel" | "carousel";
export type AssetType = "image" | "video";

export class InstagramApi {
  constructor(private readonly env: Env, private readonly fetcher: Fetcher = fetch) {}

  async getProfile() {
    if (this.env.mockMode) return { id: "demo-account", username: "simplemente_demo", account_type: "BUSINESS", media_count: 18 };
    return this.request("/me", { fields: "id,user_id,username,account_type,media_count" });
  }

  async listMedia(limit = 10) {
    if (this.env.mockMode) return { data: demoMedia.slice(0, limit) };
    return this.request("/me/media", { fields: "id,caption,media_type,permalink,timestamp,like_count,comments_count", limit: String(limit) });
  }

  async getMediaInsights(mediaId: string) {
    if (this.env.mockMode) return { id: mediaId, insights: [{ name: "reach", values: [{ value: 810 }] }, { name: "saved", values: [{ value: 24 }] }, { name: "shares", values: [{ value: 9 }] }] };
    return this.request(`/${encodeURIComponent(mediaId)}/insights`, { metric: "reach,saved,shares" });
  }

  async getComments(mediaId: string) {
    if (this.env.mockMode) return { data: [{ id: "demo-comment-1", text: "¿Hacen envíos al interior?", username: "cliente_demo", timestamp: "2026-09-25T20:00:00+0000" }] };
    return this.request(`/${encodeURIComponent(mediaId)}/comments`, { fields: "id,text,username,timestamp", limit: "50" });
  }

  async replyToComment(commentId: string, message: string) {
    if (this.env.mockMode) return { success: true, demo: true, comment_id: commentId, message };
    this.assertWritesEnabled();
    return this.request(`/${encodeURIComponent(commentId)}/replies`, {}, "POST", { message });
  }

  async publishMedia(input: { mediaUrl: string; assetType: AssetType; placement: Placement; caption?: string; shareToFeed?: boolean }) {
    const { mediaUrl, assetType, placement, caption = "", shareToFeed = true } = input;
    if (this.env.mockMode) return { success: true, demo: true, placement, asset_type: assetType, media_url: mediaUrl, caption };
    this.assertWritesEnabled();
    if (!this.env.userId) throw new Error("Falta IG_USER_ID en el entorno.");
    if (placement === "reel" && assetType !== "video") throw new Error("Los Reels requieren un video.");

    const mediaType = placement === "story" ? "STORIES" : placement === "reel" ? "REELS" : assetType === "video" ? "VIDEO" : undefined;
    const createFields: Record<string, string> = assetType === "image" ? { image_url: mediaUrl } : { video_url: mediaUrl };
    if (mediaType) createFields.media_type = mediaType;
    if (placement !== "story" && caption) createFields.caption = caption;
    if (placement === "reel") createFields.share_to_feed = String(shareToFeed);

    const container = await this.request(`/${encodeURIComponent(this.env.userId)}/media`, {}, "POST", createFields);
    const containerId = String(container.id ?? "");
    if (!containerId) throw new Error("Instagram no devolvió un ID de contenedor.");

    if (assetType === "video") await this.waitForContainer(containerId);
    const published = await this.request(`/${encodeURIComponent(this.env.userId)}/media_publish`, {}, "POST", { creation_id: containerId });
    return { container_id: containerId, published_media: published };
  }

  async publishCarousel(input: { mediaUrls: string[]; caption?: string }) {
    if (input.mediaUrls.length < 2 || input.mediaUrls.length > 10) throw new Error("Un carrusel requiere entre 2 y 10 archivos.");
    if (this.env.mockMode) return { success: true, demo: true, placement: "carousel", media_urls: input.mediaUrls, caption: input.caption ?? "" };
    this.assertWritesEnabled();
    if (!this.env.userId) throw new Error("Falta IG_USER_ID en el entorno.");
    const childIds: string[] = [];
    for (const mediaUrl of input.mediaUrls) {
      const child = await this.request(`/${encodeURIComponent(this.env.userId)}/media`, {}, "POST", {
        image_url: mediaUrl,
        is_carousel_item: "true"
      });
      const id = String(child.id ?? "");
      if (!id) throw new Error("Instagram no devolvió un ID para un elemento del carrusel.");
      childIds.push(id);
    }
    const parent = await this.request(`/${encodeURIComponent(this.env.userId)}/media`, {}, "POST", {
      media_type: "CAROUSEL",
      children: childIds.join(","),
      ...(input.caption ? { caption: input.caption } : {})
    });
    const containerId = String(parent.id ?? "");
    if (!containerId) throw new Error("Instagram no devolvió un contenedor para el carrusel.");
    const published = await this.request(`/${encodeURIComponent(this.env.userId)}/media_publish`, {}, "POST", { creation_id: containerId });
    return { container_id: containerId, child_container_ids: childIds, published_media: published };
  }

  private assertWritesEnabled() {
    if (!this.env.allowWrites) throw new Error("Publicación y respuestas están desactivadas. Configura ALLOW_WRITES=true después de validar la cuenta y los permisos.");
  }

  private async waitForContainer(id: string) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const status = await this.request(`/${encodeURIComponent(id)}`, { fields: "status_code,status" });
      if (status.status_code === "FINISHED") return;
      if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
        throw new Error(`Instagram no pudo procesar el video: ${String(status.status ?? status.status_code)}`);
      }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    throw new Error("Instagram todavía procesa el video. No se publicó; vuelve a consultar el contenedor antes de reintentar.");
  }

  private async request(path: string, query: Record<string, string> = {}, method = "GET", body?: Record<string, string>) {
    if (!this.env.accessToken) throw new Error("Falta IG_ACCESS_TOKEN en los secretos del servidor.");
    const url = new URL(`https://graph.instagram.com/${this.env.graphVersion}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const headers: Record<string, string> = { authorization: `Bearer ${this.env.accessToken}` };
    if (body) headers["content-type"] = "application/x-www-form-urlencoded";
    const response = await this.fetcher(url, {
      method,
      headers,
      body: body ? new URLSearchParams(body) : undefined,
      signal:AbortSignal.timeout(30_000)
    });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      const metaError = data.error as { message?: string } | undefined;
      throw new Error(`Instagram API (${response.status}): ${metaError?.message ?? "solicitud rechazada"}`);
    }
    return data;
  }
}

export function getEnv(): Env {
  return {
    mockMode: process.env.MOCK_MODE !== "false",
    allowWrites: process.env.ALLOW_WRITES === "true",
    accessToken: process.env.IG_ACCESS_TOKEN || undefined,
    userId: process.env.IG_USER_ID || undefined,
    graphVersion: process.env.IG_GRAPH_VERSION || "v25.0"
  };
}
