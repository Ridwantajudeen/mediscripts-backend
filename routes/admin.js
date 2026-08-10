import { Router } from 'express'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import supabaseAdmin from '../server/lib/supabaseAdmin.js'
import { sendOrderConfirmationEmailIfNeeded } from '../server/lib/orderEmail.js'
import { listAdminActivityLogs, logAdminAction } from '../server/lib/adminAudit.js'
import { loadTransferPaymentSettings, upsertTransferPaymentSettings, createTransferReceiptSignedUrl } from '../server/lib/transferPayments.js'

const router = Router()
const orderStatusValues = [
  'Pending Payment',
  'Paid',
  'Awaiting Prescription',
  'Under Review',
  'Approved',
  'Rejected',
  'Processing',
  'Ready',
  'Out for Delivery',
  'Delivered',
  'Cancelled',
  'Refunded',
]
const prescriptionReviewValues = ['Pending', 'Under Review', 'Approved', 'Rejected']

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function parsePrice(value) {
  const price = Number(value)

  if (Number.isNaN(price) || price < 0) {
    throw new Error('Price must be a valid non-negative number.')
  }

  return price.toFixed(2)
}

function parseStockQuantity(value) {
  const stockQuantity = Number.parseInt(value, 10)

  if (Number.isNaN(stockQuantity) || stockQuantity < 0) {
    throw new Error('Stock quantity must be a valid non-negative whole number.')
  }

  return stockQuantity
}

function buildProductPayload(body) {
  const name = String(body.name || '').trim()
  const description = String(body.description || '').trim()

  if (!name) {
    throw new Error('Product name is required.')
  }

  if (!description) {
    throw new Error('Product description is required.')
  }

  const images = Array.isArray(body.images)
    ? body.images.filter((image) => typeof image === 'string' && image.trim())
    : []

  return {
    name,
    slug: String(body.slug || '').trim() || slugify(name),
    description,
    price: parsePrice(body.price ?? 0),
    category_id: body.categoryId || null,
    stock_quantity: parseStockQuantity(body.stockQuantity ?? 0),
    prescription_required: Boolean(body.prescriptionRequired),
    is_active: body.isActive === undefined ? true : Boolean(body.isActive),
    images,
  }
}

function buildCategoryPayload(body) {
  const name = String(body.name || '').trim()

  if (!name) {
    throw new Error('Category name is required.')
  }

  return {
    name,
    slug: String(body.slug || '').trim() || slugify(name),
    description: String(body.description || '').trim() || null,
    is_active: body.isActive === undefined ? true : Boolean(body.isActive),
  }
}

function normalizeOrderStatus(value) {
  const status = String(value || '').trim()

  if (!orderStatusValues.includes(status)) {
    throw new Error('Please choose a valid order status.')
  }

  return status
}

function normalizePrescriptionStatus(value) {
  const status = String(value || '').trim()

  if (!prescriptionReviewValues.includes(status)) {
    throw new Error('Please choose a valid prescription review status.')
  }

  return status
}

function normalizeText(value) {
  return String(value || '').trim()
}

async function loadLatestPaymentForOrder(orderId) {
  const { data, error } = await supabaseAdmin
    .from('payments')
    .select(
      'id, order_id, reference, provider, payment_method, status, amount, metadata, receipt_storage_path, receipt_note, receipt_status, receipt_submitted_at, receipt_reviewed_by, receipt_reviewed_at, created_at, updated_at',
    )
    .eq('order_id', orderId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw error
  }

  return data
}

router.get('/me', requireAuth, requireAdmin, (req, res) => {
  res.json({
    user: {
      id: req.auth.user.id,
      email: req.auth.user.email,
      fullName: req.auth.profile?.full_name || '',
      role: req.auth.profile?.role || 'customer',
    },
  })
})

router.get('/dashboard', requireAuth, requireAdmin, (_req, res) => {
  res.json({ message: 'Admin dashboard endpoint ready.' })
})

