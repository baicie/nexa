# Text test font fixtures

`NotoSansArabic.ttf` is copied from the `cosmic-text 0.17.0` crate fixture set solely for deterministic `nui-text` tests. It is Noto Sans Arabic under the SIL Open Font License 1.1; the accompanying `NotoSans-LICENSE` file is retained verbatim. The font is a dev/test asset and is not part of the Nexa UI runtime package.

Additional cases use `AHEM`, `NOTOSERIF_AUTOHINT_SHAPING`, `NOTOSERIFTC_AUTOHINT_METRICS`, `NOTO_HANDWRITING_SBIX`, and `ttc::TTC` exported by the exactly pinned `font-test-data 0.6.1` dev dependency. Those assets remain test-only Cargo inputs and are not copied into or shipped with Nexa UI runtime packages.

`multilingual-golden.json` records deterministic paragraph geometry in units of 1/64 logical pixel. It covers fixed Latin and CJK wrapping, Arabic/Latin visual order, and an Emoji ZWJ cluster. To print a regenerated manifest for review without modifying the checked-in fixture, run:

```bash
NUI_PRINT_TEXT_GOLDENS=1 cargo test -p nui-text --test multilingual_golden -- --nocapture
```
