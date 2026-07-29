import { Router } from 'express'
import supabaseAdmin from '../server/lib/supabaseAdmin.js'
import { sendResendEmail } from '../server/lib/resend.js'
import {
  decryptTrackingOtp,
  encryptTrackingOtp,
  formatTrackingDate,
  generateTrackingOtp,
  normalizeTrackingEmail,
  normalizeTrackingOrderNumber,
  trackingOtpSendLimit,
  trackingOtpValidityMinutes,
  trackingOtpWindowMinutes,
} from '../server/lib/trackingOtp.js'

const router = Router()

function formatCurrency(value) {
  return `NGN ${Number(value || 0).toLocaleString()}`
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000)
}

function now() {
  return new Date()
}

function getTrackingWindowState(record, currentTime) {
  const windowStart = record?.send_window_started_at
    ? new Date(record.send_window_started_at)
    : currentTime
  const windowEnd = addMinutes(windowStart, trackingOtpWindowMinutes)
  const windowExpired = currentTime >= windowEnd
  const sendCount = windowExpired ? 0 : Number(record?.send_count || 0)
  const remainingSends = Math.max(0, trackingOtpSendLimit - sendCount)

  return {
    windowStart,
    windowEnd,
    windowExpired,
    sendCount,
    remainingSends,
  }
}

function getCodeExpiry(record) {
  if (!record?.expires_at) {
    return null
  }

  return new Date(record.expires_at)
}

function hasActiveCode(record, currentTime) {
  const expiresAt = getCodeExpiry(record)
  return Boolean(expiresAt && currentTime < expiresAt)
}

function buildTrackingEmail({ orderNumber, customerName, otp, expiresAt }) {
  const formattedExpiry = formatTrackingDate(expiresAt)

  return {
    subject: `Your Mediscripts tracking code for ${orderNumber}`,
    text: [
      `Hello ${customerName},`,
      '',
      `Your tracking code for order ${orderNumber} is ${otp}.`,
      `It expires at ${formattedExpiry}.`,
      '',
      `The code is valid for 10 minutes.`,
      `You can request up to 5 tracking codes every 30 minutes.`,
      `If you request another code before this one expires, we will send the same code again.`,
      '',
      `If you did not request this code, you can ignore this email.`,
    ].join('\n'),
    html: `
      <div style="font-family: Arial, sans-serif; color: #0f172a; line-height: 1.6;">
        <p>Hello ${customerName},</p>
        <p>Your tracking code for order <strong>${orderNumber}</strong> is:</p>
        <p style="font-size: 28px; font-weight: 800; letter-spacing: 0.14em;">${otp}</p>
        <p>This code expires at <strong>${formattedExpiry}</strong>.</p>
        <ul>
          <li>The code is valid for 10 minutes.</li>
          <li>You can request up to 5 tracking codes every 30 minutes.</li>
          <li>If you request another code before this one expires, we will send the same code again.</li>
        </ul>
        <p>If you did not request this code, you can ignore this email.</p>
      </div>
    `,
  }
}

async function loadTrackingOrder(orderNumber, email) {
  const normalizedOrderNumber = normalizeTrackingOrderNumber(orderNumber)
  const normalizedEmail = normalizeTrackingEmail(email)

  if (!normalizedOrderNumber) {
    return { order: null }
  }

  const { data: order, error } = await supabaseAdmin
    .from('orders')
    .select(
      'id, order_number, customer_name, customer_email, status, payment_status, total_amount, created_at, updated_at',
    )
    .eq('order_number', normalizedOrderNumber)
    .maybeSingle()

  if (error) {
    throw error
  }

  if (!order || normalizeTrackingEmail(order.customer_email) !== normalizedEmail) {
    return { order: null }
  }

  return { order }
}

async function loadTrackingRecord(orderId) {
  const { data: record, error } = await supabaseAdmin
    .from('order_tracking_verifications')
    .select(
      'id, order_id, customer_email, otp_ciphertext, otp_iv, otp_auth_tag, send_count, send_window_started_at, last_sent_at, expires_at, verified_at, created_at, updated_at',
    )
    .eq('order_id', orderId)
    .maybeSingle()

  if (error) {
    throw error
  }

  return record
}