router.get('/summary', requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const [
      totalOrders,
      pendingOrders,
      pendingPrescriptionReviews,
      totalProducts,
      lowStockProducts,
      outOfStockProducts,
      revenueResult,
    ] = await Promise.all([
      supabaseAdmin.from('orders').select('id', { count: 'exact', head: true }),
      supabaseAdmin
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'Pending Payment'),
      supabaseAdmin
        .from('prescriptions')
        .select('id', { count: 'exact', head: true })
        .eq('review_status', 'Pending'),
      supabaseAdmin.from('products').select('id', { count: 'exact', head: true }),
      supabaseAdmin
        .from('products')
        .select('id', { count: 'exact', head: true })
        .gt('stock_quantity', 0)
        .lte('stock_quantity', 10),
      supabaseAdmin
        .from('products')
        .select('id', { count: 'exact', head: true })
        .eq('stock_quantity', 0),
      supabaseAdmin
        .from('payments')
        .select('amount')
        .eq('status', 'Verified'),
    ])

    if (
      totalOrders.error ||
      pendingOrders.error ||
      pendingPrescriptionReviews.error ||
      totalProducts.error ||
      lowStockProducts.error ||
      outOfStockProducts.error ||
      revenueResult.error
    ) {
      throw (
        totalOrders.error ||
        pendingOrders.error ||
        pendingPrescriptionReviews.error ||
        totalProducts.error ||
        lowStockProducts.error ||
        outOfStockProducts.error ||
        revenueResult.error
      )
    }

    const revenue = (revenueResult.data || []).reduce(
      (sum, payment) => sum + Number(payment.amount || 0),
      0,
    )

    res.json({
      metrics: {
        totalOrders: totalOrders.count || 0,
        pendingOrders: pendingOrders.count || 0,
        pendingPrescriptionReviews: pendingPrescriptionReviews.count || 0,
        totalProducts: totalProducts.count || 0,
        lowStockProducts: lowStockProducts.count || 0,
        outOfStockProducts: outOfStockProducts.count || 0,
        revenue,
      },
    })
  } catch (error) {
    next(error)
  }
})

router.get('/payment-settings', requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const settings = await loadTransferPaymentSettings(supabaseAdmin)
    res.json({ settings })
  } catch (error) {
    next(error)
  }
})

router.patch('/payment-settings', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const beforeSettings = await loadTransferPaymentSettings(supabaseAdmin)
    const updatedSettings = await upsertTransferPaymentSettings(
      supabaseAdmin,
      req.body || {},
      req.auth.user.id,
    )

    await logAdminAction({
      supabaseAdmin,
      actorId: req.auth.user.id,
      action: 'update',
      entityType: 'payment_settings',
      entityId: '1',
      summary: 'Updated transfer payment details.',
      beforeData: beforeSettings,
      afterData: updatedSettings,
    })

    res.json({ settings: updatedSettings })
  } catch (error) {
    next(error)
  }
})

router.get('/activity-logs', requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const logs = await listAdminActivityLogs(supabaseAdmin, 100)
    res.json({ logs })
  } catch (error) {
    next(error)
  }
})

router.get('/payments', requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const { data: payments, error: paymentsError } = await supabaseAdmin
      .from('payments')
      .select(
        'id, order_id, reference, provider, payment_method, status, amount, metadata, receipt_storage_path, receipt_note, receipt_status, receipt_submitted_at, receipt_reviewed_by, receipt_reviewed_at, created_at, updated_at',
      )
      .order('created_at', { ascending: false })
      .limit(50)

    if (paymentsError) {
      throw paymentsError
    }

    const orderIds = [...new Set((payments || []).map((payment) => payment.order_id).filter(Boolean))]

    const { data: orders, error: ordersError } = orderIds.length
      ? await supabaseAdmin
          .from('orders')
          .select('id, order_number, customer_name, customer_email, status, payment_status, total_amount')
          .in('id', orderIds)
      : { data: [], error: null }

    if (ordersError) {
      throw ordersError
    }

    const orderMap = new Map((orders || []).map((order) => [order.id, order]))
    const paymentsWithReceipts = await Promise.all(
      (payments || []).map(async (payment) => ({
        ...payment,
        receipt_url:
          payment.receipt_storage_path && payment.receipt_status !== 'Not Submitted'
            ? await createTransferReceiptSignedUrl(supabaseAdmin, payment.receipt_storage_path)
            : null,
        order: orderMap.get(payment.order_id) || null,
      })),
    )

    res.json({
      payments: paymentsWithReceipts,
    })
  } catch (error) {
    next(error)
  }
})

