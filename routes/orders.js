import crypto from 'node:crypto'
import { Router } from 'express'
import supabaseAdmin from '../server/lib/supabaseAdmin.js'
import { sendOrderConfirmationEmailIfNeeded } from '../server/lib/orderEmail.js'

const router = Router()
const paystackApiBaseUrl = 'https://api.paystack.co'

function generateOrderNumber() {
  const timestamp = Date.now().toString(36).toUpperCase()
  const randomPart = Math.random().toString(36).slice(2, 8).toUpperCase()
  return `MS-${timestamp}-${randomPart}`
}

function generatePaymentReference(orderNumber) {
  const randomPart = Math.random().toString(36).slice(2, 10).toUpperCase()
  return `PAY-${orderNumber}-${randomPart}`
}

function getFrontendUrl() {
  return (process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'http://localhost:5173').replace(
    /\/+$/,
    '',
  )
}

function normalizeCheckoutItem(item) {
  const productId = String(item?.productId || item?.id || '').trim()
  const quantity = Number.parseInt(item?.quantity, 10)

  if (!productId) {
    throw new Error('Each cart item must include a product id.')
  }

  if (Number.isNaN(quantity) || quantity <= 0) {
    throw new Error('Each cart item must include a valid quantity.')
  }

  return { productId, quantity }
}

