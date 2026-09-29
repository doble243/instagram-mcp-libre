# Cierre de 1.0

## Verificado en esta versión candidata

- Pruebas unitarias e integración local, incluido PostgreSQL mediante PGlite.
- Aislamiento de dos proyectos, tokens firmados con permisos, reclamo transaccional de publicaciones, estado OAuth de un solo uso y almacenamiento privado preparado.
- Studio y puente del backend compilados con TypeScript.

## Validación pendiente en entorno real

- Crear la app de Meta, configurar permisos aprobados y probar OAuth con cuenta profesional.
- Publicar una imagen de feed, una Story, un Reel y un carrusel con medios accesibles desde Meta; confirmar métricas y comentarios permitidos.
- Crear base/bucket dedicados y correr la migración; probar reinicio, recuperación y fecha programada con servicio persistente.
- Insertar el Studio en una plataforma host, conectar sesiones/roles/CSRF y sincronizar marca y productos reales; comprobar dos tiendas administradas por usuarios distintos.
- Monitorear fallos, respaldos, cuotas y costos antes de venderlo a múltiples tiendas.

El código se etiqueta `1.0.0-rc.1` hasta completar esa validación. No se ha conectado una cuenta ni realizado publicaciones reales en este entorno.
