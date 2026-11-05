import { createClient } from 'npm:@supabase/supabase-js@2.91.0'
import { GUIDELINES_MESSAGE, suspensionMessage, violatesGuidelines } from './community-rules.ts'
import { handleBlogs } from './blogs.ts'
import { startBlogAutoReview } from './blog-autoreview.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')
const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}')
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || secretKeys.default

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Supabase URL and a server-side secret API key are required.')
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false }
})

startBlogAutoReview(admin)

const allowedOrigins = new Set([
  'https://www.vynzosocial.com',
  'https://vynzosocial.com',
  'https://localhost',
  'capacitor://localhost'
])

const allowedMediaTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'video/quicktime'
])

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Vary': 'Origin'
  }
  if (origin && (allowedOrigins.has(origin))) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' }
  })
}

function throwOnError(error: { message: string } | null): void {
  if (error) throw error
}

function getErrorMetadata(error: unknown): { code?: string; name?: string; status?: number } {
  if (!error || typeof error !== 'object') return {}
  const metadata: { code?: string; name?: string; status?: number } = {}
  if ('code' in error && typeof error.code === 'string') metadata.code = error.code
  if ('name' in error && typeof error.name === 'string') metadata.name = error.name
  if ('status' in error && typeof error.status === 'number') metadata.status = error.status
  if ('statusCode' in error) {
    const statusCode = Number(error.statusCode)
    if (Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599) metadata.status = statusCode
  }
  return metadata
}

const USERNAME_ALLOWED = /^[\p{L}\p{N}\p{M}\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0f._-]+$/u
const USERNAME_HAS_CONTENT = /[\p{L}\p{N}\p{Extended_Pictographic}\p{Regional_Indicator}]/u
function isValidUsername(value: string): boolean {
  const name = value.normalize('NFC')
  const length = [...name].length
  return length >= 2 && length <= 30 && USERNAME_ALLOWED.test(name) && USERNAME_HAS_CONTENT.test(name)
}

async function getViewer(request: Request): Promise<{ id: string } | null> {
  const authorization = request.headers.get('Authorization')
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) return null

  const authClient = createClient(supabaseUrl!, serviceRoleKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } }
  })
  const { data, error } = await authClient.auth.getUser(token)
  if (error && (('status' in error && Number(error.status) >= 400 && Number(error.status) < 500) || error.name === 'AuthSessionMissingError')) return null
  if (error) throw error
  if (!data.user) return null
  return { id: data.user.id }
}

async function getAcceptedConnections(userId: string): Promise<Set<string>> {
  const [outgoing, incoming] = await Promise.all([
    admin.from('follows').select('following_id').eq('follower_id', userId).eq('status', 'accepted'),
    admin.from('follows').select('follower_id').eq('following_id', userId).eq('status', 'accepted')
  ])
  throwOnError(outgoing.error)
  throwOnError(incoming.error)
  const follows = new Set((outgoing.data || []).map(row => row.following_id))
  const followedBy = new Set((incoming.data || []).map(row => row.follower_id))
  return new Set([...follows].filter(id => followedBy.has(id)))
}

// Everyone the viewer blocked plus everyone who blocked the viewer; content from either side is hidden.
async function getBlockedIds(viewerId: string): Promise<Set<string>> {
  const { data, error } = await admin.from('blocks').select('blocker_id,blocked_id')
    .or(`blocker_id.eq.${viewerId},blocked_id.eq.${viewerId}`)
  throwOnError(error)
  return new Set((data || []).map(row => row.blocker_id === viewerId ? row.blocked_id : row.blocker_id))
}

async function getBlockRelation(viewerId: string, targetId: string) {
  const [mine, theirs] = await Promise.all([
    admin.from('blocks').select('blocker_id').eq('blocker_id', viewerId).eq('blocked_id', targetId).maybeSingle(),
    admin.from('blocks').select('blocker_id').eq('blocker_id', targetId).eq('blocked_id', viewerId).maybeSingle()
  ])
  throwOnError(mine.error)
  throwOnError(theirs.error)
  return { blockedByMe: Boolean(mine.data), blockedMe: Boolean(theirs.data) }
}

async function getFollowStatus(viewerId: string, userIds: string[]) {
  if (!userIds.length) return new Map<string, { following: boolean; followsMe: boolean }>()
  const [outgoing, incoming] = await Promise.all([
    admin.from('follows').select('following_id,status').eq('follower_id', viewerId).in('following_id', userIds),
    admin.from('follows').select('follower_id').eq('following_id', viewerId).eq('status', 'accepted').in('follower_id', userIds)
  ])
  throwOnError(outgoing.error)
  throwOnError(incoming.error)
  const followsMe = new Set((incoming.data || []).map(row => row.follower_id))
  const statuses = new Map((outgoing.data || []).map(row => [row.following_id, row.status]))
  return new Map(userIds.map(id => [id, {
    following: statuses.get(id) === 'accepted',
    followsMe: followsMe.has(id)
  }]))
}

async function getFriendCounts(userIds: string[]) {
  if (!userIds.length) return new Map<string, number>()
  const [outgoing, incoming] = await Promise.all([
    admin.from('follows').select('follower_id,following_id').eq('status', 'accepted').in('follower_id', userIds),
    admin.from('follows').select('follower_id,following_id').eq('status', 'accepted').in('following_id', userIds)
  ])
  throwOnError(outgoing.error)
  throwOnError(incoming.error)
  const follows = new Set((incoming.data || []).map(row => `${row.follower_id}:${row.following_id}`))
  const counts = new Map(userIds.map(id => [id, 0]))
  for (const edge of outgoing.data || []) {
    if (follows.has(`${edge.following_id}:${edge.follower_id}`)) {
      counts.set(edge.follower_id, (counts.get(edge.follower_id) || 0) + 1)
    }
  }
  return counts
}

async function getLiveFriendIds(viewerId: string, hostIds: string[]): Promise<Set<string>> {
  const [following, followedBy] = await Promise.all([
    admin.from('follows').select('following_id').eq('follower_id', viewerId).eq('status', 'accepted').in('following_id', hostIds),
    admin.from('follows').select('follower_id').eq('following_id', viewerId).eq('status', 'accepted').in('follower_id', hostIds)
  ])
  throwOnError(following.error)
  throwOnError(followedBy.error)
  return new Set([
    ...(following.data || []).map(row => row.following_id),
    ...(followedBy.data || []).map(row => row.follower_id)
  ])
}

async function getLiveMutualFriendIds(viewerId: string | undefined, userIds: string[]): Promise<Set<string>> {
  if (!viewerId || !userIds.length) return new Set<string>()
  const [following, followedBy] = await Promise.all([
    admin.from('follows').select('following_id').eq('follower_id', viewerId).eq('status', 'accepted').in('following_id', userIds),
    admin.from('follows').select('follower_id').eq('following_id', viewerId).eq('status', 'accepted').in('follower_id', userIds)
  ])
  throwOnError(following.error)
  throwOnError(followedBy.error)
  const followingIds = new Set((following.data || []).map(row => row.following_id))
  const followedByIds = new Set((followedBy.data || []).map(row => row.follower_id))
  return new Set([...followingIds].filter(id => followedByIds.has(id)))
}

async function getLiveInvitedSessionIds(viewerId: string | undefined, sessionIds: string[]): Promise<Set<string>> {
  if (!viewerId || !sessionIds.length) return new Set<string>()
  const { data, error } = await admin.from('live_session_invites')
    .select('live_session_id')
    .eq('user_id', viewerId)
    .in('live_session_id', sessionIds)
  throwOnError(error)
  return new Set((data || []).map(row => row.live_session_id))
}

async function getUserSummaries(userIds: string[], withCounts = true, viewerId?: string) {
  if (!userIds.length) return new Map()
  const { data: users, error } = await admin.from('users')
    .select('id,username,display_name,avatar_url,is_private')
    .in('id', userIds)
  throwOnError(error)
  const { data: rawLiveSessions, error: liveError } = await admin.from('live_sessions')
    .select('id,host_id,title,viewer_count,visibility')
    .in('host_id', userIds)
    .eq('is_active', true)
    .gte('last_heartbeat', new Date(Date.now() - 90_000).toISOString())
    .order('created_at', { ascending: false })
  throwOnError(liveError)
  const friendsOnlyHosts = [...new Set((rawLiveSessions || []).filter(s => s.visibility === 'friends' && s.host_id !== viewerId).map(s => s.host_id))]
  const allowedFriendHosts = viewerId && friendsOnlyHosts.length ? await getLiveFriendIds(viewerId, friendsOnlyHosts) : new Set<string>()
  const selectedSessionIds = (rawLiveSessions || []).filter(s => s.visibility === 'selected' && s.host_id !== viewerId).map(s => s.id)
  const selectedHostIds = [...new Set((rawLiveSessions || []).filter(s => s.visibility === 'selected' && s.host_id !== viewerId).map(s => s.host_id))]
  const allowedSelectedSessions = await getLiveInvitedSessionIds(viewerId, selectedSessionIds)
  const selectedFriendHosts = await getLiveMutualFriendIds(viewerId, selectedHostIds)
  const liveSessions = (rawLiveSessions || []).filter(s => s.visibility === 'public'
    || s.host_id === viewerId
    || (s.visibility === 'friends' && allowedFriendHosts.has(s.host_id))
    || (s.visibility === 'selected' && allowedSelectedSessions.has(s.id) && selectedFriendHosts.has(s.host_id)))
  const liveByHost = new Map<string, NonNullable<typeof liveSessions>[number]>()
  for (const session of liveSessions || []) {
    if (!liveByHost.has(session.host_id)) liveByHost.set(session.host_id, session)
  }
  let followerCounts = new Map<string, number>()
  let friendCounts = new Map<string, number>()
  if (withCounts) {
    const followerCountEntries: Array<readonly [string, number]> = []
    for (let start = 0; start < userIds.length; start += 25) {
      const batch = userIds.slice(start, start + 25)
      const results = await Promise.all(batch.map(async id => {
        const { count, error: countError } = await admin.from('follows')
          .select('follower_id', { count: 'exact', head: true })
          .eq('following_id', id)
          .eq('status', 'accepted')
        throwOnError(countError)
        return [id, count || 0] as const
      }))
      followerCountEntries.push(...results)
    }
    followerCounts = new Map(followerCountEntries)
    friendCounts = await getFriendCounts(userIds)
  }
  return new Map((users || []).map(user => [user.id, {
    ...user,
    followers_count: followerCounts.get(user.id) || 0,
    friends_count: friendCounts.get(user.id) || 0,
    live_session_id: liveByHost.get(user.id)?.id || null,
    live_title: liveByHost.get(user.id)?.title || null,
    viewer_count: liveByHost.get(user.id)?.viewer_count || 0,
    is_live: liveByHost.has(user.id)
  }]))
}

function canViewPost(
  post: { user_id: string; privacy: string | null },
  owner: { is_private: boolean | null; posts_privacy: string | null },
  viewerId: string,
  friends: Set<string>
): boolean {
  if (post.user_id === viewerId) return true

  const isFriend = friends.has(post.user_id)
  // Private accounts' posts are publicly visible by product decision; only posts_privacy and per-post privacy restrict them.
  const accountAllowsPost = owner.posts_privacy !== 'only_me'
    && (owner.posts_privacy !== 'friends' || isFriend)
  if (!accountAllowsPost) return false

  const privacy = post.privacy || 'everyone'
  return privacy === 'everyone' || (privacy === 'friends' && isFriend)
}

async function getPostContext(postId: string, viewerId: string) {
  const { data: post, error: postError } = await admin
    .from('posts')
    .select('id,user_id,media_url,privacy')
    .eq('id', postId)
    .maybeSingle()
  throwOnError(postError)
  if (!post) return null

  const [{ data: owner, error: ownerError }, friends, blocked] = await Promise.all([
    admin.from('users').select('id,is_private,posts_privacy').eq('id', post.user_id).maybeSingle(),
    getAcceptedConnections(viewerId),
    getBlockedIds(viewerId)
  ])
  throwOnError(ownerError)
  if (blocked.has(post.user_id)) return null
  if (!owner || !canViewPost(post, owner, viewerId, friends)) return null
  return { post, owner }
}

function canViewStory(
  story: { user_id: string; privacy: string | null },
  owner: { is_private: boolean | null },
  viewerId: string,
  friends: Set<string>
): boolean {
  if (story.user_id === viewerId) return true
  const isFriend = friends.has(story.user_id)
  const privacy = story.privacy || 'everyone'
  return privacy !== 'only_me' && ((privacy === 'everyone' && (!owner.is_private || isFriend)) || isFriend)
}

async function getStoryContext(storyId: string, viewerId: string) {
  const { data: story, error: storyError } = await admin.from('stories')
    .select('id,user_id,media_url,privacy,expires_at')
    .eq('id', storyId)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()
  throwOnError(storyError)
  if (!story) return null

  const [{ data: owner, error: ownerError }, friends, blocked] = await Promise.all([
    admin.from('users').select('id,is_private').eq('id', story.user_id).maybeSingle(),
    getAcceptedConnections(viewerId),
    getBlockedIds(viewerId)
  ])
  throwOnError(ownerError)
  if (blocked.has(story.user_id)) return null
  if (!owner || !canViewStory(story, owner, viewerId, friends)) return null
  return { story, owner }
}

async function updatePostCount(postId: string, column: 'likes_count' | 'comments_count') {
  const { count, error: countError } = await admin
    .from(column === 'likes_count' ? 'likes' : 'comments')
    .select(column === 'likes_count' ? 'post_id' : 'id', { count: 'exact', head: true })
    .eq('post_id', postId)
  throwOnError(countError)
  const { error } = await admin.from('posts').update({ [column]: count || 0 }).eq('id', postId)
  throwOnError(error)
}