async function initializePaystackTransaction({ email, amount, reference, callbackUrl, metadata }) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY

  if (!secretKey) {
    throw new Error('PAYSTACK_SECRET_KEY is not configured.')
  }

  const response = await fetch(`${paystackApiBaseUrl}/transaction/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      amount: String(amount),
      currency: 'NGN',
      reference,
      callback_url: callbackUrl,
      metadata: metadata || {},
    }),
  })

  const payload = await response.json()

  if (!response.ok || !payload.status || !payload.data?.authorization_url) {
    throw new Error(payload.message || 'Unable to initialize payment.')
  }

  return payload.data
}

async function verifyPaystackTransaction(reference) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY

  if (!secretKey) {
    throw new Error('PAYSTACK_SECRET_KEY is not configured.')
  }

  const response = await fetch(
    `${paystackApiBaseUrl}/transaction/verify/${encodeURIComponent(reference)}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${secretKey}`,
      },
    },
  )

  const payload = await response.json()

  if (!response.ok || !payload.status) {
    throw new Error(payload.message || 'Unable to verify payment.')
  }

  return payload.data
}

function buildPaystackTransactionPayload(transaction) {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    reference: transaction.reference,
    paidAt: transaction.paid_at || transaction.paidAt || null,
    gatewayResponse: transaction.gateway_response,
    channel: transaction.channel,
    requestedAmount: transaction.requested_amount,
    customer: transaction.customer,
  }
}

function signaturesMatch(expectedSignature, providedSignature) {
  const expected = Buffer.from(expectedSignature)
  const provided = Buffer.from(providedSignature)

  if (expected.length !== provided.length) {
    return false
  }

  return crypto.timingSafeEqual(expected, provided)
}

async function loadPaymentContext(reference) {
  const { data: payment, error: paymentError } = await supabaseAdmin
    .from('payments')
    .select('id, order_id, reference, status, amount, metadata')
    .eq('reference', reference)
    .maybeSingle()

  if (paymentError) {
    throw paymentError
  }

  if (!payment) {
    return { payment: null, currentOrder: null }
  }

  const { data: currentOrder, error: orderError } = await supabaseAdmin
    .from('orders')
    .select(
      'id, order_number, customer_name, customer_email, customer_phone, delivery_address, status, payment_status, payment_reference, total_amount, created_at, updated_at, confirmation_email_sent_at',
    )
    .eq('id', payment.order_id)
    .maybeSingle()

  if (orderError) {
    throw orderError
  }

  return { payment, currentOrder }
}

async function markPaymentVerified(payment, transactionPayload) {
  const { data: updatedPayment, error: updatePaymentError } = await supabaseAdmin
    .from('payments')
    .update({
      status: 'Verified',
      metadata: {
        ...(payment.metadata || {}),
        paystack: transactionPayload,
      },
    })
    .eq('reference', payment.reference)
    .select('id, order_id, reference, status, amount, metadata')
    .single()

  if (updatePaymentError) {
    throw updatePaymentError
  }

  const { data: updatedOrder, error: updateOrderError } = await supabaseAdmin
    .from('orders')
    .update({
      status: 'Paid',
      payment_status: 'Paid',
    })
    .eq('id', payment.order_id)
    .select(
      'id, order_number, customer_name, customer_email, customer_phone, delivery_address, status, payment_status, payment_reference, total_amount, created_at, updated_at, confirmation_email_sent_at',
    )
    .single()

  if (updateOrderError) {
    throw updateOrderError
  }

  try {
    await sendOrderConfirmationEmailIfNeeded({ supabaseAdmin, order: updatedOrder })
  } catch (emailError) {
    console.warn('Order confirmation email could not be sent:', emailError)
  }

  return { updatedPayment, updatedOrder }
}

async function markPaymentFailed(payment, transactionPayload) {
  const { data: failedPayment, error: failedPaymentError } = await supabaseAdmin
    .from('payments')
    .update({
      status: 'Failed',
      metadata: {
        ...(payment.metadata || {}),
        paystack: transactionPayload,
      },
    })
    .eq('reference', payment.reference)
    .select('id, order_id, reference, status, amount, metadata')
    .single()

  if (failedPaymentError) {
    throw failedPaymentError
  }

  return failedPayment
}

router.post('/checkout', async (req, res, next) => {
  try {
    const customerName = String(req.body.customerName || '').trim()
    const customerEmail = String(req.body.customerEmail || '').trim()
    const customerPhone = String(req.body.customerPhone || '').trim()
    const deliveryAddress = String(req.body.deliveryAddress || '').trim()
    const rawItems = Array.isArray(req.body.items) ? req.body.items : []

    if (!customerName) {
      return res.status(400).json({ message: 'Full name is required.' })
    }

    if (!customerEmail) {
      return res.status(400).json({ message: 'Email is required.' })
    }

    if (!customerPhone) {
      return res.status(400).json({ message: 'Phone number is required.' })
    }

    if (!deliveryAddress) {
      return res.status(400).json({ message: 'Delivery address is required.' })
    }

    if (rawItems.length === 0) {
      return res.status(400).json({ message: 'Your cart is empty.' })
    }

    const items = rawItems.map(normalizeCheckoutItem)
    const productIds = [...new Set(items.map((item) => item.productId))]

    const { data: products, error: productsError } = await supabaseAdmin
      .from('products')
      .select('id, name, price, stock_quantity, prescription_required, is_active')
      .in('id', productIds)

    if (productsError) {
      throw productsError
    }

    const productMap = new Map((products || []).map((product) => [product.id, product]))

    if (productMap.size !== productIds.length) {
      return res.status(400).json({ message: 'One or more products in your cart no longer exist.' })
    }

    const lineItems = items.map((item) => {
      const product = productMap.get(item.productId)

      if (!product?.is_active) {
        throw new Error(`"${product?.name || 'A product'}" is no longer available.`)
      }

      if (product.prescription_required) {
        throw new Error(
          `"${product.name}" requires a prescription and cannot be checked out here yet.`,
        )
      }

      if (product.stock_quantity < item.quantity) {
        throw new Error(`"${product.name}" does not have enough stock for your order.`)
      }

      return {
        productId: product.id,
        quantity: item.quantity,
        unitPrice: Number(product.price || 0),
      }
    })

    const totalAmount = lineItems.reduce(
      (sum, item) => sum + Number(item.unitPrice || 0) * item.quantity,
      0,
    )

    const orderNumber = generateOrderNumber()
    const paymentReference = generatePaymentReference(orderNumber)

    const { data: order, error: orderError } = await supabaseAdmin
      .from('orders')
      .insert({
        order_number: orderNumber,
        customer_name: customerName,
        customer_email: customerEmail,
        customer_phone: customerPhone,
        delivery_address: deliveryAddress,
        status: 'Pending Payment',
        payment_status: 'Unpaid',
        requires_prescription: false,
        total_amount: totalAmount,
        payment_reference: paymentReference,
      })
      .select('id, order_number, total_amount, status, payment_status, payment_reference, created_at')
      .single()

    if (orderError) {
      throw orderError
    }

    const { error: itemsError } = await supabaseAdmin.from('order_items').insert(
      lineItems.map((item) => ({
        order_id: order.id,
        product_id: item.productId,
        quantity: item.quantity,
        unit_price: item.unitPrice,
      })),
    )

    if (itemsError) {
      await supabaseAdmin.from('orders').delete().eq('id', order.id)
      throw itemsError
    }

    const { error: paymentError } = await supabaseAdmin.from('payments').insert({
      order_id: order.id,
      provider: 'paystack',
      reference: paymentReference,
      status: 'Pending',
      amount: totalAmount,
      metadata: {
        orderNumber,
        customerEmail,
      },
    })

    if (paymentError) {
      throw paymentError
    }

    const callbackUrl = `${getFrontendUrl()}/checkout/success/${order.order_number}`
    const paystackTransaction = await initializePaystackTransaction({
      email: customerEmail,
      amount: Math.round(Number(totalAmount || 0) * 100),
      reference: paymentReference,
      callbackUrl,
      metadata: {
        orderNumber: order.order_number,
        customerName,
        customerEmail,
        customerPhone,
      },
    })

    await supabaseAdmin
      .from('payments')
      .update({
        metadata: {
          orderNumber: order.order_number,
          customerEmail,
          accessCode: paystackTransaction.access_code,
          authorizationUrl: paystackTransaction.authorization_url,
          callbackUrl,
        },
      })
      .eq('reference', paymentReference)

    res.status(201).json({
      order: {
        ...order,
        items: lineItems.map((item) => {
          const product = productMap.get(item.productId)
          return {
            productId: item.productId,
            name: product?.name || 'Product',
            quantity: item.quantity,
            unitPrice: item.unitPrice,
          }
        }),
      },
      payment: {
        reference: paymentReference,
        authorizationUrl: paystackTransaction.authorization_url,
        accessCode: paystackTransaction.access_code,
        callbackUrl,
      },
    })
  } catch (error) {
    next(error)
  }
})

router.get('/payments/verify', async (req, res, next) => {
  try {
    const reference = String(req.query.reference || req.query.trxref || '').trim()

    if (!reference) {
      return res.status(400).json({ message: 'Payment reference is required.' })
    }

    const { payment, currentOrder } = await loadPaymentContext(reference)

    if (!payment || !currentOrder) {
      return res.status(404).json({ message: 'Payment record not found.' })
    }

    if (payment.status === 'Verified' || currentOrder.payment_status === 'Paid') {
      try {
        await sendOrderConfirmationEmailIfNeeded({ supabaseAdmin, order: currentOrder })
      } catch (emailError) {
        console.warn('Order confirmation email could not be sent:', emailError)
      }

      return res.json({
        verified: true,
        transactionStatus: 'success',
        payment,
        order: currentOrder,
      })
    }

    const transaction = await verifyPaystackTransaction(reference)
    const transactionStatus = String(transaction.status || '').toLowerCase()
    const transactionPayload = buildPaystackTransactionPayload(transaction)

    if (transactionStatus === 'success') {
      const { updatedPayment, updatedOrder } = await markPaymentVerified(payment, transactionPayload)

      return res.json({
        verified: true,
        transactionStatus,
        payment: updatedPayment,
        order: updatedOrder,
      })
    }

    if (['failed', 'abandoned', 'reversed'].includes(transactionStatus)) {
      const failedPayment = await markPaymentFailed(payment, transactionPayload)

      return res.status(400).json({
        verified: false,
        transactionStatus,
        payment: failedPayment,
        order: currentOrder,
        message: 'Payment was not successful.',
      })
    }

    return res.json({
      verified: false,
      transactionStatus,
      payment,
      order: currentOrder,
      message: 'Payment is still being processed.',
    })
  } catch (error) {
    next(error)
  }
})

router.post('/payments/webhook', async (req, res, next) => {
  try {
    const secretKey = process.env.PAYSTACK_SECRET_KEY
    const signature = req.get('x-paystack-signature') || ''
    const rawBody = req.rawBody

    if (!secretKey) {
      return res.status(500).json({ message: 'PAYSTACK_SECRET_KEY is not configured.' })
    }

    if (!signature || !rawBody || rawBody.length === 0) {
      return res.status(401).json({ message: 'Invalid webhook signature.' })
    }

    const expectedSignature = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex')

    if (!signaturesMatch(expectedSignature, signature)) {
      return res.status(401).json({ message: 'Invalid webhook signature.' })
    }

    const event = req.body

    if (event?.event !== 'charge.success') {
      return res.json({ received: true, processed: false })
    }

    const transaction = event.data || {}
    const reference = String(transaction.reference || '').trim()

    if (!reference) {
      return res.status(400).json({ message: 'Webhook payload is missing a payment reference.' })
    }

    const transactionStatus = String(transaction.status || '').toLowerCase()

    if (transactionStatus !== 'success') {
      return res.json({ received: true, processed: false })
    }

    const { payment, currentOrder } = await loadPaymentContext(reference)

    if (!payment || !currentOrder) {
      return res.json({
        received: true,
        processed: false,
        message: 'Payment record not found.',
      })
    }

    if (payment.status === 'Verified' || currentOrder.payment_status === 'Paid') {
      try {
        await sendOrderConfirmationEmailIfNeeded({ supabaseAdmin, order: currentOrder })
      } catch (emailError) {
        console.warn('Order confirmation email could not be sent:', emailError)
      }

      return res.json({ received: true, processed: true, verified: true })
    }

    const transactionPayload = buildPaystackTransactionPayload(transaction)
    const { updatedPayment, updatedOrder } = await markPaymentVerified(payment, transactionPayload)

    return res.json({
      received: true,
      processed: true,
      verified: true,
      payment: updatedPayment,
      order: updatedOrder,
    })
  } catch (error) {
    next(error)
  }
})

export default router
