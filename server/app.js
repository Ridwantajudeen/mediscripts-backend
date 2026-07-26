import express from 'express'
import cors from 'cors'
import routes from '../routes/index.js'
import { notFoundHandler, errorHandler } from '../middleware/errorHandler.js'

const app = express()

app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(',').map((value) => value.trim()) || '*',
  }),
)
app.use(
  express.json({
    limit: '2mb',
    verify: (req, _res, buffer) => {
      req.rawBody = buffer
    },
  }),
)
app.use(express.urlencoded({ extended: true }))

app.get('/', (_req, res) => {
  res.json({
    name: 'Mediscript API',
    status: 'ok',
  })
})

app.use('/api', routes)
app.use(notFoundHandler)
app.use(errorHandler)

export default app
