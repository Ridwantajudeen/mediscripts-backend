import { sendResendEmail } from './resend.js'

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatCurrency(value) {
  return `NGN ${Number(value || 0).toLocaleString('en-NG')}`
}

function formatDate(value) {
  if (!value) {
    return 'Just now'
  }

  return new Intl.DateTimeFormat('en-NG', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function getFrontendUrl() {
  return (process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'http://localhost:5173').replace(
    /\/+$/,
    '',
  )
}

function getBrandLogoUrl() {
  return `${getFrontendUrl()}/mediscripts-logo.png`
}

function buildItemRows(items) {
  return (items || [])
    .map((item) => {
      const name = escapeHtml(item.name || 'Medicine')
      const quantity = Number(item.quantity || 0)
      const unitPrice = Number(item.unit_price || 0)
      const subtotal = unitPrice * quantity

      return `
        <tr>
          <td style="padding: 12px 0; border-top: 1px solid #e2e8f0; color: #0f172a;">${name}</td>
          <td style="padding: 12px 0; border-top: 1px solid #e2e8f0; color: #475569; text-align: center;">${quantity}</td>
          <td style="padding: 12px 0; border-top: 1px solid #e2e8f0; color: #0f172a; text-align: right;">${formatCurrency(subtotal)}</td>
        </tr>
      `
    })
    .join('')
}

function buildOrderStatusNote(order) {
  if (order?.status === 'Approved') {
    return 'Our pharmacy team has approved your order and it is moving to the next step.'
  }

  if (order?.status === 'Paid') {
    return 'Your payment has been confirmed and your order is now in motion.'
  }

  return 'Your order has been confirmed and we are keeping it ready for the next update.'
}

export function shouldSendOrderConfirmationEmail(order) {
  if (!order) {
    return false
  }

  const isConfirmed = ['Paid', 'Approved'].includes(order.status)
  return isConfirmed && !order.confirmation_email_sent_at
}

export function buildOrderConfirmationEmail({ order, items }) {
  const logoUrl = getBrandLogoUrl()
  const total = formatCurrency(order?.total_amount)
  const orderNumber = escapeHtml(order?.order_number || 'Unknown')
  const customerName = escapeHtml(order?.customer_name || 'there')
  const orderDate = formatDate(order?.created_at)
  const deliveryAddress = escapeHtml(order?.delivery_address || 'Not provided')
  const status = escapeHtml(order?.status || 'Confirmed')
  const paymentStatus = escapeHtml(order?.payment_status || 'Pending')
  const statusNote = escapeHtml(buildOrderStatusNote(order))
  const trackUrl = `${getFrontendUrl()}/track-order`

  return {
    subject: `Your Mediscripts order ${orderNumber} is confirmed`,
    text: [
      `Hello ${customerName},`,
      '',
      `Your order ${orderNumber} has been confirmed.`,
      `Status: ${status}`,
      `Payment: ${paymentStatus}`,
      `Total: ${total}`,
      `Placed: ${orderDate}`,
      `Delivery address: ${order?.delivery_address || 'Not provided'}`,
      '',
      'Items:',
      ...(items || []).map((item) => {
        const quantity = Number(item.quantity || 0)
        const unitPrice = Number(item.unit_price || 0)
        return `- ${item.name || 'Medicine'} x${quantity} (${formatCurrency(unitPrice * quantity)})`
      }),
      '',
      statusNote,
      `Track your order here: ${trackUrl}`,
    ].join('\n'),
    html: `
      <div style="margin:0; padding:32px 0; background:#f8fafc; font-family: Arial, sans-serif; color:#0f172a;">
        <div style="max-width:640px; margin:0 auto; padding:0 18px;">
          <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:24px; overflow:hidden; box-shadow:0 18px 45px rgba(15,23,42,0.08);">
            <div style="padding:28px 28px 12px; text-align:center; border-bottom:1px solid #eef2f7;">
              <img src="${logoUrl}" alt="Mediscripts Pharmacy" style="max-width:220px; width:100%; height:auto; display:block; margin:0 auto 10px;" />
              <p style="margin:0; color:#64748b; font-size:13px; letter-spacing:0.12em; text-transform:uppercase; font-weight:700;">Order confirmed</p>
            </div>

            <div style="padding:28px;">
              <p style="margin:0 0 14px; font-size:16px; line-height:1.7;">Hello ${customerName},</p>
              <p style="margin:0 0 20px; font-size:16px; line-height:1.7; color:#334155;">${statusNote}</p>

              <div style="display:grid; gap:12px; grid-template-columns:repeat(2, minmax(0, 1fr)); margin-bottom:22px;">
                <div style="padding:14px 16px; border:1px solid #e2e8f0; border-radius:18px; background:#f8fafc;">
                  <div style="font-size:12px; color:#64748b; text-transform:uppercase; letter-spacing:0.08em; font-weight:700; margin-bottom:4px;">Order number</div>
                  <div style="font-size:15px; font-weight:700; color:#0f172a;">${orderNumber}</div>
                </div>
                <div style="padding:14px 16px; border:1px solid #e2e8f0; border-radius:18px; background:#f8fafc;">
                  <div style="font-size:12px; color:#64748b; text-transform:uppercase; letter-spacing:0.08em; font-weight:700; margin-bottom:4px;">Status</div>
                  <div style="font-size:15px; font-weight:700; color:#0f172a;">${status}</div>
                </div>
                <div style="padding:14px 16px; border:1px solid #e2e8f0; border-radius:18px; background:#f8fafc;">
                  <div style="font-size:12px; color:#64748b; text-transform:uppercase; letter-spacing:0.08em; font-weight:700; margin-bottom:4px;">Payment</div>
                  <div style="font-size:15px; font-weight:700; color:#0f172a;">${paymentStatus}</div>
                </div>
                <div style="padding:14px 16px; border:1px solid #e2e8f0; border-radius:18px; background:#f8fafc;">
                  <div style="font-size:12px; color:#64748b; text-transform:uppercase; letter-spacing:0.08em; font-weight:700; margin-bottom:4px;">Total</div>
                  <div style="font-size:15px; font-weight:700; color:#0f172a;">${total}</div>
                </div>
              </div>

              <div style="margin-bottom:20px; padding:16px 18px; border:1px solid #e2e8f0; border-radius:18px; background:#fff;">
                <div style="font-size:12px; color:#64748b; text-transform:uppercase; letter-spacing:0.08em; font-weight:700; margin-bottom:4px;">Delivery address</div>
                <div style="font-size:14px; line-height:1.7; color:#0f172a;">${deliveryAddress}</div>
              </div>

              <div style="margin-bottom:20px; padding:16px 18px; border:1px solid #e2e8f0; border-radius:18px; background:#fff;">
                <div style="font-size:12px; color:#64748b; text-transform:uppercase; letter-spacing:0.08em; font-weight:700; margin-bottom:4px;">Placed on</div>
                <div style="font-size:14px; line-height:1.7; color:#0f172a;">${escapeHtml(orderDate)}</div>
              </div>

              <div style="margin-bottom:18px;">
                <h2 style="margin:0 0 12px; font-size:18px; letter-spacing:-0.02em;">Order items</h2>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse; width:100%;">
                  <thead>
                    <tr>
                      <th style="text-align:left; padding:0 0 10px; color:#64748b; font-size:12px; text-transform:uppercase; letter-spacing:0.08em;">Item</th>
                      <th style="text-align:center; padding:0 0 10px; color:#64748b; font-size:12px; text-transform:uppercase; letter-spacing:0.08em;">Qty</th>
                      <th style="text-align:right; padding:0 0 10px; color:#64748b; font-size:12px; text-transform:uppercase; letter-spacing:0.08em;">Subtotal</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${buildItemRows(items)}
                  </tbody>
                </table>
              </div>

              <div style="display:flex; justify-content:space-between; gap:16px; align-items:center; padding:16px 18px; border-radius:18px; background:#ecfdf5; border:1px solid #bbf7d0; margin-bottom:22px;">
                <div>
                  <div style="font-size:12px; color:#166534; text-transform:uppercase; letter-spacing:0.08em; font-weight:700; margin-bottom:4px;">Order total</div>
                  <div style="font-size:20px; font-weight:800; color:#14532d;">${total}</div>
                </div>
                <a href="${trackUrl}" style="display:inline-block; padding:12px 18px; border-radius:999px; background:#38c34d; color:#fff; text-decoration:none; font-weight:700;">Track your order</a>
              </div>

              <p style="margin:0; font-size:14px; line-height:1.7; color:#475569;">${statusNote}</p>
            </div>
          </div>
        </div>
      </div>
    `,
  }
}

export async function sendOrderConfirmationEmailIfNeeded({ supabaseAdmin, order }) {
  if (!shouldSendOrderConfirmationEmail(order)) {
    return { sent: false }
  }

  const { data: items, error: itemsError } = await supabaseAdmin
    .from('order_items')
    .select('id, quantity, unit_price, products(name)')
    .eq('order_id', order.id)
    .order('created_at', { ascending: true })

  if (itemsError) {
    throw itemsError
  }

  const email = buildOrderConfirmationEmail({
    order,
    items: (items || []).map((item) => ({
      name: item.products?.name || 'Medicine',
      quantity: item.quantity,
      unit_price: item.unit_price,
    })),
  })

  await sendResendEmail({
    to: order.customer_email,
    subject: email.subject,
    html: email.html,
    text: email.text,
  })

  const { error: updateError } = await supabaseAdmin
    .from('orders')
    .update({ confirmation_email_sent_at: new Date().toISOString() })
    .eq('id', order.id)
    .is('confirmation_email_sent_at', null)

  if (updateError) {
    throw updateError
  }

  return { sent: true }
}
