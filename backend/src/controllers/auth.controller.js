const jwt = require('jsonwebtoken');
const db = require('../database/db');
const { JWT_SECRET } = require('../middleware/auth.middleware');
const {
  SupabaseAuthError,
  signUpWithEmail,
  signInWithEmail,
  deleteAuthUser
} = require('../services/supabase-auth');

const TERMS_VERSION = '2026-11-01';

function parseBirthDate(dayValue, monthValue, yearValue) {
  const day = Number(dayValue);
  const month = Number(monthValue);
  const year = Number(yearValue);
  if (![day, month, year].every(Number.isInteger) || year < 1900) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  if (date.getTime() > Date.now()) return null;
  return { year, month, day, iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
}

function ageOn({ year, month, day }) {
  const now = new Date();
  let age = now.getUTCFullYear() - year;
  const hadBirthday = now.getUTCMonth() + 1 > month || (now.getUTCMonth() + 1 === month && now.getUTCDate() >= day);
  if (!hadBirthday) age -= 1;
  return age;
}

// Phone numbers are stored in international form: + and 8-15 digits.
function normalizePhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return { phone: null };
  const digits = raw.replace(/[\s().-]/g, '');
  if (!/^\+?\d{8,15}$/.test(digits)) return { error: 'Enter a valid phone number with country code, for example +966501234567.' };
  return { phone: digits.startsWith('+') ? digits : '+' + digits };
}

