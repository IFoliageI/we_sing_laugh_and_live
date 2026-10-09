import { createSignal, createMemo, createEffect, For, Show, onMount, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import { voiceGroups, secretGroup, EMPTY_HINT, PAST_KEY, type VoiceGroup, type Voice, type VoiceStack } from '../data/voices';
import { createAudioPlayer, type Playing } from '../lib/audio-player';
import { findVoice, normalVoices, shareUrl } from '../lib/board-data';

interface TipData {
  thumb?: string;
  title?: string;
  time?: string;
  note?: string;
  artist?: string;
  pos?: string;
  x: number;
  y: number;
  above: boolean;
}

// 这个音效板组件被「首页」和「渺の歌单」两页共用。
// 不传任何 props 时，行为与首页完全一致（用 voices.ts 的音效数据）；歌单页传入歌曲数据与相应文案。
export interface BoardOptions {
  // 数据源（不传 = 用首页音效数据 voiceGroups）
  groups?: VoiceGroup[];
  // 彩蛋「往日」的额外分组（不传 = 用首页的 secretGroup）
  secret?: VoiceGroup;
  // 是否启用「往日」彩蛋（默认 true，歌单页传 false）
  enableSecret?: boolean;
  // 以下均为可覆盖的界面文案
  searchPlaceholder?: string;
  noResultWord?: string;
  emptyGroupText?: string;
  noAudioText?: string;
  emptyHint?: string;
}

export function SoundBoard(props: BoardOptions = {}) {
  const baseGroups = () => props.groups ?? voiceGroups;
  const secretRef = () => props.secret ?? secretGroup;
  const secretOn = () => props.enableSecret ?? true;
  const searchPlaceholder = () => props.searchPlaceholder ?? '搜索音效…';
  const noResultWord = () => props.noResultWord ?? '动静';
  const emptyGroupText = () => props.emptyGroupText ?? '（本组暂无音效，待主人填入 mp3）';
  const noAudioText = () => props.noAudioText ?? '这条音效还没有注入音频文件哦';
  const emptyHint = () => props.emptyHint ?? EMPTY_HINT;

  const [query, setQuery] = createSignal('');
  const [playing, setPlaying] = createSignal<Playing | null>(null);
  const [loop, setLoop] = createSignal(false);
  // 记录「被折叠」的分组：默认全部展开，这样切换数据源（如歌单的展示方式）时新出现的分组也是展开的
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  const [toast, setToast] = createSignal<string | null>(null);
  const [fabOpen, setFabOpen] = createSignal(false);
  const [hasClipboard, setHasClipboard] = createSignal(true);
  const [past, setPast] = createSignal(false); // 往日彩蛋开关
  const [tip, setTip] = createSignal<TipData | null>(null); // 悬停卡片
  const [stackCurrent, setStackCurrent] = createSignal<Record<string, number>>({}); // 各合集当前项索引
  const player = createAudioPlayer(setPlaying, showToast);
  let tipElement: HTMLDivElement | undefined;

  createEffect(() => {
    const current = tip();
    if (!current) return;
    const frame = requestAnimationFrame(() => {
      if (!tipElement || tip() !== current) return;
      const { height } = tipElement.getBoundingClientRect();
      const minimum = current.above ? height + 8 : 8;
      const maximum = current.above ? window.innerHeight - 8 : window.innerHeight - height - 8;
      const y = Math.max(minimum, Math.min(maximum, current.y));
      if (y !== current.y) setTip({ ...current, y });
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });

  // ---- 悬停卡片 ----
  function showTip(el: HTMLElement, voice: Voice | undefined, pos?: string) {
    if (!voice) return;
    const info = voice.info;
    if (!info && !pos && !voice.artist) return;
    const rect = el.getBoundingClientRect();
    const above = rect.top > 76; // 靠近页面顶部时改在下方弹出，避免被裁切
    setTip({
      thumb: info?.thumb,
      title: info?.title ?? (pos ? voice.zh : undefined),
      time: info?.time,
      note: info?.note,
      artist: voice.artist,
      pos,
      x: Math.max(118, Math.min(window.innerWidth - 118, rect.left + rect.width / 2)),
      y: above ? rect.top - 6 : rect.bottom + 6,
      above,
    });
  }
  function hideTip() {
    setTip(null);
  }

  // ---- 彩蛋“往日”：打开后，每个分类浮现隐藏音频，并多出一个额外分类 ----
  const effectiveGroups = createMemo<VoiceGroup[]>(() => {
    if (!secretOn() || !past()) return baseGroups();
    return [
      ...baseGroups().map((g) => ({
        ...g,
        voices: [...g.voices, ...(g.hiddenVoices ?? [])],
      })),
      { ...secretRef(), voices: [...secretRef().voices, ...(secretRef().hiddenVoices ?? [])] },
    ];
  });

  // ---- 过滤：保留所有大类（含空分类），搜索时只保留标题或音效命中的 ----
  const matchedGroups = createMemo(() => {
    const q = query().trim().toLowerCase();
    const groups = effectiveGroups();
    if (!q) return groups;
    return groups
      .map((g) => {
        const groupMatch =
          g.groupName.toLowerCase().includes(q) || g.title.toLowerCase().includes(q);
        const voices = g.voices.filter(
          (v) => v.zh.toLowerCase().includes(q) || v.path.toLowerCase().includes(q)
        );
        const stacks = (g.stacks ?? []).filter(
          (s) =>
            (s.title ?? '').toLowerCase().includes(q) ||
            s.voices.some((v) => v.zh.toLowerCase().includes(q) || v.path.toLowerCase().includes(q))
        );
        if (groupMatch) return g;
        if (voices.length > 0 || stacks.length > 0) return { ...g, voices, stacks };
        return null;
      })
      .filter((g): g is VoiceGroup => g !== null);
  });

  // ---- 提示 ----------
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function showToast(msg: string) {
    setToast(msg);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(null), 1800);
  }

  // ---- 播放 ----------
  function playVoice(v: Voice, groupName: string) {
    if (!v || !v.path) {
      showToast(noAudioText());
      return;
    }
    hideTip();
    player.play(v, groupName);
  }
  function playSound(group: VoiceGroup, idx: number) {
    playVoice(group.voices[idx], group.groupName);
  }

  // ---- 堆叠按钮（合集）----
  const stackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  function stackKey(groupName: string, title: string, idx: number) {
    return JSON.stringify([groupName, title, idx]);
  }
  function currentStackIndex(groupName: string, title: string, idx: number, total: number) {
    if (total === 0) return 0;
    const cur = stackCurrent()[stackKey(groupName, title, idx)];
    return cur === undefined ? 0 : ((cur % total) + total) % total;
  }
  function stackPlay(group: VoiceGroup, stack: VoiceStack, idx: number) {
    const vs = stack.voices;
    if (!vs.length) { showToast('这个合集还没有音频哦'); return; }
    const i = Math.floor(Math.random() * vs.length);
    setStackCurrent((s) => ({ ...s, [stackKey(group.groupName, stack.title ?? '', idx)]: i }));
    playVoice(vs[i], group.groupName);
  }
  function stackReroll(group: VoiceGroup, stack: VoiceStack, idx: number) {
    const vs = stack.voices;
    if (!vs.length) return;
    const k = stackKey(group.groupName, stack.title ?? '', idx);
    const cur = stackCurrent()[k] ?? 0;
    const i = vs.length > 1 ? (cur + 1 + Math.floor(Math.random() * (vs.length - 1))) % vs.length : 0;
    setStackCurrent((s) => ({ ...s, [k]: i }));
  }
  function onStackClick(group: VoiceGroup, stack: VoiceStack, idx: number) {
    const k = stackKey(group.groupName, stack.title ?? '', idx);
    const t = stackTimers.get(k);
    if (t) clearTimeout(t);
    const timer = setTimeout(() => { stackTimers.delete(k); stackPlay(group, stack, idx); }, 250);
    stackTimers.set(k, timer);
  }
  function onStackDbl(group: VoiceGroup, stack: VoiceStack, idx: number) {
    const k = stackKey(group.groupName, stack.title ?? '', idx);
    const t = stackTimers.get(k);
    if (t) { clearTimeout(t); stackTimers.delete(k); }
    stackReroll(group, stack, idx);
  }

  function togglePlay() {
    player.toggle();
  }

  function stopSound() {
    player.stop();
  }

  function toggleLoop() {
    const next = !loop();
    setLoop(next);
    player.setLoop(next);
    showToast(next ? '已开启循环播放' : '已关闭循环播放');
  }

  function toggleGroup(name: string) {
    hideTip();
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  // 标签用于定位；重复点击不会把刚定位的内容折叠。
  function scrollToGroup(name: string) {
    const el = document.getElementById(`group-${name}`);
    setCollapsed((current) => {
      const next = new Set(current);
      next.delete(name);
      return next;
    });
    if (el) el.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  function randomPlay() {
    const candidates = baseGroups().flatMap((group) => normalVoices(group).map((voice) => ({ voice, groupName: group.groupName })));
    if (candidates.length === 0) {
      showToast(emptyHint());
      return;
    }
    const choice = candidates[Math.floor(Math.random() * candidates.length)];
    playVoice(choice.voice, choice.groupName);
  }

  async function share() {
    const p = playing();
    if (!p) return;
    const url = shareUrl(location.href, { path: p.path, zh: p.name });
    try {
      await navigator.clipboard.writeText(url);
      showToast('已复制分享链接');
    } catch {
      showToast('复制失败');
    }
  }

  onMount(() => {
    if (!navigator.clipboard) setHasClipboard(false);
    // 彩蛋“往日”开关状态（只在启用彩蛋的页面读取）
    if (secretOn()) {
      try { if (sessionStorage.getItem(PAST_KEY) === '1') setPast(true); } catch {}
      const onPastChange = () => {
        try { setPast(sessionStorage.getItem(PAST_KEY) === '1'); } catch {}
      };
      window.addEventListener('lmy-past-change', onPastChange);
      onCleanup(() => window.removeEventListener('lmy-past-change', onPastChange));
    }
    const params = new URLSearchParams(location.search);
    const btn = params.get('btn');
    if (btn) {
      const found = findVoice(baseGroups(), btn);
      if (found) playVoice(found.voice, found.groupName);
    }
    window.addEventListener('scroll', hideTip, { passive: true });
    window.addEventListener('resize', hideTip);
    onCleanup(() => {
      window.removeEventListener('scroll', hideTip);
      window.removeEventListener('resize', hideTip);
    });
  });

  onCleanup(() => {
    clearTimeout(toastTimer);
    stackTimers.forEach((timer) => clearTimeout(timer));
    stackTimers.clear();
    player.stop();
  });

  const curProgress = () => playing()?.progress ?? 0;
  const currentGroupName = createMemo(() => {
    const current = playing();
    if (!current) return null;
    const groups = effectiveGroups();
    const containsCurrent = (group: VoiceGroup) => normalVoices(group).some((voice) => voice.path === current.path);
    return (groups.find((group) => group.groupName === current.groupName && containsCurrent(group))
      ?? groups.find(containsCurrent))?.groupName ?? current.groupName;
  });
  const isCurrentVoice = (voice: Voice | undefined, groupName: string) =>
    !!voice && playing()?.path === voice.path && currentGroupName() === groupName;

  return (
    <>
      {/* 搜索卡 */}
      <div class="search-card">
        <div class="search-box">
          <span class="search-icon sficon" aria-hidden="true">{String.fromCharCode(0xE721)}</span>
          <input
            type="text"
            placeholder={searchPlaceholder()}
            aria-label={searchPlaceholder()}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <Show when={query()}>
            <button
              type="button"
              aria-label="清除"
              class="clear-icon sficon"
              onClick={() => setQuery('')}
            >{String.fromCharCode(0xE711)}</button>
          </Show>
        </div>
      </div>

      {/* 空态（全局无匹配） */}
      <Show when={matchedGroups().length === 0}>
        <div class="no-result">
          <Show when={query().trim()} fallback={emptyHint()}>
            没有搜到关于“{query()}”的{noResultWord()}
          </Show>
        </div>
      </Show>

      {/* 大类标签栏（原版：点击跳转到对应分组） */}
      <Show when={matchedGroups().length > 1}>
        <div class="tabs">
          <For each={matchedGroups()}>
            {(group) => (
              <button type="button" class="tab" onClick={() => scrollToGroup(group.groupName)}>
                {group.title}
              </button>
            )}
          </For>
        </div>
      </Show>

      {/* 分组面板：“几个大类”以可展开区块呈现 */}
      <div class="panels">
        <For each={matchedGroups()}>
          {(group) => {
            const isOpen = () => !collapsed().has(group.groupName);
            const groupPlaying = () => currentGroupName() === group.groupName;
            const totalBtns = () => group.voices.length + (group.stacks?.length ?? 0);
            return (
              <div
                class="panel"
                classList={{ open: isOpen() }}
                id={`group-${group.groupName}`}
              >
                <button
                  type="button"
                  class="panel__head"
                  onClick={() => toggleGroup(group.groupName)}
                  aria-expanded={isOpen()}
                  aria-controls={`body-${group.groupName}`}
                >
                  <span class="panel__title">{group.title}</span>
                  <span class="panel__count">
                    {groupPlaying() ? String.fromCharCode(0x266A) : totalBtns()}
                  </span>
                  <span class="panel__chevron sficon">{String.fromCharCode(0xE70D)}</span>
                </button>
                <div class="panel__body" id={`body-${group.groupName}`} inert={!isOpen()}>
                  <div class="panel__body-inner">
                    <Show when={totalBtns() > 0} fallback={<div class="group-empty">{emptyGroupText()}</div>}>
                      <div class="panel__grid">
                        <For each={group.voices}>
                          {(voice, i) => (
                            <div class="sound-btn-wrap">
                              <button
                                type="button"
                                class="sound-btn"
                                classList={{ playing: isCurrentVoice(voice, group.groupName) }}
                                onClick={() => playSound(group, i())}
                                onMouseEnter={(e) => showTip(e.currentTarget, voice)}
                                onMouseLeave={hideTip}
                                onMouseDown={hideTip}
                                onFocus={(e) => showTip(e.currentTarget, voice)}
                                onBlur={hideTip}
                                data-sound={voice.zh}
                              >
                                <Show when={isCurrentVoice(voice, group.groupName)}>
                                  <span class="pulse-dot" />
                                </Show>
                                <span>{voice.zh}</span>
                                <Show when={isCurrentVoice(voice, group.groupName)}>
                                  <span class="progress" style={`--progress: ${curProgress()}%`} />
                                </Show>
                              </button>
                            </div>
                          )}
                        </For>
                        <For each={group.stacks ?? []}>
                          {(stack, si) => {
                            const curIdx = () => currentStackIndex(group.groupName, stack.title ?? '', si(), stack.voices.length);
                            const curVoice = () => stack.voices[curIdx()];
                            return (
                              <div class="sound-btn-wrap stack-wrap">
                                <button
                                  type="button"
                                  class="sound-btn sound-stack"
                                  classList={{ playing: isCurrentVoice(curVoice(), group.groupName) }}
                                  disabled={stack.voices.length === 0}
                                  aria-label={stack.voices.length ? undefined : `${stack.title || '合集'}（暂无音频）`}
                                  onClick={() => onStackClick(group, stack, si())}
                                  onDblClick={() => onStackDbl(group, stack, si())}
                                  onMouseEnter={(e) => showTip(e.currentTarget, curVoice(), `第 ${curIdx() + 1}/${stack.voices.length} 个`)}
                                  onMouseLeave={hideTip}
                                  onMouseDown={hideTip}
                                  onFocus={(e) => showTip(e.currentTarget, curVoice(), `第 ${curIdx() + 1}/${stack.voices.length} 个`)}
                                  onBlur={hideTip}
                                >
                                  <Show when={isCurrentVoice(curVoice(), group.groupName)}>
                                    <span class="pulse-dot" />
                                  </Show>
                                  <span class="stack-title">{stack.title || '合集'}</span>
                                  <span class="stack-count">{stack.voices.length}</span>
                                  <Show when={isCurrentVoice(curVoice(), group.groupName)}>
                                    <span class="progress" style={`--progress: ${curProgress()}%`} />
                                  </Show>
                                </button>
                              </div>
                            );
                          }}
                        </For>
                      </div>
                    </Show>
                  </div>
                </div>
              </div>
            );
          }}
        </For>
      </div>

      {/* 悬浮播放控件（随页面滚动） */}
      <Show when={playing()}>
        {(p) => (
          <div class="bottom-sheet open">
            <div class="bottom-sheet__progress" style={{ width: p().progress + '%' }} />
            <div class="bottom-sheet__row">
              <div class="bottom-sheet__thumbs sficon">{String.fromCharCode(0xE767)}</div>
              <div class="bottom-sheet__info">
                <div class="bottom-sheet__name">{p().name}</div>
                <div class="bottom-sheet__status" role="status">{p().isLoading ? '加载中' : p().isPlaying ? '播放中' : '已暂停'}</div>
              </div>
              <Show when={hasClipboard() && baseGroups().some((group) =>
                group.groupName === currentGroupName() && normalVoices(group).some((voice) => voice.path === p().path))}>
                <button type="button" class="icon-btn sficon" onClick={share} aria-label="分享" title="分享">{String.fromCharCode(0xE72D)}</button>
              </Show>
              <button type="button" class="icon-btn sficon" onClick={toggleLoop} aria-label="循环" aria-pressed={loop()} title="循环">
                {loop() ? String.fromCharCode(0xE8EE) : String.fromCharCode(0xE8CD)}
              </button>
              <button type="button" class="icon-btn sficon" onClick={togglePlay} aria-label={p().isPlaying ? '暂停' : '播放'} title={p().isPlaying ? '暂停' : '播放'}>
                {p().isPlaying ? String.fromCharCode(0xE769) : String.fromCharCode(0xE768)}
              </button>
              <button type="button" class="icon-btn sficon" onClick={stopSound} aria-label="停止" title="停止">{String.fromCharCode(0xE711)}</button>
            </div>
          </div>
        )}
      </Show>

      {/* FAB */}
      <div class="fab-row">
        <Show when={fabOpen()}>
          <button type="button" class="fab sub fab-enter sficon" onClick={toggleLoop} title="循环" aria-label="循环" aria-pressed={loop()}>{String.fromCharCode(0xE8EE)}</button>
          <button type="button" class="fab sub fab-enter sficon" onClick={randomPlay} title="随机播放" aria-label="随机播放">{String.fromCharCode(0xE8B1)}</button>
        </Show>
        <button type="button" class="fab main sficon" onClick={() => setFabOpen(!fabOpen())} aria-label={fabOpen() ? '收起' : '更多功能'} aria-expanded={fabOpen()} title={fabOpen() ? '收起' : '更多功能'}>
          {fabOpen() ? String.fromCharCode(0xE711) : String.fromCharCode(0xE713)}
        </button>
      </div>

      {/* Toast */}
      <Show when={toast()}>
        <div class="toast" role="status">
          <span class="sficon">{String.fromCharCode(0xE73E)}</span>
          {toast()}
        </div>
      </Show>

      {/* 悬停信息卡片（Portal 到 body，避免被面板 overflow 裁切） */}
      <Portal>
        <Show when={tip()}>
          {(t) => (
            <div
              class="sound-tip"
              ref={tipElement}
              classList={{ below: !t().above }}
              style={{ left: t().x + 'px', top: t().y + 'px' }}
            >
              <Show when={t().thumb}>
                <img class="sound-tip__thumb" src={t().thumb} alt=""
                  onError={(e) => { e.currentTarget.style.display = 'none'; }} />
              </Show>
              <div class="sound-tip__body">
                <Show when={t().pos}>
                  <div class="sound-tip__pos">{t().pos}</div>
                </Show>
                <Show when={t().time}>
                  <div class="sound-tip__line"><span class="sound-tip__k">时间</span>{t().time}</div>
                </Show>
                <Show when={t().title}>
                  <div class="sound-tip__line"><span class="sound-tip__k">标题</span>{t().title}</div>
                </Show>
                <Show when={t().artist}>
                  <div class="sound-tip__line"><span class="sound-tip__k">原唱</span>{t().artist}</div>
                </Show>
                <Show when={t().note}>
                  <div class="sound-tip__line">{t().note}</div>
                </Show>
              </div>
            </div>
          )}
        </Show>
      </Portal>
    </>
  );
}

export default SoundBoard;