function buildSessionResponse({ order, record, currentTime }) {
  const windowState = getTrackingWindowState(record, currentTime)
  const codeActive = hasActiveCode(record, currentTime)
  const response = {
    status: 'ready_to_send',
    hasActiveCode: false,
    canSendCode: windowState.remainingSends > 0,
    remainingSends: windowState.remainingSends,
    sendLimit: trackingOtpSendLimit,
    windowResetsAt: windowState.windowEnd.toISOString(),
    codeExpiresAt: null,
    message: 'We can send a tracking code to this email address.',
    orderNumber: order.order_number,
  }

  if (codeActive) {
    response.status = 'code_active'
    response.hasActiveCode = true
    response.codeExpiresAt = getCodeExpiry(record).toISOString()
    response.message = 'A tracking code is already active. Enter the latest code from your email.'
  }

  if (!codeActive && windowState.remainingSends <= 0) {
    response.status = 'rate_limited'
    response.canSendCode = false
    response.message =
      'You have reached the tracking code limit for this order. Please try again later.'
  }

  return response
}

async function persistTrackingRecord({ order, email, otp, record, currentTime, expiresAt }) {
  const encryptedOtp = encryptTrackingOtp(otp)
  const windowState = getTrackingWindowState(record, currentTime)
  const shouldResetWindow = !record || windowState.windowExpired
  const nextSendCount = shouldResetWindow ? 1 : windowState.sendCount + 1
  const payload = {
    order_id: order.id,
    customer_email: email,
    otp_ciphertext: encryptedOtp.otp_ciphertext,
    otp_iv: encryptedOtp.otp_iv,
    otp_auth_tag: encryptedOtp.otp_auth_tag,
    send_count: nextSendCount,
    send_window_started_at: shouldResetWindow ? currentTime.toISOString() : record.send_window_started_at,
    last_sent_at: currentTime.toISOString(),
    expires_at: expiresAt.toISOString(),
    verified_at: null,
  }

  if (record) {
    const { error } = await supabaseAdmin
      .from('order_tracking_verifications')
      .update(payload)
      .eq('id', record.id)

    if (error) {
      throw error
    }
  } else {
    const { error } = await supabaseAdmin.from('order_tracking_verifications').insert(payload)

    if (error) {
      throw error
    }
  }

  return {
    expiresAt,
    sendCount: nextSendCount,
    windowState: getTrackingWindowState({ ...payload }, currentTime),
  }
}

async function getTrackingDetails(orderId) {
  const [{ data: order, error: orderError }, { data: items, error: itemsError }] = await Promise.all(
    [
      supabaseAdmin
        .from('orders')
        .select('id, order_number, customer_name, customer_email, delivery_address, status, payment_status, requires_prescription, prescription_status, prescription_document_url, rejection_reason, total_amount, created_at, updated_at')
        .eq('id', orderId)
        .maybeSingle(),
      supabaseAdmin
        .from('order_items')
        .select('id, quantity, unit_price, products(name, slug)')
        .eq('order_id', orderId)
        .order('created_at', { ascending: true }),
    ],
  )

  if (orderError) {
    throw orderError
  }

  if (itemsError) {
    throw itemsError
  }

  return {
    order,
    items: (items || []).map((item) => ({
      id: item.id,
      quantity: item.quantity,
      unit_price: item.unit_price,
      name: item.products?.name || 'Medicine',
      slug: item.products?.slug || '',
    })),
  }
}

router.post('/session', async (req, res, next) => {
  try {
    const orderNumber = String(req.body.orderNumber || '').trim()
    const email = String(req.body.email || '').trim()

    if (!orderNumber) {
      return res.status(400).json({ message: 'Order number is required.' })
    }

    if (!email) {
      return res.status(400).json({ message: 'Email address is required.' })
    }

    const { order } = await loadTrackingOrder(orderNumber, email)

    if (!order) {
      return res.status(404).json({ message: 'We could not match that order and email.' })
    }

    const record = await loadTrackingRecord(order.id)
    const response = buildSessionResponse({ order, record, currentTime: now() })

    if (response.status === 'rate_limited') {
      return res.status(429).json(response)
    }

    return res.json(response)
  } catch (error) {
    next(error)
  }
})

