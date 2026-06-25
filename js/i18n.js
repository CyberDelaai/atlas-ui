(function (ATLAS) {
  'use strict';
  const $ = ATLAS.$;
  // ---- UI translations (the top-right language picker). Brand names, the menu
  // and the version stay as-is; everything else switches. Translatable DOM nodes
  // carry data-i18n / data-i18n-title attributes; applyLang rewrites them. ----
  const I18N = {
    en: { h_controls: '// CONTROLS', h_output: '// OUTPUT',
      l_search: 'FIND PLACE', b_locate: 'LOCATE', l_lat: 'LATITUDE', l_lon: 'LONGITUDE',
      l_area_w: 'WIDTH', l_area_h: 'HEIGHT', l_title: 'TITLE',
      l_units: 'UNITS', lab_km: 'KM', lab_mi: 'MI',
      b_render: 'RENDER MAP', b_export: 'EXPORT PNG',
      panel_colors: 'COLORS', l_colors: 'MAP COLORS', c_land: 'LAND', c_landshade: 'LAND SHADE', c_water: 'WATER', c_border: 'BORDERS',
      c_frame: 'FRAME', c_region: 'REGION', c_building: 'BUILDINGS', c_marker: 'MARKER', t_pick: 'Pick any color',
      t_region_clear: 'Clear district color', region_district: 'DISTRICT',
      hint_districts: 'Left-click a district to select it; right-click for its color / image menu.',
      l_districts: 'CITY DISTRICTS', l_districts_land: 'DISTRICTS: LAND ONLY', l_buildings: 'BUILDINGS', lab_off: 'OFF', lab_on: 'ON',
      t_zoom_in: 'Zoom in — recrop tighter', t_zoom_out: 'Zoom out — recrop wider',
      t_crop: 'Draw a region to recrop',
      t_pan_up: 'Pan north', t_pan_down: 'Pan south', t_pan_left: 'Pan west', t_pan_right: 'Pan east',
      l_markers: 'MARKERS', b_add_marker: '+ ADD MARKER',
      hint_markers: 'Drag the pin or its label to move them apart. Click either to edit; toggle a straight or right-angled connector.',
      l_marker_label: 'LABEL', l_connector: 'CONNECTOR', l_underline: 'UNDERLINE', l_marker_shape: 'SHAPE', l_marker_fontsize: 'FONT SIZE', l_marker_color: 'COLOR', t_marker_default: 'Use map default', t_marker_clone: 'Clone marker', b_delete: 'DELETE', b_done: 'DONE',
      b_set_image: 'SET IMAGE', b_edit_image: 'EDIT IMAGE', b_remove_image: 'REMOVE', b_ungroup: 'UNGROUP', b_cancel: 'CANCEL', hint_image: 'Drag to move · scroll to zoom',
      hint_output: 'Free ESRI hillshade terrain + country, region & city-district borders, recolored to the cyberdeck palette. Runs entirely in your browser.',
      t_roll20: 'Roll20 grid to match this map: set the VTT page to this many cells, and 1 cell to this distance.',
      ph_title: 'ATLAS', ph_sub: 'enter coordinates and render a map',
      tag: 'ATLAS', tag_alt: 'OFF THE MAP',
      // transient status lines (other languages fall back to these)
      st_need_place: 'Enter a place to find.', st_locating: 'Locating…',
      st_not_found: 'No match found.', st_geo_fail: 'Lookup failed — check connection.',
      st_need_coords: 'Enter latitude and longitude.', st_loading: 'Loading tiles…',
      st_done: 'Map rendered.', st_render_fail: 'Render failed — see console.' },
    ru: { h_controls: '// УПРАВЛЕНИЕ', h_output: '// ВЫВОД',
      l_search: 'НАЙТИ МЕСТО', b_locate: 'НАЙТИ', l_lat: 'ШИРОТА', l_lon: 'ДОЛГОТА',
      l_area_w: 'ШИРИНА', l_area_h: 'ВЫСОТА', l_title: 'ЗАГОЛОВОК', l_units: 'ЕДИНИЦЫ',
      b_render: 'СОЗДАТЬ КАРТУ', b_export: 'ЭКСПОРТ PNG',
      panel_colors: 'ЦВЕТА', l_colors: 'ЦВЕТА КАРТЫ', c_land: 'СУША', c_landshade: 'ТЕНЬ СУШИ', c_water: 'ВОДА', c_border: 'ГРАНИЦЫ',
      c_frame: 'РАМКА', c_region: 'РЕГИОН', c_building: 'ЗДАНИЯ', c_marker: 'МАРКЕР', t_pick: 'Выбрать любой цвет',
      l_districts: 'ГОРОДСКИЕ РАЙОНЫ', l_districts_land: 'РАЙОНЫ: ТОЛЬКО СУША', l_buildings: 'ЗДАНИЯ',
      l_markers: 'МАРКЕРЫ', b_add_marker: '+ ДОБАВИТЬ',
      hint_markers: 'Перетащите, чтобы переместить. Нажмите на маркер, чтобы изменить подпись.',
      l_marker_label: 'ПОДПИСЬ', l_connector: 'ЛИНИЯ', l_underline: 'ПОДЧЁРК', l_marker_shape: 'ФОРМА', l_marker_fontsize: 'РАЗМЕР ШРИФТА', l_marker_color: 'ЦВЕТ', t_marker_default: 'Цвет карты по умолчанию', t_marker_clone: 'Клонировать маркер', b_delete: 'УДАЛИТЬ', b_done: 'ГОТОВО',
      b_set_image: 'ИЗОБРАЖЕНИЕ', b_edit_image: 'ИЗМЕНИТЬ ФОТО', b_remove_image: 'УБРАТЬ', b_ungroup: 'РАЗГРУППИРОВАТЬ', b_cancel: 'ОТМЕНА', hint_image: 'Перетащите · колесо для масштаба',
      t_crop: 'Выделить область для перекадрирования',
      hint_output: 'Бесплатный рельеф ESRI + границы стран, регионов и городских районов в палитре cyberdeck. Работает полностью в браузере.',
      t_roll20: 'Сетка Roll20 под эту карту: задайте на странице VTT столько клеток и такое расстояние на клетку.',
      ph_title: 'ATLAS', ph_sub: 'введите координаты и создайте карту',
      tag: 'ATLAS', tag_alt: 'ВНЕ КАРТЫ' },
    fr: { h_controls: '// CONTRÔLES', h_output: '// SORTIE',
      l_search: 'TROUVER UN LIEU', b_locate: 'LOCALISER', l_lat: 'LATITUDE', l_lon: 'LONGITUDE',
      l_area_w: 'LARGEUR', l_area_h: 'HAUTEUR', l_title: 'TITRE', l_units: 'UNITÉS',
      b_render: 'GÉNÉRER LA CARTE', b_export: 'EXPORTER PNG',
      panel_colors: 'COULEURS', l_colors: 'COULEURS', c_land: 'TERRE', c_landshade: 'OMBRE TERRE', c_water: 'EAU', c_border: 'FRONTIÈRES',
      c_frame: 'CADRE', c_region: 'RÉGION', c_building: 'BÂTIMENTS', c_marker: 'MARQUEUR', t_pick: 'Choisir une couleur',
      l_districts: 'ARRONDISSEMENTS', l_districts_land: 'QUARTIERS : TERRE SEULE', l_buildings: 'BÂTIMENTS',
      l_markers: 'MARQUEURS', b_add_marker: '+ AJOUTER',
      hint_markers: 'Glissez pour déplacer. Cliquez sur un marqueur pour modifier son libellé.',
      l_marker_label: 'LIBELLÉ', l_connector: 'LIGNE', l_underline: 'SOULIGNÉ', l_marker_shape: 'FORME', l_marker_fontsize: 'TAILLE', l_marker_color: 'COULEUR', t_marker_default: 'Couleur par défaut', t_marker_clone: 'Cloner le marqueur', b_delete: 'SUPPRIMER', b_done: 'TERMINÉ',
      b_set_image: 'IMAGE', b_edit_image: 'MODIFIER', b_remove_image: 'RETIRER', b_ungroup: 'DISSOCIER', b_cancel: 'ANNULER', hint_image: 'Glissez · molette pour zoomer',
      t_crop: 'Tracer une zone à recadrer',
      hint_output: 'Relief ESRI gratuit + frontières pays, régions & arrondissements, recolorés à la palette cyberdeck. Tout se fait dans le navigateur.',
      t_roll20: 'Grille Roll20 adaptée à cette carte : réglez la page VTT sur ce nombre de cases et 1 case sur cette distance.',
      ph_title: 'ATLAS', ph_sub: 'saisissez des coordonnées et générez une carte',
      tag: 'ATLAS', tag_alt: 'HORS CARTE' },
    de: { h_controls: '// STEUERUNG', h_output: '// AUSGABE',
      l_search: 'ORT SUCHEN', b_locate: 'SUCHEN', l_lat: 'BREITE', l_lon: 'LÄNGE',
      l_area_w: 'BREITE', l_area_h: 'HÖHE', l_title: 'TITEL', l_units: 'EINHEITEN',
      b_render: 'KARTE ERZEUGEN', b_export: 'PNG EXPORT',
      panel_colors: 'FARBEN', l_colors: 'KARTENFARBEN', c_land: 'LAND', c_landshade: 'LANDSCHATTEN', c_water: 'WASSER', c_border: 'GRENZEN',
      c_frame: 'RAHMEN', c_region: 'REGION', c_building: 'GEBÄUDE', c_marker: 'MARKER', t_pick: 'Beliebige Farbe wählen',
      l_districts: 'STADTBEZIRKE', l_districts_land: 'BEZIRKE: NUR LAND', l_buildings: 'GEBÄUDE',
      l_markers: 'MARKER', b_add_marker: '+ HINZUFÜGEN',
      hint_markers: 'Zum Verschieben ziehen. Marker anklicken, um die Beschriftung zu bearbeiten.',
      l_marker_label: 'BESCHRIFTUNG', l_connector: 'LINIE', l_underline: 'UNTERSTRICH', l_marker_shape: 'FORM', l_marker_fontsize: 'SCHRIFTGRÖSSE', l_marker_color: 'FARBE', t_marker_default: 'Kartenstandard verwenden', t_marker_clone: 'Marker klonen', b_delete: 'LÖSCHEN', b_done: 'FERTIG',
      b_set_image: 'BILD', b_edit_image: 'BILD ÄNDERN', b_remove_image: 'ENTFERNEN', b_ungroup: 'GRUPPE LÖSEN', b_cancel: 'ABBRECHEN', hint_image: 'Ziehen · scrollen zum Zoomen',
      t_crop: 'Bereich zum Zuschneiden ziehen',
      hint_output: 'Kostenloses ESRI-Relief + Länder-, Regions- & Stadtbezirksgrenzen, in der Cyberdeck-Palette eingefärbt. Läuft komplett im Browser.',
      t_roll20: 'Roll20-Raster passend zu dieser Karte: VTT-Seite auf so viele Felder und 1 Feld auf diese Distanz setzen.',
      ph_title: 'ATLAS', ph_sub: 'Koordinaten eingeben und Karte erzeugen',
      tag: 'ATLAS', tag_alt: 'ABSEITS DER KARTE' },
    es: { h_controls: '// CONTROLES', h_output: '// SALIDA',
      l_search: 'BUSCAR LUGAR', b_locate: 'LOCALIZAR', l_lat: 'LATITUD', l_lon: 'LONGITUD',
      l_area_w: 'ANCHO', l_area_h: 'ALTO', l_title: 'TÍTULO', l_units: 'UNIDADES',
      b_render: 'GENERAR MAPA', b_export: 'EXPORTAR PNG',
      panel_colors: 'COLORES', l_colors: 'COLORES', c_land: 'TIERRA', c_landshade: 'SOMBRA TIERRA', c_water: 'AGUA', c_border: 'FRONTERAS',
      c_frame: 'MARCO', c_region: 'REGIÓN', c_building: 'EDIFICIOS', c_marker: 'MARCADOR', t_pick: 'Elegir un color',
      l_districts: 'DISTRITOS', l_districts_land: 'DISTRITOS: SOLO TIERRA', l_buildings: 'EDIFICIOS',
      l_markers: 'MARCADORES', b_add_marker: '+ AÑADIR',
      hint_markers: 'Arrastra para mover. Haz clic en un marcador para editar su etiqueta.',
      l_marker_label: 'ETIQUETA', l_connector: 'LÍNEA', l_underline: 'SUBRAYADO', l_marker_shape: 'FORMA', l_marker_fontsize: 'TAMAÑO', l_marker_color: 'COLOR', t_marker_default: 'Usar color del mapa', t_marker_clone: 'Clonar marcador', b_delete: 'ELIMINAR', b_done: 'LISTO',
      b_set_image: 'IMAGEN', b_edit_image: 'EDITAR IMAGEN', b_remove_image: 'QUITAR', b_ungroup: 'DESAGRUPAR', b_cancel: 'CANCELAR', hint_image: 'Arrastra · rueda para zoom',
      t_crop: 'Dibuja una región para recortar',
      hint_output: 'Relieve ESRI gratuito + fronteras de países, regiones y distritos urbanos, recoloreados a la paleta cyberdeck. Funciona en el navegador.',
      t_roll20: 'Cuadrícula Roll20 para este mapa: configura la página VTT con estas casillas y 1 casilla a esta distancia.',
      ph_title: 'ATLAS', ph_sub: 'introduce coordenadas y genera un mapa',
      tag: 'ATLAS', tag_alt: 'FUERA DEL MAPA' },
    it: { h_controls: '// CONTROLLI', h_output: '// OUTPUT',
      l_search: 'TROVA LUOGO', b_locate: 'LOCALIZZA', l_lat: 'LATITUDINE', l_lon: 'LONGITUDINE',
      l_area_w: 'LARGHEZZA', l_area_h: 'ALTEZZA', l_title: 'TITOLO', l_units: 'UNITÀ',
      b_render: 'GENERA MAPPA', b_export: 'ESPORTA PNG',
      panel_colors: 'COLORI', l_colors: 'COLORI MAPPA', c_land: 'TERRA', c_landshade: 'OMBRA TERRA', c_water: 'ACQUA', c_border: 'CONFINI',
      c_frame: 'CORNICE', c_region: 'REGIONE', c_building: 'EDIFICI', c_marker: 'MARCATORE', t_pick: 'Scegli un colore',
      l_districts: 'DISTRETTI', l_districts_land: 'DISTRETTI: SOLO TERRA', l_buildings: 'EDIFICI',
      l_markers: 'MARCATORI', b_add_marker: '+ AGGIUNGI',
      hint_markers: 'Trascina per spostare. Clicca un marcatore per modificarne l\'etichetta.',
      l_marker_label: 'ETICHETTA', l_connector: 'LINEA', l_underline: 'SOTTOLINEA', l_marker_shape: 'FORMA', l_marker_fontsize: 'DIMENSIONE', l_marker_color: 'COLORE', t_marker_default: 'Usa colore mappa', t_marker_clone: 'Clona marcatore', b_delete: 'ELIMINA', b_done: 'FATTO',
      b_set_image: 'IMMAGINE', b_edit_image: 'MODIFICA IMMAGINE', b_remove_image: 'RIMUOVI', b_ungroup: 'SEPARA', b_cancel: 'ANNULLA', hint_image: 'Trascina · rotella per zoom',
      t_crop: 'Disegna una regione da ritagliare',
      hint_output: 'Rilievo ESRI gratuito + confini di paesi, regioni e distretti urbani, ricolorati nella palette cyberdeck. Tutto nel browser.',
      t_roll20: 'Griglia Roll20 per questa mappa: imposta la pagina VTT su queste celle e 1 cella su questa distanza.',
      ph_title: 'ATLAS', ph_sub: 'inserisci le coordinate e genera una mappa',
      tag: 'ATLAS', tag_alt: 'FUORI MAPPA' },
    ja: { h_controls: '// コントロール', h_output: '// 出力',
      l_search: '場所を検索', b_locate: '検索', l_lat: '緯度', l_lon: '経度',
      l_area_w: '幅', l_area_h: '高さ', l_title: 'タイトル', l_units: '単位',
      b_render: 'マップを生成', b_export: 'PNG書き出し',
      panel_colors: 'カラー', l_colors: 'マップの色', c_land: '陸地', c_landshade: '陸地の陰', c_water: '水域', c_border: '境界線',
      c_frame: '枠', c_region: '地域', c_building: '建物', c_marker: 'マーカー', t_pick: '任意の色を選択',
      l_districts: '市区境界', l_districts_land: '市区境界：陸地のみ', l_buildings: '建物',
      l_markers: 'マーカー', b_add_marker: '+ 追加',
      hint_markers: 'ドラッグで移動。マーカーをクリックしてラベルを編集。',
      l_marker_label: 'ラベル', l_connector: '連結線', l_underline: '下線', l_marker_shape: '形状', l_marker_fontsize: '文字サイズ', l_marker_color: '色', t_marker_default: '地図の既定色を使用', t_marker_clone: 'マーカーを複製', b_delete: '削除', b_done: '完了',
      b_set_image: '画像', b_edit_image: '画像を編集', b_remove_image: '削除', b_ungroup: 'グループ解除', b_cancel: 'キャンセル', hint_image: 'ドラッグで移動・スクロールで拡大',
      t_crop: '範囲を描いて再トリミング',
      hint_output: '無料のESRI陰影起伏 + 国・地域・市区の境界線をcyberdeckパレットで再着色。すべてブラウザ内で動作します。',
      t_roll20: 'この地図に合うRoll20グリッド：VTTページをこのマス数に、1マスをこの距離に設定。',
      ph_title: 'ATLAS', ph_sub: '座標を入力してマップを生成',
      tag: 'ATLAS', tag_alt: '地図の外' },
    zh: { h_controls: '// 控制', h_output: '// 输出',
      l_search: '查找地点', b_locate: '定位', l_lat: '纬度', l_lon: '经度',
      l_area_w: '宽度', l_area_h: '高度', l_title: '标题', l_units: '单位',
      b_render: '生成地图', b_export: '导出 PNG',
      panel_colors: '配色', l_colors: '地图配色', c_land: '陆地', c_landshade: '陆地阴影', c_water: '水域', c_border: '边界',
      c_frame: '边框', c_region: '区域', c_building: '建筑', c_marker: '标记', t_pick: '选择任意颜色',
      l_districts: '城市辖区', l_districts_land: '辖区：仅陆地', l_buildings: '建筑',
      l_markers: '标记', b_add_marker: '+ 添加标记',
      hint_markers: '拖动以移动。点击标记编辑标签。',
      l_marker_label: '标签', l_connector: '连接线', l_underline: '下划线', l_marker_shape: '形状', l_marker_fontsize: '字号', l_marker_color: '颜色', t_marker_default: '使用地图默认色', t_marker_clone: '克隆标记', b_delete: '删除', b_done: '完成',
      b_set_image: '设为图片', b_edit_image: '编辑图片', b_remove_image: '移除', b_ungroup: '取消编组', b_cancel: '取消', hint_image: '拖动移动·滚轮缩放',
      t_crop: '框选区域以重新裁剪',
      hint_output: '免费的 ESRI 山体阴影地形 + 国家／地区／城市辖区边界，按 cyberdeck 配色重新着色。完全在浏览器中运行。',
      t_roll20: '匹配此地图的 Roll20 网格：将 VTT 页面设为这些格数，每格设为此距离。',
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
