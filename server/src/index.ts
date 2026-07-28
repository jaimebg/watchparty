import { buildApp } from './app.js'

const app = await buildApp({})
await app.listen({ port: 8400, host: '0.0.0.0' })
console.log('jbg-watchparty en http://localhost:8400')