async function handleUsers(request: Request, viewerId: string, headers: Record<string, string>) {
  const url = new URL(request.url)
  const pathSegments = url.pathname.split('/').filter(Boolean)
  const functionIndex = pathSegments.indexOf('vynzo-api')
  const endpointSegments = functionIndex >= 0 ? pathSegments.slice(functionIndex + 1) : pathSegments
  if (endpointSegments[0] === 'api') endpointSegments.shift()
  const route = `/${endpointSegments.join('/')}`
  const method = request.method

  if (route === '/users/me/profile' && method === 'PATCH') {
    const body = await request.json()
    const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : ''
    const bio = typeof body?.bio === 'string' ? body.bio.trim() : ''
    if (!isValidUsername(username)) {
      const { data: currentUser, error: currentUserError } = await admin.from('users')
        .select('username')
        .eq('id', viewerId)
        .maybeSingle()
      throwOnError(currentUserError)
      if (currentUser?.username?.toLowerCase() !== username) {
        return jsonResponse(400, { error: 'Username must be 2–30 characters and use only letters, numbers, emoji, periods, underscores, and hyphens.' }, headers)
      }
    }
    if (bio.length > 500) return jsonResponse(400, { error: 'Bio must be 500 characters or fewer.' }, headers)
    if (violatesGuidelines(bio, username)) return jsonResponse(422, { error: GUIDELINES_MESSAGE, code: 'guidelines' }, headers)
    const { data: user, error } = await admin.from('users').update({ username, bio, updated_at: new Date().toISOString() })
      .eq('id', viewerId)
      .select('id,username,email,display_name,bio,avatar_url')
      .maybeSingle()
    if (error?.code === '23505') return jsonResponse(409, { error: 'That username is already in use.' }, headers)
    throwOnError(error)
    if (!user) return jsonResponse(404, { error: 'Account not found' }, headers)
    return jsonResponse(200, { user }, headers)
  }

  if (route === '/users/me/privacy' && method === 'PATCH') {
    const body = await request.json()
    const updates: Record<string, unknown> = {}
    const privacyValues = ['everyone', 'friends', 'only_me']
    if (body?.is_private !== undefined) {
      if (typeof body.is_private !== 'boolean') return jsonResponse(400, { error: 'is_private must be true or false.' }, headers)
      updates.is_private = body.is_private
    }
    if (body?.message_privacy !== undefined) {
      if (!['everyone', 'friends', 'nobody'].includes(body.message_privacy)) return jsonResponse(400, { error: 'message_privacy must be everyone, friends or nobody.' }, headers)
      updates.message_privacy = body.message_privacy
    }
    if (body?.allow_calls !== undefined) {
      if (typeof body.allow_calls !== 'boolean') return jsonResponse(400, { error: 'allow_calls must be true or false.' }, headers)
      updates.allow_calls = body.allow_calls
    }
    for (const key of ['posts_privacy', 'following_privacy']) {
      if (body?.[key] !== undefined) {
        if (!privacyValues.includes(body[key])) return jsonResponse(400, { error: `${key} must be everyone, friends or only_me.` }, headers)
        updates[key] = body[key]
      }
    }
    if (body?.read_receipts !== undefined) {
      if (typeof body.read_receipts !== 'boolean') return jsonResponse(400, { error: 'read_receipts must be true or false.' }, headers)
      updates.read_receipts = body.read_receipts
    }
    if (!Object.keys(updates).length) return jsonResponse(400, { error: 'Nothing to update.' }, headers)
    updates.updated_at = new Date().toISOString()
    const { data: user, error } = await admin.from('users').update(updates).eq('id', viewerId)
      .select('id,is_private,message_privacy,allow_calls,posts_privacy,following_privacy,read_receipts')
      .maybeSingle()
    throwOnError(error)
    if (!user) return jsonResponse(404, { error: 'Account not found' }, headers)
    const { id: _id, ...privacy } = user
    return jsonResponse(200, privacy, headers)
  }

  if (route === '/users/me/avatar' && method === 'PUT') {
    const form = await request.formData()
    const file = form.get('avatar')
    if (!(file instanceof File) || file.size === 0) return jsonResponse(400, { error: 'Choose a profile photo to upload.' }, headers)
    if (file.size > 10 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
      return jsonResponse(400, { error: 'Choose a supported image up to 10 MB.' }, headers)
    }
    const extension = file.name.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0] || ''
    const path = `${viewerId}/avatars/${crypto.randomUUID()}${extension}`
    const { error: uploadError } = await admin.storage.from('uploads').upload(path, file, { contentType: file.type, upsert: false })
    throwOnError(uploadError)
    const avatarUrl = admin.storage.from('uploads').getPublicUrl(path).data.publicUrl
    const { data: user, error } = await admin.from('users').update({ avatar_url: avatarUrl, updated_at: new Date().toISOString() })
      .eq('id', viewerId)
      .select('id,username,email,display_name,bio,avatar_url')
      .maybeSingle()
    if (error || !user) {
      const { error: cleanupError } = await admin.storage.from('uploads').remove([path])
      if (cleanupError) console.error('Profile avatar cleanup error:', cleanupError)
      throwOnError(error)
      return jsonResponse(404, { error: 'Account not found' }, headers)
    }
    return jsonResponse(200, { user }, headers)
  }

  if (route === '/users/friends' && method === 'GET') {
    const { data: outgoing, error } = await admin.from('follows').select('following_id')
      .eq('follower_id', viewerId).eq('status', 'accepted')
    throwOnError(error)
    const outgoingIds = (outgoing || []).map(row => row.following_id)
    const [{ data: incoming, error: incomingError }, summaries] = await Promise.all([
      outgoingIds.length
        ? admin.from('follows').select('follower_id').eq('following_id', viewerId).eq('status', 'accepted').in('follower_id', outgoingIds)
        : Promise.resolve({ data: [], error: null }),
      getUserSummaries(outgoingIds, false, viewerId)
    ])
    throwOnError(incomingError)
    const friendIds = new Set((incoming || []).map(row => row.follower_id))
    const friends = outgoingIds.filter(id => friendIds.has(id)).map(id => summaries.get(id))
      .sort((a, b) => String(a.display_name || a.username).localeCompare(String(b.display_name || b.username)))
    return jsonResponse(200, { friends }, headers)
  }

  if (route === '/users/connections' && method === 'GET') {
    const type = url.searchParams.get('type') === 'followers' ? 'followers' : 'friends'
    const { data: incoming, error } = await admin.from('follows').select('follower_id')
      .eq('following_id', viewerId).eq('status', 'accepted').limit(200)
    throwOnError(error)
    const candidateIds = (incoming || []).map(row => row.follower_id)
    const [status, summaries] = await Promise.all([
      getFollowStatus(viewerId, candidateIds),
      getUserSummaries(candidateIds, true, viewerId)
    ])
    const users = candidateIds.filter(id => type === 'followers' || status.get(id)?.following)
      .map(id => ({
        ...summaries.get(id),
        follow_status: status.get(id)?.following ? 'accepted' : null,
        follows_me: true,
        is_friend: Boolean(status.get(id)?.following),
        is_following: Boolean(status.get(id)?.following),
        follow_requested: false
      }))
      .sort((a, b) => String(a.display_name || a.username).localeCompare(String(b.display_name || b.username)))
    return jsonResponse(200, { users }, headers)
  }

  if (route === '/users/follow-requests' && method === 'GET') {
    const { data: incoming, error } = await admin.from('follows').select('follower_id,created_at')
      .eq('following_id', viewerId).eq('status', 'accepted').order('created_at', { ascending: false }).limit(50)
    throwOnError(error)
    const candidateIds = (incoming || []).map(row => row.follower_id)
    const [{ data: outgoing, error: outgoingError }, summaries] = await Promise.all([
      candidateIds.length
        ? admin.from('follows').select('following_id').eq('follower_id', viewerId).eq('status', 'accepted').in('following_id', candidateIds)
        : Promise.resolve({ data: [], error: null }),
      getUserSummaries(candidateIds, true, viewerId)
    ])
    throwOnError(outgoingError)
    const mutual = new Set((outgoing || []).map(row => row.following_id))
    const createdAt = new Map((incoming || []).map(row => [row.follower_id, row.created_at]))
    const requests = candidateIds.filter(id => !mutual.has(id)).map(id => ({
      id,
      username: summaries.get(id)?.username,
      display_name: summaries.get(id)?.display_name,
      avatar_url: summaries.get(id)?.avatar_url,
      created_at: createdAt.get(id)
    }))
    return jsonResponse(200, { requests }, headers)
  }

  if (route === '/users/search' && method === 'GET') {
    const query = (url.searchParams.get('q') || '').trim()
    if (query.length < 2 || query.length > 50) return jsonResponse(400, { error: 'Search must be between 2 and 50 characters' }, headers)
    const escaped = query.replace(/[\\%_]/g, character => `\\${character}`)
    const pattern = `%${escaped}%`
    const [usernameResults, displayNameResults, blockedIds] = await Promise.all([
      admin.from('users').select('id,username,display_name,avatar_url,is_private')
        .neq('id', viewerId).ilike('username', pattern).limit(40),
      admin.from('users').select('id,username,display_name,avatar_url,is_private')
        .neq('id', viewerId).ilike('display_name', pattern).limit(40),
      getBlockedIds(viewerId)
    ])
    throwOnError(usernameResults.error)
    throwOnError(displayNameResults.error)
    const users = [...new Map([
      ...(usernameResults.data || []),
      ...(displayNameResults.data || [])
    ].filter(user => !blockedIds.has(user.id)).map(user => [user.id, user])).values()].slice(0, 20)
    const ids = (users || []).map(user => user.id)
    const [followStatus, summaries] = await Promise.all([getFollowStatus(viewerId, ids), getUserSummaries(ids, true, viewerId)])
    const results = ids.map(id => {
      const user = summaries.get(id)
      const relation = followStatus.get(id)
      const isFriend = Boolean(relation?.following && relation.followsMe)
      return {
        ...user,
        is_following: Boolean(relation?.following),
        follow_requested: false,
        follows_me: Boolean(relation?.followsMe),
        is_friend: isFriend
      }
    }).sort((a, b) => {
      const aMatch = String(a.username).toLowerCase().startsWith(query.toLowerCase()) ? 0 : 1
      const bMatch = String(b.username).toLowerCase().startsWith(query.toLowerCase()) ? 0 : 1
      return aMatch - bMatch || String(a.username).localeCompare(String(b.username))
    })
    return jsonResponse(200, { users: results }, headers)
  }

  const followMatch = route.match(/^\/users\/([^/]+)\/follow$/)
  if (followMatch && (method === 'POST' || method === 'DELETE')) {
    const [, targetId] = followMatch
    if (method === 'POST') {
      if (targetId === viewerId) return jsonResponse(400, { error: 'You cannot add your own account' }, headers)
      const { data: target, error: targetError } = await admin.from('users').select('id').eq('id', targetId).maybeSingle()
      throwOnError(targetError)
      if (!target) return jsonResponse(404, { error: 'Account not found' }, headers)
      const relationBlock = await getBlockRelation(viewerId, targetId)
      if (relationBlock.blockedByMe || relationBlock.blockedMe) {
        return jsonResponse(403, { error: relationBlock.blockedByMe ? 'Unblock this account first.' : 'You cannot follow this account.' }, headers)
      }
      const { error } = await admin.from('follows').upsert(
        { follower_id: viewerId, following_id: targetId, status: 'accepted' },
        { onConflict: 'follower_id,following_id' }
      )
      throwOnError(error)
      const relation = await getFollowStatus(viewerId, [targetId])
      const value = relation.get(targetId)!
      return jsonResponse(200, {
        is_following: value.following,
        follow_requested: false,
        is_friend: value.following && value.followsMe
      }, headers)
    }
    const { error } = await admin.from('follows').delete().eq('follower_id', viewerId).eq('following_id', targetId)
    throwOnError(error)
    return jsonResponse(200, { is_following: false, follow_requested: false, is_friend: false }, headers)
  }

  const profileMatch = route.match(/^\/users\/([^/]+)\/profile$/)
  if (profileMatch && method === 'GET') {
    const [, targetId] = profileMatch
    const { data: user, error } = await admin.from('users')
      .select('id,username,display_name,bio,avatar_url,is_private,is_verified,created_at,message_privacy,allow_calls,posts_privacy,following_privacy,read_receipts')
      .eq('id', targetId)
      .maybeSingle()
    throwOnError(error)
    if (!user) return jsonResponse(404, { error: 'Account not found' }, headers)
    const isOwner = viewerId === targetId
    if (!isOwner) {
      const blockState = await getBlockRelation(viewerId, targetId)
      if (blockState.blockedMe) return jsonResponse(404, { error: 'Account not found' }, headers)
      if (blockState.blockedByMe) {
        return jsonResponse(200, {
          profile: {
            id: user.id,
            username: user.username,
            display_name: user.display_name,
            avatar_url: user.avatar_url,
            is_owner: false,
            is_blocked: true,
            is_following: false,
            follows_me: false,
            follow_requested: false,
            is_friend: false,
            can_message: false,
            message_block_reason: 'You blocked this account.',
            can_view_content: false,
            posts_count: null,
            followers_count: 0,
            friends_count: 0,
            following_count: null
          },
          posts: []
        }, headers)
      }
    }
    const [identifierResult, relation] = await Promise.all([
      isOwner
        ? admin.rpc('get_vynzo_id', { target_user_id: targetId })
        : Promise.resolve({ data: null, error: null }),
      getFollowStatus(viewerId, [targetId])
    ])
    throwOnError(identifierResult.error)
    const vynzoId = identifierResult.data
    const followerCount = admin.from('follows').select('follower_id', { count: 'exact', head: true }).eq('following_id', targetId).eq('status', 'accepted')
    const followingCount = admin.from('follows').select('following_id', { count: 'exact', head: true }).eq('follower_id', targetId).eq('status', 'accepted')
    const postCount = admin.from('posts').select('id', { count: 'exact', head: true }).eq('user_id', targetId)
    const [followers, following, postsResult] = await Promise.all([followerCount, followingCount, postCount])
    throwOnError(followers.error)
    throwOnError(following.error)
    throwOnError(postsResult.error)
    const follow = relation.get(targetId)!
    const isFriend = follow.following && follow.followsMe
    const postsPrivacy = user.posts_privacy || 'everyone'
    const canViewPosts = isOwner || (postsPrivacy === 'friends' && isFriend)
      || (postsPrivacy === 'everyone' && (!user.is_private || isFriend))
    const followingPrivacy = user.following_privacy || 'everyone'
    const canViewFollowing = isOwner || followingPrivacy === 'everyone'
      || (followingPrivacy === 'friends' && isFriend)
    let messageBlock: string | null = null
    if (!isOwner) {
      const [viewerBlock, targetBlock, { data: setting, error: settingError }] = await Promise.all([
        admin.from('blocks').select('blocker_id').eq('blocker_id', viewerId).eq('blocked_id', targetId).maybeSingle(),
        admin.from('blocks').select('blocker_id').eq('blocker_id', targetId).eq('blocked_id', viewerId).maybeSingle(),
        admin.from('users').select('message_privacy').eq('id', targetId).maybeSingle()
      ])
      throwOnError(viewerBlock.error)
      throwOnError(targetBlock.error)
      throwOnError(settingError)
      if (viewerBlock.data || targetBlock.data) messageBlock = 'This account has blocked messaging.'
      else if (setting?.message_privacy === 'nobody') messageBlock = 'This person is not accepting messages.'
      else if (setting?.message_privacy === 'friends' && !isFriend) messageBlock = 'This person only accepts messages from friends.'
    }
    let visiblePosts: Record<string, unknown>[] = []
    if (canViewPosts) {
      const { data: userPosts, error: postsError } = await admin.from('posts')
        .select('id,user_id,caption,media_type,media_url,created_at,likes_count,comments_count,is_protected,privacy')
        .eq('user_id', targetId).order('created_at', { ascending: false }).limit(100)
      throwOnError(postsError)
      const postIds = (userPosts || []).map(post => post.id)
      const { data: likes, error: likesError } = postIds.length
        ? await admin.from('likes').select('post_id').eq('user_id', viewerId).in('post_id', postIds)
        : { data: [], error: null }
      throwOnError(likesError)
      const likedIds = new Set((likes || []).map(row => row.post_id))
      visiblePosts = (userPosts || []).filter(post => post.user_id === viewerId
        || (post.privacy !== 'only_me' && (post.privacy !== 'friends' || isFriend)))
        .map(post => ({ ...post, is_owner: post.user_id === viewerId, is_liked: likedIds.has(post.id) }))
    }
    const { data: liveRaw, error: liveError } = await admin.from('live_sessions')
      .select('id,title,visibility').eq('host_id', targetId).eq('is_active', true).gte('last_heartbeat', new Date(Date.now() - 90_000).toISOString()).order('created_at', { ascending: false }).limit(1).maybeSingle()
    throwOnError(liveError)
    const invitedLiveSessions = liveRaw?.visibility === 'selected'
      ? await getLiveInvitedSessionIds(viewerId, [liveRaw.id])
      : new Set<string>()
    const live = liveRaw && (liveRaw.visibility === 'public'
      || isOwner
      || (liveRaw.visibility === 'friends' && isFriend)
      || (liveRaw.visibility === 'selected' && invitedLiveSessions.has(liveRaw.id)))
      ? liveRaw
      : null
    let likeStats: Record<string, number> | undefined
    {
      const [storiesResult, imagePostsResult, videoPostsResult, blogsResult] = await Promise.all([
        isOwner ? admin.from('stories').select('id').eq('user_id', targetId) : Promise.resolve({ data: [], error: null }),
        admin.from('posts').select('id').eq('user_id', targetId).eq('media_type', 'image'),
        admin.from('posts').select('id').eq('user_id', targetId).eq('media_type', 'video'),
        admin.from('blog_articles').select('id').eq('author_id', targetId)
      ])
      throwOnError(storiesResult.error)
      throwOnError(imagePostsResult.error)
      throwOnError(videoPostsResult.error)
      throwOnError(blogsResult.error)
      const [storyLikes, imageLikes, videoLikes, blogLikes] = await Promise.all([
        storiesResult.data?.length
          ? admin.from('story_likes').select('story_id', { count: 'exact', head: true }).in('story_id', storiesResult.data.map(row => row.id))
          : Promise.resolve({ count: 0, error: null }),
        imagePostsResult.data?.length
          ? admin.from('likes').select('post_id', { count: 'exact', head: true }).in('post_id', imagePostsResult.data.map(row => row.id))
          : Promise.resolve({ count: 0, error: null }),
        videoPostsResult.data?.length
          ? admin.from('likes').select('post_id', { count: 'exact', head: true }).in('post_id', videoPostsResult.data.map(row => row.id))
          : Promise.resolve({ count: 0, error: null }),
        blogsResult.data?.length
          ? admin.from('blog_likes').select('article_id', { count: 'exact', head: true }).in('article_id', blogsResult.data.map(row => row.id))
          : Promise.resolve({ count: 0, error: null })
      ])
      throwOnError(storyLikes.error)
      throwOnError(imageLikes.error)
      throwOnError(videoLikes.error)
      throwOnError(blogLikes.error)
      const stories = storyLikes.count || 0
      const images = imageLikes.count || 0
      const videos = videoLikes.count || 0
      const blogs = blogLikes.count || 0
      likeStats = { stories, images, videos, blogs, total: stories + images + videos + blogs }
    }
    return jsonResponse(200, {
      profile: {
        id: user.id,
        is_live: Boolean(live),
        live_session_id: live?.id || null,
        live_title: live?.title || null,
        username: user.username,
        ...(isOwner ? { vynzo_id: vynzoId } : {}),
        display_name: user.display_name,
        bio: user.bio,
        avatar_url: user.avatar_url,
        is_private: user.is_private,
        ...(isOwner ? {
          message_privacy: user.message_privacy,
          allow_calls: user.allow_calls,
          posts_privacy: postsPrivacy,
          following_privacy: followingPrivacy,
          read_receipts: user.read_receipts !== false
        } : {}),
        can_message: !messageBlock,
        message_block_reason: messageBlock,
        is_verified: user.is_verified,
        created_at: user.created_at,
        is_owner: isOwner,
        is_following: follow.following,
        follows_me: follow.followsMe,
        follow_requested: false,
        is_friend: isFriend,
        can_view_content: canViewPosts,
        posts_count: canViewPosts ? (postsResult.count || 0) : null,
        followers_count: followers.count || 0,
        friends_count: (await getFriendCounts([targetId])).get(targetId) || 0,
        following_count: canViewFollowing ? following.count || 0 : null,
        ...(likeStats ? { like_stats: likeStats } : {})
      },
      posts: visiblePosts
    }, headers)
  }

  return jsonResponse(404, { error: 'Endpoint not found' }, headers)
}

