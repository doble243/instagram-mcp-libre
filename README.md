# Instagram Core 1.0 RC

Módulo reutilizable para tiendas y paneles que conecta cuentas profesionales de Instagram, toma contexto real de marca y productos, y permite preparar, aprobar, programar y publicar posts, Stories, Reels y carruseles. Expone API HTTP, SDK, MCP (33 herramientas), A2A 1.0, CLI y Studio embebible.

**Estado:** candidato `1.0.0-rc.1`. La prueba automatizada cubre persistencia, aislamiento, permisos y llamadas simuladas a Meta. La validación con OAuth y publicación real, y la instalación en Conecta, World Case y Nanisports, requiere credenciales y acceso a esos proyectos. No se ha desplegado un servicio público.

## Capacidades

| Área | Incluido |
| --- | --- |
| Conexión | OAuth por tienda, tokens cifrados AES-256-GCM, renovación, selección y desconexión de cuentas. |
| Editorial | Borradores, aprobación, programación, posts, Stories, Reels, carruseles, historial y revisión de errores inciertos. |
| Contexto | Marca, logo, paleta, catálogo real, imágenes y estilos opcionales; sugerencias de texto basadas en datos sincronizados. |
| Equipo | Tokens de 15 minutos con permisos `read`, `edit`, `approve`, `publish`, `accounts`; registro de acciones HTTP. |
| Agentes | MCP HTTP, A2A con comandos JSON explícitos, CLI e instrucciones en `.agents/skills/integrar-instagram-core/`. |
| Interfaz | Studio embebible sin dependencia de React: resumen, estilos, catálogo, carga, borradores, cuentas e historial. |
| Persistencia | PostgreSQL privado + bucket privado de Supabase para operación duradera; JSON local para desarrollo. |

El diseño no genera imágenes finales ni inventa precio, stock u ofertas. Las propuestas requieren revisión humana. A2A no interpreta lenguaje libre ni tiene streaming. No se debe reintentar una publicación de estado incierto antes de comprobar Instagram.

## Desarrollo local

Node.js 22 o superior, pnpm:

```bash
cp .env.example .env
# Generar MCP_BEARER_TOKEN, PROJECT_TOKEN_SIGNING_KEY y ASSET_SIGNING_SECRET por separado.
pnpm install
pnpm test
pnpm dev
```

`MOCK_MODE=true` no llama a Meta. `GET /health` verifica el servidor; MCP está en `/mcp` y la Agent Card en `/.well-known/agent-card.json`. `pnpm build` genera `dist/`; `node dist/src/cli.js doctor --url http://localhost:8787` verifica el servicio.

## Configuración duradera

1. Crear un proyecto PostgreSQL y ejecutar [`sql/001_core.sql`](sql/001_core.sql) con un rol autorizado. Se instala el esquema privado `instagram_core` con RLS habilitado y sin permisos de Data API. El servidor debe conectarse con un rol confiable que tenga acceso a ese esquema; no exponer `DATABASE_URL` al navegador.
2. Crear un bucket privado en Supabase Storage. Configurar `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (clave secreta del servidor), `SUPABASE_MEDIA_BUCKET`. El servidor exige los cuatro valores al usar PostgreSQL.
3. Configurar `PUBLIC_BASE_URL` con HTTPS estable, `ASSET_SIGNING_SECRET`, `MCP_BEARER_TOKEN`, `PROJECT_TOKEN_SIGNING_KEY`, `TOKEN_ENCRYPTION_KEY`, `IG_CLIENT_ID`, `IG_CLIENT_SECRET` y `OAUTH_REDIRECT_URI` (la ruta pública `/oauth/instagram/callback`). Registrar esa URI exacta en Meta.
4. Desplegar `pnpm build && pnpm start` en un **servicio Node persistente**. El planificador corre cada 30 segundos dentro del proceso. Múltiples réplicas pueden reclamar una publicación una sola vez mediante PostgreSQL; una operación interrumpida pasa a `needs_review` al vencer la reserva. Mantener una réplica activa para cumplir fechas programadas.
5. Cambiar `MOCK_MODE=false` y validar OAuth, permisos de Meta, cuenta profesional y una publicación de prueba. Sólo entonces `ALLOW_WRITES=true`. Las URLs de medios deben ser HTTPS accesibles desde Meta; los enlaces firmados duran siete días y se renuevan al publicar desde un archivo aún almacenado.

Un endpoint HTTP sin proceso persistente no ejecutará la programación por sí solo. Los planes gratuitos y sus cuotas cambian según proveedor; medir base, almacenamiento y tráfico antes de ofrecerlo a muchas tiendas. No hay una instalación de producción en esta entrega.

## Integración en cada tienda

El host valida su sesión, rol y pertenencia a la tienda. La clave propietaria vive sólo en el backend. Identificadores estables como `conecta_42`, `worldcase` y `nanisports` impiden colisiones.

```ts
import { InstagramAdminClient } from "instagram-mcp-libre/integration";

