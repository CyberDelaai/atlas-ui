(function (ATLAS) {
  'use strict';
  const $ = ATLAS.$;
  // ---- UI translations (the top-right language picker). Brand names, the menu
  // and the version stay as-is; everything else switches. Translatable DOM nodes
  // carry data-i18n / data-i18n-title attributes; applyLang rewrites them. ----
  const I18N = {
    en: { h_controls: '// CONTROLS', h_output: '// OUTPUT',
      l_search: 'FIND PLACE', b_locate: 'LOCATE', l_lat: 'LATITUDE', l_lon: 'LONGITUDE',
      l_area: 'AREA — SQUARE EDGE (KM)', l_title: 'TITLE', l_region: 'REGION NAME',
      l_center: 'CENTER LABEL', b_render: 'RENDER MAP', b_export: 'EXPORT PNG',
      hint_output: 'Free ESRI hillshade terrain + country / region borders, recolored to the cyberdeck palette. Runs entirely in your browser.',
      ph_title: 'ATLAS', ph_sub: 'enter coordinates and render a map',
      tag: 'ATLAS', tag_alt: 'OFF THE MAP',
      // transient status lines (other languages fall back to these)
      st_need_place: 'Enter a place to find.', st_locating: 'Locating…',
      st_not_found: 'No match found.', st_geo_fail: 'Lookup failed — check connection.',
      st_need_coords: 'Enter latitude and longitude.', st_loading: 'Loading tiles…',
      st_done: 'Map rendered.', st_render_fail: 'Render failed — see console.' },
    ru: { h_controls: '// УПРАВЛЕНИЕ', h_output: '// ВЫВОД',
      l_search: 'НАЙТИ МЕСТО', b_locate: 'НАЙТИ', l_lat: 'ШИРОТА', l_lon: 'ДОЛГОТА',
      l_area: 'ОБЛАСТЬ — СТОРОНА (КМ)', l_title: 'ЗАГОЛОВОК', l_region: 'НАЗВАНИЕ РЕГИОНА',
      l_center: 'ЦЕНТРАЛЬНАЯ МЕТКА', b_render: 'СОЗДАТЬ КАРТУ', b_export: 'ЭКСПОРТ PNG',
      hint_output: 'Бесплатный рельеф ESRI + границы стран и регионов в палитре cyberdeck. Работает полностью в браузере.',
      ph_title: 'ATLAS', ph_sub: 'введите координаты и создайте карту',
      tag: 'ATLAS', tag_alt: 'ВНЕ КАРТЫ' },
    fr: { h_controls: '// CONTRÔLES', h_output: '// SORTIE',
      l_search: 'TROUVER UN LIEU', b_locate: 'LOCALISER', l_lat: 'LATITUDE', l_lon: 'LONGITUDE',
      l_area: 'ZONE — CÔTÉ DU CARRÉ (KM)', l_title: 'TITRE', l_region: 'NOM DE RÉGION',
      l_center: 'ÉTIQUETTE CENTRALE', b_render: 'GÉNÉRER LA CARTE', b_export: 'EXPORTER PNG',
      hint_output: 'Relief ESRI gratuit + frontières pays / régions, recolorés à la palette cyberdeck. Tout se fait dans le navigateur.',
      ph_title: 'ATLAS', ph_sub: 'saisissez des coordonnées et générez une carte',
      tag: 'ATLAS', tag_alt: 'HORS CARTE' },
    de: { h_controls: '// STEUERUNG', h_output: '// AUSGABE',
      l_search: 'ORT SUCHEN', b_locate: 'SUCHEN', l_lat: 'BREITE', l_lon: 'LÄNGE',
      l_area: 'BEREICH — QUADRATSEITE (KM)', l_title: 'TITEL', l_region: 'REGIONSNAME',
      l_center: 'ZENTRUM-LABEL', b_render: 'KARTE ERZEUGEN', b_export: 'PNG EXPORT',
      hint_output: 'Kostenloses ESRI-Relief + Länder- / Regionsgrenzen, in der Cyberdeck-Palette eingefärbt. Läuft komplett im Browser.',
      ph_title: 'ATLAS', ph_sub: 'Koordinaten eingeben und Karte erzeugen',
      tag: 'ATLAS', tag_alt: 'ABSEITS DER KARTE' },
    es: { h_controls: '// CONTROLES', h_output: '// SALIDA',
      l_search: 'BUSCAR LUGAR', b_locate: 'LOCALIZAR', l_lat: 'LATITUD', l_lon: 'LONGITUD',
      l_area: 'ÁREA — LADO DEL CUADRADO (KM)', l_title: 'TÍTULO', l_region: 'NOMBRE DE REGIÓN',
      l_center: 'ETIQUETA CENTRAL', b_render: 'GENERAR MAPA', b_export: 'EXPORTAR PNG',
      hint_output: 'Relieve ESRI gratuito + fronteras de países / regiones, recoloreados a la paleta cyberdeck. Funciona en el navegador.',
      ph_title: 'ATLAS', ph_sub: 'introduce coordenadas y genera un mapa',
      tag: 'ATLAS', tag_alt: 'FUERA DEL MAPA' },
    it: { h_controls: '// CONTROLLI', h_output: '// OUTPUT',
      l_search: 'TROVA LUOGO', b_locate: 'LOCALIZZA', l_lat: 'LATITUDINE', l_lon: 'LONGITUDINE',
      l_area: 'AREA — LATO DEL QUADRATO (KM)', l_title: 'TITOLO', l_region: 'NOME REGIONE',
      l_center: 'ETICHETTA CENTRALE', b_render: 'GENERA MAPPA', b_export: 'ESPORTA PNG',
      hint_output: 'Rilievo ESRI gratuito + confini di paesi / regioni, ricolorati nella palette cyberdeck. Tutto nel browser.',
      ph_title: 'ATLAS', ph_sub: 'inserisci le coordinate e genera una mappa',
      tag: 'ATLAS', tag_alt: 'FUORI MAPPA' },
    ja: { h_controls: '// コントロール', h_output: '// 出力',
      l_search: '場所を検索', b_locate: '検索', l_lat: '緯度', l_lon: '経度',
      l_area: '範囲 — 正方形の一辺 (KM)', l_title: 'タイトル', l_region: '地域名',
      l_center: '中心ラベル', b_render: 'マップを生成', b_export: 'PNG書き出し',
      hint_output: '無料のESRI陰影起伏 + 国・地域の境界線をcyberdeckパレットで再着色。すべてブラウザ内で動作します。',
      ph_title: 'ATLAS', ph_sub: '座標を入力してマップを生成',
      tag: 'ATLAS', tag_alt: '地図の外' },
    zh: { h_controls: '// 控制', h_output: '// 输出',
      l_search: '查找地点', b_locate: '定位', l_lat: '纬度', l_lon: '经度',
      l_area: '范围 — 正方形边长 (公里)', l_title: '标题', l_region: '区域名称',
      l_center: '中心标签', b_render: '生成地图', b_export: '导出 PNG',
      hint_output: '免费的 ESRI 山体阴影地形 + 国家／地区边界，按 cyberdeck 配色重新着色。完全在浏览器中运行。',
      ph_title: 'ATLAS', ph_sub: '输入坐标并生成地图',
      tag: 'ATLAS', tag_alt: '地图之外' },
  };

  let lang = 'en';
  // Translate a key in the current language, falling back to English.
  ATLAS.t = (key) => (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;

  // Rewrite every data-i18n / data-i18n-title node for the chosen language.
  ATLAS.applyLang = function applyLang(code) {
    lang = I18N[code] ? code : 'en';
    ATLAS.save('atlas:lang', lang);
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const v = ATLAS.t(el.getAttribute('data-i18n'));
      if (v) el.textContent = v;
    });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const v = ATLAS.t(el.getAttribute('data-i18n-title'));
      if (v) el.setAttribute('title', v);
    });
    document.documentElement.lang = lang;
  };

  // Wire the picker + restore the saved language on load.
  document.addEventListener('DOMContentLoaded', () => {
    const sel = $('uiLangSel');
    const saved = (() => { try { return localStorage.getItem('atlas:lang'); } catch (e) { return null; } })();
    const start = saved && I18N[saved] ? saved : 'en';
    if (sel) {
      sel.value = start;
      sel.addEventListener('change', () => ATLAS.applyLang(sel.value));
    }
    ATLAS.applyLang(start);
  });
})(window.ATLAS);