router.get('/orders', requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const { data: orders, error } = await supabaseAdmin
      .from('orders')
      .select(
        'id, order_number, customer_name, customer_email, customer_phone, status, payment_status, payment_method, total_amount, requires_prescription, prescription_status, created_at, updated_at',
      )
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) {
      throw error
    }

    res.json({ orders: orders || [] })
  } catch (error) {
    next(error)
  }
})

router.get('/orders/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { data: order, error: orderError } = await supabaseAdmin
      .from('orders')
      .select(
        'id, order_number, customer_name, customer_email, customer_phone, delivery_address, status, payment_status, payment_method, requires_prescription, prescription_status, prescription_document_url, rejection_reason, total_amount, payment_reference, created_at, updated_at',
      )
      .eq('id', req.params.id)
      .maybeSingle()

    if (orderError) {
      throw orderError
    }

    if (!order) {
      return res.status(404).json({ message: 'Order not found.' })
    }

    const [{ data: orderItems, error: orderItemsError }, { data: payment, error: paymentError }] =
      await Promise.all([
        supabaseAdmin
          .from('order_items')
          .select('id, quantity, unit_price, product_id, products(id, name, slug, images, prescription_required)')
          .eq('order_id', order.id)
          .order('created_at', { ascending: true }),
        supabaseAdmin
          .from('payments')
          .select(
            'id, order_id, reference, provider, payment_method, status, amount, metadata, receipt_storage_path, receipt_note, receipt_status, receipt_submitted_at, receipt_reviewed_by, receipt_reviewed_at, created_at, updated_at',
          )
          .eq('order_id', order.id)
          .maybeSingle(),
      ])

    if (orderItemsError) {
      throw orderItemsError
    }

    if (paymentError) {
      throw paymentError
    }

    const receiptUrl =
      payment?.receipt_storage_path && payment.receipt_status !== 'Not Submitted'
        ? await createTransferReceiptSignedUrl(supabaseAdmin, payment.receipt_storage_path)
        : null

    const { data: prescriptions, error: prescriptionsError } = await supabaseAdmin
      .from('prescriptions')
      .select('id, file_url, review_status, review_note, reviewed_at, reviewed_by')
      .eq('order_id', order.id)
      .order('created_at', { ascending: true })

    if (prescriptionsError) {
      throw prescriptionsError
    }

    const { data: history, error: historyError } = await supabaseAdmin
      .from('order_status_history')
      .select('id, previous_status, new_status, note, created_at, changed_by')
      .eq('order_id', order.id)
      .order('created_at', { ascending: false })

    if (historyError) {
      throw historyError
    }

    const changedByIds = [...new Set((history || []).map((entry) => entry.changed_by).filter(Boolean))]
    const { data: changedByProfiles, error: changedByProfilesError } = changedByIds.length
      ? await supabaseAdmin.from('profiles').select('id, full_name').in('id', changedByIds)
      : { data: [], error: null }

    if (changedByProfilesError) {
      throw changedByProfilesError
    }

    const profileMap = new Map((changedByProfiles || []).map((profile) => [profile.id, profile.full_name]))

    res.json({
      order,
      items: orderItems || [],
      payment: payment ? { ...payment, receipt_url: receiptUrl } : null,
      prescriptions: prescriptions || [],
      history: (history || []).map((entry) => ({
        ...entry,
        changed_by_name: profileMap.get(entry.changed_by) || 'Admin',
      })),
    })
  } catch (error) {
    next(error)
  }
})

