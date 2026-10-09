import { audioUrl } from './board-data.ts';
import type { Voice } from '../data/voices.ts';

export interface Playing {
  audio: HTMLAudioElement;
  name: string;
  path: string;
  groupName: string;
  isPlaying: boolean;
  isLoading: boolean;
  progress: number;
}

/** 媒体生命周期集中管理；迟到的事件只更新所属音频，不能覆盖新的播放。 */
export function createAudioPlayer(
  onChange: (playing: Playing | null) => void,
  onError: (message: string) => void,
  makeAudio: (url: string) => HTMLAudioElement = (url) => new Audio(url),
) {
  let current: Playing | null = null;
  let looping = false;
  let removeListeners = () => {};

  function publish() {
    onChange(current ? { ...current } : null);
  }

  function stop() {
    const previous = current;
    current = null;
    removeListeners();
    removeListeners = () => {};
    if (previous) {
      previous.audio.pause();
      previous.audio.removeAttribute('src');
      previous.audio.load();
    }
    publish();
  }

  async function resume(audio: HTMLAudioElement) {
    try {
      await audio.play();
    } catch (error) {
      if (current?.audio !== audio) return;
      if (error instanceof Error && error.name === 'NotAllowedError') {
        current.isLoading = false;
        current.isPlaying = false;
        publish();
        onError('浏览器阻止了自动播放，请点击播放按钮');
      } else {
        stop();
        onError('播放失败：文件不存在或格式不支持');
      }
    }
  }

  function play(voice: Voice, groupName: string) {
    stop();
    const audio = makeAudio(audioUrl(voice.path));
    audio.loop = looping;
    current = {
      audio,
      name: voice.zh,
      path: voice.path,
      groupName,
      isPlaying: false,
      isLoading: true,
      progress: 0,
    };
    const listen = (event: string, action: () => void) => {
      const handler = () => {
        if (current?.audio !== audio) return;
        action();
      };
      audio.addEventListener(event, handler);
      return () => audio.removeEventListener(event, handler);
    };
    const cleanup = [
      listen('playing', () => {
        current!.isLoading = false;
        current!.isPlaying = true;
        publish();
      }),
      listen('pause', () => {
        current!.isLoading = false;
        current!.isPlaying = false;
        publish();
      }),
      listen('waiting', () => {
        current!.isLoading = true;
        publish();
      }),
      listen('timeupdate', () => {
        const progress = Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.currentTime / audio.duration * 100
          : 0;
        current!.progress = Math.max(0, Math.min(100, progress));
        publish();
      }),
      listen('ended', () => {
        if (!audio.loop) stop();
      }),
      listen('error', () => {
        stop();
        onError('播放失败：文件不存在或格式不支持');
      }),
    ];
    removeListeners = () => cleanup.forEach((remove) => remove());
    publish();
    void resume(audio);
  }

  return {
    play,
    stop,
    toggle() {
      const audio = current?.audio;
      if (!audio) return;
      if (audio.paused) void resume(audio);
      else audio.pause();
    },
    setLoop(value: boolean) {
      looping = value;
      if (current) current.audio.loop = value;
    },
  };
}
