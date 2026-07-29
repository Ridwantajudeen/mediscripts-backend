const resendApiBaseUrl = 'https://api.resend.com'

function getResendFromAddress() {
  const fromAddress = String(process.env.RESEND_FROM_EMAIL || '').trim()

  if (!fromAddress) {
    throw new Error('RESEND_FROM_EMAIL is not configured.')
  }

  return fromAddress
}

export async function sendResendEmail({ to, subject, html, text }) {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim()

  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured.')
  }

  const response = await fetch(`${resendApiBaseUrl}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: getResendFromAddress(),
      to: [to],
      subject,
      html,
      text,
    }),
  })

  const payload = await response.json()

  if (!response.ok || !payload?.id) {
    throw new Error(payload?.message || 'Unable to send email.')
  }

  return payload
}