async function register(req, res) {
  try {
    const { username, password, age_confirmed, terms_accepted } = req.body;
    const email = String(req.body.email || '').trim().toLowerCase();
    const first_name = String(req.body.first_name || '').trim();
    const last_name = String(req.body.last_name || '').trim();
    const nationality = String(req.body.nationality || '').trim();
    if (!username || !email || !password || !first_name || !last_name || !nationality) {
      return res.status(400).json({ error: 'All fields are required, including an email address.' });
    }
    if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (first_name.length > 60 || last_name.length > 60 || nationality.length > 80) {
      return res.status(400).json({ error: 'Name or nationality is too long.' });
    }
    const birthDate = parseBirthDate(req.body.birth_day, req.body.birth_month, req.body.birth_year);
    if (!birthDate) {
      return res.status(400).json({ error: 'Please enter a valid date of birth.' });
    }
    if (ageOn(birthDate) < 18) {
      return res.status(400).json({ error: 'The date of birth entered shows that you are under 18. Check the day, month, and year; Vynzo is for people aged 18 or older.' });
    }
    const display_name = `${first_name} ${last_name}`.slice(0, 100);
    if (age_confirmed !== true) {
      return res.status(400).json({ error: 'You must confirm that you are 18 years or older to join Vynzo.' });
    }
    if (terms_accepted !== true) {
      return res.status(400).json({ error: 'You must agree to the Vynzo Terms, Community Guidelines and Conditions.' });
    }

    const existingUsername = await db.query(
      'SELECT 1 FROM users WHERE lower(username) = lower($1) LIMIT 1',
      [username]
    );
    if (existingUsername.rows.length) {
      return res.status(409).json({ error: 'That username is already in use.' });
    }

    const authResult = await signUpWithEmail(email, password);
    const authUser = authResult.user;
    if (!authUser?.id) {
      throw new Error('Supabase Auth did not return a user after signup.');
    }
    if (Array.isArray(authUser.identities) && authUser.identities.length === 0) {
      return res.status(202).json({
        message: 'If this email can be registered, Supabase will send a verification link. Existing users can log in.'
      });
    }
    if (authResult.session || authResult.access_token || authUser.email_confirmed_at) {
      try {
        await deleteAuthUser(authUser.id);
      } catch (cleanupError) {
        console.error('Unable to remove a user created without email confirmation:', cleanupError.message);
      }
      return res.status(503).json({
        error: 'Email verification is not enabled for this Supabase project. Please contact support.'
      });
    }

    const query = `
      WITH new_user AS (
        INSERT INTO users (id, username, email, display_name, age_confirmed_at, terms_accepted_at, terms_version,
                           first_name, last_name, birth_date, nationality, phone)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $5, $6, $7, $8, $9, $10)
        RETURNING id, username, email, phone, display_name, created_at
      ), new_identifier AS (
        INSERT INTO vynzo_private.user_identifiers (user_id)
        SELECT id FROM new_user
        RETURNING user_id, vynzo_id
      )
      SELECT new_user.id, new_user.username, new_user.email, new_user.phone, new_user.display_name,
             new_user.created_at, new_identifier.vynzo_id
      FROM new_user
      JOIN new_identifier ON new_identifier.user_id = new_user.id
    `;
    const values = [authUser.id, username, email, display_name, TERMS_VERSION, first_name, last_name, birthDate.iso, nationality, null];
    try {
      await db.query(query, values);
    } catch (profileError) {
      try {
        await deleteAuthUser(authUser.id);
      } catch (cleanupError) {
        console.error('Unable to remove an Auth user after profile creation failed:', cleanupError.message);
      }
      throw profileError;
    }

    res.status(202).json({
      message: `We sent a verification link to ${email}. Please verify your email before logging in.`
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That username is already in use.' });
    }
    if (err instanceof SupabaseAuthError) {
      if (err.status === 422 || err.status === 400) {
        return res.status(400).json({ error: err.message });
      }
      if (err.status === 429) {
        return res.status(429).json({ error: 'Too many verification emails were requested. Please try again later.' });
      }
    }
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function login(req, res) {
  try {
    const { password } = req.body;
    const identifier = String(req.body.identifier || req.body.email || '').trim();
    if (!identifier || !password) {
      return res.status(400).json({ error: 'Username, email or phone number and password are required' });
    }

    const isEmail = identifier.includes('@');
    const loginPhone = isEmail ? { phone: null } : normalizePhone(identifier);
    const lookup = isEmail
      ? await db.query('SELECT id, email FROM users WHERE lower(email) = lower($1) LIMIT 1', [identifier])
      : await db.query(
        `SELECT id, email FROM users WHERE ($1::text IS NOT NULL AND phone = $1) OR lower(username) = lower($2)
         ORDER BY (username = $2) DESC LIMIT 1`,
        [loginPhone.phone || null, identifier]
      );
    const account = lookup.rows[0];
    if (!account?.email) {
      return res.status(401).json({ error: 'Invalid username, email, phone number or password' });
    }

    let authResult;
    try {
      authResult = await signInWithEmail(account.email, password);
    } catch (err) {
      if (err instanceof SupabaseAuthError && /email not confirmed/i.test(err.message)) {
        return res.status(403).json({ error: 'Please verify your email before logging in. Check your inbox for the confirmation link.' });
      }
      if (err instanceof SupabaseAuthError && [400, 401].includes(err.status)) {
        return res.status(401).json({ error: 'Invalid username, email, phone number or password' });
      }
      throw err;
    }

    if (!authResult.user?.email_confirmed_at) {
      return res.status(403).json({ error: 'Please verify your email before logging in. Check your inbox for the confirmation link.' });
    }

    const result = await db.query(
      `SELECT id, username, email, phone, display_name, bio, avatar_url, suspended_until
       FROM users WHERE id = $1 LIMIT 1`,
      [authResult.user.id]
    );
    const user = result.rows[0];
    if (!user) {
      return res.status(403).json({ error: 'Your account profile is not available. Please contact support.' });
    }
    if (user.suspended_until && new Date(user.suspended_until) > new Date()) {
      return res.status(403).json({ error: 'This account is suspended. Contact Vynzo support if you think this is a mistake.' });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        phone: user.phone,
        display_name: user.display_name,
        bio: user.bio,
        avatar_url: user.avatar_url
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { register, login };