async function handleModeration(request: Request, viewerId: string, headers: Record<string, string>) {
  const url = new URL(request.url)
  const pathSegments = url.pathname.split('/').filter(Boolean)
  const functionIndex = pathSegments.indexOf('vynzo-api')
  const endpointSegments = functionIndex >= 0 ? pathSegments.slice(functionIndex + 1) : pathSegments
  if (endpointSegments[0] === 'api') endpointSegments.shift()
  const route = `/${endpointSegments.join('/')}`
  if (route === '/moderation/report' && request.method === 'POST') {
    const body = await request.json()
    const targetType = String(body?.target_type || '')
    const targetId = String(body?.target_id || '')
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
    if (!targetType || !targetId || !reason) {
      return jsonResponse(400, { error: 'Target type, target ID, and reason are required' }, headers)
    }
    if (reason.length > 2000) return jsonResponse(400, { error: 'Reason must be 2000 characters or fewer.' }, headers)
    if (!/^[a-z_]{1,30}$/i.test(targetType) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetId)) {
      return jsonResponse(400, { error: 'Invalid report target.' }, headers)
    }
    const { count: existingReports, error: existingError } = await admin.from('reports')
      .select('id', { count: 'exact', head: true })
      .eq('reporter_id', viewerId).eq('target_type', targetType).eq('target_id', targetId)
    throwOnError(existingError)
    if ((existingReports || 0) > 0) return jsonResponse(429, { error: 'You already reported this.' }, headers)
    const { data: report, error } = await admin.from('reports')
      .insert({ reporter_id: viewerId, target_type: targetType, target_id: targetId, reason })
      .select('id,target_type,target_id,status,created_at').single()
    throwOnError(error)
    return jsonResponse(201, {
      message: 'Report submitted successfully. Our moderation team will review it.',
      report
    }, headers)
  }
  const blockMatch = route.match(/^\/moderation\/block\/([^/]+)$/)
  if (blockMatch && request.method === 'POST') {
    const blockedId = blockMatch[1]
    if (blockedId === viewerId) return jsonResponse(400, { error: 'You cannot block yourself' }, headers)
    const { data: target, error: targetError } = await admin.from('users').select('id').eq('id', blockedId).maybeSingle()
    throwOnError(targetError)
    if (!target) return jsonResponse(404, { error: 'Account not found' }, headers)
    const { error } = await admin.from('blocks').upsert(
      { blocker_id: viewerId, blocked_id: blockedId },
      { onConflict: 'blocker_id,blocked_id', ignoreDuplicates: true }
    )
    throwOnError(error)
    await Promise.all([
      admin.from('follows').delete().eq('follower_id', viewerId).eq('following_id', blockedId),
      admin.from('follows').delete().eq('follower_id', blockedId).eq('following_id', viewerId)
    ])
    return jsonResponse(200, { message: 'User blocked successfully', is_blocked: true }, headers)
  }
  if (blockMatch && request.method === 'DELETE') {
    const { error } = await admin.from('blocks').delete().eq('blocker_id', viewerId).eq('blocked_id', blockMatch[1])
    throwOnError(error)
    return jsonResponse(200, { message: 'User unblocked', is_blocked: false }, headers)
  }
  if (route === '/moderation/blocks' && request.method === 'GET') {
    const { data, error } = await admin.from('blocks').select('blocked_id').eq('blocker_id', viewerId)
    throwOnError(error)
    const ids = (data || []).map(row => row.blocked_id)
    const summaries = await getUserSummaries(ids, false, viewerId)
    return jsonResponse(200, { users: ids.map(id => summaries.get(id)).filter(Boolean) }, headers)
  }
  return jsonResponse(404, { error: 'Endpoint not found' }, headers)
}