router.patch('/orders/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { data: existingOrder, error: existingOrderError } = await supabaseAdmin
      .from('orders')
      .select(
        'id, status, prescription_status, confirmation_email_sent_at, customer_email, customer_name, order_number, payment_status, payment_method, total_amount, delivery_address, customer_phone, created_at, updated_at, payment_reference, requires_prescription, prescription_document_url, rejection_reason',
      )
      .eq('id', req.params.id)
      .maybeSingle()

    if (existingOrderError) {
      throw existingOrderError
    }

    if (!existingOrder) {
      return res.status(404).json({ message: 'Order not found.' })
    }

    const updates = {}
    const statusHistoryNote = normalizeText(req.body.statusNote || req.body.note || '')

    if (req.body.paymentStatus !== undefined) {
      const paymentStatus = String(req.body.paymentStatus || '').trim()
      if (!['Unpaid', 'Pending Verification', 'Paid', 'Failed', 'Refunded'].includes(paymentStatus)) {
        throw new Error('Please choose a valid payment status.')
      }
      updates.payment_status = paymentStatus

      if (paymentStatus === 'Paid' && req.body.status === undefined) {
        updates.status = 'Paid'
      }
    }

    if (req.body.rejectionReason !== undefined) {
      updates.rejection_reason = normalizeText(req.body.rejectionReason) || null
    }

    if (req.body.prescriptionStatus !== undefined || req.body.prescriptionNote !== undefined) {
      const prescriptionStatus =
        req.body.prescriptionStatus !== undefined
          ? normalizePrescriptionStatus(req.body.prescriptionStatus)
          : null
      const prescriptionNote = normalizeText(req.body.prescriptionNote)

      const { data: latestPrescription, error: latestPrescriptionError } = await supabaseAdmin
        .from('prescriptions')
        .select('id')
        .eq('order_id', req.params.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (latestPrescriptionError) {
        throw latestPrescriptionError
      }

      if (!latestPrescription) {
        throw new Error('Add a prescription before reviewing it.')
      }

      if (prescriptionStatus === 'Rejected' && !prescriptionNote) {
        throw new Error('Add a rejection note before rejecting the prescription.')
      }

      const prescriptionUpdates = {}

      if (req.body.prescriptionStatus !== undefined) {
        prescriptionUpdates.review_status = prescriptionStatus
      }

      if (req.body.prescriptionNote !== undefined) {
        prescriptionUpdates.review_note = prescriptionNote || null
      }

      if (req.body.prescriptionStatus !== undefined && prescriptionStatus !== 'Pending') {
        prescriptionUpdates.reviewed_by = req.auth.user.id
        prescriptionUpdates.reviewed_at = new Date().toISOString()
      }

      const { error: prescriptionUpdateError } = await supabaseAdmin
        .from('prescriptions')
        .update(prescriptionUpdates)
        .eq('id', latestPrescription.id)

      if (prescriptionUpdateError) {
        throw prescriptionUpdateError
      }

      if (req.body.prescriptionStatus !== undefined) {
        updates.prescription_status = prescriptionStatus

        if (req.body.status === undefined) {
          if (prescriptionStatus === 'Approved') {
            updates.status = 'Approved'
          }

          if (prescriptionStatus === 'Rejected') {
            updates.status = 'Rejected'
            updates.rejection_reason = prescriptionNote
          }

          if (prescriptionStatus === 'Under Review') {
            updates.status = 'Under Review'
          }
        }
      }
    }

    if (req.body.status !== undefined) {
      updates.status = normalizeOrderStatus(req.body.status)
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No changes were provided.' })
    }

    const previousStatus = existingOrder.status
    const nextStatus = updates.status ?? existingOrder.status

    const { data, error } = await supabaseAdmin
      .from('orders')
      .update(updates)
      .eq('id', req.params.id)
      .select(
        'id, order_number, customer_name, customer_email, customer_phone, delivery_address, status, payment_status, requires_prescription, prescription_status, prescription_document_url, rejection_reason, total_amount, payment_reference, created_at, updated_at, confirmation_email_sent_at',
      )
      .single()

    if (error) {
      throw error
    }

    let updatedPayment = null

    if (updates.payment_status === 'Paid') {
      const latestPayment = await loadLatestPaymentForOrder(data.id)

      if (latestPayment) {
        const paymentUpdate = {
          status: 'Verified',
          receipt_status: 'Verified',
          receipt_reviewed_by: req.auth.user.id,
          receipt_reviewed_at: new Date().toISOString(),
          metadata: {
            ...(latestPayment.metadata || {}),
            verifiedBy: req.auth.user.id,
            verifiedAt: new Date().toISOString(),
          },
        }

        const { error: paymentUpdateError } = await supabaseAdmin
          .from('payments')
          .update(paymentUpdate)
          .eq('id', latestPayment.id)

        if (paymentUpdateError) {
          throw paymentUpdateError
        }

        updatedPayment = {
          ...latestPayment,
          ...paymentUpdate,
        }
      }
    }

    if (nextStatus !== previousStatus) {
      const { error: historyError } = await supabaseAdmin.from('order_status_history').insert({
        order_id: data.id,
        previous_status: previousStatus,
        new_status: nextStatus,
        changed_by: req.auth.user.id,
        note: statusHistoryNote || null,
      })

      if (historyError) {
        throw historyError
      }
    }

    try {
      await sendOrderConfirmationEmailIfNeeded({ supabaseAdmin, order: data })
    } catch {
    }

    try {
      await logAdminAction({
        supabaseAdmin,
        actorId: req.auth.user.id,
        action: 'update',
        entityType: 'order',
        entityId: data.id,
        summary: `Updated order ${data.order_number}.`,
        beforeData: existingOrder,
        afterData: data,
      })
    } catch {
    }

    res.json({ order: data, payment: updatedPayment })
  } catch (error) {
    next(error)
  }
})

