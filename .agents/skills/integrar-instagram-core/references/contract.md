# Contrato del Core 1.0 RC

- `InstagramAdminClient({baseUrl,ownerToken}).forProject(workspaceId,actorId,scopes)` emite una credencial de 15 minutos. Scopes: `read`, `edit`, `approve`, `publish`, `accounts`. Host verifica sesión, rol y pertenencia antes de llamar.
- `InstagramProjectClient` (backend): marca, catálogo, sugerencias, OAuth, cuentas, archivos, borradores, aprobación, publicación e historial. ID de proyecto: letras, números, `_` y `-`, máximo 64.
- `mountInstagramStudio(root,{workspaceId,permissions,gateway:createStudioGateway('/api/instagram')})` monta la UI. La ruta homónima pertenece al host. `executeStudioAction(client,body,permissions)` del export `./host` valida el despacho JSON; `/upload` requiere comprobación `edit` y llamada a `client.uploadAsset`.
- MCP HTTP `/mcp` con bearer del proyecto. A2A 1.0 JSON-RPC `/a2a`, header `A2A-Version: 1.0`; Agent Card `/.well-known/agent-card.json`. Acciones JSON: `brand.get`, `products.search`, `product.suggest`, `accounts.list`, `drafts.list`, `draft.create`, `draft.approve`, `draft.publish`, `history.list`.
- CLI: `instagram-core init --workspace ID` o `--workspace-prefix PREFIX`; `doctor --url URL`.
- Servidor real: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_MEDIA_BUCKET`, `MCP_BEARER_TOKEN`, `PROJECT_TOKEN_SIGNING_KEY`, `ASSET_SIGNING_SECRET`, `TOKEN_ENCRYPTION_KEY`, `IG_CLIENT_ID`, `IG_CLIENT_SECRET`, `OAUTH_REDIRECT_URI`, `PUBLIC_BASE_URL`, `MOCK_MODE=false`. Para escribir realmente, `ALLOW_WRITES=true` después de validar Meta.
- PostgreSQL: ejecutar `sql/001_core.sql` en esquema privado. Bucket privado de Supabase. Un servicio Node persistente ejecuta el scheduler.
- `1.0.0-rc.1`: validación real con Meta y plataformas host aún pendiente; consultar `docs/v1-release.md`.
