import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import AuthScreen from '../src/components/AuthScreen'
import { StatusList } from '../src/components/Lists'
import { canonicalEmail, checkEmail, isDisposableDomain, POPULAR_PROVIDERS } from '../src/lib/email'
import { cachedTeacher, signIn, signUp } from '../src/lib/auth'
import { seedFakeUser } from './fakeCloud'
import { stu } from './helpers'

beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const bad = (e: string) => { const r = checkEmail(e); return r.ok ? null : r }

describe('Valid addresses (EM)', () => {
  it('EM-01 mainstream and custom-domain addresses are accepted and normalised', () => {
    for (const e of ['priya@gmail.com', 'Priya.Sharma@Gmail.COM', ' priya+school@gmail.com ', 'a_b-c@outlook.com', 'x@yahoo.co.in', 'me@icloud.com', 'teacher@brightminds.in', 'info@school.edu.in', 'n@proton.me', 'o\'brien@gmx.com', 'user@sub.company.co.uk', 'a@mail.com']) {
      const r = checkEmail(e)
      expect(r.ok, e).toBe(true)
      if (r.ok) expect(r.email).toBe(e.trim().toLowerCase())
    }
  })
  it('EM-02 every popular provider on the list is accepted', () => {
    for (const d of POPULAR_PROVIDERS) expect(checkEmail(`someone@${d}`).ok, d).toBe(true)
  })
})

describe('Malformed addresses are rejected (EF)', () => {
  it('EF-01 each kind of malformed input gets a reason', () => {
    for (const e of ['', '   ', 'plain', '@gmail.com', 'a@', 'a@b', 'a@gmail', 'a@@gmail.com', 'a b@gmail.com', 'a@gma il.com', '.a@gmail.com', 'a.@gmail.com', 'a..b@gmail.com',
      'a@-gmail.com', 'a@gmail-.com', 'a@gmail..com', 'a@.com', 'a@gmail.c', 'a@gmail.123', 'a@gmail.c0m', '<script>@gmail.com', 'a,b@gmail.com', 'a@gmail.com.', 'a(b)@gmail.com',
      `${'x'.repeat(65)}@gmail.com`, `a@${'x'.repeat(64)}.com`, `a@${'x.'.repeat(130)}com`]) {
      const r = bad(e); expect(r, JSON.stringify(e)).not.toBeNull(); expect(r!.reason.length).toBeGreaterThan(5)
    }
  })
  it('EF-02 hostile input never throws', () => {
    for (const e of ['\u0000@gmail.com', 'a@\u202egmail.com', '"quoted"@gmail.com', 'a@[127.0.0.1]', 'a@1.2.3.4', null as unknown as string, undefined as unknown as string, '\n', 'a'.repeat(5000)]) expect(() => checkEmail(e)).not.toThrow()
    expect(bad('a@[127.0.0.1]')).not.toBeNull(); expect(bad('a@1.2.3.4')).not.toBeNull()
  })
})

