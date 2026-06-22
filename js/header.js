(function (ATLAS) {
  'use strict';
  const $ = ATLAS.$;
  const t = ATLAS.t;
  // ---- Logo tool-switcher dropdown (shared across cyberdeck.tools apps) ----
  (function setupAppMenu() {
    const btn = $('logoBtn'), menu = $('appMenu');
    if (!btn || !menu) return;
    const open = () => { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); };
    const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden ? open() : close(); });
    document.addEventListener('click', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) close();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  })();

  // ---- Header tag glitch: scrambles the tagline <-> its alt phrase. Both read
  // from the current language each cycle (t('tag') / t('tag_alt')). ----
  (function startTagGlitch() {
    const el = $('tagWord');
    if (!el) return;
    const CHARS = '!@#$%&*<>{}[]/|01ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    function scrambleFrame(target, revealed, maxLen) {
      let out = '';
      for (let i = 0; i < maxLen; i++) {
        if (i >= target.length) { out += ' '; continue; }
        out += i < revealed ? target[i] : CHARS[Math.floor(Math.random() * CHARS.length)];
      }
      return out;
    }
    function runScramble(target, maxLen, onDone) {
      const steps = 8; let step = 0;
      const id = setInterval(() => {
        step++;
        el.textContent = scrambleFrame(target, Math.floor((step / steps) * target.length), maxLen);
        if (step >= steps) {
          clearInterval(id);
          el.textContent = target + ' '.repeat(Math.max(0, maxLen - target.length));
          onDone();
        }
      }, 40);
    }
    function runGlitch() {
      const ORIGINAL = t('tag'), TARGET = t('tag_alt');
      const maxLen = Math.max(ORIGINAL.length, TARGET.length);
      el.classList.add('glitching');
      runScramble(TARGET, maxLen, () => {
        setTimeout(() => {
          runScramble(ORIGINAL, maxLen, () => {
            el.classList.remove('glitching');
            el.textContent = ORIGINAL;
            setTimeout(runGlitch, 14000 + Math.random() * 18000);
          });
        }, 700);
      });
    }
    setTimeout(runGlitch, 8000 + Math.random() * 6000);
  })();

  // ---- Version hover-morph: hover " // vX" -> " // changes: N" (GitHub commits) ----
  (function setupVersionMorph() {
    const meta = $('tagMeta');
    if (!meta) return;
    const GH_REPO = 'CyberDelaai/atlas-ui';
    // Version lives in 3 spots: this const, the #tagVersion span in index.html, and
    // the line-1 `<!-- ATLAS v… -->` comment. Bump them all in sync with:
    //   python3 bump_version.py {x|y|z}
    const VER = ' // v0.3.6';
    const CHARS = '!@#$%&*<>{}[]/|01ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let commitCount = '';

    async function fetchCommitCount() {
      const CK = 'atlas:commitCount', CA = 'atlas:commitCountAt', TTL = 3600000;
      const cached = localStorage.getItem(CK);
      const at = parseInt(localStorage.getItem(CA) || '0', 10);
      if (cached && (Date.now() - at) < TTL) return cached;
      try {
        const r = await fetch('https://api.github.com/repos/' + GH_REPO + '/commits?per_page=1');
        if (!r.ok) return cached || '';
        const link = r.headers.get('Link');
        const m = link && link.match(/<[^>]*[?&]page=(\d+)>;\s*rel="last"/);
        let count = m ? m[1] : null;
        if (!count) { const arr = await r.json().catch(() => null); if (Array.isArray(arr)) count = String(arr.length); }
        if (count) { localStorage.setItem(CK, count); localStorage.setItem(CA, String(Date.now())); return count; }
      } catch (e) { /* offline / blocked */ }
      return cached || '';
    }
    fetchCommitCount().then((c) => { if (c) commitCount = c; });

    let timer = null;
    function morphTo(target) {
      if (timer) { clearInterval(timer); timer = null; }
      const maxLen = Math.max(meta.textContent.length, target.length);
      const steps = 7; let step = 0;
      timer = setInterval(() => {
        step++;
        const revealed = Math.floor((step / steps) * target.length);
        let out = '';
        for (let i = 0; i < maxLen; i++) {
          if (i >= target.length) { out += ' '; continue; }
          out += i < revealed ? target[i] : CHARS[Math.floor(Math.random() * CHARS.length)];
        }
        meta.textContent = out;
        if (step >= steps) { clearInterval(timer); timer = null; meta.textContent = target; }
      }, 28);
    }
    meta.addEventListener('mouseenter', () => { if (commitCount) morphTo(' // changes: ' + commitCount); });
    meta.addEventListener('mouseleave', () => morphTo(VER));
  })();
})(window.ATLAS);
