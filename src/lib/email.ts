/*
 * Teacher sign-up email rules (sign-in is never affected, so existing accounts keep working):
 *   1. a well-formed address at a real-looking domain
 *   2. not a placeholder / reserved domain (example.com, test.com, localhost ...)
 *   3. not a disposable / temporary mailbox service
 *   4. a likely typo of a popular provider (gmial.com, hotmal.com ...) is stopped with a "did you mean" hint
 * Gmail's dots and "+tag" never create a second identity: a.b+x@gmail.com and ab@gmail.com are the same mailbox.
 * Limit: this runs offline in the browser, so it cannot confirm that a mailbox really exists or that its owner can
 * read it; the disposable list covers the well-known services, not every one that exists.
 */

/** Mainstream providers (always accepted, and used to catch typos of them). */
export const POPULAR_PROVIDERS = [
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.in', 'yahoo.co.in', 'yahoo.co.uk', 'ymail.com', 'outlook.com', 'outlook.in', 'hotmail.com', 'hotmail.co.uk',
  'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'zoho.com', 'zohomail.in', 'rediffmail.com', 'mail.com',
  'gmx.com', 'gmx.net', 'yandex.com', 'fastmail.com', 'hey.com', 'rocketmail.com',
]

/** Well-known disposable / temporary email services (a domain or any subdomain of it is rejected). */
const DISPOSABLE = new Set([
  'mailinator.com', 'mailinator.net', 'mailinator2.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.biz', 'guerrillamail.de', 'guerrillamailblock.com',
  'grr.la', 'sharklasers.com', 'pokemail.net', 'spam4.me', '10minutemail.com', '10minutemail.net', '10minutemail.co.uk', '20minutemail.com', '30minutemail.com', '60minutemail.com',
  'temp-mail.org', 'temp-mail.io', 'temp-mail.ru', 'tempmail.com', 'tempmail.net', 'tempmail.org', 'tempmail.dev', 'tempmail.email', 'tempmail.plus', 'tempmailo.com', 'tempmailaddress.com',
  'tempail.com', 'tempinbox.com', 'tempr.email', 'tmpmail.org', 'tmpmail.net', 'tmail.ws', 'trashmail.com', 'trashmail.net', 'trashmail.de', 'trashmail.io', 'trash-mail.com', 'trashmail.me',
  'yopmail.com', 'yopmail.net', 'yopmail.fr', 'cool.fr.nf', 'jetable.org', 'nospam.ze.tc', 'getnada.com', 'nada.email', 'nada.ltd', 'throwawaymail.com', 'throwaway.email',
  'dispostable.com', 'discard.email', 'discardmail.com', 'discardmail.de', 'fakeinbox.com', 'fakemail.net', 'fakemailgenerator.com', 'maildrop.cc', 'mailnesia.com', 'mailcatch.com',
  'mintemail.com', 'mohmal.com', 'moakt.com', 'moakt.cc', 'emailondeck.com', 'burnermail.io', 'mytemp.email', 'mailtemp.info', 'mail-temp.com', 'instantemailaddress.com',
  'spamgourmet.com', 'spambox.us', 'spamex.com', 'spamfree24.org', 'mailforspam.com', 'mailsac.com', 'inboxbear.com', 'inboxkitten.com', 'mail.tm', 'emailfake.com', 'email-fake.com',
  'fakeinbox.email', 'dropmail.me', 'anonbox.net', 'anonymbox.com', 'airmail.cc', 'bccto.me', 'byom.de', 'cuvox.de', 'dayrep.com', 'einrot.com', 'fleckens.hu', 'gustr.com',
  'jourrapide.com', 'rhyta.com', 'superrito.com', 'teleworm.us', 'armyspy.com', 'zippymail.info', 'harakirimail.com', 'deadaddress.com', 'mailexpire.com', 'mailmoat.com',
  'mailnull.com', 'meltmail.com', 'mt2015.com', 'mvrht.net', 'nwldx.com', 'owlpic.com', 'sogetthis.com', 'sneakemail.com', 'tafmail.com', 'thankyou2010.com', 'trbvm.com',
  'wegwerfmail.de', 'wegwerfmail.net', 'wegwerfemail.de', 'zehnminutenmail.de', 'kasmail.com', 'linshiyouxiang.net', 'etranquil.com', 'eelmail.com', 'getairmail.com',
  'incognitomail.com', 'incognitomail.org', 'mailzilla.com', 'mailtothis.com', 'my10minutemail.com', 'oneoffmail.com', 'onewaymail.com', 'rmqkr.net', 'safetymail.info',
  'selfdestructingmail.com', 'smashmail.de', 'snkmail.com', 'spoofmail.de', 'binkmail.com', 'bobmail.info', 'chammy.info', 'dingbone.com', 'fudgerub.com', 'lookugly.com',
  'lroid.com', 'smellfear.com', 'tradermail.info', 'veryrealemail.com', 'vomoto.com', 'wuzupmail.net', 'xagloo.com', 'yuurok.com', 'zoemail.org', 'crazymailing.com', 'cmail.club',
])
/** Words that appear in the name of nearly every disposable service not on the list above. */
const DISPOSABLE_WORDS = /(tempmail|temp-mail|tempemail|trashmail|trash-mail|throwaway|disposable|guerrillamail|mailinator|10minute|20minute|minutemail|yopmail|burnermail|fakeinbox|fakemail|spambox|spamgourmet|discardmail|getnada|mohmal|dropmail|emailondeck|maildrop)/i

