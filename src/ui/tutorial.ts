// ===== あそびかたチュートリアル（初心者向けオーバーレイ） ================
// 全6章・16カード。文章は最小限で、実ゲーム風のミニ盤面デモ（DOM+CSSのみ）が
// ルールを見せる。配当表と同じ .paytable-overlay 型の全画面オーバーレイで、
// ゲームの状態には一切触らない。
//
// 保存:
//   triple-slot.tutorial.seen  … 初回自動表示を済ませたか（"1"）
//   triple-slot.tutorial.stars … 最後まで見た章のindex配列（JSON、プレイヤー共通）
import type { Sfx } from "../audio/sfx";

const SEEN_KEY = "triple-slot.tutorial.seen";
const STARS_KEY = "triple-slot.tutorial.stars";

/** 1カードぶんのデモ。tick は表示中だけ回す setInterval のID を返す。 */
interface Demo {
  html: string;
  tick?: (root: HTMLElement) => number;
}
interface Step {
  /** カード見出し */
  t: string;
  /** 本文（<em>=ネオン強調 / <strong>=金強調） */
  b: string;
  d: () => Demo;
}
interface Chapter {
  icon: string;
  name: string;
  desc: string;
  steps: Step[];
}

// ---- ミニ盤面ヘルパー（204px固定・セル64px+ギャップ6px） ----------------
const C = [32, 102, 172]; // セル中心座標

function cell(glyph: string, cls = ""): string {
  return `<div class="tut-mc ${cls}"><span class="g">${glyph}</span></div>`;
}
function grid(cells: string[], overlay = ""): string {
  return `<div class="tut-mgwrap"><div class="tut-mg">${cells.join("")}</div>${overlay}</div>`;
}
/** セルindex(0..8)のペアを結ぶ「道」SVG（コネクト表示用） */
function roads(pairs: [number, number][], color: string): string {
  const lines = pairs
    .map(
      ([a, b]) =>
        `<line x1="${C[a % 3]}" y1="${C[(a / 3) | 0]}" x2="${C[b % 3]}" y2="${C[(b / 3) | 0]}"
           stroke="${color}" style="color:${color}"/>`
    )
    .join("");
  return `<svg class="tut-roads" viewBox="0 0 204 204" width="204" height="204">${lines}</svg>`;
}

// ---- 各カードのデモ ------------------------------------------------------
function demoBet(): Demo {
  return {
    html: `
      <div class="tut-col">
        <div class="tut-meters">
          <div class="tut-meter"><div class="lb">メダル</div><div class="val">1000</div></div>
          <div class="tut-meter"><div class="lb">BET</div><div class="val" data-bet-val>10</div></div>
        </div>
        <div class="tut-btnrow">
          <span class="tut-fakebtn">BET ▲</span>
          <span class="tut-fakebtn gold">MAX BET</span>
          <span class="tut-finger" style="left:26px;top:26px">👆</span>
        </div>
      </div>`,
    tick: (root) => {
      const seq = [10, 50, 100, 500];
      let i = 0;
      const el = root.querySelector("[data-bet-val]")!;
      return window.setInterval(() => {
        i = (i + 1) % seq.length;
        el.textContent = String(seq[i]);
      }, 900);
    },
  };
}

function demoSpin(): Demo {
  const cells = ["🍒", "🍊", "🔔", "🍇", "🍒", "🍈", "🍌", "🔔", "🍊"].map((g) =>
    cell(g, "spinning")
  );
  return {
    html: `
      <div class="tut-col">
        ${grid(cells)}
        <div class="tut-btnrow">
          <span class="tut-fakebtn gold big">SPIN</span>
          <span class="tut-finger" style="left:50%;top:16px;margin-left:-8px">👆</span>
        </div>
      </div>`,
  };
}

