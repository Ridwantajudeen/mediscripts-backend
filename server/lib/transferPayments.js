import crypto from 'node:crypto'

const receiptBucket = 'transfer-receipts'
const defaultNotificationEmail = 'mediscriptsrx2@gmail.com'

function normalizeText(value) {
  return String(value || '').trim()
}

function getExtensionFromContentType(contentType) {
  switch (String(contentType || '').toLowerCase()) {
    case 'image/jpeg':
      return '.jpg'
    case 'image/png':
      return '.png'
    case 'image/webp':
      return '.webp'
    case 'application/pdf':
      return '.pdf'
    default:
      return '.bin'
  }
}

function parseReceiptDataUrl(dataUrl) {
  const value = normalizeText(dataUrl)

  if (!value) {
    throw new Error('Receipt file is required.')
  }

  const match = /^data:([^;]+);base64,(.+)$/.exec(value)

  if (!match) {
    throw new Error('Receipt file must be sent as a data URL.')
  }

  return {
    contentType: match[1],
    buffer: Buffer.from(match[2], 'base64'),
  }
}

export async function loadTransferPaymentSettings(supabaseAdmin) {
  const { data, error } = await supabaseAdmin
    .from('payment_settings')
    .select('bank_name, account_name, account_number, instructions, notification_email, updated_at')
    .eq('id', 1)
    .maybeSingle()

  if (error) {
    throw error
  }

  return {
    bank_name: data?.bank_name || '',
    account_name: data?.account_name || '',
    account_number: data?.account_number || '',
    instructions: data?.instructions || '',
    notification_email: data?.notification_email || defaultNotificationEmail,
    updated_at: data?.updated_at || null,
  }
}

export async function upsertTransferPaymentSettings(supabaseAdmin, payload, actorId) {
  const normalized = {
    bank_name: normalizeText(payload.bankName || payload.bank_name),
    account_name: normalizeText(payload.accountName || payload.account_name),
    account_number: normalizeText(payload.accountNumber || payload.account_number),
    instructions: normalizeText(payload.instructions || ''),
    notification_email: normalizeText(payload.notificationEmail || payload.notification_email) || defaultNotificationEmail,
    updated_by: actorId || null,
  }

  const { data, error } = await supabaseAdmin
    .from('payment_settings')
    .upsert({ id: 1, ...normalized })
    .select('bank_name, account_name, account_number, instructions, notification_email, updated_at')
    .single()

  if (error) {
    throw error
  }

  return data
}

export async function uploadTransferReceipt({ supabaseAdmin, orderNumber, receiptDataUrl }) {
  const { contentType, buffer } = parseReceiptDataUrl(receiptDataUrl)

  if (buffer.length === 0) {
    throw new Error('Receipt file is empty.')
  }

  const path = `orders/${normalizeText(orderNumber)}/${Date.now()}-${crypto.randomUUID()}${getExtensionFromContentType(contentType)}`
  const { error } = await supabaseAdmin.storage.from(receiptBucket).upload(path, buffer, {
    contentType,
    upsert: false,
  })

  if (error) {
    throw error
  }

  return {
    path,
    contentType,
    size: buffer.length,
  }
}

export async function createTransferReceiptSignedUrl(supabaseAdmin, path, expiresIn = 24 * 60 * 60) {
  if (!path) {
    return null
  }

  const { data, error } = await supabaseAdmin.storage.from(receiptBucket).createSignedUrl(path, expiresIn)

  if (error) {
    throw error
  }

  return data?.signedUrl || null
}