describe('Temporary / disposable addresses are rejected (ED)', () => {
  it('ED-01 well-known disposable services', () => {
    for (const d of ['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'temp-mail.org', 'tempmail.com', 'yopmail.com', 'sharklasers.com', 'trashmail.com', 'getnada.com', 'maildrop.cc', 'throwawaymail.com', 'dispostable.com', 'mohmal.com', 'fakeinbox.com', 'mail.tm', 'dropmail.me', 'emailondeck.com', 'burnermail.io']) {
      const r = bad(`someone@${d}`); expect(r?.code, d).toBe('disposable'); expect(r!.reason).toMatch(/Temporary|disposable/i)
    }
  })
  it('ED-02 subdomains of a disposable service and look-alike names are caught too', () => {
    for (const d of ['x.mailinator.com', 'a.b.guerrillamail.net', 'my-tempmail-box.xyz', 'cheap10minutemail.store', 'super-throwaway-mail.online', 'disposable-inbox.site']) expect(bad(`a@${d}`)?.code, d).toBe('disposable')
    expect(isDisposableDomain('mailinator.com')).toBe(true); expect(isDisposableDomain('gmail.com')).toBe(false)
  })
  it('ED-03 normal domains that merely share letters are NOT flagged', () => {
    for (const d of ['gmail.com', 'templeschool.in', 'burnerton-academy.org', 'minuteman.edu', 'tempo-learning.com', 'guerra-tutors.com']) expect(bad(`a@${d}`)?.code, d).not.toBe('disposable')
  })
})

describe('Placeholder domains and typos (EP / ET)', () => {
  it('EP-01 placeholder / reserved domains are refused', () => {
    for (const d of ['example.com', 'example.org', 'test.com', 'domain.com', 'localhost.test', 'mail.invalid', 'x.example', 'host.local', 'a.localhost', 'email.com']) expect(bad(`a@${d}`)?.code, d).toBe('reserved')
  })
  it('ET-01 common typos of big providers are stopped with a "did you mean"', () => {
    for (const [typo, fix] of [['gmial.com', 'gmail.com'], ['gmail.con', 'gmail.com'], ['gmail.co', 'gmail.com'], ['gnail.com', 'gmail.com'], ['hotmal.com', 'hotmail.com'], ['yaho.com', 'yahoo.com'], ['outlok.com', 'outlook.com'], ['gmaail.com', 'gmail.com']]) {
      const r = bad(`riya@${typo}`); expect(r?.code, typo).toBe('typo'); expect(r!.reason).toContain(`riya@${fix}`)
    }
  })
  it('ET-02 genuine different domains are not mistaken for typos', () => {
    for (const d of ['gmx.com', 'mail.com', 'live.com', 'me.com', 'aol.com', 'brightminds.in', 'yahoo.in', 'zoho.com', 'hey.com']) expect(checkEmail(`a@${d}`).ok, d).toBe(true)
  })
})

describe('One mailbox = one account (EC)', () => {
  it('EC-01 gmail dots, +tags and googlemail.com all map to the same mailbox; other providers keep their dots', () => {
    const c = canonicalEmail
    expect(c('A.B.C+school@Gmail.com')).toBe('abc@gmail.com'); expect(c('abc@googlemail.com')).toBe('abc@gmail.com')
    expect(c('a.b@outlook.com')).toBe('a.b@outlook.com'); expect(c('a.b@outlook.com')).not.toBe(c('ab@outlook.com'))
  })
  it('EC-02 sign-up refuses a second account for the same Gmail mailbox, but allows a different mailbox', async () => {
    await signUp('Priya', 'priya.sharma@gmail.com', 'secret1', '{}')
    await expect(signUp('Priya 2', 'priyasharma+x@gmail.com', 'secret1', '{}')).rejects.toThrow(/already exists/)
    await expect(signUp('Priya 3', 'PRIYA.SHARMA@googlemail.com', 'secret1', '{}')).rejects.toThrow(/already exists/)
    await expect(signUp('Ravi', 'ravi@gmail.com', 'secret1', '{}')).resolves.toBeTruthy()
  })
})

describe('Sign-up and sign-in enforcement (EA)', () => {
  it('EA-01 signUp throws the exact reason and creates nothing for bad / temporary / placeholder / typo emails', async () => {
    for (const [e, re] of [['x@mailinator.com', /Temporary/], ['x@example.com', /real email/], ['x@gmial.com', /Did you mean x@gmail.com/], ['nope', /valid email/], ['', /Enter your email/]] as const) {
      await expect(signUp('T', e, 'secret1', '{}'), e).rejects.toThrow(re)
    }
    expect(cachedTeacher()).toBeNull()
  })
  it('EA-02 the email is stored trimmed and lower-case', async () => {
    const t = await signUp('T', '  Teacher@Gmail.COM ', 'secret1', '{}')
    expect(t.email).toBe('teacher@gmail.com')
    await expect(signIn('TEACHER@gmail.com ', 'secret1')).resolves.toBeTruthy()
  })
  it('EA-03 existing accounts are never locked out: an older account on a now-rejected domain can still sign in', async () => {
    seedFakeUser('old@example.com', 'secret1', 'Old Teacher')
    await expect(signIn('old@example.com', 'whatever')).rejects.toThrow(/incorrect/)   // fails only on the password, not on the email rules
    await expect(signIn('old@example.com', 'secret1')).resolves.toMatchObject({ email: 'old@example.com' })
    expect(bad('old@example.com')).not.toBeNull()                                       // ...even though new sign-ups with it are refused
  })
})

describe('Sign-up screen (UI)', () => {
  const fill = (v: string) => fireEvent.change(screen.getByLabelText('Email'), { target: { value: v } })
  const toSignUp = () => fireEvent.click(screen.getByRole('tab', { name: 'Create account' }))

  it('UI-01 shows the reason as you type a temporary address, marks the field invalid, and blocks submit', async () => {
    render(<AuthScreen onAuth={vi.fn()} />)
    toSignUp()
    fill('riya@mailinator.com')
    expect(screen.getByRole('alert').textContent).toMatch(/Temporary \/ disposable/)
    expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBe('true')
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Riya' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret1' } })
    fireEvent.click(screen.getByRole('button', { name: /Create account/ }))
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0))
    expect(cachedTeacher()).toBeNull()
  })
  it('UI-02 a typo suggests the fix; a good Gmail clears the message and signs up', async () => {
    const onAuth = vi.fn()
    render(<AuthScreen onAuth={onAuth} />)
    toSignUp()
    fill('riya@gmial.com')
    expect(screen.getByRole('alert').textContent).toMatch(/Did you mean riya@gmail\.com/)
    fill('riya@gmail.com')
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Riya' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret1' } })
    fireEvent.click(screen.getByRole('button', { name: /Create account/ }))
    await waitFor(() => expect(onAuth).toHaveBeenCalled())
    expect(cachedTeacher()?.email).toBe('riya@gmail.com')
  })
  it('UI-03 a half-typed address is not nagged until the field is left (format errors wait for blur)', () => {
    render(<AuthScreen onAuth={vi.fn()} />)
    toSignUp()
    fill('riya@gm')
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.blur(screen.getByLabelText('Email'))
    expect(screen.getByRole('alert').textContent).toMatch(/real domain|valid email/)
  })
  it('UI-04 the sign-in tab applies no email rules, so older accounts are never blocked', () => {
    render(<AuthScreen onAuth={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Sign in' }))
    fill('old@example.com'); fireEvent.blur(screen.getByLabelText('Email'))
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('UI-05 the hint tells new users what is accepted', () => {
    render(<AuthScreen onAuth={vi.fn()} />)
    toSignUp()
    expect(document.body.textContent).toMatch(/Temporary emails are not accepted/)
    expect((screen.getByLabelText('Email') as HTMLInputElement).placeholder).toBe('you@gmail.com')
  })
})

describe('Message button colour per tab (MC)', () => {
  const list = (status: 'present' | 'absent', layout: 'list' | 'grid') =>
    render(<StatusList students={[stu('s1', 'Rohan Gupta', '01')]} status={status} layout={layout} locked={false} onSet={() => {}} onLockedTap={() => {}} onMessage={() => {}} />)
  const btn = () => screen.getByRole('button', { name: 'Message Rohan Gupta on WhatsApp' })

  it('MC-01 Present tab: the message button is green (both list and card layouts)', () => {
    for (const layout of ['list', 'grid'] as const) {
      const { unmount } = list('present', layout)
      expect(btn().style.background).toMatch(/#00a884/i); expect(btn().style.background).not.toMatch(/#d92d3a/i); expect(btn().getAttribute('data-tone')).toBe('green')
      unmount()
    }
  })
  it('MC-02 Absent tab: it stays red', () => {
    for (const layout of ['list', 'grid'] as const) {
      const { unmount } = list('absent', layout)
      expect(btn().style.background).toMatch(/#d92d3a/i); expect(btn().style.background).not.toMatch(/#00a884/i); expect(btn().getAttribute('data-tone')).toBe('red')
      unmount()
    }
  })
  it('MC-03 it works the same on both tabs: tapping calls onMessage', () => {
    const onMessage = vi.fn()
    render(<StatusList students={[stu('s1', 'Rohan Gupta', '01')]} status="present" layout="list" locked={false} onSet={() => {}} onLockedTap={() => {}} onMessage={onMessage} />)
    fireEvent.click(btn()); expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }))
  })
})