function demoFirstWin(): Demo {
  const cells = [
    cell("🍊"), cell("🍇"), cell("🔔"),
    cell("🍒", "hit"), cell("🍒", "hit"), cell("🍒", "hit"),
    cell("🍌"), cell("🍈"), cell("🍊"),
  ];
  const line = `<svg class="tut-lines" viewBox="0 0 204 204" width="204" height="204">
    <line class="lit" x1="14" y1="102" x2="190" y2="102"/></svg>`;
  return {
    html: `
      <div class="tut-col">
        ${grid(cells, line)}
        <div class="tut-meter winc"><div class="lb">WIN</div><div class="val" data-win-val>0</div></div>
      </div>`,
    tick: (root) => {
      const el = root.querySelector("[data-win-val]")!;
      let v = 0;
      return window.setInterval(() => {
        v = v >= 100 ? 0 : v + 10;
        el.textContent = String(v);
      }, 130);
    },
  };
}

function demoLines(): Demo {
  const cells: string[] = [];
  for (let i = 0; i < 9; i++) cells.push(cell("🍒"));
  const L: [number, number, number, number][] = [
    [14, 32, 190, 32], [14, 102, 190, 102], [14, 172, 190, 172],
    [32, 14, 32, 190], [102, 14, 102, 190], [172, 14, 172, 190],
    [16, 16, 188, 188], [188, 16, 16, 188],
  ];
  const svg =
    `<svg class="tut-lines" viewBox="0 0 204 204" width="204" height="204">` +
    L.map(([x1, y1, x2, y2]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`).join("") +
    `</svg>`;
  return {
    html: grid(cells, svg) + `<div class="tut-stage-label goldc" data-line-lbl>よこ の ライン</div>`,
    tick: (root) => {
      const lines = root.querySelectorAll(".tut-lines line");
      const lbl = root.querySelector("[data-line-lbl]")!;
      const names = ["よこ", "よこ", "よこ", "たて", "たて", "たて", "ななめ", "ななめ"];
      let i = 0;
      lines[0].classList.add("lit");
      return window.setInterval(() => {
        lines[i].classList.remove("lit");
        i = (i + 1) % 8;
        lines[i].classList.add("lit");
        lbl.textContent = `${names[i]} の ライン`;
      }, 850);
    },
  };
}

function demoConnect(): Demo {
  const cells = [
    cell("🔔", "hit"), cell("🔔", "hit"), cell("🍇"),
    cell("🍊"), cell("🔔", "hit"), cell("🍈"),
    cell("🍌"), cell("🔔", "hit"), cell("🍒"),
  ];
  return {
    html:
      grid(cells, roads([[0, 1], [1, 4], [4, 7]], "#ffd24a")) +
      `<div class="tut-stage-label goldc">みちが ひかって つながる！</div>`,
  };
}

function demoDiagonal(): Demo {
  const c2 = [21, 67, 113]; // 40pxセル+6pxギャップのミニ盤面の中心
  const mini = (
    cells: string[],
    pairs: [number, number][],
    color: string,
    dash: boolean,
    cap: string,
    capCls: string
  ) => {
    const lines = pairs
      .map(
        ([a, b]) =>
          `<line x1="${c2[a % 3]}" y1="${c2[(a / 3) | 0]}" x2="${c2[b % 3]}" y2="${c2[(b / 3) | 0]}"
             stroke="${color}" style="color:${color}${dash ? ";stroke-dasharray:5 6" : ""}"/>`
      )
      .join("");
    return `<div>
      <div class="tut-mgwrap mini">
        <div class="tut-mg mini">${cells
          .map((g) => `<div class="tut-mc mini"><span class="g">${g}</span></div>`)
          .join("")}</div>
        <svg class="tut-roads" viewBox="0 0 132 132" width="132" height="132">${lines}</svg>
      </div>
      <div class="tut-cap ${capCls}">${cap}</div>
    </div>`;
  };
  const ok = mini(
    ["🍇", "🍒", "🍒", "🍒", "🍇", "🍒", "🍒", "🍒", "🍇"],
    [[0, 4], [4, 8]], "#7dff9e", false, "まんなか なら ○", "ok"
  );
  const ng = mini(
    ["🍒", "🍇", "🍒", "🍇", "🍒", "🍒", "🍒", "🍒", "🍒"],
    [[1, 3]], "#ff7d7d", true, "はしっこ どうしは ✕", "ng"
  );
  return { html: `<div class="tut-okng">${ok}${ng}</div>` };
}

function demoCascade(): Demo {
  const cells = [
    cell("🍇", "dropin"), cell("🍊", "dropin"), cell("🔔", "dropin"),
    cell("🍒"), cell("🍈"), cell("🍌"),
    cell("🍊"), cell("🍒"), cell("🍈"),
  ];
  return { html: grid(cells) + `<div class="tut-stage-label">きえたぶん、上から ふってくる</div>` };
}

function demoCombo(): Demo {
  return {
    html: `
      <div class="tut-col">
        <div class="tut-combo">4 れんさ！</div>
        <div class="tut-meter winc"><div class="lb">COMBO BONUS</div><div class="val">BET ×1</div></div>
        <div class="tut-note">5れんさ ×2 ／ 6れんさ ×4 ／ 7れんさ ×8 …</div>
      </div>`,
  };
}

function demoOdds(): Demo {
  return {
    html: `
      <div class="tut-odds">
        <div class="tut-oddsrow"><span class="sym">🔔</span> ベル <span class="mult">×6</span></div>
        <div class="tut-oddsrow up"><span class="sym">🍈</span> メロン <span class="arrow">▲UP</span><span class="mult" data-odd-a>×5</span></div>
        <div class="tut-oddsrow up"><span class="sym">🍒</span> チェリー <span class="arrow">▲UP</span><span class="mult" data-odd-b>×1</span></div>
      </div>`,
    tick: (root) => {
      const a = root.querySelector("[data-odd-a]")!;
      const b = root.querySelector("[data-odd-b]")!;
      let on = false;
      return window.setInterval(() => {
        on = !on;
        a.textContent = on ? "×6" : "×5";
        b.textContent = on ? "×2" : "×1";
      }, 1100);
    },
  };
}

function demoIce(): Demo {
  const cells = [
    cell("🍒", "hit"), cell("🍒", "hit"), cell("🍒", "hit"),
    cell("🍊", "frozen"), cell("🍈"), cell("🍇", "frozen"),
    cell("🍌"), cell("🍊"), cell("🔔"),
  ];
  const line = `<svg class="tut-lines" viewBox="0 0 204 204" width="204" height="204">
    <line class="lit" x1="14" y1="32" x2="190" y2="32"/></svg>`;
  return {
    html: grid(cells, line) + `<div class="tut-stage-label">❄のマスは あたりに はいれない</div>`,
  };
}

function demoMelt(): Demo {
  const cells = [
    cell("🍒", "hit"), cell("🍒", "hit"), cell("🍒", "hit"),
    cell("🍊", "frozen melting"), cell("🍈"), cell("🍇"),
    cell("🍌"), cell("🍊"), cell("🔔"),
  ];
  return { html: grid(cells) + `<div class="tut-stage-label goldc">となりで あたると とける！</div>` };
}

function demoRushIn(): Demo {
  const cells = [
    cell("🍊"), cell("7️⃣", "hit scat"), cell("🍇"),
    cell("7️⃣", "hit scat"), cell("🍈"), cell("🍌"),
    cell("🍒"), cell("🔔"), cell("7️⃣", "hit scat"),
  ];
  return { html: grid(cells) + `<div class="tut-stage-label goldc">7️⃣が 3こ で ラッシュ！</div>` };
}

function demoRushMode(): Demo {
  const b7 = `<span class="b7">7</span>`;
  const r7 = `<span class="r7">7</span>`;
  const cells = [
    cell(b7), cell(r7, "hit"), cell(b7),
    cell(r7, "hit"), cell(b7), cell("🍈"),
    cell(r7, "hit"), cell(b7), cell(b7),
  ];
  const line = `<svg class="tut-lines" viewBox="0 0 204 204" width="204" height="204">
    <line class="lit" x1="32" y1="14" x2="32" y2="190"/></svg>`;
  return {
    html: `<div class="tut-rushbg"></div>
      <div class="tut-col over">
        ${grid(cells, line)}
        <div class="tut-rushmeter">FREE SPIN あと 7</div>
      </div>`,
  };
}

function demoDuIntro(): Demo {
  return {
    html: `
      <div class="tut-col">
        <div class="tut-meter winc"><div class="lb">WIN</div><div class="val">500</div></div>
        <div class="tut-btnrow wrap">
          <span class="tut-fakebtn gold">COLLECT</span>
          <span class="tut-fakebtn">半分かける</span>
          <span class="tut-fakebtn">全部かける</span>
        </div>
        <div class="tut-note">まよったら <b class="gold">COLLECT</b>（そのまま もらう）でOK</div>
      </div>`,
  };
}

function demoDuPick(): Demo {
  return {
    html: `
      <div class="tut-col">
        <div class="tut-note"><b class="pink">ディーラー</b>のシンボルより つよければ かち！</div>
        <div class="tut-ducards">
          <div><div class="tut-ducard dealer">🍊</div><div class="tut-note"><b class="pink">ディーラー</b></div></div>
          <div class="tut-duvs">VS</div>
          <div><div class="tut-ducard pick">🔔</div><div class="tut-note"><b class="gold">きみ</b></div></div>
        </div>
        <div class="tut-meter winc"><div class="lb">WIN</div><div class="val">500 → 1000</div></div>
      </div>`,
  };
}

function demoDuToggle(): Demo {
  return {
    html: `
      <div class="tut-col">
        <div class="tut-btnrow">
          <span class="tut-tg on" data-tg-on>ダブル ON</span>
          <span class="tut-tg" data-tg-off>ダブル OFF</span>
        </div>
        <div class="tut-note">OFFにすると かった メダルは <b class="gold">ぜんぶ じどうで もらえる</b></div>
      </div>`,
    tick: (root) => {
      const a = root.querySelector("[data-tg-on]")!;
      const b = root.querySelector("[data-tg-off]")!;
      return window.setInterval(() => {
        a.classList.toggle("on");
        b.classList.toggle("on");
      }, 1400);
    },
  };
}

// ---- 章データ（あそぶのに必要な順） --------------------------------------
const CHAPTERS: Chapter[] = [
  {
    icon: "🎰", name: "きほんの あそびかた", desc: "メダルを かけて まわそう",
    steps: [
      { t: "メダルを かけよう", b: `<em>BET ▲</em> で かける まいすうを えらぶよ。<strong>MAX BET</strong> は いちばん おおく かける ボタン。`, d: demoBet },
      { t: "SPIN を おそう", b: `<em>SPIN</em> を おすと 9この シンボルが くるくる まわって とまるよ。`, d: demoSpin },
      { t: "そろえば あたり！", b: `おなじ シンボルが ならぶと <strong>WIN</strong> に メダルが はいるよ。`, d: demoFirstWin },
    ],
  },
  {
    icon: "⭐", name: "あたりの しくみ", desc: "ラインと つながりで あたり",
    steps: [
      { t: "ラインは 8ほん", b: `<em>たて3・よこ3・ななめ2</em>。どこか 1れつに おなじ シンボルが 3つ ならべば あたり！`, d: demoLines },
      { t: "つながっても あたり", b: `ラインじゃなくても、おなじ シンボルが <strong>3こ いじょう となりどうし</strong> なら コネクトボーナス！`, d: demoConnect },
      { t: "ななめの ルール", b: `ななめの つながりは <em>まんなかの マス</em> を とおる ときだけ だよ。`, d: demoDiagonal },
    ],
  },
  {
    icon: "🌠", name: "れんさと オッズ", desc: "きえて ふって また あたる",
    steps: [
      { t: "れんさが おこる", b: `あたった シンボルは きえて、<em>上から あたらしいのが ふってくる</em>。また そろえば れんさ！`, d: demoCascade },
      { t: "4れんさで ボーナス", b: `れんさが <strong>4かい</strong> つづくと コンボボーナス！ つづくほど どんどん ふえるよ。`, d: demoCombo },
      { t: "オッズが あがる", b: `ラインで あたった シンボルは、<em>ばいりつの かいだん</em> を 1だん のぼるよ（つぎの スピンで もとどおり）。`, d: demoOdds },
    ],
  },
  {
    icon: "🧊", name: "こおりの マス", desc: "こおりは とかして つかおう",
    steps: [
      { t: "こおりは あたらない", b: `❄が ついた マスは <em>あたりに はいれない</em>よ。`, d: demoIce },
      { t: "となりで とかそう", b: `こおりの <strong>となりで あたる</strong>と とけて、つぎの れんさから つかえるように なるよ！`, d: demoMelt },
    ],
  },
  {
    icon: "7️⃣", name: "セブンラッシュ", desc: "7️⃣を 3こ あつめよう",
    steps: [
      { t: "7️⃣が 3こで とつにゅう", b: `さいしょの ばんめんに <strong>7️⃣が 3こ</strong> あると セブンラッシュ！`, d: demoRushIn },
      { t: "7かい タダで まわせる", b: `ラッシュちゅうは <em>7ゲーム むりょう</em>！ <strong>青7・赤7</strong> が いっぱい でて おおあたりの チャンス！`, d: demoRushMode },
    ],
  },
  {
    icon: "🎲", name: "ダブルアップ", desc: "かったら 2ばいに ちょうせん",
    steps: [
      { t: "かったら ちょうせんできる", b: `あたった あとに えらべるよ。<strong>COLLECT</strong> なら そのまま もらえる。`, d: demoDuIntro },
      { t: "つよい ほうが かち", b: `ディーラーより <em>つよい シンボル</em>を ひけたら メダルが <strong>2ばい</strong>！ おなじなら もういっかい。`, d: demoDuPick },
      { t: "しんぱいなら OFF", b: `「<em>半分かける</em>」なら はんぶんは ちょきん。<strong>ダブル OFF</strong> ボタンで ぜんぶ じどうCOLLECTにも できるよ。`, d: demoDuToggle },
    ],
  },
];

// ---- 本体 ---------------------------------------------------------------
export class Tutorial {
  readonly el: HTMLElement;
  private screen: HTMLElement;
  private timer: number | null = null;
  private done = new Set<number>();

  constructor(private sfx: Sfx) {
    this.done = loadStars();
    this.el = document.createElement("div");
    this.el.className = "tut-overlay hidden";
    this.el.innerHTML = `
      <div class="tut-panel">
        <div class="tut-head">
          <span class="tut-title">あそびかた</span>
          <span class="tut-sub" data-tut-sub>TUTORIAL</span>
          <button class="tut-x" data-tut-close aria-label="とじる">✕</button>
        </div>
        <div class="tut-screen" data-tut-screen></div>
      </div>`;
    this.screen = this.el.querySelector("[data-tut-screen]") as HTMLElement;

    this.el.querySelector("[data-tut-close]")!.addEventListener("click", () => this.close());
    this.el.addEventListener("click", (e) => {
      if (e.target === this.el) this.close();
    });
  }

  open(): void {
    this.sfx.resume();
    this.sfx.ui();
    markSeen();
    this.renderMenu();
    this.el.classList.remove("hidden");
    this.el.scrollTop = 0;
  }

  close(): void {
    this.sfx.ui();
    this.clearTimer();
    this.el.classList.add("hidden");
  }

  /** 初回だけ自動で開く（プレイヤー選択の直後に呼ぶ）。開いたら true。 */
  maybeAutoOpen(): boolean {
    if (localStorage.getItem(SEEN_KEY)) return false;
    this.open();
    return true;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private setSub(text: string): void {
    (this.el.querySelector("[data-tut-sub]") as HTMLElement).textContent = text;
  }

  // ---- メニュー（章えらび） ----
  private renderMenu(): void {
    this.clearTimer();
    this.setSub("TUTORIAL");
    const cards = CHAPTERS.map(
      (ch, i) => `
      <button class="tut-ch" data-ch="${i}">
        <span class="tut-ch-icon">${ch.icon}</span>
        <span class="tut-ch-txt">
          <span class="tut-ch-name">${ch.name}</span>
          <span class="tut-ch-desc">${ch.desc}</span>
        </span>
        <span class="tut-star${this.done.has(i) ? " lit" : ""}">★</span>
      </button>`
    ).join("");
    this.screen.innerHTML = `
      <div class="tut-chlist">${cards}</div>
      <div class="tut-menu-foot">
        <button class="btn gold" data-ch="0">▶ さいしょから みる</button>
      </div>`;
    this.screen.querySelectorAll<HTMLElement>("[data-ch]").forEach((b) =>
      b.addEventListener("click", () => {
        this.sfx.ui();
        this.renderLesson(Number(b.dataset.ch), 0);
      })
    );
  }

  // ---- レッスン（カード送り） ----
  private renderLesson(ci: number, si: number): void {
    this.clearTimer();
    const ch = CHAPTERS[ci];
    const st = ch.steps[si];
    const demo = st.d();
    const isLast = si === ch.steps.length - 1;
    const hasNextCh = ci < CHAPTERS.length - 1;
    this.setSub(`${ch.icon} ${ch.name}`);

    const dots = ch.steps
      .map(
        (_, i) =>
          `<button class="tut-dot${i === si ? " on" : ""}" data-si="${i}" aria-label="カード${i + 1}"></button>`
      )
      .join("");
    const backBtn =
      si > 0
        ? `<button class="btn ghost" data-act="prev">← もどる</button>`
        : `<button class="btn ghost" data-act="menu">← メニュー</button>`;
    const nextBtn = !isLast
      ? `<button class="btn primary" data-act="next">つぎへ →</button>`
      : hasNextCh
        ? `<button class="btn gold" data-act="nextch">★GET! つぎの章へ →</button>`
        : `<button class="btn gold" data-act="fin">★GET! おしまい</button>`;

    this.screen.innerHTML = `
      <div class="tut-stage">${demo.html}</div>
      <div class="tut-lesson-text">
        <div class="tut-lesson-title">${st.t}</div>
        <div class="tut-lesson-body">${st.b}</div>
      </div>
      <div class="tut-dots">${dots}</div>
      <div class="tut-nav">${backBtn}${nextBtn}</div>`;

    const stage = this.screen.querySelector(".tut-stage") as HTMLElement;
    if (demo.tick) this.timer = demo.tick(stage);
    if (isLast) this.markDone(ci);

    this.screen.querySelectorAll<HTMLElement>(".tut-dot").forEach((d) =>
      d.addEventListener("click", () => {
        this.sfx.ui();
        this.renderLesson(ci, Number(d.dataset.si));
      })
    );
    this.screen.querySelectorAll<HTMLElement>("[data-act]").forEach((b) =>
      b.addEventListener("click", () => {
        this.sfx.ui();
        switch (b.dataset.act) {
          case "menu": this.renderMenu(); break;
          case "prev": this.renderLesson(ci, si - 1); break;
          case "next": this.renderLesson(ci, si + 1); break;
          case "nextch": this.renderLesson(ci + 1, 0); break;
          case "fin": this.renderMenu(); break;
        }
      })
    );
  }

  private markDone(ci: number): void {
    if (this.done.has(ci)) return;
    this.done.add(ci);
    saveStars(this.done);
  }
}

// ---- 保存（失敗してもゲームを妨げない） ----------------------------------
function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* 保存できなくても続行 */
  }
}
function loadStars(): Set<number> {
  try {
    const raw = localStorage.getItem(STARS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(arr) ? arr.filter((n) => typeof n === "number") : []);
  } catch {
    return new Set();
  }
}
function saveStars(done: Set<number>): void {
  try {
    localStorage.setItem(STARS_KEY, JSON.stringify([...done]));
  } catch {
    /* 保存できなくても続行 */
  }
}
