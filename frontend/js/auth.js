import { requireSupabase, syncLegacySession } from './supabase-client.js';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './supabase-config.js';
import { isValidUsername, USERNAME_MESSAGE } from './username-rules.js';
import { canSelectSavedLogin, selectSavedLogin, offerToSaveLogin } from './password-manager.js?v=1';

const COUNTRY_CODES = 'AF AX AL DZ AS AD AO AI AQ AG AR AM AW AU AT AZ BS BH BD BB BY BE BZ BJ BM BT BO BA BW BV BR IO VG BN BG BF BI KH CM CA CV BQ KY CF TD CL CN CX CC CO KM CG CD CK CR CI HR CU CW CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FK FO FJ FI FR GF PF TF GA GM GE DE GH GI GR GL GD GP GU GT GG GN GW GY HT HM HN HK HU IS IN ID IR IQ IE IM IL IT JM JP JE JO KZ KE KI KW KG LA LV LB LS LR LY LI LT LU MO MG MW MY MV ML MT MH MQ MR MU YT MX FM MD MC MN ME MS MA MZ MM NA NR NP NL NC NZ NI NE NG NU NF KP MK MP NO OM PK PW PS PA PG PY PE PH PN PL PT PR QA RE RO RW WS SM ST SA SN RS SC SL SG SX SK SI SB SO ZA GS KR SS ES LK BL SH KN LC MF PM VC SD SR SJ SE CH SY TW TJ TZ TH TL TG TK TO TT TN TR TM TC TV UM VI UG UA AE GB US UY UZ VU VA VE VN WF EH YE ZM ZW';
const REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });
const COUNTRIES = COUNTRY_CODES.split(' ').concat('RU')
  .map(code => REGION_NAMES.of(code))
  .filter(name => name !== undefined)
  .sort((left, right) => left.localeCompare(right));
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function populateRegisterOptions() {
  const fill = (id, items) => {
    const select = document.getElementById(id);
    if (!select) return;
    items.forEach(([value, label]) => select.add(new Option(label, value)));
  };
  fill('birth_day', Array.from({ length: 31 }, (_, i) => [i + 1, String(i + 1)]));
  fill('birth_month', MONTHS.map((name, i) => [i + 1, name]));
  const thisYear = new Date().getFullYear();
  fill('birth_year', Array.from({ length: thisYear - 1900 + 1 }, (_, i) => [thisYear - i, String(thisYear - i)]));
  fill('country', COUNTRIES.map(name => [name, name]));
}

