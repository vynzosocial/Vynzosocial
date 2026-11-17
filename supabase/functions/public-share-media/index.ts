import { createClient } from 'npm:@supabase/supabase-js@2.91.0'
import { publicMediaReference, readLegacyPublicMedia } from './media-access.mjs'
import { accountIsActive } from '../vynzo-api/account-lifecycle-access.mjs'

const supabaseUrl = Deno.env.get('SUPABASE_URL')
const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}')
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || secretKeys.default
if (!supabaseUrl || !serviceRoleKey) throw new Error('Supabase server credentials are required.')
const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

Deno.serve(async request => {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers })
  const params = new URL(request.url).searchParams
  const kind = params.get('kind'), id = params.get('id') || '', type = params.get('type')
  if (!['post', 'story'].includes(kind || '') || !uuid.test(id) || !['image', 'video'].includes(type || '')) return new Response('Not found', { status: 404, headers })
  try {
    const { data: item, error } = kind === 'story'
      ? await admin.from('stories').select('id,user_id,media_url,media_type,privacy,is_protected,expires_at').eq('id', id).maybeSingle()
      : await admin.from('posts').select('id,user_id,media_url,media_type,privacy,is_protected').eq('id', id).maybeSingle()
    if (error) throw error
    if (!item) return new Response('Not found', { status: 404, headers })
    if (Deno.env.get('ACCOUNT_LIFECYCLE_ENABLED') === 'true' && !await accountIsActive(admin, item.user_id)) {
      return new Response('Not found', { status: 404, headers })
    }
    const { data: owner, error: ownerError } = await admin.from('users').select('is_private,posts_privacy').eq('id', item.user_id).maybeSingle()
    if (ownerError) throw ownerError
    const ref = publicMediaReference(item, owner, kind, id, type)
    if (!ref) return new Response('Not found', { status: 404, headers })
    const range = request.headers.get('Range')
    let response: Response
    if (ref.legacyPath) {
      response = await readLegacyPublicMedia(admin.storage.from('uploads'), ref.legacyPath, supabaseUrl!, range)
    } else {
      const workerUrl = Deno.env.get('R2_MEDIA_WORKER_URL')
      const secret = Deno.env.get('R2_MEDIA_CONTROL_SECRET')
      if (!workerUrl || !secret || secret.length < 32) throw new Error('Media delivery is not configured.')
      response = await fetch(new URL('/internal/read', workerUrl), { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Media-Control': secret, ...(range ? { Range: range } : {}) },
        body: JSON.stringify(ref) })
    }
    if (response.status === 404) return new Response('Not found', { status: 404, headers })
    if (response.status === 416) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': response.headers.get('Content-Range') || 'bytes */0' } })
    if (![200, 206].includes(response.status)) throw new Error(`Media read failed (HTTP ${response.status}).`)
    const contentType = response.headers.get('Content-Type') || ''
    const allowed = type === 'image' ? ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] : ['video/mp4', 'video/webm', 'video/quicktime']
    if (!allowed.includes(contentType)) throw new Error('Invalid media content type.')
    const resultHeaders = new Headers({ ...headers, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' })
    for (const name of ['Content-Length', 'Content-Range']) {
      const value = response.headers.get(name)
      if (value) resultHeaders.set(name, value)
    }
    return new Response(response.body, { status: response.status, headers: resultHeaders })
  } catch (error) {
    console.error('Public media delivery failed:', error)
    return new Response('Media unavailable', { status: 503, headers })
  }
})
