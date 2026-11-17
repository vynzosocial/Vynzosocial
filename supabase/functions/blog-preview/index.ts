import { createClient } from 'npm:@supabase/supabase-js@2.91.0'
import { publicBlogPreview, rewritePublicBlogMedia } from './public-blog.mjs'
import { cleanHtml } from '../vynzo-api/blog-sanitize.ts'
import { accountIsActive } from '../vynzo-api/account-lifecycle-access.mjs'
import { readLegacyPublicMedia } from '../public-share-media/media-access.mjs'

const supabaseUrl = Deno.env.get('SUPABASE_URL')
const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}')
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || secretKeys.default
if (!supabaseUrl || !serviceRoleKey) throw new Error('Supabase server credentials are required.')
const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const previewMediaTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime'])
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }

Deno.serve(async request => {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { ...headers, Allow: 'GET' } })
  const url = new URL(request.url)
  const id = url.searchParams.get('id') || ''
  if (!uuid.test(id)) return new Response('Not found', { status: 404, headers })
  try {
    const { data: article, error } = await admin.from('blog_articles').select('id,title,cover_url,status,author_id,content_html,language').eq('id', id).maybeSingle()
    if (error) throw error
    if (!article) return new Response('Not found', { status: 404, headers })
    if (Deno.env.get('ACCOUNT_LIFECYCLE_ENABLED') === 'true' && !await accountIsActive(admin, article.author_id)) {
      return new Response('Not found', { status: 404, headers })
    }
    const { data: owner, error: ownerError } = await admin.from('users').select('is_private').eq('id', article.author_id).maybeSingle()
    if (ownerError) throw ownerError
    const preview = publicBlogPreview(article, owner, new URL(supabaseUrl).origin)
    if (!preview) return new Response('Not found', { status: 404, headers })
    if (url.searchParams.get('image') !== '1') {
      return Response.json({ title: preview.title, hasCover: !!preview.coverPath,
        ...(url.searchParams.get('full') === '1' ? {
          content: rewritePublicBlogMedia(cleanHtml(article.content_html), article, new URL(supabaseUrl).origin, 'https://www.vynzosocial.com/share-blog-media'),
          language: article.language === 'ar' ? 'ar' : 'en'
        } : {}) }, { headers })
    }
    const requestedAsset = url.searchParams.get('asset')
    const path = requestedAsset
      ? preview.mediaPaths.includes(requestedAsset) ? requestedAsset : null
      : preview.coverPath
    if (!path) return new Response('Not found', { status: 404, headers })
    const result = await readLegacyPublicMedia(
      admin.storage.from('uploads'),
      path,
      new URL(supabaseUrl).origin,
      request.headers.get('Range')
    )
    if (result.status === 404) return new Response('Not found', { status: 404, headers })
    if (result.status === 416) {
      const rangeHeaders = new Headers(headers)
      rangeHeaders.set('Content-Range', result.headers.get('Content-Range') || 'bytes */0')
      return new Response(null, { status: 416, headers: rangeHeaders })
    }
    if (![200, 206].includes(result.status)) throw new Error(`Storage media request failed (HTTP ${result.status}).`)
    const media = result
    const type = media.headers.get('Content-Type')
    if (!type || !previewMediaTypes.has(type) || (!requestedAsset && !type.startsWith('image/'))) {
      console.error('Blog preview media has an unsupported content type.')
      return new Response('Preview unavailable', { status: 502, headers })
    }
    const mediaHeaders = new Headers(headers)
    mediaHeaders.set('Content-Type', type)
    mediaHeaders.set('Accept-Ranges', 'bytes')
    for (const name of ['Content-Length', 'Content-Range', 'Accept-Ranges']) {
      const value = media.headers.get(name)
      if (value) mediaHeaders.set(name, value)
    }
    return new Response(media.body, { status: result.status, headers: mediaHeaders })
  } catch (error) {
    console.error('Blog preview failed:', error)
    return new Response('Preview unavailable', { status: 503, headers })
  }
})