document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');

  if (loginForm) {
    const savedLoginButton = document.getElementById('use-saved-login');
    const loginSubmit = document.getElementById('login-submit');
    const loginContinue = document.getElementById('login-continue');
    const errorEl = document.getElementById('error-message');
    savedLoginButton.hidden = !canSelectSavedLogin();
    savedLoginButton.addEventListener('click', async () => {
      savedLoginButton.disabled = true;
      errorEl.textContent = '';
      try {
        const credential = await selectSavedLogin();
        if (credential) {
          document.getElementById('email').value = credential.username;
          document.getElementById('password').value = credential.password;
        }
      } catch (err) {
        errorEl.textContent = 'Could not use a saved login. Check your password manager or enter your details.';
      } finally {
        savedLoginButton.disabled = false;
      }
    });
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;
      const saveLogin = document.getElementById('save-login').checked;
      errorEl.textContent = '';
      loginSubmit.disabled = true;

      try {
        const response = await fetch(`${SUPABASE_URL}/functions/v1/vynzo-api/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: SUPABASE_PUBLISHABLE_KEY },
          body: JSON.stringify({ identifier: email, password })
        }).catch(() => null);
        if (!response) throw new Error('Cannot reach Supabase. Check your connection and try again.');
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'Unable to sign in.');
        const { data, error } = await requireSupabase().auth.setSession(result.session);
        if (error) throw error;
        if (!data.session || !data.user) {
          throw new Error('Supabase did not return a signed-in session.');
        }
        syncLegacySession(data.session);
        if (saveLogin) {
          try {
            await offerToSaveLogin(email, password);
          } catch (err) {
            errorEl.textContent = 'You are logged in, but the password manager did not save your login. You can continue.';
            loginSubmit.hidden = true;
            loginContinue.hidden = false;
            return;
          }
        }
        window.location.href = '../index.html';
      } catch (err) {
        if (errorEl) errorEl.textContent = err.message || 'Unable to sign in.';
      } finally {
        loginSubmit.disabled = false;
      }
    });
  }

  if (registerForm) {
    populateRegisterOptions();
    const NON_ENGLISH = {
      username: /[\p{L}\p{N}\p{M}](?<![A-Za-z0-9])/gu,
      first_name: /[^A-Za-z .'-]/g,
      last_name: /[^A-Za-z .'-]/g,
      email: /[^\x21-\x7E]/g,
      phone: /[^0-9+\s().-]/g,
      password: /[^\x20-\x7E]/g
    };
    Object.entries(NON_ENGLISH).forEach(([id, pattern]) => {
      const el = document.getElementById(id);
      if (!el) return;
      const clean = (e) => {
        if (e.isComposing) return;
        const next = el.value.replace(pattern, '');
        if (next !== el.value) el.value = next;
      };
      el.addEventListener('input', clean);
      el.addEventListener('compositionend', clean);
      if (id !== 'password') el.setAttribute('lang', 'en');
      if (id === 'email' || id === 'phone' || id === 'password') el.setAttribute('inputmode', id === 'phone' ? 'tel' : 'text');
    });
    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nonEnglishField = Object.entries(NON_ENGLISH).find(([id, pattern]) => {
        const el = document.getElementById(id);
        return el && el.value.replace(pattern, '') !== el.value;
      });
      if (nonEnglishField) {
        const errorElEn = document.getElementById('error-message');
        if (errorElEn) errorElEn.textContent = 'Please enter all registration information in English.';
        return;
      }
      const username = document.getElementById('username').value.trim();
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;
      const errorEl = document.getElementById('error-message');
      const phoneInput = document.getElementById('phone')?.value.replace(/[\s().-]/g, '') || '';
      const age_confirmed = document.getElementById('age_confirmed').checked;
      const terms_accepted = document.getElementById('terms_accepted').checked;
      const first_name = document.getElementById('first_name').value.trim();
      const last_name = document.getElementById('last_name').value.trim();
      const birth_day = document.getElementById('birth_day').value;
      const birth_month = document.getElementById('birth_month').value;
      const birth_year = document.getElementById('birth_year').value;
      const country = document.getElementById('country').value;

      const birthDay = Number(birth_day);
      const birthMonth = Number(birth_month);
      const birthYear = Number(birth_year);
      const birth = new Date(Date.UTC(birthYear, birthMonth - 1, birthDay));
      if (birth.getUTCDate() !== birthDay || birth.getUTCMonth() !== birthMonth - 1 || birth.getUTCFullYear() !== birthYear) {
        if (errorEl) errorEl.textContent = 'Please enter a valid date of birth.';
        return;
      }
      const now = new Date();
      const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const eighteenthBirthday = Date.UTC(birthYear + 18, birthMonth - 1, birthDay);
      if (today < eighteenthBirthday) {
        if (errorEl) errorEl.textContent = 'The date of birth entered shows that you are under 18. Check the day, month, and year; Vynzo is for people aged 18 or older.';
        return;
      }

      if (!email && !phoneInput) {
        if (errorEl) errorEl.textContent = 'Enter your email address or your phone number.';
        return;
      }

      if (!age_confirmed || !terms_accepted) {
        if (errorEl) {
          errorEl.textContent = !age_confirmed
            ? 'Please confirm that you are 18 years or older.'
            : 'Please agree to the Terms, Community Guidelines and Conditions.';
        }
        return;
      }

      try {
        const normalizedUsername = username.trim().toLowerCase();
        if (!isValidUsername(normalizedUsername)) {
          throw new Error(USERNAME_MESSAGE);
        }
        const birthDate = `${birthYear}-${String(birthMonth).padStart(2, '0')}-${String(birthDay).padStart(2, '0')}`;
        if (phoneInput && !/^\+?\d{8,15}$/.test(phoneInput)) {
          throw new Error('Enter a valid phone number with country code, for example +966501234567.');
        }
        const { data: available, error: availableError } = await requireSupabase().rpc('is_username_available', { candidate: normalizedUsername });
        if (!availableError && available === false) {
          throw new Error('That username is already taken. Please choose another one.');
        }
        if (!email) {
          const response = await fetch(`${SUPABASE_URL}/functions/v1/vynzo-api/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: SUPABASE_PUBLISHABLE_KEY },
            body: JSON.stringify({
              phone: phoneInput, password, username: normalizedUsername, first_name, last_name,
              birth_date: birthDate, nationality: country, age_confirmed, terms_accepted
            })
          }).catch(() => null);
          if (!response) throw new Error('Cannot reach Supabase. Check your connection and try again.');
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(result.error || 'Unable to create your account.');
          const { data: phoneSession, error: phoneError } = await requireSupabase().auth.setSession(result.session);
          if (phoneError) throw phoneError;
          syncLegacySession(phoneSession.session);
          window.location.href = '../index.html';
          return;
        }
        const { data, error } = await requireSupabase().auth.signUp({
          email,
          password,
          options: {
            data: {
              vynzo_profile_version: '1',
              ...(phoneInput ? { phone: phoneInput } : {}),
              username: normalizedUsername,
              first_name,
              last_name,
              birth_date: birthDate,
              nationality: country,
              age_confirmed,
              terms_accepted
            }
          }
        });
        if (error) {
          if (/database error|username/i.test(error.message || '')) {
            throw new Error('That username is already taken, or some details are invalid. Please choose another username and check your details.');
          }
          throw error;
        }
        if (data.session) {
          window.location.href = '../index.html';
          return;
        }
        const successEl = document.getElementById('success-message');
        if (successEl) {
          successEl.textContent = `This email may already be registered. Please log in or reset your password.`;
          successEl.hidden = false;
        }
        registerForm.hidden = true;
      } catch (err) {
        if (errorEl) errorEl.textContent = err.message || 'Unable to create your account.';
      }
    });
  }
});