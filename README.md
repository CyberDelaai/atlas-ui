# ATLAS

A free, in-browser cyberpunk utility — the newest tool in the
[cyberdeck.tools](https://cyberdeck.tools/) family (COMMLINK · CHRONOS · GRIDMAP).

> **Status: blank scaffold.** This repo currently ships only the shared chrome
> (header, tool-switcher, theming, i18n, version-bump infrastructure). The tool's
> actual feature set is not built yet — it's a starting point to build on.

No build step, no backend — just open `index.html`. Everything runs client-side.

## Running

Open `index.html` in any modern browser, or serve the folder:

```
python3 -m http.server 8765
```

## Versioning

`X.Y.Z`, bumped with the helper script (keeps all three in-file version spots
in sync — the line-1 comment, the `#tagVersion` span, and the `VER` constant):

```
python3 bump_version.py {x|y|z}
```

## Built with

- [augmented-ui](https://augmented-ui.com/) — clipped/beveled cyberpunk panel styling
- [JetBrains Mono](https://www.jetbrains.com/lp/mono/) — UI typeface

## Support

If you find these tools useful, you can support development here: [boosty.to/cyberdelaai/donate](https://boosty.to/cyberdelaai/donate)

## License

[MIT](LICENSE) © 2026 CyberDelaai