async function handleStories(request: Request, viewerId: string, headers: Record<string, string>) {
  const url = new URL(request.url)
  const pathSegments = url.pathname.split('/').filter(Boolean)
  const functionIndex = pathSegments.indexOf('vynzo-api')
  const endpointSegments = functionIndex >= 0 ? pathSegments.slice(functionIndex + 1) : pathSegments
  if (endpointSegments[0] === 'api') endpointSegments.shift()
  const route = `/${endpointSegments.join('/')}`
  const method = request.method

  if (route === '/stories' && method === 'GET') {
    const scope = url.searchParams.get('scope') || 'following'
    const [friends, followsResult] = await Promise.all([
      scope === 'me' ? Promise.resolve(new Set<string>()) : getAcceptedConnections(viewerId),
      scope === 'me' || scope === 'all' || scope === 'any'
        ? Promise.resolve({ data: [], error: null })
        : admin.from('follows').select('following_id')
          .eq('follower_id', viewerId)
          .eq('status', 'accepted')
    ])
    throwOnError(followsResult.error)
    const followedIds = new Set((followsResult.data || []).map(row => row.following_id))
    let query = admin.from('stories')
      .select('id,user_id,media_type,media_url,is_protected,privacy,created_at,expires_at')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: true })
      .range(0, 999)
    if (scope === 'me') query = query.eq('user_id', viewerId)
    else if (scope === 'all') query = query.neq('user_id', viewerId)
    else if (scope !== 'any') {
      if (!followedIds.size) return jsonResponse(200, { usersWithStories: [], viewer_is_admin: false }, headers)
      query = query.in('user_id', [...followedIds])
    }

    const [{ data: stories, error }, { data: viewer, error: viewerError }, blockedIds] = await Promise.all([
      query,
      admin.from('users').select('is_admin').eq('id', viewerId).maybeSingle(),
      getBlockedIds(viewerId)
    ])
    throwOnError(error)
    throwOnError(viewerError)
    const userIds = [...new Set((stories || []).map(story => story.user_id))].filter(id => !blockedIds.has(id))
    const { data: users, error: usersError } = userIds.length
      ? await admin.from('users').select('id,username,display_name,avatar_url,is_private').in('id', userIds)
      : { data: [], error: null }
    throwOnError(usersError)
    const visibleUsers = new Map((users || []).map(user => [user.id, user]))
    const visibleStories = (stories || []).filter(story => {
      const owner = visibleUsers.get(story.user_id)
      return owner && canViewStory(story, owner, viewerId, friends)
    })
    const storyIds = visibleStories.map(story => story.id)
    const [likes, comments, ownLikes] = storyIds.length
      ? await Promise.all([
        admin.from('story_likes').select('story_id').in('story_id', storyIds),
        admin.from('story_comments').select('story_id').in('story_id', storyIds),
        admin.from('story_likes').select('story_id').eq('user_id', viewerId).in('story_id', storyIds)
      ])
      : [
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null }
      ]
    throwOnError(likes.error)
    throwOnError(comments.error)
    throwOnError(ownLikes.error)
    const likeCounts = new Map<string, number>()
    const commentCounts = new Map<string, number>()
    for (const row of likes.data || []) likeCounts.set(row.story_id, (likeCounts.get(row.story_id) || 0) + 1)
    for (const row of comments.data || []) commentCounts.set(row.story_id, (commentCounts.get(row.story_id) || 0) + 1)
    const likedIds = new Set((ownLikes.data || []).map(row => row.story_id))
    const groups = new Map<string, Record<string, unknown> & { stories: Record<string, unknown>[] }>()
    for (const story of visibleStories) {
      const owner = visibleUsers.get(story.user_id)!
      if (!groups.has(story.user_id)) {
        groups.set(story.user_id, {
          user_id: owner.id,
          username: owner.username,
          display_name: owner.display_name,
          avatar_url: owner.avatar_url,
          stories: []
        })
      }
      groups.get(story.user_id)!.stories.push({
        id: story.id,
        media_type: story.media_type,
        media_url: story.media_url,
        is_protected: story.is_protected,
        privacy: story.privacy || 'everyone',
        created_at: story.created_at,
        expires_at: story.expires_at,
        likes_count: likeCounts.get(story.id) || 0,
        comments_count: commentCounts.get(story.id) || 0,
        is_liked: likedIds.has(story.id),
        is_owner: viewerId === story.user_id
      })
    }
    return jsonResponse(200, { usersWithStories: [...groups.values()], viewer_is_admin: Boolean(viewer?.is_admin) }, headers)
  }

  if (route === '/stories/upload' && method === 'POST') {
    const form = await request.formData()
    const file = form.get('media')
    if (!(file instanceof File) || file.size === 0) {
      return jsonResponse(400, { error: 'Media file is required for a story' }, headers)
    }
    if (file.size > 50 * 1024 * 1024 || !allowedMediaTypes.has(file.type)) {
      return jsonResponse(400, { error: 'Choose a supported image or video file up to 50 MB.' }, headers)
    }
    const extension = file.name.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0] || ''
    const path = `${viewerId}/${crypto.randomUUID()}${extension}`
    const { error: uploadError } = await admin.storage.from('uploads').upload(path, file, {
      contentType: file.type,
      upsert: false
    })
    throwOnError(uploadError)
    const mediaUrl = admin.storage.from('uploads').getPublicUrl(path).data.publicUrl
    const { data: story, error } = await admin.from('stories').insert({
      user_id: viewerId,
      media_type: file.type.startsWith('video/') ? 'video' : 'image',
      media_url: mediaUrl,
      is_protected: ['true', '1', 'on'].includes(String(form.get('protected') || '').toLowerCase()),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    }).select('id,user_id,media_type,media_url,is_protected,expires_at,created_at').single()
    if (error) {
      const { error: cleanupError } = await admin.storage.from('uploads').remove([path])
      if (cleanupError) console.error('Failed to clean up uploaded media after story creation failed:', cleanupError)
      throw new Error(error.message)
    }
    return jsonResponse(201, { message: 'Story published successfully', story }, headers)
  }

  const storyMatch = route.match(/^\/stories\/([^/]+)(?:\/(view|like|comments|privacy))?$/)
  const moderateMatch = route.match(/^\/stories\/([^/]+)\/moderate$/)
  if (moderateMatch && method === 'POST') {
    const { data: viewer, error: viewerError } = await admin.from('users').select('is_admin').eq('id', viewerId).maybeSingle()
    throwOnError(viewerError)
    if (!viewer?.is_admin) return jsonResponse(403, { error: 'Administrator access required' }, headers)
    const storyId = moderateMatch[1]
    const { data: story, error: storyError } = await admin.from('stories')
      .select('id,user_id,media_type,media_url')
      .eq('id', storyId)
      .maybeSingle()
    throwOnError(storyError)
    if (!story) return jsonResponse(404, { error: 'Story not found' }, headers)
    const body = await request.json()
    const reason = typeof body?.reason === 'string' && body.reason.trim()
      ? body.reason.trim().slice(0, 300)
      : 'it violates the Vynzo community guidelines'
    const { error: deleteError } = await admin.from('stories').delete().eq('id', storyId)
    throwOnError(deleteError)
    const { error: logError } = await admin.from('story_moderation_logs').insert({
      user_id: story.user_id,
      actor_id: viewerId,
      media_type: story.media_type,
      action: 'admin_removed',
      reason
    })
    if (logError) console.error('Story moderation log failed:', logError)
    const path = storagePath(story.media_url)
    if (path) {
      const { error: storageError } = await admin.storage.from('uploads').remove([path])
      if (storageError) console.error('Moderated story media cleanup error:', storageError)
    }
    return jsonResponse(200, { success: true }, headers)
  }
  if (!storyMatch) return jsonResponse(404, { error: 'Endpoint not found' }, headers)
  const [, storyId, action] = storyMatch
  if (!action && method === 'DELETE') {
    const { data: story, error } = await admin.from('stories')
      .select('id,media_url')
      .eq('id', storyId)
      .eq('user_id', viewerId)
      .maybeSingle()
    throwOnError(error)
    if (!story) return jsonResponse(404, { error: 'Story not found or you do not own it' }, headers)
    const { error: deleteError } = await admin.from('stories').delete().eq('id', storyId).eq('user_id', viewerId)
    throwOnError(deleteError)
    const path = storagePath(story.media_url)
    if (path) {
      const { error: storageError } = await admin.storage.from('uploads').remove([path])
      if (storageError) console.error('Deleted story media cleanup error:', storageError)
    }
    return jsonResponse(200, { success: true }, headers)
  }

  const context = await getStoryContext(storyId, viewerId)
  if (!context) return jsonResponse(403, { error: 'This story is unavailable or private.' }, headers)

  if (action === 'privacy' && method === 'PATCH') {
    if (context.story.user_id !== viewerId) return jsonResponse(403, { error: 'Only the story owner can change privacy.' }, headers)
    const body = await request.json()
    const privacy = String(body?.privacy || '')
    if (!['everyone', 'friends', 'only_me'].includes(privacy)) return jsonResponse(400, { error: 'Invalid privacy option' }, headers)
    const { error } = await admin.from('stories').update({ privacy }).eq('id', storyId).eq('user_id', viewerId)
    throwOnError(error)
    return jsonResponse(200, { success: true, privacy }, headers)
  }

  if (action === 'view' && method === 'POST') {
    const { error } = await admin.from('story_views').upsert(
      { story_id: storyId, user_id: viewerId },
      { onConflict: 'story_id,user_id', ignoreDuplicates: true }
    )
    throwOnError(error)
    return jsonResponse(200, { success: true }, headers)
  }

  if (action === 'like' && method === 'POST') {
    const { data: existing, error } = await admin.from('story_likes')
      .select('story_id')
      .eq('story_id', storyId)
      .eq('user_id', viewerId)
      .maybeSingle()
    throwOnError(error)
    if (existing) {
      const { error: deleteError } = await admin.from('story_likes').delete().eq('story_id', storyId).eq('user_id', viewerId)
      throwOnError(deleteError)
      return jsonResponse(200, { liked: false }, headers)
    }
    const { error: insertError } = await admin.from('story_likes').upsert(
      { story_id: storyId, user_id: viewerId },
      { onConflict: 'story_id,user_id', ignoreDuplicates: true }
    )
    throwOnError(insertError)
    return jsonResponse(200, { liked: true }, headers)
  }

  if (action === 'comments' && method === 'GET') {
    const { data: comments, error } = await admin.from('story_comments')
      .select('id,story_id,user_id,content,created_at')
      .eq('story_id', storyId)
      .order('created_at', { ascending: true })
    throwOnError(error)
    const userIds = [...new Set((comments || []).map(comment => comment.user_id))]
    const { data: users, error: usersError } = userIds.length
      ? await admin.from('users').select('id,username,display_name').in('id', userIds)
      : { data: [], error: null }
    throwOnError(usersError)
    const userById = new Map((users || []).map(user => [user.id, user]))
    const blockedForStoryComments = await getBlockedIds(viewerId)
    return jsonResponse(200, {
      comments: (comments || []).filter(comment => !blockedForStoryComments.has(comment.user_id)).map(comment => ({
        ...comment,
        ...userById.get(comment.user_id)
      }))
    }, headers)
  }

  if (action === 'comments' && method === 'POST') {
    const body = await request.json()
    const content = typeof body?.content === 'string' ? body.content.trim() : ''
    if (!content) return jsonResponse(400, { error: 'Comment content cannot be empty' }, headers)
    if (content.length > 500) return jsonResponse(400, { error: 'Comment must be 500 characters or fewer' }, headers)
    if (violatesGuidelines(content)) return jsonResponse(422, { error: GUIDELINES_MESSAGE, code: 'guidelines' }, headers)
    const { data: comment, error } = await admin.from('story_comments')
      .insert({ story_id: storyId, user_id: viewerId, content })
      .select('id,story_id,user_id,content,created_at')
      .single()
    throwOnError(error)
    const { data: user, error: userError } = await admin.from('users')
      .select('username,display_name')
      .eq('id', viewerId)
      .single()
    throwOnError(userError)
    return jsonResponse(201, { comment: { ...comment, ...user } }, headers)
  }

  return jsonResponse(404, { error: 'Endpoint not found' }, headers)
}

function storagePath(mediaUrl: string): string | null {
  try {
    const url = new URL(mediaUrl)
    const prefix = '/storage/v1/object/public/uploads/'
    if (url.pathname.startsWith(prefix)) return decodeURIComponent(url.pathname.slice(prefix.length))
  } catch {
    if (mediaUrl.startsWith('/uploads/')) return mediaUrl.slice('/uploads/'.length)
  }
  return null
}

