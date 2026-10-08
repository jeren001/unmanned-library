import type { LibraryRepository } from "../persistence/repositories.js";

export class AuditService {
  constructor(private readonly repo: LibraryRepository) {}

  log(actorId: string | null, action: string, entity: string, entityId: string, detail: unknown, ip?: string) {
    return this.repo.recordAudit({
      actor_id: actorId,
      action,
      entity,
      entity_id: entityId,
      detail_json: JSON.stringify(detail ?? {}),
      ip,
      ts: new Date().toISOString()
    });
  }
}
