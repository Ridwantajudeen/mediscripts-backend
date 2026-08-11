import { Router } from 'express'
import supabaseAdmin from '../server/lib/supabaseAdmin.js'

const router = Router()
const staticPaths = ['', 'products', 'contact', 'track-order']

router.get('/sitemap.xml', async (req, res, next) => {
  try {
    const siteUrl = String(process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')
    const { data, error } = await supabaseAdmin
      .from('products')
      .select('slug')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .range(0, 9999)

    if (error) {
      throw error
    }

    const now = new Date().toISOString()
    const staticUrls = staticPaths.map((path) => `${siteUrl}/${path}`)
    const productUrls = Array.isArray(data)
      ? data
          .filter((product) => product?.slug)
          .map((product) => `${siteUrl}/products/${encodeURIComponent(product.slug)}`)
      : []

    const allUrls = [...new Set([...staticUrls, ...productUrls])]

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${allUrls
  .map(
    (url) => `  <url>\n    <loc>${url}</loc>\n    <lastmod>${now}</lastmod>\n    <changefreq>weekly</changefreq>\n  </url>`,
  )
  .join('\n')}
</urlset>`

    res.header('Content-Type', 'application/xml')
    res.send(xml)
  } catch (error) {
    next(error)
  }
})

export default router
