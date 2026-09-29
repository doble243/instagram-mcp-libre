# Roadmap desde la candidata 1.0

La implementación actual se etiqueta `1.0.0-rc.1`. PostgreSQL, Storage privado, OAuth persistente, permisos, SDK, Studio y pruebas automatizadas están implementados. La validación real se sigue en [v1-release.md](v1-release.md).

| Prioridad | Trabajo | Motivo |
| --- | --- | --- |
| P0 | Probar OAuth y los cuatro formatos con Meta | La API simulada no valida permisos, revisión de app ni descargas reales de Meta. |
| P0 | Integrar dos tiendas reales y sus roles | Confirmar sincronización, aislamiento y experiencia editorial en Conecta o plataformas existentes. |
| P0 | Supervisar proceso persistente, backup y alertas | La programación depende de un servicio activo; un error incierto requiere revisión humana. |
| P1 | Vista previa visual final y editor de borradores en Studio | Hoy el panel muestra medios, texto y estado, pero no compone una plantilla final. |
| P1 | Auditoría de todas las llamadas MCP/A2A y revocación inmediata por actor | La auditoría HTTP y tokens temporales no cubren cada operación de agentes ni revocación antes de caducar. |
| P1 | Configurar rotación de secretos, políticas de retención y borrado | Completar operación para venta a escala. |
| P2 | Tareas A2A persistentes, streaming y webhooks | Extender agentes y eventos cuando el piloto lo requiera. |