async function handlePosts(request: Request, viewerId: string, headers: Record<string, string>) {
  const url = new URL(request.url)
  const pathSegments = url.pathname.split('/').filter(Boolean)
  const functionIndex = pathSegments.indexOf('vynzo-api')
  const endpointSegments = functionIndex >= 0 ? pathSegments.slice(functionIndex + 1) : pathSegments
  if (endpointSegments[0] === 'api') endpointSegments.shift()
  const route = `/${endpointSegments.join('/')}`
  const method = request.method

  if (route === '/posts/feed' && method === 'GET') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 10, 1), 50)
    const offset = Math.min(Math.max(Number(url.searchParams.get('offset')) || 0, 0), 999)
    const scope = url.searchParams.get('scope') || 'following'
    const [friends, outgoing] = await Promise.all([
      scope === 'me' ? Promise.resolve(new Set<string>()) : getAcceptedConnections(viewerId),
      scope === 'me' || scope === 'all'
        ? Promise.resolve({ data: [], error: null })
        : admin.from('follows').select('following_id')
          .eq('follower_id', viewerId)
          .eq('status', 'accepted')
    ])
    throwOnError(outgoing.error)
    const followedIds = new Set((outgoing.data || []).map(row => row.following_id))

    let query = admin.from('posts')
      .select('id,user_id,caption,media_type,media_url,thumbnail_url,views_count,likes_count,comments_count,created_at,is_protected,privacy')
      .order('created_at', { ascending: false })
      .range(scope === 'me' ? offset : 0, scope === 'me' ? offset + limit - 1 : 999)
    if (scope === 'me') query = query.eq('user_id', viewerId)
    else if (scope === 'all') query = query.neq('user_id', viewerId)
    else {
      if (!followedIds.size) return jsonResponse(200, { posts: [], limit, offset }, headers)
      query = query.in('user_id', [...followedIds])
    }

    const { data: candidates, error } = await query
    throwOnError(error)
    const blockedIds = await getBlockedIds(viewerId)
    const userIds = [...new Set((candidates || []).map(post => post.user_id))].filter(id => !blockedIds.has(id))
    const { data: users, error: usersError } = userIds.length
      ? await admin.from('users').select('id,username,display_name,avatar_url,is_private,posts_privacy').in('id', userIds)
      : { data: [], error: null }
    throwOnError(usersError)
    const userById = new Map((users || []).map(user => [user.id, user]))

    const visiblePosts = (candidates || [])
      .filter(post => {
        const owner = userById.get(post.user_id)
        return owner && canViewPost(post, owner, viewerId, friends)
      })
    const pagePosts = scope === 'me' ? visiblePosts : visiblePosts.slice(offset, offset + limit)
    const postIds = pagePosts.map(post => post.id)
    const { data: likedRows, error: likesError } = postIds.length
      ? await admin.from('likes').select('post_id').eq('user_id', viewerId).in('post_id', postIds)
      : { data: [], error: null }
    throwOnError(likesError)
    const likedIds = new Set((likedRows || []).map(row => row.post_id))

    return jsonResponse(200, {
      posts: pagePosts.map(post => {
        const owner = userById.get(post.user_id)!
        return {
          ...post,
          is_owner: post.user_id === viewerId,
          is_liked: likedIds.has(post.id),
          author_id: owner.id,
          author_username: owner.username,
          author_display_name: owner.display_name,
          author_avatar_url: owner.avatar_url
        }
      }),
      limit,
      offset
    }, headers)
  }

  if (route === '/posts/upload' && method === 'POST') {
    const form = await request.formData()
    const file = form.get('media')
    if (!(file instanceof File) || file.size === 0) {
      return jsonResponse(400, { error: 'Media file is required' }, headers)
    }
    if (file.size > 50 * 1024 * 1024 || !allowedMediaTypes.has(file.type)) {
      return jsonResponse(400, { error: 'Choose a supported image or video file up to 50 MB.' }, headers)
    }
    const caption = String(form.get('caption') || '').slice(0, 2200)
    if (violatesGuidelines(caption)) return jsonResponse(422, { error: GUIDELINES_MESSAGE, code: 'guidelines' }, headers)

    const extension = file.name.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0] || ''
    const path = `${viewerId}/${crypto.randomUUID()}${extension}`
    const { error: uploadError } = await admin.storage.from('uploads').upload(path, file, {
      contentType: file.type,
      upsert: false
    })
    throwOnError(uploadError)

    const mediaUrl = admin.storage.from('uploads').getPublicUrl(path).data.publicUrl
    const { data: post, error } = await admin.from('posts').insert({
      user_id: viewerId,
      caption,
      media_type: file.type.startsWith('video/') ? 'video' : 'image',
      media_url: mediaUrl,
      is_protected: ['true', '1', 'on'].includes(String(form.get('protected') || '').toLowerCase())
    }).select('id,user_id,caption,media_type,media_url,is_protected,views_count,likes_count,comments_count,created_at').single()
    if (error) {
      const { error: cleanupError } = await admin.storage.from('uploads').remove([path])
      if (cleanupError) console.error('Failed to clean up uploaded media after post creation failed:', cleanupError)
      throw new Error(error.message)
    }
    return jsonResponse(201, { message: 'Post created successfully', post }, headers)
  }

  const postMatch = route.match(/^\/posts\/([^/]+)(?:\/(privacy|like|comments))?$/)
  if (!postMatch) return jsonResponse(404, { error: 'Endpoint not found' }, headers)
  const [, postId, action] = postMatch

  if (!action && method === 'DELETE') {
    const { data: post, error } = await admin.from('posts').select('id,media_url').eq('id', postId).eq('user_id', viewerId).maybeSingle()
    throwOnError(error)
    if (!post) return jsonResponse(404, { error: 'Post not found or you do not own it' }, headers)
    const { error: deleteError } = await admin.from('posts').delete().eq('id', postId).eq('user_id', viewerId)
    throwOnError(deleteError)
    const path = storagePath(post.media_url)
    if (path) {
      const { error: storageError } = await admin.storage.from('uploads').remove([path])
      if (storageError) console.error('Deleted post media cleanup error:', storageError)
    }
    return jsonResponse(200, { success: true }, headers)
  }

  const context = await getPostContext(postId, viewerId)
  if (!context) return jsonResponse(403, { error: 'This post is unavailable or private.' }, headers)

  if (action === 'privacy' && method === 'PATCH') {
    if (context.post.user_id !== viewerId) return jsonResponse(403, { error: 'Only the post owner can change privacy.' }, headers)
    const body = await request.json()
    const privacy = String(body?.privacy || '')
    if (!['everyone', 'friends', 'only_me'].includes(privacy)) {
      return jsonResponse(400, { error: 'Invalid privacy option' }, headers)
    }
    const { error } = await admin.from('posts').update({ privacy }).eq('id', postId).eq('user_id', viewerId)
    throwOnError(error)
    return jsonResponse(200, { success: true, privacy }, headers)
  }

  if (action === 'like' && method === 'POST') {
    const { data: existing, error } = await admin.from('likes').select('post_id').eq('user_id', viewerId).eq('post_id', postId).maybeSingle()
    throwOnError(error)
    if (existing) {
      const { error: deleteError } = await admin.from('likes').delete().eq('user_id', viewerId).eq('post_id', postId)
      throwOnError(deleteError)
    } else {
      const { error: insertError } = await admin.from('likes').insert({ user_id: viewerId, post_id: postId })
      throwOnError(insertError)
    }
    await updatePostCount(postId, 'likes_count')
    return jsonResponse(200, { liked: !existing, postId }, headers)
  }

  if (action === 'comments' && method === 'GET') {
    const { data: comments, error } = await admin.from('comments')
      .select('id,post_id,user_id,content,created_at')
      .eq('post_id', postId)
      .order('created_at', { ascending: true })
    throwOnError(error)
    const userIds = [...new Set((comments || []).map(comment => comment.user_id))]
    const { data: users, error: usersError } = userIds.length
      ? await admin.from('users').select('id,username,display_name,avatar_url').in('id', userIds)
      : { data: [], error: null }
    throwOnError(usersError)
    const userById = new Map((users || []).map(user => [user.id, user]))
    const blockedForComments = await getBlockedIds(viewerId)
    return jsonResponse(200, {
      comments: (comments || []).filter(comment => !blockedForComments.has(comment.user_id)).map(comment => {
        const user = userById.get(comment.user_id)
        return {
          id: comment.id,
          post_id: comment.post_id,
          user_id: comment.user_id,
          content: comment.content,
          created_at: comment.created_at,
          username: user?.username,
          display_name: user?.display_name,
          avatar_url: user?.avatar_url
        }
      })
    }, headers)
  }

  if (action === 'comments' && method === 'POST') {
    const body = await request.json()
    const content = String(body?.content || '').trim()
    if (!content) return jsonResponse(400, { error: 'Comment content cannot be empty' }, headers)
    if (content.length > 500) return jsonResponse(400, { error: 'Comment must be 500 characters or fewer.' }, headers)
    if (violatesGuidelines(content)) return jsonResponse(422, { error: GUIDELINES_MESSAGE, code: 'guidelines' }, headers)
    const { data: comment, error } = await admin.from('comments')
      .insert({ post_id: postId, user_id: viewerId, content })
      .select('id,post_id,user_id,content,created_at')
      .single()
    throwOnError(error)
    await updatePostCount(postId, 'comments_count')
    const { data: user, error: userError } = await admin.from('users')
      .select('username,display_name,avatar_url')
      .eq('id', viewerId)
      .single()
    throwOnError(userError)
    return jsonResponse(201, { message: 'Comment added', comment: { ...comment, ...user } }, headers)
  }

  return jsonResponse(404, { error: 'Endpoint not found' }, headers)
}

async function getMessageBlockReason(senderId: string, recipientId: string): Promise<string | null> {
  const { data: recipient, error } = await admin.from('users')
    .select('id,message_privacy')
    .eq('id', recipientId)
    .maybeSingle()
  throwOnError(error)
  if (!recipient) return 'Account not found'

  if (recipient.message_privacy === 'nobody') return 'This person is not accepting messages.'
  if (recipient.message_privacy === 'friends') {
    const { data: mutualFollow, error: followError } = await admin.from('follows')
      .select('follower_id')
      .eq('follower_id', senderId)
      .eq('following_id', recipientId)
      .eq('status', 'accepted')
      .maybeSingle()
    throwOnError(followError)
    if (!mutualFollow) return 'This person only accepts messages from friends.'
    const { data: followsBack, error: followsBackError } = await admin.from('follows')
      .select('follower_id')
      .eq('follower_id', recipientId)
      .eq('following_id', senderId)
      .eq('status', 'accepted')
      .maybeSingle()
    throwOnError(followsBackError)
    if (!followsBack) return 'This person only accepts messages from friends.'
  }
  return null
}

function replyPreview(
  target: { id: string; sender_id: string; content: string | null; media_url: string | null; view_once: boolean } | null | undefined,
  usersById: Map<string, { display_name?: string; username?: string }>
) {
  if (!target) return { id: null, unavailable: true }
  const sender = usersById.get(target.sender_id)
  const text = target.view_once ? '📷 View-once photo' : (target.content || (target.media_url ? (/\.(weba|m4a|ogg)$/i.test(target.media_url) ? '🎤 Voice message' : '📎 Photo / video') : ''))
  return {
    id: target.id,
    sender_id: target.sender_id,
    sender_name: sender?.display_name || sender?.username || 'Unknown',
    text: text.length > 140 ? `${text.slice(0, 137)}…` : text
  }
}

async function getConversationMembership(conversationId: string, viewerId: string) {
  const { data, error } = await admin.from('conversation_members')
    .select('conversation_id,user_id,role,joined_at,cleared_at,last_read_at,hidden_senders')
    .eq('conversation_id', conversationId)
  throwOnError(error)
  const members = data || []
  return members.some(member => member.user_id === viewerId) ? members : null
}

