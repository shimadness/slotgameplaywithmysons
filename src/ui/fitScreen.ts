// 画面フィット：キャビネット全体を CSS `zoom` で縮小し、必ず1画面に収める。
// 素サイズは「現在の描画サイズ ÷ 適用中zoom」で求める（iOS WebKitでも zoom は
// getBoundingClientRect に反映される＝この割り算が成立。実機確認済み）。
// これにより、起動後に画像/フォントで盤面が伸びても ResizeObserver で追従して縮め直す。
// body高さ/overflowは触らない（iOSの真っ暗バグ回避）。縮小のみ・下限0.4クランプ。
export function installFitScreen(cabinet: HTMLElement): void {
  let applied = 1; // 現在あてている zoom 値
  const SAFETY = 6; // 念のための余白(px)。測定誤差や遅延伸長でもスクロールさせない

  const measure = (): void => {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    if (vh <= 0 || vw <= 0) return; // ビューポート未確定なら後続に回す

    const rect = cabinet.getBoundingClientRect();
    if (rect.height <= 0 || rect.width <= 0) return;
    const naturalH = rect.height / applied;
    const naturalW = rect.width / applied;

    const cs = getComputedStyle(document.body);
    const padV = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const padH = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);

    let scale = Math.min(
      1,
      (vh - padV - SAFETY) / naturalH,
      (vw - padH) / naturalW
    );
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    scale = Math.max(scale, 0.4); // 下限＝異常時でも真っ暗にしない

    const target = scale < 0.999 ? scale : 1;
    if (Math.abs(target - applied) < 0.003) return; // 変化なし＝再適用しない（ループ防止）

    applied = target;
    cabinet.style.zoom = target === 1 ? "" : String(target);
  };

  measure();
  window.addEventListener("resize", measure);
  window.addEventListener("orientationchange", measure);
  window.addEventListener("load", measure);
  document.addEventListener("visibilitychange", measure);
  const fonts = (document as { fonts?: { ready?: Promise<unknown> } }).fonts;
  if (fonts?.ready) void fonts.ready.then(measure);
  // 盤面の中身が増減（画像/フォント読込・モード切替・ラッシュ）で追従
  new ResizeObserver(measure).observe(cabinet);
  // 起動直後の未確定サイズ＆遅延伸長の回収（rAFに頼らずタイマー直叩き）
  for (const ms of [120, 350, 700, 1200, 2000, 3200]) setTimeout(measure, ms);
}
