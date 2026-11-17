const MAX_EDGE = 1200;

export async function createImageCover(file) {
  if (!(file instanceof File) || !file.type.startsWith('image/') || !file.size) {
    throw new Error('Choose a valid image to create a preview.');
  }
  let image;
  let imageUrl;
  try {
    if (typeof createImageBitmap === 'function') {
      try {
        image = await createImageBitmap(file);
      } catch (error) {
        console.warn('Image bitmap decoding failed; trying the browser image decoder:', error);
      }
    }
    if (!image) {
      imageUrl = URL.createObjectURL(file);
      const element = new Image();
      try {
        await new Promise((resolve, reject) => {
          element.onload = resolve;
          element.onerror = () => reject(new Error('The browser could not decode the selected photo.'));
          element.src = imageUrl;
        });
        image = element;
      } catch (error) {
        console.error('Could not decode the selected image:', error);
        throw new Error('This photo could not be opened. Try saving it as JPG or PNG, or select it from My Files instead of Gallery.');
      } finally {
        element.onload = null;
        element.onerror = null;
      }
    }
    if (!image.width || !image.height) throw new Error('The image has no displayable dimensions.');
    const scale = Math.min(1, MAX_EDGE / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image preview generation is unavailable on this device.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(result => result ? resolve(result) : reject(new Error('Could not encode the image preview.')), 'image/jpeg', 0.8);
    });
    return new File([blob], 'cover.jpg', { type: 'image/jpeg' });
  } finally {
    image?.close?.();
    if (imageUrl) URL.revokeObjectURL(imageUrl);
  }
}
