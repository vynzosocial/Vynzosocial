const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const cloud = require('./storage');

const uploadDir = path.join(__dirname, '../../uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
  }
});

// Saves to disk (local backup), then mirrors the file to Supabase Storage.
const storage = {
  _handleFile(req, file, cb) {
    diskStorage._handleFile(req, file, async (err, info) => {
      if (err) return cb(err);
      if (!cloud.enabled()) return cb(null, info);
      try {
        await cloud.uploadFile(info.path, info.filename, file.mimetype);
        cb(null, info);
      } catch (uploadErr) {
        fs.unlink(info.path, () => cb(uploadErr));
      }
    });
  },
  _removeFile(req, file, cb) {
    diskStorage._removeFile(req, file, cb);
  }
};

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

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB max file size
  }
});

upload.avatar = multer({
  storage,
  fileFilter: avatarFileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024
  }
});

// View-once photos live in a private folder that is never served statically or mirrored to cloud storage.
const privateUploadDir = path.join(__dirname, '../../private_uploads');
if (!fs.existsSync(privateUploadDir)) {
  fs.mkdirSync(privateUploadDir, { recursive: true });
}

upload.viewOnce = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, privateUploadDir),
    filename: (req, file, cb) => {
      const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[file.mimetype] || '.bin';
      cb(null, `${crypto.randomBytes(24).toString('hex')}${ext}`);
    }
  }),
  fileFilter: avatarFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }
});
upload.privateUploadDir = privateUploadDir;

const blogFileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime'];
  if (allowed.includes(file.mimetype)) cb(null, true);
  else cb(new Error('Use a JPEG, PNG, WEBP or GIF image, or an MP4, WEBM or MOV video.'), false);
};

upload.blog = multer({
  storage,
  fileFilter: blogFileFilter,
  limits: { fileSize: 50 * 1024 * 1024 }
});

module.exports = upload;