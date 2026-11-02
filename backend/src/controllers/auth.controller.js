const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../database/db');
const { JWT_SECRET } = require('../middleware/auth.middleware');
const { syncAuthUser } = require('../utils/auth-sync');

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
      return res.status(400).json({ error: 'You must be 18 years or older to join Vynzo.' });
    }
    const display_name = `${first_name} ${last_name}`.slice(0, 100);
    if (age_confirmed !== true) {
      return res.status(400).json({ error: 'You must confirm that you are 18 years or older to join Vynzo.' });
    }
    if (terms_accepted !== true) {
      return res.status(400).json({ error: 'You must agree to the Vynzo Terms, Community Guidelines and Conditions.' });
    }

    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);

    const query = `
      WITH new_user AS (
        INSERT INTO users (username, email, password_hash, display_name, age_confirmed_at, terms_accepted_at, terms_version,
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
    const values = [username, email, password_hash, display_name, TERMS_VERSION, first_name, last_name, birthDate.iso, nationality, null];
    const result = await db.query(query, values);

    const user = result.rows[0];
    await syncAuthUser(user.id);
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({ message: 'User registered successfully', token, user });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username or email already exists' });
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
    // Without an @, the identifier can be a phone number or a username.
    const result = isEmail
      ? await db.query('SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1', [identifier])
      : await db.query(
        `SELECT * FROM users WHERE ($1::text IS NOT NULL AND phone = $1) OR lower(username) = lower($2)
         ORDER BY (username = $2) DESC LIMIT 1`,
        [loginPhone.phone || null, identifier]
      );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username, email, phone number or password' });
    }

    const user = result.rows[0];
    if (user.suspended_until && new Date(user.suspended_until) > new Date()) {
      return res.status(403).json({ error: 'This account is suspended. Contact Vynzo support if you think this is a mistake.' });
    }
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid username, email, phone number or password' });
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