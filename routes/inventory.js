import { Router } from 'express'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import supabaseAdmin from '../server/lib/supabaseAdmin.js'
import { logAdminAction } from '../server/lib/adminAudit.js'

const router = Router()

router.get('/movements', requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('inventory_movements')
      .select('id, product_id, delta, reason, reference_type, reference_id, created_at')
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) {
      throw error
    }

    res.json({ movements: data || [] })
  } catch (error) {
    next(error)
  }
})

router.post('/adjustments', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const productId = String(req.body.productId || '').trim()
    const delta = Number.parseInt(req.body.delta, 10)
    const reason = String(req.body.reason || '').trim()

    if (!productId) {
      return res.status(400).json({ message: 'Product is required.' })
    }

    if (Number.isNaN(delta) || delta === 0) {
      return res.status(400).json({ message: 'Delta must be a non-zero whole number.' })
    }

    if (!reason) {
      return res.status(400).json({ message: 'Reason is required.' })
    }

    const { data, error } = await supabaseAdmin.rpc('adjust_inventory', {
      p_product_id: productId,
      p_delta: delta,
      p_reason: reason,
      p_reference_type: req.body.referenceType || null,
      p_reference_id: req.body.referenceId || null,
      p_created_by: req.auth.user.id,
    })

    if (error) {
      throw error
    }

    try {
      await logAdminAction({
        supabaseAdmin,
        actorId: req.auth.user.id,
        action: 'adjust',
        entityType: 'inventory',
        entityId: productId,
        summary: `Adjusted stock by ${delta}.`,
        beforeData: null,
        afterData: data?.[0] || null,
      })
    } catch {
    }

    res.status(201).json({
      adjustment: data?.[0] || null,
      message: 'Inventory updated successfully.',
    })
  } catch (error) {
    next(error)
  }
})

export default router