async function handleMessages(request: Request, viewerId: string, headers: Record<string, string>) {
  const url = new URL(request.url)
  const pathSegments = url.pathname.split('/').filter(Boolean)
  const functionIndex = pathSegments.indexOf('vynzo-api')
  const endpointSegments = functionIndex >= 0 ? pathSegments.slice(functionIndex + 1) : pathSegments
  if (endpointSegments[0] === 'api') endpointSegments.shift()
  const route = `/${endpointSegments.join('/')}`
  const method = request.method

  if (route === '/messages' && method === 'GET') {
    const { data: memberships, error: membershipsError } = await admin.from('conversation_members')
      .select('conversation_id,cleared_at,joined_at,deleted_at,last_read_at')
      .eq('user_id', viewerId)
      .order('joined_at', { ascending: false })
      .limit(100)
    throwOnError(membershipsError)
    const conversationIds = (memberships || []).map(member => member.conversation_id)
    if (!conversationIds.length) return jsonResponse(200, { conversations: [] }, headers)

    const [conversationsResult, membersResult, messagesResult] = await Promise.all([
      admin.from('conversations')
        .select('id,is_group,group_name,group_avatar,created_at')
        .in('id', conversationIds),
      admin.from('conversation_members')
        .select('conversation_id,user_id,joined_at')
        .in('conversation_id', conversationIds),
      admin.from('messages')
        .select('id,conversation_id,content,media_url,view_once,sender_id,created_at')
        .in('conversation_id', conversationIds)
        .order('created_at', { ascending: false })
        .limit(1000)
    ])
    throwOnError(conversationsResult.error)
    throwOnError(membersResult.error)
    throwOnError(messagesResult.error)

    const peerIds = [...new Set((membersResult.data || [])
      .filter(member => member.user_id !== viewerId)
      .map(member => member.user_id))]
    const peerResult = peerIds.length
      ? await admin.from('users').select('id,username,display_name,avatar_url').in('id', peerIds)
      : { data: [], error: null }
    throwOnError(peerResult.error)

    const clearedAtByConversation = new Map((memberships || []).map(member => [
      member.conversation_id,
      member.cleared_at ? new Date(member.cleared_at).getTime() : Number.NEGATIVE_INFINITY
    ]))
    const deletedByConversation = new Map((memberships || []).map(member => [member.conversation_id, member.deleted_at]))
    const latestMessageByConversation = new Map<string, NonNullable<typeof messagesResult.data>[number]>()
    for (const message of messagesResult.data || []) {
      if (new Date(message.created_at).getTime() <= (clearedAtByConversation.get(message.conversation_id) ?? Number.NEGATIVE_INFINITY)) continue
      if (!latestMessageByConversation.has(message.conversation_id)) {
        latestMessageByConversation.set(message.conversation_id, message)
      }
    }

    const unreadByConversation = new Map<string, number>()
    const readAtByConversation = new Map((memberships || []).map(member => [
      member.conversation_id,
      Math.max(
        member.last_read_at ? new Date(member.last_read_at).getTime() : Number.NEGATIVE_INFINITY,
        member.cleared_at ? new Date(member.cleared_at).getTime() : Number.NEGATIVE_INFINITY
      )
    ]))
    for (const message of messagesResult.data || []) {
      if (message.sender_id === viewerId) continue
      if (new Date(message.created_at).getTime() <= (readAtByConversation.get(message.conversation_id) ?? Number.NEGATIVE_INFINITY)) continue
      unreadByConversation.set(message.conversation_id, (unreadByConversation.get(message.conversation_id) || 0) + 1)
    }

    const membersByConversation = new Map<string, typeof membersResult.data>()
    for (const member of membersResult.data || []) {
      const current = membersByConversation.get(member.conversation_id) || []
      current.push(member)
      membersByConversation.set(member.conversation_id, current)
    }
    const usersById = new Map((peerResult.data || []).map(user => [user.id, user]))
    const conversations = (conversationsResult.data || []).filter(conversation => {
      const deletedAt = deletedByConversation.get(conversation.id)
      return !deletedAt || latestMessageByConversation.has(conversation.id)
    }).map(conversation => {
      const peer = (membersByConversation.get(conversation.id) || [])
        .filter(member => member.user_id !== viewerId)
        .sort((a, b) => String(a.joined_at).localeCompare(String(b.joined_at)))
        .map(member => usersById.get(member.user_id))
        .find(Boolean)
      return {
        ...conversation,
        other_user_id: peer?.id || null,
        other_username: peer?.username || null,
        other_display_name: peer?.display_name || null,
        other_avatar_url: peer?.avatar_url || null,
        last_message: latestMessageByConversation.get(conversation.id) || null,
        unread_count: unreadByConversation.get(conversation.id) || 0
      }
    }).sort((a, b) => {
      const aTime = a.last_message ? new Date(a.last_message.created_at).getTime() : new Date(a.created_at).getTime()
      const bTime = b.last_message ? new Date(b.last_message.created_at).getTime() : new Date(b.created_at).getTime()
      return bTime - aTime
    })
    return jsonResponse(200, { conversations }, headers)
  }

  const uploadUrlMatch = route.match(/^\/messages\/([^/]+)\/upload-url$/)
  if (uploadUrlMatch && method === 'POST') {
    const [, conversationId] = uploadUrlMatch
    const members = await getConversationMembership(conversationId, viewerId)
    if (!members) return jsonResponse(403, { error: 'Access denied to this conversation' }, headers)
    const body = await request.json().catch(() => ({}))
    const extensions: Record<string, string> = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
      'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
      'audio/webm': 'weba', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg'
    }
    const extension = extensions[String(body?.content_type || '').split(';')[0].trim().toLowerCase()]
    if (!extension) return jsonResponse(400, { error: 'Choose a supported image, video or voice file.' }, headers)
    const path = `${viewerId}/messages/${conversationId}/${crypto.randomUUID()}.${extension}`
    const { data, error } = await admin.storage.from('uploads').createSignedUploadUrl(path)
    throwOnError(error)
    return jsonResponse(200, { path, token: data!.token }, headers)
  }

  const messagesMatch = route.match(/^\/messages\/([^/]+)\/messages$/)
  if (messagesMatch && method === 'GET') {
    const [, conversationId] = messagesMatch
    const members = await getConversationMembership(conversationId, viewerId)
    if (!members) return jsonResponse(403, { error: 'Access denied to this conversation' }, headers)
    const viewerMembership = members.find(member => member.user_id === viewerId)!
    const otherMembers = members.filter(member => member.user_id !== viewerId)
    const senderIds = [...new Set([...members.map(member => member.user_id), viewerId])]
    let messageQuery = admin.from('messages')
      .select('id,conversation_id,sender_id,content,media_url,created_at,view_once,viewed_at,edited_at,reply_to_id')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(500)
    if (viewerMembership.cleared_at) messageQuery = messageQuery.gt('created_at', viewerMembership.cleared_at)
    const [{ data: messages, error }, { data: users, error: usersError }, { data: viewer, error: viewerError }] = await Promise.all([
      messageQuery,
      admin.from('users').select('id,username,display_name,avatar_url,read_receipts').in('id', senderIds),
      admin.from('users').select('read_receipts').eq('id', viewerId).single()
    ])
    throwOnError(error)
    throwOnError(usersError)
    throwOnError(viewerError)
    if (!viewer) throw new Error('The authenticated user profile is unavailable.')

    const usersById = new Map((users || []).map(user => [user.id, user]))
    const hiddenSenders = (viewerMembership.hidden_senders || {}) as Record<string, string>
    const visibleMessages = (messages || []).filter(message => {
      if (hiddenSenders[`msg:${message.id}`]) return false
      const hiddenAt = hiddenSenders[message.sender_id]
      return !hiddenAt || new Date(message.created_at).getTime() > new Date(hiddenAt).getTime()
    })
    const replyIds = [...new Set(visibleMessages.map(message => message.reply_to_id).filter(Boolean))]
    const replyTargets = replyIds.length
      ? (await admin.from('messages')
        .select('id,sender_id,content,media_url,view_once')
        .eq('conversation_id', conversationId)
        .in('id', replyIds)).data || []
      : []
    const replyById = new Map(replyTargets.map(target => [target.id, target]))
    const messagesWithUsers = visibleMessages.map(message => {
      const sender = usersById.get(message.sender_id)
      const target = message.reply_to_id ? replyById.get(message.reply_to_id) : null
      const readers = otherMembers.filter(member => member.user_id !== message.sender_id)
      const readAtOrAfterMessage = (member: (typeof members)[number]) =>
        Boolean(member.last_read_at && new Date(member.last_read_at).getTime() >= new Date(message.created_at).getTime())
      const wasRead = readers.some(readAtOrAfterMessage)
      const seen = message.sender_id === viewerId && viewer.read_receipts !== false
        && readers.some(member => readAtOrAfterMessage(member)
          && usersById.get(member.user_id)?.read_receipts !== false)
      return {
        ...message,
        sender_username: sender?.username,
        sender_display_name: sender?.display_name,
        sender_avatar_url: sender?.avatar_url,
        seen,
        can_unsend: message.sender_id === viewerId && !wasRead,
        reply_to: message.reply_to_id ? replyPreview(target, usersById) : null
      }
    })
    return jsonResponse(200, {
      messages: messagesWithUsers,
      read_receipts: viewer.read_receipts !== false,
      members: members.map(member => {
        const user = usersById.get(member.user_id)
        return { id: member.user_id, username: user?.username, display_name: user?.display_name, is_me: member.user_id === viewerId }
      })
    }, headers)
  }

  const readMatch = route.match(/^\/messages\/([^/]+)\/read$/)
  if (readMatch && method === 'POST') {
    const [, conversationId] = readMatch
    const { data, error } = await admin.from('conversation_members')
      .update({ last_read_at: new Date().toISOString() })
      .eq('conversation_id', conversationId)
      .eq('user_id', viewerId)
      .select('last_read_at')
      .maybeSingle()
    throwOnError(error)
    if (!data) return jsonResponse(403, { error: 'Access denied to this conversation' }, headers)
    return jsonResponse(200, { read_at: data.last_read_at }, headers)
  }

  if (messagesMatch && method === 'POST') {
    const [, conversationId] = messagesMatch
    const members = await getConversationMembership(conversationId, viewerId)
    if (!members) return jsonResponse(403, { error: 'Access denied to this conversation' }, headers)
    const conversationResult = await admin.from('conversations')
      .select('is_group')
      .eq('id', conversationId)
      .maybeSingle()
    throwOnError(conversationResult.error)
    if (!conversationResult.data) return jsonResponse(404, { error: 'Conversation not found' }, headers)

    let content = ''
    let replyToId: string | null = null
    let file: File | null = null
    let directPath: string | null = null
    if (request.headers.get('content-type')?.toLowerCase().includes('multipart/form-data')) {
      const form = await request.formData()
      content = typeof form.get('content') === 'string' ? String(form.get('content')).trim() : ''
      const uploaded = form.get('media')
      if (uploaded instanceof File) file = uploaded
      if (typeof form.get('reply_to_id') === 'string') replyToId = String(form.get('reply_to_id')) || null
    } else {
      const body = await request.json()
      content = typeof body?.content === 'string' ? body.content.trim() : ''
      if (typeof body?.reply_to_id === 'string') replyToId = body.reply_to_id || null
      if (typeof body?.media_path === 'string' && body.media_path) {
        directPath = body.media_path
        const prefix = `${viewerId}/messages/${conversationId}/`
        if (!directPath!.startsWith(prefix) || directPath!.includes('..') || !/\.(jpg|png|webp|gif|mp4|webm|mov|weba|m4a|ogg)$/i.test(directPath!)) {
          return jsonResponse(400, { error: 'Invalid media upload.' }, headers)
        }
      }
    }
    let replyTarget: { id: string; sender_id: string; content: string | null; media_url: string | null; view_once: boolean } | null = null
    if (replyToId) {
      const { data: target, error: targetError } = await admin.from('messages')
        .select('id,sender_id,content,media_url,view_once')
        .eq('id', replyToId)
        .eq('conversation_id', conversationId)
        .maybeSingle()
      if (targetError || !target) return jsonResponse(400, { error: 'The message you are replying to is no longer available.' }, headers)
      replyTarget = target
    }
    if (!content && !file && !directPath) return jsonResponse(400, { error: 'Message cannot be empty' }, headers)
    if (content.length > 2000) return jsonResponse(400, { error: 'Message must be 2000 characters or fewer.' }, headers)

    for (const member of members) {
      if (member.user_id === viewerId || conversationResult.data.is_group) continue
      const blockReason = await getMessageBlockReason(viewerId, member.user_id)
      if (blockReason) return jsonResponse(403, { error: blockReason }, headers)
    }

    let mediaUrl: string | null = null
    let mediaPath: string | null = null
    if (directPath) {
      mediaPath = directPath
      mediaUrl = admin.storage.from('uploads').getPublicUrl(directPath).data.publicUrl
    }
    if (file) {
      if (!allowedMediaTypes.has(file.type)) return jsonResponse(400, { error: 'Choose a supported image or video file.' }, headers)
      if (file.size === 0 || file.size > 50 * 1024 * 1024) return jsonResponse(413, { error: 'Message media must be 50 MB or smaller.' }, headers)
      const extensions: Record<string, string> = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'video/mp4': 'mp4',
        'video/webm': 'webm',
        'video/quicktime': 'mov'
      }
      mediaPath = `${viewerId}/messages/${conversationId}/${crypto.randomUUID()}.${extensions[file.type]}`
      const { error: uploadError } = await admin.storage.from('uploads').upload(mediaPath, file, {
        contentType: file.type,
        upsert: false
      })
      throwOnError(uploadError)
      mediaUrl = admin.storage.from('uploads').getPublicUrl(mediaPath).data.publicUrl
    }

    try {
      const { data: inserted, error } = await admin.from('messages')
        .insert({ conversation_id: conversationId, sender_id: viewerId, content, media_url: mediaUrl, reply_to_id: replyTarget?.id ?? null })
        .select('id,conversation_id,sender_id,content,media_url,created_at,view_once,viewed_at,reply_to_id')
        .single()
      throwOnError(error)
      const { data: sender, error: senderError } = await admin.from('users')
        .select('username,display_name,avatar_url')
        .eq('id', viewerId)
        .single()
      throwOnError(senderError)
      if (!sender) throw new Error('The sender profile is unavailable.')
      let reply_to = null
      if (replyTarget) {
        const { data: targetUser } = await admin.from('users')
          .select('id,username,display_name').eq('id', replyTarget.sender_id).maybeSingle()
        reply_to = replyPreview(replyTarget, new Map(targetUser ? [[targetUser.id, targetUser]] : []))
      }
      return jsonResponse(201, {
        message: {
          ...inserted,
          username: sender.username,
          display_name: sender.display_name,
          avatar_url: sender.avatar_url,
          seen: false,
          can_unsend: true,
          reply_to
        }
      }, headers)
    } catch (error) {
      if (mediaPath) {
        const { error: cleanupError } = await admin.storage.from('uploads').remove([mediaPath])
        if (cleanupError) console.error('Failed to clean up unsaved message media:', cleanupError)
      }
      throw error
    }
  }

  const sendViewOnceMatch = route.match(/^\/messages\/([^/]+)\/view-once$/)
  if (sendViewOnceMatch && method === 'POST') {
    const [, conversationId] = sendViewOnceMatch
    const members = await getConversationMembership(conversationId, viewerId)
    if (!members) return jsonResponse(403, { error: 'Access denied to this conversation' }, headers)
    const form = await request.formData()
    const photo = form.get('photo')
    if (!(photo instanceof File)) return jsonResponse(400, { error: 'Choose a photo to send' }, headers)
    const photoExtensions: Record<string, string> = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
      'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov'
    }
    if (!photoExtensions[photo.type]) return jsonResponse(400, { error: 'View-once media must be a JPEG, PNG, WEBP, GIF, MP4, WEBM or MOV file.' }, headers)
    const maxViewOnceBytes = photo.type.startsWith('video/') ? 50 * 1024 * 1024 : 10 * 1024 * 1024
    if (photo.size === 0 || photo.size > maxViewOnceBytes) return jsonResponse(413, { error: 'This file is too large for view-once (photos 10 MB, videos 50 MB).' }, headers)

    const { data: conversation, error: conversationError } = await admin.from('conversations')
      .select('is_group').eq('id', conversationId).maybeSingle()
    throwOnError(conversationError)
    if (!conversation) return jsonResponse(404, { error: 'Conversation not found' }, headers)
    for (const member of members) {
      if (member.user_id === viewerId || conversation.is_group) continue
      const blockReason = await getMessageBlockReason(viewerId, member.user_id)
      if (blockReason) return jsonResponse(403, { error: blockReason }, headers)
    }

    const photoPath = `${viewerId}/${conversationId}/${crypto.randomUUID()}.${photoExtensions[photo.type]}`
    const { error: photoUploadError } = await admin.storage.from('view-once').upload(photoPath, photo, {
      contentType: photo.type,
      upsert: false
    })
    throwOnError(photoUploadError)
    const { data: inserted, error: insertError } = await admin.from('messages')
      .insert({ conversation_id: conversationId, sender_id: viewerId, content: '', view_once: true, view_once_path: photoPath })
      .select('id,conversation_id,sender_id,content,media_url,created_at,view_once,viewed_at')
      .single()
    if (insertError) {
      await admin.storage.from('view-once').remove([photoPath])
      throwOnError(insertError)
    }
    const { data: sender, error: senderError } = await admin.from('users')
      .select('username,display_name,avatar_url').eq('id', viewerId).single()
    throwOnError(senderError)
    return jsonResponse(201, {
      message: { ...inserted, username: sender?.username, display_name: sender?.display_name, avatar_url: sender?.avatar_url, seen: false, can_unsend: false }
    }, headers)
  }

  const openViewOnceMatch = route.match(/^\/messages\/([^/]+)\/messages\/([^/]+)\/view-once$/)
  if (openViewOnceMatch && method === 'POST') {
    const [, conversationId, messageId] = openViewOnceMatch
    const members = await getConversationMembership(conversationId, viewerId)
    const gone = () => jsonResponse(410, { error: 'This photo is no longer available.' }, headers)
    if (!members) return gone()
    // The update only matches while the photo is unopened, so only one request can claim it.
    const { data: claimed, error: claimError } = await admin.from('messages')
      .update({ viewed_at: new Date().toISOString() })
      .eq('id', messageId)
      .eq('conversation_id', conversationId)
      .eq('view_once', true)
      .is('viewed_at', null)
      .neq('sender_id', viewerId)
      .select('view_once_path')
      .maybeSingle()
    throwOnError(claimError)
    if (!claimed?.view_once_path) return gone()
    const { data: blob, error: downloadError } = await admin.storage.from('view-once').download(claimed.view_once_path)
    if (downloadError || !blob) return gone()
    await admin.from('messages').update({ view_once_path: null }).eq('id', messageId)
    const { error: removeError } = await admin.storage.from('view-once').remove([claimed.view_once_path])
    if (removeError) console.error('View-once photo deletion failed:', removeError)
    return new Response(blob, {
      status: 200,
      headers: {
        ...headers,
        'Content-Type': blob.type || 'application/octet-stream',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Content-Type-Options': 'nosniff'
      }
    })
  }

  const editMessageMatch = route.match(/^\/messages\/([^/]+)\/messages\/([^/]+)$/)
  if (editMessageMatch && method === 'PATCH') {
    const [, conversationId, messageId] = editMessageMatch
    const members = await getConversationMembership(conversationId, viewerId)
    if (!members) return jsonResponse(403, { error: 'Access denied to this conversation' }, headers)
    const body = await request.json().catch(() => ({}))
    const content = typeof body?.content === 'string' ? body.content.trim() : ''
    if (!content) return jsonResponse(400, { error: 'Message cannot be empty' }, headers)
    if (content.length > 2000) return jsonResponse(400, { error: 'Message must be 2000 characters or fewer.' }, headers)
    const { data: message, error } = await admin.from('messages')
      .select('id,sender_id,content,view_once,created_at')
      .eq('id', messageId)
      .eq('conversation_id', conversationId)
      .eq('sender_id', viewerId)
      .maybeSingle()
    throwOnError(error)
    if (!message) return jsonResponse(404, { error: 'Message not found or you do not own it.' }, headers)
    const alreadySeen = members.some(member => member.user_id !== viewerId
      && member.last_read_at
      && new Date(member.last_read_at).getTime() >= new Date(message.created_at).getTime())
    if (alreadySeen) return jsonResponse(403, { error: 'This message can no longer be edited because it has already been seen.' }, headers)
    if (message.view_once || !message.content) {
      return jsonResponse(400, { error: 'Only text messages can be edited.' }, headers)
    }
    if (content === message.content) return jsonResponse(200, { message }, headers)
    const { data: updated, error: updateError } = await admin.from('messages')
      .update({ content, edited_at: new Date().toISOString() })
      .eq('id', messageId)
      .eq('sender_id', viewerId)
      .select('id,conversation_id,sender_id,content,media_url,created_at,view_once,viewed_at,edited_at')
      .single()
    throwOnError(updateError)
    return jsonResponse(200, { message: updated }, headers)
  }

  const deleteConversationMatch = route.match(/^\/messages\/([^/]+)$/)
  if (deleteConversationMatch && method === 'DELETE') {
    const [, conversationId] = deleteConversationMatch
    const now = new Date().toISOString()
    const { data, error } = await admin.from('conversation_members')
      .update({ cleared_at: now, deleted_at: now })
      .eq('conversation_id', conversationId)
      .eq('user_id', viewerId)
      .select('deleted_at')
      .maybeSingle()
    throwOnError(error)
    if (!data) return jsonResponse(403, { error: 'Access denied to this conversation' }, headers)
    return jsonResponse(200, { deleted_at: data.deleted_at }, headers)
  }

  const deleteMessageMatch = route.match(/^\/messages\/([^/]+)\/messages\/([^/]+)$/)
  if (deleteMessageMatch && method === 'DELETE') {
    const [, conversationId, messageId] = deleteMessageMatch
    const members = await getConversationMembership(conversationId, viewerId)
    if (!members) return jsonResponse(403, { error: 'Access denied to this conversation' }, headers)
    const { data: message, error } = await admin.from('messages')
      .select('id,conversation_id,sender_id,created_at,view_once_path')
      .eq('id', messageId)
      .eq('conversation_id', conversationId)
      .eq('sender_id', viewerId)
      .maybeSingle()
    throwOnError(error)
    if (!message) return jsonResponse(404, { error: 'Message not found or you do not own it.' }, headers)
    const seen = members.some(member => member.user_id !== viewerId
      && member.last_read_at
      && new Date(member.last_read_at).getTime() >= new Date(message.created_at).getTime())
    if (seen) {
      const mine = members.find(member => member.user_id === viewerId)!
      const hidden = { ...((mine.hidden_senders || {}) as Record<string, string>), [`msg:${messageId}`]: new Date().toISOString() }
      const { error: hideError } = await admin.from('conversation_members')
        .update({ hidden_senders: hidden })
        .eq('conversation_id', conversationId)
        .eq('user_id', viewerId)
      throwOnError(hideError)
      return jsonResponse(200, { messageId, hidden_for_me: true }, headers)
    }
    const { error: deleteError } = await admin.from('messages')
      .delete()
      .eq('id', messageId)
      .eq('conversation_id', conversationId)
      .eq('sender_id', viewerId)
    throwOnError(deleteError)
    if (message.view_once_path) {
      const { error: storageError } = await admin.storage.from('view-once').remove([message.view_once_path])
      if (storageError) console.error('Deleted view-once message media cleanup error:', storageError)
    }
    return jsonResponse(200, { messageId }, headers)
  }

  const hideSenderMatch = route.match(/^\/messages\/([^/]+)\/senders\/([^/]+)$/)
  if (hideSenderMatch && method === 'DELETE') {
    const [, conversationId, senderId] = hideSenderMatch
    const members = await getConversationMembership(conversationId, viewerId)
    if (!members) return jsonResponse(403, { error: 'Access denied to this conversation' }, headers)
    if (!members.some(member => member.user_id === senderId)) {
      return jsonResponse(404, { error: 'That person is not in this conversation.' }, headers)
    }
    const mine = members.find(member => member.user_id === viewerId)!
    const hidden = { ...((mine.hidden_senders || {}) as Record<string, string>), [senderId]: new Date().toISOString() }
    const { error } = await admin.from('conversation_members')
      .update({ hidden_senders: hidden })
      .eq('conversation_id', conversationId)
      .eq('user_id', viewerId)
    throwOnError(error)
    return jsonResponse(200, { user_id: senderId }, headers)
  }

  const clearMatch = route.match(/^\/messages\/([^/]+)\/messages$/)
  if (clearMatch && method === 'DELETE') {
    const [, conversationId] = clearMatch
    const { data, error } = await admin.from('conversation_members')
      .update({ cleared_at: new Date().toISOString() })
      .eq('conversation_id', conversationId)
      .eq('user_id', viewerId)
      .select('cleared_at')
      .maybeSingle()
    throwOnError(error)
    if (!data) return jsonResponse(403, { error: 'Access denied to this conversation' }, headers)
    return jsonResponse(200, { cleared_at: data.cleared_at }, headers)
  }

  if (route === '/messages/conversations' && method === 'POST') {
    const body = await request.json()
    if (body?.isGroup === true) {
      const rawMemberIds: unknown = body?.memberIds
      const memberIds: string[] = Array.isArray(rawMemberIds)
        ? [...new Set<string>(rawMemberIds.filter((id): id is string => typeof id === 'string' && id.length <= 64))]
          .filter(id => id !== viewerId)
        : []
      if (memberIds.length < 1 || memberIds.length > 49) {
        return jsonResponse(400, { error: 'A group conversation must include between 1 and 49 other members.' }, headers)
      }
      const name = typeof body.groupName === 'string' ? body.groupName.trim() : ''
      if (name.length > 100) return jsonResponse(400, { error: 'Group name must be 100 characters or fewer.' }, headers)
      for (const memberId of memberIds) {
        const reason = await getMessageBlockReason(viewerId, memberId)
        if (reason) return jsonResponse(403, { error: reason }, headers)
      }
      const { data: conversation, error: conversationError } = await admin.from('conversations')
        .insert({ is_group: true, group_name: name || 'New Group' })
        .select('id')
        .single()
      throwOnError(conversationError)
      if (!conversation) throw new Error('Supabase did not return the new group conversation.')
      const { error: membersError } = await admin.from('conversation_members').insert([
        { conversation_id: conversation.id, user_id: viewerId, role: 'admin' },
        ...memberIds.map(userId => ({ conversation_id: conversation.id, user_id: userId, role: 'member' }))
      ])
      if (membersError) {
        const { error: cleanupError } = await admin.from('conversations').delete().eq('id', conversation.id)
        if (cleanupError) console.error('Failed to clean up incomplete group conversation:', cleanupError)
        throwOnError(membersError)
      }
      return jsonResponse(201, { message: 'Group conversation created', conversationId: conversation.id }, headers)
    }

    const recipientId = typeof body?.recipientId === 'string' ? body.recipientId : ''
    if (!recipientId) return jsonResponse(400, { error: 'Recipient ID is required for direct messages' }, headers)
    if (recipientId === viewerId) return jsonResponse(400, { error: 'You cannot create a conversation with yourself.' }, headers)
    const blockReason = await getMessageBlockReason(viewerId, recipientId)
    if (blockReason) return jsonResponse(403, { error: blockReason }, headers)
    const { data: existingMembers, error: existingError } = await admin.from('conversation_members')
      .select('conversation_id')
      .eq('user_id', viewerId)
    throwOnError(existingError)
    const existingIds = (existingMembers || []).map(member => member.conversation_id)
    if (existingIds.length) {
      const { data: conversations, error: conversationError } = await admin.from('conversations')
        .select('id')
        .eq('is_group', false)
        .in('id', existingIds)
      throwOnError(conversationError)
      const directConversationIds = (conversations || []).map(conversation => conversation.id)
      if (directConversationIds.length) {
        const { data: recipientMemberships, error: recipientError } = await admin.from('conversation_members')
          .select('conversation_id')
          .eq('user_id', recipientId)
          .in('conversation_id', directConversationIds)
        throwOnError(recipientError)
        if (recipientMemberships?.length) {
          return jsonResponse(200, { conversationId: recipientMemberships[0].conversation_id }, headers)
        }
      }
    }

    const { data: conversation, error: insertError } = await admin.from('conversations')
      .insert({ is_group: false })
      .select('id')
      .single()
    throwOnError(insertError)
    if (!conversation) throw new Error('Supabase did not return the new direct conversation.')
    const { error: membersError } = await admin.from('conversation_members').insert([
      { conversation_id: conversation.id, user_id: viewerId },
      { conversation_id: conversation.id, user_id: recipientId }
    ])
    if (membersError) {
      const { error: cleanupError } = await admin.from('conversations').delete().eq('id', conversation.id)
      if (cleanupError) console.error('Failed to clean up incomplete direct conversation:', cleanupError)
      throwOnError(membersError)
    }
    return jsonResponse(201, { conversationId: conversation.id }, headers)
  }

  return jsonResponse(404, { error: 'Endpoint not found' }, headers)
}

