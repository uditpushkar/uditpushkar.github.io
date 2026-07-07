#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');

const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET;
const outputPath = process.env.CLOUDINARY_GALLERY_OUTPUT || path.join('_data', 'cloudinary_gallery.json');
const sourcePrefix = normalizePrefix(process.env.CLOUDINARY_GALLERY_PREFIX || '');

function normalizePrefix(prefix) {
  if (!prefix) {
    return '';
  }

  return prefix.replace(/^\/+/, '').replace(/\/?$/, '/');
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

function titleize(slug) {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function inferAlt(resource, albumTitle) {
  const contextAlt = resource.context && resource.context.custom && resource.context.custom.alt;

  if (contextAlt) {
    return contextAlt;
  }

  const filename = resource.public_id.split('/').pop() || albumTitle;

  return filename
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function transformCloudinaryUrl(url, transformation) {
  return url.replace('/upload/', `/upload/${transformation}/`);
}

async function fetchResources() {
  const resources = [];
  let nextCursor;

  do {
    const url = new URL(`https://api.cloudinary.com/v1_1/${cloudName}/resources/image/upload`);
    url.searchParams.set('max_results', '500');
    url.searchParams.set('context', 'true');
    url.searchParams.set('tags', 'true');

    if (sourcePrefix) {
      url.searchParams.set('prefix', sourcePrefix);
    }

    if (nextCursor) {
      url.searchParams.set('next_cursor', nextCursor);
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Cloudinary API request failed (${response.status}): ${body}`);
    }

    const payload = await response.json();
    resources.push(...(payload.resources || []));
    nextCursor = payload.next_cursor;
  } while (nextCursor);

  return resources;
}

function buildGallery(resources) {
  const images = resources
    .filter((resource) => {
      if (!resource.public_id || !resource.secure_url) {
        return false;
      }

      if (!sourcePrefix) {
        return true;
      }

      return resource.public_id.startsWith(sourcePrefix);
    })
    .map((resource) => ({
      public_id: resource.public_id,
      src: transformCloudinaryUrl(resource.secure_url, 'f_auto,q_auto,w_900,c_limit'),
      full: transformCloudinaryUrl(resource.secure_url, 'f_auto,q_auto,w_1800,c_limit'),
      alt: inferAlt(resource, 'All Photos'),
      width: resource.width,
      height: resource.height,
      created_at: resource.created_at
    }))
    .sort((left, right) => {
      return new Date(right.created_at) - new Date(left.created_at);
    });

  const albums = images.length > 0 ? [
    {
      title: 'All Photos',
      slug: 'all-photos',
      images,
      updated_at: images[0].created_at
    }
  ] : [];

  return {
    generated_at: new Date().toISOString(),
    source_prefix: sourcePrefix || null,
    total_images: albums.reduce((sum, album) => sum + album.images.length, 0),
    albums
  };
}

async function writeGalleryFile(gallery) {
  const absoluteOutputPath = path.resolve(outputPath);
  await fs.mkdir(path.dirname(absoluteOutputPath), { recursive: true });

  try {
    const existingGallery = JSON.parse(await fs.readFile(absoluteOutputPath, 'utf8'));

    if (sameGalleryContent(existingGallery, gallery)) {
      return { absoluteOutputPath, changed: false };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  await fs.writeFile(absoluteOutputPath, `${JSON.stringify(gallery, null, 2)}\n`, 'utf8');
  return { absoluteOutputPath, changed: true };
}

function sameGalleryContent(left, right) {
  return JSON.stringify(withoutGeneratedAt(left)) === JSON.stringify(withoutGeneratedAt(right));
}

function withoutGeneratedAt(gallery) {
  const clone = { ...gallery };
  delete clone.generated_at;
  return clone;
}

async function main() {
  assertEnv();
  const resources = await fetchResources();
  const gallery = buildGallery(resources);
  const { absoluteOutputPath, changed } = await writeGalleryFile(gallery);

  if (changed) {
    console.log(`Synced ${gallery.total_images} images across ${gallery.albums.length} albums to ${absoluteOutputPath}`);
  } else {
    console.log(`Cloudinary gallery already up to date at ${absoluteOutputPath}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