router.get('/products', requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select(
        'id, name, slug, description, price, stock_quantity, prescription_required, is_active, images, category_id, categories(name, slug)',
      )
      .order('created_at', { ascending: false })

    if (error) {
      throw error
    }

    res.json({ products: data || [] })
  } catch (error) {
    next(error)
  }
})

router.get('/products/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select(
        'id, name, slug, description, price, stock_quantity, prescription_required, is_active, images, category_id, categories(name, slug)',
      )
      .eq('id', req.params.id)
      .maybeSingle()

    if (error) {
      throw error
    }

    if (!data) {
      return res.status(404).json({ message: 'Product not found.' })
    }

    res.json({ product: data })
  } catch (error) {
    next(error)
  }
})

router.post('/products', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const payload = buildProductPayload(req.body)

    const { data, error } = await supabaseAdmin
      .from('products')
      .insert(payload)
      .select(
        'id, name, slug, description, price, stock_quantity, prescription_required, is_active, images, category_id, categories(name, slug)',
      )
      .single()

    if (error) {
      throw error
    }

    try {
      await logAdminAction({
        supabaseAdmin,
        actorId: req.auth.user.id,
        action: 'create',
        entityType: 'product',
        entityId: data.id,
        summary: `Created product ${data.name}.`,
        afterData: data,
      })
    } catch {
    }

    res.status(201).json({ product: data })
  } catch (error) {
    next(error)
  }
})

