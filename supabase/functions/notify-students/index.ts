// notify-students — Web Push fan-out for the Student Hub.
//
// The teacher app calls this straight after it publishes a live class or a new note:
//   POST /functions/v1/notify-students   { "kind": "live" | "note", "id": "<uuid>" }
//   Authorization: Bearer <teacher access token>
//
// The function never trusts the caller for scope. It loads the row it was told about, proves the
// caller owns it, then alerts only the phones whose student row is in that same batch and still
// holds the very device token the subscription was created with. A paused student, an unlinked
// phone or a student who moved batch therefore cannot be alerted.
//
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.
// GET returns a small health probe (no secrets) so a deploy can be checked in a browser.

import { createClient } from 'npm:@supabase/supabase-js@2'

const enc = new TextEncoder()

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

/* ---------------------------------------------------------------- base64url helpers */

function b64uToBytes(value: string): Uint8Array {
  const normalised = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4)
  const raw = atob(padded)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

function bytesToB64u(bytes: Uint8Array): string {
  let raw = ''
  for (const byte of bytes) raw += String.fromCharCode(byte)
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/* ---------------------------------------------------------------- RFC 8291 payload encryption */

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8)
  return new Uint8Array(bits)
}

/** aes128gcm body: salt(16) | rs(4) | idlen(1) | as_public(65) | ciphertext. */
async function encryptPayload(
  payload: Uint8Array,
  p256dh: string,
  authSecret: string,
): Promise<Uint8Array> {
  const uaPublic = b64uToBytes(p256dh)
  const auth = b64uToBytes(authSecret)
  if (uaPublic.length !== 65) throw new Error('bad-p256dh')
  if (auth.length !== 16) throw new Error('bad-auth')

  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey))
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256),
  )

  const info = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic)
  const prk = await hkdf(auth, shared, info, 32)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, prk, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, prk, enc.encode('Content-Encoding: nonce\0'), 12)

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  // 0x02 marks the last (only) record, per RFC 8188.
  const record = concat(payload, new Uint8Array([2]))
  const cipherText = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record),
  )

  const header = new Uint8Array(21 + asPublic.length)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, 4096, false)
  header[20] = asPublic.length
  header.set(asPublic, 21)
  return concat(header, cipherText)
}

/* ---------------------------------------------------------------- VAPID (RFC 8292) */

async function vapidKey(privateKey: string, publicKey: string): Promise<CryptoKey> {
  const raw = b64uToBytes(publicKey)
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('bad-vapid-public')
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    d: privateKey,
    x: bytesToB64u(raw.slice(1, 33)),
    y: bytesToB64u(raw.slice(33, 65)),
    ext: true,
  }
  return await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}

async function vapidHeader(endpoint: string, key: CryptoKey, subject: string, publicKey: string): Promise<string> {
  const audience = new URL(endpoint).origin
  const header = bytesToB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = bytesToB64u(
    enc.encode(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })),
  )
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    enc.encode(`${header}.${claims}`),
  )
  const jwt = `${header}.${claims}.${bytesToB64u(new Uint8Array(signature))}`
  return `vapid t=${jwt}, k=${publicKey}`
}

/* ---------------------------------------------------------------- sending */

type Sub = {
  id: string
  endpoint: string
  p256dh: string
  auth: string
  device_token: string
  student_id: string
}

type PushBody = { title: string; body: string; url: string; tag: string }

async function sendOne(sub: Sub, body: PushBody, key: CryptoKey, subject: string, publicKey: string) {
  const payload = enc.encode(JSON.stringify(body))
  const encrypted = await encryptPayload(payload, sub.p256dh, sub.auth)
  const response = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      TTL: '86400',
      Urgency: 'high',
      Authorization: await vapidHeader(sub.endpoint, key, subject, publicKey),
    },
    body: encrypted,
  })
  return response
}

