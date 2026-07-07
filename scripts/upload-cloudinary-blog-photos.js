#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const envPath = path.resolve('.env');
const localFolder = path.resolve(process.env.CLOUDINARY_LOCAL_PHOTOS_DIR || path.join('Pictures', 'blog photos'));
const uploadFolder = normalizeFolder(process.env.CLOUDINARY_UPLOAD_FOLDER || 'blog-photos');
const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.heic', '.heif']);
const maxDirectUploadBytes = 10 * 1024 * 1024;

loadDotEnv();

const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET;

function loadDotEnv() {
  let contents;

  try {
    contents = require('fs').readFileSync(envPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    return;
  }

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function normalizeFolder(folder) {
  return folder.replace(/^\/+|\/+$/g, '');
}

function assertEnv() {
  const missing = [];

  if (!cloudName) missing.push('CLOUDINARY_CLOUD_NAME');
  if (!apiKey) missing.push('CLOUDINARY_API_KEY');
  if (!apiSecret) missing.push('CLOUDINARY_API_SECRET');

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

function cloudinaryAuthHeader() {
  return `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`;
}

function publicIdForFile(filePath) {
  const parsed = path.parse(filePath);
  const safeName = parsed.name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

  return safeName || parsed.name.toLowerCase();
}

function signParams(params) {
  const payload = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');

  return crypto.createHash('sha1').update(`${payload}${apiSecret}`).digest('hex');
}

async function collectLocalPhotos() {
  let entries;

  try {
    entries = await fs.readdir(localFolder, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      await fs.mkdir(localFolder, { recursive: true });
      return [];
    }

    throw error;
  }

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(localFolder, entry.name))
    .filter((filePath) => allowedExtensions.has(path.extname(filePath).toLowerCase()))
    .sort((left, right) => left.localeCompare(right));
}

async function fetchExistingPublicIds() {
  const publicIds = new Set();
  let nextCursor;
  const prefix = `${uploadFolder}/`;

  do {
    const url = new URL(`https://api.cloudinary.com/v1_1/${cloudName}/resources/image/upload`);
    url.searchParams.set('max_results', '500');
    url.searchParams.set('prefix', prefix);

    if (nextCursor) {
      url.searchParams.set('next_cursor', nextCursor);
    }

    const response = await fetch(url, {
      headers: {
        Authorization: cloudinaryAuthHeader()
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Cloudinary lookup failed (${response.status}): ${body}`);
    }

    const payload = await response.json();

    for (const resource of payload.resources || []) {
      if (resource.public_id) {
        publicIds.add(resource.public_id);
      }
    }

    nextCursor = payload.next_cursor;
  } while (nextCursor);

  return publicIds;
}

async function uploadPhoto(filePath, publicId) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const params = {
    folder: uploadFolder,
    overwrite: 'false',
    public_id: publicId,
    tags: 'blog-photos',
    timestamp
  };
  const signature = signParams(params);
  const uploadFilePath = await prepareUploadFile(filePath, publicId);
  const bytes = await fs.readFile(uploadFilePath);
  const form = new FormData();

  form.set('file', new Blob([bytes]), path.basename(uploadFilePath));
  form.set('api_key', apiKey);
  form.set('folder', params.folder);
  form.set('overwrite', params.overwrite);
  form.set('public_id', params.public_id);
  form.set('tags', params.tags);
  form.set('timestamp', params.timestamp);
  form.set('signature', signature);

  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: 'POST',
    body: form
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Upload failed for ${path.basename(filePath)} (${response.status}): ${body}`);
  }

  return response.json();
}

async function prepareUploadFile(filePath, publicId) {
  const stats = await fs.stat(filePath);

  if (stats.size <= maxDirectUploadBytes) {
    return filePath;
  }

  const tempDir = path.join(os.tmpdir(), 'cloudinary-blog-photos');
  await fs.mkdir(tempDir, { recursive: true });

  const attempts = [
    { maxDimension: '2400', quality: '85' },
    { maxDimension: '2200', quality: '75' },
    { maxDimension: '1800', quality: '70' }
  ];

  for (const attempt of attempts) {
    const tempFilePath = path.join(tempDir, `${publicId}-${attempt.maxDimension}-${attempt.quality}.jpg`);
    const result = spawnSync('sips', [
      '-s',
      'format',
      'jpeg',
      '-s',
      'formatOptions',
      attempt.quality,
      '-Z',
      attempt.maxDimension,
      filePath,
      '--out',
      tempFilePath
    ], {
      encoding: 'utf8'
    });

    if (result.status !== 0) {
      throw new Error(`Could not compress ${path.basename(filePath)} with sips: ${result.stderr || result.stdout}`);
    }

    const tempStats = await fs.stat(tempFilePath);

    if (tempStats.size <= maxDirectUploadBytes) {
      console.log(`Compressed ${path.basename(filePath)} from ${formatBytes(stats.size)} to ${formatBytes(tempStats.size)} for upload.`);
      return tempFilePath;
    }
  }

  throw new Error(`Could not compress ${path.basename(filePath)} below ${formatBytes(maxDirectUploadBytes)}.`);
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function runGallerySync() {
  const result = spawnSync(process.execPath, [path.join('scripts', 'sync-cloudinary-gallery.js')], {
    env: process.env,
    stdio: 'inherit'
  });

  if (result.status !== 0) {
    throw new Error('Gallery sync failed after upload.');
  }
}

async function main() {
  assertEnv();

  const files = await collectLocalPhotos();

  if (files.length === 0) {
    console.log(`No local photos found in ${localFolder}`);
    runGallerySync();
    return;
  }

  const existingPublicIds = await fetchExistingPublicIds();
  let uploadedCount = 0;
  let skippedCount = 0;

  for (const filePath of files) {
    const publicId = `${uploadFolder}/${publicIdForFile(filePath)}`;

    if (existingPublicIds.has(publicId)) {
      skippedCount += 1;
      console.log(`Already synced: ${path.basename(filePath)} -> ${publicId}`);
      continue;
    }

    console.log(`Uploading: ${path.basename(filePath)} -> ${publicId}`);
    await uploadPhoto(filePath, publicIdForFile(filePath));
    existingPublicIds.add(publicId);
    uploadedCount += 1;
  }

  console.log(`Cloudinary upload complete: ${uploadedCount} uploaded, ${skippedCount} already synced.`);
  runGallerySync();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