router.post('/send-code', async (req, res, next) => {
  try {
    const orderNumber = String(req.body.orderNumber || '').trim()
    const email = String(req.body.email || '').trim()

    if (!orderNumber) {
      return res.status(400).json({ message: 'Order number is required.' })
    }

    if (!email) {
      return res.status(400).json({ message: 'Email address is required.' })
    }

    const { order } = await loadTrackingOrder(orderNumber, email)

    if (!order) {
      return res.status(404).json({ message: 'We could not match that order and email.' })
    }

    const currentTime = now()
    const record = await loadTrackingRecord(order.id)
    const windowState = getTrackingWindowState(record, currentTime)

    if (windowState.remainingSends <= 0) {
      return res.status(429).json({
        status: 'rate_limited',
        message: 'You have reached the tracking code limit for this order. Please try again later.',
        remainingSends: 0,
        sendLimit: trackingOtpSendLimit,
        windowResetsAt: windowState.windowEnd.toISOString(),
      })
    }

    const reuseExistingCode = hasActiveCode(record, currentTime)
    const otp = reuseExistingCode ? decryptTrackingOtp(record) : generateTrackingOtp()
    const expiresAt = reuseExistingCode ? getCodeExpiry(record) : addMinutes(currentTime, trackingOtpValidityMinutes)
    const trackingRecord = await persistTrackingRecord({
      order,
      email: normalizeTrackingEmail(email),
      otp,
      record,
      currentTime,
      expiresAt,
    })

    const emailPayload = buildTrackingEmail({
      orderNumber: order.order_number,
      customerName: order.customer_name,
      otp,
      expiresAt,
    })

    await sendResendEmail({
      to: email,
      subject: emailPayload.subject,
      html: emailPayload.html,
      text: emailPayload.text,
    })

    return res.json({
      status: 'code_sent',
      message: reuseExistingCode
        ? 'We sent the latest tracking code again.'
        : 'We sent a new tracking code to your email.',
      hasActiveCode: true,
      codeExpiresAt: trackingRecord.expiresAt.toISOString(),
      remainingSends: Math.max(0, trackingOtpSendLimit - trackingRecord.sendCount),
      sendLimit: trackingOtpSendLimit,
      windowResetsAt: trackingRecord.windowState.windowEnd.toISOString(),
      orderNumber: order.order_number,
    })
  } catch (error) {
    next(error)
  }
})

router.post('/verify-code', async (req, res, next) => {
  try {
    const orderNumber = String(req.body.orderNumber || '').trim()
    const email = String(req.body.email || '').trim()
    const otp = String(req.body.otp || '').trim()

    if (!orderNumber) {
      return res.status(400).json({ message: 'Order number is required.' })
    }

    if (!email) {
      return res.status(400).json({ message: 'Email address is required.' })
    }

    if (!otp) {
      return res.status(400).json({ message: 'Tracking code is required.' })
    }

    const { order } = await loadTrackingOrder(orderNumber, email)

    if (!order) {
      return res.status(404).json({ message: 'We could not match that order and email.' })
    }

    const record = await loadTrackingRecord(order.id)

    if (!record) {
      return res.status(400).json({ message: 'Please request a tracking code first.' })
    }

    const currentTime = now()

    if (!hasActiveCode(record, currentTime)) {
      return res.status(400).json({ message: 'That code has expired. Please request a new one.' })
    }

    const storedOtp = decryptTrackingOtp(record)

    if (storedOtp.length !== otp.length || storedOtp !== otp) {
      return res.status(400).json({ message: 'That code is not correct.' })
    }

    const { error: verifyError } = await supabaseAdmin
      .from('order_tracking_verifications')
      .update({ verified_at: currentTime.toISOString() })
      .eq('id', record.id)

    if (verifyError) {
      throw verifyError
    }

    const details = await getTrackingDetails(order.id)

    return res.json({
      verified: true,
      message: 'Tracking code confirmed.',
      order: details.order,
      items: details.items,
      codeExpiresAt: record.expires_at,
      verifiedAt: currentTime.toISOString(),
    })
  } catch (error) {
    next(error)
  }
})

export default router
