import { createClient } from 'npm:@supabase/supabase-js@2.91.0'

const supabaseUrl = Deno.env.get('SUPABASE_URL')
const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}')
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || secretKeys.default

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Supabase URL and a server-side secret API key are required.')
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false }
})

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
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Vary': 'Origin'
  }
  if (origin && (allowedOrigins.has(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin))) {
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
    headers: { ...headers, 'Content-Type': 'application/json' }
  })
}

function throwOnError(error: { message: string } | null): void {
  if (error) throw new Error(error.message)
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
  if (error && 'status' in error && (error.status === 401 || error.status === 403)) return null
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

async function getUserSummaries(userIds: string[], withCounts = true) {
  if (!userIds.length) return new Map()
  const { data: users, error } = await admin.from('users')
    .select('id,username,display_name,avatar_url,is_private')
    .in('id', userIds)
  throwOnError(error)
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
    friends_count: friendCounts.get(user.id) || 0
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
  const accountAllowsPost = owner.posts_privacy !== 'only_me'
    && ((owner.posts_privacy !== 'friends' && !owner.is_private) || isFriend)
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

  const [{ data: owner, error: ownerError }, friends] = await Promise.all([
    admin.from('users').select('id,is_private,posts_privacy').eq('id', post.user_id).maybeSingle(),
    getAcceptedConnections(viewerId)
  ])
  throwOnError(ownerError)
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

  const [{ data: owner, error: ownerError }, friends] = await Promise.all([
    admin.from('users').select('id,is_private').eq('id', story.user_id).maybeSingle(),
    getAcceptedConnections(viewerId)
  ])
  throwOnError(ownerError)
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
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9._]{1,28}[a-zA-Z0-9])$/.test(username)) {
      return jsonResponse(400, { error: 'Username must be 3–30 characters and use only letters, numbers, periods, and underscores.' }, headers)
    }
    if (bio.length > 500) return jsonResponse(400, { error: 'Bio must be 500 characters or fewer.' }, headers)
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
      getUserSummaries(outgoingIds, false)
    ])
    throwOnError(incomingError)
    const friendIds = new Set((incoming || []).map(row => row.follower_id))
    const friends = outgoingIds.filter(id => friendIds.has(id)).map(id => ({
      ...summaries.get(id),
      live_session_id: null,
      live_title: null,
      viewer_count: null,
      is_live: false
    })).sort((a, b) => String(a.display_name || a.username).localeCompare(String(b.display_name || b.username)))
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
      getUserSummaries(candidateIds)
    ])
    const users = candidateIds.filter(id => type === 'followers' || status.get(id)?.following)
      .map(id => ({
        ...summaries.get(id),
        follow_status: status.get(id)?.following ? 'accepted' : null,
        follows_me: true,
        is_friend: Boolean(status.get(id)?.following),
        is_following: Boolean(status.get(id)?.following),
        follow_requested: false,
        is_live: false,
        live_session_id: null,
        live_title: null
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
      getUserSummaries(candidateIds)
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
    const [usernameResults, displayNameResults] = await Promise.all([
      admin.from('users').select('id,username,display_name,avatar_url,is_private')
        .neq('id', viewerId).ilike('username', pattern).limit(20),
      admin.from('users').select('id,username,display_name,avatar_url,is_private')
        .neq('id', viewerId).ilike('display_name', pattern).limit(20)
    ])
    throwOnError(usernameResults.error)
    throwOnError(displayNameResults.error)
    const users = [...new Map([
      ...(usernameResults.data || []),
      ...(displayNameResults.data || [])
    ].map(user => [user.id, user])).values()].slice(0, 20)
    const ids = (users || []).map(user => user.id)
    const [followStatus, summaries] = await Promise.all([getFollowStatus(viewerId, ids), getUserSummaries(ids)])
    const results = ids.map(id => {
      const user = summaries.get(id)
      const relation = followStatus.get(id)
      const isFriend = Boolean(relation?.following && relation.followsMe)
      return {
        ...user,
        is_following: Boolean(relation?.following),
        follow_requested: false,
        follows_me: Boolean(relation?.followsMe),
        is_friend: isFriend,
        is_live: false,
        live_session_id: null,
        live_title: null
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
    const [identifierResult, relation] = await Promise.all([
      admin.schema('vynzo_private').from('user_identifiers')
        .select('vynzo_id')
        .eq('user_id', targetId)
        .maybeSingle(),
      getFollowStatus(viewerId, [targetId])
    ])
    throwOnError(identifierResult.error)
    const identifier = identifierResult.data
    const followerCount = admin.from('follows').select('follower_id', { count: 'exact', head: true }).eq('following_id', targetId).eq('status', 'accepted')
    const followingCount = admin.from('follows').select('following_id', { count: 'exact', head: true }).eq('follower_id', targetId).eq('status', 'accepted')
    const postCount = admin.from('posts').select('id', { count: 'exact', head: true }).eq('user_id', targetId)
    const [followers, following, postsResult] = await Promise.all([followerCount, followingCount, postCount])
    throwOnError(followers.error)
    throwOnError(following.error)
    throwOnError(postsResult.error)
    const isOwner = viewerId === targetId
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
    const { data: live, error: liveError } = await admin.from('live_sessions')
      .select('id,title').eq('host_id', targetId).eq('is_active', true).order('created_at', { ascending: false }).limit(1).maybeSingle()
    throwOnError(liveError)
    let likeStats: Record<string, number> | undefined
    if (isOwner) {
      const [storiesResult, imagePostsResult, videoPostsResult, blogsResult] = await Promise.all([
        admin.from('stories').select('id').eq('user_id', targetId),
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
        ...(isOwner ? { vynzo_id: identifier?.vynzo_id } : {}),
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
    return jsonResponse(200, { message: 'User blocked successfully' }, headers)
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
    const friends = await getAcceptedConnections(viewerId)
    const { data: follows, error: followsError } = await admin.from('follows')
      .select('following_id')
      .eq('follower_id', viewerId)
      .eq('status', 'accepted')
    throwOnError(followsError)
    const followedIds = new Set((follows || []).map(row => row.following_id))
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

    const [{ data: stories, error }, { data: viewer, error: viewerError }] = await Promise.all([
      query,
      admin.from('users').select('is_admin').eq('id', viewerId).maybeSingle()
    ])
    throwOnError(error)
    throwOnError(viewerError)
    const userIds = [...new Set((stories || []).map(story => story.user_id))]
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
    return jsonResponse(200, {
      comments: (comments || []).map(comment => ({
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
    const friends = await getAcceptedConnections(viewerId)
    const outgoing = await admin.from('follows')
      .select('following_id')
      .eq('follower_id', viewerId)
      .eq('status', 'accepted')
    throwOnError(outgoing.error)
    const followedIds = new Set((outgoing.data || []).map(row => row.following_id))

    let query = admin.from('posts')
      .select('id,user_id,caption,media_type,media_url,thumbnail_url,views_count,likes_count,comments_count,created_at,is_protected,privacy')
      .order('created_at', { ascending: false })
      .range(0, 999)
    if (scope === 'me') query = query.eq('user_id', viewerId)
    else if (scope !== 'all') {
      if (!followedIds.size) return jsonResponse(200, { posts: [], limit, offset }, headers)
      query = query.in('user_id', [...followedIds])
    }

    const { data: candidates, error } = await query
    throwOnError(error)
    const userIds = [...new Set((candidates || []).map(post => post.user_id))]
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
      .slice(offset, offset + limit)
    const postIds = visiblePosts.map(post => post.id)
    const { data: likedRows, error: likesError } = postIds.length
      ? await admin.from('likes').select('post_id').eq('user_id', viewerId).in('post_id', postIds)
      : { data: [], error: null }
    throwOnError(likesError)
    const likedIds = new Set((likedRows || []).map(row => row.post_id))

    return jsonResponse(200, {
      posts: visiblePosts.map(post => {
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
      caption: String(form.get('caption') || '').slice(0, 2200),
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
    return jsonResponse(200, {
      comments: (comments || []).map(comment => {
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

Deno.serve(async request => {
  const headers = corsHeaders(request.headers.get('Origin'))
  if (request.method === 'OPTIONS') return new Response('ok', { headers })

  try {
    const viewer = await getViewer(request)
    if (!viewer) return jsonResponse(401, { error: 'Invalid or expired session.' }, headers)
    const pathSegments = new URL(request.url).pathname.split('/').filter(Boolean)
    const functionIndex = pathSegments.indexOf('vynzo-api')
    const endpointSegments = functionIndex >= 0 ? pathSegments.slice(functionIndex + 1) : pathSegments
    if (endpointSegments[0] === 'api') endpointSegments.shift()
    if (endpointSegments[0] === 'posts') return await handlePosts(request, viewer.id, headers)
    if (endpointSegments[0] === 'users') return await handleUsers(request, viewer.id, headers)
    if (endpointSegments[0] === 'moderation') return await handleModeration(request, viewer.id, headers)
    const storyModerationRoute = endpointSegments.length === 3
      && endpointSegments[0] === 'stories'
      && endpointSegments[2] === 'moderate'
    if (endpointSegments[0] === 'stories' && !storyModerationRoute) {
      return await handleStories(request, viewer.id, headers)
    }
    return jsonResponse(404, { error: 'Endpoint not found' }, headers)
  } catch (error) {
    console.error('Vynzo Edge Function error:', error)
    return jsonResponse(500, { error: 'The Vynzo service could not complete the request.' }, headers)
  }
})
