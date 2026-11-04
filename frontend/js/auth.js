import { requireSupabase, syncLegacySession } from './supabase-client.js';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './supabase-config.js';

const NATIONALITIES = ['Afghan','Albanian','Algerian','American','Andorran','Angolan','Argentine','Armenian','Australian','Austrian','Azerbaijani','Bahamian','Bahraini','Bangladeshi','Barbadian','Belarusian','Belgian','Belizean','Beninese','Bhutanese','Bolivian','Bosnian','Botswanan','Brazilian','British','Bruneian','Bulgarian','Burkinabe','Burundian','Cambodian','Cameroonian','Canadian','Cape Verdean','Central African','Chadian','Chilean','Chinese','Colombian','Comorian','Congolese','Costa Rican','Croatian','Cuban','Cypriot','Czech','Danish','Djiboutian','Dominican','Dutch','Ecuadorian','Egyptian','Emirati','Equatorial Guinean','Eritrean','Estonian','Eswatini','Ethiopian','Fijian','Filipino','Finnish','French','Gabonese','Gambian','Georgian','German','Ghanaian','Greek','Grenadian','Guatemalan','Guinean','Guyanese','Haitian','Honduran','Hungarian','Icelandic','Indian','Indonesian','Iranian','Iraqi','Irish','Israeli','Italian','Ivorian','Jamaican','Japanese','Jordanian','Kazakh','Kenyan','Kuwaiti','Kyrgyz','Lao','Latvian','Lebanese','Liberian','Libyan','Liechtensteiner','Lithuanian','Luxembourger','Malagasy','Malawian','Malaysian','Maldivian','Malian','Maltese','Mauritanian','Mauritian','Mexican','Moldovan','Monegasque','Mongolian','Montenegrin','Moroccan','Mozambican','Myanmar','Namibian','Nepalese','New Zealander','Nicaraguan','Nigerian','Nigerien','North Korean','North Macedonian','Norwegian','Omani','Pakistani','Palestinian','Panamanian','Papua New Guinean','Paraguayan','Peruvian','Polish','Portuguese','Qatari','Romanian','Russian','Rwandan','Saudi','Senegalese','Serbian','Seychellois','Sierra Leonean','Singaporean','Slovak','Slovenian','Somali','South African','South Korean','South Sudanese','Spanish','Sri Lankan','Sudanese','Surinamese','Swedish','Swiss','Syrian','Taiwanese','Tajik','Tanzanian','Thai','Togolese','Trinidadian','Tunisian','Turkish','Turkmen','Ugandan','Ukrainian','Uruguayan','Uzbek','Venezuelan','Vietnamese','Yemeni','Zambian','Zimbabwean','Other'];
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
  fill('nationality', NATIONALITIES.map(name => [name, name]));
}

document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');

  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;
      const errorEl = document.getElementById('error-message');

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
        window.location.href = '../index.html';
      } catch (err) {
        if (errorEl) errorEl.textContent = err.message || 'Unable to sign in.';
      }
    });
  }

  if (registerForm) {
    populateRegisterOptions();
    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
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
      const nationality = document.getElementById('nationality').value;

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

      if (!email) {
        if (errorEl) errorEl.textContent = 'Enter your email address.';
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
        if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9._]{1,28}[a-zA-Z0-9])$/.test(normalizedUsername)) {
          throw new Error('Username must be 3–30 characters and use only letters, numbers, periods, and underscores.');
        }
        const birthDate = `${birthYear}-${String(birthMonth).padStart(2, '0')}-${String(birthDay).padStart(2, '0')}`;
        if (phoneInput && !/^\+?\d{8,15}$/.test(phoneInput)) {
          throw new Error('Enter a valid phone number with country code, for example +966501234567.');
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
              nationality,
              age_confirmed,
              terms_accepted
            }
          }
        });
        if (error) throw error;
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