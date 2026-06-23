// 画面フィット：キャビネット全体を表示域に収まるよう CSS `zoom` で縮小する。
// 堅牢版：毎回 zoom を解除して「素のサイズ」を測り直す（割り算で素サイズを推定しないので
// iOS でのスパイラル縮小＝真っ暗化を防ぐ）。ResizeObserver の自己発火は ignore フラグで抑止。
// scale には下限を設け、万一の異常値でも消えないようにする。
export function installFitScreen(cabinet: HTMLElement): void {
  let ignoreRO = false;

  const measure = (): void => {
    if (ignoreRO) return; // 自分の zoom 変更で起きた再計測は無視（ループ防止）
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    if (vh <= 0 || vw <= 0) return; // ビューポート未確定なら後続に回す

    ignoreRO = true;
    // いったん素に戻して自然サイズを測る（割り算推定しない＝確実）
    if (cabinet.style.zoom) cabinet.style.zoom = "";
    const rect = cabinet.getBoundingClientRect();
    const naturalH = rect.height;
    const naturalW = rect.width;

    if (naturalH > 0 && naturalW > 0) {
      const cs = getComputedStyle(document.body);
      const padV = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const padH = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      let scale = Math.min(1, (vh - padV) / naturalH, (vw - padH) / naturalW);
      if (!Number.isFinite(scale) || scale <= 0) scale = 1;
      scale = Math.max(scale, 0.4); // 下限＝異常時でも真っ暗にしない
      cabinet.style.zoom = scale < 0.999 ? String(scale) : "";
    }

    // 自己発火する ResizeObserver をやり過ごしてから監視再開
    setTimeout(() => { ignoreRO = false; }, 60);
  };

  measure();
  window.addEventListener("resize", measure);
  window.addEventListener("orientationchange", measure);
  window.addEventListener("load", measure);
  document.addEventListener("visibilitychange", measure);
  const fonts = (document as { fonts?: { ready?: Promise<unknown> } }).fonts;
  if (fonts?.ready) void fonts.ready.then(measure);
  new ResizeObserver(measure).observe(cabinet);
  // 起動直後の未確定サイズの回収（rAFに頼らずタイマー直叩き）
  setTimeout(measure, 150);
  setTimeout(measure, 500);
  setTimeout(measure, 1100);
  setTimeout(measure, 2000);
}
