import {
  DestroyRef,
  Directive,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

/** Allowed drift (seconds) between the video and the playhead during playback. */
const PLAYBACK_TOLERANCE = 0.25;
/** Paused frames are re-seeked when off by more than this (about half a frame at 60 fps). */
const SEEK_TOLERANCE = 1 / 120;

/**
 * Keeps a `<video>` element in step with the editor: seeks to `time` while
 * paused or scrubbing, plays along during playback (correcting drift) and
 * reports buffering through `loading`.
 */
@Directive({
  selector: 'video[appPreviewVideo]',
  exportAs: 'previewVideo',
  host: {
    '[muted]': 'true',
    playsinline: '',
    preload: 'auto',
    '(loadstart)': 'loading.set(true)',
    '(waiting)': 'loading.set(true)',
    '(seeking)': 'onSeeking()',
    '(loadeddata)': 'onReady()',
    '(seeked)': 'onReady()',
    '(canplay)': 'onReady()',
    '(playing)': 'onReady()',
    '(error)': 'failed.emit()',
  },
})
export class PreviewVideo {
  /** Position in the source media, in seconds. */
  readonly time = input.required<number>();
  readonly playing = input(false);
  readonly failed = output<void>();
  /** True while the element has no frame to show for `time`. */
  readonly loading = signal(true);

  private readonly video = inject<ElementRef<HTMLVideoElement>>(ElementRef).nativeElement;
  private seekTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => this.sync(this.time(), this.playing()));
    inject(DestroyRef).onDestroy(() => this.clearSeekTimer());
  }

  protected onReady(): void {
    if (this.video.readyState >= 2 && !this.video.seeking) {
      this.clearSeekTimer();
      this.loading.set(false);
    }
  }

  protected onSeeking(): void {
    // Short seeks are not worth a spinner; only show one when a seek is slow.
    this.clearSeekTimer();
    this.seekTimer = setTimeout(() => {
      if (this.video.seeking) {
        this.loading.set(true);
      }
    }, 150);
  }

  private sync(time: number, playing: boolean): void {
    const video = this.video;
    const drift = Math.abs(video.currentTime - time);
    if (playing) {
      if (drift > PLAYBACK_TOLERANCE) {
        video.currentTime = time;
      }
      if (video.paused) {
        // Rejected when interrupted by a pause or when the element is unsupported.
        Promise.resolve(video.play?.()).catch(() => undefined);
      }
      return;
    }
    if (!video.paused) {
      video.pause?.();
    }
    if (drift > SEEK_TOLERANCE) {
      video.currentTime = time;
    }
  }

  private clearSeekTimer(): void {
    if (this.seekTimer !== null) {
      clearTimeout(this.seekTimer);
      this.seekTimer = null;
    }
  }
}
