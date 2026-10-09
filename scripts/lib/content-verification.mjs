export function decodeHtml(source) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return source.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, key) => {
    if (!key.startsWith('#')) return named[key.toLowerCase()];
    const code = key.toLowerCase().startsWith('#x') ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function containsJsValue(source, value) {
  const candidates = [
    value,
    JSON.stringify(value).slice(1, -1),
    JSON.stringify(value).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'"),
  ];
  const unicodeDecoded = source.replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
  return candidates.some((candidate) => source.includes(candidate) || unicodeDecoded.includes(candidate));
}

export function verifyContent(content, html, allJs) {
  let itemCount = 0;
  let fieldCount = 0;
  const problems = [];
  for (const section of ['voice', 'song']) {
    const data = content[section];
    if (!data) continue;
    const page = decodeHtml(html[section]);
    const groups = [...data.groups, ...(data.secretGroup ? [data.secretGroup] : [])];
    for (const group of groups) {
      const secret = group === data.secretGroup;
      const expectRendered = (value, label) => {
        if (secret ? !containsJsValue(allJs, value) : !page.includes(value)) {
          problems.push(`${secret ? 'JS' : 'HTML'}[${section}] 缺${label}: ${value}`);
        }
      };
      expectRendered(group.title, '分组标题');
      for (const stack of group.stacks ?? []) {
        if (stack.title) expectRendered(stack.title, '合集标题');
      }
      for (const voice of group.voices) expectRendered(voice.zh, '按钮文字');

      const voices = [...group.voices, ...(group.hiddenVoices ?? []), ...(group.stacks ?? []).flatMap((stack) => stack.voices)];
      for (const voice of voices) {
        itemCount++;
        const fields = [voice.zh, voice.path, voice.artist, voice.info?.time, voice.info?.title, voice.info?.note, voice.info?.thumb].filter(Boolean);
        for (const value of fields) {
          fieldCount++;
          if (!containsJsValue(allJs, value)) problems.push(`JS[${section}] 缺字段: ${value}（条目 ${voice.zh}）`);
        }
      }
    }
    if (data.hint && !containsJsValue(allJs, data.hint)) problems.push(`JS[${section}] 缺空态文案`);
  }
  return { itemCount, fieldCount, problems };
}
