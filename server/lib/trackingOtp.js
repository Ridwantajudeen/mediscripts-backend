import crypto from 'node:crypto'

const trackingSecret =
  process.env.TRACKING_OTP_SECRET ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'mediscript-tracking-otp-secret'

const trackingKey = crypto.createHash('sha256').update(trackingSecret).digest()

export const trackingOtpValidityMinutes = 10
export const trackingOtpWindowMinutes = 30
export const trackingOtpSendLimit = 5

export function normalizeTrackingOrderNumber(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
}

export function normalizeTrackingEmail(value) {
  return String(value || '').trim().toLowerCase()
}

export function generateTrackingOtp() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
}

export function encryptTrackingOtp(otp) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', trackingKey, iv)
  const encrypted = Buffer.concat([cipher.update(String(otp), 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return {
    otp_ciphertext: encrypted.toString('base64'),
    otp_iv: iv.toString('base64'),
    otp_auth_tag: authTag.toString('base64'),
  }
}

export function decryptTrackingOtp(record) {
  if (!record?.otp_ciphertext || !record?.otp_iv || !record?.otp_auth_tag) {
    return ''
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    trackingKey,
    Buffer.from(record.otp_iv, 'base64'),
  )

  decipher.setAuthTag(Buffer.from(record.otp_auth_tag, 'base64'))

  return Buffer.concat([
    decipher.update(Buffer.from(record.otp_ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

export function formatTrackingDate(value) {
  return new Intl.DateTimeFormat('en-NG', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}
