export async function uploadSelectedFile(input, upload) {
  const file = input.files?.[0];
  if (!file) return;
  input.disabled = true;
  try {
    await upload(file);
  } finally {
    input.value = '';
    input.disabled = false;
  }
}
