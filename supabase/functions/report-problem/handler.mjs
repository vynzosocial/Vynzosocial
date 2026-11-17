const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_REQUEST = MAX_IMAGE + 64 * 1024;
const ORIGINS = new Set(['https://www.vynzosocial.com', 'https://vynzosocial.com', 'https://localhost', 'capacitor://localhost']);
const TYPES = new Map([
  ['image/jpeg', { extension: 'jpg', matches: b => b[0] === 255 && b[1] === 216 && b[2] === 255 }],
  ['image/png', { extension: 'png', matches: b => [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => b[i] === v) }],
  ['image/webp', { extension: 'webp', matches: b => String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP' }]
]);

async function readBounded(request) {
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_REQUEST)) throw new RangeError();
  if (!request.body) throw new TypeError('Missing request body');
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST) { await reader.cancel(); throw new RangeError(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function handleProblemReport(request, { authenticate, consumeLimit, sendMail, logError = console.error }) {
  const origin = request.headers.get('origin');
  const cors = { 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Cache-Control': 'no-store' };
  if (ORIGINS.has(origin)) cors['Access-Control-Allow-Origin'] = origin;
  const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  if (origin && !ORIGINS.has(origin)) return reply(403, { error: 'Origin not allowed.' });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return reply(405, { error: 'Method not allowed.' });
  try {
    const user = await authenticate(request);
    if (!user) return reply(401, { error: 'Please log in to report a problem.' });
    const contentType = request.headers.get('content-type') || '';
    if (!/^multipart\/form-data\s*;/i.test(contentType)) return reply(400, { error: 'Invalid report format.' });
    let form;
    try {
      const bytes = await readBounded(request);
      form = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData();
    } catch (error) {
      if (error instanceof RangeError) return reply(413, { error: 'The image must be 5 MB or smaller.' });
      return reply(400, { error: 'Could not read the report.' });
    }
    if (form.getAll('description').length !== 1 || form.getAll('image').length > 1) return reply(400, { error: 'Invalid report fields.' });
    const raw = form.get('description');
    const description = typeof raw === 'string' ? raw.trim() : '';
    if (!description || description.length > 4000) return reply(400, { error: 'Describe the problem in up to 4,000 characters.' });
    const image = form.get('image');
    let attachment;
    if (image !== null && !(image instanceof File)) return reply(400, { error: 'Invalid image attachment.' });
    if (image instanceof File && image.size) {
      const type = TYPES.get(image.type);
      if (!type || image.size > MAX_IMAGE) return reply(400, { error: 'Choose a JPEG, PNG or WebP image up to 5 MB.' });
      const bytes = new Uint8Array(await image.arrayBuffer());
      if (!type.matches(bytes)) return reply(400, { error: 'The attachment is not a valid image.' });
      attachment = { filename: `problem-report.${type.extension}`, content: bytes, contentType: image.type };
    }
    if (!await consumeLimit(user.id)) return reply(429, { error: 'Too many reports. Please try again later.' });
    await sendMail({ userId: user.id, description, attachment });
    return reply(200, { message: 'Your report was sent. Thank you.' });
  } catch (error) {
    logError('Problem report delivery failed:', error);
    return reply(503, { error: 'Could not send your report. Please try again later.' });
  }
}
