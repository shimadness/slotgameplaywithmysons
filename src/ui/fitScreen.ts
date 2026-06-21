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

    const cs = getComputedStyle(document.body);
    const padV = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const padH = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const availH = window.innerHeight - padV;
    const availW = window.innerWidth - padH;

    const rect = cabinet.getBoundingClientRect();
    if (rect.height === 0) return;
    const scale = Math.min(1, availH / rect.height, availW / rect.width);

    if (scale < 0.999) {
      cabinet.style.transformOrigin = "top center";
      cabinet.style.transform = `scale(${scale})`;
      cabinet.style.alignSelf = "flex-start"; // flex stretch で潰れるのを防ぐ
      document.body.style.height = window.innerHeight + "px";
      document.body.style.overflow = "hidden";
    }
  };

  const schedule = (): void => {
    if (!raf) raf = requestAnimationFrame(measure);
  };

  schedule();
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);
  // フォント読み込み後に測り直し（字幅が変わると高さも変わる）
  const fonts = (document as { fonts?: { ready?: Promise<unknown> } }).fonts;
  if (fonts?.ready) void fonts.ready.then(schedule);
  // 盤面の中身が増減（モード切替/ラッシュ）したら自動で測り直す
  new ResizeObserver(schedule).observe(cabinet);
  // 念のための遅延再計算
  setTimeout(schedule, 200);
  setTimeout(schedule, 800);
}