/** Not real: placeholder, documentation and reserved names. */
const RESERVED_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'example.edu', 'test.com', 'test.org', 'test.net', 'tests.com', 'domain.com', 'email.com', 'mail.test', 'localhost', 'invalid.com', 'yourdomain.com', 'sample.com', 'nomail.com', 'noemail.com', 'none.com', 'abc.com', 'xyz.com', 'asdf.com'])
const RESERVED_TLDS = new Set(['test', 'example', 'invalid', 'localhost', 'local', 'internal', 'lan', 'home', 'corp', 'onion', 'arpa'])

/** Obvious misspellings of the big providers. */
const TYPOS: Record<string, string> = {
  'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gnail.com': 'gmail.com', 'gmail.co': 'gmail.com', 'gmail.con': 'gmail.com',
  'gmail.cm': 'gmail.com', 'gmail.om': 'gmail.com', 'gmail.comm': 'gmail.com', 'gmaill.com': 'gmail.com', 'gmeil.com': 'gmail.com', 'gimail.com': 'gmail.com', 'gmailcom.com': 'gmail.com', 'gmail.in': 'gmail.com',
  'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yahoo.con': 'yahoo.com', 'yahoo.co': 'yahoo.com', 'yhoo.com': 'yahoo.com', 'yaoo.com': 'yahoo.com',
  'hotmial.com': 'hotmail.com', 'hotmal.com': 'hotmail.com', 'hotmail.con': 'hotmail.com', 'hotmai.com': 'hotmail.com', 'hotnail.com': 'hotmail.com',
  'outlok.com': 'outlook.com', 'outloook.com': 'outlook.com', 'outlook.con': 'outlook.com', 'outllok.com': 'outlook.com', 'iclod.com': 'icloud.com', 'icloud.con': 'icloud.com', 'icoud.com': 'icloud.com',
}

const LOCAL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/i
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i

export type EmailCheck = { ok: true; email: string; canonical: string } | { ok: false; code: 'empty' | 'format' | 'reserved' | 'disposable' | 'typo'; reason: string }


export const isDisposableDomain = (domain: string): boolean => {
  const d = domain.toLowerCase()
  const parts = d.split('.')
  for (let i = 0; i < parts.length - 1; i++) if (DISPOSABLE.has(parts.slice(i).join('.'))) return true // the domain or any parent of it
  return DISPOSABLE_WORDS.test(parts.slice(0, -1).join('.'))
}

/** Gmail ignores dots and "+tags" in the part before the @; everything else is compared as typed (lower-cased). */
export function canonicalEmail(email: string): string {
  const e = email.trim().toLowerCase()
  const at = e.lastIndexOf('@')
  if (at < 1) return e
  let local = e.slice(0, at)
  let domain = e.slice(at + 1)
  if (domain === 'googlemail.com') domain = 'gmail.com'
  if (domain === 'gmail.com') local = local.split('+')[0].replace(/\./g, '')
  return `${local}@${domain}`
}

const editDistance1 = (a: string, b: string): boolean => {
  if (a === b) return false
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0, j = 0, diff = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue }
    if (++diff > 1) return false
    if (a.length > b.length) i++
    else if (a.length < b.length) j++
    else { i++; j++ }
  }
  return diff + (a.length - i) + (b.length - j) <= 1
}

export function checkEmail(raw: string): EmailCheck {
  const email = (raw ?? '').trim().toLowerCase()
  if (!email) return { ok: false, code: 'empty', reason: 'Enter your email address.' }
  const bad = (reason: string): EmailCheck => ({ ok: false, code: 'format', reason })
  if (email.length > 254 || /\s/.test(email)) return bad('Enter a valid email address, like name@gmail.com.')
  const at = email.indexOf('@')
  if (at < 1 || at !== email.lastIndexOf('@') || at === email.length - 1) return bad('Enter a valid email address, like name@gmail.com.')
  const local = email.slice(0, at), domain = email.slice(at + 1)
  if (local.length > 64 || !LOCAL_RE.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return bad('That email address has characters that are not allowed.')
  const labels = domain.split('.')
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) return bad('The part after @ is not a real domain (for example gmail.com).')
  const tld = labels[labels.length - 1]
  if (!/^[a-z]{2,24}$/.test(tld)) return bad('The part after @ must end like .com, .in or .org.')
  if (RESERVED_DOMAINS.has(domain) || RESERVED_TLDS.has(tld)) return { ok: false, code: 'reserved', reason: 'Use your real email address \u2014 placeholder addresses like example.com are not accepted.' }
  if (isDisposableDomain(domain)) return { ok: false, code: 'disposable', reason: 'Temporary / disposable email addresses are not accepted. Use your own Gmail, Outlook or work email.' }
  if (!POPULAR_PROVIDERS.includes(domain)) {
    const fix = TYPOS[domain] ?? POPULAR_PROVIDERS.slice(0, 12).find((p) => editDistance1(domain, p))
    if (fix) return { ok: false, code: 'typo', reason: `Did you mean ${local}@${fix}? "${domain}" looks like a typo.` }
  }
  return { ok: true, email, canonical: canonicalEmail(email) }
}
