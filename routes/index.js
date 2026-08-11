import { Router } from 'express'
import healthRoutes from './health.js'
import adminRoutes from './admin.js'
import catalogRoutes from './catalog.js'
import inventoryRoutes from './inventory.js'
import ordersRoutes from './orders.js'
import trackingRoutes from './tracking.js'
import sitemapRoutes from './sitemap.js'

const router = Router()

router.use(healthRoutes)
router.use('/catalog', catalogRoutes)
router.use('/orders', ordersRoutes)
router.use('/tracking', trackingRoutes)
router.use('/admin', adminRoutes)
router.use('/admin/inventory', inventoryRoutes)
router.use('/', sitemapRoutes)

export default router
