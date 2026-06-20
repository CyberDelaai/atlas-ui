(function (ATLAS) {
  'use strict';
  const $ = ATLAS.$;
  // ---- UI translations (the top-right language picker). Brand names, the menu
  // and the version stay as-is; everything else switches. Translatable DOM nodes
  // carry data-i18n / data-i18n-title attributes; applyLang rewrites them. ----
  const I18N = {
    en: { h_controls: '// CONTROLS', h_output: '// OUTPUT',
      placeholder_left: 'Left control panel — start building here.',
      placeholder_right: 'Right output panel — start building here.',
      ph_title: 'ATLAS', ph_sub: 'blank scaffold — ready to build',
      tag: 'ATLAS', tag_alt: 'OFF THE MAP' },
    ru: { h_controls: '// УПРАВЛЕНИЕ', h_output: '// ВЫВОД',
      placeholder_left: 'Левая панель управления — начните здесь.',
      placeholder_right: 'Правая панель вывода — начните здесь.',
      ph_title: 'ATLAS', ph_sub: 'пустой каркас — готов к работе',
      tag: 'ATLAS', tag_alt: 'ВНЕ КАРТЫ' },
    fr: { h_controls: '// CONTRÔLES', h_output: '// SORTIE',
      placeholder_left: 'Panneau de contrôle gauche — commencez ici.',
      placeholder_right: 'Panneau de sortie droit — commencez ici.',
      ph_title: 'ATLAS', ph_sub: 'structure vierge — prête à construire',
      tag: 'ATLAS', tag_alt: 'HORS CARTE' },
    de: { h_controls: '// STEUERUNG', h_output: '// AUSGABE',
      placeholder_left: 'Linkes Bedienfeld — hier beginnen.',
      placeholder_right: 'Rechtes Ausgabefeld — hier beginnen.',
      ph_title: 'ATLAS', ph_sub: 'leeres Gerüst — bereit zum Bauen',
      tag: 'ATLAS', tag_alt: 'ABSEITS DER KARTE' },
    es: { h_controls: '// CONTROLES', h_output: '// SALIDA',
      placeholder_left: 'Panel de control izquierdo — empieza aquí.',
      placeholder_right: 'Panel de salida derecho — empieza aquí.',
      ph_title: 'ATLAS', ph_sub: 'estructura en blanco — lista para construir',
      tag: 'ATLAS', tag_alt: 'FUERA DEL MAPA' },
    it: { h_controls: '// CONTROLLI', h_output: '// OUTPUT',
      placeholder_left: 'Pannello di controllo sinistro — inizia qui.',
      placeholder_right: 'Pannello di output destro — inizia qui.',
      ph_title: 'ATLAS', ph_sub: 'impalcatura vuota — pronta da costruire',
      tag: 'ATLAS', tag_alt: 'FUORI MAPPA' },
    ja: { h_controls: '// コントロール', h_output: '// 出力',
      placeholder_left: '左コントロールパネル — ここから作成。',
      placeholder_right: '右出力パネル — ここから作成。',
      ph_title: 'ATLAS', ph_sub: '空のひな形 — 作成準備完了',
      tag: 'ATLAS', tag_alt: '地図の外' },
    zh: { h_controls: '// 控制', h_output: '// 输出',
      placeholder_left: '左侧控制面板 — 从这里开始。',
      placeholder_right: '右侧输出面板 — 从这里开始。',
      ph_title: 'ATLAS', ph_sub: '空白脚手架 — 准备构建',
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