/* ---------------------------------------------------------------- request handling */

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const publicKey = Deno.env.get('VAPID_PUBLIC_KEY') ?? ''
  const privateKey = Deno.env.get('VAPID_PRIVATE_KEY') ?? ''
  const subject = Deno.env.get('VAPID_SUBJECT') ?? ''

  if (req.method === 'GET') {
    return json({
      ok: true,
      function: 'notify-students',
      // Never the values: only whether the deploy has what it needs.
      vapid: { public: publicKey.length > 80, private: privateKey.length > 30, subject: subject.length > 5 },
    })
  }

  if (req.method !== 'POST') return json({ error: 'method-not-allowed' }, 405)

  if (!publicKey || !privateKey || !subject) {
    return json({ error: 'push-not-configured', message: 'VAPID secrets are missing on this project.' }, 500)
  }

  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!url || !serviceKey) return json({ error: 'server-misconfigured' }, 500)

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return json({ error: 'not-signed-in', message: 'Sign in again to send alerts.' }, 401)

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

  const { data: userData, error: userError } = await admin.auth.getUser(token)
  if (userError || !userData?.user) {
    return json({ error: 'not-signed-in', message: 'Sign in again to send alerts.' }, 401)
  }

  let body: { kind?: string; id?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'bad-json' }, 400)
  }

  const kind = body.kind === 'note' ? 'note' : body.kind === 'live' ? 'live' : ''
  const id = typeof body.id === 'string' ? body.id : ''
  if (!kind || !id) return json({ error: 'bad-request', message: 'kind and id are required.' }, 400)

  let teacherId = ''
  let batch = ''
  let push: PushBody

  if (kind === 'live') {
    const { data: meeting, error } = await admin
      .from('live_meetings')
      .select('id, teacher_id, batch_name, meeting_title, topic, teacher_name, scheduled_start, expires_at, status')
      .eq('id', id)
      .maybeSingle()
    if (error) return json({ error: 'lookup-failed', message: error.message }, 500)
    if (!meeting) return json({ error: 'not-found' }, 404)
    if (meeting.teacher_id !== userData.user.id) return json({ error: 'not-your-class' }, 403)

    const { data: state } = await admin.rpc('student_hub_meeting_state', {
      p_scheduled_start: meeting.scheduled_start,
      p_expires_at: meeting.expires_at,
      p_status: meeting.status,
    })
    if (state !== 'live') return json({ ok: true, sent: 0, skipped: 'not-live' })

    teacherId = meeting.teacher_id
    batch = meeting.batch_name
    const title = String(meeting.meeting_title ?? meeting.topic ?? 'Live class')
    push = {
      title: `Live now · ${batch}`,
      body: `${title} — tap to join`,
      url: './?open=live',
      tag: `live-${meeting.id}`,
    }
  } else {
    const { data: note, error } = await admin
      .from('student_notes')
      .select('id, teacher_id, batch_name, title, subject, kind')
      .eq('id', id)
      .maybeSingle()
    if (error) return json({ error: 'lookup-failed', message: error.message }, 500)
    if (!note) return json({ error: 'not-found' }, 404)
    if (note.teacher_id !== userData.user.id) return json({ error: 'not-your-note' }, 403)

    teacherId = note.teacher_id
    batch = note.batch_name
    push = {
      title: `New note · ${note.subject || 'General'}`,
      body: String(note.title ?? 'New study material'),
      url: './?open=notes',
      tag: `note-${note.id}`,
    }
  }

  // Scope: this teacher, this batch, and only phones whose device token is still the current one.
  const { data: subs, error: subError } = await admin
    .from('student_push_subs')
    .select('id, endpoint, p256dh, auth, device_token, student_id')
    .eq('teacher_id', teacherId)
    .eq('batch_name', batch)
  if (subError) return json({ error: 'lookup-failed', message: subError.message }, 500)

  if (!subs || subs.length === 0) {
    return json({ ok: true, sent: 0, failed: 0, pruned: 0, students: 0, message: 'No student has alerts on for this batch yet.' })
  }

  const { data: students } = await admin
    .from('students')
    .select('id, device_token, batch_name, is_activated, access_status')
    .in('id', [...new Set(subs.map((s: Sub) => s.student_id))])

  const live = new Map<string, { device_token: string | null; batch_name: string; is_activated: boolean; access_status: string }>()
  for (const student of students ?? []) live.set(student.id, student)

  let key: CryptoKey
  try {
    key = await vapidKey(privateKey, publicKey)
  } catch {
    return json({ error: 'bad-vapid-secret', message: 'The VAPID key pair on this project is not usable.' }, 500)
  }

  let sent = 0
  let failed = 0
  let pruned = 0
  const reached = new Set<string>()

  for (const sub of subs as Sub[]) {
    const student = live.get(sub.student_id)
    const stillValid =
      student &&
      student.is_activated &&
      student.access_status === 'active' &&
      student.batch_name === batch &&
      student.device_token === sub.device_token

    if (!stillValid) {
      await admin.from('student_push_subs').delete().eq('id', sub.id)
      pruned += 1
      continue
    }

    try {
      const response = await sendOne(sub, push, key, subject, publicKey)
      if (response.ok) {
        sent += 1
        reached.add(sub.student_id)
        await admin.from('student_push_subs').update({ last_sent_at: new Date().toISOString() }).eq('id', sub.id)
      } else if (response.status === 404 || response.status === 410) {
        // The browser dropped this subscription: keep the table honest.
        await admin.from('student_push_subs').delete().eq('id', sub.id)
        pruned += 1
      } else {
        failed += 1
        console.error('push failed', response.status, await response.text().catch(() => ''))
      }
    } catch (error) {
      failed += 1
      console.error('push threw', error instanceof Error ? error.message : String(error))
    }
  }

  return json({ ok: failed === 0, sent, failed, pruned, students: reached.size })
})
