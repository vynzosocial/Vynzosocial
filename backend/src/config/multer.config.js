const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const cloud = require('./storage');

function cloudStorage(bucket) {
  return {
    _handleFile(req, file, cb) {
      const chunks = [];
      let size = 0;
      let completed = false;
      const finish = (err, info) => {
        if (completed) return;
        completed = true;
        cb(err, info);
      };
      file.stream.on('data', chunk => {
        chunks.push(chunk);
        size += chunk.length;
      });
      file.stream.once('error', err => finish(err));
      file.stream.once('end', async () => {
        const buffer = Buffer.concat(chunks);
        const field = file.fieldname.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 30) || 'file';
        const extension = path.extname(file.originalname).slice(0, 12);
        const filename = `${field}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${extension}`;
        try {
          await cloud.uploadBuffer(filename, buffer, file.mimetype, bucket);
          finish(null, { filename, size, buffer });
        } catch (err) {
          finish(err);
        }
      });
    },
    _removeFile(req, file, cb) {
      if (!file.filename) return cb(null);
      cloud.deleteFile(file.filename, bucket).then(() => cb(null), cb);
    }
  };
}

const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'video/mp4',
    'video/webm',
    'video/quicktime'
  ];

  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Unsupported file format. Only JPEG, PNG, WEBP, GIF, MP4, and WEBM are allowed.'), false);
  }
};

const avatarFileFilter = (req, file, cb) => {
  const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Profile photo must be a JPEG, PNG, WEBP, or GIF image.'), false);
  }
};

const limits = { fileSize: 50 * 1024 * 1024 };
const upload = multer({ storage: cloudStorage(cloud.PUBLIC_BUCKET), fileFilter, limits });

upload.avatar = multer({
  storage: cloudStorage(cloud.PUBLIC_BUCKET),
  fileFilter: avatarFileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }
});

upload.viewOnce = multer({
  storage: cloudStorage(cloud.PRIVATE_BUCKET),
  fileFilter: avatarFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }
});

const blogFileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime'];
  if (allowed.includes(file.mimetype)) cb(null, true);
  else cb(new Error('Use a JPEG, PNG, WEBP or GIF image, or an MP4, WEBM or MOV video.'), false);
};

upload.blog = multer({
  storage: cloudStorage(cloud.PUBLIC_BUCKET),
  fileFilter: blogFileFilter,
  limits
});

module.exports = upload;