const admin = new InstagramAdminClient({
  baseUrl: process.env.INSTAGRAM_CORE_URL!,
  ownerToken: process.env.INSTAGRAM_CORE_ADMIN_TOKEN!
});

// Después de comprobar la sesión, el rol y la tienda:
const permissions = ["read", "edit", "approve"] as const;
const ig = await admin.forProject(`conecta_${shop.id}`, session.user.id, [...permissions]);
await ig.syncBrand({businessName: shop.name, logoUrl: shop.logoUrl,
  colors: {primary: shop.primaryColor}}); // Sincronizar mediante credencial con permiso edit.
await ig.upsertProducts(selectedProducts.map(p => ({
  id: p.id, name: p.name, imageUrls: p.images,
  price: p.price, currency: "UYU", availability: p.available ? "available" : "unavailable"
})));
```

El SDK backend exporta `InstagramAdminClient` y `InstagramProjectClient` desde `./integration`. El token de proyecto queda restringido a un workspace, actor y permisos; el backend puede emitir uno diferente para cada rol. Los tokens estáticos en `PROJECT_TOKENS_JSON` conservan todos los permisos y se reservan para servidores de confianza.

### Studio en el panel

```ts
import { createStudioGateway, mountInstagramStudio } from "instagram-mcp-libre/studio";

mountInstagramStudio(document.querySelector("#instagram")!, {
  workspaceId: "conecta_42",
  permissions: ["read", "edit", "approve"],
  gateway: createStudioGateway("/api/instagram")
});
```

`/api/instagram` es una ruta **del backend de la tienda**, en el mismo origen que su panel. Para el POST JSON, verificar sesión y membresía, obtener un `InstagramProjectClient` con permisos derivados del rol, y llamar `executeStudioAction(ig, await request.json(), permissions)` del export `instagram-mcp-libre/host`. Para el POST multipart `/api/instagram/upload`, verificar además `edit`, extraer el archivo y llamar `ig.uploadAsset(file, file.name)`. No enviar `MCP_BEARER_TOKEN`, `INSTAGRAM_CORE_ADMIN_TOKEN` ni `PROJECT_TOKEN_SIGNING_KEY` al navegador. Aplicar protección CSRF en las rutas del host conforme a su autenticación. El host entrega el `workspaceId` y los permisos reales al montar el Studio.

El cargador admite JPG, PNG, WEBP, MP4 y MOV hasta `MAX_UPLOAD_BYTES`; el carrusel del Studio requiere 2 a 10 imágenes. El Core confirma la firma del archivo antes de almacenarlo. El bucket privado se sirve a Meta mediante enlaces firmados del Core.

### CLI y skill del repositorio

```bash
pnpm build
node dist/src/cli.js init --workspace worldcase
node dist/src/cli.js init --workspace-prefix conecta
```

El CLI genera un adaptador inicial y un `AGENTS.md` sin secretos. Las instrucciones propias de este módulo están en [`.agents/skills/integrar-instagram-core/SKILL.md`](.agents/skills/integrar-instagram-core/SKILL.md). Revisar los campos reales de cada plataforma antes de sincronizar.

### Agentes

MCP: `POST /mcp` con `Authorization: Bearer <token>`; las herramientas de escritura exigen su permiso correspondiente y confirmación cuando publican. A2A: `POST /a2a` con `A2A-Version: 1.0` y bearer; la Agent Card pública describe los comandos `brand.get`, `products.search`, `product.suggest`, `accounts.list`, `drafts.list`, `draft.create`, `draft.approve`, `draft.publish`, `history.list`. Las acciones A2A pasan por la misma API autorizada. A2A usa tareas síncronas en memoria.

## Verificación y límites conocidos

`pnpm test` ejecuta pruebas de API simulada, aislamiento entre proyectos, permisos, OAuth local, PostgreSQL en memoria, transacciones y recuperación. Falta una prueba con Meta real y una tienda host real. El Studio no tiene generador visual final de imágenes ni editor avanzado de borradores; esas operaciones están disponibles por SDK/API. La auditoría cubre acciones HTTP correctas; no registra todavía cada invocación MCP o A2A por actor. El planificador requiere servicio persistente y supervisión del proceso. Consulta [`docs/v1-release.md`](docs/v1-release.md) para la lista de puesta en producción.
