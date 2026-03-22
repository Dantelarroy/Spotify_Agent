# Spotify Automation V2 — Spec Plan

## 1) Objetivo
Convertir la automatización de Spotify en un sistema **stateful, asíncrono y determinístico**, similar al comportamiento de un agente interactivo con Playwright:
- No depender de un único request síncrono de `/api/chat`.
- Reintentar por fase hasta terminar o fallar con código explícito.
- Verificar resultado real en UI antes de declarar éxito.

## 2) Problemas actuales (diagnóstico)
1. Ejecución síncrona en `/api/chat` con `maxDuration` alto pero finito.
2. Scripts largos embebidos como string en `lib/spotify-agent.ts` (frágiles a escaping/regresiones).
3. Recuperación limitada ante cambios de UI (heurísticas lineales).
4. Lógica de límites/cobro mezclada con flujo de automatización.
5. Mensajes de error no siempre accionables para frontend.

## 3) Arquitectura objetivo
### 3.1 Job Orchestrator (asíncrono)
- `POST /api/automation/jobs` crea un job y responde `jobId`.
- `GET /api/automation/jobs/:id` devuelve estado/progreso/resultados.
- Worker interno ejecuta fases y persiste eventos.

### 3.2 Session Manager (stateful)
- Reutiliza sandbox/browser por `jobId` (TTL 10-20 min).
- Mantiene `context/page` durante todo el job (evita reinicios por paso).
- Cierra recursos al terminar o timeout.

### 3.3 State Machine por tipo de job
- Playlist:
  - `INIT -> OPEN_SPOTIFY -> ENSURE_LIBRARY -> CREATE_PLAYLIST -> ADD_TRACKS -> VERIFY_PLAYLIST -> DONE|FAILED`
- Player:
  - `INIT -> OPEN_SPOTIFY -> SEARCH_TRACK -> PLAY_ACTION -> VERIFY_PLAYBACK -> DONE|FAILED`

### 3.4 Error Taxonomy
- `AUTH_REQUIRED`
- `LIMIT_REACHED`
- `UI_CHANGED`
- `NO_RESULTS`
- `ACTION_NOT_CONFIRMED`
- `INFRA_SANDBOX`
- `UNKNOWN`

## 4) Modelo de datos (Prisma)
Agregar:

```prisma
model AutomationJob {
  id            String   @id @default(cuid())
  userId        String
  type          String   // CREATE_PLAYLIST | PLAY_TRACK | ...
  status        String   // PENDING | RUNNING | DONE | FAILED | CANCELED
  phase         String?
  attempt       Int      @default(0)
  payload       String   // JSON serializado
  result        String?  // JSON serializado
  errorCode     String?
  errorMessage  String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  startedAt     DateTime?
  finishedAt    DateTime?

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, createdAt])
  @@index([status, createdAt])
}

model AutomationJobEvent {
  id         String   @id @default(cuid())
  jobId      String
  phase      String
  level      String   // INFO | WARN | ERROR
  message    String
  data       String?  // JSON serializado
  createdAt  DateTime @default(now())

  job AutomationJob @relation(fields: [jobId], references: [id], onDelete: Cascade)

  @@index([jobId, createdAt])
}
```

## 5) API contracts
### 5.1 Create Job
`POST /api/automation/jobs`

Request:
```json
{
  "type": "CREATE_PLAYLIST",
  "payload": {
    "name": "Focus",
    "description": "Focus tracks",
    "trackQueries": ["Numb Linkin Park", "..."]
  }
}
```

Response:
```json
{
  "jobId": "cj...",
  "status": "PENDING"
}
```

### 5.2 Get Job
`GET /api/automation/jobs/:id`

Response:
```json
{
  "id": "cj...",
  "status": "RUNNING",
  "phase": "ADD_TRACKS",
  "attempt": 2,
  "progress": {
    "total": 20,
    "done": 7
  },
  "errorCode": null,
  "errorMessage": null,
  "result": null
}
```

## 6) Deterministic success criteria
### 6.1 CREATE_PLAYLIST
Éxito solo si:
1. Se resolvió URL playlist válida.
2. `tracksAdded > 0` cuando `trackQueries.length > 0`.
3. Verificación final de links `/track/` en playlist > 0.

### 6.2 PLAY_TRACK
Éxito solo si:
1. Se ejecutó acción de play.
2. Verificación posterior confirma estado reproducible (play/pause control o now-playing con track).

## 7) Retry policy
- Máximo 3 intentos por fase (excepto `AUTH_REQUIRED`).
- Backoff: 300ms, 900ms, 2000ms.
- Reintentos solo para errores `UI_CHANGED`, `INFRA_SANDBOX`, `ACTION_NOT_CONFIRMED`.
- `AUTH_REQUIRED` y `LIMIT_REACHED` fallan directo.

## 8) Cambios de código (plan por archivos)
### Fase A — Infra mínima (2-3 días)
1. `prisma/schema.prisma`
   - agregar `AutomationJob`, `AutomationJobEvent`.
2. `app/api/automation/jobs/route.ts`
   - crear job.
3. `app/api/automation/jobs/[id]/route.ts`
   - consultar status/resultado.
4. `lib/automation/job-runner.ts`
   - motor de estado + persistencia de eventos.
5. `lib/automation/session-manager.ts`
   - sandbox/page lifecycle por job.

### Fase B — Migración de flujo playlist (2-4 días)
1. `scripts/pw/create-playlist.cjs`
   - mover script actual desde string embebido.
2. `lib/spotify-agent.ts`
   - reemplazar string-based execution por file-based execution.
3. `lib/tools.ts`
   - `create_playlist` crea job y espera/polleea hasta DONE/FAILED (o devuelve jobId para UX async).

### Fase C — Migración de player/search (1-2 días)
1. `scripts/pw/player-control.cjs`
2. `lib/spotify-agent.ts`
   - unificar con flujo de jobs/state machine.

### Fase D — Límites y cobro correcto (1 día)
1. `app/api/chat/route.ts`
   - validar sesión Spotify antes de consumir cuota.
2. `lib/memory.ts`
   - transacción atómica para límites.
3. Mensajes de límite consistentes con valores reales.

## 9) Observabilidad obligatoria
Cada transición de fase debe registrar evento con:
- `jobId`, `phase`, `attempt`, `url`, `selector` (si aplica), `durationMs`, `errorCode`.

Artifacts de error:
- screenshot path
- html path
- last action

## 10) Seguridad y operaciones
1. Endpoint `admin/reset-credits`:
   - solo con `ADMIN_API_KEY` en producción.
2. Feature flag:
   - `AUTOMATION_V2_ENABLED=true` para rollout gradual.
3. Rollback:
   - desactivar flag y volver a path actual.

## 11) Test plan
### Unit
- transitions de state machine
- clasificación de errores
- retry policy

### Integration
- crear job -> progreso -> done
- crear playlist con 5 tracks en entorno sandbox
- play track y verificación de reproducción

### Canary
- 50 ejecuciones CREATE_PLAYLIST
- 50 ejecuciones PLAY_TRACK
- métricas objetivo:
  - success rate >= 95%
  - `p95` completion <= 180s

## 12) Definition of Done
1. Jobs asíncronos en producción.
2. Scripts Playwright externos (no string gigante embebido).
3. Errores clasificados y visibles en frontend.
4. Límites/cobro consistentes y atómicos.
5. Dashboard/logs suficientes para diagnóstico sin reproducir manualmente.

