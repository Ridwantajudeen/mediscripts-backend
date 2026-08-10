export async function logAdminAction({
  supabaseAdmin,
  actorId,
  action,
  entityType,
  entityId = null,
  summary,
  beforeData = null,
  afterData = null,
}) {
  if (!actorId || !action || !entityType || !summary) {
    return
  }

  const { error } = await supabaseAdmin.from('admin_activity_logs').insert({
    actor_id: actorId,
    action,
    entity_type: entityType,
    entity_id: entityId ? String(entityId) : null,
    summary,
    before_data: beforeData,
    after_data: afterData,
  })

  if (error) {
    throw error
  }
}

export async function listAdminActivityLogs(supabaseAdmin, limit = 100) {
  const { data, error } = await supabaseAdmin
    .from('admin_activity_logs')
    .select('id, actor_id, action, entity_type, entity_id, summary, before_data, after_data, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    throw error
  }

  const actorIds = [...new Set((data || []).map((entry) => entry.actor_id).filter(Boolean))]
  const { data: profiles, error: profileError } = actorIds.length
    ? await supabaseAdmin.from('profiles').select('id, full_name, role').in('id', actorIds)
    : { data: [], error: null }

  if (profileError) {
    throw profileError
  }

  const profileMap = new Map((profiles || []).map((profile) => [profile.id, profile]))

  return (data || []).map((entry) => ({
    ...entry,
    actor: profileMap.get(entry.actor_id) || null,
  }))
}