async function handleLive(request: Request, viewerId: string | undefined, headers: Record<string, string>) {
  const url = new URL(request.url)
  const pathSegments = url.pathname.split('/').filter(Boolean)
  const functionIndex = pathSegments.indexOf('vynzo-api')
  const endpointSegments = functionIndex >= 0 ? pathSegments.slice(functionIndex + 1) : pathSegments
  if (endpointSegments[0] === 'api') endpointSegments.shift()
  const route = `/${endpointSegments.join('/')}`
  const method = request.method

  if (route === '/live' && method === 'GET') {
    const { data: sessions, error } = await admin.from('live_sessions')
      .select('id,host_id,title,category,viewer_count,created_at,visibility')
      .eq('is_active', true)
      .gte('last_heartbeat', new Date(Date.now() - 90_000).toISOString())
      .order('viewer_count', { ascending: false })
      .order('created_at', { ascending: false })
    throwOnError(error)
    if (!sessions?.length) return jsonResponse(200, { liveStreams: [] }, headers)

    const hostIds = [...new Set(sessions.map(session => session.host_id))]
    const [usersResult, followingResult, followedByResult] = await Promise.all([
      admin.from('users').select('id,username,display_name,avatar_url').in('id', hostIds),
      viewerId
        ? admin.from('follows').select('following_id').eq('follower_id', viewerId).eq('status', 'accepted').in('following_id', hostIds)
        : Promise.resolve({ data: [], error: null }),
      viewerId
        ? admin.from('follows').select('follower_id').eq('following_id', viewerId).eq('status', 'accepted').in('follower_id', hostIds)
        : Promise.resolve({ data: [], error: null })
    ])
    throwOnError(usersResult.error)
    throwOnError(followingResult.error)
    throwOnError(followedByResult.error)
    const usersById = new Map((usersResult.data || []).map(user => [user.id, user]))
    const friendIds = new Set([
      ...(followingResult.data || []).map(row => row.following_id),
      ...(followedByResult.data || []).map(row => row.follower_id)
    ])
    const blockedForLive = viewerId ? await getBlockedIds(viewerId) : new Set<string>()
    const selectedSessionIds = sessions.filter(session => session.visibility === 'selected' && session.host_id !== viewerId).map(session => session.id)
    const selectedHostIds = [...new Set(sessions.filter(session => session.visibility === 'selected' && session.host_id !== viewerId).map(session => session.host_id))]
    const allowedSelectedSessions = await getLiveInvitedSessionIds(viewerId, selectedSessionIds)
    const selectedFriendHosts = await getLiveMutualFriendIds(viewerId, selectedHostIds)
    const liveStreams = sessions.filter(session => !blockedForLive.has(session.host_id)
      && (session.visibility === 'public'
        || session.host_id === viewerId
        || (session.visibility === 'friends' && friendIds.has(session.host_id))
        || (session.visibility === 'selected' && allowedSelectedSessions.has(session.id) && selectedFriendHosts.has(session.host_id)))).map(session => {
      const host = usersById.get(session.host_id)
      return {
        id: session.id,
        title: session.title,
        category: session.category,
        visibility: session.visibility,
        viewer_count: session.viewer_count,
        created_at: session.created_at,
        host_id: session.host_id,
        host_username: host?.username,
        host_display_name: host?.display_name,
        host_avatar_url: host?.avatar_url,
        is_friend: friendIds.has(session.host_id)
      }
    }).sort((a, b) => Number(b.is_friend) - Number(a.is_friend))
    return jsonResponse(200, { liveStreams }, headers)
  }

  if (route === '/live/start' && method === 'POST' && viewerId) {
    const body = await request.json()
    const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 100) : ''
    const category = typeof body?.category === 'string' && body.category.trim()
      ? body.category.trim().slice(0, 100)
      : 'General'
    if (!title) return jsonResponse(400, { error: 'Livestream title is required' }, headers)
    if (violatesGuidelines(title, category)) return jsonResponse(422, { error: GUIDELINES_MESSAGE, code: 'guidelines' }, headers)
    const visibility = ['friends', 'selected'].includes(body?.visibility) ? body.visibility : 'public'
    let audienceIds: string[] = []
    if (visibility === 'selected') {
      if (!Array.isArray(body?.audience_ids) || !body.audience_ids.length || body.audience_ids.length > 200
        || body.audience_ids.some((id: unknown) => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
        return jsonResponse(400, { error: 'Select between 1 and 200 friends for your livestream.' }, headers)
      }
      audienceIds = [...new Set(body.audience_ids as string[])]
      const [following, followedBy] = await Promise.all([
        admin.from('follows').select('following_id').eq('follower_id', viewerId).eq('status', 'accepted').in('following_id', audienceIds),
        admin.from('follows').select('follower_id').eq('following_id', viewerId).eq('status', 'accepted').in('follower_id', audienceIds)
      ])
      throwOnError(following.error)
      throwOnError(followedBy.error)
      const follows = new Set((following.data || []).map(row => row.following_id))
      const followedByIds = new Set((followedBy.data || []).map(row => row.follower_id))
      if (audienceIds.some(id => id === viewerId || !follows.has(id) || !followedByIds.has(id))) {
        return jsonResponse(400, { error: 'Only your current friends can be selected to watch this livestream.' }, headers)
      }
    }

    const { data: session, error: insertError } = await admin.from('live_sessions')
      .insert({ host_id: viewerId, title, category, visibility, is_active: true })
      .select('id,title,category,viewer_count,created_at,visibility')
      .single()
    throwOnError(insertError)
    if (!session) throw new Error('Supabase did not return the new livestream session.')

    if (audienceIds.length) {
      const { error: inviteError } = await admin.from('live_session_invites').insert(
        audienceIds.map(userId => ({ live_session_id: session.id, user_id: userId }))
      )
      if (inviteError) {
        const { error: cleanupError } = await admin.from('live_sessions').delete().eq('id', session.id).eq('host_id', viewerId)
        if (cleanupError) console.error('Failed to clean up livestream after invite creation failed:', cleanupError)
        throwOnError(inviteError)
      }
    }

    const { error: endPreviousError } = await admin.from('live_sessions')
      .update({ is_active: false })
      .eq('host_id', viewerId)
      .eq('is_active', true)
      .neq('id', session.id)
    if (endPreviousError) {
      const { error: cleanupError } = await admin.from('live_sessions').delete().eq('id', session.id).eq('host_id', viewerId)
      if (cleanupError) console.error('Failed to clean up incomplete livestream start:', cleanupError)
      throwOnError(endPreviousError)
    }
    return jsonResponse(201, { message: 'Livestream started successfully', session }, headers)
  }

  const titleMatch = route.match(/^\/live\/([^/]+)\/title$/)
  if (titleMatch && method === 'PATCH' && viewerId) {
    const [, sessionId] = titleMatch
    const body = await request.json()
    const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 100) : ''
    if (!title) return jsonResponse(400, { error: 'Livestream title is required' }, headers)
    if (violatesGuidelines(title)) return jsonResponse(422, { error: GUIDELINES_MESSAGE, code: 'guidelines' }, headers)
    const { data: session, error } = await admin.from('live_sessions')
      .update({ title })
      .eq('id', sessionId)
      .eq('host_id', viewerId)
      .eq('is_active', true)
      .select('id,title')
      .maybeSingle()
    throwOnError(error)
    if (!session) return jsonResponse(404, { error: 'Livestream not found' }, headers)
    return jsonResponse(200, { session }, headers)
  }

  const heartbeatMatch = route.match(/^\/live\/([^/]+)\/heartbeat$/)
  if (heartbeatMatch && method === 'POST' && viewerId) {
    const body = await request.json().catch(() => ({}))
    const viewerCount = Math.max(0, Math.min(100000, Number.parseInt(body?.viewer_count, 10) || 0))
    const { error } = await admin.from('live_sessions')
      .update({ viewer_count: viewerCount, last_heartbeat: new Date().toISOString() })
      .eq('id', heartbeatMatch[1])
      .eq('host_id', viewerId)
      .eq('is_active', true)
    throwOnError(error)
    return jsonResponse(200, { ok: true }, headers)
  }

  const endMatch = route.match(/^\/live\/([^/]+)\/end$/)
  if (endMatch && method === 'POST' && viewerId) {
    const [, sessionId] = endMatch
    const { error } = await admin.from('live_sessions')
      .update({ is_active: false })
      .eq('id', sessionId)
      .eq('host_id', viewerId)
    throwOnError(error)
    return jsonResponse(200, { message: 'Livestream ended successfully' }, headers)
  }

  if (!viewerId && method !== 'GET') return jsonResponse(401, { error: 'Invalid or expired session.' }, headers)

  return jsonResponse(404, { error: 'Endpoint not found' }, headers)
}