router.patch('/products/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const updates = {}

    if (req.body.name !== undefined) updates.name = String(req.body.name || '').trim()
    if (req.body.description !== undefined) updates.description = String(req.body.description || '').trim()
    if (req.body.slug !== undefined) updates.slug = String(req.body.slug || '').trim()
    if (req.body.price !== undefined) updates.price = parsePrice(req.body.price)
    if (req.body.categoryId !== undefined) updates.category_id = req.body.categoryId || null
    if (req.body.stockQuantity !== undefined) updates.stock_quantity = parseStockQuantity(req.body.stockQuantity)
    if (req.body.prescriptionRequired !== undefined) updates.prescription_required = Boolean(req.body.prescriptionRequired)
    if (req.body.isActive !== undefined) updates.is_active = Boolean(req.body.isActive)
    if (req.body.images !== undefined) {
      updates.images = Array.isArray(req.body.images)
        ? req.body.images.filter((image) => typeof image === 'string' && image.trim())
        : []
    }

    if (updates.name && !updates.slug) {
      updates.slug = slugify(updates.name)
    }

    if (updates.name === '') {
      throw new Error('Product name cannot be empty.')
    }

    if (updates.description === '') {
      throw new Error('Product description cannot be empty.')
    }

    const { data, error } = await supabaseAdmin
      .from('products')
      .update(updates)
      .eq('id', req.params.id)
      .select(
        'id, name, slug, description, price, stock_quantity, prescription_required, is_active, images, category_id, categories(name, slug)',
      )
      .single()

    if (error) {
      throw error
    }

    try {
      await logAdminAction({
        supabaseAdmin,
        actorId: req.auth.user.id,
        action: 'update',
        entityType: 'product',
        entityId: data.id,
        summary: `Updated product ${data.name}.`,
        afterData: data,
      })
    } catch {
    }

    res.json({ product: data })
  } catch (error) {
    next(error)
  }
})

router.delete('/products/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin
      .from('products')
      .update({ is_active: false })
      .eq('id', req.params.id)

    if (error) {
      throw error
    }

    try {
      await logAdminAction({
        supabaseAdmin,
        actorId: req.auth.user.id,
        action: 'archive',
        entityType: 'product',
        entityId: req.params.id,
        summary: 'Archived a product.',
      })
    } catch {
    }

    res.json({ message: 'Product archived.' })
  } catch (error) {
    next(error)
  }
})

router.get('/categories', requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('categories')
      .select('id, name, slug, description, is_active, created_at, updated_at')
      .order('name', { ascending: true })

    if (error) {
      throw error
    }

    res.json({ categories: data || [] })
  } catch (error) {
    next(error)
  }
})

router.post('/categories', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const payload = buildCategoryPayload(req.body)

    const { data, error } = await supabaseAdmin
      .from('categories')
      .insert(payload)
      .select('id, name, slug, description, is_active, created_at, updated_at')
      .single()

    if (error) {
      throw error
    }

    try {
      await logAdminAction({
        supabaseAdmin,
        actorId: req.auth.user.id,
        action: 'create',
        entityType: 'category',
        entityId: data.id,
        summary: `Created category ${data.name}.`,
        afterData: data,
      })
    } catch {
    }

    res.status(201).json({ category: data })
  } catch (error) {
    next(error)
  }
})

router.patch('/categories/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const updates = {}

    if (req.body.name !== undefined) {
      const name = String(req.body.name || '').trim()
      if (!name) {
        throw new Error('Category name cannot be empty.')
      }
      updates.name = name
      if (req.body.slug === undefined) {
        updates.slug = slugify(name)
      }
    }

    if (req.body.slug !== undefined) updates.slug = String(req.body.slug || '').trim()
    if (req.body.description !== undefined) updates.description = String(req.body.description || '').trim() || null
    if (req.body.isActive !== undefined) updates.is_active = Boolean(req.body.isActive)

    const { data, error } = await supabaseAdmin
      .from('categories')
      .update(updates)
      .eq('id', req.params.id)
      .select('id, name, slug, description, is_active, created_at, updated_at')
      .single()

    if (error) {
      throw error
    }

    try {
      await logAdminAction({
        supabaseAdmin,
        actorId: req.auth.user.id,
        action: 'update',
        entityType: 'category',
        entityId: data.id,
        summary: `Updated category ${data.name}.`,
        afterData: data,
      })
    } catch {
    }

    res.json({ category: data })
  } catch (error) {
    next(error)
  }
})

router.delete('/categories/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin
      .from('categories')
      .update({ is_active: false })
      .eq('id', req.params.id)

    if (error) {
      throw error
    }

    try {
      await logAdminAction({
        supabaseAdmin,
        actorId: req.auth.user.id,
        action: 'archive',
        entityType: 'category',
        entityId: req.params.id,
        summary: 'Archived a category.',
      })
    } catch {
    }

    res.json({ message: 'Category archived.' })
  } catch (error) {
    next(error)
  }
})

export default router
