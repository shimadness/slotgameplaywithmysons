// 画面フィット：キャビネット全体を表示域の高さ/幅に合わせて等比縮小する。
// 縮小のみ（拡大はしない）。ネイティブWebView・小型端末(iPhone SE 等)でも
// 「1画面に必ず収まる」を保証する安全網。body の余白(セーフエリア)は考慮する。
export function installFitScreen(cabinet: HTMLElement): void {
  let raf = 0;

  const measure = (): void => {
    raf = 0;
    // いったん素の状態へ戻して自然サイズを測る
    cabinet.style.transform = "";
    cabinet.style.transformOrigin = "";
    cabinet.style.removeProperty("align-self");
    document.body.style.removeProperty("height");
    document.body.style.removeProperty("overflow");

    // ★ビューポート未確定（iOS WebView 起動直後は innerHeight が 0 のことがある）。
    //   このまま計算すると scale が負→body 高さ0で画面が真っ暗になるので、必ず再計測に回す。
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    if (vh <= 0 || vw <= 0) return;

    const cs = getComputedStyle(document.body);
    const padV = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const padH = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const availH = vh - padV;
    const availW = vw - padH;

    const rect = cabinet.getBoundingClientRect();
    if (rect.height <= 0 || rect.width <= 0) return;

    const scale = Math.min(1, availH / rect.height, availW / rect.width);
    // 異常値（NaN/Infinity/0以下）は絶対に適用しない＝真っ暗バグの再発防止
    if (!Number.isFinite(scale) || scale <= 0) return;

    if (scale < 0.999) {
      cabinet.style.transformOrigin = "top center";
      cabinet.style.transform = `scale(${scale})`;
      cabinet.style.alignSelf = "flex-start"; // flex stretch で潰れるのを防ぐ
      document.body.style.height = vh + "px";
      document.body.style.overflow = "hidden";
    }
  };

  const schedule = (): void => {
    if (!raf) raf = requestAnimationFrame(measure);
  };

  schedule();
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);
  window.addEventListener("load", schedule); // iOS WebView がサイズ確定する頃にもう一度
  document.addEventListener("visibilitychange", schedule);
  // フォント読み込み後に測り直し（字幅が変わると高さも変わる）
  const fonts = (document as { fonts?: { ready?: Promise<unknown> } }).fonts;
  if (fonts?.ready) void fonts.ready.then(schedule);
  // 盤面の中身が増減（モード切替/ラッシュ）したら自動で測り直す
  new ResizeObserver(schedule).observe(cabinet);
  // 念のための遅延再計算（起動直後に innerHeight が 0 だったケースの回収）
  setTimeout(schedule, 200);
  setTimeout(schedule, 800);
  setTimeout(schedule, 1600);
}
