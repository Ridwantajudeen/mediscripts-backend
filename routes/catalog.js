import { Router } from 'express'
import supabaseAdmin from '../server/lib/supabaseAdmin.js'
import { loadStorefrontCollections } from '../server/lib/storefrontCollections.js'

const router = Router()

function escapeLikeValue(value) {
  return String(value || '').replace(/[%_]/g, '\\$&')
}

router.get('/products', async (req, res, next) => {
  try {
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1)
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 24, 1), 50)
    const categoryId = String(req.query.categoryId || '').trim()
    const search = String(req.query.q || '').trim()
    const start = (page - 1) * limit
    const fetchLimit = limit + 1
    const end = start + fetchLimit - 1

    let query = supabaseAdmin
      .from('products')
      .select(
        'id, name, slug, description, price, stock_quantity, prescription_required, is_active, images, category_id, categories(name, slug)',
      )
      .eq('is_active', true)
      .order('created_at', { ascending: false })

    if (categoryId) {
      query = query.eq('category_id', categoryId)
    }

    if (search) {
      const safeSearch = `%${escapeLikeValue(search)}%`
      query = query.or(`name.ilike.${safeSearch},description.ilike.${safeSearch}`)
    }

    const { data, error } = await query.range(start, end)

    if (error) {
      throw error
    }

    const items = Array.isArray(data) ? data : []
    const hasMore = items.length > limit
    const products = items.slice(0, limit).map((product) => ({
      id: product.id,
      name: product.name,
      slug: product.slug,
      description: product.description,
      price: product.price,
      stockQuantity: product.stock_quantity,
      prescriptionRequired: product.prescription_required,
      isActive: product.is_active,
      images: product.images,
      categoryId: product.category_id,
      category: product.categories?.name || 'Uncategorized',
      categorySlug: product.categories?.slug || '',
    }))

    res.json({
      products,
      page,
      limit,
      hasMore,
    })
  } catch (error) {
    next(error)
  }
})

router.get('/homepage-sections', async (_req, res, next) => {
  try {
    const sections = await loadStorefrontCollections(supabaseAdmin)
    res.json(sections)
  } catch (error) {
    next(error)
  }
})

router.get('/products/:slug', async (req, res, next) => {
  try {
    const { slug } = req.params

    const { data, error } = await supabaseAdmin
      .from('products')
      .select(
        'id, name, slug, description, price, stock_quantity, prescription_required, is_active, images, categories(name, slug)',
      )
      .eq('slug', slug)
      .eq('is_active', true)
      .maybeSingle()

    if (error) {
      throw error
    }

    if (!data) {
      return res.status(404).json({ message: 'Product not found.' })
    }

    res.json({
      product: {
        id: data.id,
        name: data.name,
        slug: data.slug,
        description: data.description,
        price: data.price,
        stockQuantity: data.stock_quantity,
        prescriptionRequired: data.prescription_required,
        isActive: data.is_active,
        images: data.images,
        categoryId: data.category_id,
        category: data.categories?.name || 'Uncategorized',
        categorySlug: data.categories?.slug || '',
      },
    })
  } catch (error) {
    next(error)
  }
})

router.get('/categories', async (_req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('categories')
      .select('id, name, slug, description, is_active')
      .eq('is_active', true)
      .order('name', { ascending: true })

    if (error) {
      throw error
    }

    res.json({ categories: data || [] })
  } catch (error) {
    next(error)
  }
})

export default router
