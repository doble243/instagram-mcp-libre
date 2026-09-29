---
name: integrar-instagram-core
description: Integrar Instagram MCP Libre/Core en una tienda, SaaS o panel de administración mediante SDK, MCP o A2A. Usar cuando se pida conectar Instagram, crear borradores, publicar posts/Stories/Reels desde productos reales o instalar el módulo en un proyecto como Conecta, World Case o Nanisports.
---

# Integrar Instagram Core

1. Inspeccionar la sesión, roles, ID permanente de tienda, catálogo, medios y marca del host. Identificar una ruta de administración existente; no inventar campos ni exponer secretos en frontend.
2. Consultar `references/contract.md` para el contrato actual. En este repositorio, después de `pnpm build`, ejecutar `instagram-core init --workspace ID` para un proyecto fijo o `instagram-core init --workspace-prefix conecta` para tiendas dinámicas. Revisar el adaptador generado.
3. Mantener el bearer propietario y las claves de Meta exclusivamente en el backend. Verificar usuario, rol y membresía antes de `InstagramAdminClient.forProject(workspaceId, actorId, scopes)`; emitir sólo los permisos del rol. Usar IDs estables, prefijados cuando distintas plataformas puedan colisionar.
4. Sincronizar nombre, logo, paleta y productos seleccionados desde las fuentes reales. No inventar precio, stock, descuentos, atributos ni imágenes. Mostrar sugerencias como borradores revisables.
5. Conectar OAuth por tienda, cargar medios HTTPS, crear borrador, previsualizar, aprobar y publicar con confirmación humana. No reintentar automáticamente si la publicación pudo haberse enviado; comprobar Instagram primero.
6. Para agentes: priorizar MCP `/mcp` si el cliente lo soporta. Usar A2A `/a2a` cuando un agente externo necesite delegar acciones estructuradas y consultar `/.well-known/agent-card.json`. A2A acepta comandos JSON explícitos y no interpreta lenguaje libre.
7. Verificar aislamiento cruzado con al menos dos tiendas, credenciales vencidas, publicación simulada, build y pruebas. Para producción configurar PostgreSQL privado, bucket privado y servicio Node persistente; verificar la lista `docs/v1-release.md`. Registrar límites de auditoría MCP/A2A y validar Meta real antes de declarar 1.0 estable.

Esta skill viaja con el repositorio y no contiene credenciales. La API del proyecto host debe intermediar llamadas del navegador al Core. Usar `mountInstagramStudio` con `createStudioGateway` y, en el backend, `executeStudioAction` más una ruta de carga protegida.
