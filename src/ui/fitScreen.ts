// 画面フィット：キャビネット全体を表示域に合わせて縮小し、必ず1画面に収める。
// 方式 = CSS `zoom`。transform:scale と違い「レイアウトごと」縮むので、body の高さ操作や
// overflow:hidden が不要＝iOS WebView で真っ暗になる不具合（負スケール/高さ0）が原理的に起きない。
// zoom は WebKit(Safari/iOS)・Chrome で動作。縮小のみ（拡大はしない）。
export function installFitScreen(cabinet: HTMLElement): void {
  let raf = 0;
  let applied = 1; // 現在あてている zoom 値

  const measure = (): void => {
    raf = 0;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    // 起動直後にビューポート未確定(0)なら何もしない（後続の再計測に回す）
    if (vh <= 0 || vw <= 0) return;

    // zoom を当てたまま現在サイズを測り、applied で割って「素のサイズ」を得る
    // （毎回 zoom をリセットして測ると ResizeObserver が無限に発火するため）
    const rect = cabinet.getBoundingClientRect();
    if (rect.height <= 0 || rect.width <= 0) return;
    const naturalH = rect.height / applied;
    const naturalW = rect.width / applied;

    const cs = getComputedStyle(document.body);
    const padV = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const padH = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);

    const scale = Math.min(1, (vh - padV) / naturalH, (vw - padH) / naturalW);
    if (!Number.isFinite(scale) || scale <= 0) return; // 異常値は適用しない

    const target = scale < 0.999 ? scale : 1;
    if (Math.abs(target - applied) < 0.004) return; // 変化なし＝再適用しない（ループ防止）

    applied = target;
    cabinet.style.zoom = target === 1 ? "" : String(target);
  };

  // rAF はバックグラウンドタブ等で止まることがあるため、タイマー直叩きも併用して
  // 「measure が一度も走らない」を防ぐ。
  const schedule = (): void => {
    if (!raf) raf = requestAnimationFrame(measure);
  };

  schedule();
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);
  window.addEventListener("load", measure); // iOS WebView がサイズ確定する頃に再計測
  document.addEventListener("visibilitychange", measure);
  const fonts = (document as { fonts?: { ready?: Promise<unknown> } }).fonts;
  if (fonts?.ready) void fonts.ready.then(measure);
  // 盤面の中身が増減（モード切替/ラッシュ）で素のサイズが変わったら測り直す
  new ResizeObserver(schedule).observe(cabinet);
  // 起動直後の未確定サイズの回収＝rAFに頼らず直接 measure を複数回叩く
  setTimeout(measure, 100);
  setTimeout(measure, 400);
  setTimeout(measure, 900);
  setTimeout(measure, 1600);
}
