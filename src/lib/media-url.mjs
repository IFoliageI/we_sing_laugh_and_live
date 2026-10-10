/** 完整直链原样保留，避免重编码破坏 OSS 签名和图床处理参数。 */
export function isRemoteMediaUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\\\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function normalizeMediaBaseUrl(value = '') {
  const base = value.trim();
  if (!base) return '';
  if (!isRemoteMediaUrl(base) || new URL(base).search || new URL(base).hash) {
    throw new Error('媒体基础地址必须是没有查询参数、片段或账号密码的 HTTP(S) 地址。');
  }
  return base.replace(/\/+$/, '');
}

/** 本地音频名称是原始文件名；图片路径允许已有的百分号编码。 */
export function resolveMediaUrl(value, baseUrl = '', localPrefix = '', encodedPath = false) {
  const source = value?.trim() ?? '';
  if (!source) return '';
  if (isRemoteMediaUrl(source)) return source;
  if (/^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith('//') || /[\u0000-\u001f\u007f]/.test(source)) return '';
  const parts = source.replace(/\\/g, '/').replace(/^\/+/, '').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return '';
  const encoded = [];
  for (const part of parts) {
    let name = part;
    if (encodedPath) {
      try { name = decodeURIComponent(part); } catch {}
      if (name === '.' || name === '..' || /[/\\\u0000-\u001f\u007f]/.test(name)) return '';
    }
    encoded.push(encodeURIComponent(name));
  }
  const base = normalizeMediaBaseUrl(baseUrl);
  return `${base || localPrefix}/${encoded.join('/')}`;
}
