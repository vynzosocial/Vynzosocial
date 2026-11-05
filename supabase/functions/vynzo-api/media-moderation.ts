const FLAG_CATEGORIES = [
  'sexual',
  'sexual/minors',
  'hate',
  'hate/threatening',
  'harassment',
  'harassment/threatening',
  'violence/graphic',
  'self-harm',
  'self-harm/intent',
  'self-harm/instructions',
]

export const MEDIA_WARNING =
  'Warning: your content was removed because it appears to violate the Vynzo community guidelines (nudity, hate, bullying or other material offensive to public decency). Repeated violations may lead to account suspension.'

export function mediaScanEnabled() {
  return Boolean(Deno.env.get('OPENAI_API_KEY'))
}

export function toDataUrl(bytes: Uint8Array, mime: string) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

// Returns true when any image is flagged, false when clean, null when scanning is unavailable.
export async function scanImages(images: string[]): Promise<boolean | null> {
  const key = Deno.env.get('OPENAI_API_KEY')
  if (!key || !images.length) return null
  let scanned = 0
  for (const url of images.slice(0, 8)) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch('https://api.openai.com/v1/moderations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: 'omni-moderation-latest',
          input: [{ type: 'image_url', image_url: { url } }],
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        console.error('Image moderation API error', response.status)
        continue
      }
      const result = (await response.json())?.results?.[0]
      scanned++
      const categories = result?.categories || {}
      if (FLAG_CATEGORIES.some((name) => categories[name] === true)) return true
    } catch (error) {
      console.error('Image moderation failed:', error)
    } finally {
      clearTimeout(timer)
    }
  }
  return scanned ? false : null
}
