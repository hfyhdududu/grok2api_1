function normalizeSourceText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeHttpUrl(value) {
  const raw = String(value || '').trim();
  if (!/^https?:\/\//i.test(raw)) return '';
  try {
    return new URL(raw).toString();
  } catch (error) {
    return '';
  }
}

function getSourceHostname(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.hostname.replace(/^www\./i, '');
  } catch (error) {
    return '';
  }
}

export function normalizeMediaUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (raw.startsWith('data:')) return raw;
  if (/^(?:https?:)?\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw, window.location.origin);
      const host = String(parsed.hostname || '').toLowerCase();
      const path = String(parsed.pathname || '').trim();
      const fileMarkers = ['/v1/files/asset/', '/v1/files/image/', '/v1/files/video/', '/v1/files/file/'];
      const marker = fileMarkers.find((item) => path.includes(item));
      if (marker) {
        return path.slice(path.indexOf(marker));
      }
      if (host === 'localhost' || host === '127.0.0.1') {
        return path || '';
      }
      if (host === 'assets.grok.com' && path) {
        return `/v1/files/asset${path.startsWith('/') ? path : `/${path}`}`;
      }
      return raw;
    } catch (error) {
      return raw;
    }
  }
  const basePath = raw.startsWith('/') ? raw : `/${raw}`;
  if (
    basePath.startsWith('/v1/files/asset/')
    || basePath.startsWith('/v1/files/image/')
    || basePath.startsWith('/v1/files/video/')
    || basePath.startsWith('/v1/files/file/')
  ) {
    return basePath;
  }
  if (basePath.startsWith('/users/')) {
    return `/v1/files/asset${basePath}`;
  }
  return basePath.startsWith('/v1/files/image/')
    ? basePath
    : `/v1/files/image${basePath}`;
}

function parseRenderingCards(rendering) {
  const rawModelResponse = rendering && rendering.rawModelResponse && typeof rendering.rawModelResponse === 'object'
    ? rendering.rawModelResponse
    : null;
  const rawCards = Array.isArray(rawModelResponse && rawModelResponse.cardAttachmentsJson)
    ? rawModelResponse.cardAttachmentsJson
    : [];
  const cardMap = new Map();
  rawCards.forEach((raw) => {
    if (typeof raw !== 'string' || !raw.trim()) return;
    try {
      const card = JSON.parse(raw);
      if (!card || typeof card !== 'object' || !card.id) return;
      cardMap.set(String(card.id), card);
    } catch (error) {
      // 忽略损坏卡片
    }
  });
  return cardMap;
}

function buildCardItem(card, fallbackKey = '') {
  const image = card && card.image && typeof card.image === 'object' ? card.image : null;
  const chunk = card && card.image_chunk && typeof card.image_chunk === 'object' ? card.image_chunk : null;
  const rawSrc = String((image && (image.original || image.thumbnail)) || (chunk && chunk.imageUrl) || '').trim();
  const src = normalizeMediaUrl(rawSrc);
  if (!src) return null;
  const sourceHref = normalizeHttpUrl((image && (image.link || image.original)) || '');
  const fallbackSrc = normalizeMediaUrl((image && image.thumbnail) || '');
  const caption = normalizeSourceText((image && image.title) || (chunk && chunk.imageTitle) || '');
  return {
    key: card && card.id ? `card:${card.id}` : fallbackKey || `url:${src}`,
    cardId: card && card.id ? String(card.id) : '',
    src,
    alt: caption || 'image',
    caption,
    sourceHref,
    sourceLabel: sourceHref ? getSourceHostname(sourceHref) : '',
    fallbackSrc
  };
}

function getFileKind(mime, contentType) {
  const normalizedMime = String(mime || '').toLowerCase();
  const normalizedType = String(contentType || '').toLowerCase();
  if (normalizedMime.startsWith('image/') || normalizedType === 'image') return 'image';
  if (normalizedMime.startsWith('video/') || normalizedType === 'video') return 'video';
  return 'file';
}

function buildFileItem(file, fallbackKey = '') {
  if (!file || typeof file !== 'object') return null;
  const rawSrc = String(file.url || file.href || '').trim();
  const src = normalizeMediaUrl(rawSrc);
  if (!src) return null;
  const name = normalizeSourceText(file.name || file.file_name || 'download');
  const mime = normalizeSourceText(file.mime || file.mime_type || '');
  const contentType = normalizeSourceText(file.contentType || file.content_type || '');
  const size = Number(file.size || file.file_size || 0) || 0;
  const kind = getFileKind(mime, contentType);
  return {
    key: fallbackKey || `file:${file.id || name}:${src}`,
    cardId: file.id ? String(file.id) : '',
    src,
    alt: name || 'file',
    caption: name || '',
    sourceHref: '',
    sourceLabel: '',
    fallbackSrc: '',
    kind,
    name: name || 'download',
    mime,
    contentType,
    size
  };
}

export function buildMediaItems(rendering) {
  if (!rendering || typeof rendering !== 'object') return [];
  const items = [];
  const seen = new Set();
  const seenSrc = new Set();
  const files = Array.isArray(rendering.files) ? rendering.files : [];
  const hasExplicitFiles = files.length > 0;
  const pushItem = (item) => {
    if (!item || !item.key || seen.has(item.key)) return;
    if (item.src && seenSrc.has(item.src)) return;
    seen.add(item.key);
    if (item.src) seenSrc.add(item.src);
    items.push(item);
  };

  const cardMap = parseRenderingCards(rendering);
  cardMap.forEach((card) => {
    const cType = String(card && card.type || '');
    const cardType = String(card && card.cardType || '');
    if (
      cType === 'render_searched_image' ||
      cType === 'render_edited_image' ||
      cType === 'render_generated_image' ||
      cardType === 'generated_image_card'
    ) {
      pushItem(buildCardItem(card));
    } else if (!hasExplicitFiles && (cType === 'render_file' || cardType === 'rendered_file_card')) {
      pushItem(buildFileItem(card, card && card.id ? `file-card:${card.id}` : ''));
    }
  });

  files.forEach((file) => {
    pushItem(buildFileItem(file));
  });

  const extraImages = Array.isArray(rendering.extraImages) ? rendering.extraImages : [];
  extraImages.forEach((url) => {
    const src = normalizeMediaUrl(url);
    if (!src) return;
    pushItem({
      key: `url:${src}`,
      cardId: '',
      src,
      alt: 'image',
      caption: '',
      sourceHref: '',
      sourceLabel: '',
      fallbackSrc: ''
    });
  });

  return items;
}