function normalizeLoginPhone(value: string): string | null {
  const digits = value.replace(/[\s().-]/g, '')
  if (!/^\+?\d{8,15}$/.test(digits)) return null
  return digits.startsWith('+') ? digits : `+${digits}`
}

// Signs in with an email, username or phone number and returns the Supabase session.
async function handlePhoneLogin(request: Request, headers: Record<string, string>): Promise<Response> {
  const body = await request.json().catch(() => null)
  const identifier = typeof body?.identifier === 'string' ? body.identifier.trim() : ''
  const password = typeof body?.password === 'string' ? body.password : ''
  const invalid = () => jsonResponse(401, { error: 'Invalid username, email, phone number or password' }, headers)
  if (!identifier || !password || identifier.length > 254) {
    return jsonResponse(400, { error: 'Enter your email, username or phone number and your password.' }, headers)
  }

  let email: string | null = null
  if (identifier.includes('@')) {
    email = identifier.toLowerCase()
  } else {
    const phone = normalizeLoginPhone(identifier)
    const byUsername = () => admin.from('users').select('email').ilike('username', identifier.replace(/[%_\\]/g, '\\$&')).limit(2)
    let found = await byUsername()
    throwOnError(found.error)
    if (!found.data?.length && phone) {
      found = await admin.from('users').select('email').in('phone', [phone, phone.slice(1)]).limit(2)
      throwOnError(found.error)
    }
    const data = found.data
    if (!data || data.length !== 1) return invalid()
    email = data[0].email
  }
  if (!email) return invalid()

  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!anonKey) throw new Error('SUPABASE_ANON_KEY is not available in this Edge Function.')
  const authClient = createClient(supabaseUrl!, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  })
  const { data: signedIn, error: signInError } = await authClient.auth.signInWithPassword({ email, password })
  if (signInError || !signedIn.session) {
    if (signInError && /confirm/i.test(signInError.message)) {
      return jsonResponse(401, { error: signInError.message }, headers)
    }
    return invalid()
  }
  return jsonResponse(200, {
    session: { access_token: signedIn.session.access_token, refresh_token: signedIn.session.refresh_token }
  }, headers)
}

// Creates an account from a phone number alone. No SMS provider is configured, so the number is not verified.
async function handlePhoneRegister(request: Request, headers: Record<string, string>): Promise<Response> {
  const body = await request.json().catch(() => null)
  const phone = typeof body?.phone === 'string' ? normalizeLoginPhone(body.phone.trim()) : null
  const password = typeof body?.password === 'string' ? body.password : ''
  if (!phone) return jsonResponse(400, { error: 'Enter a valid phone number with country code, for example +966501234567.' }, headers)
  if (password.length < 6 || password.length > 72) {
    return jsonResponse(400, { error: 'Password must be between 6 and 72 characters.' }, headers)
  }
  const { data: taken, error: takenError } = await admin.from('users').select('id').in('phone', [phone, phone.slice(1)]).limit(1)
  throwOnError(takenError)
  if (taken?.length) return jsonResponse(409, { error: 'This phone number is already registered. Please log in.' }, headers)

  const profile = {
    vynzo_profile_version: '1',
    phone,
    username: body.username,
    first_name: body.first_name,
    last_name: body.last_name,
    birth_date: body.birth_date,
    nationality: body.nationality,
    age_confirmed: body.age_confirmed === true ? 'true' : 'false',
    terms_accepted: body.terms_accepted === true ? 'true' : 'false'
  }
  // The profile trigger requires an email, so phone accounts get an internal placeholder address.
  const email = `${phone.slice(1)}@phone.vynzosocial.com`
  const { error: createError } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: profile
  })
  if (createError) {
    const message = createError.message || ''
    if (/already|registered|exists|duplicate/i.test(message)) {
      return jsonResponse(409, { error: 'This phone number or username is already registered.' }, headers)
    }
    if (/username/i.test(message)) return jsonResponse(409, { error: 'That username is already taken.' }, headers)
    if (/18|invalid|database error/i.test(message)) return jsonResponse(400, { error: 'Check your details: username, date of birth (18+), and terms must be valid.' }, headers)
    throw createError
  }

  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!anonKey) throw new Error('SUPABASE_ANON_KEY is not available in this Edge Function.')
  const authClient = createClient(supabaseUrl!, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data: signedIn, error: signInError } = await authClient.auth.signInWithPassword({ email, password })
  if (signInError || !signedIn.session) throw signInError ?? new Error('Sign-in after registration failed.')
  return jsonResponse(201, {
    session: { access_token: signedIn.session.access_token, refresh_token: signedIn.session.refresh_token }
  }, headers)
}

Deno.serve(async request => {
  const headers = corsHeaders(request.headers.get('Origin'))
  if (request.method === 'OPTIONS') return new Response('ok', { headers })

  try {
    const viewer = await getViewer(request)
    const pathSegments = new URL(request.url).pathname.split('/').filter(Boolean)
    const functionIndex = pathSegments.indexOf('vynzo-api')
    const endpointSegments = functionIndex >= 0 ? pathSegments.slice(functionIndex + 1) : pathSegments
    if (endpointSegments[0] === 'api') endpointSegments.shift()
    if (endpointSegments[0] === 'auth' && endpointSegments[1] === 'login' && request.method === 'POST') {
      return await handlePhoneLogin(request, headers)
    }
    if (endpointSegments[0] === 'auth' && endpointSegments[1] === 'register' && request.method === 'POST') {
      return await handlePhoneRegister(request, headers)
    }
    const isRead = request.method === 'GET' || request.method === 'HEAD'
    const suspensionExempt = (endpointSegments[0] === 'moderation' && endpointSegments[1] === 'report')
      || (endpointSegments[0] === 'blogs' && endpointSegments[2] === 'appeal')
    if (viewer && !isRead && !suspensionExempt) {
      const suspended = await suspensionMessage(admin, viewer.id)
      if (suspended) return jsonResponse(403, { error: suspended, code: 'suspended' }, headers)
    }
    if (endpointSegments[0] === 'live') return await handleLive(request, viewer?.id, headers)
    if (!viewer) return jsonResponse(401, { error: 'Invalid or expired session.' }, headers)
    if (endpointSegments[0] === 'blogs') return await handleBlogs(request, viewer.id, headers, admin)
    if (endpointSegments[0] === 'posts') return await handlePosts(request, viewer.id, headers)
    if (endpointSegments[0] === 'users') return await handleUsers(request, viewer.id, headers)
    if (endpointSegments[0] === 'moderation') return await handleModeration(request, viewer.id, headers)
    if (endpointSegments[0] === 'messages') {
      return await handleMessages(request, viewer.id, headers)
    }
    const storyModerationRoute = endpointSegments.length === 3
      && endpointSegments[0] === 'stories'
      && endpointSegments[2] === 'moderate'
    if (endpointSegments[0] === 'stories' && !storyModerationRoute) {
      return await handleStories(request, viewer.id, headers)
    }
    return jsonResponse(404, { error: 'Endpoint not found' }, headers)
  } catch (error) {
    console.error('Vynzo Edge Function error:', error)
    const { code, name, status } = getErrorMetadata(error)
    if (error instanceof TypeError && /fetch|network|connection/i.test(error.message)) {
      return jsonResponse(503, { error: 'Supabase could not be reached from this Edge Function. Check the project status and function network logs.' }, headers)
    }
    if (name?.toLowerCase().includes('storage')) {
      if (status === 403) {
        return jsonResponse(403, { error: 'Supabase Storage denied this upload. Verify the bucket configuration and access policy.' }, headers)
      }
      if (status === 413) {
        return jsonResponse(413, { error: 'Supabase Storage rejected this upload because it exceeds the configured file-size limit.' }, headers)
      }
      return jsonResponse(status && status >= 400 && status < 500 ? status : 502, {
        error: 'Supabase Storage could not complete this upload. Check the bucket configuration and Storage logs.'
      }, headers)
    }
    if (code === '42501' || status === 403) {
      return jsonResponse(403, { error: 'Supabase denied this operation. Verify database grants, RLS policies, and Storage access rules.' }, headers)
    }
    if (code === '23505') {
      return jsonResponse(409, { error: 'A record with the supplied value already exists.' }, headers)
    }
    if (code === '23514' || code?.startsWith('22')) {
      return jsonResponse(400, { error: 'The submitted data is invalid.' }, headers)
    }
    if (code === 'PGRST202' || code === 'PGRST204' || code === 'PGRST205') {
      return jsonResponse(503, { error: 'Supabase Data API schema or permissions are not configured for this operation.' }, headers)
    }
    return jsonResponse(500, { error: 'Supabase could not complete the request.' }, headers)
  }
})
