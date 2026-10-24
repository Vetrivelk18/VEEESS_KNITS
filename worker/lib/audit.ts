export async function audit(
  db: D1Database,
  adminEmail: string,
  action: string,
  entity: string,
  entityId: string | number,
  details: Record<string, unknown> = {},
  ip?: string,
): Promise<void> {
  await db
    .prepare('INSERT INTO audit_log (admin_email, action, entity, entity_id, details, ip) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(adminEmail, action, entity, String(entityId), JSON.stringify(details).slice(0, 4000), ip ?? null)
    .run();
}

export function auditStmt(
  db: D1Database,
  adminEmail: string,
  action: string,
  entity: string,
  entityId: string | number,
  details: Record<string, unknown> = {},
  ip?: string,
): D1PreparedStatement {
  return db
    .prepare('INSERT INTO audit_log (admin_email, action, entity, entity_id, details, ip) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(adminEmail, action, entity, String(entityId), JSON.stringify(details).slice(0, 4000), ip ?? null);
}
