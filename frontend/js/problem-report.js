import { requireSupabase } from './supabase-client.js';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './supabase-config.js';

const form = document.getElementById('problem-report-form');
const toggle = document.getElementById('problem-report-toggle');
const description = document.getElementById('problem-report-description');
const image = document.getElementById('problem-report-image');
const submit = document.getElementById('problem-report-submit');
const status = document.getElementById('problem-report-status');

toggle.addEventListener('click', () => {
  form.hidden = !form.hidden;
  toggle.setAttribute('aria-expanded', String(!form.hidden));
  if (!form.hidden) {
    status.textContent = '';
    description.focus();
  }
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!description.value.trim()) {
    status.textContent = 'Please describe the problem.';
    description.focus();
    return;
  }
  const file = image.files[0];
  if (file && (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024)) {
    status.textContent = 'Choose a JPEG, PNG or WebP image up to 5 MB.';
    return;
  }
  submit.disabled = true;
  toggle.disabled = true;
  description.disabled = true;
  image.disabled = true;
  status.textContent = 'Sending report...';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const { data, error } = await requireSupabase().auth.getSession();
    if (error) throw error;
    if (!data.session?.access_token) throw new Error('Please log in to report a problem.');
    const body = new FormData();
    body.append('description', description.value.trim());
    if (file) body.append('image', file);
    const response = await fetch(`${SUPABASE_URL}/functions/v1/report-problem`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${data.session.access_token}`, apikey: SUPABASE_PUBLISHABLE_KEY },
      body,
      signal: controller.signal
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not send your report.');
    form.reset();
    form.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    status.textContent = result.message || 'Your report was sent. Thank you.';
  } catch (error) {
    console.error('Could not send problem report:', error);
    status.textContent = controller.signal.aborted
      ? 'The request timed out. Check your connection before trying again.'
      : error.message || 'Could not send your report. Please try again.';
  } finally {
    clearTimeout(timeout);
    submit.disabled = false;
    toggle.disabled = false;
    description.disabled = false;
    image.disabled = false;
  }
});
