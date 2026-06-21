// ===== 効果音エンジン（Web Audio・基本は合成音＋一部サンプル） ========

// ライン成立音（サンプル）。連鎖1回目〜5回目で出し分け、5以降は5を継続。
// Viteが本番でハッシュ付きURLに解決する。
const lineWinUrls = [
  new URL("./lineAttack1.wav", import.meta.url).href,
  new URL("./lineAttack2.wav", import.meta.url).href,
  new URL("./lineAttack3.wav", import.meta.url).href,
  new URL("./lineAttack4.wav", import.meta.url).href,
  new URL("./lineAttack5.wav", import.meta.url).href,
];
// ゲーム開始〜初回配当決定の間に流す効果音（リール停止でカット）
const playStartUrl = new URL("./gamePlayStart.wav", import.meta.url).href;

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private spinNodes: { osc: OscillatorNode; gain: GainNode } | null = null;
  private lineWinBufs: (AudioBuffer | null)[] = [null, null, null, null, null];
  private playStartBuf: AudioBuffer | null = null;
  private playStartSrc: AudioBufferSourceNode | null = null;
  private playStartGain: GainNode | null = null;
  private samplesLoading = false;
  muted = false;

  /** ユーザー操作後に一度だけ呼ぶ（自動再生ポリシー対策） */
  resume(): void {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    void this.loadSamples();
  }

  /** サンプル音源を遅延ロード（初回ユーザー操作後）。失敗しても静かに無効化。 */
  private async loadSamples(): Promise<void> {
    if (!this.ctx || this.lineWinBufs[0] || this.samplesLoading) return;
    this.samplesLoading = true;
    const load = async (url: string): Promise<AudioBuffer | null> => {
      try {
        const res = await fetch(url);
        return await this.ctx!.decodeAudioData(await res.arrayBuffer());
      } catch {
        return null; // 失敗しても静かに無効化
      }
    };
    try {
      await Promise.all([
        ...lineWinUrls.map(async (url, i) => { this.lineWinBufs[i] = await load(url); }),
        (async () => { this.playStartBuf = await load(playStartUrl); })(),
      ]);
    } finally {
      this.samplesLoading = false;
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(m ? 0 : 0.35, this.ctx.currentTime, 0.02);
    }
  }

  private get out(): AudioNode | null {
    return this.muted ? null : this.master;
  }

  /** 単発トーン */
  private tone(
    freq: number,
    dur: number,
    type: OscillatorType = "sine",
    opts: { gain?: number; sweepTo?: number; delay?: number } = {}
  ): void {
    if (!this.ctx || !this.out) return;
    const t0 = this.ctx.currentTime + (opts.delay ?? 0);
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.sweepTo) osc.frequency.exponentialRampToValueAtTime(opts.sweepTo, t0 + dur);
    const peak = opts.gain ?? 0.4;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.out);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** ノイズ的な短い打撃音 */
  private click(): void {
    if (!this.ctx || !this.out) return;
    const t0 = this.ctx.currentTime;
    const buffer = this.ctx.createBuffer(1, 1024, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const g = this.ctx.createGain();
    g.gain.value = 0.25;
    const f = this.ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = 1800;
    src.connect(f).connect(g).connect(this.out);
    src.start(t0);
  }

  // --- ゲームイベント別 -------------------------------------------------

  /** スピン中のループ音。ユーザー要望で「ブー」音は廃止＝無音（呼び出しは互換のため残す）。 */
  startSpin(): void {
    /* 意図的に無音。サンプル音(playStart)側でスピン中の演出を担う。 */
  }

  stopSpin(): void {
    if (!this.ctx || !this.spinNodes) return;
    const { osc, gain } = this.spinNodes;
    gain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.03);
    osc.stop(this.ctx.currentTime + 0.1);
    this.spinNodes = null;
  }

  /** リール停止音 */
  reelStop(): void {
    this.click();
    this.tone(220, 0.08, "square", { gain: 0.18 });
  }

  /** リーチ（あと1つで揃う）の緊張音 */
  reach(): void {
    this.tone(440, 0.5, "sine", { gain: 0.3, sweepTo: 660 });
    this.tone(880, 0.5, "sine", { gain: 0.15, sweepTo: 990, delay: 0.05 });
  }

  /** 小当たり */
  winSmall(): void {
    const notes = [523, 659, 784];
    notes.forEach((f, i) => this.tone(f, 0.18, "triangle", { gain: 0.35, delay: i * 0.07 }));
  }

  /** 大当たり */
  winBig(): void {
    const notes = [523, 659, 784, 1046, 1318];
    notes.forEach((f, i) => this.tone(f, 0.25, "triangle", { gain: 0.4, delay: i * 0.08 }));
    this.tone(130, 0.6, "sawtooth", { gain: 0.2 });
  }

  /** ライン成立音（サンプル再生）。連鎖回数で1〜5を出し分け、5以降は5。未ロード/ミュート時は無音。 */
  lineWin(chain = 1): void {
    if (!this.ctx || !this.out) return;
    const idx = Math.min(Math.max(chain, 1), 5) - 1; // 1→0 … 5以降→4
    const buf = this.lineWinBufs[idx];
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = 0.8; // master(0.35)経由。大きすぎ/小さすぎはここで調整
    src.connect(g).connect(this.out);
    src.start();
  }

  /** ゲーム開始効果音を再生（1回・最後まで流す）。被る時は fadeOutPlayStart() で徐々に消す。 */
  playStart(): void {
    if (!this.ctx || !this.out || !this.playStartBuf) return;
    this.stopPlayStart(); // 前回ぶんを止めて多重再生防止
    const src = this.ctx.createBufferSource();
    src.buffer = this.playStartBuf;
    const g = this.ctx.createGain();
    g.gain.value = 0.7; // master(0.35)経由。音量はここで調整
    src.connect(g).connect(this.out);
    src.onended = () => {
      if (this.playStartSrc === src) { this.playStartSrc = null; this.playStartGain = null; }
    };
    src.start();
    this.playStartSrc = src;
    this.playStartGain = g;
  }

  /** 開始効果音を徐々にフェードアウト（ライン音などと被る時用）。 */
  fadeOutPlayStart(dur = 0.6): void {
    if (!this.ctx || !this.playStartSrc) return;
    if (this.playStartGain) {
      const now = this.ctx.currentTime;
      const g = this.playStartGain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0.0001, now + dur);
    }
    try { this.playStartSrc.stop(this.ctx.currentTime + dur + 0.05); } catch { /* noop */ }
    this.playStartSrc = null;
    this.playStartGain = null;
  }

  /** 開始効果音を即停止 */
  stopPlayStart(): void {
    if (!this.playStartSrc) return;
    try { this.playStartSrc.stop(); } catch { /* 既に停止済み */ }
    this.playStartSrc = null;
    this.playStartGain = null;
  }

  /** 連鎖音（連鎖が伸びるほど高く） */
  chain(level: number): void {
    const base = 440 * Math.pow(2, Math.min(level - 1, 8) / 12);
    this.tone(base, 0.16, "triangle", { gain: 0.34 });
    this.tone(base * 1.5, 0.16, "sine", { gain: 0.18, delay: 0.03 });
    this.click();
  }

  /** RUSH 突入ファンファーレ */
  bonus(): void {
    const seq = [392, 523, 659, 784, 1046];
    seq.forEach((f, i) => {
      this.tone(f, 0.3, "square", { gain: 0.35, delay: i * 0.12 });
      this.tone(f * 2, 0.3, "triangle", { gain: 0.18, delay: i * 0.12 });
    });
  }

  // --- RUSH 専用 BGM（ループシーケンサー） -----------------------------
  private bgm: {
    timer: number;
    nextTime: number;
    step: number;
    gain: GainNode;
  } | null = null;

  private bgmNote(
    freq: number,
    start: number,
    dur: number,
    dest: GainNode,
    peak: number,
    type: OscillatorType
  ): void {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g).connect(dest);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }

  startRushBgm(): void {
    if (!this.ctx || !this.master || this.bgm) return;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.5;
    gain.connect(this.master);

    const tempo = 152;
    const stepDur = 60 / tempo / 2; // 8分音符
    const root = 220; // A3
    // マイナーペンタトニックで駆け上がる8ステップのアルペジオ
    const arp = [0, 3, 5, 7, 10, 12, 10, 7];
    const bassSeq = [0, 0, 5, 5, 3, 3, 7, 7];

    this.bgm = {
      timer: 0,
      nextTime: this.ctx.currentTime + 0.06,
      step: 0,
      gain,
    };

    const schedule = () => {
      if (!this.ctx || !this.bgm) return;
      while (this.bgm.nextTime < this.ctx.currentTime + 0.14) {
        const s = this.bgm.step % 8;
        const t = this.bgm.nextTime;
        // アルペジオ
        this.bgmNote(
          root * Math.pow(2, arp[s] / 12),
          t,
          stepDur * 0.85,
          this.bgm.gain,
          0.13,
          "square"
        );
        // ベース（裏打ち薄め）
        this.bgmNote(
          (root / 2) * Math.pow(2, bassSeq[s] / 12),
          t,
          stepDur * 1.3,
          this.bgm.gain,
          0.2,
          "sawtooth"
        );
        // ハイハット代わりの短い高音
        if (s % 2 === 1) {
          this.bgmNote(3520, t, 0.03, this.bgm.gain, 0.05, "triangle");
        }
        this.bgm.nextTime += stepDur;
        this.bgm.step++;
      }
    };
    this.bgm.timer = window.setInterval(schedule, 25);
    schedule();
  }

  stopRushBgm(): void {
    if (!this.bgm) return;
    clearInterval(this.bgm.timer);
    const { gain } = this.bgm;
    if (this.ctx) {
      gain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.1);
      setTimeout(() => gain.disconnect(), 400);
    }
    this.bgm = null;
  }

  /** ボタンのクリック感 */
  ui(): void {
    this.tone(660, 0.05, "square", { gain: 0.15 });
  }

  /** 残高不足 */
  deny(): void {
    this.tone(160, 0.18, "sawtooth", { gain: 0.25, sweepTo: 110 });
  }
}
