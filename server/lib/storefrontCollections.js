function normalizeProductRecord(product) {
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    description: product.description,
    price: Number(product.price || 0),
    stockQuantity: Number(product.stock_quantity || 0),
    prescriptionRequired: Boolean(product.prescription_required),
    isActive: product.is_active !== false,
    images: Array.isArray(product.images) ? product.images : [],
    categoryId: product.category_id || null,
    category: product.categories?.name || 'Uncategorized',
    categorySlug: product.categories?.slug || '',
  }
}

function isMissingRelationError(error) {
  const message = String(error?.message || '').toLowerCase()
  return (
    error?.code === '42P01' ||
    error?.code === '42883' ||
    message.includes('does not exist') ||
    message.includes('could not find the relation') ||
    message.includes('relation "public.storefront_collections" does not exist')
  )
}

function emptyCollections() {
  return {
    featuredProducts: [],
    promotionProducts: [],
    featuredProductIds: [],
    promotionProductIds: [],
  }
}

export async function loadStorefrontCollections(supabaseAdmin) {
  const { data: collections, error } = await supabaseAdmin
    .from('storefront_collections')
    .select('section_key, sort_order, product_id')
    .order('section_key', { ascending: true })
    .order('sort_order', { ascending: true })

  if (error) {
    if (isMissingRelationError(error)) {
      return emptyCollections()
    }

    throw error
  }

  const rows = Array.isArray(collections) ? collections : []

  if (rows.length === 0) {
    return emptyCollections()
  }

  const productIds = [...new Set(rows.map((row) => row.product_id).filter(Boolean))]
  const { data: products, error: productsError } = await supabaseAdmin
    .from('products')
    .select('id, name, slug, description, price, stock_quantity, prescription_required, is_active, images, category_id, categories(name, slug)')
    .in('id', productIds)

  if (productsError) {
    if (isMissingRelationError(productsError)) {
      return emptyCollections()
    }

    throw productsError
  }

  const productMap = new Map(
    (products || [])
      .filter((product) => product && product.is_active !== false)
      .map((product) => [product.id, normalizeProductRecord(product)]),
  )

  const grouped = emptyCollections()

  for (const row of rows) {
    const sectionKey = row.section_key === 'promotion' ? 'promotion' : 'featured'
    const normalizedProduct = productMap.get(row.product_id)

    if (!normalizedProduct) {
      continue
    }

    grouped[`${sectionKey}Products`].push(normalizedProduct)
    grouped[`${sectionKey}ProductIds`].push(normalizedProduct.id)
  }

  return grouped
}

export function normalizeProductForAdmin(product) {
  return normalizeProductRecord(product)
}
