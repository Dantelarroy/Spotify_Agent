# Spotify Automation V2 — Backlog Ejecutivo

## P0 (bloqueantes)
- [ ] Mover cobro de cuota después de validar sesión Spotify en `app/api/chat/route.ts`.
- [ ] Hacer `checkActionLimit` transaccional en `lib/memory.ts`.
- [ ] Restringir `api/admin/reset-credits` a admin key en producción.
- [ ] Extraer scripts Playwright a `scripts/pw/*.cjs` (eliminar string embebido crítico).

## P1 (estabilidad E2E)
- [ ] Crear `AutomationJob` + `AutomationJobEvent` en Prisma.
- [ ] Endpoints:
  - [ ] `POST /api/automation/jobs`
  - [ ] `GET /api/automation/jobs/:id`
- [ ] Implementar `lib/automation/job-runner.ts` con state machine playlist.
- [ ] Implementar `lib/automation/session-manager.ts` con TTL.
- [ ] Integrar `create_playlist` tool con runner async.

## P2 (calidad y observabilidad)
- [ ] Clasificación unificada de errores (`AUTH_REQUIRED`, `UI_CHANGED`, etc.).
- [ ] Incluir artifacts en eventos de error (screenshot/html).
- [ ] Exponer progreso de job en frontend.
- [ ] Canary suite para playlist/play_track.

## P3 (optimización)
- [ ] Cache de context por usuario para secuencias de acciones cortas.
- [ ] Ajuste de retries por fase con telemetría real.
- [ ] Métricas de p95 y éxito por versión de deploy.

